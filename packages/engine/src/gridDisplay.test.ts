import test from "node:test";
import assert from "node:assert/strict";
import { resolveVariant, Question } from "@rescript/schema";
import {
  headerRepeatEvery, headerRepeatsBefore, headerRepeatApplies,
  ratingLabelMode, ratingScaleOptions, switchRatingLabels, RATING_TEXT_LABELS,
  createQuestionFromVariant, migrateQuestionType,
} from "./index.js";

/* 07-10-2026 review, Prince #2 — Header Repeat */
test("header repeat: off / auto / every N, and the default by grid length", () => {
  assert.equal(headerRepeatEvery("off", 40), null);
  assert.equal(headerRepeatEvery("auto", 40), 10);
  assert.equal(headerRepeatEvery(5, 40), 5);
  assert.equal(headerRepeatEvery(25, 40), 25);
  assert.equal(headerRepeatEvery(7, 40), 7, "a custom count");
  assert.equal(headerRepeatEvery(undefined, 15), null, "1–15 rows: off");
  assert.equal(headerRepeatEvery(undefined, 20), null, "16–20: available, not on");
  assert.equal(headerRepeatEvery(undefined, 21), 10, "20+: automatic");
  assert.equal(headerRepeatEvery("auto", 10), null, "nothing after the last row");
  assert.equal(headerRepeatEvery(0 as never, 30), null);
  const at = (every: number | null, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => headerRepeatsBefore(i, every, n));
  assert.deepEqual(at(10, 25), [10, 20], "before rows 11 and 21 — never before the first");
  assert.deepEqual(at(5, 12), [5, 10]);
  assert.deepEqual(at(null, 30), []);
});

test("header repeat is offered on every grid that draws a header, and only there", () => {
  for (const id of ["matrix.single", "matrix.multi", "matrix.likert", "matrix.rating", "matrix.semantic", "matrix.mixed", "matrix.numeric", "matrix.text", "matrix.dropdown", "matrix.constant_sum", "matrix.slider_matrix", "matrix.random_rows", "list.editable_table"]) {
    const v = resolveVariant(id)!;
    assert.ok(headerRepeatApplies({ type: v.baseType, variant: id }), id);
  }
  for (const id of ["matrix.star_matrix", "matrix.dragdrop_matrix", "swipe.tinder", "single_select.radio"]) {
    const v = resolveVariant(id)!;
    assert.equal(headerRepeatApplies({ type: v.baseType, variant: id }), false, id);
  }
});

/* Prince #1 — Rating Matrix columns */
test("Rating Matrix arrives with columns 1–5, shown as numbers", () => {
  const q = createQuestionFromVariant(resolveVariant("matrix.rating")!, 1);
  assert.deepEqual(q.options.map((o) => [o.code, o.label]), [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]]);
  assert.equal(ratingLabelMode(q), "numbers");
});

test("Numbers ⇄ Text labels: the standard words, the codes kept, the author's words remembered", () => {
  const nums = ratingScaleOptions(5, "numbers");
  const text = switchRatingLabels(nums, "text");
  assert.deepEqual(text.map((o) => o.label), RATING_TEXT_LABELS[5]);
  assert.deepEqual(text.map((o) => o.code), [1, 2, 3, 4, 5], "the data still stores 1–5");
  const edited = text.map((o, i) => (i === 4 ? { ...o, label: "Outstanding" } : o));
  const back = switchRatingLabels(edited, "numbers");
  assert.deepEqual(back.map((o) => o.label), ["1", "2", "3", "4", "5"]);
  assert.equal(switchRatingLabels(back, "text")[4]!.label, "Outstanding", "switching back restores what was written");
  assert.equal(ratingLabelMode({ settings: {} as never, options: edited as never }), "text", "inferred from the labels");
  assert.equal(ratingLabelMode({ settings: { ratingLabels: "numbers" } as never, options: edited as never }), "numbers", "the setting wins");
});

test("the Rating scale control: 1–3 … 1–10, existing points kept", () => {
  assert.deepEqual(ratingScaleOptions(7, "text").map((o) => o.label), RATING_TEXT_LABELS[7]);
  assert.deepEqual(ratingScaleOptions(10, "numbers").map((o) => o.code), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(ratingScaleOptions(10, "text").map((o) => o.label), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], "no standard words for ten: numbers until named");
  const withLogic = ratingScaleOptions(5, "numbers").map((o) => (o.code === 2 ? { ...o, flags: ["anchor_top"] as never } : o));
  assert.deepEqual(ratingScaleOptions(3, "numbers", withLogic)[1]!.flags, ["anchor_top"], "a kept point keeps what it carries");
  const mine = switchRatingLabels(ratingScaleOptions(5, "numbers"), "text").map((o, i) => (i === 0 ? { ...o, label: "Awful" } : o));
  assert.equal(ratingScaleOptions(5, "text", mine)[0]!.label, "Awful", "same size: the author's words stay");
  assert.equal(ratingScaleOptions(4, "text", mine)[0]!.label, "Poor", "a new size takes that size's words");
});

test("Likert → Rating Matrix: Likert's seeded columns become 1–5; edited ones stay", () => {
  const likert = Question.parse({ ...createQuestionFromVariant(resolveVariant("matrix.likert")!, 1), rows: [{ code: "r1", label: "A" }] });
  const m = migrateQuestionType(likert, resolveVariant("matrix.rating")!);
  assert.deepEqual(m.q.options.map((o) => o.label), ["1", "2", "3", "4", "5"]);
  const mine = Question.parse({ ...likert, options: likert.options.map((o, i) => (i === 0 ? { ...o, label: "Hate it" } : o)) });
  assert.equal(migrateQuestionType(mine, resolveVariant("matrix.rating")!).q.options[0]!.label, "Hate it");
});
