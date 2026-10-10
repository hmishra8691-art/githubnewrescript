import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { conditionInWords, fuzzyQuestion, namedQuestions, objectChoices, semanticReading, stripPreamble } from "./nlSemanticMatch.js";

/*
 * RESEARCH ENGINE AUDIT, PHASE 7 (§F ①b) — the semantic tier. What the
 * recognisers miss by shape is read by meaning: politeness stripped, the
 * intent found by its cues, the object by code, wording, concept or
 * population, the condition in words made the logic's, the whole written
 * as the canonical sentence and interpreted again. One clear reading is
 * taken and said; several become one question; a bare object is asked
 * what should happen to it. Everything deterministic, nothing applied.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5") },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South") },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q7", "q9"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}
type Actions = Extract<Interpretation, { kind: "actions" }>;
type Clarify = Extract<Interpretation, { kind: "clarify" }>;
const actionsOf = (r: Interpretation, what = ""): Actions => { assert.equal(r.kind, "actions", `${what} ${JSON.stringify(r)}`); return r as Actions; };
const clarifyOf = (r: Interpretation, what = ""): Clarify => { assert.equal(r.kind, "clarify", `${what} ${JSON.stringify(r)}`); return r as Clarify; };
const readAs = (r: Interpretation) => r.kind !== "model" ? r.detected.find((d) => d.what === "read as")?.value : undefined;

test("politeness and preamble are stripped before the recognisers read, and the reading is the plain sentence's", () => {
  assert.equal(stripPreamble("Could you please make Q1 required, thanks"), "make Q1 required");
  assert.equal(stripPreamble("I'd like you to delete Q2."), "delete Q2");
  assert.equal(stripPreamble("let's randomise Q3"), "randomise Q3");
  assert.equal(stripPreamble("please"), "please", "nothing left: the sentence stands");
  const def = survey();
  for (const [t, expect] of [["Please make Q1 required", "Make Q1 required."], ["Could you delete Q2?", "Delete Q2 (“What is your gender?”). Impact: nothing else depends on it."], ["let's randomise Q3", "Randomize the options of Q3."], ["can you make the age question compulsory please", "Make Q1 required."]] as const) {
    const r = actionsOf(interpretRequest(def, t), t);
    assert.equal(r.understood, expect, t);
    assert.equal(readAs(r), undefined, "a sentence the recognisers read after stripping is not a semantic reading");
  }
});

test("one clear reading is taken and said: required, optional, delete, own page, move, terminate, show/hide, crosstab, test, what depends, options, hypothesis, objective", () => {
  const def = survey();
  const cases: [string, string, unknown][] = [
    ["the gender question must be answered", "Make Q2 required", [{ op: "update_question", target: "Q2", required: true }]],
    ["respondents shouldn't be able to skip the age question", "Make Q1 required", [{ op: "update_question", target: "Q1", required: true }]],
    ["gendr required", "Make Q2 required", [{ op: "update_question", target: "Q2", required: true }]],
    ["make everything required", "Make Q1, Q2, Q3, Q4, Q7, Q9 required", null],
    ["we don't need Q7", "Delete Q7", [{ op: "delete_question", target: "Q7" }]],
    ["the age question is pointless", "Delete Q1", [{ op: "delete_question", target: "Q1" }]],
    ["get rid of the brand preference question", "Delete Q3", [{ op: "delete_question", target: "Q3" }]],
    ["we don't need Q3 or Q7", "Delete Q3, Q7", null],
    ["I want the satisfaction question on its own page", "Put Q7 on its own page", null],
    ["put Q7 before Q3", "Move Q7 before Q3", null],
    ["kick out anyone under 18", "Terminate if AGE < 18", [{ op: "add_skip", from: "Q1", when: "AGE < 18", to: "terminated" }]],
    ["nobody under 18 should continue", "Terminate if AGE < 18", null],
    ["people who are 65 or older shouldn't take part", "Terminate if AGE >= 65", null],
    ["age under 18 or over 65 can't take part", "Terminate if Q1 < 18 OR AGE > 65", null],
    ["only ask Q7 to women", "Show Q7 only if Q2 = 2", null],
    ["Q7 should only appear for people who chose Brand A", "Show Q7 only if Q3 = 1", null],
    ["don't show Q3 to anyone under 18", "Hide Q3 if AGE < 18", null],
    ["break satisfaction down by gender", "Plan a crosstab of SAT by GENDER", null],
    ["satisfaction by gender", "Plan a crosstab of SAT by GENDER", null],
    ["is satisfaction related to gender", "Test whether SAT differs by GENDER", null],
    ["compare satisfaction between men and women", "Test whether SAT differs by GENDER", null],
    ["Q3 needs a Don't know option", 'Add option "Don\'t know" to Q3', null],
    ["we expect women to be more satisfied than men", "Add hypothesis: Women to be more satisfied than men", null],
    ["the objective of the study is to understand brand switching", 'Set the research objective to "Understand brand switching"', null],
  ];
  for (const [t, canonical, actions] of cases) {
    const r = interpretRequest(def, t);
    assert.ok(r.kind === "actions" || r.kind === "answer", `${t}: ${JSON.stringify(r)}`);
    assert.equal(readAs(r), canonical, t);
    assert.match((r as Actions).understood, new RegExp(`^Read “${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60)}`), t);
    if (actions) assert.deepEqual((r as Actions).actions, actions, t);
  }
  const dep = interpretRequest(def, "can we see what breaks if Q2 goes");
  assert.equal(dep.kind, "answer");
  assert.equal(readAs(dep), "What depends on Q2?");
});

test("several readings become one question; a bare object is asked what should happen to it; an ambiguous object is asked which; what nothing reads is the model's", () => {
  const def = survey();
  // the brand question: Q3 and Q7 both say "brand" — which?
  let c = clarifyOf(interpretRequest(def, "add 'Other' to the brand question"));
  assert.deepEqual(c.choices.map((x) => x.text).sort(), ['Add option "Other" to Q3', 'Add option "Other" to Q4', 'Add option "Other" to Q7']);
  assert.match(c.question, /more than one thing/);
  // each choice is a sentence the engine reads to the action
  assert.equal(actionsOf(interpretRequest(def, c.choices[0].text)).actions[0].op, "update_question");
  c = clarifyOf(interpretRequest(def, "shuffle the brand question"));
  assert.deepEqual(c.choices.map((x) => x.text).sort(), ["Randomize the options of Q3", "Randomize the options of Q4", "Randomize the options of Q7"]);
  // a code alone
  c = clarifyOf(interpretRequest(def, "Q7"));
  assert.match(c.question, /read Q7 but not what should happen to it/);
  assert.deepEqual(c.choices.map((x) => x.text), ["Make Q7 required", "Make Q7 optional", "Randomize the options of Q7", "Put Q7 on its own page", "Delete Q7", "What depends on Q7?"]);
  assert.deepEqual(objectChoices(def.questions[0]).map((x) => x.text), ["Make Q1 required", "Make Q1 optional", "Put Q1 on its own page", "Delete Q1", "What depends on Q1?"], "no options, no randomize");
  // a description that fits two questions
  c = clarifyOf(interpretRequest(def, "the brand question"));
  assert.match(c.question, /fits 3 questions — which one/);
  assert.deepEqual(c.choices.map((x) => x.text), ["Q3", "Q4", "Q7"]);
  // what no reading fits stays the model's — the semantic tier never invents
  for (const t of ["rewrite Q7 in a friendlier tone", "translate the survey into French", "make me a sandwich", "change the theme to dark blue"]) assert.equal(interpretRequest(def, t).kind, "model", t);
  // a measure the library knows is offered as the engine's standard items (the model's turn, with the fallback), not applied unasked
  const m = interpretRequest(def, "we need a question on trust");
  assert.equal(m.kind, "model");
  assert.equal((m as Extract<Interpretation, { kind: "model" }>).fallback?.choices[0].text.startsWith("Add a required single-select question \"I trust"), true);
  // a sentence the recognisers already refuse as "already so" stays that
  assert.equal(interpretRequest(def, "Q3 doesn't need to be answered").kind, "refused");
  // a recogniser's refusal of an object it could not find is rescued when the semantic tier can read it, and left when it cannot
  assert.equal(readAs(interpretRequest(def, "delete the brand preference question")), "Delete Q3");
  assert.equal(interpretRequest(def, "delete the hobby question").kind, "model", "nothing to read: not invented");
});

test("the pieces: a question from words, the questions a phrase names, a condition in words", () => {
  const def = survey();
  assert.equal(fuzzyQuestion(def, "the gender question", {})?.q.code, "Q2");
  assert.equal(fuzzyQuestion(def, "see if Q2 goes", {})?.q.code, "Q2", "a code anywhere in the phrase");
  assert.equal(fuzzyQuestion(def, "gendr", {})?.q.code, "Q2", "one letter out");
  assert.equal(fuzzyQuestion(def, "gendr", {})?.sure, false);
  assert.equal(fuzzyQuestion(def, "women", {})?.q.code, "Q2", "a population names its question");
  assert.equal(fuzzyQuestion(def, "the brand preference question", {})?.q.code, "Q3");
  const amb = fuzzyQuestion(def, "the brand question", {});
  assert.equal(amb?.sure, false);
  assert.deepEqual(amb?.alternatives?.map((q) => q.code), ["Q4", "Q7"]);
  assert.equal(fuzzyQuestion(def, "the hobby question", {}), null);
  assert.deepEqual(namedQuestions(def, "Q3 or Q7 and AGE").map((q) => q.code), ["Q3", "Q7", "Q1"]);
  for (const [words, expr] of [["age is under 18", "AGE < 18"], ["anyone under 18", "AGE < 18"], ["over 65", "AGE > 65"], ["at least 21", "AGE >= 21"], ["65 or older", "AGE >= 65"], ["18 or younger", "AGE <= 18"], ["gender is female", 'GENDER = "Female"'], ["gender is not male", 'GENDER != "Male"'], ["they said No to Q4", 'SWITCHED = "No"'], ["Q1 < 18", "Q1 < 18"], ["under 18 or over 65", "AGE < 18 OR AGE > 65"], ["women", "Q2 = 2"], ["female", "Q2 = 2"]] as const) {
    assert.equal(conditionInWords(def, words, {}), expr, words);
  }
  assert.equal(conditionInWords(def, "the moon is full", {}), null);
  // the reading lists every candidate with its score and why, best first
  const reading = semanticReading(def, "the gender question must be answered");
  assert.equal(reading.core, "the gender question must be answered");
  assert.equal(reading.candidates[0].text, "Make Q2 required");
  assert.equal(reading.candidates[0].score, 1);
  assert.match(reading.candidates[0].why, /“must be answered” → make required; /);
});
