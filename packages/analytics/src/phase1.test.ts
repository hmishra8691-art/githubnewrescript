import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset, spec } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { withPlannedVariables } from "./plannedVariables.js";
import { runPlan } from "./findings.js";
import { plannedAnalyses } from "./planBridge.js";

/**
 * Research Engine audit, Phase 1 — analytics correctness.
 *
 * 1. The plan's derived variables and segments are columns of every dataset
 *    the Studio builds (`buildFor` calls `withPlannedVariables`), so a saved
 *    analysis that names one runs; and `runPlan`'s own pass over a dataset
 *    that already carries them adds nothing and warns of nothing.
 * 2. A plan variable that could not be computed leaves its note on the
 *    dataset, and the results that read it inherit the note.
 * 3. A factor analysis outputs its scores.
 */
const PLAN = {
  crosstabs: [{ id: "x1", rows: ["SAT_T2B"], columns: ["GENDER"], priority: 1, hypotheses: [] }],
  tests: [{ id: "t1", method: "t_test", outcome: "ITEMS_SCORE", variables: [], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }],
  derived: [
    { name: "SAT_T2B", kind: "top_box", from: ["SAT"] },
    { name: "ITEMS_SCORE", kind: "mean_score", from: ["ITEMS"] },
    { name: "NO_RULE", kind: "recode", from: ["SAT"] },
  ],
  segments: [{ name: "Gender × region", by: ["GENDER", "REGION"] }],
};
const withPlan = () => {
  const def = structuredClone(base);
  def.research = { objective: "x", hypotheses: ["Women have a higher item score than men"], population: "adults", constructs: [], analysis: [], assumptions: [], sources: [], analysisPlan: PLAN } as never;
  return def;
};

test("a dataset built with the plan's variables runs a saved analysis that names one; runPlan over it adds nothing twice", () => {
  const def = withPlan();
  const built = withPlannedVariables(def, synthDataset(300));
  assert.deepEqual(built.computed.slice(0, 2), ["SAT_T2B", "ITEMS_SCORE"]);
  assert.equal(built.computed.length, 3, `the segment too: ${built.computed.join(",")}`);
  assert.ok(built.dataset.byName.get("SAT_T2B")?.derived && built.dataset.byName.get(built.computed[2])?.derived, "marked as the plan's own");
  // the way the Studio would run a saved crosstab on this dataset
  const xt = runAnalysis({ id: "a", kind: "crosstab", name: "T2B by gender", variables: ["SAT_T2B", "GENDER"], dataset: spec, options: {} } as never, built.dataset);
  assert.ok(!xt.warnings.some((w) => /not in this survey's dictionary/.test(w)), xt.warnings.join(" | "));
  assert.ok(xt.tables.length >= 1, "the table was computed");
  // the second pass — runPlan on the same dataset — finds the columns present and raises no "already has a variable" warning
  const again = withPlannedVariables(def, built.dataset);
  assert.deepEqual(again.computed, []);
  assert.ok(!again.warnings.some((w) => /already has a variable|already a variable/.test(w)), again.warnings.join(" | "));
  const run = runPlan(def, built.dataset, { items: plannedAnalyses(def, spec), trigger: "manual" });
  assert.ok(!run.warnings.some((w) => /already has a variable|already a variable/.test(w)), run.warnings.join(" | "));
  assert.ok(run.items.some((i) => i.result.variablesUsed.includes("ITEMS_SCORE")), "the planned t-test ran on the derived score");
});

test("a plan variable that could not be computed leaves its note on the dataset, inherited by the results that read it", () => {
  const def = withPlan();
  const built = withPlannedVariables(def, synthDataset(120));
  const note = built.warnings.find((w) => /NO_RULE/.test(w));
  assert.ok(note, `the recode without an expression is said: ${built.warnings.join(" | ")}`);
  built.dataset.warnings = built.warnings;
  const uses = runAnalysis({ id: "a", kind: "descriptive", name: "x", variables: ["NO_RULE"], dataset: spec, options: {} } as never, built.dataset);
  assert.ok(uses.warnings.includes(note!), "the result that reads it carries the note");
  const other = runAnalysis({ id: "b", kind: "descriptive", name: "y", variables: ["SAT"], dataset: spec, options: {} } as never, built.dataset);
  assert.ok(!other.warnings.includes(note!), "a result that does not read it does not");
});

test("factor analysis outputs its scores: a summary table and one score per case and factor", () => {
  const ds = synthDataset(400);
  const r = runAnalysis({ id: "f", kind: "factor", name: "f", variables: ["ITEMS", "SAT"], dataset: spec, options: { factors: 2 } } as never, ds);
  const scores = r.tables.find((t) => t.id === "scores");
  assert.ok(scores, `tables: ${r.tables.map((t) => t.id).join(",")} warnings: ${r.warnings.join(" | ")}`);
  assert.equal(scores!.rows.length, 2, "one row per factor");
  assert.ok(scores!.rows.every((row) => Number(row.n) > 100 && Number.isFinite(Number(row.sd))));
  assert.equal(r.chart.scores?.factors.length, 2);
  assert.equal(r.chart.scores?.values.length, ds.cases.length, "one row per case, in dataset order");
  assert.equal(r.chart.scores?.values[0]?.length, 2);
  // a respondent missing an item has no score: not counted, not scored as zero
  const holed = { ...ds, cases: ds.cases.map((c, i) => (i < 40 ? { ...c, vars: { ...c.vars, ITEMS_a: null } } : c)) };
  const r2 = runAnalysis({ id: "f", kind: "factor", name: "f", variables: ["ITEMS", "SAT"], dataset: spec, options: { factors: 2 } } as never, holed);
  const t2 = r2.tables.find((t) => t.id === "scores")!;
  assert.ok(t2.rows.every((row) => Number(row.n) <= ds.cases.length - 40), `n excludes the holed cases: ${t2.rows.map((x) => x.n).join(",")}`);
  assert.equal(r2.chart.scores?.values[0]?.[0], null, "…and their scores are null, not 0");
});
