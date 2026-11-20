import { NextRequest } from "next/server";
import { json, portalRoute, readBody } from "@/lib/portal/http";
import { portalOrigin, sendResetMail } from "@/lib/portal/mail";
import { confirmReset, requestReset } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * PASSWORD RESET. No session: a person who has forgotten their password cannot have one.
 *
 *   POST { login }             → always { ok: true }. When the login matches an account with an email address, a
 *                                reset link is emailed (one per two minutes). The answer is the same either way, so
 *                                the form cannot be used to find out who has an account.
 *   POST { token, password }   → the emailed link's token (single use, one hour): sets the password and signs every
 *                                session out. The person then signs in normally.
 */
export async function POST(req: NextRequest) {
  return portalRoute(req, { limit: "portal_auth", mutate: true }, async (deps) => {
    const body = await readBody(req);
    if (body.token !== undefined) {
      await confirmReset(deps, { token: body.token, password: body.password });
      return json({ ok: true });
    }
    const mail = await requestReset(deps, body.login);
    if (mail) {
      /* the token rides in the fragment: it is never sent to a server by the browser's request for the page */
      const link = `${portalOrigin(req.nextUrl.origin)}/portal/reset#token=${mail.token}`;
      await sendResetMail({ to: mail.to, name: mail.name, respondentId: mail.respondentId, link, minutes: mail.minutes });
    }
    return json({ ok: true });
  });
}
