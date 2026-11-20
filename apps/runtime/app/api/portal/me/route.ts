import { NextRequest } from "next/server";
import { json, portalRoute, readBody, signedIn } from "@/lib/portal/http";
import { changePassword, endSession, listSessions, overview, updateProfile } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * THE SIGNED-IN RESPONDENT.
 *
 *   GET                                         → { account, assessments, sessions }: the dashboard
 *   POST { action: "profile", name }            → correct the name
 *   POST { action: "password", current, next }  → change the password (other devices are signed out)
 *   POST { action: "end_session", sessionId }   → sign another device out
 */
export async function GET(req: NextRequest) {
  return portalRoute(req, {}, async (deps) => {
    const ctx = await signedIn(req, deps);
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
    return json({ error: "Unknown action.", code: "bad_action" }, 400);
  });
}
