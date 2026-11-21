import { NextRequest } from "next/server";
import { json, portalRoute, readBody, signedIn } from "@/lib/portal/http";
import { assessmentDetail, editAnswer, explainResults, startLink } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * ONE OF THE RESPONDENT'S ASSESSMENTS. `id` is the enrolment; one that is not linked to the signed-in account is
 * "not found" (lib/portal/service.ts `own`).
 *
 *   GET                                                       → the assessment, its attempts, and — where the
 *                                                               researcher allows — the answers, each with whether
 *                                                               it may still be changed
 *   POST { action: "start" }                                  → { url } to take or continue it
 *   POST { action: "answer", responseId, questionId, value, revision }
 *                                                             → change one answer (policy, validation and the
 *                                                               revision are checked on the server)
 *   POST { action: "explain" }                                → the rule-written sentences about the latest results,
 *                                                               re-worded by the AI provider where the researcher
 *                                                               allows it; { text, source: "ai" | "rules" }
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return portalRoute(req, {}, async (deps) => json({ ok: true, ...(await assessmentDetail(deps, await signedIn(req, deps), params.id)) }));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  /* the summary is the one action here that can cost money: it is limited like a sign-in attempt, not like a page view */
  const peek = await req.clone().json().catch(() => ({})) as { action?: unknown };
  return portalRoute(req, { mutate: true, limit: peek.action === "explain" ? "portal_auth" : "portal" }, async (deps) => {
    const ctx = await signedIn(req, deps);
    const body = await readBody(req);
    if (body.action === "start") return json({ ok: true, ...(await startLink(deps, ctx, params.id)) });
    if (body.action === "answer") return json({ ok: true, ...(await editAnswer(deps, ctx, { enrolmentId: params.id, responseId: body.responseId, questionId: body.questionId, value: body.value, revision: body.revision })) });
    if (body.action === "explain") return json({ ok: true, ...(await explainResults(deps, ctx, params.id)) });
    return json({ error: "Unknown action.", code: "bad_action" }, 400);
  });
}
