/**
 * RESPONDENT ENDPOINT RATE LIMITS (audit 2026-11-17, P0-08 / SEC-02).
 *
 * Nothing limited how often one address could call `/api/session/start` or `/api/session/save`. A script could
 * open thousands of sessions a minute, filling quotas with junk and spending the database's 60 connections. That
 * starves real respondents.
 *
 * This is the in-app layer: a sliding one-minute window per (route, client address), kept in each serverless
 * instance's memory. It is deliberately GENEROUS, because panels and offices put many real respondents behind
 * one address (carrier NAT, corporate proxies):
 * - start: 60 per minute per address;
 * - save: 600 per minute (a respondent saves about once a page);
 * - entry links: 120 per minute.
 * It stops floods, not crowds.
 *
 * It does NOT replace an edge limit: every instance counts on its own, so the real ceiling is
 * limit × instances. A Vercel or Cloudflare WAF rule in front of the runtime is the durable answer (owner decision,
 * see docs/RATE-LIMITS-2026-11-17.md).
 *
 *   RUNTIME_RATE_LIMIT=off                         no limit
 *   RUNTIME_RATE_LIMIT=start=60,save=600,entry=120 per-minute limits (any subset; the rest keep their defaults)
 */

/* `portal_auth`: sign-in, invitation and reset attempts of the respondent portal — far below the survey routes, because nobody types a password 60 times a minute */
export type LimitedRoute = "start" | "save" | "entry" | "portal_auth" | "portal";
export const DEFAULT_LIMITS: Record<LimitedRoute, number> = { start: 60, save: 600, entry: 120, portal_auth: 20, portal: 240 };
const WINDOW_MS = 60_000;
/* a bound on memory: past it the oldest addresses are forgotten (an attacker rotating addresses gains nothing from that) */
const MAX_KEYS = 20_000;

export function readLimits(env: Record<string, string | undefined>): Record<LimitedRoute, number> | null {
  const raw = (env.RUNTIME_RATE_LIMIT ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return null;
  const out = { ...DEFAULT_LIMITS };
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(start|save|entry|portal_auth|portal)\s*=\s*(\d{1,6})$/.exec(part);
    if (m && Number(m[2]) > 0) out[m[1] as LimitedRoute] = Number(m[2]);
  }
  return out;
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly limits: Record<LimitedRoute, number>;
  private readonly now: () => number;
  constructor(limits: Record<LimitedRoute, number>, now: () => number = Date.now) { this.limits = limits; this.now = now; }

  /** count this call; `retryAfter` (seconds) when it is over the limit */
  check(route: LimitedRoute, address: string): { ok: true } | { ok: false; retryAfter: number; limit: number } {
    const limit = this.limits[route];
    const key = `${route}|${address || "unknown"}`;
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (t - fresh[0])) / 1000)), limit };
    }
    fresh.push(t);
    this.hits.delete(key);
    this.hits.set(key, fresh);
    if (this.hits.size > MAX_KEYS) { const first = this.hits.keys().next().value; if (first !== undefined) this.hits.delete(first); }
    return { ok: true };
  }

  get size(): number { return this.hits.size; }
}

let shared: SlidingWindowLimiter | null | undefined;
/** the instance's limiter, or null when limits are off */
export function runtimeLimiter(): SlidingWindowLimiter | null {
  if (shared === undefined) { const l = readLimits(process.env); shared = l ? new SlidingWindowLimiter(l) : null; }
  return shared;
}

/** the 429 a limited route answers with, or null to go on */
export function limited(route: LimitedRoute, address: string): Response | null {
  const l = runtimeLimiter();
  if (!l) return null;
  const r = l.check(route, address);
  if (r.ok) return null;
  return new Response(JSON.stringify({ error: "Too many requests from this connection. Please wait a moment and try again.", code: "rate_limited", retryAfter: r.retryAfter }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(r.retryAfter), "cache-control": "no-store" },
  });
}
