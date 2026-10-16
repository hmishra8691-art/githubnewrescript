import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset } from "./dataset.js";
import { crosstabDefinition, planVariableName, plannedAnalyses, testDefinition } from "./planBridge.js";
import { withPlannedVariables } from "./plannedVariables.js";
import { runPlan, compactRun } from "./findings.js";
import { reviewPlanned, surveyKnownNames } from "./planCheck.js";
import { def as fixtureDef, synthRows, spec } from "./analyses/fixture.js";

/*
 * THE PLAN RUNS WHAT IT SAYS (audit 2026-10-16, ANALYTICS-05 / -06 / -07).
 *
 *  - an item naming a question by CODE ("Q6") passed validation and ran as
 *    "not in this survey's dictionary", base 0, no error — codes are now
 *    resolved to variable names where the plan becomes analyses;
 *  - an item naming a variable the data does not have ran anyway, producing
 *    an empty result with no error — it is now kept in the run with `error`
 *    set and named in one run caveat;
 *  - the run built one dataset from the FIRST item's weighting — each item
 *    now runs on the dataset built for its own weighting.
 */
const def = SurveyDefinition.parse({
  ...JSON.parse(JSON.stringify(fixtureDef)),
  research: { analysisPlan: {
    crosstabs: [
      { id: "x_code", rows: ["Q4"], columns: ["Q1"], priority: 1, hypotheses: ["H1"] },
      { id: "x_dead", rows: ["SAT"], columns: ["NOPE"], priority: 2, hypotheses: [] },
    ],
    tests: [
      { id: "t_code", method: "t_test", outcome: "Q2", groupBy: "Q1", priority: 1, hypotheses: ["H1"] },
      { id: "t_dead", method: "anova", outcome: "GHOST", groupBy: "GENDER", priority: 2, hypotheses: [] },
    ],
    derived: [{ name: "SAT_T2B", kind: "top_box", from: ["Q4"] }],
    segments: [{ name: "By gender", by: ["Q1"] }],
  } },
});
const ds = buildDataset(def, synthRows(120), { spec });

test("ANALYTICS-05: a question code in the plan becomes the variable the dataset knows", () => {
  assert.equal(planVariableName(def, "Q4"), "SAT");
  assert.equal(planVariableName(def, "SAT"), "SAT", "a variable name is left alone");
  assert.equal(planVariableName(def, "NOPE"), "NOPE", "an unknown name passes through for the review to catch");
  const x = crosstabDefinition({ id: "x", rows: ["Q4"], columns: ["Q1"], priority: 1, hypotheses: [] } as never, spec, def);
  assert.deepEqual([x.rows, x.columns, x.variables], [["SAT"], ["GENDER"], ["SAT", "GENDER"]]);
  assert.equal(x.name, "Q4 by Q1", "the name still reads as the plan wrote it");
  const t = testDefinition({ id: "t", method: "t_test", outcome: "Q2", groupBy: "Q1", variables: [], priority: 1, hypotheses: [] } as never, spec, def);
  assert.deepEqual(t.variables, ["AGE", "GENDER"]);
  assert.equal(t.name, "t test — Q2");
});

test("ANALYTICS-05: derived variables and segments named by code are computed", () => {
  const pv = withPlannedVariables(def, ds);
  assert.ok(pv.computed.includes("SAT_T2B"), `SAT_T2B computed from Q4: ${pv.warnings.join(" | ")}`);
  assert.ok(pv.computed.some((n) => /gender/i.test(n)), `segment by Q1 computed: ${pv.computed.join(", ")}`);
  assert.equal(pv.warnings.length, 0, pv.warnings.join(" | "));
});

test("ANALYTICS-05: the planned code items pass the review and run on their variables with a real base", () => {
  const items = plannedAnalyses(def, spec);
  const vars = [...ds.byName.values()];
  const review = reviewPlanned(items, vars, surveyKnownNames(def, vars));
  assert.deepEqual(review.kept.map((k) => k.definition.options?.planned), ["x_code", "t_code"]);
  assert.deepEqual(review.blocked.map((b) => b.item.definition.options?.planned), ["x_dead", "t_dead"]);
  const run = runPlan(def, ds, { trigger: "test", discover: false });
  const byId = new Map(run.items.map((it) => [String(it.definition.options?.planned), it]));
  assert.equal(byId.get("x_code")!.result.base.n, 120);
  assert.equal(byId.get("x_code")!.error, undefined);
  assert.equal(byId.get("t_code")!.result.base.n, 120);
  assert.ok(!run.warnings.some((w) => /not in this survey's dictionary/.test(w)), run.warnings.join(" | "));
});

test("ANALYTICS-06: items the data cannot run are kept with `error` set, not run, and named in one run caveat", () => {
  const run = runPlan(def, ds, { trigger: "test", discover: false });
  const dead = run.items.filter((it) => it.error);
  assert.deepEqual(dead.map((it) => it.definition.options?.planned), ["x_dead", "t_dead"]);
  for (const it of dead) {
    assert.equal(it.error?.code, "unknown_variable");
    assert.match(it.error!.message, /^Not run — (NOPE|GHOST) is not in this survey's data\.$/);
    assert.equal(it.result.tables.length, 0);
    assert.equal(it.findings.length, 0);
  }
  const caveat = run.warnings.find((w) => w.startsWith("2 planned analyses were not run:"));
  assert.ok(caveat, run.warnings.join(" | "));
  assert.match(caveat!, /“Q4 by NOPE” \(NOPE is not in this survey's data\)/);
  assert.match(caveat!, /“anova — GHOST” \(GHOST is not in this survey's data\)/);
  assert.ok(!run.warnings.some((w) => /has no respondents in the selected data/.test(w)), "the dead items' own empty-result warnings are not merged into the run");
  /* the stored (compact) run keeps the error though not the result */
  const compact = compactRun(run);
  assert.equal(compact.items.filter((it) => it.error?.code === "unknown_variable").length, 2);
});

test("ANALYTICS-07: each item runs on the dataset built for its own weighting", () => {
  const weighted = buildDataset(def, synthRows(120), { spec, weighting: { variable: "AGE" } });
  const items = plannedAnalyses(def, spec).filter((p) => ["x_code", "t_code"].includes(String(p.definition.options?.planned)));
  items[1] = { ...items[1], definition: { ...items[1].definition, weighting: { variable: "AGE" } } };
  const run = runPlan(def, ds, { items, trigger: "test", discover: false, datasetFor: (p) => (p.definition.weighting ? weighted : undefined) });
  const [first, second] = run.items;
  assert.equal(first.result.base.weightedN, first.result.base.n, "the unweighted item is unweighted");
  assert.notEqual(second.result.base.weightedN, second.result.base.n, "the second item's weighting applies although the first item has none");
  assert.equal(run.n, ds.cases.length);
});
