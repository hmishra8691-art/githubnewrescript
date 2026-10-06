import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset, spec } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { plannedAnalyses, testDefinition, crosstabDefinition } from "./planBridge.js";

/*
 * THE PLAN RUNS. What the engine planned before fieldwork becomes the
 * analyses this package executes — on real (synthetic) data, through the
 * same runAnalysis as a hand-built analysis.
 */

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction", hypotheses: ["Region affects satisfaction", "Awareness of Alpha raises consideration"], population: "adults",
    constructs: [
      { name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] },
      { name: "Region", role: "independent", questionIds: ["q_region"] },
      { name: "Awareness of Alpha", role: "independent", questionIds: ["q_brands"] },
      { name: "Consideration", role: "dependent", questionIds: ["q_consider"] },
    ],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by profile" }, { id: "x2", rows: ["CONSIDER"], columns: ["AWARE"], priority: 2, hypotheses: ["H2"] }],
      tests: [
        { id: "t1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"], reason: "satisfaction across regions" },
        { id: "t2", method: "t_test", outcome: "SAT", variables: [], groupBy: "GENDER", priority: 2, hypotheses: [] },
        { id: "t3", method: "chi_square", outcome: "CONSIDER", variables: ["AWARE"], priority: 1, hypotheses: ["H2"] },
        { id: "t4", method: "regression", outcome: "SAT", variables: ["AGE"], moderator: "NPS", priority: 1, hypotheses: [] },
        { id: "t5", method: "correlation", outcome: "SAT", variables: ["NPS", "AGE"], priority: 2, hypotheses: [] },
        { id: "t6", method: "maxdiff_scores", variables: ["MD"], priority: 1, hypotheses: [] },
        { id: "t7", method: "nps", variables: ["NPS"], priority: 1, hypotheses: [] },
        { id: "t8", method: "top_box", outcome: "SAT", variables: [], priority: 2, hypotheses: [] },
      ],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

test("every planned item becomes a definition the runners accept, in the order each runner expects", () => {
  const def = planned();
  const items = plannedAnalyses(def, spec);
  assert.equal(items.length, 10);
  assert.equal(items[0].source.kind, "crosstab", "hypothesis-linked first");
  assert.ok(items.slice(0, 4).every((i) => i.hypotheses.length) && !items[4].hypotheses.length, "the hypothesis-linked ones lead");
  const x1 = items.find((i) => i.source.kind === "crosstab" && i.source.id === "x1")!.definition;
  assert.equal(x1.kind, "crosstab"); assert.deepEqual(x1.rows, ["SAT"]); assert.deepEqual(x1.columns, ["GENDER", "REGION"]);
  assert.equal(x1.options?.layout, "banner"); assert.equal(x1.options?.planned, "x1"); assert.deepEqual(x1.options?.hypotheses, ["H1"]);
  assert.equal(x1.name, "satisfaction by profile");
  const t1 = items.find((i) => i.source.kind === "test" && i.source.id === "t1")!.definition;
  assert.equal(t1.kind, "test"); assert.deepEqual(t1.variables, ["SAT", "REGION"]); assert.equal(t1.options?.test, "anova_one_way");
  const t3 = items.find((i) => i.source.kind === "test" && i.source.id === "t3")!.definition;
  assert.deepEqual(t3.variables, ["CONSIDER", "AWARE"]); assert.equal(t3.options?.test, "chi_square");
  const t4 = items.find((i) => i.source.kind === "test" && i.source.id === "t4")!.definition;
  assert.equal(t4.kind, "regression"); assert.deepEqual(t4.variables, ["SAT", "AGE", "NPS"]); assert.equal(t4.options?.moderation, true); assert.deepEqual(t4.options?.interactions, [["AGE", "NPS"]]);
  const t8 = items.find((i) => i.source.kind === "test" && i.source.id === "t8")!.definition;
  assert.equal(t8.kind, "topbox"); assert.deepEqual(t8.variables, ["SAT"]); assert.equal(t8.options?.primaryBox, 2);
  assert.equal(items.find((i) => i.source.kind === "test" && i.source.id === "t6")!.definition.kind, "maxdiff");
  /* a mediation test routes outcome, predictor, mediator */
  const med = testDefinition({ id: "m", method: "regression", outcome: "SAT", variables: ["AGE"], mediator: "NPS", priority: 1, hypotheses: [] }, spec);
  assert.deepEqual(med.variables, ["SAT", "AGE", "NPS"]); assert.equal(med.options?.model, "mediation");
  const logit = testDefinition({ id: "l", method: "logistic_regression", outcome: "GENDER", variables: ["AGE"], priority: 1, hypotheses: [] }, spec);
  assert.equal(logit.options?.model, "logistic");
  assert.equal(crosstabDefinition({ id: "c", rows: ["SAT"], columns: ["GENDER"], priority: 2, hypotheses: [] }, spec, def).name, "Q4 by Q1");
});

test("the planned analyses run on data and produce results, not warnings about their shape", () => {
  const def = planned();
  const ds = synthDataset(300);
  const items = plannedAnalyses(def, spec);
  for (const it of items) {
    const r = runAnalysis(it.definition, ds);
    const shape = r.warnings.filter((w) => /needs|Unknown analysis|could not be computed/.test(w));
    assert.deepEqual(shape, [], `${it.definition.name}: ${shape.join(" | ")}`);
    assert.ok(r.tables.length > 0 || r.tests.length > 0 || (r.chart.kpis?.length ?? 0) > 0, `${it.definition.name} produced nothing`);
  }
  const anova = runAnalysis(items.find((i) => i.source.kind === "test" && i.source.id === "t1")!.definition, ds);
  assert.equal(anova.tests[0]?.test, "anova_one_way");
  const chi = runAnalysis(items.find((i) => i.source.kind === "test" && i.source.id === "t3")!.definition, ds);
  assert.equal(chi.tests[0]?.test, "chi_square");
});

test("primary analyses per question come from the inferred framework, outcomes first, screening left out", () => {
  const def = planned();
  const items = plannedAnalyses(def, spec, { primaries: true }).filter((i) => i.source.kind === "primary");
  const sat = items.find((i) => i.source.kind === "primary" && i.source.questionId === "q_sat")!;
  assert.equal(sat.definition.kind, "descriptive");
  assert.equal(sat.priority, 1);
  assert.deepEqual(sat.hypotheses, ["H1"], "“Region affects satisfaction” names its construct");
  assert.ok(items.some((i) => i.definition.kind === "nps" && i.definition.variables[0] === "NPS"));
  assert.ok(!items.some((i) => i.source.kind === "primary" && i.source.questionId === "q_text") || items.find((i) => i.source.kind === "primary" && i.source.questionId === "q_text")!.definition.kind === "text");
  /* a screener profiles who was turned away, not the study: no primary analysis for it */
  const screened = structuredClone(base);
  screened.questions[0] = { ...screened.questions[0], skipLogic: [{ id: "sk", when: { type: "rule", source: { kind: "question", ref: "GENDER" }, operator: "eq", value: 2 }, target: { kind: "terminate", status: "screened" } }] } as never;
  const sp = plannedAnalyses(screened, spec, { primaries: true }).filter((i) => i.source.kind === "primary");
  assert.ok(!sp.some((i) => i.source.kind === "primary" && i.source.questionId === "q_gender"), "the screening question is left out");
  assert.ok(sp.some((i) => i.source.kind === "primary" && i.source.questionId === "q_region"), "the others stay");
  /* without a stored plan the engine's framework is used */
  const bare = structuredClone(base);
  assert.ok(plannedAnalyses(bare, spec).length >= 1);
});

/* ------------------------------------------------------------ Phase 6: the plan's own variables */

import { withPlannedVariables } from "./plannedVariables.js";
import { runPlan } from "./findings.js";

test("derived variables are computed as columns before the plan runs — and a planned test that names one runs on it", () => {
  const def = structuredClone(base);
  def.research = { objective: "x", hypotheses: ["Women have a higher item score than men"], population: "adults", constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT_T2B"], columns: ["GENDER"], priority: 1, hypotheses: [] }],
      tests: [
        { id: "t1", method: "t_test", outcome: "ITEMS_SCORE", variables: [], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
        { id: "t2", method: "chi_square", outcome: "SAT_T2B", variables: ["GENDER"], priority: 1, hypotheses: [] },
      ],
      derived: [
        { name: "SAT_T2B", kind: "top_box", from: ["SAT"] },
        { name: "SAT_B2B", kind: "bottom_box", from: ["SAT"] },
        { name: "ITEMS_SCORE", kind: "mean_score", from: ["ITEMS"] },
        { name: "ITEMS_SUM", kind: "sum_score", from: ["ITEMS_a", "ITEMS_b"] },
        { name: "AWARE_N", kind: "count", from: ["AWARE"] },
        { name: "AWARE_ANY", kind: "flag", from: ["AWARE_3", "CONSIDER_3"] },
        { name: "SAT_X2", kind: "index", from: ["SAT"], expression: "SAT * 2" },
        { name: "SAT_HI", kind: "recode", from: ["SAT"], expression: "if(SAT >= 4, 1, 0)" },
        { name: "NO_RULE", kind: "recode", from: ["SAT"] },
      ],
      segments: [],
    },
  } as never;
  const ds = synthDataset(300);
  const p = withPlannedVariables(def, ds);
  assert.deepEqual(p.computed, ["SAT_T2B", "SAT_B2B", "ITEMS_SCORE", "ITEMS_SUM", "AWARE_N", "AWARE_ANY", "SAT_X2", "SAT_HI"]);
  assert.deepEqual(p.warnings, ["NO_RULE: not computed — needs an expression the runner evaluates (a recode has no rule of its own)."]);
  assert.ok(!ds.byName.has("SAT_T2B") && !("SAT_T2B" in ds.cases[0].vars), "the caller's dataset is untouched");
  for (const c of p.dataset.cases) {
    const sat = Number(c.vars.SAT), items = ["ITEMS_a", "ITEMS_b", "ITEMS_c"].map((k) => Number(c.vars[k]));
    assert.equal(c.vars.SAT_T2B, sat >= 4 ? 1 : 0, "top-2 of a 1–5 scale is 4 and 5");
    assert.equal(c.vars.SAT_B2B, sat <= 2 ? 1 : 0);
    assert.ok(Math.abs(Number(c.vars.ITEMS_SCORE) - items.reduce((t, x) => t + x, 0) / 3) < 1e-9, "the matrix named by its question is its rows");
    assert.equal(c.vars.ITEMS_SUM, items[0] + items[1]);
    assert.equal(c.vars.AWARE_N, (c.vars.AWARE as unknown[]).length);
    assert.equal(c.vars.AWARE_ANY, Number(c.vars.AWARE_3) === 1 || Number(c.vars.CONSIDER_3) === 1 ? 1 : 0);
    assert.equal(c.vars.SAT_X2, sat * 2);
    assert.equal(c.vars.SAT_HI, sat >= 4 ? 1 : 0);
  }
  assert.equal(p.dataset.byName.get("SAT_T2B")!.role, "categorical");
  assert.deepEqual(p.dataset.byName.get("SAT_T2B")!.categories!.map((c) => c.label), ["Not top 2", "Top 2 box"]);
  assert.equal(p.dataset.byName.get("ITEMS_SCORE")!.role, "scale");
  /* the run: the planned test of the derived score runs on the column, and finds the planted gender gap */
  const run = runPlan(def, ds);
  const t1 = run.items.find((it) => it.definition.options?.planned === "t1")!;
  assert.deepEqual(t1.definition.variables, ["ITEMS_SCORE", "GENDER"]);
  assert.ok(!t1.result.warnings.some((w) => /needs|not found|no data/i.test(w)), t1.result.warnings.join(" | "));
  assert.match(t1.result.tests[0]?.test ?? "", /^t_(?:independent|welch)$/);
  assert.ok(t1.findings[0].significant, t1.findings[0].headline);
  const x1 = run.items.find((it) => it.definition.options?.planned === "x1")!;
  assert.ok(x1.result.tables.length > 0 && x1.result.tests.length > 0, "the crosstab of a derived flag runs");
  assert.ok(run.warnings.includes(p.warnings[0]), "what could not be computed is a caveat of the run");
  assert.equal(run.verdicts[0].verdict, "supported", run.verdicts[0].reason);
});

test("segments become a variable — one label per combination — usable by a planned crosstab, with the small segments named in the run's warnings", () => {
  const def = structuredClone(base);
  def.research = { objective: "x", hypotheses: [], population: "adults", constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "xs", rows: ["SAT"], columns: ["SEG_GENDER_REGION"], priority: 1, hypotheses: [] }], tests: [], derived: [], segments: [{ name: "Gender × region", by: ["GENDER", "REGION"] }, { name: "Awareness", by: ["AWARE"] }] },
  } as never;
  const ds = synthDataset(120);
  const p = withPlannedVariables(def, ds);
  assert.deepEqual(p.computed, ["SEG_GENDER_REGION"]);
  const meta = p.dataset.byName.get("SEG_GENDER_REGION")!;
  assert.deepEqual(meta.categories!.map((c) => c.label), ["Male × North", "Male × South", "Male × East", "Female × North", "Female × South", "Female × East"]);
  const c0 = p.dataset.cases[0];
  assert.equal(c0.vars.SEG_GENDER_REGION, `${c0.vars.GENDER === 1 ? "Male" : "Female"} × ${["North", "South", "East"][Number(c0.vars.REGION) - 1]}`);
  // 120 respondents over 6 segments: every segment is under 30
  const small = p.warnings.find((w) => w.startsWith("Segment “Gender × region” (SEG_GENDER_REGION): "))!;
  assert.match(small, /Male × North n = \d+/);
  assert.match(small, /under 30, read those columns with caution/);
  assert.ok(p.warnings.some((w) => /Segment “Awareness”: not computed — AWARE is a multi-select/.test(w)));
  const run = runPlan(def, ds);
  const xs = run.items.find((it) => it.definition.options?.planned === "xs")!;
  assert.ok(xs.result.tables.length > 0, "the crosstab by the segment variable runs");
  assert.ok(run.warnings.includes(small));
  /* 600 respondents: every segment is big enough, nothing to say */
  assert.ok(!withPlannedVariables(def, synthDataset(600)).warnings.some((w) => /Gender × region/.test(w)));
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 6) */

test("withPlannedVariables — edges: a name the survey already has is not overwritten; a 0/1 recode is categorical, an index numeric; a box of several items is the box of their mean; a segment needs every part", () => {
  const def = structuredClone(base);
  def.research = { objective: "x", hypotheses: [], population: "adults", constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [], tests: [], segments: [{ name: "Gender × region", by: ["GENDER", "REGION"] }],
      derived: [
        { name: "SAT", kind: "mean_score", from: ["ITEMS"] },
        { name: "SAT_HI", kind: "recode", from: ["SAT"], expression: "if(SAT >= 4, 1, 0)" },
        { name: "SAT_X2", kind: "index", from: ["SAT"], expression: "SAT * 2" },
        { name: "ITEMS_T2B", kind: "top_box", from: ["ITEMS"] },
      ] },
  } as never;
  const ds = synthDataset(300);
  ds.cases[0].vars.REGION = null;
  const p = withPlannedVariables(def, ds);
  assert.ok(p.warnings.includes("SAT: not computed — the survey already has a variable of that name."), p.warnings.join(" | "));
  assert.ok(p.dataset.cases.every((c, i) => c.vars.SAT === ds.cases[i].vars.SAT), "the question's answers are kept");
  assert.equal(p.dataset.byName.get("SAT_HI")!.role, "categorical", "a recode to a few values is a code frame");
  assert.equal(p.dataset.byName.get("SAT_X2")!.role, "numeric", "an index is a number");
  for (const c of p.dataset.cases) {
    const items = ["ITEMS_a", "ITEMS_b", "ITEMS_c"].map((k) => Number(c.vars[k]));
    assert.equal(c.vars.ITEMS_T2B, items.reduce((t, x) => t + x, 0) / 3 >= 4 ? 1 : 0, "the box of the items' mean");
  }
  assert.equal(p.dataset.cases[0].vars.SEG_GENDER_REGION, null, "no region, no segment");
  assert.ok(p.dataset.cases.slice(1).every((c) => typeof c.vars.SEG_GENDER_REGION === "string"));
});
