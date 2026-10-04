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
