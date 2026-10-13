import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset, spec } from "./analyses/fixture.js";
import { variableMetadata } from "./dataset.js";
import { runPlan, compactRun } from "./findings.js";
import {
  planItemViews, planVariableViews, planOverview, planAnalysisSync, mergePlanUpdate, planRelinks, relinkedDefinition, planChartSync, planChartSpec, planDashboard, plannedHash, stampedDefinition, summarizeApply, withOrigin, editedSinceApply,
  type SavedAnalysisRow, type SavedChartRow,
} from "./planWorkspace.js";
import type { DashboardDefinition } from "./types.js";

/*
 * THE ANALYSIS PLAN IN DATA ANALYTICS: the plan read into item views against
 * the dictionary, the saved analyses, the charts and the latest run; the
 * apply's decisions, which must be the same the second time; and the
 * dashboard the apply maintains without disturbing the researcher's own.
 */

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction", hypotheses: ["Region affects satisfaction", "Awareness of Alpha raises consideration"], population: "adults",
    constructs: [
      { name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] },
      { name: "Region", role: "independent", questionIds: ["q_region"] },
    ],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [
        { id: "x1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by profile" },
        { id: "x2", rows: ["CONSIDER"], columns: ["AWARE"], priority: 2, hypotheses: ["H2"] },
        { id: "x3", rows: ["SAT"], columns: ["GONE_VAR"], priority: 3, hypotheses: [] },
      ],
      tests: [
        { id: "t1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"], reason: "satisfaction across regions" },
        { id: "t2", method: "t_test", outcome: "SAT", variables: [], groupBy: "GENDER", priority: 2, hypotheses: [] },
      ],
      derived: [{ name: "SAT_TOP", kind: "top_box", from: ["SAT"] }], segments: [],
    },
  } as never;
  return def;
}

test("item views: every planned item, its variables, what is missing, and its state against the saved analyses", () => {
  const def = planned();
  const dictionary = variableMetadata(def);
  const views = planItemViews(def, spec, { dictionary, analyses: [], charts: [] });
  assert.deepEqual(views.map((v) => v.id), ["x1", "x2", "x3", "t1", "t2"]);
  const x1 = views.find((v) => v.id === "x1")!;
  assert.equal(x1.kind, "crosstab"); assert.deepEqual(x1.variables, ["SAT", "GENDER", "REGION"]); assert.equal(x1.state, "planned"); assert.deepEqual(x1.missing, []);
  assert.equal(x1.derived.options?.planned, "x1"); assert.equal(x1.title, "satisfaction by profile");
  const x3 = views.find((v) => v.id === "x3")!;
  assert.equal(x3.state, "invalid"); assert.deepEqual(x3.missing, ["GONE_VAR"]);
  assert.match(x3.issues[0].message, /GONE_VAR/);
  const t1 = views.find((v) => v.id === "t1")!;
  assert.equal(t1.method, "anova"); assert.deepEqual(t1.variables, ["SAT", "REGION"]); assert.equal(t1.derived.kind, "test");

  /* the variables: what reads each, and the one that is gone */
  const vars = planVariableViews(def, views, dictionary);
  const gone = vars.find((v) => v.name === "GONE_VAR")!;
  assert.equal(gone.kind, "missing"); assert.deepEqual(gone.crosstabs, ["x3"]); assert.ok(gone.warnings.length);
  const sat = vars.find((v) => v.name === "SAT")!;
  assert.equal(sat.kind, "question"); assert.equal(sat.questionCode, "Q4"); assert.deepEqual(sat.crosstabs, ["x1", "x3"]); assert.deepEqual(sat.tests, ["t1", "t2"]); assert.ok(sat.hypotheses.includes("H1"));
  assert.ok(sat.categories && sat.categories.length >= 2);
  assert.equal(vars[0].kind, "missing", "the missing variable is listed first");

  const ov = planOverview(def, views, vars);
  assert.equal(ov.crosstabs, 3); assert.equal(ov.tests, 2); assert.equal(ov.derived, 1); assert.equal(ov.hypotheses, 2);
  assert.equal(ov.invalid, 1); assert.equal(ov.configured, 0); assert.equal(ov.missingVariables, 1);
  assert.deepEqual(ov.attention.map((a) => a.id), ["x3"]);
});

test("the apply is idempotent: the first apply creates, the second finds everything unchanged; a changed plan item updates its analysis in place; a refinement is kept", () => {
  const def = planned();
  const dictionary = variableMetadata(def);
  const views = planItemViews(def, spec, { dictionary, analyses: [], charts: [] });
  const sync1 = planAnalysisSync(views, spec, "1.0");
  assert.deepEqual(sync1.map((s) => s.kind), ["create", "create", "skip", "create", "create"]);
  const created: SavedAnalysisRow[] = sync1.flatMap((s, i) => (s.kind === "create" ? [{ id: `a${i}`, name: s.definition.name, kind: s.definition.kind, version: 1, definition: s.definition }] : []));
  assert.equal(created[0].definition.options?.plannedHash, plannedHash(views[0].derived));

  /* the same plan again: every saved analysis matches, nothing to create or update */
  const views2 = planItemViews(def, spec, { dictionary, analyses: created, charts: [] });
  assert.deepEqual(views2.filter((v) => v.state !== "invalid").map((v) => v.state), ["configured", "configured", "configured", "configured"]);
  assert.deepEqual(planAnalysisSync(views2, spec, "1.0").map((s) => s.kind), ["keep", "keep", "skip", "keep", "keep"]);

  /* the plan changes: x1 gets another column → stale → updated from the plan, same analysis id */
  const def2 = structuredClone(def);
  def2.research!.analysisPlan!.crosstabs[0].columns = ["REGION"];
  const views3 = planItemViews(def2, spec, { dictionary, analyses: created, charts: [] });
  assert.equal(views3[0].state, "stale");
  const sync3 = planAnalysisSync(views3, spec, "1.0");
  assert.equal(sync3[0].kind, "update");
  assert.equal((sync3[0] as { analysisId: string }).analysisId, created[0].id);
  assert.deepEqual((sync3[0] as { definition: { columns?: string[] } }).definition.columns, ["REGION"]);
  assert.ok(planOverview(def2, views3, planVariableViews(def2, views3, dictionary)).attention.some((a) => a.id === "x1"));

  /* the researcher refines a saved analysis (plan unchanged): kept, and reported as refined */
  const refined = structuredClone(created);
  refined[1].definition = { ...refined[1].definition, measure: "pct_row" };
  refined[1].version = 2;
  const views4 = planItemViews(def, spec, { dictionary, analyses: refined, charts: [] });
  assert.equal(views4[1].state, "refined");
  const sync4 = planAnalysisSync(views4, spec, "1.0");
  assert.equal(sync4[1].kind, "keep"); assert.equal((sync4[1] as { refined: boolean }).refined, true);

  /* an analysis saved before hashes existed, and edited, is a refinement too — never overwritten by the first apply */
  const legacy = structuredClone(created);
  const { plannedHash: _h, ...opts } = legacy[0].definition.options as Record<string, unknown>; void _h;
  legacy[0].definition = { ...legacy[0].definition, options: opts, measure: "count" };
  const views5 = planItemViews(def, spec, { dictionary, analyses: legacy, charts: [] });
  assert.equal(views5[0].state, "refined");
  /* …and one saved before hashes that still matches the plan is simply configured */
  const legacySame = structuredClone(created);
  legacySame[0].definition = { ...legacySame[0].definition, options: opts };
  assert.equal(planItemViews(def, spec, { dictionary, analyses: legacySame, charts: [] })[0].state, "configured");

  /* the stamped definition carries the dataset the apply chose and the survey version */
  const st = stampedDefinition(views[0], { environment: "TEST", dataset: "clean" }, "2.0");
  assert.equal(st.dataset.environment, "TEST"); assert.equal(st.surveyVersion, "2.0"); assert.equal(st.options?.planned, "x1");
});

test("charts: one per planned item typed as the run recommends, created once, retyped only while never customised; the run's findings reach the item view", () => {
  const def = planned();
  def.research!.analysisPlan!.crosstabs.splice(2, 1); // drop the invalid one so the run is clean
  const dictionary = variableMetadata(def);
  const views = planItemViews(def, spec, { dictionary, analyses: [], charts: [] });
  const analyses: SavedAnalysisRow[] = planAnalysisSync(views, spec, "1.0").flatMap((s, i) => (s.kind === "create" ? [{ id: `a${i}`, name: s.definition.name, kind: s.definition.kind, version: 1, definition: s.definition }] : []));
  const ds = synthDataset(300);
  const run = runPlan(def, ds, { trigger: "apply", discover: false });
  const idFor = (planned: string) => analyses.find((a) => a.definition.options?.planned === planned)?.id;
  const sync = planChartSync(views, idFor, [], run.items);
  assert.equal(sync.length, 4);
  assert.ok(sync.every((c) => c.action === "create"));
  const charts: SavedChartRow[] = sync.map((c, i) => ({ id: `c${i}`, analysis_id: c.analysisId, name: c.item.title, spec: planChartSpec(c.item, c.type), style_version: 1 }));
  assert.equal(charts[0].spec.id, "plan:x1");
  /* again: nothing to create */
  const again = planChartSync(views, idFor, charts, run.items);
  assert.ok(again.every((c) => c.action === "keep"), JSON.stringify(again.map((c) => c.action)));
  /* a chart the researcher restyled is never retyped; one never touched follows the run's recommendation */
  const other = charts.map((c) => ({ ...c, spec: { ...c.spec, type: "pie" as const } }));
  const retyped = planChartSync(views, idFor, other, run.items);
  assert.ok(retyped.every((c) => c.action === "retype"));
  const customised = other.map((c) => ({ ...c, style_version: 3 }));
  assert.ok(planChartSync(views, idFor, customised, run.items).every((c) => c.action === "keep"));

  /* the stored (compact) run links back to the items by planned id */
  const stored = { ...compactRun(run), id: "run1" };
  const withRun = planItemViews(def, spec, { dictionary, analyses, charts, run: stored });
  assert.ok(withRun.every((v) => v.run), "every item has its run");
  assert.ok(withRun.every((v) => v.chart && v.chart.id.startsWith("c")));
  assert.equal(planOverview(def, withRun, planVariableViews(def, withRun, dictionary)).run, 4);
  assert.equal(planOverview(def, withRun, planVariableViews(def, withRun, dictionary)).charts, 4);
});

test("the dashboard: plan widgets added once, kept where the researcher put them, removed when the item leaves the plan; other widgets untouched", () => {
  const def = planned();
  def.research!.analysisPlan!.crosstabs.splice(2, 1);
  const dictionary = variableMetadata(def);
  const views = planItemViews(def, spec, { dictionary, analyses: [], charts: [] });
  const idFor = (p: string) => `analysis-${p}`;
  const specFor = (p: string) => { const v = views.find((x) => x.id === p); return v ? planChartSpec(v, "bar_vertical") : undefined; };
  const d1 = planDashboard(null, "Plan dashboard", views, { analysisIdFor: idFor, chartSpecFor: specFor, run: null });
  assert.equal(d1.title, "Plan dashboard");
  assert.equal(d1.widgets[0].id, "plan:summary"); assert.match(d1.widgets[0].text ?? "", /not been run/);
  assert.deepEqual(d1.widgets.slice(1).map((w) => w.id), ["plan:x1", "plan:t1", "plan:x2", "plan:t2"], "hypothesis-linked first, then by priority");
  assert.ok(d1.widgets.every((w) => w.w <= 12 && w.x + w.w <= 12));
  /* no overlaps */
  const boxes = d1.widgets.map((w) => [w.x, w.y, w.w, w.h]);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const [ax, ay, aw, ah] = boxes[i], [bx, by, bw, bh] = boxes[j]; assert.ok(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay, `widgets ${i} and ${j} overlap`); }

  /* the researcher drags x1 and adds a KPI; applying again keeps both and changes nothing else */
  const edited: DashboardDefinition = { ...d1, widgets: d1.widgets.map((w) => (w.id === "plan:x1" ? { ...w, x: 6, y: 20 } : w)).concat([{ id: "mine", type: "kpi", analysisId: "k", x: 0, y: 30, w: 3, h: 2 }]) };
  const d2 = planDashboard(edited, "ignored", views, { analysisIdFor: idFor, chartSpecFor: specFor, run: null });
  assert.equal(d2.widgets.length, edited.widgets.length);
  assert.deepEqual(d2.widgets.find((w) => w.id === "plan:x1")!.x, 6);
  assert.ok(d2.widgets.some((w) => w.id === "mine"));
  assert.equal(d2.title, "Plan dashboard");

  /* an item leaves the plan: its widget goes; a new one arrives: a widget is added in a free slot */
  const def2 = structuredClone(def);
  def2.research!.analysisPlan!.tests = def2.research!.analysisPlan!.tests.filter((t) => t.id !== "t2");
  def2.research!.analysisPlan!.crosstabs.push({ id: "x9", rows: ["AWARE"], columns: ["GENDER"], priority: 2, hypotheses: [] });
  const views2 = planItemViews(def2, spec, { dictionary, analyses: [], charts: [] });
  const d3 = planDashboard(d2, "x", views2, { analysisIdFor: idFor, chartSpecFor: (p) => { const v = views2.find((x) => x.id === p); return v ? planChartSpec(v, "bar_vertical") : undefined; }, run: null });
  assert.ok(!d3.widgets.some((w) => w.id === "plan:t2"));
  assert.ok(d3.widgets.some((w) => w.id === "plan:x9"));
  assert.ok(d3.widgets.some((w) => w.id === "mine"));

  /* the origin stamp says whether the researcher edited the output since the apply */
  const stamped = withOrigin(d3, { kind: "analysis_plan", appliedAt: "2026-10-12T00:00:00Z", runId: null });
  assert.equal(editedSinceApply(stamped), false);
  assert.equal(editedSinceApply({ ...stamped, widgets: stamped.widgets.slice(1) }), true);
});

test("the apply summary distinguishes configured, applied and computed", () => {
  const items = [
    { id: "x1", title: "a", sync: "created" as const, status: "run" as const }, { id: "x2", title: "b", sync: "updated" as const, status: "run" as const }, { id: "x3", title: "c", sync: "skipped_invalid" as const, status: "skipped" as const, reason: "gone" },
    { id: "t1", title: "d", sync: "unchanged" as const, status: "failed" as const, reason: "boom" },
  ];
  const partial = summarizeApply("LIVE", 120, items, { charts: 2, planned: 4 });
  assert.equal(partial.status, "partial"); assert.equal(partial.counts.skipped, 1); assert.equal(partial.counts.failed, 1); assert.equal(partial.counts.created, 1); assert.equal(partial.counts.updated, 1); assert.match(partial.message, /1 created, 1 updated from the plan, 1 skipped \(invalid\), 1 failed to compute\. 2 run on 120 completes, 2 charts/);
  const noData = summarizeApply("LIVE", 0, [{ id: "x1", title: "a", sync: "created", status: "pending_data" }, { id: "x2", title: "b", sync: "unchanged", status: "pending_data" }], { charts: 0, planned: 2 });
  assert.equal(noData.status, "no_data"); assert.match(noData.message, /No complete live responses yet/);
  assert.equal(summarizeApply("TEST", 10, [], { charts: 0, planned: 0 }).status, "nothing_planned");
  assert.equal(summarizeApply("ALL", 50, [{ id: "x1", title: "a", sync: "unchanged", status: "run" }], { charts: 1, planned: 1 }).status, "applied");
});


/* ------------------------------------------------------------ P-2, P-5, P-1 */

function savedFrom(def: ReturnType<typeof planned>, dataset = spec) {
  const dictionary = variableMetadata(def);
  const views = planItemViews(def, dataset, { dictionary, analyses: [], charts: [] });
  const rows: SavedAnalysisRow[] = planAnalysisSync(views, dataset, "1.0").flatMap((s, i) => (s.kind === "create" ? [{ id: `a${i}`, name: s.definition.name, kind: s.definition.kind, version: 1, definition: s.definition }] : []));
  return { dictionary, rows };
}

test("P-2: applying a changed plan updates what the plan owns and keeps the researcher's filter, weighting and options", () => {
  const def = planned();
  const { dictionary, rows } = savedFrom(def);
  const mine = { type: "rule", source: { kind: "variable", ref: "REGION" }, operator: "eq", value: 1 } as never;
  rows[0].definition = { ...rows[0].definition, filter: mine, filterIds: ["f1"], weighting: { variable: "WGT" }, layers: ["REGION"], options: { ...rows[0].definition.options, decimals: 2, confidence: 0.9 } };
  rows[0].version = 2;
  /* the plan moves: x1's reason (and so its name) and its measure are edited */
  const def2 = structuredClone(def);
  Object.assign(def2.research!.analysisPlan!.crosstabs[0], { reason: "satisfaction by profile, revised", measure: "count" });
  const views = planItemViews(def2, spec, { dictionary, analyses: rows, charts: [] });
  assert.equal(views[0].state, "stale");
  const s = planAnalysisSync(views, spec, "1.0", rows)[0];
  assert.equal(s.kind, "update");
  const d = (s as { definition: ReturnType<typeof stampedDefinition> }).definition;
  assert.equal(d.name, "satisfaction by profile, revised"); assert.equal(d.measure, "count", "the plan's change is applied");
  assert.deepEqual(d.filter, mine); assert.deepEqual(d.filterIds, ["f1"]); assert.deepEqual(d.weighting, { variable: "WGT" }); assert.deepEqual(d.layers, ["REGION"]);
  assert.equal(d.options?.decimals, 2); assert.equal(d.options?.confidence, 0.9);
  assert.equal(d.options?.planned, "x1"); assert.equal(d.options?.plannedHash, views[0].hash, "stamped as written from the plan as it is now");
  assert.match((s as { summary: string }).summary, /filter, weighting and other refinements were kept/);
  /* and an option the plan stopped setting goes with it */
  const merged = mergePlanUpdate({ ...rows[0].definition, options: { ...rows[0].definition.options, hypotheses: ["H1"], moderation: true } }, { ...rows[0].definition, options: { planned: "x1" } });
  assert.equal(merged.options?.hypotheses, undefined); assert.equal(merged.options?.moderation, undefined); assert.equal(merged.options?.decimals, 2);
});

test("P-5: an analysis saved on LIVE is re-pointed when the apply runs on TEST — also a refined one, keeping its refinement — and the apply says so", () => {
  const def = planned();
  const { dictionary, rows } = savedFrom(def, spec);
  rows[1].definition = { ...rows[1].definition, measure: "pct_row" }; rows[1].version = 2;
  const test = { environment: "TEST" as const, dataset: "all" as const };
  const views = planItemViews(def, test, { dictionary, analyses: rows, charts: [] });
  const sync = planAnalysisSync(views, test, "1.0", rows);
  const live = sync.filter((s) => s.kind !== "skip");
  assert.ok(live.every((s) => s.kind === "update"), "every saved analysis moves");
  const x2 = sync[1] as { definition: { dataset: { environment: string }; measure?: string }; repointedFrom?: { environment: string }; summary: string };
  assert.equal(x2.definition.dataset.environment, "TEST"); assert.equal(x2.repointedFrom?.environment, "LIVE");
  assert.equal(x2.definition.measure, "pct_row", "the researcher's refinement is kept");
  assert.match(x2.summary, /Re-pointed from LIVE to TEST/);
  /* on the dataset it already reads, nothing happens */
  assert.deepEqual(planAnalysisSync(planItemViews(def, spec, { dictionary, analyses: rows, charts: [] }), spec, "1.0", rows).map((s) => s.kind), ["keep", "keep", "skip", "keep", "keep"]);
  const sum = summarizeApply("TEST", 10, [{ id: "x1", title: "t", sync: "repointed", status: "run" }], { charts: 0, planned: 1 });
  assert.match(sum.message, /1 moved to test data/); assert.equal(sum.counts.repointed, 1);
});

test("P-1: an analysis whose plan id now names another item is re-linked to the item it was written for, not overwritten with the other item's definition", () => {
  const def = planned();
  const { dictionary, rows } = savedFrom(def);   // a0: x1 (SAT by profile), a1: x2 (CONSIDER by AWARE), a3: t1, a4: t2
  /* the ids shift, as counters did when the survey grew: x1 and x2 swap */
  const shifted = structuredClone(def);
  const [c1, c2] = shifted.research!.analysisPlan!.crosstabs;
  const id1 = c1.id; c1.id = c2.id; c2.id = id1;
  const views = planItemViews(shifted, spec, { dictionary, analyses: rows, charts: [] });
  /* what used to be silently overwritten with the other item's definition */
  const before = planAnalysisSync(views, spec, "1.0", rows);
  assert.equal(before[0].kind, "update"); assert.equal((before[0] as { analysisId: string }).analysisId, "a1"); assert.deepEqual((before[0] as { definition: { rows?: string[] } }).definition.rows, ["SAT"], "(the old behaviour this fixes: a1's CONSIDER table replaced by SAT)");
  const links = planRelinks(views, rows);
  assert.deepEqual(links.map((l) => [l.analysisId, l.from, l.to]).sort(), [["a0", "x1", "x2"], ["a1", "x2", "x1"]]);
  /* after the relink every analysis matches its item and nothing needs updating */
  const fixed = rows.map((r) => { const l = links.find((x) => x.analysisId === r.id); const to = l ? views.find((v) => v.id === l.to)! : null; return to ? { ...r, definition: relinkedDefinition(r.definition, { id: to.id, hash: to.hash }) } : r; });
  const views2 = planItemViews(shifted, spec, { dictionary, analyses: fixed, charts: [] });
  assert.deepEqual(views2.filter((v) => v.state !== "invalid").map((v) => v.state), ["configured", "configured", "configured", "configured"]);
  assert.deepEqual(planAnalysisSync(views2, spec, "1.0", fixed).map((s) => s.kind), ["keep", "keep", "skip", "keep", "keep"]);

  /* an analysis that matches no item at all is not re-linked: the plan was edited, and the ordinary update applies */
  const odd = structuredClone(rows); odd[0].definition = { ...odd[0].definition, rows: ["AGE"], columns: ["GENDER"], variables: ["AGE", "GENDER"] };
  assert.deepEqual(planRelinks(planItemViews(def, spec, { dictionary, analyses: odd, charts: [] }), odd), []);
  /* an unshifted plan has nothing to relink */
  assert.deepEqual(planRelinks(planItemViews(def, spec, { dictionary, analyses: rows, charts: [] }), rows), []);
});
