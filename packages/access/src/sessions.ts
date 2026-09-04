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
 * ONE ACTIVE SESSION IS NOT THE SAME AS ONE ALLOWED DEVICE. The revised §12
 * separates them: the account may still have exactly one live session, but a
 * person signing in from a second machine gets it, and the first session is
 * ended — audited, with its edit locks released, and with the old browser
 * told on its next heartbeat. Refusing the second machine was the bug (P0-2),
 * not the feature.
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
   * May a login displace a live session belonging to the same user?
   *
   * This default was `false` and it was wrong in practice. The original
   * requirement said "do not silently invalidate the first session", and the
   * literal reading produced the P0 that replaced it: a researcher who moved
   * from their desk to a laptop was refused entry to their own account and
   * had to wait out a 15-minute stale timer. The revised requirement (§12) is
   * explicit — "the user must be able to move from System A to System B and
   * continue working with the same account", and "if the product requirement
   * remains strictly one active session per account, the previous session may
   * be invalidated when the new session is created. However, the new session
   * MUST still work correctly."
   *
   * So the default is now: the newest login wins. Exclusivity is still real —
   * there is still exactly one active session per account, still enforced by
   * a unique partial index rather than by this flag — but the loser of that
   * contest is the OLD session, not the person standing at the keyboard.
   *
   * Nothing about it is silent. The displaced session is ended with
   * `ended_reason = 'taken_over'`, its edit locks are released so it cannot
   * hold the project hostage from a browser nobody is looking at, the event
   * is audited, and the old browser is told what happened on its next
   * heartbeat rather than discovering it at the next save.
   *
   * A workspace that genuinely needs the strict behaviour can still set this
   * to false in its access settings — but see `decideLogin`: even then, the
   * refusal must never be the last word, because §12 requires the new session
   * to work.
   */
  allowForceTakeover: boolean;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  heartbeatSeconds: 30,
  idleAfterSeconds: 5 * 60,
  staleAfterSeconds: 15 * 60,
  absoluteLifetimeSeconds: 12 * 60 * 60,
  allowForceTakeover: true,
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
  /**
   * Strict mode only: there is a live session elsewhere and the policy will
   * not displace it without being asked. This is NOT a dead end — §12 requires
   * the new session to work — so it always carries `canConfirmTakeover`, and
   * the login screen turns it into "Sign in here and end the other session".
   * The person, not the policy, does the invalidating, which is exactly what
   * "do not SILENTLY invalidate the first session" asks for.
   */
  | {
      kind: "blocked";
      existing: SessionRecord;
      status: SessionStatus;
      message: string;
      canConfirmTakeover: true;
    }
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
  const where = existing.deviceLabel ? ` on ${existing.deviceLabel}` : "";
  return {
    kind: "blocked",
    existing,
    status,
    canConfirmTakeover: true,
    message:
      `This account is already signed in${where}`
      + `${status === "idle" ? ", though it has been idle" : ""}. `
      + "You can sign in here and end that session — any unsaved work there will not be saved.",
  };
}

/**
 * Did the caller explicitly ask to displace the other session?
 *
 * One place decides it so the login route, the tests and any future client
 * agree on what counts as consent. A body flag is enough: consent is a UI
 * affordance, not a security boundary — the account's own password has
 * already been verified by the time this is asked, and the only thing being
 * "protected" is the account holder's other browser from themselves.
 */
export function requestedTakeover(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const v = (body as Record<string, unknown>).force ?? (body as Record<string, unknown>).endOtherSession;
  return v === true || v === "true" || v === 1;
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
