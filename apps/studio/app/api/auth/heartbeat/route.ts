import { NextRequest, NextResponse } from "next/server";
import { sessionStatus, type SessionRecord } from "@rescript/access";
import { clearSessionCookie, loadPolicies, sessionIdFrom, supabaseService } from "@/lib/authServer";

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
/**
 * A 401 from here also THROWS THE COOKIE AWAY (P0-3).
 *
 * The heartbeat is usually the first thing to notice a session has ended, so
 * it is usually the first thing that can stop the stale cookie from
 * convincing the rest of the app that somebody is signed in. Leaving the
 * cookie in place was what let an expired session bounce between `/` and
 * `/login` forever.
 */
function ended(status: string) {
  const res = NextResponse.json({ status, alive: false, signedOut: true }, { status: 401 });
  clearSessionCookie(res);
  return res;
}

export async function POST(req: NextRequest) {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) return NextResponse.json({ status: "none", alive: false }, { status: 401 });

  const db = supabaseService();
  const { data: row, error } = await db
    .from("user_sessions")
    .select("id, user_id, status, created_at, last_seen_at, expires_at, ended_reason")
    .eq("id", sessionId).maybeSingle();
  if (error) {
    /*
     * Could not reach the database. Emphatically NOT a sign-out: answering
     * 401 here would turn a momentary blip into every open tab throwing its
     * user back to the login screen at once.
     */
    console.error("[rescript:auth] heartbeat lookup failed", { error: error.message });
    return NextResponse.json({ status: "unavailable", alive: true }, { status: 503 });
  }
  if (!row) return ended("unknown");

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

  if (!alive) {
    /*
     * "Taken over" is reported as itself rather than as an expiry. Someone
     * who just signed in on their laptop and sees "your session expired
     * after a period of inactivity" on the desktop learns nothing and
     * suspects a bug; "you signed in on another device" is the truth and
     * needs no support ticket.
     */
    const res = NextResponse.json(
      {
        status: row.ended_reason === "taken_over" ? "taken_over" : status,
        alive: false,
        signedOut: true,
        endedReason: row.ended_reason ?? null,
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
    clearSessionCookie(res);
    return res;
  }

  return NextResponse.json(
    { status, alive, heartbeatSeconds: policies.session.heartbeatSeconds },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
