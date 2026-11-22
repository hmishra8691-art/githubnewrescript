import type { AnalysisResult } from "./types.js";

/**
 * REFRESH, SCHEDULES AND ALERTS FOR REPORTS (Level 5 roadmap R5 + R6, 2026-11-22).
 *
 *   digestResults     the few numbers of a result set worth comparing later (base, KPIs, the first series by
 *                     category) — what a schedule keeps between runs instead of whole results
 *   changeSummary     what moved between two digests, biggest first, each a sentence: a base that grew, a share
 *                     that moved by at least `minPoints` points, a KPI that changed, analyses added or gone
 *   nextRunAt         when a daily / weekly / monthly schedule runs next (UTC hour, weekday, day of month)
 *   checkAlert        whether a metric crossed its threshold since the last run — told once when it crosses, not
 *                     on every run it stays over
 *
 * Changes in figures from fewer than `minBase` people are not reported as findings (they say so). Browser-safe.
 */
export interface MetricDigest {
  analyses: Record<string, { name: string; n: number; kpis: Record<string, number>; values: Record<string, number>; pct: boolean }>;
  at: string;
}

const MAX_CATEGORIES = 40;
const round = (v: number) => Math.round(v * 100) / 100;

export function digestResults(results: Record<string, AnalysisResult>, at = new Date().toISOString()): MetricDigest {
  const analyses: MetricDigest["analyses"] = {};
  for (const [id, r] of Object.entries(results ?? {})) {
    if (!r || r.error) continue;
    const kpis: Record<string, number> = {};
    for (const k of r.chart.kpis ?? []) if (typeof k.value === "number" && Number.isFinite(k.value)) kpis[k.label] = round(k.value);
    const values: Record<string, number> = {};
    const s = r.chart.series?.[0];
    (r.chart.categories ?? []).slice(0, MAX_CATEGORIES).forEach((c, i) => { const v = s?.values[i]; if (typeof v === "number" && Number.isFinite(v)) values[c] = round(v); });
    analyses[id] = { name: r.name, n: r.base?.n ?? 0, kpis, values, pct: r.chart.valueFormat === "pct" };
  }
  return { analyses, at };
}

export interface Change { analysisId: string; kind: "base" | "value" | "kpi" | "added" | "removed"; label: string; from: number | null; to: number | null; magnitude: number; sentence: string }
export interface ChangeSummary { changes: Change[]; headline: string; unchanged: number; since: string | null }

const fmt = (v: number, pct: boolean) => `${Number.isInteger(v) ? v : v.toFixed(1)}${pct ? "%" : ""}`;

export function changeSummary(prev: MetricDigest | null, next: MetricDigest, opts: { minPoints?: number; minKpiChange?: number; minBase?: number; max?: number } = {}): ChangeSummary {
  const minPoints = opts.minPoints ?? 3, minKpi = opts.minKpiChange ?? 2, minBase = opts.minBase ?? 30, max = opts.max ?? 12;
  if (!prev) return { changes: [], headline: "First run: there is nothing earlier to compare with.", unchanged: 0, since: null };
  const changes: Change[] = [];
  let unchanged = 0;
  for (const [id, a] of Object.entries(next.analyses)) {
    const b = prev.analyses[id];
    if (!b) { changes.push({ analysisId: id, kind: "added", label: a.name, from: null, to: a.n, magnitude: 0.5, sentence: `${a.name} is new in this report (n = ${a.n}).` }); continue; }
    let moved = false;
    if (a.n !== b.n) changes.push({ analysisId: id, kind: "base", label: a.name, from: b.n, to: a.n, magnitude: 0.1, sentence: `${a.name}: the base went from ${b.n} to ${a.n} (${a.n > b.n ? "+" : ""}${a.n - b.n}).` });
    const small = a.n < minBase || b.n < minBase;
    for (const [k, v] of Object.entries(a.kpis)) {
      const w = b.kpis[k]; if (w === undefined) continue;
      const d = v - w;
      if (Math.abs(d) >= minKpi) { moved = true; changes.push({ analysisId: id, kind: "kpi", label: `${a.name} · ${k}`, from: w, to: v, magnitude: small ? 0 : Math.abs(d), sentence: `${a.name}: ${k} ${d > 0 ? "rose" : "fell"} from ${fmt(w, false)} to ${fmt(v, false)}${small ? ` — on fewer than ${minBase} respondents, so not a finding` : ""}.` }); }
    }
    for (const [c, v] of Object.entries(a.values)) {
      const w = b.values[c]; if (w === undefined) continue;
      const d = v - w;
      const threshold = a.pct ? minPoints : Math.max(minPoints, Math.abs(w) * 0.1);
      if (Math.abs(d) >= threshold) { moved = true; changes.push({ analysisId: id, kind: "value", label: `${a.name} · ${c}`, from: w, to: v, magnitude: small ? 0 : Math.abs(d), sentence: `${a.name}: “${c}” ${d > 0 ? "up" : "down"} ${a.pct ? `${Math.abs(d).toFixed(1)} points` : `by ${Math.abs(d).toFixed(1)}`}, ${fmt(w, a.pct)} → ${fmt(v, a.pct)}${small ? ` — on fewer than ${minBase} respondents, so not a finding` : ""}.` }); }
    }
    if (!moved && a.n === b.n) unchanged++;
  }
  for (const [id, b] of Object.entries(prev.analyses)) if (!next.analyses[id]) changes.push({ analysisId: id, kind: "removed", label: b.name, from: b.n, to: null, magnitude: 0.5, sentence: `${b.name} is no longer in this report, or could not be computed.` });
  changes.sort((x, y) => y.magnitude - x.magnitude);
  const findings = changes.filter((c) => (c.kind === "value" || c.kind === "kpi") && c.magnitude > 0);
  const bases = changes.filter((c) => c.kind === "base");
  const grew = bases.reduce((s, c) => s + ((c.to ?? 0) - (c.from ?? 0)), 0);
  const headline = findings.length
    ? `${findings.length} figure${findings.length === 1 ? "" : "s"} moved since ${prev.at.slice(0, 10)}; the largest: ${findings[0].sentence.replace(/\.$/, "")}.`
    : bases.length ? `No figure moved by ${minPoints} points or more since ${prev.at.slice(0, 10)}${grew ? `; the bases ${grew > 0 ? "grew" : "shrank"} as data came in` : ""}.`
    : `Nothing changed since ${prev.at.slice(0, 10)}.`;
  return { changes: changes.slice(0, max), headline, unchanged, since: prev.at };
}

export type Cadence = "daily" | "weekly" | "monthly";
export interface ScheduleTiming { cadence: Cadence; hourUtc: number; weekday?: number; dayOfMonth?: number }

/** the next run strictly after `after` (UTC); weekday 0 = Sunday; a day of month past the month's end runs on its last day */
export function nextRunAt(t: ScheduleTiming, after: Date): Date {
  const h = Math.max(0, Math.min(23, Math.round(t.hourUtc)));
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), h, 0, 0));
  if (t.cadence === "daily") { if (d <= after) d.setUTCDate(d.getUTCDate() + 1); return d; }
  if (t.cadence === "weekly") {
    const wd = Math.max(0, Math.min(6, Math.round(t.weekday ?? 1)));
    d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7));
    if (d <= after) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  const want = Math.max(1, Math.min(31, Math.round(t.dayOfMonth ?? 1)));
  const inMonth = (y: number, m: number) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(want, last), h, 0, 0)); };
  let c = inMonth(after.getUTCFullYear(), after.getUTCMonth());
  if (c <= after) c = inMonth(after.getUTCFullYear(), after.getUTCMonth() + 1);
  return c;
}

export interface AlertRule { analysisId: string; metric: string; op: "above" | "below"; threshold: number; minBase?: number }
export interface AlertCheck { value: number | null; over: boolean; fire: boolean; sentence: string }

/** the metric is a KPI label, or a category of the first series; it fires when it CROSSES (was not over before, is now) */
export function checkAlert(rule: AlertRule, next: MetricDigest, prev: MetricDigest | null): AlertCheck {
  const read = (d: MetricDigest | null) => { const a = d?.analyses[rule.analysisId]; if (!a) return null; const v = a.kpis[rule.metric] ?? a.values[rule.metric]; return typeof v === "number" ? { v, n: a.n, name: a.name, pct: a.pct && !(rule.metric in a.kpis) } : null; };
  const now = read(next), before = read(prev);
  if (!now) return { value: null, over: false, fire: false, sentence: `“${rule.metric}” is not in the latest results, so the alert could not be checked.` };
  const minBase = rule.minBase ?? 30;
  const over = rule.op === "above" ? now.v > rule.threshold : now.v < rule.threshold;
  const wasOver = before ? (rule.op === "above" ? before.v > rule.threshold : before.v < rule.threshold) : false;
  if (now.n < minBase) return { value: now.v, over, fire: false, sentence: `${now.name}: ${rule.metric} is ${fmt(now.v, now.pct)} but rests on ${now.n} respondents (under ${minBase}), so no alert is sent.` };
  const fire = over && !wasOver;
  return { value: now.v, over, fire, sentence: `${now.name}: ${rule.metric} is ${fmt(now.v, now.pct)}, ${over ? (rule.op === "above" ? "above" : "below") : rule.op === "above" ? "not above" : "not below"} the threshold of ${fmt(rule.threshold, now.pct)}${before ? ` (it was ${fmt(before.v, before.pct)})` : ""} — n = ${now.n}.` };
}
