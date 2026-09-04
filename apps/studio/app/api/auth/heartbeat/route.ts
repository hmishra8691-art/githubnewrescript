import { NextRequest, NextResponse } from "next/server";
import { sessionStatus, type SessionRecord } from "@rescript/access";
import { loadPolicies, sessionIdFrom, supabaseService } from "@/lib/authServer";

export const dynamic = "force-dynamic";

/**
 * SESSION LIVENESS (§6).
 *
 * The client says "someone is still here"; the server decides what that means.
 *
 * This is a separate endpoint rather than a side effect of ordinary requests
 * on purpose. If every authorization check refreshed the session, a background
 * poll would keep an abandoned browser "active" forever and the idle timeout
 * would never fire — the thing that makes a crashed machine release the
 * account would be defeated by the very mechanism meant to detect it.
 *
 * The response reports the status the server now believes, so a client whose
 * session was revoked or expired finds out within one interval and can show
 * the login screen instead of failing the next real action.
 */
export async function POST(req: NextRequest) {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) return NextResponse.json({ status: "none" }, { status: 401 });

  const db = supabaseService();
  const { data: row } = await db
    .from("user_sessions")
    .select("id, user_id, status, created_at, last_seen_at, expires_at")
    .eq("id", sessionId).maybeSingle();
  if (!row) return NextResponse.json({ status: "unknown" }, { status: 401 });

  const { data: profile } = await db.from("profiles").select("customer_id").eq("id", row.user_id).maybeSingle();
  const policies = await loadPolicies(profile?.customer_id ?? null);

  const { data: touched } = await db.rpc("rescript_touch_session", {
    p_session: sessionId,
    p_stale_seconds: policies.session.staleAfterSeconds,
    p_absolute_seconds: policies.session.absoluteLifetimeSeconds,
  });
  const t = (Array.isArray(touched) ? touched[0] : touched) as { status: string; last_seen_at: string | null } | null;

  // `rescript_touch_session` answers "unknown" for a session id it cannot
  // find, which is not one of the stored statuses — treat it as expired, which
  // is what it means to the caller
  const stored = String(t?.status ?? row.status);
  const record: SessionRecord = {
    sessionId, userId: row.user_id,
    status: (stored === "unknown" ? "expired" : stored) as SessionRecord["status"],
    createdAt: row.created_at,
    lastSeenAt: t?.last_seen_at ?? row.last_seen_at,
    expiresAt: row.expires_at,
  };
  const status = sessionStatus(record, policies.session);
  const alive = status === "active" || status === "idle";

  return NextResponse.json(
    { status, alive, heartbeatSeconds: policies.session.heartbeatSeconds },
    { status: alive ? 200 : 401, headers: { "cache-control": "no-store" } },
  );
}
