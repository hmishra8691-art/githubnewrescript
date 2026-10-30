import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQuotaCounts, qualitySalt } from "@/lib/session";
import { recordSessionUsage } from "@/lib/metering";
import { SurveyDefinition } from "@rescript/schema";
import { checkSubmission, quotaIncrements, hasExactBalance, sanitizeNavTrail, balanceVariableForKey, sanitizeScriptWrites, sanitizeScriptHealth, redactionSet, type ResponseState, type SubmissionCheck } from "@rescript/engine";
import { sandboxRow, sandboxSurvey } from "@/lib/sessionSandbox";
import { isStaleSave, parseSaveSeq } from "@/lib/saveSeq";
import { assessAndStore, deviceHashFrom, resolveRunDefinition, RESPONSE_COLUMNS } from "@rescript/quality/server";
import { configFingerprint, enabledRuleIds, resolveConfig, summarizeConfig } from "@rescript/quality";
import { surveyFieldworkEvents } from "@/lib/notifyEmit";
import { assessmentResultRow, scoreForSubmission } from "@/lib/assessmentPayload";
import type { RespondentAssessmentReport } from "@rescript/engine";

export const dynamic = "force-dynamic";

/**
 * Persist session progress. Auth model: the sessionId is an unguessable
 * 128-bit token created server-side; only status/answers of that session
 * can be written, and only while it is in progress.
 *
 * Quality engine: every save stores the runtime's behavioural telemetry
 * (derived counts and durations, see runtime/lib/telemetry.ts) beside the
 * answers; the FINAL save — completion, screen-out, termination — runs the
 * quality engine against the survey's other responses and stores the
 * assessment on the row. There is no separate processing step. A failure in
 * the engine never fails the save: the answers are the data, the assessment
 * can be recomputed from the Studio.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, status, stepIndex, answers, calculated, embedded, flags, completed, telemetry } = body ?? {};
  if (typeof sessionId !== "string" || sessionId.length < 16)
    return NextResponse.json({ error: "invalid session" }, { status: 400 });
  const sbx = sandboxRow(sessionId);
  if (sbx) return sandboxSave(sbx, body);
  /* D6 / 0078: the client's save sequence number — an intermediate save older than the row's is not written */
  const seq = parseSaveSeq(body?.seq);

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, respondent_id, is_test, respondent_code, deleted_at, seed, started_at, surveys(customer_id)")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (existing.deleted_at) return NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 });
  /*
   * RUNTIME-07: a session the expire-partials sweep closed is NOT "already
   * finalized" — answering ok would tell a respondent whose tab sat open past
   * the survey's window that work was saved when it was dropped. Say so.
   */
  if (existing.status === "abandoned")
    return NextResponse.json({ error: "This survey session expired after a long period of inactivity. Please reload the page to start again.", code: "session_expired" }, { status: 410 });
  if (existing.status !== "in_progress")
    return NextResponse.json({ ok: true, note: "session already finalized", environment: existing.is_test ? "TEST" : "LIVE", respondentCode: existing.respondent_code ?? null });

  const validStatus = ["in_progress", "complete", "screened", "quota_full", "terminated"];
  const newStatus = validStatus.includes(status) ? status : "in_progress";

  // the definition decides what telemetry may be kept and which checks run —
  // it must be the one this session is actually running: a TEST session runs
  // the autosaved draft, not the version its row is recorded against (see
  // resolveRunDefinition in @rescript/quality/server)
  const run = await resolveRunDefinition(db, existing, body?.build);
  const def = run.def;
  const tcfg = def?.quality?.telemetry;
  const keepTelemetry = telemetry && typeof telemetry === "object" && telemetry.v === 1 ? sanitizeTelemetry(telemetry, tcfg) : undefined;
  const deviceHash = tcfg?.device === false ? null : deviceHashFrom(qualitySalt(existing.survey_id), keepTelemetry?.device ?? null);

  /*
   * RUNTIME-01 (audit 2026-10-16) — THE SERVER NO LONGER TAKES THE CLIENT'S
   * WORD FOR IT. The payload is replayed with the engine the browser ran
   * (`checkSubmission`): every page before the one the client claims to be
   * on must validate, and a completion must reach an end. The posture is set
   * by RUNTIME_SERVER_VALIDATION:
   *
   *   off      — the old behaviour (store verbatim)
   *   log      — replay, log every problem, store anyway        ← default
   *   enforce  — refuse a payload with a hard problem (422)
   *
   * `log` is the default so a deployment can watch a week of real traffic
   * for would-be refusals before turning enforcement on; a false refusal
   * would strand a respondent, which is worse than a stored bad row. TEST
   * sessions are never refused: a programmer's test link may start mid-survey
   * (`startAt`), which the replay cannot know about.
   */
  /* S1a: which values sandboxed scripts wrote — checked, and read by the replay (script_written, not a mismatch) */
  const scriptWrites = sanitizeScriptWrites(body?.scriptWrites);
  const check = def ? await serverCheck(def, existing, { status: newStatus, stepIndex, answers, calculated, embedded, flags, completed, scriptWrites }, sessionId) : null;
  if (check && !check.ok && validationPosture() === "enforce" && !existing.is_test) {
    const first = check.hard[0];
    return NextResponse.json({
      error: first.questionId ? `This answer could not be saved: ${first.message}` : `This page could not be saved: ${first.message}`,
      problems: check.hard,
    }, { status: 422 });
  }

  /*
   * D7 (S0b) — RUNTIME_SERVER_RECOMPUTE=store: the derived fields the replay recomputed (derived punches,
   * calculations, exact-balance claims) are stored as the SERVER derived them, not as posted. `log` (default)
   * only logs the `server_mismatch` lines with the submission check; `off` skips the comparison.
   */
  const stored = recomputePosture() === "store" ? withRecomputed({ answers, calculated }, check?.recomputed) : { answers, calculated };
  const update: Record<string, unknown> = {
    status: newStatus,
    step_index: Number(stepIndex) || 0,
    answers: stored.answers ?? {},
    calculated: stored.calculated ?? {},
    embedded: embedded ?? {},
    flags: flags ?? [],
    completed_at: completed ? new Date().toISOString() : null,
    last_saved_at: new Date().toISOString(),
  };
  /*
   * S1a: the script-write paradata travels with the telemetry jsonb (no new column in S1a) — so it is kept when the
   * survey keeps telemetry; a dedicated column is S1b/S1c's (see docs/S1-ONE-SCRIPT-ENGINE-2026-10-30.md).
   */
  if (keepTelemetry && scriptWrites.length) keepTelemetry.scriptWrites = scriptWrites;
  /*
   * S1c (D11 / SE-30) — SCRIPT HEALTH IS KEPT WHATEVER THE SURVEY'S TELEMETRY SWITCHES SAY. It describes the
   * survey's code (which script failed, how, on which page, how often, in which browser class) — not the respondent:
   * no timing, no typed text (messages are redacted again here against this save's own answers and embedded data).
   * The runtime sends the session's whole list on every save; it replaces the stored one.
   */
  const scriptHealth = sanitizeScriptHealth(body?.scriptHealth, redactionSet(answers, embedded));
  if (scriptHealth.length) { if (keepTelemetry) keepTelemetry.scriptHealth = scriptHealth; else update.telemetry = { scriptHealth }; }
  if (keepTelemetry) { update.telemetry = keepTelemetry; if (deviceHash) update.device_hash = deviceHash; }
  const isFinal = !!completed && newStatus !== "in_progress";
  if (seq != null) update.save_seq = seq;
  /*
   * SECTION NAVIGATION (0077, responses.nav): the Back trail and the pages seen, checked against the definition
   * this session runs — shape, bounds, every id a page of it; unknown ids are dropped, never stored. It is never
   * trusted to move the respondent: the replay above already decided what is valid, and resume positions by
   * step_index. A malformed trail is ignored (logged), never a refused save.
   */
  const nav = def ? sanitizeNavTrail(def, body?.nav) : { trail: null, dropped: 0 };
  if (nav.trail) update.nav = nav.trail;
  if (nav.invalid || nav.dropped) console.info("[rescript:save] navigation trail", JSON.stringify({ sessionId: sessionId.slice(0, 8), invalid: nav.invalid ?? null, dropped: nav.dropped }));
  /*
   * Y11 — THE UPDATE IS A COMPARE-AND-SWAP, SO READ WHAT IT SWAPPED.
   *
   * `.eq("status", "in_progress")` was already here and is exactly right: it
   * means only one request can move a response out of in_progress. What was
   * missing is that nobody looked at whether THIS request was the one that
   * did it. The status check further up runs on a row read BEFORE the update,
   * so two clicks 50 ms apart both read `in_progress`, both pass it, and both
   * fall through to the block below — which increments quota cells, confirms
   * List Fill claims and meters a billable SURVEY_RESPONSE. A quota cell up
   * by two, and the customer invoiced twice, for one interview.
   *
   * `.select("id")` turns the conditional update into a claim: the request
   * that actually performed the transition gets a row back, the loser gets an
   * empty array. Everything with a side effect now happens only for the
   * winner. No new table, no idempotency key — the condition was always
   * there, it just was not being read.
   */
  /*
   * D6 (audit 2026-10-30, migration 0078) — AN OLDER SAVE NEVER OVERWRITES A NEWER ONE. An intermediate save with a
   * seq is written only while the row's save_seq is lower (same compare-and-swap shape as the status condition
   * above); a stale one changes no row and is answered 200 { stale: true } below. The final save is not seq-guarded
   * (the status condition finalises it exactly once). Before 0078 the column is missing: retry without it, log once.
   */
  let seqGuard = seq != null && !isFinal;
  const applyUpdate = async () => {
    let q = db.from("responses").update(update).eq("session_id", sessionId).eq("status", "in_progress");
    if (seqGuard) q = q.lt("save_seq", seq as number);
    return q.select("id");
  };
  let { data: changed, error } = await applyUpdate();
  if (error && "save_seq" in update && /save_seq/.test(error.message)) {
    if (!warnedSeqColumn) { warnedSeqColumn = true; console.warn("[rescript:save] responses.save_seq missing (migration 0078 not applied) — saving unordered", error.message); }
    delete update.save_seq;
    seqGuard = false;
    ({ data: changed, error } = await applyUpdate());
  }
  if (error && /last_saved_at/.test(error.message)) {
    // migration 0006 not applied yet — the column is a convenience, not the save
    delete update.last_saved_at;
    ({ data: changed, error } = await applyUpdate());
  }
  if (error && "nav" in update && /\bnav\b/.test(error.message)) {
    // migration 0077 not applied yet — the trail is paradata, never the save: log once, keep the answers
    if (!warnedNavColumn) { warnedNavColumn = true; console.warn("[rescript:save] responses.nav missing (migration 0077 not applied) — saving without the navigation trail", error.message); }
    delete update.nav;
    ({ data: changed, error } = await applyUpdate());
  }
  if (error) {
    console.error("[rescript:save] write failed", JSON.stringify({ sessionId: sessionId.slice(0, 8), error: error.message }));
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }
  if (!changed?.length && seqGuard) {
    // no row changed: either a newer save already landed (stale) or the session was finalised meanwhile
    const { data: now } = await db.from("responses").select("status, save_seq").eq("session_id", sessionId).maybeSingle();
    if (now?.status === "in_progress") {
      console.info("[rescript:save] stale save ignored", JSON.stringify({ sessionId: sessionId.slice(0, 8), seq, stored: now.save_seq ?? null }));
      return NextResponse.json({ ok: true, stale: true, seq: now.save_seq ?? null, environment: existing.is_test ? "TEST" : "LIVE", respondentCode: existing.respondent_code ?? null });
    }
  }
  if (!changed?.length) {
    /*
     * Somebody else finalised this session between our read and our write.
     * Identical answer to the pre-read guard above, and for the same reason:
     * the interview IS finished and the caller should be told so, not handed
     * an error — but none of the finalisation below may run a second time.
     */
    console.info("[rescript:save] lost the finalise race — side effects skipped", JSON.stringify({ sessionId: sessionId.slice(0, 8) }));
    return NextResponse.json({
      ok: true, note: "session already finalized",
      environment: existing.is_test ? "TEST" : "LIVE",
      respondentCode: existing.respondent_code ?? null,
    });
  }

  // Finalize: quota counts for THIS environment (test and live are counted
  // apart — migration 0006; before it, the two-argument call counts live only)
  let quality: { classification: string; riskScore: number; qualityScore: number } | null = null;
  let assessment: RespondentAssessmentReport | null = null;
  if (completed && newStatus !== "in_progress") {
    if (def && newStatus === "complete") {
      const state = {
        answers: answers ?? {},
        calculated: calculated ?? {},
        embedded: embedded ?? {},
        flags: flags ?? [],
      } as unknown as ResponseState;
      const cells = quotaIncrements(def, state);
      if (cells.length) {
        // SCHEMA-07 (0057): record the cells on the row and count them once, so a soft delete can release them.
        // Before 0057 is applied the function is missing: fall back to the plain increment.
        const { error: cErr } = await db.rpc("rescript_count_quota_cells", { p_survey: existing.survey_id, p_session: sessionId, p_cells: cells, p_test: !!existing.is_test });
        if (cErr) {
          const { error: qErr } = await db.rpc("increment_quota_counts", { p_survey_id: existing.survey_id, p_cells: cells, p_test: !!existing.is_test });
          if (qErr && !existing.is_test) await db.rpc("increment_quota_counts", { p_survey_id: existing.survey_id, p_cells: cells });
        }
      }
    }
    /*
     * List Fill (migration 0007). A completed interview CONFIRMS its claims,
     * moving them into `completed_count` — which is the number a list capped
     * on completes is judged by, and the reporting split between in-progress
     * and finished for every other list.
     *
     * Anything else RELEASES them. A respondent who screened out or hit a
     * quota did not consume a slot of "150 interviews about Apple", and
     * leaving the claim behind would close an option that is not actually
     * full. Neither call can fail the save: the answers are the data, and
     * `rescript_recount_listfill` can rebuild the counters from the
     * allocations at any time.
     */
    if (def?.listFills?.length) {
      const fn = newStatus === "complete" ? "rescript_complete_listfill" : "rescript_release_listfill";
      const { error: lfErr } = await db.rpc(fn, { p_survey: existing.survey_id, p_session: sessionId });
      if (lfErr) console.error(`[rescript:listfill] ${fn} failed`, { sessionId: sessionId.slice(0, 8), status: newStatus, error: lfErr.message });
    }
    /*
     * Exact balance (engine item #15, migration 0073), the same bargain: a
     * completed interview keeps its randomizer / design-version claims counted
     * for good; a screen-out, termination or quota-full gives them back so the
     * completes balance. Never fails the save (a database without 0073 has no
     * claims — the arms were seed-derived).
     */
    if (def && hasExactBalance(def)) {
      const { error: bErr } = newStatus === "complete"
        ? await db.rpc("rescript_complete_balance", { p_survey: existing.survey_id, p_session: sessionId })
        : await db.rpc("rescript_release_balance", { p_survey: existing.survey_id, p_session: sessionId, p_reason: newStatus });
      if (bErr) console.error("[rescript:balance] end-of-interview update failed", { sessionId: sessionId.slice(0, 8), status: newStatus, error: bErr.message });
    }
    if (existing.respondent_id) {
      await db.from("respondents").update({ status: newStatus }).eq("id", existing.respondent_id);
    }
    /*
     * METERING (billing brief §6). One SURVEY_RESPONSE per completed
     * interview, on the project's wallet, in this environment — TEST
     * completes are TEST usage and priced by policy. Screen-outs and
     * quota-fulls are not completes and are not billed; the interview's data
     * is saved above regardless of what the meter says.
     */
    if (newStatus === "complete") {
      const cust = (existing as unknown as { surveys?: { customer_id?: string } | { customer_id?: string }[] }).surveys;
      const customerId = Array.isArray(cust) ? cust[0]?.customer_id : cust?.customer_id;
      if (customerId) void recordSessionUsage({ customerId, surveyId: existing.survey_id, environment: existing.is_test ? "TEST" : "LIVE", sessionId }, { eventType: "SURVEY_RESPONSE", quantity: 1, metadata: { sessionId: sessionId.slice(0, 8), versionId: existing.version_id } });
    }
    /*
     * ASSESSMENTS (K4 2026-10-25, ported 2026-10-29 — migration 0076): a completed paper is scored HERE, against
     * the server's definition (the respondent never had the key), deterministically (engine scoreAssessment).
     * The full result is stored per session in `assessment_results` (upsert on session_id, so a retried final
     * save cannot duplicate it); the respondent gets only the report sections the paper shows (null when its
     * results are never shown). Never fails the save: the answers are the data and the score is recomputable —
     * before 0076 is applied, /api/session/assessment re-scores from the answers.
     */
    if (newStatus === "complete") {
      try {
        const scored = scoreForSubmission(def, answers);
        if (scored) {
          assessment = scored.report;
          const { error: aErr } = await db.from("assessment_results").upsert(assessmentResultRow(existing, sessionId, scored.result), { onConflict: "session_id" });
          if (aErr) console.error("[rescript:assessment] storing the score failed (answers saved)", { sessionId: sessionId.slice(0, 8), error: aErr.message });
        }
      } catch (e) {
        console.error("[rescript:assessment] scoring failed (answers saved)", { sessionId: sessionId.slice(0, 8), error: (e as Error).message });
      }
    }
    /* G3 2026-10-22: survey fieldwork alerts — a quota-full end, completes milestones (never blocks the save) */
    if (newStatus === "quota_full" || newStatus === "complete") await surveyFieldworkEvents(db, { surveyId: existing.survey_id, status: newStatus, isTest: !!existing.is_test, sampleSize: def?.research?.sampleSize ?? null, title: def?.meta.title ?? null });
    // the quality engine, on the final state of the row
    const summary = def ? summarizeConfig(def) : null;
    // §3 — what the engine is about to receive, so the saved settings and the
    // executed settings can be compared line for line with the Studio's log
    console.info("[rescript:quality] config", JSON.stringify({
      surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), isTest: !!existing.is_test, status: newStatus,
      definition: { source: run.source, versionId: run.versionId, revision: run.revision, hint: body?.build?.source ?? null, note: run.note },
      config: summary ? { hash: summary.configHash, enabled: summary.enabled, strictness: summary.strictness, profile: summary.profile, rulesOn: summary.rulesOn, rulesCustomised: summary.rulesCustomised, customRules: summary.customRules, telemetryOff: summary.telemetryOff, bands: summary.bands } : null,
      enabledChecks: def ? enabledRuleIds(resolveConfig(def)) : [],
      at: new Date().toISOString(),
    }));
    if (def?.quality?.enabled) {
      try {
        const { data: row } = (await db.from("responses").select(RESPONSE_COLUMNS + ", survey_id").eq("id", existing.id).single()) as { data: any };
        if (row) {
          const a = await assessAndStore(db, def, row);
          quality = { classification: a.classification, riskScore: a.riskScore, qualityScore: a.qualityScore };
          console.info("[rescript:quality] assessed", JSON.stringify({ surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), configHash: a.configHash, strictness: a.strictness, classification: a.classification, risk: a.riskScore, quality: a.qualityScore, flags: a.flags.length, peers: a.benchmarks.peers, computedAt: a.computedAt }));
        }
      } catch (e) {
        console.error("[rescript:quality] assessment failed (answers saved)", { sessionId: sessionId.slice(0, 8), error: (e as Error).message });
      }
    } else if (def) {
      console.info("[rescript:quality] skipped — quality checks are off in the definition this session ran", JSON.stringify({ surveyId: existing.survey_id, sessionId: sessionId.slice(0, 8), source: run.source, versionId: run.versionId }));
    }
  }
  return NextResponse.json({
    ok: true, quality, ...(assessment ? { assessment } : {}),
    environment: existing.is_test ? "TEST" : "LIVE",
    respondentCode: existing.respondent_code ?? null,
    status: newStatus,
    definition: { source: run.source, versionId: run.versionId, configHash: def ? configFingerprint(resolveConfig(def)) : null },
  });
}

let warnedNavColumn = false;
let warnedSeqColumn = false;

/**
 * THE SANDBOX ROW (a runtime with no database, lib/sessionSandbox.ts): the same contract as the database path for
 * what section navigation needs — the replay check with the same posture, the same `nav` validation — and the row
 * kept in memory. Quality scoring, quotas, List Fill, metering and assessments are the database path's; a sandbox
 * session records none of them.
 */
async function sandboxSave(row: NonNullable<ReturnType<typeof sandboxRow>>, body: any) {
  /*
   * FAKE-ONLY SEAM (D6 browser check): delay this save before it is applied, so a test can make an older save
   * arrive after a newer one. Honoured only here — the sandbox path exists only without a database — and only with
   * the fake AI provider; capped at 5 s.
   */
  const delay = Number(body?.sandboxDelayMs);
  if ((process.env.AI_API_URL ?? "").startsWith("fake:") && Number.isFinite(delay) && delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
  if (row.status !== "in_progress") return NextResponse.json({ ok: true, note: "session already finalized", environment: "TEST", respondentCode: row.respondent_code });
  const survey = sandboxSurvey(row.survey);
  if (!survey) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  const validStatus = ["in_progress", "complete", "screened", "quota_full", "terminated"];
  const newStatus = validStatus.includes(body?.status) ? body.status : "in_progress";
  // D6: the same ordering rule as the database path (0078)
  const seq = parseSaveSeq(body?.seq);
  if (isStaleSave(row.save_seq, seq, !!body?.completed && newStatus !== "in_progress")) {
    console.info("[rescript:save] sandbox stale save ignored", JSON.stringify({ sessionId: row.session_id.slice(0, 8), seq, stored: row.save_seq }));
    return NextResponse.json({ ok: true, stale: true, seq: row.save_seq, environment: "TEST", respondentCode: row.respondent_code, sandbox: true });
  }
  const posture = validationPosture();
  let sandboxStored: { answers: unknown; calculated: unknown } | null = null;
  if (posture !== "off") {
    const check = checkSubmission({
      def: survey.def,
      prior: { seed: row.seed, sessionId: row.session_id, startedAt: row.started_at },
      posted: { answers: body?.answers ?? {}, calculated: body?.calculated ?? {}, embedded: body?.embedded ?? {}, flags: body?.flags ?? [], stepIndex: body?.stepIndex ?? 0, status: newStatus, completed: !!body?.completed, scriptWrites: sanitizeScriptWrites(body?.scriptWrites) },
      recompute: recomputePosture() !== "off",
    });
    if (recomputePosture() === "store") sandboxStored = withRecomputed({ answers: body?.answers, calculated: body?.calculated }, check.recomputed);
    if (check.hard.length || check.soft.length) console.info("[rescript:save] sandbox submission check", JSON.stringify({ sessionId: row.session_id.slice(0, 8), posture, hard: check.hard, soft: check.soft }));
    if (!check.ok && posture === "enforce") return NextResponse.json({ error: `This page could not be saved: ${check.hard[0].message}`, problems: check.hard }, { status: 422 });
  }
  const nav = sanitizeNavTrail(survey.def, body?.nav);
  Object.assign(row, {
    status: newStatus, step_index: Number(body?.stepIndex) || 0,
    answers: sandboxStored?.answers ?? body?.answers ?? {}, calculated: sandboxStored?.calculated ?? body?.calculated ?? {}, embedded: body?.embedded ?? {}, flags: Array.isArray(body?.flags) ? body.flags : [],
    completed_at: body?.completed ? new Date().toISOString() : null, last_saved_at: new Date().toISOString(),
    ...(nav.trail ? { nav: nav.trail } : {}),
    ...(seq != null ? { save_seq: seq } : {}),
    script_writes: sanitizeScriptWrites(body?.scriptWrites),
    // S1c: the session's script failures, as the database path keeps them in telemetry.scriptHealth
    script_health: sanitizeScriptHealth(body?.scriptHealth, redactionSet(body?.answers, body?.embedded)),
  });
  return NextResponse.json({ ok: true, environment: "TEST", respondentCode: row.respondent_code, status: newStatus, sandbox: true });
}

type Posture = "off" | "log" | "enforce";
function validationPosture(): Posture {
  const v = (process.env.RUNTIME_SERVER_VALIDATION ?? "log").toLowerCase();
  return v === "off" || v === "enforce" ? v : "log";
}

/** D7 (S0b): what the save does with the derived fields the replay recomputes — RUNTIME_SERVER_RECOMPUTE, default log */
function recomputePosture(): "off" | "log" | "store" {
  const v = (process.env.RUNTIME_SERVER_RECOMPUTE ?? "log").toLowerCase();
  return v === "off" || v === "store" ? v : "log";
}
/** the posted answers / calculated with the server's recomputed values laid over them */
function withRecomputed<T extends { answers: unknown; calculated: unknown }>(posted: T, rec: SubmissionCheck["recomputed"] | undefined): T {
  if (!rec || (!Object.keys(rec.answers).length && !Object.keys(rec.calculated).length)) return posted;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const answers: Record<string, unknown> = { ...obj(posted.answers) };
  for (const [k, v] of Object.entries(rec.answers)) { if (v == null) delete answers[k]; else answers[k] = v; }
  return { ...posted, answers, calculated: { ...obj(posted.calculated), ...rec.calculated } };
}

/** the exact-balance claims this session holds, as the variables they are written under (D7); {} when there are none or no 0073 */
async function storedBalanceClaims(def: SurveyDefinition, surveyId: string, isTest: boolean, sessionId: string): Promise<Record<string, string>> {
  if (!hasExactBalance(def)) return {};
  try {
    const { data, error } = await supabaseAdmin().from("balance_claims").select("balance_key, arms").eq("survey_id", surveyId).eq("is_test", isTest).eq("session_id", sessionId).in("status", ["active", "completed"]);
    if (error || !Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const r of data as { balance_key: string; arms: string[] }[]) { const v = balanceVariableForKey(def, r.balance_key); if (v && Array.isArray(r.arms)) out[v] = r.arms.join(","); }
    return out;
  } catch { return {}; }
}

/**
 * Replay the posted interview against the definition this session runs and
 * say what does not add up. Never throws and never blocks the save by itself:
 * an engine error here is logged and treated as "could not check".
 */
async function serverCheck(
  def: SurveyDefinition,
  existing: { survey_id: string; is_test: boolean | null; seed?: number | null; started_at?: string | null },
  posted: { status: string; stepIndex: unknown; answers: unknown; calculated: unknown; embedded: unknown; flags: unknown; completed: unknown; scriptWrites?: unknown },
  sessionId: string,
): Promise<SubmissionCheck | null> {
  const posture = validationPosture();
  if (posture === "off") return null;
  try {
    const quotaCounts = def.quotas?.length ? await loadQuotaCounts(existing.survey_id, !!existing.is_test) : {};
    const recompute = recomputePosture() !== "off";
    const balanceClaims = recompute ? await storedBalanceClaims(def, existing.survey_id, !!existing.is_test, sessionId) : {};
    const check = checkSubmission({
      def,
      prior: { seed: existing.seed == null ? null : Number(existing.seed), sessionId, startedAt: existing.started_at ?? null },
      posted: { answers: posted.answers ?? {}, calculated: posted.calculated ?? {}, embedded: posted.embedded ?? {}, flags: posted.flags ?? [], stepIndex: posted.stepIndex ?? 0, status: posted.status, completed: !!posted.completed, scriptWrites: posted.scriptWrites },
      quotaCounts, recompute, balanceClaims,
    });
    if (check.hard.length || check.soft.length) {
      console[check.hard.length ? "warn" : "info"]("[rescript:save] submission check", JSON.stringify({
        sessionId: sessionId.slice(0, 8), surveyId: existing.survey_id, isTest: !!existing.is_test, posture,
        status: posted.status, stepIndex: posted.stepIndex, replayedPages: check.replayedPages, endStatus: check.endStatus ?? null,
        wouldRefuse: check.hard.length > 0 && !existing.is_test,
        hard: check.hard, soft: check.soft,
      }));
    }
    return check;
  } catch (e) {
    console.error("[rescript:save] submission check failed (stored as posted)", JSON.stringify({ sessionId: sessionId.slice(0, 8), error: (e as Error).message }));
    return null;
  }
}

/**
 * Keep only the fields the collector defines, drop anything the survey has
 * switched off, and bound the size. Clipboard text never arrives (the
 * collector records lengths only) — this guards against a tampered client.
 */
function sanitizeTelemetry(t: any, cfg: any): any {
  const on = (k: string) => !cfg || cfg[k] !== false;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const pages = Array.isArray(t.pages) ? t.pages.slice(0, 2000).map((v: any) => ({
    pageId: String(v.pageId ?? "").slice(0, 80), step: num(v.step), enteredAt: num(v.enteredAt),
    leftAt: typeof v.leftAt === "number" ? v.leftAt : undefined,
    via: ["start", "next", "back", "reload", "jump"].includes(v.via) ? v.via : "next",
    questionIds: Array.isArray(v.questionIds) ? v.questionIds.slice(0, 200).map(String) : [],
    outOfFocusMs: on("focus") ? num(v.outOfFocusMs) : 0, blurs: on("focus") ? num(v.blurs) : 0,
    pointerEvents: on("interaction") ? num(v.pointerEvents) : 0, keyEvents: on("interaction") ? num(v.keyEvents) : 0, scrollEvents: on("interaction") ? num(v.scrollEvents) : 0,
  })) : [];
  const questions: Record<string, unknown> = {};
  if (t.questions && typeof t.questions === "object") {
    for (const [k, q] of Object.entries(t.questions as Record<string, any>).slice(0, 2000)) {
      questions[String(k).slice(0, 80)] = {
        firstChangeAt: typeof q?.firstChangeAt === "number" ? q.firstChangeAt : undefined,
        lastChangeAt: typeof q?.lastChangeAt === "number" ? q.lastChangeAt : undefined,
        changes: num(q?.changes), latencyMs: typeof q?.latencyMs === "number" ? q.latencyMs : undefined,
        pastes: on("clipboard") ? num(q?.pastes) : 0, pasteChars: on("clipboard") ? num(q?.pasteChars) : 0,
        typedChars: on("interaction") ? num(q?.typedChars) : 0, copies: on("clipboard") ? num(q?.copies) : 0,
      };
    }
  }
  const d = t.device && typeof t.device === "object" && on("device") ? {
    type: ["desktop", "tablet", "mobile"].includes(t.device.type) ? t.device.type : "unknown",
    browser: String(t.device.browser ?? "").slice(0, 40), os: String(t.device.os ?? "").slice(0, 40),
    screen: String(t.device.screen ?? "").slice(0, 20), viewport: String(t.device.viewport ?? "").slice(0, 20),
    dpr: num(t.device.dpr), locale: String(t.device.locale ?? "").slice(0, 20), language: String(t.device.language ?? "").slice(0, 10),
    timezone: String(t.device.timezone ?? "").slice(0, 60), tzOffset: num(t.device.tzOffset),
    touch: !!t.device.touch, webdriver: !!t.device.webdriver,
    hardwareConcurrency: typeof t.device.hardwareConcurrency === "number" ? t.device.hardwareConcurrency : undefined,
    platform: t.device.platform ? String(t.device.platform).slice(0, 40) : undefined,
  } : undefined;
  const disabled = new Set<string>(Array.isArray(t.disabled) ? t.disabled.map(String) : []);
  for (const k of ["timing", "focus", "clipboard", "navigation", "interaction", "device", "network"]) if (!on(k)) disabled.add(k);
  return {
    v: 1, startedAt: num(t.startedAt), submittedAt: typeof t.submittedAt === "number" ? t.submittedAt : undefined,
    pages: on("timing") || on("navigation") ? pages : [],
    questions: on("timing") ? questions : {},
    focus: on("focus") ? { blurs: num(t.focus?.blurs), totalOutOfFocusMs: num(t.focus?.totalOutOfFocusMs), longestOutOfFocusMs: num(t.focus?.longestOutOfFocusMs) } : { blurs: 0, totalOutOfFocusMs: 0, longestOutOfFocusMs: 0 },
    clipboard: on("clipboard") ? { copies: num(t.clipboard?.copies), pastes: num(t.clipboard?.pastes), pasteChars: num(t.clipboard?.pasteChars), largePastes: num(t.clipboard?.largePastes), pasteQuestions: num(t.clipboard?.pasteQuestions) } : { copies: 0, pastes: 0, pasteChars: 0, largePastes: 0, pasteQuestions: 0 },
    navigation: on("navigation") ? { back: num(t.navigation?.back), forward: num(t.navigation?.forward), reloads: num(t.navigation?.reloads), jumps: num(t.navigation?.jumps), sequence: Array.isArray(t.navigation?.sequence) ? t.navigation.sequence.slice(0, 500).map((x: unknown) => String(x).slice(0, 90)) : [] } : { back: 0, forward: 0, reloads: 0, jumps: 0, sequence: [] },
    interaction: on("interaction") ? { pointerEvents: num(t.interaction?.pointerEvents), keyEvents: num(t.interaction?.keyEvents), scrollEvents: num(t.interaction?.scrollEvents) } : { pointerEvents: 0, keyEvents: 0, scrollEvents: 0 },
    device: d,
    disabled: [...disabled],
  };
}
