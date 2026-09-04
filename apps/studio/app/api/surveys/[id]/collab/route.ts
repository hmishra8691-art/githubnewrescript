import { NextRequest, NextResponse } from "next/server";
import {
  activePresence, activityFor, avatarHue, can, capabilitiesOf, initialsOf,
  lockBanner, lockStatus, roleSourceNote, roleSummary,
  type PresenceEntry,
} from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, loadLock, requireProject, type ProjectContext } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE COLLABORATION POLL (§31, §38) — one call, every live fact.
 *
 * The client asks this every few seconds and gets back everything that can
 * change underneath it: who is present, who is editing, whether its own lock
 * survived, what it is allowed to do, and whether anyone left it a note. It
 * also REPORTS the caller's presence and refreshes their lock heartbeat, so
 * the same round trip that reads the shared state also maintains this
 * client's part of it.
 *
 * Why one endpoint instead of five: presence, lock and permissions are read
 * together on every tick, and five polls would be five times the requests,
 * five chances to show a half-updated screen, and five places for the
 * intervals to drift out of step. It is also the seam where Supabase Realtime
 * would replace the transport later — the shape of what the client needs
 * would not change, only how often it arrives.
 *
 * "Editing" is derived from the lock, never from what a client claims to be
 * doing, so a manipulated browser cannot make itself appear as a second
 * editor on everyone else's screen.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  return handle(req, gate, false);
}

/** POST is the same read, plus "I am here" and "my lock is alive". */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  return handle(req, gate, true);
}

/*
 * Both verbs authorize in the handler rather than in here. Hiding the guard in
 * a shared helper works, but it means you have to read a second function to
 * know a route is authorized — and that is how a guard eventually gets
 * dropped without anyone noticing.
 */
async function handle(req: NextRequest, ctx: ProjectContext, report: boolean) {
  const surveyId = ctx.surveyId;
  const { user, role } = ctx;
  const db = supabaseService();

  const url = new URL(req.url);
  const section = url.searchParams.get("section")?.slice(0, 80) ?? null;
  const editing = url.searchParams.get("editing") === "1";

  /*
   * Report first, read second, so the caller sees themselves in the presence
   * list they get back. A read-then-report order would show every user a list
   * that never contains them until the next tick, which reads as a bug.
   */
  if (report) {
    await db.rpc("rescript_touch_presence", {
      p_survey: surveyId, p_session: user.sessionId, p_user: user.userId,
      p_activity: editing ? "editing" : role === "reviewer" ? "reviewing" : role === "test_user" ? "testing" : "viewing",
    });
    if (editing) {
      // one heartbeat, not two round trips: if the client believes it is
      // editing, this is also the lock's liveness signal (§17)
      const { data: alive } = await db.rpc("rescript_heartbeat_lock", {
        p_survey: surveyId, p_session: user.sessionId,
        p_max_hold_seconds: user.policies.lock.maxHoldSeconds, p_section: section,
      });

      /*
       * KEEPING THE EDITOR EDITING, WITHOUT A BUTTON.
       *
       * The heartbeat says this session does not hold the lock. Before, that
       * left the user in read-only until they noticed a banner and clicked
       * "Enter edit mode" — which is the reported "the project went read-only
       * on its own" and, worse, "my changes stopped saving": someone typing
       * into a project whose lock they had silently lost.
       *
       * So the same round trip that discovers the lock is missing tries to
       * take it. Three things make that safe rather than a land-grab:
       *
       *   · it only runs for a client that says it is EDITING. A reviewer
       *     reading the project polls with editing=0 and never takes a lock
       *     away from anyone;
       *   · `requireProject` has already established this user may edit, and
       *     `rescript_acquire_lock` re-checks the whole takeable predicate
       *     inside the row lock, so a live editor is never displaced;
       *   · a refusal is not an error. The lock read below sees whoever won
       *     and the client goes read-only naming them, in this same response.
       */
      if (!alive && can(role, "survey.edit")) {
        await db.rpc("rescript_acquire_lock", {
          p_survey: surveyId,
          p_user: user.userId,
          p_session: user.sessionId,
          p_stale_seconds: user.policies.lock.staleAfterSeconds,
          p_max_hold_seconds: user.policies.lock.maxHoldSeconds,
          p_section: section,
        });
      }
    }
    // opportunistic cleanup: whoever looks at the project tidies up the locks
    // the clock — or a sign-out — has ended, so a lock nobody is behind needs
    // no scheduler to disappear
    await db.rpc("rescript_expire_locks", { p_stale_seconds: user.policies.lock.staleAfterSeconds });
  }

  /*
   * The lock comes from the gate's shared loader, which resolves the holder's
   * name and — the part that matters for P0-8 — whether the holder's session
   * is still live. This route used to read the row itself and fall back to a
   * profiles lookup when the holder was not in the presence list; that was one
   * of three private copies of "read the lock", and the copies are exactly how
   * a liveness rule ends up applied in two places out of three.
   */
  const [lock, presenceRes, commentRes] = await Promise.all([
    loadLock(surveyId),
    db.rpc("rescript_project_presence", {
      p_survey: surveyId, p_within_seconds: user.policies.presence.presentWithinSeconds,
    }),
    db.from("project_comments")
      .select("id", { count: "exact", head: true })
      .eq("survey_id", surveyId).is("resolved_at", null).is("deleted_at", null),
  ]);

  const rawPresence = ((presenceRes.data ?? []) as {
    user_id: string; session_id: string; user_code: string; full_name: string;
    email: string; role: string; activity: string; last_seen_at: string; first_seen_at: string;
  }[]).map<PresenceEntry>((p) => ({
    userId: p.user_id,
    sessionId: p.session_id,
    userCode: p.user_code,
    name: p.full_name,
    email: p.email,
    role: p.role,
    // derived from the lock, not from p.activity — see the header
    activity: activityFor(p.role, p.session_id, lock, user.policies.lock),
    lastSeenAt: p.last_seen_at,
  }));

  const present = activePresence(rawPresence, user.policies.presence);
  const status = lockStatus(lock, user.policies.lock);
  const iHoldLock = !!lock && lock.lockedBySessionId === user.sessionId && status === "held";

  return NextResponse.json({
    project: { id: ctx.survey.id, code: ctx.survey.code, title: ctx.survey.title, status: ctx.survey.status, locked: ctx.survey.locked },
    me: {
      userId: user.userId, userCode: user.userCode, name: user.fullName,
      sessionId: user.sessionId, role, roleSummary: roleSummary(role),
      /*
       * Where the role came from, so the read-only notice can say something
       * the user can act on. "You have viewer access because your workspace
       * grants it" points at an administrator; "your role on this project is
       * viewer" sends them to an owner who never granted them anything and
       * cannot find them in the member list (P0-1).
       */
      roleSource: ctx.roleSource,
      roleSourceNote: roleSourceNote(ctx.roleSource),
      viaAdmin: ctx.viaAdmin,
      capabilities: capabilitiesOf(role),
      canEdit: can(role, "survey.edit"),
      canShare: can(role, "project.share"),
      canManageMembers: can(role, "project.manage_members"),
      canForceRelease: can(role, "lock.force_release") || user.isPlatformAdmin,
      canComment: can(role, "comment.create"),
      /**
       * THE flag the whole UI hangs off. Read-only is the default: a user is
       * editable only while they demonstrably hold the lock, so a client that
       * loses it mid-session falls back to read-only on the next tick rather
       * than staying editable until it tries to save.
       */
      readOnly: !iHoldLock,
    },
    lock: {
      status,
      mine: iHoldLock,
      banner: lockBanner(lock, user.sessionId, user.policies.lock),
      heldBy: lock && (status === "held" || status === "stale" || status === "orphaned")
        ? {
            userId: lock.lockedByUserId, name: lock.lockedByName, userCode: lock.lockedByUserCode,
            since: lock.createdAt, lastActive: lock.lastHeartbeatAt, section: lock.section ?? null,
            sessionLive: lock.holderSessionLive ?? true,
          }
        : null,
    },
    presence: present.map((p) => ({
      userId: p.userId, userCode: p.userCode, name: p.name, role: p.role,
      activity: p.activity, lastSeenAt: p.lastSeenAt,
      initials: initialsOf(p.name, p.userCode.slice(-2)),
      hue: avatarHue(p.userId),
      isMe: p.sessionId === user.sessionId,
    })),
    openComments: commentRes.count ?? 0,
    /** the cadence the client must poll at — server-decided, so §7 stays configurable */
    poll: {
      presenceSeconds: user.policies.presence.heartbeatSeconds,
      lockSeconds: user.policies.lock.heartbeatSeconds,
      sessionSeconds: user.policies.session.heartbeatSeconds,
    },
  }, { headers: { "cache-control": "no-store" } });
}
