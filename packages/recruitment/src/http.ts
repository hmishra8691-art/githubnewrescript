import { AdapterError } from "./adapter.js";

/**
 * THE TRANSPORT EVERY LIVE ADAPTER SITS ON (Phase 6).
 *
 * Nothing here knows which vendor it is talking to. It knows four things that every vendor call needs and that
 * every adapter would otherwise reimplement slightly differently:
 *
 *   WHAT MAY BE RETRIED   not "did it fail", but "is trying again safe". A feasibility lookup may be retried
 *                         freely. An order placement may NOT — unless the vendor accepts an idempotency key,
 *                         in which case it may. Getting this wrong buys the same sample twice.
 *   HOW LONG TO WAIT      exponential backoff with full jitter, and `Retry-After` obeyed when the vendor sends
 *                         one, because a vendor that tells you when to come back has told you something more
 *                         accurate than your own formula.
 *   WHEN TO STOP TRYING   a circuit breaker per integration, so one vendor being down does not hold open every
 *                         request in every project that happens to include it.
 *   WHAT TO RECORD        one row per call, so health is computed from observed behaviour rather than declared.
 *
 * ## A warning about the circuit breaker
 *
 * The in-process breaker below is a FAST PATH, not the source of truth. On serverless hosting each invocation
 * may be a fresh process, so in-memory state is frequently empty and the breaker then behaves as if closed. A
 * breaker that silently does nothing in production while looking correct in tests is worse than no breaker, so
 * this one takes an optional `state` store: give it one backed by the database and it works across processes;
 * leave it out and it degrades to per-process, which is honest but weak. `vendor_api_calls` in 0086 is what a
 * durable implementation reads.
 */

export type RetryPolicy = "safe" | "idempotent" | "never";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * `safe` — a read; retry freely.
   * `idempotent` — a write carrying a key the vendor de-duplicates on; retry is safe BECAUSE of that key.
   * `never` — a write with no such key. One attempt. A timeout here is genuinely ambiguous and is reported as
   *           such rather than retried into a double order.
   */
  retry?: RetryPolicy;
  /** per attempt, in milliseconds */
  timeoutMs?: number;
  /** across all attempts; a caller's own deadline always wins over our retry schedule */
  deadlineMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** parsed when the response is JSON, otherwise the raw text */
  body: unknown;
  raw: string;
  attempts: number;
  elapsedMs: number;
}

export interface CallRecord {
  integrationId: string;
  operation: string;
  method: string;
  /** the path only — a query string can carry participant identifiers, so it is dropped */
  path: string;
  status: number | null;
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  error?: string;
  retryAfterMs?: number;
}

/** Where a durable breaker keeps its state. Implement it over the database to make the breaker real. */
export interface BreakerState {
  get(key: string): Promise<{ failures: number; openedAt: number | null } | null>;
  set(key: string, value: { failures: number; openedAt: number | null }): Promise<void>;
}

export interface HttpOptions {
  /** called once per request with the outcome, for health and rate-limit accounting */
  record?: (row: CallRecord) => void | Promise<void>;
  state?: BreakerState;
  /** injectable for tests and for the replay harness */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** deterministic jitter in tests */
  random?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** consecutive failures before the breaker opens */
export const BREAKER_THRESHOLD = 5;
/** how long it stays open before one trial request is allowed through */
export const BREAKER_COOLDOWN_MS = 60_000;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Is trying again safe AND worth it?
 *
 * Two separate questions, and both must be yes. A 500 on an order placement with no idempotency key is
 * retryable in the "the vendor might work next time" sense and NOT retryable in the sense that matters, because
 * the first attempt may have placed the order before failing to tell us.
 */
export function mayRetry(policy: RetryPolicy, status: number | null, method: string): boolean {
  if (policy === "never") return false;
  if (policy === "safe" && method !== "GET" && method !== "HEAD") {
    // a caller that marked a write as `safe` is mistaken; refuse rather than honour it
    return false;
  }
  if (status === null) return true;          // transport failure, no response
  return RETRYABLE_STATUS.has(status);
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild; neither may be trusted blindly. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms >= 0 && ms <= 300_000 ? ms : null;   // a vendor asking for an hour is capped, not obeyed
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms > 0 && ms <= 300_000 ? ms : null;
}

/**
 * Full jitter: wait a random amount up to the exponential ceiling, not the ceiling itself.
 *
 * Equal backoff puts every client back on the vendor at the same instant, which is how a recovering API is
 * knocked over by the retries of the outage it just ended.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.floor(random() * ceiling);
}

const breakerKey = (integrationId: string) => `breaker:${integrationId}`;
const memory = new Map<string, { failures: number; openedAt: number | null }>();

async function readBreaker(opts: HttpOptions, key: string) {
  if (opts.state) return (await opts.state.get(key)) ?? { failures: 0, openedAt: null };
  return memory.get(key) ?? { failures: 0, openedAt: null };
}

async function writeBreaker(opts: HttpOptions, key: string, v: { failures: number; openedAt: number | null }) {
  if (opts.state) await opts.state.set(key, v); else memory.set(key, v);
}

/** Exposed so tests and operators can reason about the breaker rather than guess at it. */
export async function breakerStatus(integrationId: string, opts: HttpOptions = {}) {
  const now = (opts.now ?? Date.now)();
  const s = await readBreaker(opts, breakerKey(integrationId));
  if (s.openedAt === null) return { open: false, failures: s.failures, retryInMs: 0 };
  const elapsed = now - s.openedAt;
  return elapsed >= BREAKER_COOLDOWN_MS
    ? { open: false, failures: s.failures, retryInMs: 0, halfOpen: true }
    : { open: true, failures: s.failures, retryInMs: BREAKER_COOLDOWN_MS - elapsed };
}

/** Only for tests — production state lives in the store. */
export function resetBreakers(): void { memory.clear(); }

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

/** The path without its query string: a query can carry a participant id, and this row is kept for 90 days. */
function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return "/"; }
}

/**
 * One vendor call, with the whole policy applied.
 *
 * Throws `AdapterError` rather than returning a failure, because every caller of this is an adapter method
 * whose contract already says that transport faults throw and vendor-side "no" answers do not.
 */
export async function vendorFetch(
  integrationId: string,
  operation: string,
  req: HttpRequest,
  opts: HttpOptions = {},
): Promise<HttpResult> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const random = opts.random ?? Math.random;
  const method = req.method ?? "GET";
  const policy = req.retry ?? (method === "GET" ? "safe" : "never");
  const started = now();
  const deadline = req.deadlineMs ? started + req.deadlineMs : null;
  const key = breakerKey(integrationId);

  const breaker = await breakerStatus(integrationId, opts);
  if (breaker.open) {
    /*
     * Refused locally, without touching the network. `retryable: true` because the vendor is not known to be
     * broken for this particular request — the breaker is a statement about recent history, not about this call.
     */
    await opts.record?.({
      integrationId, operation, method, path: safePath(req.url), status: null, ok: false,
      attempts: 0, elapsedMs: 0, error: `circuit open; retry in ${Math.ceil(breaker.retryInMs / 1000)}s`,
    });
    throw new AdapterError(
      `This vendor's integration has failed repeatedly and calls to it are paused for another ${Math.ceil(breaker.retryInMs / 1000)} seconds.`,
      { retryable: true },
    );
  }

  const maxAttempts = Math.max(1, req.maxAttempts ?? (policy === "never" ? 1 : DEFAULT_MAX_ATTEMPTS));
  let attempts = 0;
  let lastError: unknown = null;
  let lastStatus: number | null = null;
  let retryAfterMs: number | undefined;

  while (attempts < maxAttempts) {
    attempts++;
    if (req.signal?.aborted) throw new AdapterError("The caller went away before the vendor answered.", { retryable: false });

    const perAttempt = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => perAttempt.abort(), timeoutMs);
    const onOuterAbort = () => perAttempt.abort();
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await doFetch(req.url, {
        method,
        headers: req.body !== undefined
          ? { "content-type": "application/json", ...(req.headers ?? {}) }
          : (req.headers ?? {}),
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: perAttempt.signal,
      });

      const raw = await res.text();
      lastStatus = res.status;
      const headers = headerObject(res.headers);
      retryAfterMs = parseRetryAfter(headers["retry-after"] ?? null, now()) ?? undefined;

      if (res.ok) {
        await writeBreaker(opts, key, { failures: 0, openedAt: null });
        let body: unknown = raw;
        if ((headers["content-type"] ?? "").includes("json")) {
          try { body = raw ? JSON.parse(raw) : null; } catch { /* a vendor mislabelling its own content type is its text */ }
        }
        const elapsedMs = now() - started;
        await opts.record?.({ integrationId, operation, method, path: safePath(req.url), status: res.status, ok: true, attempts, elapsedMs });
        return { status: res.status, ok: true, headers, body, raw, attempts, elapsedMs };
      }

      if (!mayRetry(policy, res.status, method) || attempts >= maxAttempts) {
        lastError = new AdapterError(
          `The vendor answered ${res.status}${raw ? `: ${raw.slice(0, 300)}` : ""}`,
          { retryable: RETRYABLE_STATUS.has(res.status), vendorStatus: res.status },
        );
        break;
      }
    } catch (err) {
      lastError = err;
      lastStatus = null;
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (aborted && req.signal?.aborted) {
        throw new AdapterError("The caller went away before the vendor answered.", { retryable: false });
      }
      if (!mayRetry(policy, null, method) || attempts >= maxAttempts) break;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }

    const wait = retryAfterMs ?? backoffMs(attempts, random);
    if (deadline !== null && now() + wait >= deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }

  /*
   * Failed. Count it against the breaker — but only a transport or server-side failure. A 400 because the
   * audience was malformed is this platform's bug, and tripping the breaker on it would take a working vendor
   * offline for everybody over one bad request.
   */
  const countsAgainstVendor = lastStatus === null || lastStatus >= 500 || lastStatus === 429;
  if (countsAgainstVendor) {
    const s = await readBreaker(opts, key);
    const failures = s.failures + 1;
    await writeBreaker(opts, key, {
      failures,
      openedAt: failures >= BREAKER_THRESHOLD ? now() : s.openedAt,
    });
  }

  const elapsedMs = now() - started;
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown transport failure");
  await opts.record?.({
    integrationId, operation, method, path: safePath(req.url), status: lastStatus, ok: false,
    attempts, elapsedMs, error: message.slice(0, 500), retryAfterMs,
  });

  if (lastError instanceof AdapterError) throw lastError;
  throw new AdapterError(
    policy === "never" && lastStatus === null
      ? `The vendor did not answer, and this request cannot safely be repeated — it may or may not have been accepted. Check the order's state with the vendor before retrying. (${message})`
      : `Could not reach the vendor after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}: ${message}`,
    { retryable: lastStatus === null || (lastStatus !== null && RETRYABLE_STATUS.has(lastStatus)), vendorStatus: lastStatus ?? undefined, cause: lastError },
  );
}
