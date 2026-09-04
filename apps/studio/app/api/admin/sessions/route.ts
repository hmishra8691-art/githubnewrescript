import { NextRequest, NextResponse } from "next/server";
import { sessionStatus, sessionStatusHint, type SessionRecord } from "@rescript/access";
import { loadPolicies, supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * ADMIN — ACTIVE SESSIONS (§9).
 *
 * The operational screen: who is signed in, since when, last seen, and a
 * button to end it. It exists because the single-session rule creates a
 * support case — "I'm locked out, my laptop died" — and an administrator
 * should be able to resolve that in a click rather than telling someone to
 * wait fifteen minutes.
 *
 * Every revocation is audited with who did it, because ending someone's
 * session interrupts their work and that should never be anonymous.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;

  const db = supabaseService();
  const { data, error } = await db.rpc("rescript_active_sessions", {
    p_stale_seconds: admin.policies.session.staleAfterSeconds,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sessions = ((data ?? []) as {
    session_id: string; user_id: string; user_code: string; full_name: string; email: string;
    organization: string; account_status: string; platform_role: string;
    created_at: string; last_seen_at: string; device_label: string; status: string;
  }[]).map((s) => {
    const record: SessionRecord = {
      sessionId: s.session_id, userId: s.user_id, status: "active",
      createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: null, deviceLabel: s.device_label,
    };
    const status = sessionStatus(record, admin.policies.session);
    return {
      sessionId: s.session_id,
      user: { userId: s.user_id, userCode: s.user_code, name: s.full_name, email: s.email, organization: s.organization },
      accountStatus: s.account_status,
      platformRole: s.platform_role,
      loginTime: s.created_at,
      lastActivity: s.last_seen_at,
      status,
      hint: sessionStatusHint(status, admin.policies.session),
      device: s.device_label,
      isMine: s.session_id === admin.sessionId,
    };
  });

  return NextResponse.json({
    sessions,
    // an "active" row that has gone quiet past the stale threshold is
    // reported honestly, and is exactly the one an admin is looking for
    stale: sessions.filter((s) => s.status === "expired").length,
    policy: admin.policies.session,
  }, { headers: { "cache-control": "no-store" } });
}

/** Revoke a session / force a logout (§9). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const sessionId = String(body?.sessionId ?? "");
  const userId = String(body?.userId ?? "");
  if (!sessionId && !userId) return NextResponse.json({ error: "Name a session or a user." }, { status: 400 });

  const db = supabaseService();
  let targets: { id: string; user_id: string }[] = [];
  if (sessionId) {
    const { data } = await db.from("user_sessions").select("id, user_id").eq("id", sessionId).eq("status", "active");
    targets = data ?? [];
  } else {
    // "force logout this person", whatever session they are on
    const { data } = await db.from("user_sessions").select("id, user_id").eq("user_id", userId).eq("status", "active");
    targets = data ?? [];
  }
  if (!targets.length) return NextResponse.json({ ok: true, revoked: 0, note: "No active session to end." });

  const { data: person } = await db.from("profiles")
    .select("full_name, user_code, customer_id").eq("id", targets[0].user_id).maybeSingle();

  for (const t of targets) {
    await db.rpc("rescript_end_session", { p_session: t.id, p_reason: "revoked", p_by: admin.userId });
  }
  await audit({
    action: "session.revoked", userId: admin.userId, sessionId: admin.sessionId,
    customerId: person?.customer_id ?? admin.customerId,
    detail: {
      targetName: person?.full_name, targetUserCode: person?.user_code,
      sessions: targets.length, reason: String(body?.reason ?? "").slice(0, 200) || null,
    },
  });

  return NextResponse.json({
    ok: true, revoked: targets.length,
    message: `${person?.full_name ?? "That user"} has been signed out and can sign in again.`,
  });
}
