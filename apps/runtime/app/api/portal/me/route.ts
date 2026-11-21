import { NextRequest } from "next/server";
import { json, portalRoute, readBody, requestMeta, signedIn } from "@/lib/portal/http";
import { changePassword, endSession, fileRequest, giveConsent, listSessions, myPrivacy, overview, updateProfile, withdrawConsent } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * THE SIGNED-IN RESPONDENT.
 *
 *   GET                                         → { account, assessments, sessions }: the dashboard
 *   POST { action: "profile", name }            → correct the name
 *   POST { action: "password", current, next }  → change the password (other devices are signed out)
 *   POST { action: "end_session", sessionId }   → sign another device out
 *   POST { action: "consent", version }         → agree to the portal notice (the version read)
 *   POST { action: "withdraw_consent" }         → withdraw it: assessments are hidden until agreed again
 *   POST { action: "request", assessmentId, kind: access | correction | deletion, message }
 *                                               → a privacy request to that assessment's organiser
 */
export async function GET(req: NextRequest) {
  return portalRoute(req, {}, async (deps) => {
    const ctx = await signedIn(req, deps);
    /* ?part=privacy → the agreement, the person's requests and who opened their results (the account page) */
    if (req.nextUrl.searchParams.get("part") === "privacy") return json({ ok: true, ...(await myPrivacy(deps, ctx)) });
    return json({ ok: true, ...(await overview(deps, ctx)), sessions: await listSessions(deps, ctx) });
  });
}

export async function POST(req: NextRequest) {
  return portalRoute(req, { mutate: true }, async (deps) => {
    const ctx = await signedIn(req, deps);
    const body = await readBody(req);
    if (body.action === "profile") return json({ ok: true, account: await updateProfile(deps, ctx, { name: body.name }) });
    if (body.action === "password") { await changePassword(deps, ctx, { current: body.current, next: body.next }); return json({ ok: true }); }
    if (body.action === "end_session") { await endSession(deps, ctx, body.sessionId); return json({ ok: true }); }
    if (body.action === "consent") { await giveConsent(deps, ctx, { version: body.version }, requestMeta(req)); return json({ ok: true }); }
    if (body.action === "withdraw_consent") { await withdrawConsent(deps, ctx); return json({ ok: true }); }
    if (body.action === "request") { await fileRequest(deps, ctx, { enrolmentId: body.assessmentId, kind: body.kind, message: body.message }); return json({ ok: true }); }
    return json({ error: "Unknown action.", code: "bad_action" }, 400);
  });
}
