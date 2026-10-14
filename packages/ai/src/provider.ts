/**
 * THE AI REQUEST MANAGER — one place where every call to a language-model
 * provider is classified, paced, retried and recorded.
 *
 * WHY. A researcher typed a survey brief and was shown "THE PROVIDER REFUSED
 * THE REQUEST" (401/403/429). Behind that card the path had: one retry with
 * a pause of at most five seconds and no jitter, a 429 and a 401 told apart
 * by nothing, no memory between requests (each researcher's call hammered a
 * provider that had just said "slow down"), and no way to say "this is
 * temporary, your work is saved" — a rate limit and a wrong key reached the
 * person as the same sentence. This module is the single answer:
 *
 *   CLASSIFY   a response or a thrown error becomes a `ProviderError` with a
 *              `kind` (rate_limited, quota_exhausted, overloaded, server,
 *              network, timeout, auth, forbidden, not_found, bad_request,
 *              busy) and whether it is worth retrying. A 429 that says the
 *              account is out of credit is not a rate limit; a 403 that says
 *              "rate limit" is not a permission problem.
 *   RESPECT    `Retry-After` (seconds or a date), `retry-after-ms`, and the
 *              providers' reset hints (`anthropic-ratelimit-*-reset`,
 *              `x-ratelimit-reset-*`) say when to come back. The wait is never
 *              shorter than that.
 *   PACE       each provider (base URL + key) is a lane with a shared
 *              cool-down and a concurrency limit. A 429 cools the whole lane
 *              and halves its concurrency, so the next researcher's request
 *              waits instead of being refused; successes widen it again.
 *   RETRY      bounded, exponential, with jitter, and never past the
 *              caller's deadline: when the wait would not fit, the error is
 *              returned with `retryAfterMs` so the caller can save its work
 *              and come back — not retried blindly, not retried forever.
 *   STOP       a bad key (401), a refused permission (403), an unknown model
 *              (404), an exhausted quota and a malformed request are never
 *              retried, and a bad key or exhausted quota is remembered for a
 *              short while so the provider is not asked again to say no.
 *   FALL BACK  only to a provider the operator configured
 *              (AI_FALLBACK_API_URL, AI_FALLBACK_API_KEY, AI_FALLBACK_MODEL),
 *              and only for the failures a second provider can fix.
 *   RECORD     one structured log line per retry, wait, fallback and failure
 *              (no keys, no prompts), and a health snapshot per lane.
 *
 * State is per process. A serverless deployment runs several instances; each
 * learns from its own 429s. That is a known limit, not a hidden one: the
 * deadline and the saved-work design above do not depend on shared state.
 */

export type ProviderErrorKind =
  | "rate_limited"     // 429 (or a 403 that is one): slow down, retry after the wait
  | "quota_exhausted"  // out of credit / spend limit: not temporary on the minute scale
  | "overloaded"       // 503/529: the provider is shedding load
  | "server"           // 5xx: a fault on the provider's side
  | "network"          // the request never arrived or the connection dropped
  | "timeout"          // no answer within the time allowed
  | "auth"             // 401: the key is invalid, expired or missing
  | "forbidden"        // 403: this key may not do this (model, region, workspace)
  | "not_found"        // 404: the model name or endpoint is wrong
  | "bad_request"      // 400/413/422: the request itself is unacceptable
  | "busy";            // this server's own queue to the provider is full

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  status?: number;
  detail?: string;
  retryAfterMs?: number;
  /** the retries allowed were used (or the deadline left no room for another) */
  exhausted?: boolean;
  attempts?: number;
  /** which provider, for the log and the card — a host, never a key */
  host?: string;
  /** the request was answered by the configured fallback provider's failure */
  viaFallback?: boolean;
  /** the refusal says the PROMPT is longer than the model's context window — a shorter prompt can succeed */
  contextTooLong?: boolean;
}

/** kinds a retry can cure (after the wait) */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "overloaded", "server", "network", "timeout", "busy"]);
/** kinds a second configured provider could cure */
const FALLBACKABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "quota_exhausted", "overloaded", "server", "network", "timeout", "busy", "auth", "forbidden"]);

/**
 * What a provider said, made safe to log and to show an administrator: any
 * key- or token-shaped string, an Authorization header and an address with
 * credentials in it are removed, whitespace is collapsed and the length is
 * capped. A provider does not normally echo a key; this is the belt for the
 * braces.
 */
export function redact(text: string, max = 300): string {
  return String(text ?? "")
    .replace(/\b(?:sk|pk|rk|key|tok|xox[a-z]?)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/(x-api-key|api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly detail: string;
  readonly retryAfterMs?: number;
  readonly exhausted: boolean;
  readonly attempts: number;
  readonly host?: string;
  readonly viaFallback: boolean;
  readonly contextTooLong: boolean;
  constructor(init: ProviderErrorInit) {
    const detail = redact(init.detail ?? "", 300);
    super(providerMessage(init.kind, init.status, detail, init.retryAfterMs));
    this.name = "ProviderError";
    this.kind = init.kind;
    this.status = init.status;
    this.detail = detail;
    this.retryAfterMs = init.retryAfterMs;
    this.exhausted = init.exhausted ?? false;
    this.attempts = init.attempts ?? 1;
    this.host = init.host;
    this.viaFallback = init.viaFallback ?? false;
    this.contextTooLong = init.contextTooLong ?? false;
  }
  /** a retry later — after `retryAfterMs` when the provider gave one — can succeed */
  get retryable(): boolean { return RETRYABLE.has(this.kind); }
  /** a second, configured provider might answer where this one cannot */
  get fallbackable(): boolean { return FALLBACKABLE.has(this.kind); }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError || (!!e && typeof e === "object" && (e as { name?: string }).name === "ProviderError" && typeof (e as { kind?: unknown }).kind === "string");
}

/*
 * The messages keep the wording older callers read ("rate-limiting requests
 * (429)", "unavailable (503)", "refused the request (401)", "did not answer
 * within N seconds") — the kind and status on the object are the contract,
 * the sentence is for logs.
 */
function providerMessage(kind: ProviderErrorKind, status: number | undefined, detail: string, retryAfterMs?: number): string {
  const s = status ? ` (${status})` : "";
  const tail = detail ? ` ${detail}` : "";
  switch (kind) {
    case "rate_limited": return `the analysis provider is rate-limiting requests${s || " (429)"}${retryAfterMs ? ` — retry after ${Math.ceil(retryAfterMs / 1000)}s` : ""}${tail}`.trim();
    case "quota_exhausted": return `the analysis provider's quota or credit is exhausted${s}${tail}`.trim();
    case "overloaded":
    case "server": return `the analysis provider is unavailable${s}${tail}`.trim();
    case "network": return `could not reach the analysis provider${detail ? ` (${detail})` : ""}`;
    case "timeout": return `the analysis provider did not answer within ${detail || "the time allowed"}`;
    case "busy": return `the analysis provider is busy: too many requests are waiting on this server`;
    default: return `the analysis provider refused the request${s}${tail}`.trim();
  }
}

/* ------------------------------------------------------- reading a response */

const SECOND = 1000;
const MAX_HINT_MS = 24 * 60 * 60 * SECOND;

/** "1s", "6m0s", "20ms", "1h2m3.5s", or a bare number of seconds → milliseconds */
export function parseDurationMs(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * SECOND);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0, any = false;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    any = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * SECOND : m[2] === "m" ? n * 60 * SECOND : n * 3600 * SECOND;
  }
  return any ? Math.round(total) : null;
}

/**
 * When the provider says to come back, in ms from `now`: `retry-after-ms`,
 * `retry-after` (seconds or an HTTP date), else the nearest of its
 * rate-limit reset hints (`anthropic-ratelimit-*-reset` timestamps,
 * `x-ratelimit-reset-*` durations). Null when it says nothing.
 */
export function retryAfterFrom(headers: Pick<Headers, "get"> & { forEach?: Headers["forEach"] }, now = Date.now()): number | null {
  const clamp = (ms: number) => Math.max(0, Math.min(MAX_HINT_MS, Math.round(ms)));
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return clamp(Number(ms));
  const ra = headers.get("retry-after");
  if (ra) {
    const d = parseDurationMs(ra);
    if (d != null && /^\s*\d/.test(ra) && !/^\d{4}-/.test(ra.trim()) && !/[a-z]{3},/i.test(ra)) return clamp(d);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return clamp(at - now);
  }
  const hints: number[] = [];
  headers.forEach?.((value, name) => {
    const n = name.toLowerCase();
    if (/^anthropic-ratelimit-.*-reset$/.test(n)) { const at = Date.parse(value); if (Number.isFinite(at) && at > now) hints.push(at - now); }
    else if (/^x-ratelimit-reset-/.test(n) || n === "x-ratelimit-reset") { const d = parseDurationMs(value); if (d != null && d > 0) hints.push(d); }
  });
  return hints.length ? clamp(Math.min(...hints)) : null;
}

/*
 * A SPENT ACCOUNT IS NOT ALWAYS A 429. Anthropic answers "Your credit balance
 * is too low to access the Anthropic API" with HTTP 400 (invalid_request_error),
 * and "This organization has been disabled" with 400 as well; OpenAI-style
 * gateways answer a spent budget with 400, 402 or 403. Read as the status
 * alone, those were "the request is malformed" — a card that told the
 * researcher to rephrase a request that was never the problem. The words
 * decide, whatever the status.
 */
const QUOTA_WORDS = /insufficient_quota|exceeded your current quota|credit balance|plan and billing|billing (?:details|hard limit|issue)|out of (?:credits|funds)|usage limits?|regain access|spend(?:ing)? limit|monthly (?:limit|quota)|quota (?:exceeded|exhausted)|payment required/i;
/** a prompt longer than the model's context window — said many ways */
const CONTEXT_WORDS = /context.?(?:length|window)|prompt is too long|maximum context|too many (?:input )?tokens|input is too long|reduce the length|exceeds? the (?:model'?s )?(?:maximum|context)|request too large/i;
/** the account or organization is switched off, or may not use this API */
const DISABLED_WORDS = /organization (?:has been|is) disabled|account (?:has been|is) (?:disabled|suspended|deactivated)|has been (?:suspended|deactivated)|not (?:authorized|permitted) to (?:use|access)|permission_error/i;
/** a 400 that is really "no such model" (some providers and gateways do not use 404 for it) */
const MODEL_WORDS = /model[^.]{0,60}(?:not found|does not exist|is not available)|(?:unknown|invalid) model|no such model/i;
const RATE_WORDS = /rate.?limit|too many requests|throttl|slow down|capacity|overloaded|temporarily|try again (?:later|in)|requests? per (?:minute|second)|tokens? per (?:minute|second)/i;

/**
 * Read one failed HTTP response. The status gives the family; the body and
 * headers say which member — a 429 about credit is not a rate limit, a 403
 * that mentions a rate limit is not a permission.
 */
export function classifyResponse(status: number, headers: Pick<Headers, "get"> & { forEach?: Headers["forEach"] }, body: string, now = Date.now()): ProviderError {
  const text = body.slice(0, 600);
  const ra = retryAfterFrom(headers, now);
  const init = (kind: ProviderErrorKind, extra: Partial<ProviderErrorInit> = {}) => new ProviderError({ kind, status, detail: text, ...(ra != null && RETRYABLE.has(kind) ? { retryAfterMs: ra } : {}), ...extra });
  if (status === 429) return QUOTA_WORDS.test(text) && !/rate.?limit|per minute/i.test(text) ? init("quota_exhausted") : init("rate_limited");
  if (status === 402) return init("quota_exhausted");
  if (status === 401) return init("auth");
  if (status === 403) {
    if (QUOTA_WORDS.test(text)) return init("quota_exhausted");
    if (RATE_WORDS.test(text) || (ra != null && ra > 0)) return init("rate_limited");
    return init("forbidden");
  }
  if (status === 404) return init("not_found");
  /* a 400 (or another 4xx) that is, in words, a spent account, a disabled organization or an unknown model — not a malformed request */
  if (status >= 400 && status < 500 && status !== 408 && status !== 413) {
    if (QUOTA_WORDS.test(text) && !CONTEXT_WORDS.test(text)) return init("quota_exhausted");
    if (DISABLED_WORDS.test(text)) return init("forbidden");
    if (MODEL_WORDS.test(text) && !CONTEXT_WORDS.test(text)) return init("not_found");
  }
  if (status === 413 || (status === 400 && CONTEXT_WORDS.test(text))) return init("bad_request", { contextTooLong: true });
  if (status === 408) return init("timeout", { detail: "the provider timed out" });
  if (status === 529 || (status === 503 && /overload|capacity/i.test(text))) return init("overloaded");
  if (status >= 500 && status !== 501) return init("server");
  return init("bad_request");
}

/** a thrown fetch error that is not an abort: the request did not arrive */
export function networkError(e: unknown, host?: string): ProviderError {
  const msg = (e as Error)?.message ?? "network error";
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  return new ProviderError({ kind: "network", detail: `${msg}${cause ? ` ${cause}` : ""}`.slice(0, 160), host });
}

/* --------------------------------------------------------------- the lanes */

export interface RetryPolicy {
  /** retries after the first attempt (so 3 = four attempts) */
  retries: number;
  /** the first pause in ms; each retry doubles the window; jitter is applied */
  delayMs: number;
  /** no single pause longer than this (default 30 s) */
  maxWaitMs?: number;
}
export const DEFAULT_RETRY: RetryPolicy = { retries: 3, delayMs: 800, maxWaitMs: 30_000 };

export interface LaneHealth {
  lane: string;
  state: "ok" | "degraded" | "cooling_down" | "blocked";
  limit: number;
  active: number;
  queued: number;
  cooldownMs: number;
  consecutiveFailures: number;
  /** `detail` is the provider's own words, redacted — present only when asked for (an administrator's view) */
  lastError?: { kind: ProviderErrorKind; status?: number; at: string; detail?: string };
  lastSuccessAt?: string;
  blockedBy?: ProviderErrorKind;
}

interface Waiter { wake: () => void }
class Lane {
  limit: number;
  readonly maxLimit: number;
  active = 0;
  cooldownUntil = 0;
  blocked: { until: number; error: ProviderError } | null = null;
  consecutiveFailures = 0;
  successesSinceCut = 0;
  lastError?: { kind: ProviderErrorKind; status?: number; at: number; detail?: string };
  lastSuccessAt?: number;
  readonly waiters: Waiter[] = [];
  /** what the provider last said it had left (token and request allowances), from its rate-limit headers */
  capacity?: { tokensRemaining?: number; tokensLimit?: number; requestsRemaining?: number; requestsLimit?: number; at: number };
  constructor(readonly name: string, maxLimit: number) { this.limit = maxLimit; this.maxLimit = maxLimit; }
}

const lanes = new Map<string, Lane>();
const hashKey = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const hostOf = (base: string) => { try { return new URL(base).host; } catch { return base.slice(0, 60); } };

function maxConcurrency(): number {
  const n = Number(process.env.AI_MAX_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.round(n)) : 6;
}
/** a lane per provider and key: another key (a rotated one) starts clean */
function laneFor(base: string, key: string): Lane {
  const name = `${hostOf(base)}#${hashKey(key)}`;
  let l = lanes.get(name);
  if (!l) { l = new Lane(name, maxConcurrency()); lanes.set(name, l); }
  return l;
}

/** how long an invalid key or an exhausted quota is remembered, so the provider is not asked again to refuse (ms) */
const BLOCK_MS = 30_000;
/** the longest a request queues behind this server's own concurrency limit (ms) */
const MAX_QUEUE_MS = 60_000;

let rng: () => number = Math.random;
let logger: (event: string, fields: Record<string, unknown>) => void = (event, fields) => {
  console.warn("[rescript:ai]", JSON.stringify({ event, ...fields }));
};
const recent: { at: string; event: string; fields: Record<string, unknown> }[] = [];

/** the structured log: one line per retry, wait, fallback and failure. No keys, no prompts. */
export function logProvider(event: string, fields: Record<string, unknown>): void {
  recent.push({ at: new Date().toISOString(), event, fields });
  if (recent.length > 100) recent.shift();
  try { logger(event, fields); } catch { /* a logger must never break a request */ }
}
/** tests, or a host with its own logger */
export function setProviderLogger(fn: ((event: string, fields: Record<string, unknown>) => void) | null): void {
  logger = fn ?? ((event, fields) => console.warn("[rescript:ai]", JSON.stringify({ event, ...fields })));
}
export function setProviderRandom(fn: (() => number) | null): void { rng = fn ?? Math.random; }
export function recentProviderEvents(): typeof recent { return recent.slice(); }
/** forget every lane, block and event (tests) */
export function resetProviderState(): void { lanes.clear(); recent.length = 0; }

/** the state of every provider lane this process has used — for a health endpoint and the log */
export function providerHealth(now = Date.now(), opts: { detail?: boolean } = {}): LaneHealth[] {
  return [...lanes.values()].map((l) => {
    const cooldownMs = Math.max(0, l.cooldownUntil - now);
    const blocked = l.blocked && l.blocked.until > now ? l.blocked : null;
    return {
      lane: l.name,
      state: blocked ? "blocked" : cooldownMs > 0 ? "cooling_down" : l.consecutiveFailures > 0 || l.limit < l.maxLimit ? "degraded" : "ok",
      limit: l.limit, active: l.active, queued: l.waiters.length, cooldownMs, consecutiveFailures: l.consecutiveFailures,
      ...(l.lastError ? { lastError: { kind: l.lastError.kind, ...(l.lastError.status ? { status: l.lastError.status } : {}), at: new Date(l.lastError.at).toISOString(), ...(opts.detail && l.lastError.detail ? { detail: l.lastError.detail } : {}) } } : {}),
      ...(l.lastSuccessAt ? { lastSuccessAt: new Date(l.lastSuccessAt).toISOString() } : {}),
      ...(blocked ? { blockedBy: blocked.error.kind } : {}),
    };
  });
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/** equal jitter: half the window fixed, half random — never a thundering herd, never a zero wait */
export function backoffMs(attempt: number, policy: Pick<RetryPolicy, "delayMs" | "maxWaitMs">): number {
  const window = Math.min(policy.maxWaitMs ?? 30_000, Math.max(1, policy.delayMs) * 2 ** attempt);
  return Math.round(window / 2 + rng() * (window / 2));
}

/**
 * Take a place on the lane: refuse at once if the lane is blocked (a bad key,
 * an exhausted quota), wait out the shared cool-down and the concurrency
 * limit — but never past `deadline` (an absolute time, ms): a wait that does
 * not fit is reported as the error it is, with how long to come back.
 */
async function enter(lane: Lane, deadline: number, signal: AbortSignal | undefined, host: string): Promise<void> {
  const now = Date.now();
  if (lane.blocked && lane.blocked.until > now) {
    const b = lane.blocked.error;
    throw new ProviderError({ kind: b.kind, status: b.status, detail: b.detail, host, exhausted: true, attempts: 0 });
  }
  for (;;) {
    const t = Date.now();
    const cool = lane.cooldownUntil - t;
    if (cool > 0) {
      if (t + cool > deadline - 250) throw new ProviderError({ kind: "rate_limited", status: 429, detail: "the provider asked for a pause; another request on this server is already waiting it out", retryAfterMs: cool, exhausted: true, attempts: 0, host });
      await sleep(cool, signal);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      continue;
    }
    if (lane.active < lane.limit) { lane.active++; return; }
    const queuedFor = Math.min(MAX_QUEUE_MS, Math.max(0, deadline - t - 250));
    if (queuedFor <= 0) throw new ProviderError({ kind: "busy", retryAfterMs: 2000 + Math.round(rng() * 3000), exhausted: true, attempts: 0, host });
    let w!: Waiter;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => w.wake(), queuedFor);
      w = { wake: () => { clearTimeout(timer); signal?.removeEventListener("abort", w.wake); resolve(); } };
      signal?.addEventListener("abort", w.wake, { once: true });
      lane.waiters.push(w);
    });
    const i = lane.waiters.indexOf(w);
    if (i >= 0) lane.waiters.splice(i, 1);
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (Date.now() >= deadline - 250 && lane.active >= lane.limit) throw new ProviderError({ kind: "busy", retryAfterMs: 2000 + Math.round(rng() * 3000), exhausted: true, attempts: 0, host });
  }
}
function leave(lane: Lane): void {
  lane.active = Math.max(0, lane.active - 1);
  const next = lane.waiters.shift();
  next?.wake();
}
/** read the allowance a provider reports on a good response (Anthropic's and OpenAI-style headers) */
function noteCapacity(lane: Lane, h: Pick<Headers, "get">): void {
  const num = (...names: string[]) => { for (const n of names) { const v = h.get(n); if (v != null && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v); } return undefined; };
  const tokensRemaining = num("anthropic-ratelimit-tokens-remaining", "x-ratelimit-remaining-tokens");
  const tokensLimit = num("anthropic-ratelimit-tokens-limit", "x-ratelimit-limit-tokens");
  const requestsRemaining = num("anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests");
  const requestsLimit = num("anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests");
  if (tokensRemaining == null && requestsRemaining == null) return;
  lane.capacity = { tokensRemaining, tokensLimit, requestsRemaining, requestsLimit, at: Date.now() };
}

/**
 * A heads-up, only when the provider says its allowance is nearly spent: under
 * 5 % of the tokens (or requests) left in the current window. Otherwise null —
 * a researcher is told about tokens running out when they are about to, not
 * before, and never about a limit that is not near.
 */
export function capacityNotice(now = Date.now()): string | null {
  for (const l of lanes.values()) {
    const c = l.capacity;
    if (!c || now - c.at > 120_000) continue;
    const low = (rem?: number, lim?: number) => rem != null && lim != null && lim > 0 && rem / lim < 0.05;
    if (low(c.tokensRemaining, c.tokensLimit) || low(c.requestsRemaining, c.requestsLimit)) return "The AI service's allowance is nearly used up for the moment. If it runs out the Studio pauses, keeps your work, and carries on by itself when it is available again.";
  }
  return null;
}

function noteSuccess(lane: Lane): void {
  lane.consecutiveFailures = 0;
  lane.lastSuccessAt = Date.now();
  lane.blocked = null;
  if (lane.limit < lane.maxLimit && ++lane.successesSinceCut >= 8) { lane.limit++; lane.successesSinceCut = 0; lane.waiters.shift()?.wake(); }
}
function noteFailure(lane: Lane, err: ProviderError): void {
  lane.consecutiveFailures++;
  lane.lastError = { kind: err.kind, ...(err.status ? { status: err.status } : {}), at: Date.now(), ...(err.detail ? { detail: err.detail } : {}) };
  if (err.kind === "rate_limited" || err.kind === "overloaded") {
    /* the provider asked everyone to slow down: one cool-down for the lane, and half the concurrency */
    const wait = err.retryAfterMs ?? backoffMs(Math.min(lane.consecutiveFailures - 1, 4), { delayMs: 1000, maxWaitMs: 20_000 });
    lane.cooldownUntil = Math.max(lane.cooldownUntil, Date.now() + Math.min(wait, MAX_HINT_MS));
    const cut = Math.max(1, Math.floor(lane.limit / 2));
    if (cut < lane.limit) { lane.limit = cut; lane.successesSinceCut = 0; }
  } else if (err.kind === "auth" || err.kind === "quota_exhausted") {
    lane.blocked = { until: Date.now() + BLOCK_MS, error: err };
  }
}

/* ----------------------------------------------------------- the managed send */

export interface ManagedOptions {
  /** the provider's lane: its base URL and key (the key is hashed for the lane's name, never logged) */
  base: string;
  key: string;
  /** one HTTP attempt */
  once: () => Promise<Response>;
  /** aborts when the caller's time is up */
  signal?: AbortSignal;
  /** the caller's time limit as an absolute time (ms); retries and queueing never run past it */
  deadline: number;
  retry?: RetryPolicy;
  /** a name for the log: the operation and the model */
  label?: string;
  onEvent?: (e: ProviderEvent) => void;
}

/** what happened on the way to the answer — for the log, and for a caller that tells the researcher */
export type ProviderEvent =
  | { type: "retry"; kind: ProviderErrorKind; status?: number; attempt: number; waitMs: number }
  | { type: "fallback"; from: ProviderErrorKind; host: string }
  | { type: "recovered"; attempts: number };

/**
 * Send with the manager's policy. Resolves with the response when it is OK or
 * when it failed in a way that is not worth retrying (or the retries / the
 * deadline ran out) — the caller reads the failed response with
 * `classifyResponse`, which this function has already done once and logged.
 * Rejects with `ProviderError` when no response was obtained (the lane is
 * blocked, cooled, full, or the network failed on the last attempt), and
 * with the original AbortError when the caller's signal fired.
 */
export async function managedSend(o: ManagedOptions): Promise<Response> {
  const lane = laneFor(o.base, o.key);
  const host = hostOf(o.base);
  const retry = o.retry ?? DEFAULT_RETRY;
  let attempt = 0;
  for (;;) {
    await enter(lane, o.deadline, o.signal, host);
    let res: Response | null = null;
    let thrown: unknown = null;
    let err: ProviderError | null = null;
    /* the lane is held until the failure is READ and noted: a request woken by this one's departure must already see the cool-down */
    try {
      try { res = await o.once(); } catch (e) { thrown = e; }
      if (thrown) {
        if ((thrown as Error)?.name !== "AbortError" && !o.signal?.aborted) err = networkError(thrown, host);
      } else if (res && !res.ok) {
        const text = await res.clone().text().catch(() => "");
        err = classifyResponse(res.status, res.headers, text);
      }
      if (err) err = new ProviderError({ kind: err.kind, status: err.status, detail: err.detail, retryAfterMs: err.retryAfterMs, host, attempts: attempt + 1 });
      if (err) noteFailure(lane, err);
    } finally { leave(lane); }
    if (thrown && !err) throw thrown;
    if (!err && res) {
      noteSuccess(lane);
      noteCapacity(lane, res.headers);
      if (attempt > 0) { logProvider("recovered", { host, label: o.label, attempts: attempt + 1 }); o.onEvent?.({ type: "recovered", attempts: attempt + 1 }); }
      return res;
    }
    if (!err) throw new ProviderError({ kind: "network", detail: "no response", host });
    const last = attempt >= retry.retries;
    const wait = err.retryAfterMs != null ? err.retryAfterMs + Math.round(rng() * 250) : backoffMs(attempt, retry);
    const fits = Date.now() + wait < o.deadline - 250;
    if (!err.retryable || last || !fits) {
      if (err.kind !== "bad_request") logProvider(err.retryable ? "gave_up" : "refused", { host, label: o.label, kind: err.kind, status: err.status, attempts: attempt + 1, retryAfterMs: err.retryAfterMs, said: err.detail.slice(0, 200), reason: !err.retryable ? "not retryable" : last ? "retries used" : "no time left for the wait" });
      if (res) return res;
      throw new ProviderError({ kind: err.kind, status: err.status, detail: err.detail, retryAfterMs: err.retryAfterMs ?? (fits ? undefined : wait), host, exhausted: true, attempts: attempt + 1 });
    }
    logProvider("retry", { host, label: o.label, kind: err.kind, status: err.status, attempt: attempt + 1, waitMs: wait });
    o.onEvent?.({ type: "retry", kind: err.kind, status: err.status, attempt: attempt + 1, waitMs: wait });
    await sleep(wait, o.signal);
    if (o.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    attempt++;
  }
}

/* ------------------------------------------------------------- the fallback */

export interface FallbackProvider { base: string; key: string; model: string; modelSmall: string }

/**
 * The second provider, when the operator configured one: AI_FALLBACK_API_URL,
 * AI_FALLBACK_API_KEY and AI_FALLBACK_MODEL (AI_FALLBACK_MODEL_SMALL for the
 * small tier). All three are required, and the address must be https (or a
 * local http one): a half-configured or plain-http fallback is not used, and
 * it says so once in the log. Nothing is ever sent to a provider nobody named.
 */
let warnedFallback = false;
export function fallbackProvider(): FallbackProvider | null {
  const base = (process.env.AI_FALLBACK_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.AI_FALLBACK_API_KEY ?? "").trim();
  const model = (process.env.AI_FALLBACK_MODEL ?? "").trim();
  if (!base && !key && !model) return null;
  let ok = !!(base && key && model);
  if (ok) { try { const u = new URL(base); ok = u.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname); } catch { ok = false; } }
  if (!ok) {
    if (!warnedFallback) { warnedFallback = true; logProvider("fallback_unusable", { reason: "AI_FALLBACK_API_URL (https), AI_FALLBACK_API_KEY and AI_FALLBACK_MODEL must all be set" }); }
    return null;
  }
  return { base, key, model, modelSmall: (process.env.AI_FALLBACK_MODEL_SMALL ?? "").trim() || model };
}
export function resetFallbackWarning(): void { warnedFallback = false; }
