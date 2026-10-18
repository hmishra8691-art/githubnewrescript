import { test } from "node:test";
import assert from "node:assert/strict";
import { variableMetadata } from "./dataset.js";
import { analysisReadiness, plannedItemReadiness, validateAnalysis, expandedItemCount } from "./planCheck.js";
import { runAnalysis } from "./analyses/index.js";
import { def, synthDataset, D, rule } from "./analyses/fixture.js";
import type { AnalysisDefinition } from "./types.js";

/*
 * THE APPLY AUDIT (2026-10-17) — one rule decides whether an analysis can be
 * applied, for every method the workspace offers: the builder's Run button,
 * the run route, the plan editor and the plan's item states all read
 * `analysisReadiness` / `plannedItemReadiness`. For each method: a valid
 * configuration is READY and the runner computes it (no error, at least one
 * table); an incomplete one is NOT READY and names what is missing.
 */
const vars = variableMetadata(def);
const ds = synthDataset(300);
const seg = (id: string, name: string, code: number) => ({ id, name, condition: rule("GENDER", code) });

type Row = { method: string; valid: AnalysisDefinition; invalid?: AnalysisDefinition; missing?: RegExp };
const TABLE: Row[] = [
  { method: "frequencies", valid: D("descriptive", ["REGION"]), invalid: D("descriptive", []), missing: /no variables chosen/ },
  { method: "top box", valid: D("topbox", ["SAT"]), invalid: D("topbox", []), missing: /no variables/ },
  { method: "crosstab", valid: { ...D("crosstab", []), rows: ["SAT"], columns: ["GENDER"] }, invalid: { ...D("crosstab", []), rows: ["SAT"], columns: [] }, missing: /row variable and one column variable/ },
  { method: "t-test", valid: D("test", ["SAT", "GENDER"], { options: { test: "t_welch" } }), invalid: D("test", ["SAT"], { options: { test: "t_welch" } }), missing: /grouping variable/ },
  { method: "one-sample t-test", valid: D("test", ["SAT"], { options: { test: "t_one_sample", mu: 3 } }) },
  { method: "anova", valid: D("test", ["SAT", "REGION"], { options: { test: "anova_one_way" } }), invalid: D("test", ["SAT"], { options: { test: "anova_one_way" } }), missing: /grouping/ },
  { method: "chi-square", valid: D("test", ["REGION", "GENDER"], { options: { test: "chi_square" } }), invalid: D("test", ["REGION", "REGION"], { options: { test: "chi_square" } }), missing: /against itself/ },
  { method: "correlation", valid: D("correlation", ["SAT", "AGE"]), invalid: D("correlation", ["SAT"]), missing: /at least two numeric/ },
  { method: "regression", valid: D("regression", ["SAT", "AGE"]), invalid: D("regression", ["SAT"]), missing: /at least one predictor/ },
  { method: "logistic", valid: D("regression", ["GENDER", "AGE"], { options: { model: "logistic" } }), invalid: D("regression", ["GENDER"], { options: { model: "logistic" } }), missing: /predictor/ },
  { method: "mediation", valid: D("regression", ["SAT", "AGE", "NPS"], { options: { model: "mediation" } }), invalid: D("regression", ["SAT", "AGE"], { options: { model: "mediation" } }), missing: /outcome, the predictor and the mediator/ },
  { method: "reliability (battery by its question)", valid: D("reliability", ["ITEMS"]), invalid: D("reliability", ["ITEMS_a"]), missing: /at least two items/ },
  { method: "factor", valid: D("factor", ["ITEMS_a", "ITEMS_b", "ITEMS_c"]), invalid: D("factor", ["ITEMS_a", "ITEMS_b"]), missing: /at least three/ },
  { method: "cluster", valid: D("cluster", ["SAT", "AGE"], { options: { k: 2 } }), invalid: D("cluster", ["SAT"]), missing: /at least two numeric/ },
  { method: "nps", valid: D("nps", ["NPS"]), invalid: D("nps", []), missing: /no variables/ },
  { method: "turf", valid: D("turf", ["AWARE"]), invalid: D("turf", []), missing: /no variables/ },
  { method: "ranking", valid: D("ranking", ["RANK"]), invalid: D("ranking", []), missing: /no variables/ },
  { method: "allocation", valid: D("allocation", ["ALLOC"]), invalid: D("allocation", []), missing: /no variables/ },
  { method: "text themes", valid: D("text", ["TEXT"]), invalid: D("text", []), missing: /no variables/ },
  { method: "pricing (Van Westendorp)", valid: D("pricing", ["P_CHEAP", "P_BARGAIN", "P_EXP", "P_TOOEXP"]), invalid: D("pricing", ["P_CHEAP", "P_BARGAIN"]), missing: /four price questions/ },
  { method: "brand funnel", valid: D("brand", ["AWARE", "CONSIDER"]), invalid: D("brand", ["AWARE"]), missing: /at least two stages/ },
  { method: "importance × performance (Options)", valid: D("gap", [], { options: { importance: ["ITEMS_a", "ITEMS_b"], performance: ["RANK_1", "RANK_2"] } }), invalid: D("gap", [], { options: { importance: ["ITEMS_a", "ITEMS_b"] } }), missing: /performance items/ },
  { method: "segment profile", valid: D("segmentation", [], { segments: [seg("s1", "Men", 1), seg("s2", "Women", 2)] }), invalid: D("segmentation", ["SAT"]), missing: /at least one/ },
  { method: "weighting (rim targets only)", valid: D("weighting", [], { weighting: { rim: [{ variable: "GENDER", targets: { "1": 50, "2": 50 } }] } }), invalid: D("weighting", ["GENDER"]), missing: /rim targets or a weight variable/ },
  { method: "data quality", valid: D("quality", []) },
  { method: "conjoint utilities", valid: D("conjoint", ["CBC_TASKS"]), invalid: D("conjoint", []), missing: /no variables/ },
  { method: "maxdiff scores", valid: D("maxdiff", ["MD_TASKS"]), invalid: D("maxdiff", []), missing: /no variables/ },
];

for (const row of TABLE) {
  test(`Apply rule — ${row.method}: a valid configuration is ready and runs; an incomplete one names what is missing`, () => {
    const ok = analysisReadiness(row.valid, vars);
    assert.equal(ok.ready, true, `${row.method} should be ready: ${ok.missing.join(" | ")}`);
    const result = runAnalysis(row.valid, ds);
    assert.equal(result.error, undefined, `${row.method} ran with an error: ${result.error?.message}`);
    assert.ok(result.tables.length > 0, `${row.method} computed no table: ${result.warnings.join(" | ")}`);
    if (row.invalid) {
      const bad = analysisReadiness(row.invalid, vars);
      assert.equal(bad.ready, false, `${row.method}: the incomplete configuration was called ready`);
      assert.match(bad.missing.join(" "), row.missing!);
    }
  });
}

test("the rule is the validator: ready ⇔ validateAnalysis has no error (names aside)", () => {
  for (const row of TABLE) for (const d of [row.valid, row.invalid].filter(Boolean) as AnalysisDefinition[]) {
    const errs = validateAnalysis(d, vars).filter((i) => i.severity === "error" && i.code !== "unknown_variable");
    assert.equal(analysisReadiness(d, vars).ready, errs.length === 0, `${row.method}: ${JSON.stringify(d.variables)}`);
  }
});

test("a one-sample test is no longer refused as 'one variable is not enough' (validator was stricter than the runner)", () => {
  assert.equal(validateAnalysis(D("test", ["SAT"], { options: { test: "t_one_sample" } }), vars).length, 0);
  assert.equal(validateAnalysis(D("test", ["GENDER"], { options: { test: "proportion_one_sample" } }), vars).length, 0);
  // an auto test with one variable still needs its grouping — the message says how to get a one-sample test instead
  assert.match(analysisReadiness(D("test", ["SAT"]), vars).missing[0], /one-sample test in Options/);
});

test("names: the builder does not refuse a planned computed variable; the plan check (checkNames) does name a dead one", () => {
  assert.equal(analysisReadiness(D("descriptive", ["SAT_TOP"]), vars).ready, true);
  const r = analysisReadiness(D("descriptive", ["GHOST"]), vars, { checkNames: true });
  assert.equal(r.ready, false); assert.match(r.missing[0], /GHOST is not in this survey's data/);
});

test("battery items are counted the way the runner reads them", () => {
  assert.equal(expandedItemCount(["ITEMS"], vars), 3);
  assert.equal(expandedItemCount(["ITEMS_a", "ITEMS_b"], vars), 2);
  assert.equal(expandedItemCount(["SAT", "UNKNOWN"], vars), 2);
});

test("planned items: the editor's rule and the plan's 'invalid' are the same — each names the missing role", () => {
  const T = (t: Record<string, unknown>) => plannedItemReadiness({ kind: "test", test: { variables: [], ...t } as never }, vars, def);
  assert.equal(T({ method: "anova", outcome: "SAT", groupBy: "REGION" }).ready, true);
  assert.match(T({ method: "anova", outcome: "SAT" }).missing.join(" "), /choose the grouping variable/);
  assert.match(T({ method: "chi_square", outcome: "REGION" }).missing.join(" "), /two categorical variables/);
  assert.equal(T({ method: "chi_square", outcome: "REGION", variables: ["GENDER"] }).ready, true);
  assert.match(T({ method: "regression", outcome: "SAT" }).missing.join(" "), /at least one predictor/);
  assert.match(T({ method: "driver_analysis", variables: ["AGE"] }).missing.join(" "), /needs an outcome/);
  assert.equal(T({ method: "regression", outcome: "SAT", variables: ["AGE"] }).ready, true);
  assert.match(T({ method: "correlation", outcome: "SAT" }).missing.join(" "), /two or more/);
  assert.equal(T({ method: "reliability", variables: ["ITEMS"] }).ready, true, "a battery named by its question is enough items");
  assert.match(T({ method: "reliability", variables: ["ITEMS_a"] }).missing.join(" "), /at least two items/);
  assert.equal(T({ method: "nps", variables: ["NPS"] }).ready, true);
  assert.match(T({ method: "nps" }).missing.join(" "), /needs the variable it reads/);
  assert.equal(T({ method: "maxdiff_scores", variables: ["MD_TASKS"] }).ready, true);
  assert.equal(T({ method: "conjoint_utilities", variables: ["CBC_TASKS"] }).ready, true);
  const X = (rows: string[], columns: string[]) => plannedItemReadiness({ kind: "crosstab", crosstab: { rows, columns } }, vars, def);
  assert.equal(X(["SAT"], ["GENDER"]).ready, true);
  assert.match(X(["SAT"], []).missing.join(" "), /at least one column variable/);
  assert.match(X(["AWARE"], ["AWARE"]).missing.join(" "), /cannot be both a row and a column/);
});
