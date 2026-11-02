import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { linkHypothesisConstructs, resolveConstructReview } from "./researchLinks.js";
import { hypothesisCoverage } from "./analysisFramework.js";
import { interpretRequest } from "./nlIntent.js";

/** 2026-11-02 — a hypothesis arrives with its constructs and the questions that measure them, in the same change */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const survey = (research?: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "s", code: "BB", title: "Broadband" },
  ...(research ? { research: { hypotheses: [], constructs: [], ...research } } : {}),
  questions: [
    { id: "q1", code: "Q1", variableName: "PRICE_PERC", type: "single_select", text: "How do you perceive the price of your plan?", options: opts("Very cheap", "Cheap", "Fair", "Expensive", "Very expensive") },
    { id: "q2", code: "Q2", variableName: "SWITCH", type: "single_select", text: "How likely are you to switch provider in the next year?", options: opts("Very likely", "Likely", "Unlikely") },
    { id: "q3", code: "Q3", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Other (please specify)") },
    { id: "q4", code: "Q4", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your provider?", options: opts("1", "2", "3", "4", "5") },
    { id: "q5", code: "Q5", variableName: "BILL", type: "numeric", text: "What do you pay each month, in pounds? (price)" },
    { id: "q6", code: "Q6", variableName: "INTRO", type: "html", text: "Thanks — now some questions about price perception." },
  ],
  flow: [{ type: "block", id: "b", children: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3", "q4", "q5", "q6"] }] }, { type: "end", id: "e", status: "complete" }],
});
const apply = (def: SurveyDefinition, actions: SurveyAction[]) => { const out = applySurveyActions(def, actions); assert.ok(out.valid && out.results.every((r) => r.ok), JSON.stringify(out.results.filter((r) => !r.ok))); return out; };
const snapshot = (d: SurveyDefinition) => JSON.stringify({ c: d.research?.constructs, h: d.research?.hypothesisDetails, a: d.questions.map((q) => q.analysis ?? null) });

test("a new hypothesis: one construct per side, created and linked to the questions that certainly measure them — in the same action", () => {
  const out = apply(survey(), [{ op: "add_hypothesis", text: "Higher price perception increases switching intention" } as SurveyAction]);
  const d = out.def;
  assert.deepEqual(d.research!.constructs.map((c) => [c.name, c.role, c.questionIds, c.origin]), [
    ["Price perception", "independent", ["q1"], "hypothesis"],
    ["Switching", "dependent", ["q2"], "hypothesis"],
  ]);
  assert.match(out.results[0].description, /constructs created: Price perception, Switching; 2 question links \(Q1 → Price perception; Q2 → Switching\)/);
  // both stores agree: the construct lists the question, the question names its construct and the hypothesis
  assert.deepEqual([d.questions[0].analysis?.construct, d.questions[0].analysis?.hypotheses], ["Price perception", ["H1"]]);
  assert.deepEqual([d.questions[1].analysis?.construct, d.questions[1].analysis?.hypotheses], ["Switching", ["H1"]]);
  // a display-only question is never linked; a question with only part of the words is for a person to confirm
  assert.equal(d.questions[5].analysis, undefined);
  assert.deepEqual(d.research!.constructs[0].review, [{ questionId: "q5", reason: "its wording carries 1 of the 2 words of “Price perception”" }]);
  assert.equal(d.questions[4].analysis, undefined, "an uncertain match is not linked");
  assert.ok(out.warnings.some((w) => /Q5 may measure “Price perception”/.test(w)), JSON.stringify(out.warnings));
  const cov = hypothesisCoverage(d)[0];
  assert.equal(cov.status, "partly", "measured on both sides; no test planned yet");
});

test("a difference between groups links the question whose ANSWER OPTIONS define the groups, and records the codes", () => {
  const d = apply(survey(), [{ op: "add_hypothesis", text: "Women are more satisfied than men" } as SurveyAction]).def;
  assert.deepEqual(d.research!.constructs.map((c) => [c.name, c.role, c.questionIds]), [["Satisfaction", "dependent", ["q4"]], ["Gender", "independent", ["q3"]]]);
  assert.deepEqual(d.research!.hypothesisDetails[0].groupOptions, { questionId: "q3", higher: [2], lower: [1] });
  assert.equal(d.research!.hypothesisDetails[0].independent, "Gender");
  assert.equal(hypothesisCoverage(d)[0].constructs.length, 2);
});

test("several hypotheses, many-to-many: a construct shared by two hypotheses is made once; a question serves both", () => {
  const d = apply(survey(), [
    { op: "add_hypothesis", text: "Price perception drives switching" },
    { op: "add_hypothesis", text: "Price perception reduces satisfaction" },
  ] as SurveyAction[]).def;
  assert.deepEqual(d.research!.constructs.map((c) => c.name), ["Price perception", "Switching", "Satisfaction"]);
  assert.deepEqual(d.questions[0].analysis?.hypotheses, ["H1", "H2"]);
  assert.equal(d.research!.constructs.filter((c) => c.name === "Price perception").length, 1);
});

test("regeneration changes nothing: no duplicate construct, no duplicate link; a dismissed suggestion stays dismissed", () => {
  let d = apply(survey(), [{ op: "add_hypothesis", text: "Higher price perception increases switching intention" } as SurveyAction]).def;
  const before = snapshot(d);
  d = apply(d, [{ op: "link_constructs" } as SurveyAction]).def;
  d = apply(d, [{ op: "link_constructs", hypothesis: "H1" } as SurveyAction]).def;
  assert.equal(snapshot(d), before);
  // dismiss Q5 for Price perception: never suggested again
  d = apply(d, [{ op: "link_constructs", review: { construct: "Price perception", question: "Q5", decision: "dismiss" } } as SurveyAction]).def;
  assert.deepEqual(d.research!.constructs[0].dismissed, ["q5"]);
  d = apply(d, [{ op: "link_constructs" } as SurveyAction]).def;
  assert.equal(d.research!.constructs[0].review, undefined);
  // set_research replacing the constructs keeps the dismissal
  d = apply(d, [{ op: "set_research", constructs: [{ name: "Price perception", role: "independent", questions: ["Q1"] }, { name: "Switching", role: "dependent", questions: ["Q2"] }] } as SurveyAction]).def;
  assert.deepEqual(d.research!.constructs[0].dismissed, ["q5"]);
});

test("a person links a suggestion: the construct and the question's tags change together", () => {
  const d = apply(survey(), [{ op: "add_hypothesis", text: "Higher price perception increases switching intention" } as SurveyAction]).def;
  assert.ok(resolveConstructReview(d, "Price perception", "q5", "link"));
  assert.deepEqual(d.research!.constructs[0].questionIds, ["q1", "q5"]);
  assert.deepEqual([d.questions[4].analysis?.construct, d.questions[4].analysis?.hypotheses], ["Price perception", ["H1"]]);
  assert.equal(d.research!.constructs[0].review, undefined);
});

test("set_research (a proposed design) links what the model did not list; set_hypothesis creates a side's construct; a near-miss name is refused", () => {
  let d = apply(survey(), [{ op: "set_research", objective: "Why customers switch", hypotheses: ["Price perception drives switching"], constructs: [{ name: "Price perception", role: "independent", questions: [] }] } as SurveyAction]).def;
  assert.deepEqual(d.research!.constructs.map((c) => [c.name, c.questionIds]), [["Price perception", ["q1"]], ["Switching", ["q2"]]]);
  d = apply(d, [{ op: "set_hypothesis", hypothesis: "H1", detail: { moderator: "Satisfaction" } } as SurveyAction]).def;
  assert.deepEqual(d.research!.constructs.find((c) => c.name === "Satisfaction")?.questionIds, ["q4"]);
  const bad = applySurveyActions(d, [{ op: "set_hypothesis", hypothesis: "H1", detail: { mediator: "Price perceptoin" } } as SurveyAction]);
  assert.ok(!bad.results[0].ok && /did you mean “Price perception”/.test(bad.results[0].error ?? ""));
});

test("a construct whose word half the questionnaire carries is not linked to all of them on words alone", () => {
  const def = survey();
  for (let i = 0; i < 8; i++) def.questions.push({ ...def.questions[3], id: `s${i}`, code: `S${i}`, variableName: `SAT${i}`, text: `How satisfied are you with aspect ${i}?` } as never);
  def.research = { hypotheses: ["Satisfaction drives loyalty"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] } as unknown as NonNullable<SurveyDefinition["research"]>;
  const rep = linkHypothesisConstructs(def);
  const sat = def.research!.constructs.find((c) => c.name === "Satisfaction")!;
  assert.deepEqual(sat.questionIds, [], "nine questions carry the word: none is certain");
  assert.equal(sat.review?.length, 9);
  assert.ok(rep.review.some((r) => /but so do 8 other questions/.test(r.why)));
});

test("Intelligent Mode: the sentence and the action", () => {
  const d = apply(survey(), [{ op: "add_hypothesis", text: "Price perception drives switching" } as SurveyAction]).def;
  assert.deepEqual((interpretRequest(d, "link the constructs") as { actions?: unknown[] }).actions, [{ op: "link_constructs" }]);
  assert.deepEqual((interpretRequest(d, "link H1 to its constructs and questions") as { actions?: unknown[] }).actions, [{ op: "link_constructs", hypothesis: "H1" }]);
  const none = applySurveyActions(survey(), [{ op: "link_constructs" } as SurveyAction]);
  assert.ok(!none.results[0].ok && /no hypotheses to link/.test(none.results[0].error ?? ""));
});
