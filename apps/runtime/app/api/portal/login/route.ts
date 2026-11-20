import { NextRequest } from "next/server";
import { json, portalRoute, readBody, requestMeta, withSessionCookie } from "@/lib/portal/http";
import { signIn } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/** POST { login, password } — sign in with a Respondent ID or email. The session is set as an httpOnly cookie; the token is never in the reply. */
export async function POST(req: NextRequest) {
  return portalRoute(req, { limit: "portal_auth", mutate: true }, async (deps) => {
    const body = await readBody(req);
    const s = await signIn(deps, { login: body.login, password: body.password }, requestMeta(req));
    return withSessionCookie(json({ ok: true, account: s.account, mustChangePassword: s.mustChangePassword }), s.sessionToken);
  });
}
