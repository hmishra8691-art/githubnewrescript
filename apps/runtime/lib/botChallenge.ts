/**
 * AN OPTIONAL BOT CHALLENGE ON OPEN LINKS (audit 2026-11-17, P1-08).
 *
 * A study switches it on with `deployment.access.botChallenge`. It runs only when this runtime has Cloudflare
 * Turnstile keys (TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY); without them the switch does nothing and the start
 * route says so in its log, so no study is locked out by a missing key. The respondent sees the challenge once,
 * before the first page; `session/start` verifies the token with Cloudflare before a response row is made.
 *
 * Test links, resumes of an existing session, and closed access modes (unique links, invitations, passwords) are
 * not challenged: the first three are not anonymous traffic, and a resume already passed the challenge once.
 *
 * When Cloudflare cannot be reached, the start is ALLOWED and logged (fail open): an outage at Cloudflare must not
 * close every study using the switch. The quality engine's bot checks still run on the finished response.
 */

type Env = Record<string, string | undefined>;

export interface ChallengeConfig { siteKey: string; secret: string }

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
const VERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

/** the keys, when both are set; null means the challenge is off on this runtime */
export function challengeConfig(env: Env): ChallengeConfig | null {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  const secret = (env.TURNSTILE_SECRET_KEY ?? "").trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

/** whether this start must carry a challenge token */
export function challengeRequired(opts: { enabled: boolean | undefined; isTest: boolean; resuming: boolean; accessMode: string; config: ChallengeConfig | null }): boolean {
  return !!opts.enabled && !!opts.config && !opts.isTest && !opts.resuming && opts.accessMode === "open";
}

export type ChallengeVerdict =
  | { ok: true; unverified?: string }
  | { ok: false; reason: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** ask Cloudflare whether the token is good; never throws */
export async function verifyChallenge(token: unknown, ip: string | null, cfg: ChallengeConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 5000): Promise<ChallengeVerdict> {
  if (typeof token !== "string" || !token.trim() || token.length > 4096) return { ok: false, reason: "missing" };
  const body = new URLSearchParams({ secret: cfg.secret, response: token });
  if (ip) body.set("remoteip", ip);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(VERIFY_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: ac.signal });
    if (!r.ok) return { ok: true, unverified: `siteverify HTTP ${r.status}` };
    const j = (await r.json().catch(() => null)) as { success?: boolean; "error-codes"?: string[] } | null;
    if (!j || typeof j.success !== "boolean") return { ok: true, unverified: "siteverify returned no verdict" };
    if (j.success) return { ok: true };
    const codes = Array.isArray(j["error-codes"]) ? j["error-codes"].map(String) : [];
    /* our own key is wrong: that is the operator's fault, not the respondent's — let them in and say so loudly */
    if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) return { ok: true, unverified: `the runtime's TURNSTILE_SECRET_KEY was refused (${codes.join(", ")})` };
    return { ok: false, reason: codes.join(", ") || "rejected" };
  } catch (e) {
    return { ok: true, unverified: `siteverify unreachable (${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message})` };
  } finally {
    clearTimeout(timer);
  }
}
