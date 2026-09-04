import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import {
  can, decideAccess, decideEdit, isProjectRole, lockStatus, sessionAuthorizes, sessionStatus,
  ROLE_LABEL,
  type Actor, type Capability, type LockRecord, type ProjectRole, type RoleSource,
  type SessionRecord, type AuditEvent,
} from "@rescript/access";
import { clearSessionCookie, loadPolicies, sessionIdFrom, supabaseService, type AccessPolicies } from "./authServer";

/**
 * THE GATE. Every authenticated request in the Studio passes through here.
 *
 * The requirement is explicit that permission decisions happen server-side and
 * that a manipulated frontend must still be refused (§17, §23, §40). This file
 * is where that is true. It asks the four questions in order, and stops at the
 * first "no":
 *
 *     1. requireUser         is there a live session, and whose?
 *     2. requireProject      does this user hold a role on this project?
 *        …with a capability  does that role permit this action?
 *     3. requireEditRight    does this session hold the edit lock?
 *
 * They are separate functions because they are separate questions with
 * different answers and different messages. A viewer who tries to save is not
 * "unauthenticated", and an editor without the lock is not "forbidden" — and
 * a UI that cannot tell those apart cannot tell the user what to do next.
 *
 * Nothing here trusts anything from the client except the session cookie, and
 * that is validated against the database on every single call. No user id, no
 * role, no project id and no lock state is ever read from a request body.
 */

export interface AuthedUser extends Actor {
  sessionId: string;
  email: string;
  fullName: string;
  userCode: string;
  platformRole: string;
  policies: AccessPolicies;
}

export type GuardFailure = { response: NextResponse };
const fail = (body: Record<string, unknown>, status: number): GuardFailure => ({
  response: NextResponse.json(body, { status }),
});

/**
 * A refusal that also DELETES THE SESSION COOKIE. This is the root fix for
 * P0-3 and P0-4.
 *
 * The redirect loop went like this. A session expires. The browser still has
 * the cookie, because nothing ever took it away. The edge middleware sees a
 * cookie, concludes the visitor is signed in, and lets them onto `/`. The page
 * calls `/api/auth/me`, gets 401, and sends them to `/login`. The middleware
 * sees the same cookie again and bounces them back to `/`. Round and round,
 * and typing `/login` by hand does not escape it either — which is P0-4.
 *
 * There were two ways to break the cycle. One is to teach the middleware to
 * validate sessions, which it cannot do: it runs at the edge with no database.
 * The other is to make the cookie's presence MEAN something again, by having
 * whoever discovers the session is dead throw it away. That is this function,
 * and it fixes the loop for every entry point at once rather than for the one
 * screen somebody remembered to patch.
 *
 * Only for refusals that mean "this session is finished". A 403 for an
 * insufficient role must keep the cookie: that user is perfectly signed in and
 * signing them out for opening the wrong project would be its own bug.
 */
const failAndSignOut = (body: Record<string, unknown>, status: number): GuardFailure => {
  const response = NextResponse.json({ ...body, signedOut: true }, { status });
  clearSessionCookie(response);
  return { response };
};

export function isFailure<T>(v: T | GuardFailure): v is GuardFailure {
  return !!v && typeof v === "object" && "response" in (v as object);
}

/* ------------------------------------------------------------ 1. who */

/**
 * The signed-in user, or a 401.
 *
 * Every call re-reads the session row, because a session can be revoked by an
 * administrator between two requests and the whole point of §9's revoke button
 * is that it takes effect immediately rather than at the next login. Caching
 * this per request is fine; caching it across requests would silently turn
 * "revoke" into "revoke eventually".
 *
 * The heartbeat is NOT sent here. An authorization check is not evidence of a
 * person being present — a background poll would keep a session alive forever
 * and defeat the idle timeout. Liveness is reported by the explicit heartbeat
 * endpoint, which is the client saying "someone is here".
 */
export async function requireUser(req: NextRequest): Promise<AuthedUser | GuardFailure> {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) return fail({ error: "Not signed in.", code: "no_session" }, 401);

  const db = supabaseService();
  const { data: row, error } = await db
    .from("user_sessions")
    .select("id, user_id, status, created_at, last_seen_at, expires_at, device_label, ended_reason")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    /*
     * The database could not be reached. That is NOT evidence the session is
     * invalid, and clearing the cookie here would sign people out over a
     * blip — so this answers 503 and keeps the cookie. Distinguishing
     * "cannot check" from "checked, and it is dead" is the difference
     * between a hiccup and a mass logout.
     */
    console.error("[rescript:auth] session lookup failed", { error: error.message });
    return fail({ error: "Cannot verify your session right now. Please try again.", code: "session_unavailable" }, 503);
  }
  if (!row) return failAndSignOut({ error: "Your session is no longer valid.", code: "unknown_session" }, 401);

  const { data: profile } = await db
    .from("profiles")
    .select("id, email, full_name, user_code, customer_id, role, status")
    .eq("id", row.user_id)
    .maybeSingle();
  if (!profile) return failAndSignOut({ error: "This account no longer exists.", code: "no_account" }, 401);
  if (profile.status !== "active") {
    return failAndSignOut({ error: "This account has been disabled. Contact your administrator.", code: "account_disabled" }, 403);
  }

  const policies = await loadPolicies(profile.customer_id ?? null);
  const record: SessionRecord = {
    sessionId: row.id,
    userId: row.user_id,
    status: row.status as SessionRecord["status"],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    deviceLabel: row.device_label,
  };
  if (!sessionAuthorizes(record, policies.session)) {
    const st = sessionStatus(record, policies.session);
    // the exact status matters to the login screen: "expired" invites a fresh
    // sign-in, "revoked" should say an administrator ended it, and a session
    // displaced by a login elsewhere should say THAT rather than blaming a
    // timeout the user did not experience
    const takenOver = row.ended_reason === "taken_over";
    return failAndSignOut(
      {
        error: takenOver ? "You signed in on another device, so this session was ended."
          : st === "revoked" ? "This session was ended by an administrator."
          : st === "logged_out" ? "You have been signed out."
          : "Your session has expired. Please sign in again.",
        code: takenOver ? "session_taken_over" : `session_${st}`,
      },
      401,
    );
  }

  return {
    sessionId: row.id,
    userId: row.user_id,
    customerId: profile.customer_id ?? null,
    isPlatformAdmin: profile.role === "platform_admin",
    email: profile.email ?? "",
    fullName: profile.full_name ?? profile.email ?? "",
    userCode: profile.user_code ?? "",
    platformRole: profile.role ?? "programmer",
    policies,
  };
}

/** Platform administration (§9). */
export async function requireAdmin(req: NextRequest): Promise<AuthedUser | GuardFailure> {
  const user = await requireUser(req);
  if (isFailure(user)) return user;
  if (!user.isPlatformAdmin) {
    return fail({ error: "This action requires a platform administrator.", code: "not_admin" }, 403);
  }
  return user;
}

/* ------------------------------------------------------------ 2. what */

export interface ProjectContext {
  user: AuthedUser;
  surveyId: string;
  role: ProjectRole | null;
  /** owner / explicit share / workspace baseline — what the UI explains (P0-1) */
  roleSource: RoleSource;
  /** the capability was granted by platform-admin duties, not by membership */
  viaAdmin: boolean;
  survey: { id: string; code: string; title: string; status: string; owner_id: string | null; customer_id: string | null; locked: boolean };
}

/**
 * Project access, for one capability.
 *
 * A project the user has no role on answers 404, not 403: telling an outsider
 * "that project exists but you may not see it" is itself a disclosure, and on
 * a platform where several research agencies share an installation the mere
 * existence of a study can be confidential. A user who IS a member but lacks
 * the capability gets 403 with a message naming their role, because that is
 * actionable — they can ask the owner.
 */
export async function requireProject(
  req: NextRequest,
  surveyId: string,
  capability: Capability,
): Promise<ProjectContext | GuardFailure> {
  const user = await requireUser(req);
  if (isFailure(user)) return user;
  return requireProjectFor(user, surveyId, capability);
}

/** The same check for a caller that already resolved the user. */
export async function requireProjectFor(
  user: AuthedUser,
  surveyId: string,
  capability: Capability,
): Promise<ProjectContext | GuardFailure> {
  if (!surveyId || !/^[0-9a-f-]{36}$/i.test(surveyId)) {
    return fail({ error: "Unknown project." }, 404);
  }
  const db = supabaseService();
  const { data: survey } = await db
    .from("surveys")
    .select("id, code, title, status, owner_id, customer_id, locked")
    .eq("id", surveyId)
    .maybeSingle();
  if (!survey) return fail({ error: "Unknown project." }, 404);

  /*
   * One call answers both "what may they do" and "why do they have it".
   * The provenance is not decoration: a refusal that says "your workspace's
   * default role is reviewer" points at a setting an administrator can
   * change, where "your role is reviewer" sends the user to ask an owner who
   * never granted them anything and cannot find them in the member list.
   */
  const { data: accessRaw } = await db.rpc("rescript_project_access", { p_user: user.userId, p_survey: surveyId });
  const accessRow = (Array.isArray(accessRaw) ? accessRaw[0] : accessRaw) as
    | { project_role: string | null; role_source: string | null }
    | null
    | undefined;
  const role = isProjectRole(accessRow?.project_role) ? accessRow!.project_role as ProjectRole : null;
  const roleSource = (["owner", "member", "workspace", "none"] as const).includes(accessRow?.role_source as never)
    ? (accessRow!.role_source as RoleSource)
    : role ? "member" : "none";
  const decision = decideAccess(user, role, capability, roleSource);

  if (!decision.allowed) {
    if (decision.reason === "not_a_member") {
      // indistinguishable from a project that does not exist, on purpose
      return fail({ error: "Unknown project." }, 404);
    }
    return fail(
      {
        error: roleSource === "workspace"
          ? `Your workspace grants ${ROLE_LABEL[role!].toLowerCase()} access to projects it does not own, which does not allow this. Ask the project's owner to share it with you directly.`
          : `Your role on this project (${ROLE_LABEL[role!] ?? role}) does not allow this.`,
        code: "insufficient_role",
        role,
        roleSource,
        capability,
      },
      403,
    );
  }

  // A frozen project refuses every write, whatever the role — the owner's
  // "lock project" is meant to survive an editor who disagrees with it.
  if (survey.locked && WRITE_CAPABILITIES.has(capability) && role !== "owner") {
    return fail({ error: "This project has been locked by its owner and cannot be changed.", code: "project_locked" }, 423);
  }

  return { user, surveyId, role, roleSource, viaAdmin: decision.viaAdmin, survey: survey as ProjectContext["survey"] };
}

const WRITE_CAPABILITIES = new Set<Capability>([
  "survey.edit", "survey.save_version", "responses.manage", "deploy.manage",
]);

/* ------------------------------------------------------------ 3. may they change it now */

export interface EditRight extends ProjectContext {
  lock: LockRecord;
}

/**
 * The check that guards every project-modifying request (§16).
 *
 * Capability is not enough and neither is the lock: BOTH must hold, and the
 * lock must belong to THIS session rather than merely to this user. That last
 * detail is what stops a second browser of the same person overwriting the
 * first one's unsaved work.
 *
 * A refusal returns 409 with the holder's name, so the client can switch
 * itself into read-only and say who to ask — a bare 403 would leave the user
 * staring at a form that silently stopped working.
 */
export async function requireEditRight(
  req: NextRequest,
  surveyId: string,
  capability: Capability = "survey.edit",
): Promise<EditRight | GuardFailure> {
  const ctx = await requireProject(req, surveyId, capability);
  if (isFailure(ctx)) return ctx;
  return requireEditRightFor(ctx, capability);
}

/**
 * THE ONE PLACE A LOCK IS READ.
 *
 * Every route that cares about the lock — the gate, the lock endpoint, the
 * collaboration poll, the diagnostics view — goes through here, because the
 * lock's liveness now depends on a fact none of them could see for
 * themselves: whether the session holding it is still active (P0-8). Three
 * hand-rolled reads would have meant three chances for one of them to keep
 * judging a lock by its heartbeat alone, and the one that forgot would be the
 * one blocking somebody's afternoon.
 *
 * `rescript_lock_for` also folds in the holder's name, which the previous
 * version fetched with a second query on every single poll.
 */
export async function loadLock(surveyId: string): Promise<LockRecord | null> {
  const db = supabaseService();
  const { data } = await db.rpc("rescript_lock_for", { p_survey: surveyId });
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        survey_id: string; locked_by_user_id: string; locked_by_session_id: string;
        status: string; section: string | null; created_at: string;
        last_heartbeat_at: string; expires_at: string | null;
        locked_by_name: string | null; locked_by_code: string | null;
        holder_session_live: boolean;
      }
    | null
    | undefined;
  if (!row) return null;
  return {
    surveyId: row.survey_id,
    lockedByUserId: row.locked_by_user_id,
    lockedBySessionId: row.locked_by_session_id,
    status: row.status as LockRecord["status"],
    section: row.section,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at,
    holderSessionLive: row.holder_session_live,
    lockedByName: row.locked_by_name,
    lockedByUserCode: row.locked_by_code,
  };
}

export async function requireEditRightFor(
  ctx: ProjectContext,
  capability: Capability = "survey.edit",
): Promise<EditRight | GuardFailure> {
  const lock = await loadLock(ctx.surveyId);

  const verdict = decideEdit({
    canEdit: can(ctx.role, capability),
    lock,
    sessionId: ctx.user.sessionId,
    userId: ctx.user.userId,
    policy: ctx.user.policies.lock,
  });

  if (!verdict.allowed) {
    // the lock was refused, and that is worth recording: it is the evidence
    // that the exclusivity actually held when two people tried at once
    if (verdict.reason === "locked_by_other") {
      void audit({
        action: "lock.denied", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
        surveyId: ctx.surveyId, customerId: ctx.user.customerId,
        detail: { targetName: verdict.heldBy.lockedByName, targetUserCode: verdict.heldBy.lockedByUserCode },
      });
    }
    /*
     * `keepChanges` is a contract with the client, not a hint (§24). Every
     * refusal from this gate is recoverable — the project still exists, the
     * user is still signed in, and the draft in their editor is still the
     * newest version of their work. The client must not reset, reload,
     * redirect or overwrite on any of them.
     *
     * `recoverable` says whether taking the lock back is even possible from
     * here: a viewer who lacks the capability cannot, and telling them to
     * "try again" would be a loop with no exit.
     */
    return fail(
      {
        error: verdict.message,
        code: verdict.reason,
        keepChanges: true,
        recoverable: verdict.reason !== "no_capability",
        lockStatus: lockStatus(lock, ctx.user.policies.lock),
        lock: lock
          ? {
              userId: lock.lockedByUserId, name: lock.lockedByName, userCode: lock.lockedByUserCode,
              since: lock.createdAt, lastActive: lock.lastHeartbeatAt,
              sessionLive: lock.holderSessionLive ?? true,
            }
          : null,
      },
      verdict.reason === "no_capability" ? 403 : 409,
    );
  }

  return { ...ctx, lock: lock! };
}

/* ------------------------------------------------------------ audit */

/**
 * Write one audit row (§25). Never throws: a failure to record must not fail
 * the action it describes, and a swallowed audit write is logged so the gap is
 * visible rather than silent.
 */
export async function audit(args: {
  action: AuditEvent;
  userId: string | null;
  sessionId?: string | null;
  surveyId?: string | null;
  customerId?: string | null;
  entity?: string;
  entityId?: string | null;
  ipHash?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = supabaseService();
    await db.from("audit_logs").insert({
      customer_id: args.customerId ?? null,
      user_id: args.userId,
      session_id: args.sessionId ?? null,
      survey_id: args.surveyId ?? null,
      action: args.action,
      entity: args.entity ?? (args.surveyId ? "survey" : "user"),
      entity_id: args.entityId ?? args.surveyId ?? args.userId,
      ip_hash: args.ipHash ?? null,
      detail: args.detail ?? {},
    });
  } catch (e) {
    console.error("[rescript:audit] not recorded", { action: args.action, error: (e as Error).message });
  }
}

/**
 * Tell the people who would want to know (§39).
 *
 * In-app rows rather than email, which is the extension point named in the
 * requirement. Recipients are resolved from membership, so a notification can
 * never reach someone who has lost access to the project it is about.
 */
export async function notifyProject(args: {
  surveyId: string;
  action: AuditEvent;
  exceptUserId?: string | null;
  onlyUserIds?: string[];
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = supabaseService();
    let recipients: string[];
    if (args.onlyUserIds) {
      recipients = args.onlyUserIds;
    } else {
      const { data } = await db.rpc("rescript_project_members", { p_survey: args.surveyId, p_present_within_seconds: 60 });
      recipients = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
    }
    const rows = recipients
      .filter((id) => id && id !== args.exceptUserId)
      .map((user_id) => ({ user_id, survey_id: args.surveyId, action: args.action, detail: args.detail ?? {} }));
    if (rows.length) await db.from("notifications").insert(rows);
  } catch (e) {
    console.error("[rescript:notify] not sent", { action: args.action, error: (e as Error).message });
  }
}

/* ------------------------------------------------------------ shape helpers */

/** What the client is told about itself — never a secret, never a token. */
export function publicUser(user: AuthedUser) {
  return {
    userId: user.userId,
    userCode: user.userCode,
    name: user.fullName,
    email: user.email,
    platformRole: user.platformRole,
    isPlatformAdmin: user.isPlatformAdmin,
    sessionId: user.sessionId,
    policies: {
      heartbeatSeconds: user.policies.session.heartbeatSeconds,
      lockHeartbeatSeconds: user.policies.lock.heartbeatSeconds,
      presenceHeartbeatSeconds: user.policies.presence.heartbeatSeconds,
      idleAfterSeconds: user.policies.session.idleAfterSeconds,
      staleAfterSeconds: user.policies.session.staleAfterSeconds,
      lockStaleAfterSeconds: user.policies.lock.staleAfterSeconds,
    },
  };
}
