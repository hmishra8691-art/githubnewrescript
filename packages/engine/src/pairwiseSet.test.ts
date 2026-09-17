/**
 * PAIRWISE, AS SEVERAL COMPARISONS.
 *
 * The existing Pairwise Choice shows the first two options and leaves the
 * rest unreachable — the review found that and asked for authored pairs
 * instead. This is the shape that answers it, and the point of these tests is
 * that it is NOT a new response model: the answer is a single-select matrix's
 * answer, so everything downstream reads it already.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, resolveVariant, effectiveResponseModel } from "@rescript/schema";
import { lintQuestionLogic } from "./lintLogic.js";
import { createResponseState } from "./state.js";
import { validateQuestion } from "./validate.js";
import { buildVariableDictionary } from "./variables.js";

function survey(rows: Record<string, unknown>[], options = [1, 2, 3, 4].map((n) => ({ code: n, label: `Choice ${n}` }))) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Pairs", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "PREF", type: "matrix_single", variant: "single_select.pairwise_set",
      text: "Which do you prefer?", required: true, options, rows,
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
}
const PAIRS = [
  { code: "p1", label: "Pair 1", meta: { left: "1", right: "2" } },
  { code: "p2", label: "Pair 2", meta: { left: "3", right: "4" } },
];

test("a pairwise set borrows an answer shape the platform already exports", () => {
  const v = resolveVariant("single_select.pairwise_set")!;
  assert.equal(v.responseModel, "per_row", "one answer per pair — a single-select matrix");
  assert.equal(v.baseType, "matrix_single");

  const def = survey(PAIRS);
  const dict = buildVariableDictionary(def);
  const names = dict.map((d) => d.name);
  assert.ok(names.includes("PREF_p1") && names.includes("PREF_p2"),
    "one variable per comparison, named like any other matrix row");
});

test("each pair stores the code of the choice that won it", () => {
  const def = survey(PAIRS);
  const q = def.questions[0];
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const ctx = { def, state, loop: null };

  assert.ok(validateQuestion(def, q, { p1: 1 }, ctx as never).length, "a required set needs every pair answered");
  assert.deepEqual(validateQuestion(def, q, { p1: 1, p2: 4 }, ctx as never), [],
    "Choice 1 beat Choice 2, and Choice 4 beat Choice 3");
  assert.equal(effectiveResponseModel(q), "per_row");
});

test("a pair that names a choice the question no longer has is an error", () => {
  /* delete an option and a pair can be left pointing at nothing — the
     renderer refuses to draw half a duel, and the author hears about it here */
  const def = survey([{ code: "p1", label: "Pair 1", meta: { left: "1", right: "99" } }]);
  const issues = lintQuestionLogic(def, def.questions[0]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "error");
  assert.match(issues[0].message, /both sides/);
});

test("a pair cannot compare a choice with itself", () => {
  const def = survey([{ code: "p1", label: "Pair 1", meta: { left: "2", right: "2" } }]);
  const issues = lintQuestionLogic(def, def.questions[0]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /with itself/);
});

test("a well-formed set raises nothing", () => {
  assert.deepEqual(lintQuestionLogic(survey(PAIRS), survey(PAIRS).questions[0]), []);
});
