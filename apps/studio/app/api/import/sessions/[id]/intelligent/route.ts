import { NextRequest, NextResponse } from "next/server";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { digestReport } from "@/lib/import/sessions";
import { coerceAnswers, intelligentFromSession, intelligenceView } from "@/lib/import/intelligent";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST { answers: [{ id, choice } | { id, own }] } — answer clarifications of an import in place (2026-11-13).
 *
 * The session's model is re-run through every stage with all the answers so far: what the answers decide is
 * programmed, the survey is validated and tested again, and the new state comes back — stages, what is still open,
 * the final report and the definition. Nothing is saved to a project here. Access is the session's own (the same
 * check as its other routes); the body is data only — an answer is an index into the choices offered or the
 * person's own words, which are recorded and never executed or programmed as a guess.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  if (isFailure(authed) && !(s && s.customerId === null)) return authed.response;
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();
  let body: { answers?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const answers = coerceAnswers(body.answers);
  if (!answers) return NextResponse.json({ error: "answers must be a list" }, { status: 400 });
  let r: ReturnType<typeof intelligentFromSession>;
  try { r = intelligentFromSession(s, answers, { format: s.format, platform: s.platform ?? null, label: s.reportDigest.label ?? s.format }); }
  catch (e) { return NextResponse.json({ error: `The import could not be continued: ${(e as Error).message}` }, { status: 500 }); }
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const { run } = r;
  if (!run.report) return NextResponse.json({ error: "The survey could not be built from this import." }, { status: 422 });
  await store.update(s.id, { decisions: r.decisions as never, reportDigest: digestReport(run.report) });
  return NextResponse.json({
    ok: run.ok, intelligence: intelligenceView(run), definition: run.definition, report: run.report,
    mapping: run.result?.mapping ?? [], confidence: run.result?.confidence ?? [], verification: run.verification,
  });
}
