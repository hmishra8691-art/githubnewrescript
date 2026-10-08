import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  otherRows, rowOtherCode, rowCodeOfOtherCode, otherBoxCodes, otherTextFor, otherTextsOf, setOtherTextFor,
  otherColumnFor, otherSpecifyEntries, clearOtherText, rowOtherBoxSupported,
  createResponseState, flattenVariables, buildVariableDictionary, resolvePiping, validateQuestion,
} from "./index.js";

/**
 * 07-10-2026 review — Suraj #1 ("we can't add an other specify box in the row
 * of a grid question") and Oweas #1 (Constant Sum Grid: "the corresponding
 * text box is not displayed"). The Studio offered the row flag; nothing
 * downstream read it. These pin the engine half: a key per row box, the pair
 * rule, the export column, piping, and the box of a column OPTION with the
 * same code kept apart.
 */
function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S", title: "T" },
    questions: [
      { id: "g", code: "Q1", variableName: "SAT", type: "matrix_single", variant: "matrix.single", text: "Rate", required: true,
        rows: [{ code: "r1", label: "Food" }, { code: "r9", label: "Other, please specify", flags: ["other_specify"] }],
        options: [{ code: 1, label: "Poor" }, { code: 2, label: "OK" }, { code: "r9", label: "Odd column", flags: ["other_specify"] }] },
      { id: "cs", code: "Q2", variableName: "SPLIT", type: "composite", variant: "matrix.constant_sum", text: "Split", required: true,
        settings: { rowSum: true, sumTarget: 100 },
        rows: [{ code: "1", label: "A" }, { code: "9", label: "Other, please describe", flags: ["other_specify"] }],
        columns: [{ id: "c1", label: "Now", responseType: "numeric", variableStem: "NOW" }, { id: "c2", label: "Later", responseType: "numeric", variableStem: "LATER" }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["g", "cs"] }, { type: "end", id: "e", status: "complete" }],
  });
}
const Q = (def: ReturnType<typeof survey>, id: string) => def.questions.find((q) => q.id === id)!;

test("a flagged row has its own box, kept apart from a column option with the same code", () => {
  const def = survey();
  const g = Q(def, "g");
  assert.deepEqual(otherRows(g).map((r) => r.code), ["r9"]);
  assert.equal(rowOtherCode("r9"), "row:r9");
  assert.equal(rowCodeOfOtherCode("row:r9"), "r9");
  assert.equal(rowCodeOfOtherCode("r9"), null, "an option's code is not a row's");
  assert.deepEqual(otherBoxCodes(g), ["r9", "row:r9"]);
  const state = createResponseState(def);
  setOtherTextFor(state, g, rowOtherCode("r9"), "Parking");
  setOtherTextFor(state, g, "r9", "Column text");
  assert.equal(otherTextFor(state, g, "row:r9"), "Parking");
  assert.equal(otherTextFor(state, g, "r9"), "Column text");
  assert.deepEqual(otherTextsOf(state, g), { r9: "Column text", "row:r9": "Parking" }, "the renderer is handed both boxes");
  clearOtherText(state, g);
  assert.deepEqual(otherTextsOf(state, g), {}, "clearing the question clears row boxes too");
});

test("the pair rule: an answered row needs its text, text needs its row, an unused row is not owed anything", () => {
  const def = survey();
  const g = Q(def, "g");
  const state = createResponseState(def);
  const ctx = { def, state, loop: null };
  const errs = (v: unknown) => validateQuestion(def, g, v, ctx).map((e) => e.message);

  assert.deepEqual(errs({ r1: 1 }), [], "a required grid does not force a rating of an 'other' nobody named");
  assert.ok(errs({ r1: 1, r9: 2 }).some((m) => /Other, please specify: /.test(m)), "rated but not named");
  setOtherTextFor(state, g, "row:r9", "Parking");
  assert.ok(errs({ r1: 1 }).some((m) => /Other, please specify/.test(m)), "named but not rated");
  assert.deepEqual(errs({ r1: 1, r9: 2 }), [], "both");

  const optional = { ...g, required: false, settings: { ...g.settings, otherSpecifyOptional: true } };
  setOtherTextFor(state, g, "row:r9", "");
  assert.deepEqual(validateQuestion(def, optional, { r1: 1, r9: 2 }, ctx), [], "Other text optional: a rated row may stay unnamed");
  setOtherTextFor(state, g, "row:r9", "Parking");
  assert.equal(validateQuestion(def, optional, { r1: 1 }, ctx).length, 1, "an optional grid still asks for the row that was named");
});

test("constant-sum: an unused Other row is not owed a total; a named one is", () => {
  const def = survey();
  const cs = Q(def, "cs");
  const state = createResponseState(def);
  const ctx = { def, state, loop: null };
  const full = { "1": { c1: 60, c2: 40 } };
  assert.deepEqual(validateQuestion(def, cs, full, ctx), []);
  setOtherTextFor(state, cs, "row:9", "Savings");
  assert.ok(validateQuestion(def, cs, full, ctx).some((e) => /Other, please describe/.test(e.message) && e.rowCode === "9"));
  assert.deepEqual(validateQuestion(def, cs, { ...full, "9": { c1: 50, c2: 50 } }, ctx), []);
});

test("export, dictionary and piping carry the row's text", () => {
  const def = survey();
  const g = Q(def, "g");
  const state = createResponseState(def);
  state.answers.g = { r1: 1, r9: 2 } as never;
  setOtherTextFor(state, g, "row:r9", "Parking");
  assert.equal(otherColumnFor(g, "row:r9"), "SAT_r9_other");
  assert.equal(flattenVariables(def, state).SAT_r9_other, "Parking");
  const dict = buildVariableDictionary(def);
  assert.ok(dict.some((v) => v.name === "SAT_r9_other" && v.dataType === "text"), "declared, so every exporter writes it");
  const entry = otherSpecifyEntries(def, state).find((e) => e.optionCode === "row:r9");
  assert.equal(entry?.optionLabel, "Other, please specify");
  assert.equal(entry?.column, "SAT_r9_other");
  const ctx = { def, state, loop: null };
  assert.equal(resolvePiping("You said {{Q1[r9].other}}", ctx), "You said ", "r9 is ALSO a flagged option here — the option's box wins, as before");
  const cs = Q(def, "cs");
  setOtherTextFor(state, cs, "row:9", "Savings");
  assert.equal(resolvePiping("{{Q2[9].other}}", ctx), "Savings", "a row-only code names the row's box");
});

test("the flag is offered only where a grid draws the box", () => {
  for (const v of ["matrix.single", "matrix.multi", "matrix.likert", "matrix.rating", "matrix.star_matrix", "matrix.slider_matrix", "matrix.constant_sum", "matrix.mixed"]) {
    const base = v === "matrix.constant_sum" || v === "matrix.mixed" ? "composite"
      : v === "matrix.multi" ? "matrix_multi" : v.includes("slider") || v.includes("star") ? "matrix_numeric" : "matrix_single";
    assert.ok(rowOtherBoxSupported({ type: base, variant: v }), v);
  }
  for (const [t, v] of [["matrix_single", "swipe.tinder"], ["matrix_single", "matrix.semantic"], ["matrix_single", "matrix.dragdrop_matrix"], ["single_select", undefined]] as const) {
    assert.equal(rowOtherBoxSupported({ type: t, variant: v }), false, String(v ?? t));
  }
});
