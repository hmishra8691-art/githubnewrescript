import { NextRequest } from "next/server";
import { json, portalRoute, readBody, requestMeta, withSessionCookie } from "@/lib/portal/http";
import { acceptInvitation, invitationInfo } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * AN INVITATION LINK. Authenticated by the link's own token (32 random bytes, stored as SHA-256, single use,
 * time-limited) — there is no session yet; this is what creates one.
 *
 *   POST { token }             → { respondentId, name }   what the "set your password" page shows
 *   POST { token, password, consent: true }   → records agreement to the portal notice, sets the password,
 *                                activates the account, signs in
 *
 * The token travels in the body, never in a query string the server would log.
 */
export async function POST(req: NextRequest) {
  return portalRoute(req, { limit: "portal_auth", mutate: true }, async (deps) => {
    const body = await readBody(req);
    if (body.password === undefined) return json({ ok: true, ...(await invitationInfo(deps, body.token)) });
    const s = await acceptInvitation(deps, { token: body.token, password: body.password, consent: body.consent }, requestMeta(req));
    return withSessionCookie(json({ ok: true, account: s.account }), s.sessionToken);
  });
}
