import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { qualitySalt } from "@/lib/session";
import { SurveyDefinition } from "@rescript/schema";
import { quotaIncrements, type ResponseState } from "@rescript/engine";
import { assessAndStore, deviceHashFrom, resolveRunDefinition, RESPONSE_COLUMNS } from "@rescript/quality/server";
import { configFingerprint, enabledRuleIds, resolveConfig, summarizeConfig } from "@rescript/quality";

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

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, respondent_id, is_test, respondent_code, deleted_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (existing.deleted_at) return NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 });
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

  const update: Record<string, unknown> = {
    status: newStatus,
    step_index: Number(stepIndex) || 0,
    answers: answers ?? {},
    calculated: calculated ?? {},
    embedded: embedded ?? {},
    flags: flags ?? [],
    completed_at: completed ? new Date().toISOString() : null,
    last_saved_at: new Date().toISOString(),
  };
  if (keepTelemetry) { update.telemetry = keepTelemetry; if (deviceHash) update.device_hash = deviceHash; }
  let { error } = await db.from("responses").update(update).eq("session_id", sessionId).eq("status", "in_progress");
  if (error && /last_saved_at/.test(error.message)) {
    // migration 0006 not applied yet — the column is a convenience, not the save
    delete update.last_saved_at;
    ({ error } = await db.from("responses").update(update).eq("session_id", sessionId).eq("status", "in_progress"));
  }
  if (error) {
    console.error("[rescript:save] write failed", JSON.stringify({ sessionId: sessionId.slice(0, 8), error: error.message }));
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }

  // Finalize: quota counts for THIS environment (test and live are counted
  // apart — migration 0006; before it, the two-argument call counts live only)
  let quality: { classification: string; riskScore: number; qualityScore: number } | null = null;
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
        const { error: qErr } = await db.rpc("increment_quota_counts", { p_survey_id: existing.survey_id, p_cells: cells, p_test: !!existing.is_test });
        if (qErr && !existing.is_test) await db.rpc("increment_quota_counts", { p_survey_id: existing.survey_id, p_cells: cells });
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
    if (existing.respondent_id) {
      await db.from("respondents").update({ status: newStatus }).eq("id", existing.respondent_id);
    }
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
    ok: true, quality,
    environment: existing.is_test ? "TEST" : "LIVE",
    respondentCode: existing.respondent_code ?? null,
    status: newStatus,
    definition: { source: run.source, versionId: run.versionId, configHash: def ? configFingerprint(resolveConfig(def)) : null },
  });
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
