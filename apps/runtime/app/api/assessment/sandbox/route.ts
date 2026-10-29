import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { isAssessment, respondentAssessmentReport, scoreAssessment, validateAssessment } from "@rescript/engine";
import { attemptOf, launchPaper, paperByObserver, paperByToken, paperResponses, sandboxAvailable, submitAttempt } from "@/lib/assessmentSandbox";

export const dynamic = "force-dynamic";

/**
 * THE SANDBOX'S "TAKE THE TEST" (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md) — only on a
 * runtime with no database (403 elsewhere: a real paper is taken through its test / live link and scored by
 * the save route). The full definition (with the key) stays in this server's memory; the take page gets the
 * stripped one.
 *
 *   { action: "launch", definition }               → { token, observerKey, takeUrl }  (the Studio / a test, server to server)
 *   { action: "submit", token, answers }           → { attemptId, assessment }        (the respondent's page)
 *   { action: "result", token, attemptId }         → { assessment, reproduced }       (a reload re-scores; token-bound)
 *   { action: "responses", observerKey, withDefinition? } → attempts, CSV with score columns, item analysis (the researcher;
 *                                                    the definition too when asked — for the Studio's Word export)
 */
export async function POST(req: NextRequest) {
  const noStore = { headers: { "cache-control": "no-store" } };
  if (!sandboxAvailable()) return NextResponse.json({ error: "the assessment sandbox exists only on a runtime with no database" }, { status: 403, ...noStore });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  if (action === "launch") {
    const parsed = SurveyDefinition.safeParse(body.definition);
    if (!parsed.success) return NextResponse.json({ error: "send the survey definition" }, { status: 400, ...noStore });
    if (!isAssessment(parsed.data)) return NextResponse.json({ error: "this survey is not an assessment — switch Assessment on in the survey settings first" }, { status: 400, ...noStore });
    const v = validateAssessment(parsed.data);
    const p = launchPaper(parsed.data);
    return NextResponse.json({ ok: true, token: p.token, observerKey: p.observerKey, takeUrl: `/x/${p.token}`, validation: { ok: v.ok, errors: v.errors.slice(0, 20), warnings: v.warnings.length } }, noStore);
  }
  if (action === "responses") {
    const p = paperByObserver(String(body.observerKey ?? ""));
    if (!p) return NextResponse.json({ error: "unknown paper" }, { status: 404, ...noStore });
    /* withDefinition: the Studio's Word export of a sandbox paper — the observer key (returned only to the launcher, who sent this definition) is the credential */
    return NextResponse.json({ ok: true, title: p.def.meta.title, ...paperResponses(p), ...(body.withDefinition === true ? { definition: p.def } : {}) }, noStore);
  }
  const p = paperByToken(String(body.token ?? ""));
  if (!p) return NextResponse.json({ error: "unknown paper" }, { status: 404, ...noStore });
  if (action === "submit") {
    const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : {};
    const a = submitAttempt(p, answers);
    return NextResponse.json({ ok: true, attemptId: a.id, assessment: respondentAssessmentReport(p.def, a.result) }, noStore);
  }
  if (action === "result") {
    const a = attemptOf(p, String(body.attemptId ?? ""));
    if (!a) return NextResponse.json({ error: "unknown attempt" }, { status: 404, ...noStore });
    const again = scoreAssessment(p.def, a.answers);
    return NextResponse.json({ ok: true, assessment: respondentAssessmentReport(p.def, again), reproduced: JSON.stringify(again) === JSON.stringify(a.result) }, noStore);
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400, ...noStore });
}
