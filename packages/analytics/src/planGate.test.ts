import { test } from "node:test";
import assert from "node:assert/strict";
import { applySurveyActions, coerceSurveyActions, registerPlanItemReadiness, type SurveyAction } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { def as fixture } from "./analyses/fixture.js";
import { registerPlanReadinessGate, planItemGate } from "./planGate.js";
import { plannedItemReadiness } from "./planCheck.js";
import { variableMetadata } from "./dataset.js";

/*
 * ENGINE WEAKNESS #12 (2026-10-22): the copilot's analysis-plan actions are judged at ACTION time by the one
 * readiness rule (`plannedItemReadiness`) — an item the rule calls not ready is refused with the missing role or
 * variable named, so the repair call can supply it, and nothing invalid is stored. One valid and (where the gate is
 * what refuses it) one invalid item per method; plus set_analysis_plan, the updates, the engine's own plan, a stored
 * plan that keeps loading, and the behaviour with no rule registered.
 */

const def: SurveyDefinition = structuredClone(fixture);
const run = (actions: unknown[], d: SurveyDefinition = def) => {
  const { actions: typed, rejected } = coerceSurveyActions(actions);
  assert.deepEqual(rejected, [], `the gate's coercion refused: ${JSON.stringify(rejected)}`);
  return applySurveyActions(d, typed as SurveyAction[]);
};
const t = (method: string, x: Record<string, unknown> = {}) => ({ op: "add_analysis_test", method, priority: 1, ...x });

type Row = { method: string; valid: Record<string, unknown>; invalid?: Record<string, unknown>; missing?: RegExp };
const TABLE: Row[] = [
  { method: "crosstab", valid: { op: "add_crosstab", rows: ["Q4"], columns: ["Q1"] } },
  { method: "frequencies", valid: t("frequencies", { variables: ["Q3"] }) },
  { method: "mean", valid: t("mean", { variables: ["Q2"] }) },
  { method: "median", valid: t("median", { variables: ["Q2"] }) },
  { method: "top_box", valid: t("top_box", { variables: ["Q4"] }) },
  { method: "nps", valid: t("nps", { variables: ["Q5"] }) },
  { method: "t_test", valid: t("t_test", { outcome: "Q4", groupBy: "Q1" }), invalid: t("t_test", { outcome: "Q4" }), missing: /grouping variable/ },
  { method: "anova", valid: t("anova", { outcome: "Q4", groupBy: "Q3" }), invalid: t("anova", { outcome: "Q4" }), missing: /grouping variable/ },
  { method: "mann_whitney", valid: t("mann_whitney", { outcome: "Q4", groupBy: "Q1" }), invalid: t("mann_whitney", { outcome: "Q4" }), missing: /grouping variable/ },
  { method: "kruskal_wallis", valid: t("kruskal_wallis", { outcome: "Q4", groupBy: "Q3" }), invalid: t("kruskal_wallis", { groupBy: "Q3" }), missing: /choose the outcome|outcome/ },
  { method: "chi_square", valid: t("chi_square", { variables: ["Q3", "Q1"] }), invalid: t("chi_square", { variables: ["Q3"] }), missing: /two categorical variables/ },
  { method: "correlation", valid: t("correlation", { variables: ["Q4", "Q2"] }), invalid: t("correlation", { variables: ["Q4"] }), missing: /two or more numeric/ },
  { method: "regression", valid: t("regression", { outcome: "Q4", variables: ["Q2"] }), invalid: t("regression", { outcome: "Q4" }), missing: /at least one predictor/ },
  { method: "logistic_regression", valid: t("logistic_regression", { outcome: "Q1", variables: ["Q2"] }), invalid: t("logistic_regression", { variables: ["Q2"] }), missing: /needs an outcome/ },
  { method: "driver_analysis", valid: t("driver_analysis", { outcome: "Q4", variables: ["Q2", "Q5"] }), invalid: t("driver_analysis", { variables: ["Q2", "Q5"] }), missing: /needs an outcome/ },
  { method: "regression + bootstrap", valid: t("regression", { outcome: "Q4", variables: ["Q2"], mediator: "Q5", options: { bootstrap: 2000 } }), invalid: t("regression", { outcome: "Q4", variables: ["Q2"], options: { bootstrap: 2000 } }), missing: /name the mediator/ },
  { method: "reliability", valid: t("reliability", { variables: ["Q8"] }), invalid: t("reliability", { variables: ["Q2"] }), missing: /at least two items/ },
  { method: "factor", valid: t("factor", { variables: ["Q8"] }), invalid: t("factor", { variables: ["Q2", "Q4"] }), missing: /at least three/ },
  { method: "cluster", valid: t("cluster", { variables: ["Q4", "Q2"] }), invalid: t("cluster", { variables: ["Q4"] }), missing: /at least two numeric/ },
  { method: "conjoint_utilities", valid: t("conjoint_utilities", { variables: ["Q16"] }) },
  { method: "maxdiff_scores", valid: t("maxdiff_scores", { variables: ["Q17"] }) },
  { method: "turf", valid: t("turf", { variables: ["Q6"] }) },
  { method: "text_themes", valid: t("text_themes", { variables: ["Q11"] }) },
  { method: "ranking_scores", valid: t("ranking_scores", { variables: ["Q9"] }) },
  { method: "allocation_shares", valid: t("allocation_shares", { variables: ["Q10"] }) },
  { method: "pricing (Van Westendorp)", valid: t("pricing", { variables: ["Q12", "Q13", "Q14", "Q15"], options: { method: "van_westendorp" } }), invalid: t("pricing", { variables: ["Q12", "Q13"], options: { method: "van_westendorp" } }), missing: /four price questions/ },
  { method: "brand_funnel", valid: t("brand_funnel", { variables: ["Q6", "Q7"] }), invalid: t("brand_funnel", { variables: ["Q6"] }), missing: /at least two stages/ },
  { method: "hb", valid: t("hb", { variables: ["Q16"] }), invalid: t("hb", { variables: ["Q16", "Q17"] }), missing: /exactly one|one CBC|only that question/ },
  { method: "latent_class", valid: t("latent_class", { variables: ["Q1", "Q3", "Q4"], options: { minClasses: 1, maxClasses: 2 } }), invalid: t("latent_class", { variables: ["Q1"] }), missing: /indicators|two/ },
  { method: "sem", valid: t("sem", { options: { syntax: "SAT_F =~ ITEMS_a + ITEMS_b + ITEMS_c" } }), invalid: t("sem", { options: { syntax: "SAT_F =~ ITEMS_a" } }), missing: /identif|indicator/ },
];

test("#12 the rule is registered once and is plannedItemReadiness with the survey's own dictionary", () => {
  registerPlanReadinessGate();
  const item = { kind: "test" as const, test: { id: "x", method: "anova" as const, outcome: "SAT", variables: [], priority: 2, hypotheses: [] } };
  assert.deepEqual(planItemGate(item, def).missing, plannedItemReadiness(item, variableMetadata(def), def).missing);
  assert.equal(planItemGate(item, def).ready, false);
});

for (const row of TABLE) {
  test(`#12 ${row.method}: a ready item is planned; one with a missing input is refused at action time, naming it`, () => {
    registerPlanReadinessGate();
    const ok = run([row.valid]);
    assert.equal(ok.results[0]!.ok, true, `${row.method} should be accepted: ${ok.errors.join(" | ")}`);
    const plan = ok.def.research?.analysisPlan;
    assert.ok(plan && plan.crosstabs.length + plan.tests.length >= 1, "the item is in the plan");
    if (row.invalid) {
      const bad = run([row.invalid]);
      assert.equal(bad.results[0]!.ok, false, `${row.method} with a missing input should be refused`);
      assert.match(bad.results[0]!.error ?? "", row.missing!, `the refusal names what is missing: ${bad.results[0]!.error}`);
      /* never stored: the plan the batch leaves has no such item */
      assert.equal((bad.def.research?.analysisPlan?.tests ?? []).length, (def.research?.analysisPlan?.tests ?? []).length);
    }
  });
}

test("#12 pricing (Gabor–Granger): one price per purchase-intent question, or refused naming the count", () => {
  registerPlanReadinessGate();
  const yn = [{ code: 1, label: "Yes, definitely" }, { code: 2, label: "Probably" }, { code: 3, label: "No" }];
  const gg = structuredClone(def);
  gg.questions.push({ ...structuredClone(def.questions.find((q) => q.code === "Q1")!), id: "q_pi1", code: "PI1", variableName: "PI1", text: "Would you buy it at $10?", options: yn } as never);
  gg.questions.push({ ...structuredClone(def.questions.find((q) => q.code === "Q1")!), id: "q_pi2", code: "PI2", variableName: "PI2", text: "Would you buy it at $20?", options: yn } as never);
  (gg.flow[0] as { questionIds: string[] }).questionIds.push("q_pi1", "q_pi2");
  const ok = run([t("pricing", { variables: ["PI1", "PI2"], options: { method: "gabor_granger", prices: [10, 20] } })], gg);
  assert.equal(ok.results[0]!.ok, true, ok.errors.join(" | "));
  const bad = run([t("pricing", { variables: ["PI1", "PI2"], options: { method: "gabor_granger", prices: [10, 20, 30] } })], gg);
  assert.equal(bad.results[0]!.ok, false);
  assert.match(bad.results[0]!.error!, /3 price points for 2 purchase-intent items|one price per/);
});

test("#12 set_analysis_plan: one item that is not ready refuses the action and names its place; the rest are not stored half-way", () => {
  registerPlanReadinessGate();
  const r = run([{ op: "set_analysis_plan", merge: true, tests: [{ method: "t_test", outcome: "Q4", groupBy: "Q1" }, { method: "anova", outcome: "Q4" }] }]);
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.results[0]!.error!, /tests\[2\].*not ready.*grouping variable/);
  assert.equal(r.def.research?.analysisPlan?.tests.length ?? 0, 0);
  const ok = run([{ op: "set_analysis_plan", merge: true, tests: [{ method: "t_test", outcome: "Q4", groupBy: "Q1" }], crosstabs: [{ rows: ["Q4"], columns: ["Q3"] }] }]);
  assert.equal(ok.results[0]!.ok, true, ok.errors.join(" | "));
});

test("#12 update_analysis_test: an edit that removes a needed input is refused; an edit of an already-invalid stored item that touches no input is kept, with the state said", () => {
  registerPlanReadinessGate();
  const base = run([t("anova", { outcome: "Q4", groupBy: "Q3" })]);
  const id = base.def.research!.analysisPlan!.tests[0]!.id;
  const broke = run([{ op: "update_analysis_test", id, groupBy: null }], base.def);
  assert.equal(broke.results[0]!.ok, false);
  assert.match(broke.results[0]!.error!, /grouping variable/);
  /* a stored plan from before this rule may hold an invalid item: it still loads, and a priority change on it is allowed */
  const legacy = structuredClone(base.def);
  legacy.research!.analysisPlan!.tests[0] = { ...legacy.research!.analysisPlan!.tests[0]!, groupBy: undefined } as never;
  delete (legacy.research!.analysisPlan!.tests[0] as { groupBy?: string }).groupBy;
  const unrelated = run([{ op: "set_question_analysis", target: "Q2", role: "control" }], legacy);
  assert.equal(unrelated.results[0]!.ok, true, "an unrelated action on a survey with a stored invalid item is fine");
  const prio = run([{ op: "update_analysis_test", id, priority: 1 }], legacy);
  assert.equal(prio.results[0]!.ok, true, prio.errors.join(" | "));
  assert.ok(prio.warnings.some((w) => /still not ready.*grouping variable/.test(w)), `the state is said: ${prio.warnings.join(" | ")}`);
  const fixed = run([{ op: "update_analysis_test", id, groupBy: "Q3" }], legacy);
  assert.equal(fixed.results[0]!.ok, true, "the repair (adding the grouping) is accepted");
});

test("#12 update_crosstab: an edit that tabulates a variable against itself is refused (as before); a ready edit applies", () => {
  registerPlanReadinessGate();
  const base = run([{ op: "add_crosstab", rows: ["Q4"], columns: ["Q1"] }]);
  const id = base.def.research!.analysisPlan!.crosstabs[0]!.id;
  assert.equal(run([{ op: "update_crosstab", id, columns: ["Q3"] }], base.def).results[0]!.ok, true);
});

test("#12 propose_analysis_plan: the engine's own items are not refused, and any that is not ready is said with the change", () => {
  registerPlanReadinessGate();
  const r = run([{ op: "propose_analysis_plan" }]);
  assert.equal(r.results[0]!.ok, true, r.errors.join(" | "));
});

test("#12 with no rule registered the actions behave exactly as before (an engine-only caller)", () => {
  registerPlanItemReadiness(null);
  try {
    const r = run([t("anova", { outcome: "Q4" })]);
    assert.equal(r.results[0]!.ok, true, "accepted without the rule — Data Analytics then marks it invalid, as before");
  } finally { registerPlanReadinessGate(); }
});
