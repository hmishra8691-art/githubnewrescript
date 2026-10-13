import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type AnalysisPlan } from "@rescript/schema";
import { buildAnalysisFramework } from "./analysisFramework.js";
import { derivedProblems, reviewAnalysisPlan } from "./analysisFramework.js";
import { PLAN_ITEM_CAP, constructsRead, planItemReads, planScope, planTagIssues, planTierOf, retagPlanHypotheses, variableConstructs } from "./planReads.js";

const opts = (...l: string[]) => l.map((x, i) => ({ id: `o${i}`, code: String(i + 1), label: x }));
const five = opts("1", "2", "3", "4", "5");

/** price → switching (H1), income moderates it (H2), women switch more than men (H3); region is only a profile */
function survey(extra: Partial<AnalysisPlan> = {}, hypothesisDetails?: unknown[], incomeRole = "moderator") {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "T" },
    research: {
      objective: "Why customers switch", population: "Customers", methodology: "Online", sampleSize: 600,
      hypotheses: ["Price perception increases switching", "Income moderates the effect of price perception on switching", "Women switch more than men"],
      ...(hypothesisDetails ? { hypothesisDetails } : {}),
      constructs: [
        { name: "Price perception", role: "independent", questionIds: ["q3", "q4"] },
        { name: "Switching", role: "dependent", questionIds: ["q5"] },
        { name: "Income", role: incomeRole, questionIds: ["q6"] },
      ],
      analysis: [], assumptions: [], sources: [],
      ...(Object.keys(extra).length ? { analysisPlan: { crosstabs: [], tests: [], derived: [], segments: [], ...extra } } : {}),
    },
    questions: [
      { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender?", options: opts("Male", "Female") },
      { id: "q2", code: "Q2", variableName: "REGION", type: "single_select", text: "Region?", options: opts("North", "South", "East") },
      { id: "q3", code: "Q3", variableName: "PRICE1", type: "single_select", text: "Prices are fair", options: five },
      { id: "q4", code: "Q4", variableName: "PRICE2", type: "single_select", text: "Prices are clear", options: five },
      { id: "q5", code: "Q5", variableName: "SWITCH", type: "single_select", text: "Likelihood of switching", options: five },
      { id: "q6", code: "Q6", variableName: "INCOME", type: "single_select", text: "Income band", options: five },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "P", questionIds: ["q1", "q2", "q3", "q4", "q5", "q6"] }] }, { type: "end", id: "e", status: "complete" }],
  });
}

test("what an item reads: every variable of its rows, columns, outcome, predictors, group, moderator and mediator — once", () => {
  assert.deepEqual(planItemReads({ id: "x", rows: ["A", "B"], columns: ["C", "A"], priority: 2, hypotheses: [] }), ["A", "B", "C"]);
  assert.deepEqual(planItemReads({ id: "t", method: "regression", outcome: "Y", variables: ["X1", "X2"], moderator: "M", mediator: "ME", priority: 1, hypotheses: [] }), ["Y", "X1", "X2", "M", "ME"]);
  assert.deepEqual(planItemReads({ id: "t", method: "t_test", outcome: "Y", variables: [], groupBy: "G", priority: 1, hypotheses: [] }), ["Y", "G"]);
});

test("the constructs a variable measures: from the design, and through a derived variable to the items it is built from", () => {
  const def = survey({ derived: [{ name: "PRICE_SCORE", kind: "mean_score", from: ["PRICE1", "PRICE2"] }] });
  const plan = def.research!.analysisPlan!;
  assert.deepEqual([...variableConstructs(def, plan, "PRICE1")], ["Price perception"]);
  assert.deepEqual([...variableConstructs(def, plan, "PRICE_SCORE")], ["Price perception"]);
  assert.deepEqual([...variableConstructs(def, plan, "REGION")], [], "a profile variable measures no construct");
  assert.deepEqual([...constructsRead(def, plan, ["SWITCH", "PRICE_SCORE", "REGION"])].sort(), ["Price perception", "Switching"]);
});

test("P-8: the outcome by the sample profile does not serve the price hypothesis; the outcome by price does; the tag follows what is read", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "2026-10-13T00:00:00Z" });
  const profile = plan.crosstabs.find((x) => x.rows[0] === "SWITCH" && x.columns.includes("REGION"));
  assert.ok(profile, "the outcome is cut by the profile");
  assert.deepEqual(profile!.hypotheses.filter((h) => h !== "H3"), [], "it reads neither price nor income");
  const corr = plan.tests.filter((t) => t.method === "correlation" && t.outcome === "SWITCH");
  const price = corr.find((t) => t.variables[0] === "PRICE1")!;
  assert.deepEqual(price.hypotheses, ["H1", "H2"], "reads both sides of H1; and of H2's cause and effect");
  const income = corr.find((t) => t.variables[0] === "INCOME");
  if (income) assert.ok(!income.hypotheses.includes("H1"), "income → switching does not test price → switching");
  /* every tag in a freshly built plan is one the item reads — the plan review has nothing to say */
  assert.deepEqual(planTagIssues(def, plan), []);
});

test("P-8: retag drops a tag the item cannot serve, demotes it to profiling, adds the hypothesis it does read, and leaves an unresolvable one alone", () => {
  const def = survey({}, [{ type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching" }, {}, {}]);
  const plan: AnalysisPlan = {
    crosstabs: [
      { id: "a", rows: ["SWITCH"], columns: ["REGION"], priority: 1, hypotheses: ["H1"] },
      { id: "b", rows: ["SWITCH"], columns: ["PRICE1"], priority: 2, hypotheses: [] },
    ],
    tests: [{ id: "c", method: "regression", outcome: "SWITCH", variables: ["PRICE1", "PRICE2"], priority: 2, hypotheses: [] }],
    derived: [], segments: [],
  };
  const changes = retagPlanHypotheses(def, plan);
  assert.deepEqual(plan.crosstabs[0].hypotheses, [], "region says nothing about price");
  assert.equal(plan.crosstabs[0].priority, 2, "an item that no longer answers a hypothesis is profiling");
  assert.deepEqual(plan.crosstabs[1].hypotheses, ["H1", "H2"].filter((h) => h === "H1" || plan.crosstabs[1].hypotheses.includes(h)));
  assert.ok(plan.crosstabs[1].hypotheses.includes("H1"));
  assert.equal(plan.crosstabs[1].priority, 1, "an item that reads both sides is raised");
  assert.ok(plan.tests[0].hypotheses.includes("H1"));
  assert.ok(changes.some((c) => c.id === "a" && c.after.length === 0));
  /* H3 names a group ("women") the design has no construct for — a tag the builder gave is not guessed away */
  const keep: AnalysisPlan = { crosstabs: [{ id: "k", rows: ["SWITCH"], columns: ["REGION"], priority: 1, hypotheses: ["H9"] }], tests: [], derived: [], segments: [] };
  retagPlanHypotheses(def, keep);
  assert.deepEqual(keep.crosstabs[0].hypotheses, ["H9"], "no hypothesis H9 to judge it by");
});

test("P-8: a difference hypothesis is served by the outcome across the group it names — and by no other cut", () => {
  const def = survey({}, [{}, {}, { type: "difference", direction: "positive", group: "women", lower: "men", dependent: "Switching" }]);
  const plan: AnalysisPlan = {
    crosstabs: [
      { id: "g", rows: ["SWITCH"], columns: ["GENDER"], priority: 2, hypotheses: [] },
      { id: "r", rows: ["SWITCH"], columns: ["REGION"], priority: 1, hypotheses: ["H3"] },
    ],
    tests: [], derived: [], segments: [],
  };
  retagPlanHypotheses(def, plan);
  assert.deepEqual(plan.crosstabs[0].hypotheses, ["H3"], "gender is the group the hypothesis names");
  assert.deepEqual(plan.crosstabs[1].hypotheses, [], "region is not");
});

test("P-8: a hypothesis that names a moderator gets a moderation test; one the plan already has is not doubled", () => {
  const detail = [{}, { type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching", moderator: "Income" }, {}];
  /* the role inference already makes Income the model's moderator: nothing is added */
  const covered = buildAnalysisFramework(survey({}, detail, "moderator"), { now: "" });
  assert.equal(covered.tests.filter((t) => t.moderator === "INCOME" && t.outcome === "SWITCH").length, 1);
  /* Income is only a control by role, but H2 says it moderates: the interaction is planned, on the price score */
  const def = survey({}, detail, "control");
  const plan = buildAnalysisFramework(def, { now: "" });
  const mods = plan.tests.filter((t) => t.moderator === "INCOME" && t.outcome === "SWITCH");
  assert.equal(mods.length, 1, JSON.stringify(plan.tests.map((t) => [t.method, t.outcome, t.variables, t.moderator])));
  assert.ok(mods[0].hypotheses.includes("H2"));
  assert.equal(mods[0].priority, 1);
  assert.equal(mods[0].method, "regression");
  assert.match(mods[0].reason ?? "", /^H2 says INCOME changes how PRICE_PERCEPTION_SCORE affects SWITCH/);
  assert.deepEqual(mods[0].variables, ["PRICE_PERCEPTION_SCORE"], "a construct measured by two items is moderated through its score, not one arbitrary item");
  /* regenerating over the plan it made adds nothing and moves nothing */
  const again = buildAnalysisFramework(def, { now: "", previous: plan });
  assert.equal(again.tests.length, plan.tests.length);
  assert.deepEqual(again.tests.map((t) => t.id), plan.tests.map((t) => t.id));
  /* the statement alone is enough: "Income moderates the effect of price perception on switching" names its moderator in words */
  assert.equal(buildAnalysisFramework(survey({}, [{}, {}, {}], "control"), { now: "" }).tests.filter((t) => t.moderator === "INCOME").length, 1);
  /* …and a design whose hypotheses name no moderator proposes none */
  const plain = survey({}, [{}, {}, {}], "control");
  plain.research!.hypotheses = ["Price perception increases switching"];
  assert.equal(buildAnalysisFramework(plain, { now: "" }).tests.filter((t) => t.moderator).length, 0);
});

test("P-7: tiers — a hypothesis or a design demand is essential, profiling is recommended, a sample profile is exploratory; a stored tier wins", () => {
  assert.equal(planTierOf({ id: "x", rows: ["A"], columns: ["B"], priority: 1, hypotheses: ["H1"] }), "essential");
  assert.equal(planTierOf({ id: "x", rows: ["A"], columns: ["B"], priority: 2, hypotheses: [] }), "recommended");
  assert.equal(planTierOf({ id: "x", rows: ["A"], columns: ["B"], priority: 1, hypotheses: [] }), "recommended", "priority 1 with nothing to answer is not essential");
  assert.equal(planTierOf({ id: "x", rows: ["A"], columns: ["B"], priority: 3, hypotheses: [] }), "exploratory");
  assert.equal(planTierOf({ id: "t", method: "nps", variables: ["N"], priority: 1, hypotheses: [] }), "essential", "the type demands it");
  assert.equal(planTierOf({ id: "t", method: "t_test", outcome: "Y", variables: [], groupBy: "G", priority: 1, hypotheses: [], reason: "between-arms comparison: …" }), "essential");
  assert.equal(planTierOf({ id: "x", rows: ["A"], columns: ["B"], priority: 1, hypotheses: ["H1"], tier: "exploratory" }), "exploratory", "the researcher's choice");
});

test("P-7: the cap keeps every essential item, fills with the rest by tier, never un-applies a saved one — and lists what it left out", () => {
  const xs = Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, rows: [`R${i}`], columns: ["C"], priority: i < 5 ? 1 : i < 40 ? 2 : 3, hypotheses: i < 5 ? ["H1"] : [] }));
  const plan: AnalysisPlan = { crosstabs: xs, tests: [], derived: [], segments: [] };
  const scope = planScope(plan);
  assert.equal(scope.inScope.size, PLAN_ITEM_CAP);
  for (let i = 0; i < 5; i++) assert.ok(scope.inScope.has(`x${i}`), "essential always");
  assert.equal(scope.notShown.length, 70 - PLAN_ITEM_CAP);
  assert.ok(scope.notShown.every((n) => n.tier === "exploratory" && /beyond the 40/.test(n.why)));
  assert.deepEqual(scope.tiers, { essential: 5, recommended: 35, exploratory: 30 });
  /* what is already applied stays */
  const kept = planScope(plan, { keep: new Set(["x69"]) });
  assert.ok(kept.inScope.has("x69"));
  assert.ok(!kept.notShown.some((n) => n.id === "x69"));
  /* the essential items are never cut, even beyond the cap */
  const many: AnalysisPlan = { crosstabs: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, rows: ["A"], columns: [`C${i}`], priority: 1, hypotheses: ["H1"] })), tests: [], derived: [], segments: [] };
  assert.equal(planScope(many).inScope.size, 50);
  assert.equal(planScope(many).notShown.length, 0);
});

test("P-9: a derived variable the run could not compute is found in the plan", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "T" },
    research: { objective: "O", population: "P", methodology: "M", sampleSize: 100, hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "SAT", type: "single_select", text: "Satisfaction", options: five },
      { id: "q2", code: "Q2", variableName: "WHY", type: "open_text", text: "Why?" },
      { id: "q3", code: "Q3", variableName: "BRAND", type: "single_select", text: "Brand?", options: opts("A", "B", "C", "D") },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "P", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
  });
  const plan: AnalysisPlan = {
    crosstabs: [], tests: [], segments: [],
    derived: [
      { name: "OK", kind: "top_box", from: ["SAT"] },
      { name: "TXT", kind: "mean_score", from: ["SAT", "WHY"] },
      { name: "TB_BRAND", kind: "top_box", from: ["BRAND"] },
      { name: "RC", kind: "recode", from: ["SAT"] },
      { name: "FL", kind: "flag", from: ["BRAND"], expression: "BRAND = 1" },
      { name: "AVG_BRAND", kind: "mean_score", from: ["BRAND"] },
      { name: "SELF", kind: "index", from: ["SELF"], expression: "SELF + 1" },
      { name: "L1", kind: "index", from: ["L2"], expression: "L2" }, { name: "L2", kind: "index", from: ["L1"], expression: "L1" },
      { name: "OK", kind: "sum_score", from: ["SAT"] },
    ],
  };
  const byName = (n: string) => derivedProblems(def, plan).filter((p) => p.name === n);
  assert.equal(byName("TXT")[0]?.level, "critical");
  assert.match(byName("TXT")[0].message, /open text/);
  assert.equal(byName("TB_BRAND")[0]?.level, "critical");
  assert.match(byName("TB_BRAND")[0].message, /needs a rating scale/);
  assert.equal(byName("RC")[0]?.level, "critical");
  assert.match(byName("RC")[0].message, /no expression/);
  assert.deepEqual(byName("FL"), [], "a flag with its expression is fine");
  assert.equal(byName("AVG_BRAND")[0]?.level, "warning", "computable but meaningless");
  assert.match(byName("SELF")[0].message, /built from itself/);
  assert.match(byName("L1")[0].message, /through other derived variables/);
  assert.ok(byName("OK").some((p) => /defined twice/.test(p.message)));
  assert.ok(!byName("OK").some((p) => p.level === "critical" && /top box|open text/.test(p.message)), "the valid top box is not flagged");
  /* …and the plan review carries them, so they appear before anything runs */
  const withPlan = SurveyDefinition.parse({ ...def, research: { ...def.research, analysisPlan: plan } });
  const issues = reviewAnalysisPlan(withPlan);
  assert.ok(issues.some((i) => i.level === "critical" && /Derived variable TXT/.test(i.message)));
});

test("the plan review says so when a saved or hand-edited plan tags an item with a hypothesis it does not read", () => {
  const def = survey({
    crosstabs: [{ id: "a", rows: ["SWITCH"], columns: ["REGION"], priority: 1, hypotheses: ["H1"] }],
  });
  const issues = reviewAnalysisPlan(def).filter((i) => i.itemId === "a" && /does not read what it is about/.test(i.message));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "suggestion");
});
