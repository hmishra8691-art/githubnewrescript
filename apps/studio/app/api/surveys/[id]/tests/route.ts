import { NextRequest, NextResponse } from "next/server";
import { runSuite, runTestCase, describeSuite, type TestCase } from "@rescript/templates";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST CASES AND REGRESSION TESTING (§55, §56).
 *
 *   GET  ?                          the suite: every case with its latest run
 *   GET  ?caseId=…                  one case's full history
 *   POST { action: "create" }       a new case
 *   POST { action: "update" }       name / notes / input / expectations / enabled
 *   POST { action: "run" }          run one case, record the run
 *   POST { action: "run_all" }      run the suite as ONE batch — the regression run
 *   POST { action: "bless" }        accept the last outcome as the baseline
 *   POST { action: "delete" }
 *
 * WHICH DEFINITION IT RUNS. `loadQualityDefinition` — the autosaved draft when
 * there is one, otherwise the current version. That is the same rule the TEST
 * LINK follows (`testBuild.ts`), and it has to be: a suite that graded the
 * published version while the programmer was testing their draft would report
 * green on work they had not saved yet, which is the most expensive answer it
 * could give. The version actually used is recorded on every run.
 *
 * WHICH CAPABILITY. `responses.read` to see the suite, `survey.edit` to change
 * or run it. Running is a write — it records a run row and can move a
 * baseline — but it deliberately does NOT require the edit lock: the suite is
 * QA data, not the questionnaire, and needing to take editing away from a
 * colleague to check whether their change broke path C would defeat the point
 * of having it. `scripts/auth-guard-audit.mjs` carries that exemption with
 * its reason.
 *
 * WHY THE RUNNER IS NOT HERE. `runSuite` and `runTestCase` are in
 * `@rescript/templates`, beside `simulateRespondent`, and unit-tested there
 * (30 assertions). This file is the part that cannot be tested without a
 * database: loading, recording, and reporting.
 */

interface CaseRow {
  id: string;
  name: string;
  notes: string | null;
  enabled: boolean;
  input: TestCase["input"];
  expectations: TestCase["expectations"];
  baseline: TestCase["baseline"];
  baseline_at: string | null;
}

const asTestCase = (r: CaseRow): TestCase => ({
  id: r.id,
  name: r.name,
  notes: r.notes ?? undefined,
  enabled: r.enabled,
  input: r.input ?? { answers: {} },
  expectations: r.expectations ?? undefined,
  baseline: r.baseline ?? null,
});

const needsMigration = (message: string | undefined) =>
  NextResponse.json({
    error: "Test cases need migration 0018.",
    migration: "0018",
    detail: message,
  }, { status: 503 });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const caseId = req.nextUrl.searchParams.get("caseId");

  /* one case's history — the "has this been flaky" view */
  if (caseId) {
    const { data: runs, error } = await db
      .from("survey_test_runs")
      .select("id, verdict, fingerprint, version_label, failures, changes, duration_ms, run_at, batch_id")
      .eq("test_case_id", caseId)
      .eq("survey_id", params.id)
      .order("run_at", { ascending: false })
      .limit(50);
    if (error) return missingMigration(error.message) ? needsMigration(error.message) : NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ runs: runs ?? [] }, { headers: { "cache-control": "no-store" } });
  }

  const [{ data: suite, error: suiteErr }, { data: cases, error: casesErr }] = await Promise.all([
    db.rpc("rescript_test_suite", { p_survey: params.id }),
    db.from("survey_test_cases")
      .select("id, name, notes, enabled, input, expectations, baseline, baseline_at")
      .eq("survey_id", params.id)
      .order("name"),
  ]);
  const err = suiteErr ?? casesErr;
  if (err) return missingMigration(err.message) ? needsMigration(err.message) : NextResponse.json({ error: err.message }, { status: 500 });

  /*
   * The definition is loaded here too, and only for its question and page
   * LISTS: a case editor that cannot offer the questions by code is one where
   * every case is written by pasting ids. A definition that does not parse is
   * reported rather than hidden — the suite is unrunnable in that state and
   * saying so is the useful answer.
   */
  const loaded = await loadQualityDefinition(db, params.id);
  const definitionError = "error" in loaded ? loaded.error : null;
  const questions = "error" in loaded ? [] : loaded.def.questions.map((q) => ({
    id: q.id, code: q.code, variableName: q.variableName, type: q.type,
    text: (q.text ?? "").replace(/<[^>]*>/g, "").slice(0, 120),
    options: q.options.map((o) => ({ code: String(o.code), label: o.label.replace(/<[^>]*>/g, "").slice(0, 60) })),
  }));
  const pages = "error" in loaded ? [] : pageList(loaded.def);

  return NextResponse.json({
    suite: suite ?? [],
    cases: cases ?? [],
    questions,
    pages,
    /* what a run WOULD grade, so the panel can say so before the button is pressed */
    runsAgainst: "error" in loaded ? null : { source: loaded.source, version: loaded.version, revision: loaded.revision },
    definitionError,
  }, { headers: { "cache-control": "no-store" } });
}

/** Pages with the question codes on them — how a programmer recognises a page. */
function pageList(def: { flow: unknown[]; questions: { id: string; code: string }[] }) {
  const out: { id: string; label: string }[] = [];
  const code = (qid: string) => def.questions.find((q) => q.id === qid)?.code ?? qid;
  const walk = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      const n = raw as { type?: string; id?: string; title?: string; questionIds?: string[]; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] };
      if (n.type === "page" && n.id) {
        const codes = (n.questionIds ?? []).map(code);
        out.push({ id: n.id, label: n.title?.trim() || (codes.length ? codes.join(", ") : n.id) });
      }
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(def.flow ?? []);
  return out;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const db = supabaseAdmin();
  const action = String(body?.action ?? "");

  /* ------------------------------------------------------------- editing */

  if (action === "create" || action === "update") {
    const name = String(body?.name ?? "").trim();
    if (action === "create" && !name) {
      return NextResponse.json({ error: "A test case needs a name — it is what the suite reports." }, { status: 400 });
    }
    const patch: Record<string, unknown> = { updated_by: gate.user.userId };
    if (name) patch.name = name.slice(0, 200);
    if (typeof body?.notes === "string") patch.notes = body.notes.slice(0, 2000) || null;
    if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
    if (body?.input && typeof body.input === "object") {
      /*
       * The seed is defaulted HERE rather than at run time. A case saved
       * without one would be re-seeded on every run and report a change every
       * time — so the value is pinned when the case is written, and a person
       * can see and change it.
       */
      const input = body.input as Record<string, unknown>;
      patch.input = {
        answers: input.answers && typeof input.answers === "object" ? input.answers : {},
        ...(input.embedded && typeof input.embedded === "object" ? { embedded: input.embedded } : {}),
        seed: typeof input.seed === "number" && Number.isFinite(input.seed) ? Math.round(input.seed) : 1,
        ...(input.quotaCounts && typeof input.quotaCounts === "object" ? { quotaCounts: input.quotaCounts } : {}),
        ...(input.listFillCounts && typeof input.listFillCounts === "object" ? { listFillCounts: input.listFillCounts } : {}),
      };
    }
    if (body?.expectations && typeof body.expectations === "object") patch.expectations = body.expectations;

    if (action === "create") {
      const { data, error } = await db.from("survey_test_cases")
        .insert({ survey_id: params.id, created_by: gate.user.userId, ...patch })
        .select("id, name")
        .maybeSingle();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          return NextResponse.json({ error: "This survey already has a test case with that name." }, { status: 409 });
        }
        return missingMigration(error.message) ? needsMigration(error.message) : NextResponse.json({ error: error.message }, { status: 500 });
      }
      await audit({
        action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
        surveyId: params.id, customerId: gate.user.customerId,
        entity: "test_case", entityId: data?.id ?? null,
        detail: { summary: `added the test case “${data?.name}”` },
      });
      return NextResponse.json({ ok: true, id: data?.id });
    }

    const caseId = String(body?.caseId ?? "");
    if (!caseId) return NextResponse.json({ error: "caseId is required" }, { status: 400 });
    const { error } = await db.from("survey_test_cases").update(patch)
      .eq("id", caseId).eq("survey_id", params.id);
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return NextResponse.json({ error: "This survey already has a test case with that name." }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "delete") {
    const caseId = String(body?.caseId ?? "");
    if (!caseId) return NextResponse.json({ error: "caseId is required" }, { status: 400 });
    const { data: row } = await db.from("survey_test_cases").select("name").eq("id", caseId).eq("survey_id", params.id).maybeSingle();
    const { error } = await db.from("survey_test_cases").delete().eq("id", caseId).eq("survey_id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await audit({
      action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "test_case", entityId: caseId,
      detail: { summary: `deleted the test case “${row?.name ?? caseId}”` },
    });
    return NextResponse.json({ ok: true });
  }

  /* ------------------------------------------------------------- running */

  if (action === "run" || action === "run_all") {
    const loaded = await loadQualityDefinition(db, params.id);
    if ("error" in loaded) {
      /*
       * A definition that will not parse is reported, never worked around. A
       * suite that silently graded an older version would be worse than one
       * that refuses: the programmer would trust a result about work they
       * have not saved.
       */
      return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    }

    let query = db.from("survey_test_cases")
      .select("id, name, notes, enabled, input, expectations, baseline, baseline_at")
      .eq("survey_id", params.id);
    if (action === "run") {
      const caseId = String(body?.caseId ?? "");
      if (!caseId) return NextResponse.json({ error: "caseId is required" }, { status: 400 });
      query = query.eq("id", caseId);
    }
    const { data: rows, error } = await query;
    if (error) return missingMigration(error.message) ? needsMigration(error.message) : NextResponse.json({ error: error.message }, { status: 500 });
    if (!rows?.length) {
      return NextResponse.json({ ok: true, summary: null, note: "There are no test cases to run yet." });
    }

    const cases = (rows as CaseRow[]).map(asTestCase);
    const versionLabel = loaded.source === "draft"
      ? `draft r${loaded.revision ?? "?"}`
      : `version ${loaded.version ?? "?"}`;

    /*
     * ONE BATCH ID for the whole run, even when running a single case. That
     * is what makes "the regression run at 14:02" a thing you can retrieve
     * rather than a set of rows to reassemble by timestamp.
     */
    const batchId = crypto.randomUUID();
    const started = Date.now();

    /* a single case still goes through runSuite, so one code path decides verdicts */
    const suite = action === "run"
      ? { results: [runTestCase(loaded.def, cases[0])], summary: runSuite(loaded.def, cases).summary }
      : runSuite(loaded.def, cases);

    const perCase = Math.max(1, Math.round((Date.now() - started) / Math.max(1, suite.results.length)));
    const { error: insErr } = await db.from("survey_test_runs").insert(
      suite.results.map((r) => ({
        survey_id: params.id,
        test_case_id: r.caseId,
        version_id: loaded.source === "version" ? loaded.versionId : null,
        version_label: versionLabel,
        batch_id: batchId,
        verdict: r.verdict,
        fingerprint: r.outcome.fingerprint,
        outcome: r.outcome,
        failures: r.failures,
        changes: r.changes,
        duration_ms: perCase,
        run_by: gate.user.userId,
      })),
    );
    if (insErr) {
      /* the run happened; failing to record it must not hide the result */
      console.error("[rescript:tests] run not recorded", { error: insErr.message });
    }

    if (action === "run_all") {
      await audit({
        action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
        surveyId: params.id, customerId: gate.user.customerId,
        entity: "test_suite", entityId: batchId,
        detail: { summary: `ran the test suite against ${versionLabel} — ${describeSuite(suite.summary)}`, ...suite.summary },
      });
    }

    return NextResponse.json({
      ok: true,
      batchId,
      ranAgainst: { source: loaded.source, label: versionLabel },
      summary: suite.summary,
      note: describeSuite(suite.summary),
      results: suite.results,
      ...(insErr ? { warning: "The results below are correct, but could not be saved to the run history." } : {}),
    });
  }

  /* --------------------------------------------------------- blessing */

  if (action === "bless") {
    const caseId = String(body?.caseId ?? "");
    if (!caseId) return NextResponse.json({ error: "caseId is required" }, { status: 400 });

    /*
     * The baseline comes from the LAST RECORDED RUN, not from a fresh one.
     * Blessing has to accept the outcome the person just looked at and
     * decided was right; re-running to capture it would bless something they
     * never saw, and on a survey being edited that is a different outcome.
     */
    const { data: run, error } = await db
      .from("survey_test_runs")
      .select("outcome, fingerprint, version_id, version_label, verdict, run_at")
      .eq("test_case_id", caseId)
      .eq("survey_id", params.id)
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!run?.outcome) {
      return NextResponse.json({
        error: "This case has not been run yet, so there is no outcome to accept. Run it first.",
      }, { status: 409 });
    }
    if (run.verdict === "stale") {
      return NextResponse.json({
        error: "This case names questions the survey no longer has, so its last run tested a different respondent. Fix the case, then run it again.",
      }, { status: 409 });
    }

    const { error: upErr } = await db.from("survey_test_cases").update({
      baseline: run.outcome,
      baseline_version_id: run.version_id,
      baseline_at: new Date().toISOString(),
      baseline_by: gate.user.userId,
      updated_by: gate.user.userId,
    }).eq("id", caseId).eq("survey_id", params.id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    const { data: row } = await db.from("survey_test_cases").select("name").eq("id", caseId).maybeSingle();
    await audit({
      action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "test_case", entityId: caseId,
      detail: { summary: `accepted the current behaviour of “${row?.name ?? caseId}” as correct (${run.version_label ?? "unknown build"})` },
    });
    return NextResponse.json({ ok: true, blessedFrom: run.version_label ?? null });
  }

  return NextResponse.json({ error: `Unknown action “${action}”.` }, { status: 400 });
}
