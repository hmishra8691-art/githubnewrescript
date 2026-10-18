import type { BillingConfig } from "./config.js";
import { money6 } from "./money.js";
import { priceOperation } from "./pricing.js";
import { DEFAULT_RATES, cacheRateFor, findRate, providerCostFor, type Rate } from "./registry.js";

/**
 * PROMPT CACHING, MEASURED FROM BILLING (2026-10-18).
 *
 * The AI cost audit (2026-10-17) turned provider prompt caching on and taught
 * the meter to price the three parts of an input — uncached, read from the
 * cache, written into it — at their own rates. Every AI usage event since then
 * carries the split in `metadata.tokens`:
 *
 *   { input, output, cachedInput, cacheWrite, uncachedInput }
 *
 * (the key is `cachedInput` on the event; the meter's own `Priced.tokens` and
 * `UsageSpec` call the same number `cacheRead` / `cacheReadUnits` — both names
 * are read here) plus the rate rows that priced it (`rateInId`,
 * `rateCacheReadId`, `rateCacheWriteId`).
 *
 * This turns those events into the report the estimate in the audit could not
 * give: per day × operation × model — calls, the token split, the hit rate,
 * what the calls actually cost the platform at the provider, what the SAME
 * calls would have cost with no caching (input and output at the rates the
 * meter used), and the saving in dollars and percent. And it says what is
 * wrong:
 *
 *   prefix_churn       a cache write that no later call read back within the
 *                      provider's TTL — the 25 % write premium paid for nothing
 *                      (a prefix that changes between calls, or traffic too
 *                      sparse for a 5-minute cache)
 *   below_minimum      calls with nothing cached whose WHOLE input is under the
 *                      provider's minimum cacheable prefix — caching cannot apply
 *   never_cached       an operation whose calls are large enough to cache and
 *                      never read or wrote the cache (a plain-string system
 *                      prompt, a provider without caching)
 *   read_at_input_rate cached tokens priced at the input rate (no cache_read
 *                      row for the model)
 *   legacy             events from before the split was recorded (counted,
 *                      never guessed at)
 *   small_sample       fewer calls than a percentage deserves
 *
 * Pure: rows in, report out. The Studio's admin panel, the CLI script and the
 * tests all call this one function.
 */

/** one usage event as the report reads it (camelCase; `fromDbRow` maps a `usage_events` row) */
export interface CacheReportRow {
  id?: string;
  createdAt: string;
  eventType: string;
  category?: string | null;
  environment?: string | null;
  provider: string | null;
  service: string | null;
  model: string | null;
  inputUnits: number | null;
  outputUnits: number | null;
  providerCost: number;
  infraCost?: number | null;
  customerCharge: number;
  customerId?: string | null;
  surveyId?: string | null;
  userId?: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CacheReportOptions {
  /** the rate table the meter used (the database's, else the defaults) */
  rates?: Rate[];
  /** the billing configuration — when given, the customer charge with no caching is priced too */
  config?: BillingConfig;
  /** how long a written prefix stays readable (Anthropic's ephemeral cache: 5 minutes, refreshed on every read) */
  ttlMs?: number;
  /** the provider's minimum cacheable prefix for a model, in tokens */
  minCacheable?: (model: string | null) => number;
  /** "now", for deciding whether a recent write may still be read (default: the latest event) */
  now?: string | Date;
  /** below this many calls with the split, the report says the sample is small */
  smallSample?: number;
}

export interface CacheTotals {
  calls: number;
  /** calls with the token split recorded */
  splitCalls: number;
  /** calls from before the split (or a path that does not record it) */
  legacyCalls: number;
  inputTokens: number;
  uncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** calls that read anything from the cache, and that wrote anything */
  readCalls: number;
  writeCalls: number;
  /** readCalls / splitCalls */
  hitRate: number;
  /** cacheReadTokens / input tokens of the split calls */
  tokenHitRate: number;
  /** what the calls cost at the provider, as metered (USD) */
  actualCostUsd: number;
  /** the same calls with no caching: all input at the input rate (USD) */
  noCacheCostUsd: number;
  savingUsd: number;
  /** savingUsd / noCacheCostUsd, in percent */
  savingPct: number;
  /** customer charges as recorded, and as they would have been priced with no caching (only with `config`) */
  chargeUsd: number;
  chargeNoCacheUsd: number | null;
}

export interface CacheGroup extends CacheTotals { day: string; operation: string; model: string }

export type CacheWarningKind = "prefix_churn" | "below_minimum" | "never_cached" | "read_at_input_rate" | "legacy" | "small_sample";
export interface CacheWarning { kind: CacheWarningKind; operation?: string; model?: string; calls: number; tokens?: number; wastedUsd?: number; message: string }

export interface CacheReport {
  generatedAt: string;
  sample: { from: string | null; to: string | null; events: number; splitEvents: number; firstSplitAt: string | null };
  totals: CacheTotals;
  groups: CacheGroup[];
  byOperation: (CacheTotals & { operation: string })[];
  byModel: (CacheTotals & { model: string })[];
  byDay: (CacheTotals & { day: string })[];
  warnings: CacheWarning[];
  /** the TTL and minimums the warnings were computed with — so a reader can check them */
  assumptions: { ttlMs: number; minimums: Record<string, number> };
}

/* ------------------------------------------------------------ the parts of one event */

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);

export interface EventTokens { split: boolean; input: number; uncached: number; read: number; write: number; output: number }

/** the token split of one event — `cachedInput` (the event's key) or `cacheRead` (the meter's) — or the plain totals of a legacy event */
export function eventTokens(row: Pick<CacheReportRow, "inputUnits" | "outputUnits" | "metadata">): EventTokens {
  const t = row.metadata && typeof row.metadata.tokens === "object" && row.metadata.tokens ? row.metadata.tokens as Record<string, unknown> : null;
  if (!t) {
    const input = num(row.inputUnits), output = num(row.outputUnits);
    return { split: false, input, uncached: input, read: 0, write: 0, output };
  }
  const input = num(t.input ?? row.inputUnits);
  const read = Math.min(input, num(t.cachedInput ?? t.cacheRead));
  const write = Math.min(input - read, num(t.cacheWrite));
  const uncached = t.uncachedInput != null ? Math.min(input, num(t.uncachedInput)) : input - read - write;
  return { split: true, input, uncached, read, write, output: num(t.output ?? row.outputUnits) };
}

/** the provider's minimum cacheable prefix (Anthropic: 1,024 for Sonnet / Opus ≤ 4.1, 4,096 for Haiku 4.5 and Opus 4.5; OpenAI: 1,024) — override with `minCacheable` */
export function defaultMinCacheable(model: string | null): number {
  const m = (model ?? "").toLowerCase();
  if (/haiku-4-5|opus-4-5/.test(m)) return 4096;
  if (/haiku-3/.test(m)) return 2048;
  return 1024;
}

interface Priced { actual: number; noCache: number; readAtInput: boolean; writePremium: number; inputRate: Rate | null }

function rateById(rates: Rate[], id: unknown): Rate | null {
  return typeof id === "string" ? rates.find((r) => r.id === id) ?? null : null;
}

/** what one event cost at the provider with its caching, and what it would have cost without */
function priceEvent(row: CacheReportRow, tok: EventTokens, rates: Rate[]): Priced {
  const md = row.metadata ?? {};
  const q = { provider: row.provider ?? "openai-compatible", service: row.service ?? "chat", model: row.model, at: row.createdAt };
  const rin = rateById(rates, md.rateInId) ?? findRate(rates, { ...q, side: "input" });
  const rout = rateById(rates, md.rateOutId) ?? findRate(rates, { ...q, side: "output" });
  const rread = tok.read ? rateById(rates, md.rateCacheReadId) ?? cacheRateFor(rates, rin, "cache_read", row.createdAt) : null;
  const rwrite = tok.write ? rateById(rates, md.rateCacheWriteId) ?? cacheRateFor(rates, rin, "cache_write", row.createdAt) : null;
  const noCache = money6(providerCostFor(rin, tok.input) + providerCostFor(rout, tok.output));
  const repriced = money6(providerCostFor(rin, tok.uncached) + providerCostFor(rread ?? rin, tok.read) + providerCostFor(rwrite ?? rin, tok.write) + providerCostFor(rout, tok.output));
  /* the platform paid what the meter recorded; an own-provider (BYOK) event is recorded at zero and repriced so its caching still counts */
  const recorded = num(row.providerCost);
  const actual = tok.split ? (recorded > 0 ? recorded : repriced) : recorded || noCache;
  /* a legacy event had no caching: what it cost is its no-cache cost */
  return { actual, noCache: tok.split ? noCache : actual, readAtInput: tok.read > 0 && !rread, writePremium: rwrite && rin ? money6(providerCostFor(rwrite, tok.write) - providerCostFor(rin, tok.write)) : 0, inputRate: rin };
}

/* ------------------------------------------------------------ totals */

function emptyTotals(): CacheTotals {
  return { calls: 0, splitCalls: 0, legacyCalls: 0, inputTokens: 0, uncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, readCalls: 0, writeCalls: 0, hitRate: 0, tokenHitRate: 0, actualCostUsd: 0, noCacheCostUsd: 0, savingUsd: 0, savingPct: 0, chargeUsd: 0, chargeNoCacheUsd: null };
}

interface Acc { t: CacheTotals; splitInput: number }
function add(acc: Acc, tok: EventTokens, p: Priced, charge: number, chargeNoCache: number | null) {
  const t = acc.t;
  t.calls++;
  if (tok.split) { t.splitCalls++; acc.splitInput += tok.input; } else t.legacyCalls++;
  t.inputTokens += tok.input; t.uncachedTokens += tok.uncached; t.cacheReadTokens += tok.read; t.cacheWriteTokens += tok.write; t.outputTokens += tok.output;
  if (tok.read > 0) t.readCalls++;
  if (tok.write > 0) t.writeCalls++;
  t.actualCostUsd += p.actual; t.noCacheCostUsd += p.noCache; t.chargeUsd += charge;
  if (chargeNoCache != null) t.chargeNoCacheUsd = (t.chargeNoCacheUsd ?? 0) + chargeNoCache;
}
function finish(acc: Acc): CacheTotals {
  const t = { ...acc.t };
  t.actualCostUsd = money6(t.actualCostUsd); t.noCacheCostUsd = money6(t.noCacheCostUsd); t.chargeUsd = money6(t.chargeUsd);
  if (t.chargeNoCacheUsd != null) t.chargeNoCacheUsd = money6(t.chargeNoCacheUsd);
  t.savingUsd = money6(t.noCacheCostUsd - t.actualCostUsd);
  t.savingPct = t.noCacheCostUsd > 0 ? Math.round((t.savingUsd / t.noCacheCostUsd) * 1000) / 10 : 0;
  t.hitRate = t.splitCalls ? Math.round((t.readCalls / t.splitCalls) * 1000) / 1000 : 0;
  t.tokenHitRate = acc.splitInput ? Math.round((t.cacheReadTokens / acc.splitInput) * 1000) / 1000 : 0;
  return t;
}

const opOf = (row: CacheReportRow) => String((row.metadata?.operation as string | undefined) ?? row.eventType ?? "unknown");
const dayOf = (row: CacheReportRow) => String(row.createdAt).slice(0, 10);

/* ------------------------------------------------------------ the report */

export function cacheReport(rowsIn: readonly CacheReportRow[], opts: CacheReportOptions = {}): CacheReport {
  const rates = opts.rates?.length ? opts.rates : DEFAULT_RATES;
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const minOf = opts.minCacheable ?? defaultMinCacheable;
  /* chat-token events only (an AI event priced per character or minute has no prompt to cache) */
  const rows = rowsIn.filter((r) => (r.service ?? "chat") === "chat" && (r.inputUnits != null || (r.metadata && typeof r.metadata.tokens === "object")))
    .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const now = opts.now ? new Date(opts.now).getTime() : rows.length ? Date.parse(rows[rows.length - 1].createdAt) : Date.now();

  const all: Acc = { t: emptyTotals(), splitInput: 0 };
  const groups = new Map<string, Acc & { day: string; operation: string; model: string }>();
  const byOp = new Map<string, Acc>(), byModel = new Map<string, Acc>(), byDay = new Map<string, Acc>();
  const acc = <K,>(m: Map<K, Acc>, k: K) => { let a = m.get(k); if (!a) { a = { t: emptyTotals(), splitInput: 0 }; m.set(k, a); } return a; };
  const parsed = rows.map((row) => {
    const tok = eventTokens(row);
    const p = priceEvent(row, tok, rates);
    const charge = num(row.customerCharge);
    /* the charge with no caching: the recorded charge scaled by the same pricing model (BYOK and free events stay at zero) */
    const chargeNoCache = !opts.config ? null : charge <= 0 || !tok.split ? charge
      : priceOperation({ providerCost: p.noCache, infraCost: num(row.infraCost) }, opts.config, { environment: row.environment === "TEST" ? "TEST" : "LIVE" }).customerCharge;
    return { row, tok, p, charge, chargeNoCache };
  });
  for (const e of parsed) {
    const day = dayOf(e.row), operation = opOf(e.row), model = e.row.model ?? "unknown";
    add(all, e.tok, e.p, e.charge, e.chargeNoCache);
    const gk = `${day}\u0000${operation}\u0000${model}`;
    let g = groups.get(gk);
    if (!g) { g = { t: emptyTotals(), splitInput: 0, day, operation, model }; groups.set(gk, g); }
    add(g, e.tok, e.p, e.charge, e.chargeNoCache);
    add(acc(byOp, operation), e.tok, e.p, e.charge, e.chargeNoCache);
    add(acc(byModel, model), e.tok, e.p, e.charge, e.chargeNoCache);
    add(acc(byDay, day), e.tok, e.p, e.charge, e.chargeNoCache);
  }

  /* ---- warnings */
  const warnings: CacheWarning[] = [];
  /* prefix churn: a write read back by a later call of the same model within the TTL (each read refreshes the entry) */
  const churn = new Map<string, CacheWarning>();
  const split = parsed.filter((e) => e.tok.split);
  split.forEach((w, i) => {
    if (w.tok.write <= 0) return;
    const t0 = Date.parse(w.row.createdAt);
    if (now - t0 < ttl) return; /* may still be read */
    let last = t0, readBack = false;
    for (let j = i + 1; j < split.length; j++) {
      const r = split[j];
      const t = Date.parse(r.row.createdAt);
      if (t - last > ttl) break;
      if ((r.row.model ?? "") !== (w.row.model ?? "")) continue;
      if (r.tok.read >= w.tok.write * 0.9) { readBack = true; break; }
      if (r.tok.read > 0) last = t;
    }
    if (readBack) return;
    const key = `${opOf(w.row)}\u0000${w.row.model ?? ""}`;
    const c = churn.get(key) ?? { kind: "prefix_churn" as const, operation: opOf(w.row), model: w.row.model ?? "unknown", calls: 0, tokens: 0, wastedUsd: 0, message: "" };
    c.calls++; c.tokens = (c.tokens ?? 0) + w.tok.write; c.wastedUsd = money6((c.wastedUsd ?? 0) + w.p.writePremium);
    churn.set(key, c);
  });
  for (const c of churn.values()) {
    c.message = `${c.calls} cache write${c.calls === 1 ? "" : "s"} by ${c.operation} (${c.tokens?.toLocaleString("en")} tokens) never read back within ${Math.round(ttl / 60000)} minutes — the write premium ($${(c.wastedUsd ?? 0).toFixed(4)}) bought nothing. A prefix that changes between calls, or traffic too sparse for the cache's lifetime.`;
    warnings.push(c);
  }
  /* per operation and model: below the minimum, never cached */
  const perOpModel = new Map<string, typeof split>();
  for (const e of split) { const k = `${opOf(e.row)}\u0000${e.row.model ?? ""}`; perOpModel.set(k, [...(perOpModel.get(k) ?? []), e]); }
  for (const [k, list] of perOpModel) {
    const [operation, model] = k.split("\u0000");
    const min = minOf(model || null);
    const cold = list.filter((e) => e.tok.read === 0 && e.tok.write === 0);
    const small = cold.filter((e) => e.tok.input < min);
    if (small.length) warnings.push({ kind: "below_minimum", operation, model: model || "unknown", calls: small.length, tokens: small.reduce((n, e) => n + e.tok.input, 0), message: `${small.length} call${small.length === 1 ? "" : "s"} of ${operation} sent less than the ${min.toLocaleString("en")}-token minimum the provider caches (${model || "unknown model"}) — caching cannot apply to them.` });
    const big = list.filter((e) => e.tok.input >= min);
    if (big.length && big.every((e) => e.tok.read === 0 && e.tok.write === 0)) warnings.push({ kind: "never_cached", operation, model: model || "unknown", calls: big.length, tokens: big.reduce((n, e) => n + e.tok.input, 0), message: `${operation} (${model || "unknown model"}): ${big.length} call${big.length === 1 ? "" : "s"} large enough to cache, none read or wrote the cache — a system prompt sent as one plain string, or a provider/path without prompt caching.` });
    const atInput = list.filter((e) => e.p.readAtInput);
    if (atInput.length) warnings.push({ kind: "read_at_input_rate", operation, model: model || "unknown", calls: atInput.length, tokens: atInput.reduce((n, e) => n + e.tok.read, 0), message: `${operation} (${model || "unknown model"}): cached tokens were priced at the input rate — the rate table has no cache_read row for this model.` });
  }
  const legacy = parsed.filter((e) => !e.tok.split);
  if (legacy.length) warnings.push({ kind: "legacy", calls: legacy.length, tokens: legacy.reduce((n, e) => n + e.tok.input, 0), message: `${legacy.length} event${legacy.length === 1 ? "" : "s"} without the token split (recorded before 2026-10-17, or on a path that does not record it) — counted at their recorded cost, no caching assumed.` });
  const smallSample = opts.smallSample ?? 30;
  if (split.length < smallSample) warnings.push({ kind: "small_sample", calls: split.length, message: `Only ${split.length} call${split.length === 1 ? "" : "s"} with the token split — read the percentages as indicative, not as a rate.` });

  const sortT = <T extends CacheTotals>(xs: T[]) => xs.sort((a, b) => b.noCacheCostUsd - a.noCacheCostUsd);
  return {
    generatedAt: new Date().toISOString(),
    sample: { from: rows[0]?.createdAt ?? null, to: rows[rows.length - 1]?.createdAt ?? null, events: rows.length, splitEvents: split.length, firstSplitAt: split[0]?.row.createdAt ?? null },
    totals: finish(all),
    groups: [...groups.values()].map((g) => ({ ...finish(g), day: g.day, operation: g.operation, model: g.model })).sort((a, b) => a.day.localeCompare(b.day) || a.operation.localeCompare(b.operation) || a.model.localeCompare(b.model)),
    byOperation: sortT([...byOp].map(([operation, a]) => ({ ...finish(a), operation }))),
    byModel: sortT([...byModel].map(([model, a]) => ({ ...finish(a), model }))),
    byDay: [...byDay].map(([day, a]) => ({ ...finish(a), day })).sort((a, b) => a.day.localeCompare(b.day)),
    warnings,
    assumptions: { ttlMs: ttl, minimums: Object.fromEntries([...new Set(rows.map((r) => r.model ?? "unknown"))].map((m) => [m, minOf(m === "unknown" ? null : m)])) },
  };
}

/** a `usage_events` row (snake_case, numerics as strings) as the report reads it */
export function cacheRowFromDb(r: Record<string, unknown>): CacheReportRow {
  const n = (v: unknown) => (v == null ? null : num(v));
  return {
    id: r.id as string | undefined, createdAt: String(r.created_at ?? ""), eventType: String(r.event_type ?? ""), category: (r.category as string) ?? null, environment: (r.environment as string) ?? null,
    provider: (r.provider as string) ?? null, service: (r.service as string) ?? null, model: (r.model as string) ?? null,
    inputUnits: n(r.input_units), outputUnits: n(r.output_units), providerCost: num(r.provider_cost), infraCost: n(r.infra_cost), customerCharge: num(r.customer_charge),
    customerId: (r.customer_id as string) ?? null, surveyId: (r.survey_id as string) ?? null, userId: (r.user_id as string) ?? null,
    metadata: r.metadata && typeof r.metadata === "object" ? r.metadata as Record<string, unknown> : null,
  };
}

/* ------------------------------------------------------------ as text (the CLI, the docs) */

const usd = (n: number) => `$${n.toFixed(4)}`;
const k = (n: number) => n.toLocaleString("en");
const pct = (n: number) => `${(n * 100).toFixed(0)} %`;

/** the report as a Markdown table set — what `scripts/ai-cache-report.mjs` prints */
export function cacheReportMarkdown(r: CacheReport): string {
  const L: string[] = [];
  const t = r.totals;
  L.push(`# AI cost and cache — measured from billing`, "");
  L.push(`Sample: ${k(r.sample.events)} chat events ${r.sample.from ? `from ${r.sample.from} to ${r.sample.to}` : ""}; ${k(r.sample.splitEvents)} with the token split (first ${r.sample.firstSplitAt ?? "—"}).`, "");
  L.push(`**Totals:** ${k(t.calls)} calls · input ${k(t.inputTokens)} (uncached ${k(t.uncachedTokens)}, cache read ${k(t.cacheReadTokens)}, cache write ${k(t.cacheWriteTokens)}) · output ${k(t.outputTokens)} · hit rate ${pct(t.hitRate)} of calls, ${pct(t.tokenHitRate)} of input tokens`);
  L.push(`**Provider cost:** ${usd(t.actualCostUsd)} actual vs ${usd(t.noCacheCostUsd)} with no caching → saved ${usd(t.savingUsd)} (${t.savingPct.toFixed(1)} %)${t.chargeNoCacheUsd != null ? ` · customer charges ${usd(t.chargeUsd)} vs ${usd(t.chargeNoCacheUsd)} uncached` : ""}`, "");
  L.push("| day | operation | model | calls | split | input | uncached | cache read | cache write | output | hit rate | actual | no cache | saving |");
  L.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const g of r.groups) L.push(`| ${g.day} | ${g.operation} | ${g.model} | ${g.calls} | ${g.splitCalls} | ${k(g.inputTokens)} | ${k(g.uncachedTokens)} | ${k(g.cacheReadTokens)} | ${k(g.cacheWriteTokens)} | ${k(g.outputTokens)} | ${g.splitCalls ? pct(g.hitRate) : "—"} | ${usd(g.actualCostUsd)} | ${usd(g.noCacheCostUsd)} | ${usd(g.savingUsd)} (${g.savingPct.toFixed(1)} %) |`);
  if (r.warnings.length) { L.push("", "## Warnings", ""); for (const w of r.warnings) L.push(`- **${w.kind}** — ${w.message}`); }
  return L.join("\n");
}
