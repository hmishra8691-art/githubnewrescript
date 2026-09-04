/**
 * SESSION MANAGEMENT — the state machine, and the arithmetic that decides it.
 *
 * This answers the second of the four questions:
 *
 *     "Is this user currently logged in?"
 *
 * The requirement is strict about a single active login per user (§4) and
 * equally strict that a crashed browser must not lock an account out (§6,
 * §7). Those two pull in opposite directions, and the resolution is that
 * "active" is a claim with an expiry date rather than a flag: a session stays
 * active only while it keeps saying so.
 *
 *     ACTIVE ──no heartbeat for idleAfter──▶ IDLE
 *       │                                     │
 *       │                        no heartbeat for staleAfter
 *       │                                     ▼
 *       ├──past absoluteLifetime────────▶ EXPIRED ──▶ (login allowed again)
 *       ├──user clicks Logout──────────▶ LOGGED_OUT
 *       └──admin revokes──────────────▶ REVOKED
 *
 * IDLE still BLOCKS a second login: the user is probably reading. STALE and
 * everything past it does not: nobody is there. That single distinction is
 * what makes the feature usable rather than infuriating.
 *
 * Every threshold is configuration, never a literal in a code path (§7).
 */

export type SessionStatus = "active" | "idle" | "expired" | "logged_out" | "revoked";

/** What the database stores per session (§34). */
export interface SessionRecord {
  sessionId: string;
  userId: string;
  /** the stored status; a heartbeat-based status can still override it */
  status: "active" | "logged_out" | "revoked" | "expired";
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  revokedAt?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  deviceLabel?: string | null;
}

/**
 * The timing rules. Defaults are deliberately generous at the top end: a
 * survey programmer reading a 300-question instrument is working, not gone.
 */
export interface SessionPolicy {
  /** how often the browser is asked to check in */
  heartbeatSeconds: number;
  /** no heartbeat for this long → IDLE (still blocks a second login) */
  idleAfterSeconds: number;
  /** no heartbeat for this long → the session is treated as gone, login allowed */
  staleAfterSeconds: number;
  /** hard ceiling from login, however active the session is */
  absoluteLifetimeSeconds: number;
  /**
   * May a login displace a live session belonging to the same user? The
   * requirement says NO by default and "do not silently invalidate the first
   * session unless an administrator or explicit security setting allows it",
   * which is precisely what this switch is.
   */
  allowForceTakeover: boolean;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  heartbeatSeconds: 30,
  idleAfterSeconds: 5 * 60,
  staleAfterSeconds: 15 * 60,
  absoluteLifetimeSeconds: 12 * 60 * 60,
  allowForceTakeover: false,
};

/** Merge stored settings over the defaults, ignoring anything nonsensical. */
export function sessionPolicy(overrides?: Partial<SessionPolicy> | null): SessionPolicy {
  const p = { ...DEFAULT_SESSION_POLICY };
  if (!overrides) return p;
  const num = (v: unknown, min: number) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined);
  p.heartbeatSeconds = num(overrides.heartbeatSeconds, 5) ?? p.heartbeatSeconds;
  p.idleAfterSeconds = num(overrides.idleAfterSeconds, 30) ?? p.idleAfterSeconds;
  p.staleAfterSeconds = num(overrides.staleAfterSeconds, 60) ?? p.staleAfterSeconds;
  p.absoluteLifetimeSeconds = num(overrides.absoluteLifetimeSeconds, 300) ?? p.absoluteLifetimeSeconds;
  if (typeof overrides.allowForceTakeover === "boolean") p.allowForceTakeover = overrides.allowForceTakeover;
  // stale must not come before idle, or a session would skip IDLE entirely
  if (p.staleAfterSeconds < p.idleAfterSeconds) p.staleAfterSeconds = p.idleAfterSeconds;
  return p;
}

const secondsSince = (iso: string, now: number): number => (now - Date.parse(iso)) / 1000;

/**
 * The session's status right now — the stored status refined by the clock.
 *
 * A row that says "active" but has not been heard from since yesterday is not
 * active, and the only honest place to decide that is here, from the
 * timestamps, at the moment of asking. Storing "idle" and "expired" as data
 * would mean a background job had to be running for the truth to be correct.
 */
export function sessionStatus(s: SessionRecord, policy: SessionPolicy, nowMs = Date.now()): SessionStatus {
  if (s.status === "revoked") return "revoked";
  if (s.status === "logged_out") return "logged_out";
  if (s.status === "expired") return "expired";
  if (s.expiresAt && Date.parse(s.expiresAt) <= nowMs) return "expired";
  const age = secondsSince(s.createdAt, nowMs);
  if (age >= policy.absoluteLifetimeSeconds) return "expired";
  const quiet = secondsSince(s.lastSeenAt, nowMs);
  if (quiet >= policy.staleAfterSeconds) return "expired";
  if (quiet >= policy.idleAfterSeconds) return "idle";
  return "active";
}

/**
 * Does this session still authorize requests? ACTIVE and IDLE do — an idle
 * user has not been logged out, they have been quiet.
 */
export function sessionAuthorizes(s: SessionRecord, policy: SessionPolicy, nowMs = Date.now()): boolean {
  const st = sessionStatus(s, policy, nowMs);
  return st === "active" || st === "idle";
}

/**
 * Does this session block a fresh login for the same user (§4)?
 *
 * The same predicate as authorization on purpose: whatever can still act must
 * still be the one active session, and whatever cannot is out of the way.
 * Two separate predicates here would eventually disagree, and the failure
 * mode is either an account that cannot log back in or two live sessions.
 */
export function sessionBlocksLogin(s: SessionRecord, policy: SessionPolicy, nowMs = Date.now()): boolean {
  return sessionAuthorizes(s, policy, nowMs);
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  active: "Active",
  idle: "Idle",
  expired: "Expired",
  logged_out: "Logged out",
  revoked: "Revoked",
};

/** How the security screen explains a status, in a sentence (§8). */
export function sessionStatusHint(st: SessionStatus, policy: SessionPolicy): string {
  const mins = (s: number) => `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"}`;
  switch (st) {
    case "active": return "Checked in within the last few seconds.";
    case "idle": return `No activity for over ${mins(policy.idleAfterSeconds)}. Still signed in, and still the only session that can be used.`;
    case "expired": return `No activity for over ${mins(policy.staleAfterSeconds)}, so this session was released and you can sign in again.`;
    case "logged_out": return "Signed out from this device.";
    case "revoked": return "Ended by an administrator.";
  }
}

/**
 * The outcome of a login attempt, decided against whatever session the user
 * already has. Separated from the endpoint so it is testable and so the
 * message the user reads is decided in one place.
 */
export type LoginDecision =
  | { kind: "allowed" }
  | { kind: "blocked"; existing: SessionRecord; status: SessionStatus; message: string }
  | { kind: "takeover"; existing: SessionRecord };

export function decideLogin(
  existing: SessionRecord | null,
  policy: SessionPolicy,
  nowMs = Date.now(),
): LoginDecision {
  if (!existing) return { kind: "allowed" };
  if (!sessionBlocksLogin(existing, policy, nowMs)) return { kind: "allowed" };
  if (policy.allowForceTakeover) return { kind: "takeover", existing };
  const status = sessionStatus(existing, policy, nowMs);
  const where = existing.deviceLabel ? ` (${existing.deviceLabel})` : "";
  return {
    kind: "blocked",
    existing,
    status,
    message:
      `This account is already logged in on another device or session${where}. `
      + "Please log out from the active session before logging in here. "
      + `If that device is no longer available, the session is released automatically after `
      + `${Math.round(policy.staleAfterSeconds / 60)} minutes without activity.`,
  };
}

/* ------------------------------------------------------------ login throttle */

/**
 * Rate limiting and lockout (§3).
 *
 * Counted per account AND per source, because the two attacks are different:
 * many guesses at one account, and one guess at many accounts. A lockout is
 * always temporary — a permanent one is a denial-of-service anyone can
 * trigger against a colleague by typing a wrong password five times.
 */
export interface ThrottlePolicy {
  windowSeconds: number;
  maxAttemptsPerAccount: number;
  maxAttemptsPerSource: number;
  lockoutSeconds: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = {
  windowSeconds: 15 * 60,
  maxAttemptsPerAccount: 8,
  maxAttemptsPerSource: 25,
  lockoutSeconds: 15 * 60,
};

export function throttlePolicy(overrides?: Partial<ThrottlePolicy> | null): ThrottlePolicy {
  const p = { ...DEFAULT_THROTTLE };
  if (!overrides) return p;
  for (const k of Object.keys(p) as (keyof ThrottlePolicy)[]) {
    const v = overrides[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) p[k] = v;
  }
  return p;
}

export interface ThrottleState {
  accountFailures: number;
  sourceFailures: number;
  /** when an explicit lockout ends, if one is in force */
  lockedUntil?: string | null;
}

export type ThrottleDecision =
  | { kind: "allow" }
  | { kind: "locked"; retryAfterSeconds: number; message: string };

export function decideThrottle(
  state: ThrottleState,
  policy: ThrottlePolicy,
  nowMs = Date.now(),
): ThrottleDecision {
  if (state.lockedUntil) {
    const left = (Date.parse(state.lockedUntil) - nowMs) / 1000;
    if (left > 0) {
      return {
        kind: "locked",
        retryAfterSeconds: Math.ceil(left),
        message: `Too many sign-in attempts. Try again in ${Math.ceil(left / 60)} minute${Math.ceil(left / 60) === 1 ? "" : "s"}, or reset your password.`,
      };
    }
  }
  if (state.accountFailures >= policy.maxAttemptsPerAccount) {
    return {
      kind: "locked",
      retryAfterSeconds: policy.lockoutSeconds,
      message: `Too many sign-in attempts for this account. Try again in ${Math.round(policy.lockoutSeconds / 60)} minutes, or reset your password.`,
    };
  }
  if (state.sourceFailures >= policy.maxAttemptsPerSource) {
    return {
      kind: "locked",
      retryAfterSeconds: policy.lockoutSeconds,
      message: "Too many sign-in attempts from this network. Please try again later.",
    };
  }
  return { kind: "allow" };
}

/* ------------------------------------------------------------ user code */

/**
 * The platform's user code (§1, §21) — `USR-10482`.
 *
 * Sequential from a database counter rather than random, because it is meant
 * to be read aloud and typed by a colleague sharing a project. It starts at
 * 10000 so every code is the same length, and it is never derived from the
 * name or email: it is an identifier, not a fact about the person.
 */
export const USER_CODE_PREFIX = "USR-";
export const USER_CODE_START = 10000;
const USER_CODE_RE = /^USR-\d{5,}$/;

export function formatUserCode(n: number): string {
  return `${USER_CODE_PREFIX}${String(Math.max(USER_CODE_START, Math.trunc(n)))}`;
}

export function isUserCode(v: string): boolean {
  return USER_CODE_RE.test(v.trim().toUpperCase());
}

/**
 * What did someone type into a "User ID or email" box?
 *
 * Sniffing the shape rather than asking is what lets one field accept both
 * (§36), and it must be forgiving: `usr 10482`, `10482` and
 * `USR-10482` are all the same person to everyone except a regular
 * expression.
 */
export type Identifier =
  | { kind: "email"; value: string }
  | { kind: "user_code"; value: string }
  | { kind: "unknown"; value: string };

export function parseIdentifier(raw: string): Identifier {
  const v = raw.trim();
  if (!v) return { kind: "unknown", value: v };
  if (v.includes("@")) return { kind: "email", value: v.toLowerCase() };
  const compact = v.toUpperCase().replace(/[\s_]+/g, "-");
  const digits = compact.replace(/^USR-?/, "");
  if (/^\d{4,}$/.test(digits)) return { kind: "user_code", value: `${USER_CODE_PREFIX}${digits}` };
  return { kind: "unknown", value: v };
}

/* ------------------------------------------------------------ device label */

/**
 * A short, human description of where a session lives, for the security
 * screen and the "already logged in on another device" message.
 *
 * Derived from the user agent and deliberately coarse. The point is to help
 * someone recognise their own other machine, not to fingerprint them, and a
 * precise string would be exactly the tracking identifier the platform has
 * spent the quality work avoiding.
 */
export function deviceLabelFrom(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "Unknown device";
  const browser = /edg\//.test(ua) ? "Edge"
    : /opr\/|opera/.test(ua) ? "Opera"
    : /chrome\//.test(ua) && !/chromium/.test(ua) ? "Chrome"
    : /chromium/.test(ua) ? "Chromium"
    : /firefox\//.test(ua) ? "Firefox"
    : /safari\//.test(ua) ? "Safari"
    : "Browser";
  const os = /windows nt/.test(ua) ? "Windows"
    : /iphone|ipad|ipod/.test(ua) ? "iOS"
    : /mac os x|macintosh/.test(ua) ? "macOS"
    : /android/.test(ua) ? "Android"
    : /linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}
