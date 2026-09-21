import test from "node:test";
import assert from "node:assert/strict";
import { migrateQuestionType } from "./questionShape.js";
import { resolveVariant } from "@rescript/schema";

/*
 * THE JUDGEMENT CONTROL MUST NOT CHANGE THE QUESTION TYPE.
 *
 * The September review, verbatim:
 *
 *   "In the Carousel Plus Choice, Slider & Text question type, the Judgment
 *    setting is currently set to Choice by default. However, when we change
 *    the Judgment type: Changing Choice → Slider automatically converts the
 *    question into a Grid Numeric question type. Changing Choice → Text
 *    automatically converts it into a Grid Text question type. This is not
 *    the expected behavior because the question should remain within the
 *    Carousel family … only the Judgment option should change."
 *
 * `carousel.judge` is deliberately one variant over three base types — the
 * Judgement select rewrites `question.type` so the input under the card can
 * change without spawning three variants. But `resolveTarget` refused to keep
 * a named variant whose declared `baseType` differed from the type being
 * asked for (the guard that stops `{ baseType: "numeric", id: "text.email" }`),
 * so the carousel fell through to the base type's default variant —
 * `matrix.numeric`, which is exactly "Grid Numeric".
 *
 * `altBaseTypes` lets the one variant that legitimately spans types say so.
 */

const carouselQuestion = () => ({
  id: "q1",
  code: "Q1",
  variableName: "CAROUSEL",
  type: "matrix_single",
  variant: "carousel.judge",
  text: "Judge each item",
  options: [
    { code: 1, label: "Dislike", flags: [] },
    { code: 2, label: "Neutral", flags: [] },
    { code: 3, label: "Like", flags: [] },
  ],
  rows: [
    { code: "r1", label: "Item one", flags: [], validation: [], required: false },
    { code: "r2", label: "Item two", flags: [], validation: [], required: false },
  ],
  columns: [],
  validation: [],
  settings: {},
  required: false,
}) as any;

test("Choice → Slider keeps the question a Carousel", () => {
  const { q } = migrateQuestionType(carouselQuestion(), { baseType: "matrix_numeric", id: "carousel.judge" });
  assert.equal(q.variant, "carousel.judge", "the variant must not become matrix.numeric (Grid Numeric)");
  assert.equal(q.type, "matrix_numeric", "the base type still follows the chosen input");
  assert.equal(resolveVariant(q.variant!)?.family, "carousel");
});

test("Choice → Text keeps the question a Carousel", () => {
  const { q } = migrateQuestionType(carouselQuestion(), { baseType: "matrix_text", id: "carousel.judge" });
  assert.equal(q.variant, "carousel.judge", "the variant must not become matrix.text (Grid Text)");
  assert.equal(q.type, "matrix_text");
  assert.equal(resolveVariant(q.variant!)?.family, "carousel");
});

test("and back again — Slider → Choice returns to matrix_single, still a Carousel", () => {
  const slider = migrateQuestionType(carouselQuestion(), { baseType: "matrix_numeric", id: "carousel.judge" }).q;
  const { q } = migrateQuestionType(slider, { baseType: "matrix_single", id: "carousel.judge" });
  assert.equal(q.variant, "carousel.judge");
  assert.equal(q.type, "matrix_single");
});

/*
 * The guard this fix had to keep. A variant that does NOT declare a type is
 * still refused for it, so naming an impossibility still falls back to the
 * base type's own default rather than mislabelling the question.
 */
test("a variant that cannot store as the requested type is still refused", () => {
  const textQ = {
    ...carouselQuestion(), type: "open_text", variant: "text.single_line", options: [], rows: [],
  } as any;
  const { q } = migrateQuestionType(textQ, { baseType: "numeric", id: "text.email" });
  assert.notEqual(q.variant, "text.email", "an email variant cannot store as a numeric question");
  assert.equal(resolveVariant(q.variant!)?.baseType, "numeric");
});
