import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadDeployment, loadTestBuild, type LoadedDeployment } from "@/lib/deployment";
import { createSession } from "@/lib/session";
import { clientIp } from "@rescript/quality/server";
import { resolveSampleSource } from "@rescript/engine";

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
 * Body: { client, study, mode: "test" | "live", token?, requestedVersionId?,
 *         resume?: sessionId, urlParams?: Record<string, string> }
 *
 * `urlParams` is the invitation link's query string, forwarded by the runner
 * so the supplier the respondent came from can be recorded (§23). It is read
 * for nothing else — the survey's own embedded data is captured client-side,
 * where the URL is.
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

  /*
   * §23: the supplier this respondent came from. The runner sends the URL
   * parameters it was rendered with, and the survey's own configuration (plus
   * the conventional names) decides which of them is the source — see
   * `resolveSampleSource`. Nothing here trusts the value beyond recording it:
   * it is tidied and length-capped in the engine, and it is a text column
   * precisely so an unexpected code is reportable rather than fatal.
   */
  const urlParams = (body?.urlParams && typeof body.urlParams === "object" && !Array.isArray(body.urlParams))
    ? (body.urlParams as Record<string, string>)
    : null;
  const sample = resolveSampleSource(d.definition, urlParams);

  // resume: same survey, same environment, still in progress, not deleted
  const resume = typeof body?.resume === "string" && body.resume.length >= 16 ? body.resume : null;
  if (resume) {
    const { data: row } = await db
      .from("responses")
      .select("session_id, seed, status, is_test, survey_id, respondent_code, answers, calculated, embedded, flags, step_index, deleted_at")
      .eq("session_id", resume)
      .maybeSingle();
    if (row && row.survey_id === d.surveyId && !!row.is_test === isTest && row.status === "in_progress" && !row.deleted_at) {
      /*
       * A respondent can reach page one before their source is known: the
       * first link they followed carried no parameter, or the row was minted
       * by a resume email. So a source arriving later is filled in — but only
       * onto a row that has none. The FIRST attribution is the true one; a
       * respondent who resumes from a different supplier's link did not come
       * from that supplier, and overwriting would let the last click take
       * credit for someone else's complete. The `.is(null)` predicate makes
       * that guarantee in the database rather than in a read-then-write.
       */
      if (sample.source) {
        const patch: Record<string, string> = { sample_source: sample.source };
        if (sample.respondent) patch.sample_source_respondent = sample.respondent;
        const { error: fillErr } = await db
          .from("responses").update(patch)
          .eq("session_id", resume).is("sample_source", null);
        // a pre-0012 database has no column to fill; the interview continues
        if (fillErr) console.warn("[rescript:session] sample source not recorded on resume", fillErr.message);
      }
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
    sampleSource: sample.source,
    sampleSourceRespondent: sample.respondent,
  });
  if ("error" in session) return NextResponse.json({ error: session.error }, { status: 403 });
  const { data: made } = await db.from("responses").select("respondent_code").eq("session_id", session.sessionId).maybeSingle();
  console.info("[rescript:session] started", JSON.stringify({ surveyId: d.surveyId, environment: isTest ? "TEST" : "LIVE", session: session.sessionId.slice(0, 8), respondentCode: made?.respondent_code ?? null, versionId: d.versionId, sampleSource: sample.source, sampleSourceParam: sample.sourceParam ?? null }));
  return NextResponse.json({
    ok: true, resumed: false,
    session: { sessionId: session.sessionId, seed: session.seed, surveyDbId: d.surveyId, versionDbId: d.versionId, respondentCode: made?.respondent_code ?? null, respondentId: session.respondentId ?? null },
    /*
     * §24 — the fields this respondent's row on the invitation list carries.
     * Sent separately from `session` because it is not identity: it is data
     * the survey will pipe and branch on, and it belongs with `saved` in the
     * runner's boot.
     */
    respondentEmbedded: session.respondentEmbedded ?? null,
  });
}
