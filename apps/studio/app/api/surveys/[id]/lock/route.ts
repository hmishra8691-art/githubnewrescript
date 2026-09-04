import { NextRequest, NextResponse } from "next/server";
import { can, lockBanner, lockStatus, type LockRecord } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE EDIT LOCK — acquire, refresh, release, take over.
 *
 * All four are POSTs to one route with an `action`, because they are one state
 * machine and splitting them across four files would let their authorization
 * drift apart. Every one of them ends by returning the CURRENT lock state, so
 * a client that lost a race learns the truth from the same response that
 * refused it rather than having to ask again.
 *
 *   acquire        enter edit mode (§14) — atomic, one winner
 *   heartbeat      stay in it (§17)
 *   release        leave it (§29)
 *   force_release  take it from someone (§30) — owner or admin only, audited
 *   request        ask the holder for it (§30) — a notification, not a seizure
 *
 * The lock is never granted by this route's own logic: `rescript_acquire_lock`
 * decides inside a row lock. This route decides only WHO MAY ASK.
 */

async function readLock(surveyId: string): Promise<LockRecord | null> {
  const db = supabaseService();
  const { data } = await db
    .from("project_edit_locks")
    .select("survey_id, locked_by_user_id, locked_by_session_id, status, section, created_at, last_heartbeat_at, expires_at")
    .eq("survey_id", surveyId).maybeSingle();
  if (!data) return null;
  const { data: who } = await db.from("profiles").select("full_name, user_code").eq("id", data.locked_by_user_id).maybeSingle();
  return {
    surveyId: data.survey_id,
    lockedByUserId: data.locked_by_user_id,
    lockedBySessionId: data.locked_by_session_id,
    status: data.status as LockRecord["status"],
    section: data.section,
    createdAt: data.created_at,
    lastHeartbeatAt: data.last_heartbeat_at,
    expiresAt: data.expires_at,
    lockedByName: who?.full_name ?? null,
    lockedByUserCode: who?.user_code ?? null,
  };
}

/** The lock as the client needs to see it: state, holder, and my own standing. */
function shape(lock: LockRecord | null, sessionId: string, policy: Parameters<typeof lockStatus>[1]) {
  const status = lockStatus(lock, policy);
  return {
    status,
    mine: !!lock && lock.lockedBySessionId === sessionId && status === "held",
    banner: lockBanner(lock, sessionId, policy),
    heldBy: lock && (status === "held" || status === "stale")
      ? {
          userId: lock.lockedByUserId,
          name: lock.lockedByName,
          userCode: lock.lockedByUserCode,
          since: lock.createdAt,
          lastActive: lock.lastHeartbeatAt,
          section: lock.section ?? null,
        }
      : null,
    heartbeatSeconds: policy.heartbeatSeconds,
    staleAfterSeconds: policy.staleAfterSeconds,
  };
}

/** Read the lock without touching it — what a read-only viewer polls. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;
  const lock = await readLock(params.id);
  return NextResponse.json(
    { ...shape(lock, ctx.user.sessionId, ctx.user.policies.lock), canEdit: can(ctx.role, "survey.edit") },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  /*
   * Identity first, before the body is even parsed. Which capability this
   * request needs depends on its `action`, so the body has to be read to
   * decide — but reading it first would mean an unauthenticated request had
   * already been processed. `requireUser` needs nothing from the body, so it
   * establishes who is asking, and the project check follows once the action
   * is known.
   */
  const who = await requireUser(req);
  if (isFailure(who)) return who.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* an action-less POST is a heartbeat */ }
  const action = String(body?.action ?? "heartbeat");
  const section = body?.section ? String(body.section).slice(0, 80) : null;

  const needed = action === "force_release" ? "lock.force_release"
    : action === "request" ? "lock.request"
    : "lock.acquire";
  const ctx = await requireProjectFor(who, params.id, needed as never);
  if (isFailure(ctx)) return ctx.response;

  const db = supabaseService();
  const { user, role } = ctx;
  const policy = user.policies.lock;

  /* ------------------------------------------------------------ acquire */
  if (action === "acquire") {
    const { data, error } = await db.rpc("rescript_acquire_lock", {
      p_survey: params.id,
      p_user: user.userId,
      p_session: user.sessionId,
      p_stale_seconds: policy.staleAfterSeconds,
      p_max_hold_seconds: policy.maxHoldSeconds,
      p_section: section,
    });
    if (error) {
      console.error("[rescript:lock] acquire failed", { surveyId: params.id, error: error.message });
      return NextResponse.json({ error: "Edit mode could not be started. Please try again." }, { status: 503 });
    }
    const r = (Array.isArray(data) ? data[0] : data) as {
      acquired: boolean; locked_by_user_id: string | null; locked_by_name: string | null;
      locked_by_code: string | null; created_at: string | null; last_heartbeat_at: string | null;
      was_stale: boolean;
    };
    const lock = await readLock(params.id);

    if (!r?.acquired) {
      // refused: the response carries who holds it so the client can go
      // read-only and name them, in the same round trip
      return NextResponse.json(
        {
          acquired: false,
          error: `This project is currently being edited by ${r?.locked_by_name ?? "another user"}. You can view the project, but editing is temporarily unavailable.`,
          ...shape(lock, user.sessionId, policy),
        },
        { status: 409 },
      );
    }

    await audit({
      action: "lock.acquired", userId: user.userId, sessionId: user.sessionId,
      surveyId: params.id, customerId: user.customerId,
      detail: { section, tookOverStaleLock: !!r.was_stale },
    });
    // whoever was waiting for this project wants to know it is now taken
    if (r.was_stale) {
      await notifyProject({
        surveyId: params.id, action: "lock.acquired", exceptUserId: user.userId,
        detail: { actorName: user.fullName, tookOverStaleLock: true },
      });
    }
    return NextResponse.json({ acquired: true, ...shape(lock, user.sessionId, policy) });
  }

  /* ------------------------------------------------------------ heartbeat */
  if (action === "heartbeat") {
    const { data: alive } = await db.rpc("rescript_heartbeat_lock", {
      p_survey: params.id, p_session: user.sessionId,
      p_max_hold_seconds: policy.maxHoldSeconds, p_section: section,
    });
    const lock = await readLock(params.id);
    if (!alive) {
      /*
       * The editor's own lock is gone — it went stale while they were away
       * from the keyboard, or an owner took it. Answering 409 rather than 200
       * is what lets the client drop out of edit mode by itself instead of
       * letting the user keep typing into a form whose next save will be
       * refused.
       */
      return NextResponse.json(
        { alive: false, error: "Your edit lock has been released.", ...shape(lock, user.sessionId, policy) },
        { status: 409 },
      );
    }
    return NextResponse.json({ alive: true, ...shape(lock, user.sessionId, policy) });
  }

  /* ------------------------------------------------------------ release */
  if (action === "release") {
    const { data: released } = await db.rpc("rescript_release_lock", {
      p_survey: params.id, p_session: user.sessionId, p_reason: String(body?.reason ?? "released"),
    });
    if (released) {
      await audit({
        action: "lock.released", userId: user.userId, sessionId: user.sessionId,
        surveyId: params.id, customerId: user.customerId, detail: {},
      });
      // §39: the people who were waiting are exactly the people to tell
      await notifyProject({
        surveyId: params.id, action: "lock.released", exceptUserId: user.userId,
        detail: { actorName: user.fullName },
      });
    }
    const lock = await readLock(params.id);
    return NextResponse.json({ released: !!released, ...shape(lock, user.sessionId, policy) });
  }

  /* ------------------------------------------------------------ force release */
  if (action === "force_release") {
    if (!policy.allowForceRelease && role !== "owner" && !user.isPlatformAdmin) {
      return NextResponse.json(
        { error: "Taking over an active edit lock is switched off for this workspace." },
        { status: 403 },
      );
    }
    const { data, error } = await db.rpc("rescript_force_release_lock", {
      p_survey: params.id, p_by: user.userId, p_reason: String(body?.reason ?? "force_released"),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const r = (Array.isArray(data) ? data[0] : data) as {
      released: boolean; was_held_by: string | null; was_held_by_name: string | null; was_held_by_session: string | null;
    };
    if (r?.released) {
      // §30 is explicit that this must be recorded — it is somebody's work
      // being interrupted, and the log is how that conversation gets had
      await audit({
        action: "lock.force_released", userId: user.userId, sessionId: user.sessionId,
        surveyId: params.id, customerId: user.customerId,
        detail: { targetName: r.was_held_by_name, targetUserId: r.was_held_by, reason: body?.reason ?? null, viaAdmin: ctx.viaAdmin },
      });
      if (r.was_held_by) {
        await notifyProject({
          surveyId: params.id, action: "lock.force_released", onlyUserIds: [r.was_held_by],
          detail: { actorName: user.fullName },
        });
      }
    }
    const lock = await readLock(params.id);
    return NextResponse.json({
      released: !!r?.released,
      wasHeldBy: r?.was_held_by_name ?? null,
      ...shape(lock, user.sessionId, policy),
    });
  }

  /* ------------------------------------------------------------ request */
  if (action === "request") {
    const lock = await readLock(params.id);
    const status = lockStatus(lock, policy);
    if (!lock || status !== "held") {
      return NextResponse.json({ requested: false, note: "The project is already available for editing.", ...shape(lock, user.sessionId, policy) });
    }
    await audit({
      action: "lock.requested", userId: user.userId, sessionId: user.sessionId,
      surveyId: params.id, customerId: user.customerId,
      detail: { targetName: lock.lockedByName, message: String(body?.message ?? "").slice(0, 500) || null },
    });
    await notifyProject({
      surveyId: params.id, action: "lock.requested", onlyUserIds: [lock.lockedByUserId],
      detail: { actorName: user.fullName, actorUserCode: user.userCode, message: String(body?.message ?? "").slice(0, 500) || null },
    });
    return NextResponse.json({ requested: true, askedName: lock.lockedByName, ...shape(lock, user.sessionId, policy) });
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
}
