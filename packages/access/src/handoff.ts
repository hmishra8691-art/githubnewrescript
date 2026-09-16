/**
 * THE RULES BOTH SIDES OF THE SESSION HANDOFF MUST AGREE ON.
 *
 * `rescript_session` is host-only, so the Studio's cookie never reaches
 * Rescript Interviews. A shared cookie domain is not available to fix it —
 * `vercel.app` is on the Public Suffix List, which exists precisely to stop one
 * deployment setting cookies for another — so the session is carried across
 * once, as a single-use code in a redirect.
 *
 * That handshake has two ends in two applications, and every value they must
 * agree on lives here rather than being written down twice. A callback path
 * that drifted, or a `next` that one side sanitised and the other did not,
 * would not fail loudly: it would fail as a sign-in loop, or as an open
 * redirect on the one endpoint in the system that mints credentials.
 *
 * Everything in this file is pure. The parts that cannot be trusted to
 * application code at all — single use, expiry, and the binding of a code to
 * one destination — are enforced in SQL by `0032_auth_handoff.sql`, because a
 * check that lives in one of two apps is a check the other app can forget.
 */

/** The path the receiving application serves. Both ends build it from here. */
export const HANDOFF_CALLBACK_PATH = "/api/auth/callback";

/** The path the issuing application serves. */
export const HANDOFF_START_PATH = "/api/auth/handoff";

/**
 * How long a code is good for.
 *
 * Long enough for a redirect and a slow network, short enough that a code
 * found in a proxy log is already dead. The database clamps this to [10, 120]
 * independently, so this constant is a preference and not the last word.
 */
export const HANDOFF_TTL_SECONDS = 60;

/**
 * A path on the target application, or "/".
 *
 * The test that matters is the second one. "//evil.example" starts with "/"
 * and is a protocol-relative URL, so a check for a leading slash alone turns
 * this into an open redirect — on the endpoint that hands out sessions.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  /* a backslash is a slash to some URL parsers and not to others; refuse it */
  if (raw.includes("\\")) return "/";
  return raw;
}

/**
 * The scheme-host-port of a URL, or null.
 *
 * Returns the ORIGIN rather than the string it was given, so
 * "https://Example.com/path/" and "https://example.com" compare equal — a
 * trailing slash or a capital letter in an environment variable should not be
 * the reason a deployment cannot sign anybody in.
 */
export function normaliseOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The origins permitted to receive a session, from a comma-separated setting.
 *
 * Deliberately no wildcard support. "https://*.vercel.app" reads like a
 * convenience for preview deployments and means every Vercel deployment owned
 * by anyone, which on this endpoint means handing sessions to the internet. A
 * new application is a new entry.
 */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const o = normaliseOrigin(part);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/** Exact match against the allowlist, both sides normalised first. */
export function originAllowed(
  origin: string | null | undefined,
  allowed: readonly string[],
): boolean {
  const o = normaliseOrigin(origin);
  return !!o && allowed.includes(o);
}

/**
 * Where an unauthenticated visitor to the receiving app is sent.
 *
 * Note it points at the handoff and NOT at the Studio's login form. Sending
 * somebody to `/login` signs them in on the Studio's origin and returns them
 * still signed out, which is the bug this whole mechanism exists to fix.
 */
export function handoffStartUrl(
  studioOrigin: string,
  selfOrigin: string,
  next = "/",
): string | null {
  const studio = normaliseOrigin(studioOrigin);
  const self = normaliseOrigin(selfOrigin);
  if (!studio || !self) return null;
  const u = new URL(HANDOFF_START_PATH, studio);
  u.searchParams.set("origin", self);
  u.searchParams.set("next", safeNextPath(next));
  return u.toString();
}

/** Where the issuing app sends the visitor back to, with the code. */
export function handoffCallbackUrl(
  targetOrigin: string,
  code: string,
  next = "/",
): string | null {
  const target = normaliseOrigin(targetOrigin);
  if (!target || !code) return null;
  const u = new URL(HANDOFF_CALLBACK_PATH, target);
  u.searchParams.set("code", code);
  u.searchParams.set("next", safeNextPath(next));
  return u.toString();
}
