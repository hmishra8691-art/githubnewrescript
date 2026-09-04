import { NextRequest, NextResponse } from "next/server";
import {
  activePresence, activityFor, avatarHue, can, capabilitiesOf, initialsOf,
  lockBanner, lockStatus, roleSummary,
  type LockRecord, type PresenceEntry,
} from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject, type ProjectContext } from "@/lib/guard";

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
      await db.rpc("rescript_heartbeat_lock", {
        p_survey: surveyId, p_session: user.sessionId,
        p_max_hold_seconds: user.policies.lock.maxHoldSeconds, p_section: section,
      });
    }
    // opportunistic cleanup: whoever looks at the project tidies up the locks
    // the clock has ended, so a stale lock needs no scheduler to disappear
    await db.rpc("rescript_expire_locks", { p_stale_seconds: user.policies.lock.staleAfterSeconds });
  }

  const [lockRes, presenceRes, commentRes] = await Promise.all([
    db.from("project_edit_locks")
      .select("survey_id, locked_by_user_id, locked_by_session_id, status, section, created_at, last_heartbeat_at, expires_at")
      .eq("survey_id", surveyId).maybeSingle(),
    db.rpc("rescript_project_presence", {
      p_survey: surveyId, p_within_seconds: user.policies.presence.presentWithinSeconds,
    }),
    db.from("project_comments")
      .select("id", { count: "exact", head: true })
      .eq("survey_id", surveyId).is("resolved_at", null).is("deleted_at", null),
  ]);

  let lock: LockRecord | null = null;
  if (lockRes.data) {
    const holder = (presenceRes.data as { user_id: string; full_name: string; user_code: string }[] | null)
      ?.find((p) => p.user_id === lockRes.data!.locked_by_user_id);
    let name = holder?.full_name ?? null;
    let code = holder?.user_code ?? null;
    if (!name) {
      // the holder may not be "present" — they can hold a lock while their
      // browser is quiet, and the banner still has to name them
      const { data: who } = await db.from("profiles").select("full_name, user_code").eq("id", lockRes.data.locked_by_user_id).maybeSingle();
      name = who?.full_name ?? null;
      code = who?.user_code ?? null;
    }
    lock = {
      surveyId: lockRes.data.survey_id,
      lockedByUserId: lockRes.data.locked_by_user_id,
      lockedBySessionId: lockRes.data.locked_by_session_id,
      status: lockRes.data.status as LockRecord["status"],
      section: lockRes.data.section,
      createdAt: lockRes.data.created_at,
      lastHeartbeatAt: lockRes.data.last_heartbeat_at,
      expiresAt: lockRes.data.expires_at,
      lockedByName: name,
      lockedByUserCode: code,
    };
  }

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
      heldBy: lock && (status === "held" || status === "stale")
        ? {
            userId: lock.lockedByUserId, name: lock.lockedByName, userCode: lock.lockedByUserCode,
            since: lock.createdAt, lastActive: lock.lastHeartbeatAt, section: lock.section ?? null,
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
