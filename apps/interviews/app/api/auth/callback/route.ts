import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { safeNextPath } from "@rescript/access";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, publicOrigin, setSessionCookie, userForSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * SPEND A HANDOFF CODE AND BECOME SIGNED IN.
 *
 * The other half of `apps/studio/app/api/auth/handoff/route.ts`. The Studio
 * sent the visitor here with a one-time code because its session cookie is
 * host-only and cannot reach this origin — see `0032_auth_handoff.sql` for why
 * a shared cookie domain is not an option on `vercel.app`.
 *
 * Everything that decides whether the code is good happens in the database, in
 * one statement, so there is no window between checking and spending:
 * `rescript_auth_redeem_handoff` returns the session id or NULL, and NULL
 * covers every reason at once — unknown, already spent, expired, minted for a
 * different origin. This route cannot tell them apart and does not try; a
 * redemption endpoint that explains its refusals is an oracle for guessing.
 *
 * ## The code does not stay in the address bar
 *
 * The response is a redirect to a clean URL, so the code is in history for one
 * hop and then gone, and `referrer-policy: no-referrer` keeps it out of the
 * next request's headers. It is single-use and already spent by then, but a
 * credential that lingers in a URL bar is one somebody pastes into a support
 * ticket.
 *
 * ## A failure never loops
 *
 * An expired or reused code sends the visitor to the home page with a note,
 * NOT back to the handoff. Retrying automatically is how two apps redirect at
 * each other forever, and the loop is indistinguishable from an outage.
 */

function go(req: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));

  if (!code) return go(req, "/?signin=failed");

  /*
   * The origin the code was minted for. It must be the configured public
   * origin, not `req.nextUrl.origin` — reading it off the request would mean a
   * code minted for the real deployment could be redeemed through any hostname
   * that happens to route here, which is exactly the binding the code exists
   * to have.
   */
  const origin = publicOrigin();
  if (!origin) return go(req, "/?signin=misconfigured");

  const codeHash = createHash("sha256").update(code).digest("hex");

  const { data, error } = await supabaseAdmin().rpc("rescript_auth_redeem_handoff", {
    p_code_hash: codeHash,
    p_origin: origin,
  });
  /*
   * A transport failure is NOT a bad code. Saying "that link expired" when the
   * database was briefly unreachable sends somebody to get a new link that
   * will fail the same way; saying "try again" is both true and useful.
   */
  if (error) return go(req, "/?signin=unavailable");

  const sessionId = typeof data === "string" ? data : null;
  if (!sessionId) return go(req, "/?signin=expired");

  /*
   * The code was good. The SESSION still has to be — it could have been
   * revoked in the seconds since, and a handoff must not resurrect something
   * an admin just ended. This is the same check every other request makes, so
   * there is no second notion of "signed in" to drift.
   */
  const user = await userForSession(sessionId);
  if (isFailure(user)) return go(req, "/?signin=expired");

  const res = go(req, next);
  setSessionCookie(res, sessionId);
  return res;
}
