/**
 * THE SCALE A RATING QUESTION HAS IS ONE NUMBER PAIR, NOT THREE.
 *
 * The September 2026 question-type review reported the visible half of this
 * three times — heart rating, emoji rating, NPS — always the same shape: the
 * editor accepts a maximum the renderer cannot draw, the renderer clamps
 * without saying so, and the validator checks the answer against the number
 * that was typed rather than the one that was shown. Each test below fails on
 * that behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Question as QuestionSchema, SurveyDefinition, type Question } from "@rescript/schema";
import { effectiveScale, scaleLimitFor, validationBounds } from "./scale.js";
import { validateQuestion } from "./validate.js";
import { createResponseState } from "./state.js";

const q = (over: Partial<Question> = {}): Question =>
  QuestionSchema.parse({
    id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "How was it?",
    ...over,
  });

test("a heart rating cannot be configured past the ten hearts it can draw", () => {
  const heart = q({ variant: "single_select.heart_rating", settings: { minValue: 1, maxValue: 50 } as any });
  const limit = scaleLimitFor(heart);
  assert.deepEqual(limit, { min: 1, max: 10 });

  const shown = effectiveScale(heart, { min: 1, max: 10 });
  assert.equal(shown.max, 10, "the renderer draws ten hearts");
  assert.equal(shown.clamped, true, "and the editor is told the stored value was not usable");
});

test("the scale the respondent sees is the scale the answer is checked against", () => {
  /*
   * THE BUG, EXACTLY. A 1–50 heart rating drew ten hearts and printed
   * "3 / 10", and `validate` accepted anything up to 50 — so a value posted
   * outside the ten the respondent could reach was stored as a valid answer
   * on a scale nobody ever saw.
   */
  const heart = q({ variant: "single_select.heart_rating", settings: { minValue: 1, maxValue: 50 } as any });
  assert.deepEqual(validationBounds(heart), { min: 1, max: 10 });

  const def = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Scale", version: "1.0" },
    questions: [heart],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const ctx = { def, state, loop: null };
  assert.deepEqual(validateQuestion(def, heart, 7, ctx as never), [], "7 is on the scale that was drawn");
  assert.equal(validateQuestion(def, heart, 40, ctx as never).length, 1, "40 is not, and used to pass");
});

test("an NPS is fixed at 0–10 whatever its settings say", () => {
  const nps = q({ type: "nps", variant: "single_select.nps", settings: { minValue: 2, maxValue: 50 } as any });
  const limit = scaleLimitFor(nps);
  assert.equal(limit?.fixed, true, "the range is the variant's definition, not a setting");

  const shown = effectiveScale(nps, { min: 0, max: 10 });
  assert.deepEqual([shown.min, shown.max], [0, 10]);
  assert.deepEqual(validationBounds(nps), { min: 0, max: 10 });
});

test("a Likelihood Scale is the author's to set, within 0–15", () => {
  /*
   * The review gave two different answers for these two variants and both are
   * honoured: an NPS has no fields because its scale is a standard, while a
   * Likelihood Scale keeps its fields — the review only asked that the name
   * stop claiming a range the fields could contradict.
   */
  const lik = q({ type: "nps", variant: "single_select.likelihood", settings: { minValue: 1, maxValue: 7 } as any });
  assert.equal(scaleLimitFor(lik)?.fixed, undefined);
  assert.deepEqual([effectiveScale(lik, { min: 0, max: 10 }).min, effectiveScale(lik, { min: 0, max: 10 }).max], [1, 7]);

  const wide = q({ type: "nps", variant: "single_select.likelihood", settings: { minValue: 0, maxValue: 40 } as any });
  assert.equal(effectiveScale(wide, { min: 0, max: 10 }).max, 15, "clamped to the declared ceiling");
});

test("a question with no variant is still held to what its renderer can draw", () => {
  /*
   * Legacy questions carry no variant and therefore no declared limit. The
   * fallback the renderer passes is its own ceiling, so a pre-existing 1–50
   * star rating does not suddenly try to draw fifty stars.
   */
  const legacy = q({ settings: { minValue: 1, maxValue: 50 } as any });
  assert.equal(scaleLimitFor(legacy), undefined);
  assert.equal(effectiveScale(legacy, { min: 1, max: 10 }).max, 10);
  /* but nothing is imposed on a plain numeric answer, which has no symbols to run out of */
  assert.deepEqual(validationBounds(legacy), { min: 1, max: 50 });
});

test("a scale inside its limit is left exactly alone", () => {
  const five = q({ variant: "slider.stars", settings: { minValue: 1, maxValue: 5 } as any });
  const shown = effectiveScale(five, { min: 1, max: 10 });
  assert.deepEqual([shown.min, shown.max, shown.clamped], [1, 5, false],
    "a five-star rating is still a five-star rating — the bound is a ceiling, not a replacement");
});
