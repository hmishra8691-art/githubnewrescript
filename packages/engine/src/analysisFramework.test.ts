import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  measurementOf, inferRole, inferQuestionAnalysis, buildAnalysisFramework, prioritizeCrosstabs, hypothesisCoverage,
  analysisDependencies, describeAnalysisImpact, reviewAnalysisPlan, methodologyAdvice,
  coerceSurveyActions, applySurveyActions, reviewSurvey, removeQuestion, referencesTo, applyRename, variableUsages,
} from "./index.js";

/*
 * THE ANALYSIS FRAMEWORK — planned before fieldwork (Phase 2 of the
 * research-intelligence brief): what each question is for, the tables and
 * tests the design implies, hypothesis coverage, and what deleting a
 * question breaks in the analysis.
 */

const scale = (n = 5) => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"][i] ?? String(i + 1) }));
const opts = (...labels: string[]) => labels.map((l, i) => ({ code: i + 1, label: l }));

function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Brand choice", version: "1.0" },
    research: {
      objective: "Why consumers choose Brand A over Brand B",
      hypotheses: ["Brand trust increases purchase intention", "Price perception moderates the effect of trust on purchase intention", "Advertising exposure raises awareness"],
      population: "US and UK adults 18–45",
      constructs: [
        { name: "Brand trust", role: "independent", questionIds: ["t1", "t2"] },
        { name: "Price perception", role: "moderator", questionIds: ["price"] },
        { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
        { name: "Advertising exposure", role: "independent", questionIds: ["ad"] },
        { name: "Awareness", role: "dependent", questionIds: ["aware"] },
      ],
      analysis: [], assumptions: [], sources: [],
    },
    questions: [
      { id: "age", code: "S1", variableName: "AGE", type: "single_select", text: "How old are you?", options: opts("18–24", "25–34", "35–45", "46+"),
        skipLogic: [{ id: "sk", when: { type: "rule", source: { kind: "question", ref: "AGE" }, operator: "eq", value: 4 }, target: { kind: "terminate", status: "screened" } }] },
      { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
      { id: "country", code: "S3", variableName: "COUNTRY", type: "single_select", text: "Which country do you live in?", options: opts("US", "UK") },
      { id: "aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Which of these brands have you heard of?", options: opts("Brand A", "Brand B", "Brand C") },
      { id: "ad", code: "Q2", variableName: "AD_EXPOSE", type: "single_select", text: "Have you seen advertising for Brand A recently?", options: opts("Yes", "No") },
      { id: "t1", code: "Q3", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
      { id: "t2", code: "Q4", variableName: "TRUST_2", type: "single_select", text: "Brand A is honest", options: scale() },
      { id: "price", code: "Q5", variableName: "PRICE_PERC", type: "single_select", text: "Brand A is good value", options: scale() },
      { id: "pi", code: "Q6", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: scale() },
      { id: "why", code: "Q7", variableName: "WHY", type: "long_text", text: "Why?" },
      { id: "md", code: "Q8", variableName: "FEATURES", type: "maxdiff_task", text: "Features", options: opts("Price", "Taste", "Pack", "Brand") },
      { id: "nps", code: "Q9", variableName: "NPS", type: "nps", text: "Recommend?", options: Array.from({ length: 11 }, (_, i) => ({ code: i, label: String(i) })) },
      { id: "intro", code: "T1", variableName: "T1", type: "html", text: "Welcome" },
    ],
    flow: [
      { type: "block", id: "b0", title: "Screening", children: [{ type: "page", id: "p0", questionIds: ["intro", "age", "gender", "country"] }] },
      { type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["aware", "ad", "t1", "t2", "price", "pi", "why", "md", "nps"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}
const q = (def: SurveyDefinition, id: string) => def.questions.find((x) => x.id === id)!;

test("measurement levels come from the type; an ordered scale is ordinal, a plain list nominal; the researcher can override", () => {
  const def = survey();
  assert.equal(measurementOf(q(def, "t1")), "ordinal");
  assert.equal(measurementOf(q(def, "gender")), "nominal");
  assert.equal(measurementOf(q(def, "aware")), "multi");
  assert.equal(measurementOf(q(def, "why")), "text");
  assert.equal(measurementOf(q(def, "md")), "choice");
  assert.equal(measurementOf(q(def, "nps")), "interval");
  assert.equal(measurementOf({ ...q(def, "t1"), analysis: { measurement: "interval", primary: [], crosstabBy: [], modeling: [], relatedTo: [], hypotheses: [] } }), "interval");
  assert.equal(measurementOf({ ...q(def, "gender"), type: "numeric" }), "ratio");
});

test("roles: the construct's role, else screening from a screen-out skip, segmentation from demographics, descriptive otherwise", () => {
  const def = survey();
  assert.equal(inferRole(def, q(def, "pi")), "dependent");
  assert.equal(inferRole(def, q(def, "t1")), "independent");
  assert.equal(inferRole(def, q(def, "price")), "moderator");
  assert.equal(inferRole(def, q(def, "age")), "screening", "it screens out");
  assert.equal(inferRole(def, q(def, "gender")), "segmentation", "by name");
  assert.equal(inferRole(def, q(def, "country")), "segmentation", "by text");
  assert.equal(inferRole(def, q(def, "why")), "descriptive");
  assert.equal(inferRole(def, q(def, "intro")), "descriptive");
  const a = inferQuestionAnalysis(def, q(def, "pi"));
  assert.equal(a.construct, "Purchase intention");
  assert.deepEqual(a.primary, ["frequencies", "top_box", "mean"]);
  assert.deepEqual(a.crosstabBy, ["GENDER", "COUNTRY"], "an outcome is cut by the segmentation variables, not by the screener");
  assert.deepEqual(a.hypotheses, ["H1", "H2"], "the hypotheses that name its construct");
  assert.ok(a.relatedTo.includes("TRUST_1") && a.relatedTo.includes("PRICE_PERC") && !a.relatedTo.includes("GENDER"));
  assert.deepEqual(a.modeling, ["regression"]);
  assert.ok(a.inferred.includes("role") && a.inferred.includes("crosstabBy"));
  /* explicit wins field by field */
  const pi = { ...q(def, "pi"), analysis: { role: "control" as const, primary: ["mean" as const], crosstabBy: ["AGE"], modeling: [], relatedTo: [], hypotheses: ["H3"] } };
  const b = inferQuestionAnalysis(def, pi);
  assert.equal(b.role, "control"); assert.deepEqual(b.primary, ["mean"]); assert.deepEqual(b.crosstabBy, ["AGE"]); assert.deepEqual(b.hypotheses, ["H3"]);
  assert.ok(!b.inferred.includes("role"));
});

test("the framework the design implies: banner crosstabs per outcome, IV × DV tables and tests by measurement level, one model per outcome, what the types demand", () => {
  const def = survey();
  const plan = buildAnalysisFramework(def, { now: "2026-10-04T00:00:00Z" });
  assert.equal(plan.source, "engine");
  const banner = plan.crosstabs.find((x) => x.rows[0] === "PURCHASE_INT" && x.columns.length > 1)!;
  assert.deepEqual(banner.columns, ["GENDER", "COUNTRY"]);
  assert.equal(banner.priority, 1, "a hypothesis names purchase intention");
  assert.deepEqual(banner.hypotheses, ["H1", "H2"]);
  assert.ok(plan.crosstabs.some((x) => x.rows[0] === "AWARE" && x.columns[0] === "AD_EXPOSE"), "awareness by exposure: categorical × categorical");
  assert.ok(!plan.crosstabs.some((x) => x.rows[0] === "PURCHASE_INT" && x.columns[0] === "TRUST_1"), "ordinal scale × scale is a correlation, not a table");
  assert.ok(plan.crosstabs.some((x) => x.priority === 3 && x.reason === "sample profile"));
  const corr = plan.tests.filter((t) => t.method === "correlation" && t.outcome === "PURCHASE_INT").map((t) => t.variables[0]);
  assert.deepEqual(corr.sort(), ["PRICE_PERC", "TRUST_1", "TRUST_2"]);
  const chi = plan.tests.find((t) => t.method === "chi_square" && t.outcome === "AWARE")!;
  assert.equal(chi.variables[0], "AD_EXPOSE");
  assert.deepEqual(chi.hypotheses, ["H3"]);
  const reg = plan.tests.find((t) => t.method === "regression" && t.outcome === "PURCHASE_INT")!;
  assert.deepEqual(reg.variables.sort(), ["AD_EXPOSE", "TRUST_1", "TRUST_2"], "every scale or binary predictor");
  assert.equal(reg.moderator, "PRICE_PERC", "the moderator enters as an interaction");
  assert.equal(reg.priority, 1);
  assert.ok(plan.tests.some((t) => t.method === "maxdiff_scores" && t.variables[0] === "FEATURES"));
  assert.ok(plan.tests.some((t) => t.method === "nps" && t.variables[0] === "NPS"));
  const rel = plan.tests.find((t) => t.method === "reliability")!;
  assert.deepEqual(rel.variables, ["TRUST_1", "TRUST_2"]);
  assert.ok(plan.derived.some((d) => d.name === "BRAND_TRUST_SCORE" && d.kind === "mean_score" && d.from.length === 2));
  assert.ok(plan.derived.some((d) => d.name === "PURCHASE_INT_T2B" && d.kind === "top_box"));
  assert.deepEqual(plan.segments.map((s) => s.by[0]), ["GENDER", "COUNTRY"]);
  /* the most important tables: hypothesis-linked first, then by priority */
  const top = prioritizeCrosstabs(def, 3, plan);
  assert.equal(top[0].rows[0], "PURCHASE_INT");
  assert.ok(top.every((x) => x.priority <= 2));
  assert.ok(!top.some((x) => x.reason === "sample profile"));
});

test("hypothesis coverage: measured and planned → testable; a construct without a question → unmeasured; a hypothesis naming nothing → unlinked", () => {
  const def = survey();
  let cov = hypothesisCoverage(def);
  assert.equal(cov.length, 3);
  assert.equal(cov[0].status, "partly", "measured, nothing planned yet");
  assert.deepEqual(cov[0].constructs.map((c) => c.name), ["Brand trust", "Purchase intention"]);
  def.research!.analysisPlan = buildAnalysisFramework(def);
  cov = hypothesisCoverage(def);
  assert.equal(cov[0].status, "testable");
  assert.ok(cov[0].tests.some((t) => t.method === "regression"));
  assert.equal(cov[1].status, "testable");
  def.research!.constructs[2].questionIds = [];
  assert.equal(hypothesisCoverage(def)[0].status, "unmeasured");
  def.research!.hypotheses.push("Loyalty programmes drive repeat purchase");
  assert.equal(hypothesisCoverage(def)[3].status, "unlinked");
  /* a tagged question links a hypothesis without a construct */
  q(def, "nps").analysis = { hypotheses: ["H4"], primary: [], crosstabBy: [], modeling: [], relatedTo: [] };
  assert.equal(hypothesisCoverage(def)[3].status, "partly");
});

test("deleting a question says what it breaks in the analysis, and the plan is pruned — not left pointing at nothing", () => {
  const def = survey();
  def.research!.analysisPlan = buildAnalysisFramework(def);
  const deps = analysisDependencies(def, "pi");
  assert.deepEqual(deps.constructs, ["Purchase intention"]);
  assert.deepEqual(deps.hypotheses, ["H1", "H2"]);
  assert.ok(deps.crosstabs.length >= 1 && deps.tests.length >= 4 && deps.derived.some((d) => d.name === "PURCHASE_INT_T2B"));
  const words = describeAnalysisImpact(def, "pi");
  assert.match(words[0], /measures “Purchase intention” \(H1, H2\)/);
  assert.ok(words.some((w) => /planned crosstab/.test(w)) && words.some((w) => /planned tests? \(/.test(w)) && words.some((w) => /PURCHASE_INT_T2B/.test(w)));
  assert.deepEqual(describeAnalysisImpact(def, "why"), [], "nothing in the plan reads the open end");
  /* the engine's delete prunes the plan and reports it */
  const refs = referencesTo(def, "gender");
  assert.ok(refs.some((r) => /Analysis plan — crosstab/.test(r.where) && /taken out/.test(r.effect)), JSON.stringify(refs));
  assert.ok(refs.some((r) => /Analysis plan — segment/.test(r.where) && /removed/.test(r.effect)));
  removeQuestion(def, "gender");
  const plan = def.research!.analysisPlan!;
  assert.ok(!plan.crosstabs.some((x) => x.columns.includes("GENDER") || x.rows.includes("GENDER")));
  assert.ok(!plan.segments.some((s) => s.by.includes("GENDER")));
  assert.ok(plan.crosstabs.some((x) => x.rows[0] === "PURCHASE_INT" && x.columns.join() === "COUNTRY"), "the banner keeps its remaining column");
  /* deleting the outcome removes the tests that lost it, and the construct says so */
  const refs2 = referencesTo(def, "pi");
  assert.ok(refs2.some((r) => /construct “Purchase intention”/.test(r.where) && /no longer measured/.test(r.effect)));
  removeQuestion(def, "pi");
  assert.ok(!plan.tests.some((t) => t.outcome === "PURCHASE_INT"));
  assert.ok(!plan.derived.some((d) => d.name === "PURCHASE_INT_T2B"));
  assert.ok(plan.tests.some((t) => t.method === "reliability"), "the trust reliability is untouched");
  assert.equal(reviewAnalysisPlan(def).filter((i) => i.level === "critical").length, 0, "nothing dead is left behind");
});

test("renaming a variable follows it into the plan and the questions' analysis", () => {
  const def = survey();
  def.research!.analysisPlan = buildAnalysisFramework(def);
  q(def, "pi").analysis = { crosstabBy: ["GENDER"], relatedTo: ["TRUST_1"], primary: [], modeling: [], hypotheses: [] };
  const uses = variableUsages(def, "TRUST_1");
  assert.ok(uses.some((u) => u.kind === "analysis" && /Q6 — analysis \(related to\)/.test(u.where)));
  assert.ok(uses.some((u) => u.kind === "analysis" && /Analysis plan — correlation/.test(u.where)));
  assert.ok(uses.some((u) => u.kind === "analysis" && /derived variable BRAND_TRUST_SCORE/.test(u.where)));
  const next = applyRename(def, "TRUST_1", "TRUST_PROMISES");
  const plan = next.research!.analysisPlan!;
  assert.ok(!JSON.stringify(plan).includes('"TRUST_1"'));
  assert.ok(plan.tests.some((t) => t.method === "correlation" && t.variables[0] === "TRUST_PROMISES"));
  assert.ok(plan.derived.find((d) => d.name === "BRAND_TRUST_SCORE")!.from.includes("TRUST_PROMISES"));
  assert.deepEqual(q(next, "pi").analysis!.relatedTo, ["TRUST_PROMISES"]);
  assert.deepEqual(q(next, "pi").analysis!.crosstabBy, ["GENDER"], "others untouched");
});

test("the review catches a plan that no longer fits the survey: dead references, a t-test on three groups, chi-square on a number, a tagged hypothesis that does not exist", () => {
  const def = survey();
  def.research!.analysisPlan = {
    crosstabs: [{ id: "x1", rows: ["PURCHASE_INT"], columns: ["REGION"], priority: 1, hypotheses: [] }, { id: "x2", rows: ["GENDER"], columns: ["GENDER"], priority: 2, hypotheses: [] }],
    tests: [
      { id: "t1", method: "t_test", outcome: "PURCHASE_INT", variables: [], groupBy: "GENDER", priority: 1, hypotheses: [] },
      { id: "t2", method: "chi_square", outcome: "AWARE", variables: ["NPS"], priority: 1, hypotheses: [] },
      { id: "t3", method: "maxdiff_scores", variables: ["PURCHASE_INT"], priority: 1, hypotheses: [] },
      { id: "t4", method: "logistic_regression", outcome: "PURCHASE_INT", variables: ["TRUST_1"], priority: 1, hypotheses: [] },
    ],
    derived: [{ name: "AGE", kind: "top_box", from: ["PURCHASE_INT"] }], segments: [],
  };
  q(def, "pi").analysis = { hypotheses: ["H9"], primary: [], crosstabBy: ["ZZZ"], modeling: [], relatedTo: [] };
  const issues = reviewAnalysisPlan(def);
  const msgs = issues.map((i) => `${i.level}: ${i.message}`);
  assert.ok(msgs.some((m) => /critical: Planned crosstab x1 reads REGION, which is not in the survey/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /warning: Planned crosstab x2 tabulates GENDER against itself/.test(m)));
  assert.ok(msgs.some((m) => /A t-test compares two groups, but S2 has 3 — use ANOVA/.test(m)));
  assert.ok(msgs.some((m) => /A chi-square needs categories/.test(m)));
  assert.ok(msgs.some((m) => /critical: MaxDiff scores are planned on PURCHASE_INT, but none is a MaxDiff/.test(m)));
  assert.ok(msgs.some((m) => /Logistic regression needs a two-category outcome; Q6/.test(m)));
  assert.ok(msgs.some((m) => /Derived variable AGE has the same name as an existing variable/.test(m)));
  assert.ok(msgs.some((m) => /Q6's analysis names ZZZ/.test(m)));
  assert.ok(msgs.some((m) => /Q6 is tagged with H9, but the research design has 3 hypotheses/.test(m)));
  /* and it reaches the survey review, as analysis / hypothesis findings */
  const rv = reviewSurvey(def);
  assert.ok(rv.findings.some((f) => f.category === "analysis" && /REGION/.test(f.message)));
  assert.ok(rv.findings.some((f) => f.category === "hypothesis" && /H9/.test(f.message)));
  /* a clean plan has nothing to say */
  const clean = survey();
  clean.research!.analysisPlan = buildAnalysisFramework(clean);
  assert.deepEqual(reviewAnalysisPlan(clean).filter((i) => i.level !== "suggestion"), []);
});

test("the analysis actions: the gate refuses what the platform cannot run, apply resolves every variable against the survey, and nothing else changes", () => {
  const def = survey();
  const { actions, rejected } = coerceSurveyActions([
    { op: "set_question_analysis", target: "Q6", role: "dependent", measurement: "interval", primary: ["mean", "top box"], crosstabBy: ["S2", "COUNTRY", "Q6"], hypotheses: ["h1", "H2"], construct: "Purchase intention" },
    { op: "set_question_analysis", target: "Q3", role: "cause" },
    { op: "add_analysis_test", method: "bayesian_network", outcome: "Q6" },
    { op: "add_crosstab", rows: ["Q6"], columns: ["S2", "S3"], priority: 1, hypotheses: ["H1"], reason: "intent by profile" },
    { op: "add_crosstab", rows: ["Q6"], columns: ["NOPE"] },
    { op: "add_analysis_test", method: "anova", outcome: "Q6", groupBy: "S1", hypotheses: ["H1"] },
    { op: "add_analysis_test", method: "regression", outcome: "Q6", predictors: ["Q3", "Q4"], moderator: "Q5", hypotheses: ["H2"] },
    { op: "add_derived_variable", name: "trust score", kind: "mean_score", from: ["Q3", "Q4"] },
    { op: "add_derived_variable", name: "AGE", kind: "top_box", from: ["Q6"] },
    { op: "set_question_analysis", target: "Q7" },
  ]);
  assert.deepEqual(rejected.map((r) => r.index), [1, 2, 9], JSON.stringify(rejected));
  assert.match(rejected[0].reason, /not a variable role/);
  assert.match(rejected[1].reason, /not an analysis method/);
  const before = JSON.stringify({ ...def, research: undefined });
  const out = applySurveyActions(def, actions, { now: "2026-10-04T00:00:00Z" });
  assert.ok(out.valid);
  assert.equal(out.errors.length, 2, out.errors.join("\n"));
  assert.match(out.errors[0], /names “NOPE”, which is not a question/);
  assert.match(out.errors[1], /AGE is already a variable/);
  const pi = q(out.def, "pi").analysis!;
  assert.equal(pi.role, "dependent"); assert.equal(pi.measurement, "interval");
  assert.deepEqual(pi.primary, ["mean", "top_box"], "methods normalised");
  assert.deepEqual(pi.crosstabBy, ["GENDER", "COUNTRY"], "resolved to variable names, the question itself dropped");
  assert.deepEqual(pi.hypotheses, ["H1", "H2"]);
  const plan = out.def.research!.analysisPlan!;
  assert.equal(plan.crosstabs.length, 1);
  assert.deepEqual(plan.crosstabs[0].columns, ["GENDER", "COUNTRY"]);
  const reg = plan.tests.find((t) => t.method === "regression")!;
  assert.deepEqual(reg.variables, ["TRUST_1", "TRUST_2"]); assert.equal(reg.moderator, "PRICE_PERC"); assert.equal(reg.outcome, "PURCHASE_INT");
  assert.ok(plan.tests.some((t) => t.method === "anova" && t.groupBy === "AGE"));
  assert.ok(plan.derived.some((d) => d.name === "TRUST_SCORE"));
  /* only the analysis changed */
  const after = JSON.stringify({ ...out.def, research: undefined, questions: out.def.questions.map((x) => ({ ...x, analysis: undefined })) });
  assert.equal(after, JSON.stringify({ ...JSON.parse(before), questions: def.questions.map((x) => ({ ...x, analysis: undefined })) }));
  assert.ok(out.results.every((r) => !r.destructive), "adding to the plan is not destructive");
  /* a construct the action names joins the research design */
  const c = out.def.research!.constructs.find((x) => x.name === "Purchase intention")!;
  assert.ok(c.questionIds.includes("pi"));
  /* removing is destructive and says so; the engine's plan replaces with a warning when one exists */
  const rm = applySurveyActions(out.def, coerceSurveyActions([{ op: "remove_analysis_test", id: reg.id }, { op: "propose_analysis_plan" }]).actions);
  assert.ok(rm.destructive.some((d) => /Removes the planned regression/.test(d)));
  assert.ok(rm.destructive.some((d) => /Replaces the analysis plan/.test(d)));
  assert.equal(rm.def.research!.analysisPlan!.source, "engine");
  /* merge keeps what is there */
  const merged = applySurveyActions(out.def, coerceSurveyActions([{ op: "propose_analysis_plan", merge: true }]).actions);
  assert.ok(merged.def.research!.analysisPlan!.crosstabs.some((x) => x.reason === "intent by profile"));
  assert.ok(merged.def.research!.analysisPlan!.crosstabs.length > 1);
  assert.equal(merged.destructive.length, 0);
  /* delete_question carries the analysis impact in its destructive note */
  const del = applySurveyActions(out.def, coerceSurveyActions([{ op: "delete_question", target: "Q6" }]).actions);
  assert.match(del.destructive[0], /in the analysis, it measures “Purchase intention” \(H1, H2\); 1 planned crosstab reads it; 2 planned tests \(anova, regression\)/);
});

test("methodology advice: the goal picks the method and names the trade-offs; a goal that decides nothing gets null", () => {
  const a = methodologyAdvice("I want to understand which product features consumers value most")!;
  assert.equal(a.recommended, "MaxDiff (best–worst scaling)");
  assert.deepEqual(a.options.map((o) => o.method).slice(1), ["Ranking", "Rating scales", "Choice-based conjoint"]);
  assert.ok(a.options[0].tradeoffs.some((t) => /price/.test(t)));
  assert.equal(methodologyAdvice("which features matter most, and the trade-off against price")!.recommended, "Choice-based conjoint");
  assert.equal(methodologyAdvice("what price should we charge")!.recommended, "Van Westendorp price sensitivity");
  assert.equal(methodologyAdvice("demand at different price points")!.recommended, "Gabor–Granger");
  assert.equal(methodologyAdvice("what drives satisfaction")!.recommended, "Key driver analysis");
  assert.equal(methodologyAdvice("test three concepts for a new beverage")!.recommended, "Sequential monadic");
  assert.equal(methodologyAdvice("brand awareness tracking")!.recommended, "Brand funnel");
  assert.equal(methodologyAdvice("which ad creative works better")!.recommended, "A/B (split) test");
  assert.equal(methodologyAdvice("how old are respondents"), null);
});
