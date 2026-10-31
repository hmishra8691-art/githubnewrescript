import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { migrateQuizKeys, quizKey, quizCorrectValue, QUIZ_VARIANT } from "./quizKey.js";
import { stripAssessmentSecrets, scoreAssessment } from "./assessment.js";
import { flattenVariables } from "./flatten.js";
import { buildVariableDictionary } from "./variables.js";
import { createResponseState } from "./state.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";

/* S4a item 4 — D14 / GA-03: one answer key for the quiz variant and assessments */

const opts = (correctCode?: number) => [1, 2, 3].map((code) => ({ code, label: `Answer ${code}`, flags: [], ...(code === correctCode ? { meta: { correct: true, explanation: "why" } } : {}) }));
const survey = (q: Partial<Question>, extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Quiz", version: "1" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", variant: QUIZ_VARIANT, text: "Which?", options: opts(), settings: {}, ...q }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  ...extra,
});

test("D14: quizKey — the assessment key wins, meta.correct is the legacy fallback, a stripped copy is withheld", () => {
  assert.deepEqual(quizKey(survey({ options: opts(2) }).questions[0]), { codes: ["2"], withheld: false, source: "meta" });
  assert.deepEqual(quizKey(survey({ options: opts(2), assessment: { correct: [3] } }).questions[0]).codes, ["3"]);
  assert.deepEqual(quizKey(survey({ assessment: { correct: [], withheld: true } }).questions[0]), { codes: [], withheld: true, source: "assessment" });
  assert.equal(quizKey(survey({}).questions[0]).source, "none");
});

test("D14: migrateQuizKeys moves meta.correct into assessment.correct; idempotent; keeps an existing assessment key and other meta", () => {
  const def = survey({ options: opts(2) });
  const r1 = migrateQuizKeys(def);
  assert.deepEqual(r1.migrated, ["Q1"]);
  const q = r1.def.questions[0];
  assert.deepEqual(q.assessment?.correct, [2]);
  assert.equal(q.options[1].meta?.correct, undefined, "the legacy key is moved, not copied");
  assert.equal(q.options[1].meta?.explanation, "why", "the explanation stays on the option");
  assert.equal(def.questions[0].options[1].meta?.correct, true, "the input is untouched");
  const r2 = migrateQuizKeys(r1.def);
  assert.equal(r2.def, r1.def, "a second run is a no-op (same object)");
  assert.deepEqual(r2.migrated, []);
  const both = migrateQuizKeys(survey({ options: opts(2), assessment: { correct: [3] } })).def.questions[0];
  assert.deepEqual(both.assessment?.correct, [3], "the assessment key wins");
  assert.equal(both.options[1].meta?.correct, undefined);
  const stripped = survey({ options: opts(2), assessment: { correct: [], withheld: true } });
  assert.equal(migrateQuizKeys(stripped).def, stripped, "a withheld (respondent) copy is never migrated");
  const notQuiz = survey({ variant: "single_select.radio", options: opts(2) });
  assert.equal(migrateQuizKeys(notQuiz).def, notQuiz, "only the quiz variant");
});

test("D14: stripping — a scored paper withholds the quiz key; per_question keeps it; an ordinary survey keeps an instant-feedback quiz's key and withholds it when feedback is off", () => {
  const paper = (showResults: string) => migrateQuizKeys(survey({ options: opts(2) }, { assessment: { enabled: true, showResults } })).def;
  const live = stripAssessmentSecrets(paper("after_submit"));
  assert.deepEqual(live.questions[0].assessment, { correct: [], withheld: true });
  assert.equal(quizKey(live.questions[0]).withheld, true);
  assert.ok(!JSON.stringify(live).includes('"correct":[2]'));
  const pq = stripAssessmentSecrets(paper("per_question"));
  assert.deepEqual(quizKey(pq.questions[0]).codes, ["2"], "per_question: the key is sent by design");
  const ordinary = migrateQuizKeys(survey({ options: opts(2) })).def;
  assert.deepEqual(quizKey(stripAssessmentSecrets(ordinary).questions[0]).codes, ["2"], "not a paper, feedback on: instant feedback needs the key (as before)");
  const quiet = migrateQuizKeys(survey({ options: opts(2), settings: { showFeedback: false } as never })).def;
  assert.equal(quizKey(stripAssessmentSecrets(quiet).questions[0]).withheld, true, "feedback off: nothing in the browser needs the key");
});

test("D14: _CORRECT is graded on the server from the key — not the browser's __correct; declared in the dictionary", () => {
  const def = migrateQuizKeys(survey({ options: opts(2) }, { assessment: { enabled: true } })).def;
  const state = createResponseState(def, { seed: 1 });
  state.answers.q1 = 2;
  (state.answers as Record<string, unknown>).q1__correct = 0; // what a stripped browser would have guessed
  assert.equal(flattenVariables(def, state).Q1_CORRECT, 1);
  state.answers.q1 = 3;
  (state.answers as Record<string, unknown>).q1__correct = 1;
  assert.equal(flattenVariables(def, state).Q1_CORRECT, 0);
  delete state.answers.q1;
  assert.equal(flattenVariables(def, state).Q1_CORRECT, null);
  assert.equal(quizCorrectValue(def.questions[0], 2), 1);
  assert.ok(buildVariableDictionary(def).some((v) => v.name === "Q1_CORRECT"));
  // and the paper scores it like any keyed question
  assert.equal(scoreAssessment(def, { q1: 2 }).correct, 1);
});

test("D14: set_answer_key (IM / Properties → Assessment) keys the quiz — the key the quiz reads", () => {
  const def = survey({});
  const r = applySurveyActions(def, [{ op: "set_answer_key", target: "Q1", correct: ["2"] } as SurveyAction]);
  assert.ok(r.results[0].ok, r.results[0].error);
  assert.deepEqual(quizKey(r.def.questions[0]).codes, ["2"]);
  assert.equal(r.def.questions[0].options.some((o) => o.meta?.correct), false, "no second key in option meta");
});
