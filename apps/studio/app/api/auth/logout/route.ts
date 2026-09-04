import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, sessionIdFrom, supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * SIGN OUT (§5).
 *
 * The session row is ended server-side, so the account is immediately free
 * for a login elsewhere — clearing the cookie alone would leave the row
 * "active" and the user locked out of their own account until it went stale.
 * The edit lock and the presence row go with it (§29), which is what makes
 * "John signed out" appear as "project available" on everyone else's screen.
 *
 * Deliberately tolerant: an unknown or already-ended session still answers
 * 200 and still clears the cookie. Sign-out must never fail — a user who
 * cannot sign out cannot sign in again.
 */
export async function POST(req: NextRequest) {
  const sessionId = sessionIdFrom(req);
  const user = await requireUser(req);

  if (sessionId) {
    try {
      const db = supabaseService();
      await db.rpc("rescript_end_session", { p_session: sessionId, p_reason: "logout", p_by: null });
    } catch (e) {
      console.error("[rescript:auth] logout could not end the session row", { error: (e as Error).message });
    }
  }
  if (!isFailure(user)) {
    await audit({
      action: "user.logged_out", userId: user.userId, sessionId,
      customerId: user.customerId, detail: {},
    });
  }

  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
