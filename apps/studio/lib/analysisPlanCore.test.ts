import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { plannedAnalyses, type AnalysisRun, type DashboardDefinition, type DatasetSpec, type ReportDefinition } from "@rescript/analytics";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyPlan, editPlan, planPayload, planHash, type PlanDeps } from "./analysisPlanCore.ts";
import type { LoadedContext, StoredRun } from "./analytics.ts";

/*
 * THE ANALYSIS PLAN IN DATA ANALYTICS — the service, end to end against an
 * in-memory database and a stub runner: the plan is read into the payload,
 * edited through the engine's actions and the revision-guarded save, and
 * APPLIED — once creates, twice changes nothing, an edit updates in place,
 * no data configures without computing, a concurrent apply is refused, a
 * hand-edited report is kept.
 */

/* the in-memory supabase the browser test uses too — the service runs over the same fake in both */
import { FakeDb as FakeDbBase, uuid, stamp } from "../../../scripts/lib/fakeSupabase.mjs";
type Row = Record<string, unknown>;
class FakeDb extends FakeDbBase { as(): SupabaseClient { return this as unknown as SupabaseClient; } }

/* ------------------------------------------------------------ a survey with a plan */

const opts = (...labels: string[]) => labels.map((l, i) => ({ code: i + 1, label: l }));
const scale = () => opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree");
function survey(plan: boolean) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Brand choice", version: "1.0" },
    research: {
      objective: "Why consumers choose Brand A", hypotheses: ["Trust raises intent", "Country changes intent"], population: "adults",
      constructs: [{ name: "Trust", role: "independent", questionIds: ["t1"] }, { name: "Intent", role: "dependent", questionIds: ["pi"] }], analysis: [], assumptions: [], sources: [],
      ...(plan ? { analysisPlan: { source: "engine", updatedAt: "2026-10-10T00:00:00Z", crosstabs: [
        { id: "xt_1", rows: ["PURCHASE_INT"], columns: ["COUNTRY"], priority: 1, hypotheses: ["H2"], reason: "intent by country" },
        { id: "xt_2", rows: ["TRUST_1"], columns: ["GONE"], priority: 3, hypotheses: [] },
      ], tests: [
        { id: "t_1", method: "t_test", outcome: "PURCHASE_INT", variables: [], groupBy: "COUNTRY", priority: 1, hypotheses: ["H2"] },
        { id: "t_2", method: "correlation", outcome: "PURCHASE_INT", variables: ["TRUST_1"], priority: 2, hypotheses: ["H1"] },
      ], derived: [], segments: [] } } : {}),
    },
    questions: [
      { id: "country", code: "S1", variableName: "COUNTRY", type: "single_select", text: "Country", options: opts("US", "UK") },
      { id: "t1", code: "Q1", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
      { id: "pi", code: "Q2", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy?", options: scale() },
    ],
    flow: [{ type: "block", id: "b", title: "Main", children: [{ type: "page", id: "p", questionIds: ["country", "t1", "pi"] }] }, { type: "end", id: "e", status: "complete" }],
  });
}

const SURVEY = "11111111-1111-4111-8111-111111111111";
const ctxOf = (db: FakeDb): LoadedContext => { const s = db.tables.surveys[0]; return { def: SurveyDefinition.parse(s.draft_definition), version: "1.0", revision: Number(s.revision), customerId: null, versionId: null, source: "draft", draftUpdatedAt: null }; };
function setup(plan = true, completes = 120) {
  const db = new FakeDb();
  db.tables.surveys.push({ id: SURVEY, title: "Brand choice", revision: 3, draft_definition: JSON.parse(JSON.stringify(survey(plan))), current_version_id: null });
  for (let i = 0; i < completes; i++) db.tables.responses.push({ id: uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null });
  return db;
}

/** a runner that computes nothing: one run item per planned (non-excluded) item, stored like the real one */
const deps = (opts: { fail?: string[] } = {}): PlanDeps => ({
  latestRun: async (db, surveyId, environment) => {
    const rows = (db as unknown as FakeDb).tables.analytics_runs.filter((r) => r.survey_id === surveyId && (!environment || r.environment === environment)).sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
    const r = rows[0]; if (!r) return null;
    return { id: String(r.id), computedAt: String(r.computed_at), trigger: String(r.trigger), environment: r.environment as DatasetSpec["environment"], n: Number(r.n), items: r.items as never, findings: [], verdicts: r.verdicts as never, warnings: [], surveyVersion: null, dataset: r.dataset as DatasetSpec } as StoredRun;
  },
  runPlanFor: async (db, surveyId, ctx, o) => {
    const spec: DatasetSpec = { environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all" };
    const fake = db as unknown as FakeDb;
    const n = fake.tables.responses.filter((r) => r.survey_id === surveyId && r.status === "complete").length;
    const items = plannedAnalyses(ctx.def, spec).filter((p) => !o.exclude?.has(String(p.definition.options?.planned)));
    const run: AnalysisRun = {
      computedAt: stamp(), trigger: o.trigger ?? "manual", environment: spec.environment, n,
      items: items.map((p) => ({ definition: p.definition, result: { tables: [], chart: {}, tests: [], insights: [], warnings: opts.fail?.includes(String(p.definition.options?.planned)) ? ["The analysis could not be computed: boom"] : [], recommendedCharts: ["bar_vertical"], computedAt: "", definitionHash: "", variablesUsed: [] } as never, findings: [], chart: p.definition.kind === "crosstab" ? "bar_grouped" : "bar_vertical", source: p.source, priority: p.priority, hypotheses: p.hypotheses })),
      findings: [], verdicts: [{ label: "H1", text: "Trust raises intent", verdict: "untested", reason: "no test ran", findings: [], analyses: 0 }, { label: "H2", text: "Country changes intent", verdict: "untested", reason: "no test ran", findings: [], analyses: 0 }], warnings: [],
    };
    if (o.skipEmpty && n === 0) return { run, stored: null };
    const row = { id: uuid(), survey_id: surveyId, trigger: run.trigger, environment: run.environment, n, dataset: spec, computed_at: run.computedAt, items: run.items.map(({ result: _r, ...rest }) => { void _r; return rest; }), findings: [], verdicts: run.verdicts, warnings: [] };
    fake.tables.analytics_runs.push(row);
    return { run, stored: { ...run, id: String(row.id), items: row.items as never, surveyVersion: null, dataset: spec } as StoredRun };
  },
  reportFacts: async () => ({ client: "Acme" }),
});

const LIVE: DatasetSpec = { environment: "LIVE", dataset: "all" };

test("no plan: the payload says so, and apply refuses", async () => {
  const db = setup(false);
  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p.plan, null); assert.deepEqual(p.items, []); assert.equal(p.overview, null); assert.equal(p.apply, null); assert.equal(p.applyAvailable, true);
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.match(r.error!, /Nothing is planned/);
});

test("the payload reads the plan against the survey: items, states, variables, hypotheses — and the invalid item is named", async () => {
  const db = setup();
  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p.items.length, 4);
  assert.deepEqual(p.items.map((i) => i.state), ["planned", "invalid", "planned", "planned"]);
  assert.deepEqual(p.items[1].missing, ["GONE"]);
  assert.equal(p.overview!.invalid, 1); assert.equal(p.overview!.hypotheses, 2); assert.equal(p.overview!.missingVariables, 1);
  assert.deepEqual(p.hypotheses.map((h) => h.items), [["t_2"], ["xt_1", "t_1"]]);
  assert.equal(p.hypotheses[1].status, "testable");
  assert.equal(p.counts.LIVE, 120); assert.equal(p.run, null); assert.equal(p.report, null); assert.equal(p.dashboard, null);
  assert.equal(p.planHash, planHash(ctxOf(db).def.research!.analysisPlan));
});

test("apply: once creates the analyses, charts, dashboard and report; again changes nothing; the invalid item is skipped and the run excludes it", async () => {
  const db = setup();
  const r1 = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r1.ok, true, r1.error);
  const s1 = r1.summary!;
  assert.equal(s1.status, "partial", s1.message);
  assert.equal(s1.n, 120);
  assert.deepEqual(s1.items.map((i) => [i.id, i.sync, i.status]), [["xt_1", "created", "run"], ["xt_2", "skipped_invalid", "skipped"], ["t_1", "created", "run"], ["t_2", "created", "run"]]);
  assert.equal(s1.counts.created, 3); assert.equal(s1.counts.run, 3); assert.equal(s1.counts.skipped, 1);
  assert.equal(db.tables.analytics_analyses.length, 3, "one analysis per valid planned item");
  assert.ok(db.tables.analytics_analyses.every((a) => a.folder === "Planned" && (a.definition as { options: { planned: string; plannedHash: string } }).options.plannedHash));
  assert.equal(db.tables.analytics_analysis_versions.length, 3);
  assert.equal(db.tables.analytics_charts.length, 3, JSON.stringify(r1.warnings));
  assert.deepEqual(db.tables.analytics_charts.map((c) => (c.spec as { id: string }).id).sort(), ["plan:t_1", "plan:t_2", "plan:xt_1"]);
  assert.equal(db.tables.analytics_runs.length, 1);
  assert.deepEqual((db.tables.analytics_runs[0].items as { definition: { options: { planned: string } } }[]).map((i) => i.definition.options.planned), ["xt_1", "t_1", "t_2"], "the run excludes the invalid item");
  const reports = db.tables.analytics_reports;
  assert.equal(reports.length, 2);
  const dash = reports.find((r) => r.kind === "dashboard")!; const rep = reports.find((r) => r.kind === "report")!;
  const dd = dash.definition as DashboardDefinition;
  assert.equal(dd.origin?.kind, "analysis_plan");
  assert.deepEqual(dd.widgets.map((w) => w.id), ["plan:summary", "plan:xt_1", "plan:t_1", "plan:t_2"]);
  assert.ok(dd.widgets.slice(1).every((w) => w.type === "chart" && w.analysisId && w.chart?.id?.startsWith("plan:")));
  const rd = rep.definition as ReportDefinition;
  assert.equal(rd.origin?.kind, "analysis_plan"); assert.ok(rd.blocks.length > 3);
  assert.equal(r1.report?.action, "created"); assert.equal(r1.dashboard?.action, "created");
  const applies = db.tables.analytics_plan_applies;
  assert.equal(applies.length, 1); assert.equal(applies[0].status, "partial"); assert.equal(applies[0].run_id, db.tables.analytics_runs[0].id); assert.equal(applies[0].report_id, rep.id); assert.equal(applies[0].dashboard_id, dash.id);

  /* the payload now shows everything linked */
  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.deepEqual(p.items.map((i) => i.state), ["configured", "invalid", "configured", "configured"]);
  assert.ok(p.items[0].analysis && p.items[0].chart && p.items[0].run);
  assert.equal(p.apply?.current, true); assert.equal(p.apply?.status, "partial");
  assert.equal(p.report?.components.filter((c) => c.planned).length, 3);
  assert.deepEqual(p.dashboard?.components.map((c) => c.planned), [null, "xt_1", "t_1", "t_2"]);
  assert.equal(p.dataChangedSinceApply, false);

  /* again: nothing new, nothing duplicated */
  const r2 = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(r2.summary!.items.map((i) => [i.id, i.sync, i.status]), [["xt_1", "unchanged", "run"], ["xt_2", "skipped_invalid", "skipped"], ["t_1", "unchanged", "run"], ["t_2", "unchanged", "run"]]);
  assert.equal(r2.summary!.counts.created, 0); assert.equal(r2.summary!.counts.updated, 0);
  assert.equal(db.tables.analytics_analyses.length, 3); assert.equal(db.tables.analytics_charts.length, 3); assert.equal(db.tables.analytics_reports.length, 2);
  assert.equal(db.tables.analytics_analysis_versions.length, 3, "no new analysis version when nothing changed");
  assert.equal(r2.report?.action, "updated"); assert.equal(r2.dashboard?.action, "updated");
  assert.equal(db.tables.analytics_plan_applies.length, 2);
  assert.equal(db.tables.analytics_runs.length, 2, "each apply on data is a run");
});

test("edit: an action saves the draft with the revision guard and the next apply updates the analysis in place (same id, new version); a stale revision is refused", async () => {
  const db = setup();
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  const before = db.tables.analytics_analyses.find((a) => (a.definition as { options: { planned: string } }).options.planned === "xt_1")!;
  const ctx = ctxOf(db);
  const e = await editPlan(db.as(), SURVEY, ctx, { actions: [{ op: "update_crosstab", id: "xt_1", columns: ["COUNTRY", "TRUST_1"], measure: "mean" }], baseRevision: ctx.revision, userId: "u1" });
  assert.equal(e.ok, true, e.ok ? "" : e.error);
  if (!e.ok) return;
  assert.equal(e.revision, 4);
  assert.deepEqual(e.plan!.crosstabs[0].columns, ["COUNTRY", "TRUST_1"]);
  assert.equal(e.plan!.crosstabs[0].id, "xt_1", "the id survives the edit");
  /* the survey row holds the edited plan */
  assert.deepEqual((db.tables.surveys[0].draft_definition as { research: { analysisPlan: { crosstabs: { columns: string[] }[] } } }).research.analysisPlan.crosstabs[0].columns, ["COUNTRY", "TRUST_1"]);

  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p.items[0].state, "stale"); assert.equal(p.apply?.current, false, "the plan changed since the apply");
  assert.ok(p.overview!.attention.some((a) => a.id === "xt_1"));

  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.summary!.items[0].status, "run"); assert.equal(r.summary!.items[0].sync, "updated");
  assert.equal(r.summary!.counts.updated, 1);
  const after = db.tables.analytics_analyses.find((a) => (a.definition as { options: { planned: string } }).options.planned === "xt_1")!;
  assert.equal(after.id, before.id); assert.equal(after.version, 2);
  assert.deepEqual((after.definition as { columns: string[] }).columns, ["COUNTRY", "TRUST_1"]);
  assert.equal(db.tables.analytics_analyses.length, 3, "no second analysis for the edited item");
  assert.equal(db.tables.analytics_charts.length, 3);
  assert.equal((db.tables.analytics_reports.find((x) => x.kind === "dashboard")!.definition as DashboardDefinition).widgets.length, 4);
  assert.equal((await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps())).apply?.current, true);

  /* a refused action: the variable is not in the survey */
  const bad = await editPlan(db.as(), SURVEY, ctxOf(db), { actions: [{ op: "update_crosstab", id: "xt_1", rows: ["NOPE"] }], baseRevision: null, userId: "u1" });
  assert.equal(bad.ok, false); if (!bad.ok) { assert.equal(bad.status, 400); assert.match(bad.error, /NOPE/); }
  /* a non-plan action is not accepted here */
  const notPlan = await editPlan(db.as(), SURVEY, ctxOf(db), { actions: [{ op: "delete_question", target: "Q1" }], baseRevision: null, userId: "u1" });
  assert.equal(notPlan.ok, false); if (!notPlan.ok) assert.match(notPlan.error, /Only analysis-plan actions/);
  /* a stale revision: refused with 409, nothing written */
  const rev = Number(db.tables.surveys[0].revision);
  const stale = await editPlan(db.as(), SURVEY, ctxOf(db), { actions: [{ op: "remove_crosstab", id: "xt_2" }], baseRevision: rev - 1, userId: "u1" });
  assert.equal(stale.ok, false); if (!stale.ok) { assert.equal(stale.status, 409); assert.equal(stale.conflict, true); assert.equal(stale.revision, rev); }
  assert.equal(db.tables.surveys[0].revision, rev);
});

test("removing an item: the dashboard widget goes at the next apply, the saved analysis stays; adding one adds a widget", async () => {
  const db = setup();
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  const e = await editPlan(db.as(), SURVEY, ctxOf(db), { actions: [{ op: "remove_analysis_test", id: "t_2" }, { op: "add_crosstab", rows: ["TRUST_1"], columns: ["COUNTRY"], priority: 2, reason: "trust by country" }], baseRevision: null, userId: "u1" });
  assert.equal(e.ok, true, e.ok ? "" : e.error);
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true);
  assert.equal(r.summary!.counts.created, 1);
  assert.equal(db.tables.analytics_analyses.length, 4, "the removed item's analysis is not deleted");
  const dd = db.tables.analytics_reports.find((x) => x.kind === "dashboard")!.definition as DashboardDefinition;
  assert.ok(!dd.widgets.some((w) => w.id === "plan:t_2"));
  const added = e.ok ? e.plan!.crosstabs.find((x) => x.reason === "trust by country")! : null;
  assert.ok(dd.widgets.some((w) => w.id === `plan:${added!.id}`));
  assert.equal(dd.widgets.length, 4);
});

test("no data: the outputs are configured, nothing is computed, no run and no report", async () => {
  const db = setup(true, 0);
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary!.status, "no_data"); assert.match(r.summary!.message, /No complete live responses yet/);
  assert.deepEqual(r.summary!.items.map((i) => [i.sync, i.status]), [["created", "pending_data"], ["skipped_invalid", "skipped"], ["created", "pending_data"], ["created", "pending_data"]]);
  assert.equal(db.tables.analytics_analyses.length, 3); assert.equal(db.tables.analytics_runs.length, 0); assert.equal(db.tables.analytics_charts.length, 3);
  assert.equal(db.tables.analytics_reports.filter((x) => x.kind === "report").length, 0);
  const dd = db.tables.analytics_reports.find((x) => x.kind === "dashboard")!.definition as DashboardDefinition;
  assert.match(dd.widgets[0].text ?? "", /not been run/);
  assert.equal(db.tables.analytics_plan_applies[0].status, "no_data");
  /* applying again on still-no-data: unchanged, pending */
  const r2 = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.deepEqual(r2.summary!.items.map((i) => [i.sync, i.status]), [["unchanged", "pending_data"], ["skipped_invalid", "skipped"], ["unchanged", "pending_data"], ["unchanged", "pending_data"]]);
  assert.equal(db.tables.analytics_analyses.length, 3);
  /* the payload says so */
  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p.apply?.status, "no_data"); assert.equal(p.run, null); assert.equal(p.counts.LIVE, 0);
});

test("a failed computation is reported per item; a concurrent apply is refused; a hand-edited report is kept unless replaced; the lock clears", async () => {
  const db = setup();
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps({ fail: ["t_1"] }));
  assert.equal(r.summary!.status, "partial");
  assert.equal(r.summary!.items.find((i) => i.id === "t_1")!.status, "failed");
  assert.match(r.summary!.items.find((i) => i.id === "t_1")!.reason!, /could not be computed/);
  assert.equal(r.summary!.counts.failed, 1);
  assert.ok(db.tables.analytics_plan_applies.every((a) => a.status !== "running" && a.finished_at), "the lock row is finished");

  /* concurrent: a running row refuses the second apply */
  db.tables.analytics_plan_applies.push({ id: uuid(), survey_id: SURVEY, status: "running", started_at: stamp(), environment: "LIVE", dataset: LIVE });
  const busy = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(busy.ok, false); assert.equal(busy.status, 409);
  db.tables.analytics_plan_applies = db.tables.analytics_plan_applies.filter((a) => a.status !== "running");

  /* the researcher edits the report: the next apply keeps it, and says so; replaceReport regenerates it */
  const rep = db.tables.analytics_reports.find((x) => x.kind === "report")!;
  const def = rep.definition as ReportDefinition;
  rep.definition = { ...def, blocks: [...def.blocks, { id: "mine", type: "text", markdown: "My note" }] };
  const kept = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(kept.report?.action, "kept_edited");
  assert.ok((db.tables.analytics_reports.find((x) => x.kind === "report")!.definition as ReportDefinition).blocks.some((b) => b.id === "mine"));
  assert.equal((await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps())).report?.editedSinceApply, true);
  const replaced = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1", replaceReport: true }, deps());
  assert.equal(replaced.report?.action, "updated");
  assert.ok(!(db.tables.analytics_reports.find((x) => x.kind === "report")!.definition as ReportDefinition).blocks.some((b) => b.id === "mine"));
  assert.equal(db.tables.analytics_reports.filter((x) => x.kind === "report").length, 1, "never a second plan report");

  /* a dashboard the researcher rearranged keeps its arrangement */
  const dash = db.tables.analytics_reports.find((x) => x.kind === "dashboard")!;
  const dd = dash.definition as DashboardDefinition;
  dash.definition = { ...dd, widgets: dd.widgets.map((w) => (w.id === "plan:xt_1" ? { ...w, x: 6, y: 40 } : w)).concat([{ id: "mine", type: "text", text: "hello", x: 0, y: 50, w: 4, h: 2 }]) };
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  const dd2 = db.tables.analytics_reports.find((x) => x.kind === "dashboard")!.definition as DashboardDefinition;
  assert.equal(dd2.widgets.find((w) => w.id === "plan:xt_1")!.x, 6);
  assert.ok(dd2.widgets.some((w) => w.id === "mine"));
});

test("without migration 0050 the apply still produces the outputs and says the record was not kept; new completes since the run are noticed", async () => {
  const db = setup();
  delete db.tables.analytics_plan_applies;
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.applyId, null);
  assert.ok(r.warnings!.some((w) => /migration 0050/.test(w)));
  assert.equal(db.tables.analytics_analyses.length, 3);
  const p = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p.applyAvailable, false); assert.equal(p.apply, null);

  /* with the table: more data since the run is flagged */
  db.tables.analytics_plan_applies = [];
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  for (let i = 0; i < 10; i++) db.tables.responses.push({ id: uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null });
  const p2 = await planPayload(db.as(), SURVEY, ctxOf(db), LIVE, deps());
  assert.equal(p2.dataChangedSinceApply, true);
});

/* ------------------------------------------------------------ Phase 1: one path, nothing a researcher did is lost, nothing mislinked */

import { ensurePlannedAnalyses, syncPlannedAnalyses } from "./analysisPlanCore.ts";
const rowsOf = (db: FakeDb) => db.tables.analytics_analyses as Row[];
const defOf = (r: Row) => r.definition as AnalysisDefinition;
import type { AnalysisDefinition } from "@rescript/analytics";
const editPlanDef = (db: FakeDb, edit: (plan: { crosstabs: Row[]; tests: Row[] }) => void) => { const s = db.tables.surveys[0]; edit((s.draft_definition as { research: { analysisPlan: { crosstabs: Row[]; tests: Row[] } } }).research.analysisPlan); s.revision = Number(s.revision) + 1; };

test("P-13: 'create the planned analyses' and 'apply the plan' follow one path — doing both makes the analyses once and the apply finds them unchanged", async () => {
  const db = setup();
  const e = await ensurePlannedAnalyses(db.as(), SURVEY, ctxOf(db), LIVE, "u1");
  assert.equal(e.created.length, 3); assert.equal(e.planned, 4);
  assert.deepEqual(e.blocked.map((b) => b.reason.includes("GONE")), [true], "the invalid item is refused with its reason, by the same validator the apply uses");
  assert.deepEqual([...e.byPlanned.keys()].sort(), ["t_1", "t_2", "xt_1"]);
  const again = await ensurePlannedAnalyses(db.as(), SURVEY, ctxOf(db), LIVE, "u1");
  assert.equal(again.created.length, 0, "never created twice"); assert.equal(rowsOf(db).length, 3);
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.summary!.items.map((i) => i.sync), ["unchanged", "skipped_invalid", "unchanged", "unchanged"]);
  assert.equal(rowsOf(db).length, 3, "the apply made no second copy");
});

test("P-4: an analysis you built by hand is used, not duplicated — but a weighted one is not mistaken for the plan's unweighted table", async () => {
  const db = setup();
  const planned = plannedAnalyses(ctxOf(db).def, LIVE).find((p) => p.definition.options?.planned === "xt_1")!.definition;
  const { planned: _p, hypotheses: _h, ...opts } = planned.options as Record<string, unknown>; void _p; void _h;
  const mine = { id: uuid(), survey_id: SURVEY, name: "My intent by country", kind: "crosstab", version: 1, deleted_at: null, folder: null, definition: { ...planned, name: "My intent by country", options: opts } };
  db.tables.analytics_analyses.push(mine);
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.equal(rowsOf(db).length, 3, "the plan made analyses for t_1 and t_2 only; xt_1 uses yours");
  assert.equal(r.summary!.items[0].analysisId, mine.id); assert.match(r.summary!.message, /1 uses an analysis you already had/);
  /* the same table weighted is a different analysis */
  const db2 = setup();
  db2.tables.analytics_analyses.push({ ...mine, id: uuid(), definition: { ...mine.definition, weighting: { variable: "WGT" } } });
  await applyPlan(db2.as(), SURVEY, ctxOf(db2), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(rowsOf(db2).length, 4, "the plan still made its own unweighted xt_1");
});

test("P-2: applying a changed plan keeps the researcher's filter, weighting and options on the analysis", async () => {
  const db = setup();
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  const row = rowsOf(db).find((r) => defOf(r).options?.planned === "xt_1")!;
  const mineFilter = { type: "rule", source: { kind: "variable", ref: "COUNTRY" }, operator: "eq", value: 1 };
  row.definition = { ...defOf(row), filter: mineFilter, weighting: { variable: "WGT" }, options: { ...defOf(row).options, decimals: 2 } }; row.version = 2;
  editPlanDef(db, (plan) => { plan.crosstabs[0].reason = "intent by country, revised"; });
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary!.items[0].sync, "updated");
  const d = defOf(rowsOf(db).find((x) => x.id === row.id)!);
  assert.equal(d.name, "intent by country, revised"); assert.deepEqual(d.filter, mineFilter); assert.deepEqual(d.weighting, { variable: "WGT" }); assert.equal(d.options?.decimals, 2);
  assert.equal(rowsOf(db).find((x) => x.id === row.id)!.version, 3);
});

test("P-5: applying on another environment re-points the saved analyses and says so", async () => {
  const db = setup();
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.ok(rowsOf(db).every((r) => defOf(r).dataset.environment === "LIVE"));
  const TEST: DatasetSpec = { environment: "TEST", dataset: "all" };
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: TEST, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  assert.ok(rowsOf(db).every((x) => defOf(x).dataset.environment === "TEST"), "every saved analysis now reads the dataset the apply ran on");
  assert.deepEqual(r.summary!.items.map((i) => i.sync), ["repointed", "skipped_invalid", "repointed", "repointed"]);
  assert.equal(r.summary!.counts.repointed, 3); assert.match(r.summary!.message, /3 moved to test data/);
  assert.equal(rowsOf(db).length, 3);
});

test("P-1: when plan ids shift, saved analyses are re-linked to the item they were written for instead of being overwritten", async () => {
  const db = setup();
  await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  const t1 = rowsOf(db).find((r) => defOf(r).options?.planned === "t_1")!, t2 = rowsOf(db).find((r) => defOf(r).options?.planned === "t_2")!;
  assert.equal(defOf(t1).kind, "test"); assert.equal(defOf(t2).kind, "correlation");
  /* the old generator renumbered: the t-test is now t_2 and the correlation t_1 */
  editPlanDef(db, (plan) => { const [a, b] = plan.tests; a.id = "t_2"; b.id = "t_1"; });
  const out = await syncPlannedAnalyses(db.as(), SURVEY, ctxOf(db), LIVE, "u1");
  assert.equal(out.relinked, 2);
  assert.equal(defOf(rowsOf(db).find((r) => r.id === t1.id)!).kind, "test", "the t-test analysis is still a t-test");
  assert.equal(defOf(rowsOf(db).find((r) => r.id === t1.id)!).options?.planned, "t_2");
  assert.equal(defOf(rowsOf(db).find((r) => r.id === t2.id)!).kind, "correlation");
  assert.equal(defOf(rowsOf(db).find((r) => r.id === t2.id)!).options?.planned, "t_1");
  assert.deepEqual([...out.results.values()].map((r) => r.sync), ["unchanged", "skipped_invalid", "unchanged", "unchanged"]);
  assert.equal(rowsOf(db).length, 3);
});

test("P-13: a planned chi-square next to the crosstab that reports it is still its own analysis (it carries its hypothesis); an exact repeat shares one", async () => {
  const db = setup();
  editPlanDef(db, (plan) => {
    plan.crosstabs.push({ id: "xt_9", rows: ["PURCHASE_INT"], columns: ["COUNTRY"], priority: 3, hypotheses: [], reason: "same table again" });
    plan.tests.push({ id: "t_9", method: "chi_square", outcome: "PURCHASE_INT", variables: ["COUNTRY"], priority: 2, hypotheses: ["H2"] });
  });
  const r = await applyPlan(db.as(), SURVEY, ctxOf(db), { dataset: LIVE, userId: "u1" }, deps());
  assert.equal(r.ok, true, r.error);
  const by = new Map(r.summary!.items.map((i) => [i.id, i]));
  assert.equal(by.get("t_9")!.sync, "created", "the chi-square is not dropped for being in the crosstab: its hypothesis needs it");
  assert.equal(by.get("xt_9")!.sync, "unchanged"); assert.equal(by.get("xt_9")!.analysisId, by.get("xt_1")!.analysisId, "an exact repeat of xt_1 shares its analysis");
  assert.equal(rowsOf(db).length, 4);
});
