import { NextRequest, NextResponse } from "next/server";
import { sessionStatus, sessionStatusHint, type SessionRecord } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * MY SESSIONS (§8) — the Security screen.
 *
 * Shows the account's own session history with the current one marked, so a
 * user can see that they are signed in, where from, and since when. The
 * status shown is computed from the timestamps by the shared state machine,
 * not read from the stored column, so an "active" row that has not checked in
 * for twenty minutes is honestly reported as expired.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const db = supabaseService();
  const { data } = await db
    .from("user_sessions")
    .select("id, status, created_at, last_seen_at, expires_at, ended_at, ended_reason, device_label, user_agent")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false })
    .limit(25);

  const sessions = (data ?? []).map((row) => {
    const record: SessionRecord = {
      sessionId: row.id, userId: user.userId,
      status: row.status as SessionRecord["status"],
      createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at,
      deviceLabel: row.device_label,
    };
    const status = sessionStatus(record, user.policies.session);
    return {
      sessionId: row.id,
      current: row.id === user.sessionId,
      status,
      hint: sessionStatusHint(status, user.policies.session),
      device: row.device_label,
      loginAt: row.created_at,
      lastActivity: row.last_seen_at,
      endedAt: row.ended_at,
      endedReason: row.ended_reason,
      revocable: status === "active" || status === "idle",
    };
  });

  return NextResponse.json({
    userId: user.userId,
    userCode: user.userCode,
    currentSessionId: user.sessionId,
    policy: {
      idleAfterSeconds: user.policies.session.idleAfterSeconds,
      staleAfterSeconds: user.policies.session.staleAfterSeconds,
      absoluteLifetimeSeconds: user.policies.session.absoluteLifetimeSeconds,
      singleSession: !user.policies.session.allowForceTakeover,
    },
    sessions,
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Revoke one of my own sessions (§8).
 *
 * Useful for exactly the case §4 creates: you are at a different machine, the
 * account says it is logged in elsewhere, and you want to release it without
 * waiting out the idle timer. You can only ever revoke your OWN sessions here
 * — an administrator's reach is a separate, audited endpoint.
 */
export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const target = String(body?.sessionId ?? "");
  if (!target) return NextResponse.json({ error: "Which session?" }, { status: 400 });

  const db = supabaseService();
  const { data: row } = await db.from("user_sessions").select("id, user_id").eq("id", target).maybeSingle();
  if (!row || row.user_id !== user.userId) {
    return NextResponse.json({ error: "Unknown session." }, { status: 404 });
  }

  await db.rpc("rescript_end_session", { p_session: target, p_reason: "revoked", p_by: user.userId });
  await audit({
    action: "session.revoked", userId: user.userId, sessionId: user.sessionId,
    customerId: user.customerId, detail: { targetName: user.fullName, self: true, revokedSession: target },
  });
  return NextResponse.json({ ok: true, endedCurrent: target === user.sessionId });
}
