import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, resolveVariant } from "@rescript/schema";
import { fieldIsRequired, requiredFieldsNote, createQuestionFromVariant, createResponseState, validateQuestion } from "./index.js";

/** 07-10-2026 review, Suraj #3 / #4: per-field Required / Optional, the rule in words. */
const rows = (req: boolean[]) => req.map((r, i) => ({ code: `f${i + 1}`, label: `<b>Field ${i + 1}</b>`, required: r }));

test("fieldIsRequired: a field that says so; a required question with none singled out means every field", () => {
  assert.equal(fieldIsRequired({ required: false, rows: rows([true, false]) as never }, { required: true }), true);
  assert.equal(fieldIsRequired({ required: false, rows: rows([true, false]) as never }, { required: false }), false);
  assert.equal(fieldIsRequired({ required: true, rows: rows([false, false]) as never }, { required: false }), true);
  assert.equal(fieldIsRequired({ required: true, rows: rows([true, false]) as never }, { required: false }), false, "one singled out: the rest are optional");
});

test("requiredFieldsNote: exactly the fields the validator will hold the respondent to", () => {
  const q = (required: boolean, req: boolean[]) => ({ required, rows: rows(req) as never });
  assert.equal(requiredFieldsNote(q(false, [false, false]), rows([false, false])), null);
  assert.equal(requiredFieldsNote(q(false, [false, true, false]), rows([false, true, false])), "“Field 2” is required.");
  assert.equal(requiredFieldsNote(q(false, [true, true, false]), rows([true, true, false])), "Required: Field 1, Field 2.");
  assert.equal(requiredFieldsNote(q(true, [false, false]), rows([false, false])), "All fields are required.");
  assert.equal(requiredFieldsNote(q(false, [true, true]), rows([true, true])), "All fields are required.");
  assert.equal(requiredFieldsNote(q(true, [false]), rows([false])), "“Field 1” is required.", "one field: name it");
  assert.equal(requiredFieldsNote(q(false, [true]), rows([true]), { fields_required_one: "«{field}» est obligatoire." }), "«Field 1» est obligatoire.", "translatable");
});

test("validation agrees with the note", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "q", code: "Q1", variableName: "Q1", type: "text_list", text: "x", rows: rows([false, true, false]) }],
    flow: [{ type: "page", id: "p", questionIds: ["q"] }],
  });
  const q = def.questions[0]!;
  const ctx = { def, state: createResponseState(def), loop: null };
  const errs = (v: unknown) => validateQuestion(def, q, v, ctx).map((e) => e.rowCode);
  assert.deepEqual(errs({ f1: "a" }), ["f2"], "only the field marked Required is asked for");
  assert.deepEqual(errs({ f2: "b" }), []);
});

test("Open Text List and Numeric List arrive with individual fields, not an item count", () => {
  for (const [id, ft] of [["list.text_list", "text"], ["list.numeric_list", "number"]] as const) {
    const q = createQuestionFromVariant(resolveVariant(id)!, 1);
    assert.equal(q.rows.length, 3, id);
    assert.ok(q.rows.every((r) => r.fieldType === ft && r.required === false), `${id}: each its own field, optional until marked`);
    assert.equal(q.settings.listCount, undefined);
  }
});
