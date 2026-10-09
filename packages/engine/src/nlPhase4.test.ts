import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { applySurveyActions } from "./surveyActions.js";
import { parseDataQuestion, defaultCuts } from "./dataQuestion.js";

/*
 * RESEARCH ENGINE AUDIT, PHASE 4 — the analysis layer reached by sentence:
 * tests planned by name or chosen from the variables' levels, the plan
 * queried for what reads a variable, a planned item removed, and data
 * questions read into queries the Studio answers on the dataset. The
 * engine has no data: a data question is a `query`, never a guess.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(plan = true): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching", "Women are more satisfied than men"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }], analysis: [], assumptions: [], sources: [],
      ...(plan ? { analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H2"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H2"] }, { id: "t2", method: "chi_square", outcome: "SWITCHED", variables: ["SWITCHED"], groupBy: "PRICE_PERC", priority: 1, hypotheses: ["H1"] }, { id: "t3", method: "correlation", variables: ["PRICE_SCORE", "SAT"], priority: 2, hypotheses: [] }], derived: [{ name: "PRICE_SCORE", kind: "mean_score", from: ["PRICE_PERC"] }], segments: [] } } : {}) },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B", "Brand C"), analysis: { role: "dependent", hypotheses: ["H1"] } },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No"), analysis: { role: "dependent", hypotheses: ["H1"] } },
      { id: "q5", code: "Q5", variableName: "AWARE", type: "multi_select", text: "Which brands are you aware of?", options: opts("Brand A", "Brand B", "Brand C") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value for money", options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5", "6", "7"), analysis: { role: "dependent", hypotheses: ["H2"] } },
      { id: "q8", code: "Q8", variableName: "NPS", type: "nps", text: "How likely are you to recommend your brand?" },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East") },
      { id: "q10", code: "Q10", variableName: "COMMENTS", type: "open_text", text: "Anything else?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q5", "q6", "q7", "q8"] }] },
      { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: ["q9", "q10"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}
type Actions = Extract<Interpretation, { kind: "actions" }>;
type Query = Extract<Interpretation, { kind: "query" }>;
const actionsOf = (r: Interpretation): Actions => { assert.equal(r.kind, "actions", JSON.stringify(r)); return r as Actions; };
const queryOf = (r: Interpretation): Query => { assert.equal(r.kind, "query", JSON.stringify(r)); return r as Query; };
const applied = (def: SurveyDefinition, r: Interpretation) => { const a = actionsOf(r); const out = applySurveyActions(def, a.actions); assert.ok(out.valid && out.results.every((x) => x.ok), JSON.stringify(out.errors)); return out.def; };
const refusal = (r: Interpretation, re: RegExp, noop?: boolean) => { assert.equal(r.kind, "refused", JSON.stringify(r)); const x = r as Extract<Interpretation, { kind: "refused" }>; assert.match(x.reason, re); if (noop !== undefined) assert.equal(!!x.noop, noop, "noop"); };

test("tests by sentence: the method named, or chosen from the levels; the numeric side is the outcome; wrong pairings are refused with the right method; an already planned test is a no-op", () => {
  const def = survey();
  // chosen from the levels: NPS (interval) by REGION (3 groups) → ANOVA; by GENDER (3 groups incl. prefer not to say) → ANOVA; SWITCHED by REGION → chi-square; AGE with NPS → correlation
  let r = interpretRequest(def, "test whether NPS differs by region");
  let a = actionsOf(r);
  assert.deepEqual(a.actions, [{ op: "add_analysis_test", method: "anova", outcome: "NPS", variables: ["NPS"], groupBy: "REGION", priority: 1, reason: "asked for in Intelligent mode: NPS by region" }]);
  assert.match(a.understood, /^Plan an ANOVA of NPS \(Q8\) across REGION — NPS is interval and REGION has 3 groups\. It runs from the Analysis tab/);
  const after = applied(def, r);
  assert.equal(after.research!.analysisPlan!.tests.length, 4);
  assert.deepEqual(actionsOf(interpretRequest(def, "test whether switching differs by region")).actions.map((x) => (x as { method: string }).method), ["chi_square"]);
  assert.deepEqual(actionsOf(interpretRequest(def, "check if age varies with NPS")).actions, [{ op: "add_analysis_test", method: "correlation", variables: ["AGE", "NPS"], priority: 1, reason: "asked for in Intelligent mode: age by NPS" }]);
  // named: the group side is the demographic whichever order the sentence used
  a = actionsOf(interpretRequest(def, "Run a t-test of region by NPS"));
  assert.deepEqual(a.actions, [{ op: "add_analysis_test", method: "t_test", outcome: "NPS", variables: ["NPS"], groupBy: "REGION", priority: 1, reason: "asked for in Intelligent mode: region by NPS" }]);
  assert.match(a.understood, /REGION has 3 groups — only the first two are compared; an ANOVA reads all of them/);
  assert.deepEqual(actionsOf(interpretRequest(def, "add a chi-square of brand preference by region")).actions, [{ op: "add_analysis_test", method: "chi_square", outcome: "BRAND_PREF", variables: ["BRAND_PREF"], groupBy: "REGION", priority: 1, reason: "asked for in Intelligent mode: brand preference by region" }]);
  assert.deepEqual(actionsOf(interpretRequest(def, "correlate satisfaction with NPS")).actions, [{ op: "add_analysis_test", method: "correlation", variables: ["SAT", "NPS"], priority: 1, reason: "asked for in Intelligent mode: satisfaction by NPS" }]);
  assert.deepEqual(actionsOf(interpretRequest(def, "regress NPS on satisfaction")).actions, [{ op: "add_analysis_test", method: "regression", outcome: "NPS", variables: ["SAT"], priority: 1, reason: "asked for in Intelligent mode: NPS by satisfaction" }]);
  assert.deepEqual(actionsOf(interpretRequest(def, "plan a Mann-Whitney test of NPS by switching")).actions.map((x) => (x as { method: string; groupBy: string }).groupBy), ["SWITCHED"]);
  // a chi-square reads an ordinal scale, an agreement scale, a yes/no — not an open number
  assert.deepEqual(actionsOf(interpretRequest(def, "add a chi-square of satisfaction by gender")).actions.map((x) => (x as { method: string }).method), ["chi_square"]);
  refusal(interpretRequest(def, "add a chi-square of age by gender"), /^A chi-square needs two categorical variables — AGE is ratio\. Use a t-test or ANOVA/);
  refusal(interpretRequest(def, "run an anova of gender by region"), /^An ANOVA compares the means of a numeric or scale variable across groups — GENDER and REGION are both nominal\. Use a chi-square/);
  refusal(interpretRequest(def, "correlate gender with region"), /^A correlation needs two numeric or scale variables — GENDER is nominal, REGION is nominal\./);
  refusal(interpretRequest(def, "test whether comments differ by region"), /COMMENTS is text — no standard test compares it/);
  refusal(interpretRequest(def, "run a t-test of satisfaction by satisfaction"), /both resolve to Q7 — a test needs two different variables/);
  // already in the plan: nothing to add, said as a no-op
  refusal(interpretRequest(def, "run a t-test of satisfaction by gender"), /^A t-test of SAT \(Q7\) across GENDER is already in the analysis plan \(H2\) — nothing to add\./, true);
  // no plan yet: the sentence starts one
  const fresh = survey(false);
  assert.match(actionsOf(interpretRequest(fresh, "test whether NPS differs by region")).understood, /This starts the survey's analysis plan; it runs from the Analysis tab/);
  assert.equal(applied(fresh, interpretRequest(fresh, "test whether NPS differs by region")).research!.analysisPlan!.tests.length, 1);
  // an unknown variable, a two-question clause: the usual refusal and hand-off
  refusal(interpretRequest(def, "test whether the weather differs by region"), /No question measures “weather”/);
  assert.equal(interpretRequest(def, "run a t-test of satisfaction and NPS by region, then make Q1 required").kind, "model");
});

test("the plan queried for a variable: the crosstabs, tests, derived variables that read it, the hypotheses they serve; nothing said as nothing with the sentence to plan one", () => {
  const def = survey();
  let r = interpretRequest(def, "what analyses are planned for satisfaction");
  assert.equal(r.kind, "answer");
  let x = r as Extract<Interpretation, { kind: "answer" }>;
  assert.equal(x.answer, "SAT (Q7) is read by 1 crosstab, 2 tests in the saved plan, serving H2.");
  assert.deepEqual(x.sections.map((s) => [s.title, s.items.map((i) => i.label)]), [["Crosstabs", ["SAT by GENDER"]], ["Tests", ["t-test on SAT across GENDER with SAT", "correlation with PRICE_SCORE, SAT"]]]);
  assert.deepEqual(x.detected, [{ what: "variable", value: "SAT (Q7)" }]);
  // a derived variable counts, and so do the tests that read it
  x = interpretRequest(def, "is the price perception question in the analysis plan") as typeof x;
  assert.equal(x.kind, "answer");
  assert.equal(x.answer, "PRICE_PERC (Q6) is read by 2 tests, 1 derived variable in the saved plan, serving H1.", "the test that reads the derived score counts too");
  assert.deepEqual(x.sections.find((s) => s.title === "Derived variables")!.items, [{ label: "PRICE_SCORE", key: "analysis:derived:PRICE_SCORE", detail: "mean score of PRICE_PERC" }]);
  x = interpretRequest(def, "which tests use age") as typeof x;
  assert.equal(x.answer, "Nothing in the saved analysis plan reads AGE (Q1). It is a demographic — say “create the most important crosstabs” to cut the outcomes by it, or “cross-tab <outcome> by AGE”.");
  x = interpretRequest(def, "how will NPS be analysed") as typeof x;
  assert.equal(x.answer, "Nothing in the saved analysis plan reads NPS (Q8). Say “test whether NPS differs by <group>” or “cross-tab NPS by <demographic>” to plan one.");
  // with no saved plan the design's framework answers, and says it is unsaved
  x = interpretRequest(survey(false), "what analyses are planned for switching") as typeof x;
  assert.match(x.answer, /in the design's plan.* No plan is saved yet — say “create an analysis framework” to save it\.$/);
  r = interpretRequest(def, "what analyses are planned for the weather");
  assert.equal(r.kind, "refused");
});

test("a planned item removed by sentence: the crosstab, the test, or every analysis of the pair; nothing there is a refusal naming what the plan has", () => {
  const def = survey();
  let r = interpretRequest(def, "remove the crosstab of satisfaction by gender");
  assert.deepEqual(actionsOf(r).actions, [{ op: "remove_crosstab", id: "x1" }]);
  assert.equal(actionsOf(r).understood, "Remove the crosstab SAT by GENDER (H2) from the analysis plan.");
  assert.equal(applied(def, r).research!.analysisPlan!.crosstabs.length, 0);
  r = interpretRequest(def, "drop the t-test on satisfaction by gender");
  assert.deepEqual(actionsOf(r).actions, [{ op: "remove_analysis_test", id: "t1" }]);
  r = interpretRequest(def, "delete the analysis of gender by satisfaction");
  assert.deepEqual(actionsOf(r).actions, [{ op: "remove_crosstab", id: "x1" }, { op: "remove_analysis_test", id: "t1" }]);
  assert.deepEqual(actionsOf(interpretRequest(def, "remove the chi-square of switching by price perception")).actions, [{ op: "remove_analysis_test", id: "t2" }]);
  refusal(interpretRequest(def, "remove the t-test of switching by price perception"), /^The plan has no t-test of SWITCHED by PRICE_PERC\. It has: chi square on SWITCHED across PRICE_PERC with SWITCHED\.$/);
  refusal(interpretRequest(def, "remove the crosstab of NPS by region"), /^The plan has no crosstab of NPS by REGION\.$/);
  refusal(interpretRequest(def, "remove the crosstab of satisfaction by region"), /^The plan has no crosstab of SAT by REGION\. It has: crosstab SAT by GENDER; t-test on SAT across GENDER with SAT; correlation with PRICE_SCORE, SAT\.$/, false);
  refusal(interpretRequest(survey(false), "remove the crosstab of satisfaction by gender"), /No analysis plan is saved/);
});

test("data questions are read into queries — the option, the question, the cut, the population — and handed to the Studio; an option two questions share is a choice", () => {
  const def = survey();
  // which groups prefer Brand A: "prefer" picks the preference question over awareness
  let q = queryOf(interpretRequest(def, "Which groups prefer Brand A?"));
  assert.equal(q.category, "findings");
  assert.deepEqual(q.query, { kind: "prefer", variable: "BRAND_PREF", question: "Q3", option: { code: "1", label: "Brand A" }, words: "which groups prefer “Brand A” (Q3) — by every demographic" });
  assert.equal(q.understood, "Read from the data: which groups prefer “Brand A” (Q3) — by every demographic.");
  assert.deepEqual(q.detected, [{ what: "question", value: "Q3" }, { what: "option", value: "Brand A" }]);
  assert.deepEqual(defaultCuts(def), ["AGE", "GENDER", "REGION"].filter((v) => v !== "AGE"), "the cuts are the categorical demographics");
  q = queryOf(interpretRequest(def, "who is most likely to be aware of Brand C"));
  assert.equal(q.query.variable, "AWARE"); assert.equal(q.query.option?.code, "3");
  // a cut named, a population named
  q = queryOf(interpretRequest(def, "which groups prefer Brand B by region among women"));
  assert.deepEqual(q.query.by, ["REGION"]);
  assert.equal(q.query.population?.expression, "Q2 = 2");
  assert.equal(q.query.population?.condition.type, "rule");
  // share and count, with "of women" as the population and "in Q5" as the question
  q = queryOf(interpretRequest(def, "what share of women chose Brand A in Q5"));
  assert.equal(q.query.kind, "share"); assert.equal(q.query.variable, "AWARE"); assert.equal(q.query.population?.words, "Q2 (GENDER) = “Female”");
  q = queryOf(interpretRequest(def, "how many respondents have switched brands"));
  assert.equal(q.query.kind, "count"); assert.equal(q.query.variable, "SWITCHED"); assert.deepEqual(q.query.option, { code: "1", label: "Yes" }, "a yes/no question named by its wording: its Yes");
  q = queryOf(interpretRequest(def, "how many people answered Q4"));
  assert.equal(q.query.option, undefined, "the question itself: the count of answers");
  refusal(interpretRequest(def, "how many respondents have switched phones"), /^No question has an option “phones”/, false);
  q = queryOf(interpretRequest(def, "how many people answered yes to Q4"));
  assert.deepEqual([q.query.kind, q.query.variable, q.query.option?.label], ["count", "SWITCHED", "Yes"]);
  // the average, by a cut, among a population, in the "how … on average" form
  q = queryOf(interpretRequest(def, "what is the average satisfaction by gender"));
  assert.deepEqual([q.query.kind, q.query.variable, q.query.by], ["mean", "SAT", ["GENDER"]]);
  q = queryOf(interpretRequest(def, "how satisfied are men on average"));
  assert.equal(q.query.population?.expression, "Q2 = 1");
  q = queryOf(interpretRequest(def, "what's the median age among respondents under 30"));
  assert.equal(q.query.population?.expression, "Q1 < 30");
  // a comparison, both forms
  q = queryOf(interpretRequest(def, "Does satisfaction differ by region?"));
  assert.deepEqual([q.query.kind, q.query.variable, q.query.by], ["compare", "SAT", ["REGION"]]);
  q = queryOf(interpretRequest(def, "are women more satisfied than men"));
  assert.deepEqual([q.query.kind, q.query.variable, q.query.by], ["compare", "SAT", ["GENDER"]]);
  assert.deepEqual(q.detected[2], { what: "groups", value: "Q2 (GENDER) = “Female” vs Q2 (GENDER) = “Male”" });
  // the most common answer
  q = queryOf(interpretRequest(def, "which brand is most preferred"));
  assert.deepEqual([q.query.kind, q.query.variable], ["top", "BRAND_PREF"]);
  q = queryOf(interpretRequest(def, "what is the most common answer to Q9 by gender"));
  assert.deepEqual([q.query.kind, q.query.variable, q.query.by], ["top", "REGION", ["GENDER"]]);
  // ambiguity is a choice with the sentence rewritten; nonsense is a refusal with the fix
  const c = interpretRequest(def, "which groups choose Brand A");
  assert.equal(c.kind, "clarify");
  const cl = c as Extract<Interpretation, { kind: "clarify" }>;
  assert.deepEqual(cl.choices.map((x) => x.text), ["which groups choose Brand A in Q3", "which groups choose Brand A in Q5"]);
  assert.equal(queryOf(interpretRequest(def, cl.choices[1].text)).query.variable, "AWARE");
  refusal(interpretRequest(def, "which groups prefer Brand Z"), /^No question has an option “Brand Z” — name the option as the survey words it, or the question \(“in Q6”\)\.$/);
  refusal(interpretRequest(def, "what is the average of the comments"), /^Q10 \(“Anything else\?”\) is text — it has no average\. Ask for the share of an answer instead/);
  refusal(interpretRequest(def, "does satisfaction differ by satisfaction"), /both resolve to Q7/);
  // not data questions: the survey's own graph, and a crosstab to plan, still go where they went
  assert.equal(interpretRequest(def, "which questions measure satisfaction").kind, "answer");
  assert.equal(interpretRequest(def, "cross-tab satisfaction by gender").kind, "refused", "already planned → the crosstab recogniser's refusal, not a query");
  assert.equal(parseDataQuestion(def, "make Q1 required"), null);
  // a data question and an edit in one sentence: the model's
  assert.equal(interpretRequest(def, "does satisfaction differ by gender and make Q1 required").kind, "model");
});
