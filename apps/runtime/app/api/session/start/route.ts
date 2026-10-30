import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { BLOCKING_STATUSES, loadDeployment, loadTestBuild, type LoadedDeployment } from "@/lib/deployment";
import { createSession } from "@/lib/session";
import { clientIp } from "@rescript/quality/server";
import { resolveSampleSource } from "@rescript/engine";
import type { PanelConfig } from "@rescript/schema";
import { panelParams, runtimePanels } from "@/lib/panels";
import { sessionAllowed } from "@/lib/metering";
import { sandboxAvailable, sandboxRow, sandboxSurvey, sandboxSurveyId, startSandboxSession } from "@/lib/sessionSandbox";

export const dynamic = "force-dynamic";

const RESUME_COLUMNS = "session_id, seed, status, is_test, survey_id, respondent_code, answers, calculated, embedded, flags, step_index, deleted_at";
let warnedNavRead = false;

/**
 * A SANDBOX TEST LINK (/n/<token>, a runtime with no database — lib/sessionSandbox.ts): the same contract as below,
 * against the in-memory rows. Resume returns the row's navigation trail (`nav`, what 0077 stores) like the
 * database path does.
 */
function sandboxStart(token: string, body: any) {
  if (!sandboxAvailable()) return NextResponse.json({ error: "Survey not found" }, { status: 404 });
  const survey = sandboxSurvey(token);
  if (!survey) return NextResponse.json({ error: "This sandbox survey is no longer active" }, { status: 404 });
  const id = sandboxSurveyId(survey.token);
  const resume = typeof body?.resume === "string" ? sandboxRow(body.resume) : null;
  if (resume && resume.survey === survey.token && resume.status === "in_progress") {
    return NextResponse.json({
      ok: true, resumed: true,
      session: { sessionId: resume.session_id, seed: resume.seed, surveyDbId: id, versionDbId: id, respondentCode: resume.respondent_code },
      saved: { answers: resume.answers, calculated: resume.calculated, embedded: resume.embedded, flags: resume.flags, stepIndex: resume.step_index, nav: resume.nav, savedAt: resume.last_saved_at },
    });
  }
  const row = startSandboxSession(survey);
  return NextResponse.json({ ok: true, resumed: false, session: { sessionId: row.session_id, seed: row.seed, surveyDbId: id, versionDbId: id, respondentCode: row.respondent_code } });
}

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
  if (client === "sandbox") return sandboxStart(study, body);

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
   * RUNTIME-02 (audit 2026-10-16). The live page refuses a paused or closed
   * survey and asks for the password — but the page is only HTML. This route
   * is what actually mints a session, and it minted one for anybody who
   * posted {client, study, mode:"live"}, password or not, closed or not. The
   * same two gates, applied where the row is created. Test links are the
   * programmer's own and keep working while a survey is paused.
   */
  if (!isTest) {
    const blocked = BLOCKING_STATUSES[d.surveyStatus];
    if (blocked) return NextResponse.json({ error: blocked.title, blocked: true }, { status: 403 });
    const access = d.definition.deployment.access;
    if (access.mode === "password") {
      const urlPw = body?.urlParams && typeof body.urlParams === "object" ? body.urlParams.pw : undefined;
      const given = typeof body?.pw === "string" ? body.pw : typeof urlPw === "string" ? urlPw : "";
      if (!access.password || given !== access.password) return NextResponse.json({ error: "Password required" }, { status: 403 });
    }
  }

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
    const { data: row, error: navReadError } = await db
      .from("responses")
      .select(`${RESUME_COLUMNS}, nav, last_saved_at`)
      .eq("session_id", resume)
      .maybeSingle();
    /*
     * 0077 (responses.nav) may not be applied yet: then the select names a missing column and returns nothing.
     * Read again without it — the browser's own copy of the trail is the fallback (Runner) — and say so once.
     */
    let resumed = row as (typeof row & { nav?: unknown; last_saved_at?: string | null }) | null;
    if (navReadError && !resumed) {
      if (!warnedNavRead) { warnedNavRead = true; console.warn("[rescript:session] resume read without responses.nav (migration 0077 not applied?)", navReadError.message); }
      const again = await db.from("responses").select(RESUME_COLUMNS).eq("session_id", resume).maybeSingle();
      resumed = again.data as typeof resumed;
    }
    if (resumed && resumed.survey_id === d.surveyId && !!resumed.is_test === isTest && resumed.status === "in_progress" && !resumed.deleted_at) {
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
      console.info("[rescript:session] resumed", JSON.stringify({ surveyId: d.surveyId, environment: isTest ? "TEST" : "LIVE", session: resume.slice(0, 8), stepIndex: resumed.step_index, answers: Object.keys(resumed.answers ?? {}).length }));
      return NextResponse.json({
        ok: true, resumed: true,
        session: { sessionId: resumed.session_id, seed: Number(resumed.seed), surveyDbId: d.surveyId, versionDbId: d.versionId, respondentCode: resumed.respondent_code ?? null },
        saved: { answers: resumed.answers ?? {}, calculated: resumed.calculated ?? {}, embedded: resumed.embedded ?? {}, flags: resumed.flags ?? [], stepIndex: resumed.step_index ?? 0, nav: resumed.nav ?? null, savedAt: resumed.last_saved_at ?? null },
      });
    }
  }

  /*
   * METERING (billing brief §14). A project at its usage limit takes no new
   * interview in a billable environment — the same sentence the Studio shows.
   * Resumes above are untouched: a respondent already in the interview
   * finishes it. Configurable: `lockRespondentsWhenReadOnly`.
   */
  {
    const { data: sv } = await db.from("surveys").select("customer_id").eq("id", d.surveyId).maybeSingle();
    if (sv?.customer_id) {
      const gate = await sessionAllowed(sv.customer_id, d.surveyId, isTest ? "TEST" : "LIVE");
      if (!gate.allowed) return NextResponse.json({ error: gate.message, code: "wallet_read_only" }, { status: 423 });
    }
  }
  /*
   * G3 2026-10-22 — PANEL RECRUITMENT ON THE SURVEY LINK. A survey whose deployed definition names panels: the
   * arrival is matched to its panel (by the panel's id parameter), refused without the id, refused as a DUPLICATE
   * when that panel id already took part (atomic in 0072), or sent back over quota when the panel's completes are
   * met. An admitted entry is tied to the new response; the signed exit is /api/panel/exit?r={{response.id}}.
   */
  const panels = Array.isArray((d.definition as { panels?: unknown[] }).panels) && (d.definition as { panels: unknown[] }).panels.length ? runtimePanels({ panels: (d.definition as { panels: PanelConfig[] }).panels }) : null;
  const panelEntry = panels ? await panels.enter({ surveyId: d.surveyId, target: "survey", targetRef: d.versionId ?? null, params: panelParams(urlParams), isTest }) : null;
  if (panelEntry && (panelEntry.kind === "refused" || panelEntry.kind === "duplicate")) return NextResponse.json({ error: panelEntry.message, code: `panel_${panelEntry.kind}` }, { status: 409 });
  if (panelEntry && panelEntry.kind === "over_quota") return NextResponse.json({ error: panelEntry.message, code: "panel_over_quota", redirectUrl: panelEntry.redirect.url }, { status: 409 });
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
  if (panels && panelEntry?.kind === "admitted") await panels.attach(panelEntry.entryId, session.sessionId);
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
