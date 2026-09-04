import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadDeployment, loadTestBuild, type LoadedDeployment } from "@/lib/deployment";
import { createSession } from "@/lib/session";
import { clientIp } from "@rescript/quality/server";

export const dynamic = "force-dynamic";

/**
 * Mint — or resume — the response row for a survey session.
 *
 * The row used to be inserted while the page was server-rendered, so every
 * visit to the link wrote a row: a refresh, the Studio's Test Survey tab
 * opening, a crawler, a respondent reloading half-way (whose answers then
 * lived on in an orphan row while a fresh row started at question one). The
 * live database showed it: 51 of 73 rows in_progress, 44 of them with no
 * answers at all. Now the runner asks for its row once it is running, and
 * hands back the id it already holds when the tab reloads, so one attempt is
 * one row.
 *
 * Body: { client, study, mode: "test" | "live", token?, requestedVersionId?, resume?: sessionId }
 *
 * Resume is honoured only when the row belongs to the same survey and
 * environment and is still in progress; anything else starts a new session,
 * so a stale id can never read or write someone else's row.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const client = String(body?.client ?? "");
  const study = String(body?.study ?? "");
  const mode = body?.mode === "test" ? "test" : body?.mode === "live" ? "live" : null;
  if (!client || !study || !mode) return NextResponse.json({ error: "client, study and mode are required" }, { status: 400 });

  let d: LoadedDeployment | null = null;
  if (mode === "live") d = await loadDeployment(client, study, "live");
  else {
    const res = await loadTestBuild(client, study, typeof body?.requestedVersionId === "string" && body.requestedVersionId ? body.requestedVersionId : null);
    if (res.kind !== "ok") return NextResponse.json({ error: res.kind === "error" ? res.message : "No test build for this link" }, { status: 404 });
    d = res.dep;
  }
  if (!d) return NextResponse.json({ error: "Survey not found" }, { status: 404 });
  const isTest = mode === "test";
  const db = supabaseAdmin();

  // resume: same survey, same environment, still in progress, not deleted
  const resume = typeof body?.resume === "string" && body.resume.length >= 16 ? body.resume : null;
  if (resume) {
    const { data: row } = await db
      .from("responses")
      .select("session_id, seed, status, is_test, survey_id, respondent_code, answers, calculated, embedded, flags, step_index, deleted_at")
      .eq("session_id", resume)
      .maybeSingle();
    if (row && row.survey_id === d.surveyId && !!row.is_test === isTest && row.status === "in_progress" && !row.deleted_at) {
      console.info("[rescript:session] resumed", JSON.stringify({ surveyId: d.surveyId, environment: isTest ? "TEST" : "LIVE", session: resume.slice(0, 8), stepIndex: row.step_index, answers: Object.keys(row.answers ?? {}).length }));
      return NextResponse.json({
        ok: true, resumed: true,
        session: { sessionId: row.session_id, seed: Number(row.seed), surveyDbId: d.surveyId, versionDbId: d.versionId, respondentCode: row.respondent_code ?? null },
        saved: { answers: row.answers ?? {}, calculated: row.calculated ?? {}, embedded: row.embedded ?? {}, flags: row.flags ?? [], stepIndex: row.step_index ?? 0 },
      });
    }
  }

  const session = await createSession(d, {
    isTest,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent") ?? undefined,
    respondentToken: typeof body?.token === "string" ? body.token : undefined,
    allowTokenless: isTest,
  });
  if ("error" in session) return NextResponse.json({ error: session.error }, { status: 403 });
  const { data: made } = await db.from("responses").select("respondent_code").eq("session_id", session.sessionId).maybeSingle();
  console.info("[rescript:session] started", JSON.stringify({ surveyId: d.surveyId, environment: isTest ? "TEST" : "LIVE", session: session.sessionId.slice(0, 8), respondentCode: made?.respondent_code ?? null, versionId: d.versionId }));
  return NextResponse.json({
    ok: true, resumed: false,
    session: { sessionId: session.sessionId, seed: session.seed, surveyDbId: d.surveyId, versionDbId: d.versionId, respondentCode: made?.respondent_code ?? null, respondentId: session.respondentId ?? null },
  });
}
