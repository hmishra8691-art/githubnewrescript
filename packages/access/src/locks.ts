/**
 * COLLABORATIVE EDITING CONTROL — the edit lock's state machine.
 *
 * The fourth question, and the one users feel most directly:
 *
 *     "Is this user currently allowed to MODIFY this project?"
 *
 * Three facts have to be true at once for a save to be accepted, and keeping
 * them separate is what the requirement means by not implementing all of
 * this as one boolean:
 *
 *     1. the session authorizes requests at all        (sessions.ts)
 *     2. the role carries `survey.edit`                (roles.ts)
 *     3. the project's lock is held by THIS session    (here)
 *
 * A lock belongs to a SESSION, not merely to a user (§35). That is not
 * pedantry: the same person logging in elsewhere — after a takeover, or once
 * their old session went stale — must not inherit an edit lock their previous
 * browser was holding, because that browser may still have unsaved state and
 * would happily write it over the new one.
 *
 * Pure: the timings and the verdicts live here, the atomic claim lives in
 * SQL, and the two never disagree because SQL only ever enforces the expiry
 * this module computes.
 */

export type LockStatus = "free" | "held" | "stale" | "released" | "expired";

/** What the database stores per project (§16, §35). */
export interface LockRecord {
  surveyId: string;
  lockedByUserId: string;
  lockedBySessionId: string;
  /** the stored status; the clock can still override "held" */
  status: "held" | "released" | "revoked";
  createdAt: string;
  lastHeartbeatAt: string;
  expiresAt?: string | null;
  /**
   * Which part of the project the holder said they were working on. Not
   * enforced today — project-level exclusivity is the first implementation —
   * but stored from the beginning so section-level locking (§18) is a change
   * to the conflict test rather than a change to the schema, the API and
   * every caller.
   */
  section?: string | null;
  /** display only: who to name in the banner without a second query */
  lockedByName?: string | null;
  lockedByUserCode?: string | null;
}

export interface LockPolicy {
  /** how often the editor's browser refreshes the lock */
  heartbeatSeconds: number;
  /**
   * No heartbeat for this long and the lock is takeable. Long enough that a
   * programmer thinking, reading a long instrument, or on a call does not
   * lose their lock (§29: "avoid releasing the lock too aggressively while
   * the user is actively working"); short enough that a crashed browser does
   * not block the team for an afternoon (§17: "do not create permanent edit
   * locks").
   */
  staleAfterSeconds: number;
  /** a ceiling from acquisition, whatever the heartbeats say */
  maxHoldSeconds: number;
  /** may a project owner / platform admin take a LIVE lock away? (§30) */
  allowForceRelease: boolean;
}

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  heartbeatSeconds: 20,
  staleAfterSeconds: 3 * 60,
  maxHoldSeconds: 8 * 60 * 60,
  allowForceRelease: true,
};

export function lockPolicy(overrides?: Partial<LockPolicy> | null): LockPolicy {
  const p = { ...DEFAULT_LOCK_POLICY };
  if (!overrides) return p;
  const num = (v: unknown, min: number) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined);
  p.heartbeatSeconds = num(overrides.heartbeatSeconds, 5) ?? p.heartbeatSeconds;
  p.staleAfterSeconds = num(overrides.staleAfterSeconds, 30) ?? p.staleAfterSeconds;
  p.maxHoldSeconds = num(overrides.maxHoldSeconds, 300) ?? p.maxHoldSeconds;
  if (typeof overrides.allowForceRelease === "boolean") p.allowForceRelease = overrides.allowForceRelease;
  if (p.staleAfterSeconds <= p.heartbeatSeconds) p.staleAfterSeconds = p.heartbeatSeconds * 3;
  return p;
}

const secondsSince = (iso: string, now: number): number => (now - Date.parse(iso)) / 1000;

export function lockStatus(lock: LockRecord | null, policy: LockPolicy, nowMs = Date.now()): LockStatus {
  if (!lock) return "free";
  if (lock.status === "released") return "released";
  if (lock.status === "revoked") return "released";
  if (lock.expiresAt && Date.parse(lock.expiresAt) <= nowMs) return "expired";
  if (secondsSince(lock.createdAt, nowMs) >= policy.maxHoldSeconds) return "expired";
  if (secondsSince(lock.lastHeartbeatAt, nowMs) >= policy.staleAfterSeconds) return "stale";
  return "held";
}

/** Is anybody actually holding this project right now? */
export function lockIsLive(lock: LockRecord | null, policy: LockPolicy, nowMs = Date.now()): boolean {
  return lockStatus(lock, policy, nowMs) === "held";
}

/**
 * Whether a lock is available to a given session — the predicate the atomic
 * SQL claim implements, stated once here so the two cannot drift.
 *
 * A session that already holds the lock is always allowed: re-acquiring is
 * how a page reload gets its edit mode back, and it must not be a conflict.
 */
export function lockAvailableTo(
  lock: LockRecord | null,
  sessionId: string,
  policy: LockPolicy,
  nowMs = Date.now(),
): boolean {
  if (!lock) return true;
  if (lock.lockedBySessionId === sessionId && lockStatus(lock, policy, nowMs) === "held") return true;
  return !lockIsLive(lock, policy, nowMs);
}

/** The reason a save is being refused, in the words the UI shows. */
export type EditVerdict =
  | { allowed: true; reason: "holds_lock" }
  | { allowed: false; reason: "no_capability"; message: string }
  | { allowed: false; reason: "locked_by_other"; message: string; heldBy: LockRecord }
  | { allowed: false; reason: "lock_not_held"; message: string }
  | { allowed: false; reason: "lock_moved"; message: string; heldBy: LockRecord };

/**
 * May this session modify the project right now?
 *
 * This is the check the BACKEND runs before accepting any project-modifying
 * request (§16). The frontend runs the same function to decide what to grey
 * out, but the frontend's answer is a courtesy — the requirement is explicit
 * that a manipulated client must still be refused, and it is refused here,
 * server-side, on data the client does not control.
 */
export function decideEdit(args: {
  canEdit: boolean;
  lock: LockRecord | null;
  sessionId: string;
  /** the acting user, so "my other browser holds it" can be told apart from "a colleague holds it" */
  userId: string;
  policy: LockPolicy;
  nowMs?: number;
}): EditVerdict {
  const { canEdit, lock, sessionId, userId, policy } = args;
  const nowMs = args.nowMs ?? Date.now();
  if (!canEdit) {
    return {
      allowed: false,
      reason: "no_capability",
      message: "Your role on this project does not allow changes.",
    };
  }
  const status = lockStatus(lock, policy, nowMs);
  if (!lock || status !== "held") {
    return {
      allowed: false,
      reason: "lock_not_held",
      message: "You are not in edit mode. Enter edit mode before saving changes.",
    };
  }
  if (lock.lockedBySessionId === sessionId) {
    return { allowed: true, reason: "holds_lock" };
  }
  // same person, different session: their other browser owns the lock, and
  // that browser's unsaved state is exactly what must not be overwritten
  if (lock.lockedByUserId === userId) {
    return {
      allowed: false, reason: "lock_moved", heldBy: lock,
      message: "This project is being edited in another of your sessions. Close it, or release the lock there, before editing here.",
    };
  }
  const who = lock.lockedByName ?? lock.lockedByUserCode ?? "another user";
  return {
    allowed: false,
    reason: "locked_by_other",
    heldBy: lock,
    message: `This project is currently being edited by ${who}. You can view the project, but editing is temporarily unavailable.`,
  };
}

/**
 * The banner text for whoever is looking at the project (§14, §15, §38).
 * One function so the three screens that show this cannot word it three ways.
 */
export function lockBanner(
  lock: LockRecord | null,
  sessionId: string,
  policy: LockPolicy,
  nowMs = Date.now(),
): { tone: "free" | "mine" | "other" | "stale"; title: string; detail?: string } {
  const status = lockStatus(lock, policy, nowMs);
  if (!lock || (status !== "held" && status !== "stale")) {
    return { tone: "free", title: "Project available for editing." };
  }
  const who = lock.lockedByName ?? lock.lockedByUserCode ?? "Another user";
  const since = new Date(lock.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const quiet = Math.round(secondsSince(lock.lastHeartbeatAt, nowMs));
  if (lock.lockedBySessionId === sessionId && status === "held") {
    return { tone: "mine", title: "You are editing this project.", detail: `Since ${since}.` };
  }
  if (status === "stale") {
    return {
      tone: "stale",
      title: `${who} left this project open without saving activity.`,
      detail: `Editing since ${since}, last active ${Math.round(quiet / 60)} minute${Math.round(quiet / 60) === 1 ? "" : "s"} ago — the lock can now be taken over.`,
    };
  }
  return {
    tone: "other",
    title: `${who} is currently editing this project.`,
    detail: `Editing since ${since}. You have read-only access until the editing lock is released.`,
  };
}

/* ------------------------------------------------------------ presence */

export type PresenceActivity = "editing" | "viewing" | "reviewing" | "testing";

/** One person currently inside a project (§13, §20). */
export interface PresenceEntry {
  userId: string;
  userCode: string;
  name: string;
  email?: string | null;
  role: string;
  activity: PresenceActivity;
  lastSeenAt: string;
  sessionId: string;
}

export interface PresencePolicy {
  /** how often a viewer reports in */
  heartbeatSeconds: number;
  /** no report for this long and they are no longer shown as present */
  presentWithinSeconds: number;
}

export const DEFAULT_PRESENCE_POLICY: PresencePolicy = {
  heartbeatSeconds: 15,
  presentWithinSeconds: 60,
};

export function presencePolicy(overrides?: Partial<PresencePolicy> | null): PresencePolicy {
  const p = { ...DEFAULT_PRESENCE_POLICY };
  if (!overrides) return p;
  if (typeof overrides.heartbeatSeconds === "number" && overrides.heartbeatSeconds >= 5) p.heartbeatSeconds = overrides.heartbeatSeconds;
  if (typeof overrides.presentWithinSeconds === "number" && overrides.presentWithinSeconds >= 15) p.presentWithinSeconds = overrides.presentWithinSeconds;
  if (p.presentWithinSeconds <= p.heartbeatSeconds) p.presentWithinSeconds = p.heartbeatSeconds * 3;
  return p;
}

/**
 * Who is still here, newest first, with the editor pinned to the top.
 *
 * The activity each person shows is derived from the lock and their role
 * rather than self-reported, so "Editing" always means the one person who
 * actually holds the lock — a client that claimed to be editing could
 * otherwise show two editors on a project that can only have one.
 */
export function activePresence(
  entries: PresenceEntry[],
  policy: PresencePolicy,
  nowMs = Date.now(),
): PresenceEntry[] {
  return entries
    .filter((e) => secondsSince(e.lastSeenAt, nowMs) < policy.presentWithinSeconds)
    .sort((a, b) => {
      if (a.activity === "editing" && b.activity !== "editing") return -1;
      if (b.activity === "editing" && a.activity !== "editing") return 1;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });
}

/** The activity to display for one present user, given who holds the lock. */
export function activityFor(
  role: string,
  sessionId: string,
  lock: LockRecord | null,
  policy: LockPolicy,
  nowMs = Date.now(),
): PresenceActivity {
  if (lock && lock.lockedBySessionId === sessionId && lockIsLive(lock, policy, nowMs)) return "editing";
  if (role === "reviewer") return "reviewing";
  if (role === "test_user") return "testing";
  return "viewing";
}

/** Initials for the presence avatars, from whatever name we actually have. */
export function initialsOf(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A stable colour per user for the avatars — derived from the id so the same
 * person is the same colour on every screen and in every session, with no
 * colour assignment to store or coordinate.
 */
export function avatarHue(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) % 360;
  return h;
}
