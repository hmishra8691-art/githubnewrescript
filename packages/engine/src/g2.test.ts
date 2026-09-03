import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, resolveVariant, isSelectableVariant } from "@rescript/schema";
import {
  createResponseState,
  flattenVariables,
  questionVariables,
  validateQuestion,
  type EvalContext,
} from "./index.js";

/**
 * Engine behaviour the grids / lists / forms variant batch relies on.
 *
 * The only new engine rule in the batch is `settings.rowSum`: a cell
 * question whose every ROW must total `settings.sumTarget` across its
 * columns (Constant-Sum Matrix). Everything else here proves the batch added
 * nothing the engine had to learn — the repeating group, the composite cells
 * and the matrix required rule already covered it.
 */

function sumGrid(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "Q1", type: "composite",
        variant: "matrix.constant_sum",
        text: "Split 100 points",
        rows: [
          { code: "a", label: "Attribute A" },
          { code: "b", label: "Attribute B" },
        ],
        columns: [
          { id: "c1", label: "Brand X", responseType: "numeric", variableStem: "Q1_C1" },
          { id: "c2", label: "Brand Y", responseType: "numeric", variableStem: "Q1_C2" },
        ],
        settings: { rowSum: true, sumTarget: 100 },
        ...extra,
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
}

function ctxFor(def: any, answers: Record<string, unknown> = {}): EvalContext {
  const state = createResponseState(def, { seed: 7 });
  Object.assign(state.answers, answers);
  return { def, state };
}

const msgs = (def: any, value: unknown) => {
  const ctx = ctxFor(def, { q1: value });
  return validateQuestion(def, def.questions[0], value, ctx).map((e) => e.message);
};

/* ------------------------------------------------------- rowSum (new rule) */

test("rowSum: a row whose cells all add to the target passes", () => {
  const def = sumGrid();
  assert.deepEqual(
    msgs(def, { a: { c1: 60, c2: 40 }, b: { c1: 100, c2: 0 } }),
    [],
  );
});

test("rowSum: a row over the target is named and reported", () => {
  const def = sumGrid();
  const out = msgs(def, { a: { c1: 60, c2: 60 }, b: { c1: 100, c2: 0 } });
  assert.deepEqual(out, ["Row “Attribute A” must total 100."]);
});

test("rowSum: a row under the target is reported too", () => {
  const def = sumGrid();
  const out = msgs(def, { a: { c1: 10, c2: 10 }, b: { c1: 50, c2: 50 } });
  assert.deepEqual(out, ["Row “Attribute A” must total 100."]);
});

test("rowSum: every offending row is reported, not just the first", () => {
  const def = sumGrid();
  const out = msgs(def, { a: { c1: 1, c2: 1 }, b: { c1: 2, c2: 2 } });
  assert.equal(out.length, 2);
  assert.match(out[0], /Attribute A/);
  assert.match(out[1], /Attribute B/);
});

test("rowSum: a half-filled row is not held to the total unless the question is required", () => {
  // a respondent typing 60 into the first cell must not be told, mid-entry,
  // that the row does not add up
  const optional = sumGrid();
  assert.deepEqual(msgs(optional, { a: { c1: 60 } }), []);

  const required = sumGrid({ required: true });
  const out = msgs(required, { a: { c1: 60 } });
  assert.ok(out.includes("Row “Attribute A” must total 100."), "required demands complete rows");
  assert.ok(out.includes("Row “Attribute B” must total 100."), "including rows never touched");
});

test("rowSum: an untouched optional grid raises nothing at all", () => {
  assert.deepEqual(msgs(sumGrid(), undefined), []);
});

test("rowSum: the unit is carried into the message when one is set", () => {
  const def = sumGrid({ settings: { rowSum: true, sumTarget: 100, sumUnit: "%" } });
  assert.deepEqual(msgs(def, { a: { c1: 10, c2: 10 }, b: { c1: 50, c2: 50 } }),
    ["Row “Attribute A” must total 100%."]);
});

test("rowSum: without the flag a composite grid is validated as before", () => {
  const def = sumGrid({ settings: { sumTarget: 100 } });
  assert.deepEqual(msgs(def, { a: { c1: 1, c2: 1 }, b: { c1: 2, c2: 2 } }), []);
});

test("rowSum: read-only and calculated columns are excluded from the total", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "composite",
      text: "Split", rows: [{ code: "a", label: "A" }],
      columns: [
        { id: "c1", label: "X", responseType: "numeric", variableStem: "Q1_C1" },
        { id: "c2", label: "Y", responseType: "numeric", variableStem: "Q1_C2" },
        { id: "c3", label: "Total", responseType: "numeric", variableStem: "Q1_C3", readOnly: true },
      ],
      settings: { rowSum: true, sumTarget: 100 },
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  assert.deepEqual(msgs(def, { a: { c1: 40, c2: 60 } }), [],
    "a read-only total column neither has to be filled nor counts twice");
});

/* --------------------------------------- the batch needed no other new rule */

test("the constant-sum grid's cells flatten to the columns' variable stems", () => {
  const def = sumGrid();
  const state = createResponseState(def, { seed: 7 });
  state.answers.q1 = { a: { c1: 60, c2: 40 }, b: { c1: 100, c2: 0 } };
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q1_C1_a, 60);
  assert.equal(flat.Q1_C2_a, 40);
  assert.equal(flat.Q1_C1_b, 100);
});

test("a dynamic list exports as its repeating group: VAR_i_<field> plus VAR_N", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "repeating_group",
      variant: "list.dynamic_list", text: "List them",
      rows: [{ code: "item", label: "Item", fieldType: "text", required: true }],
      settings: { minRepeats: 1, maxRepeats: 3 },
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const state = createResponseState(def, { seed: 7 });
  state.answers.q1 = [{ item: "apple" }, { item: "pear" }] as never;
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q1_N, 2);
  assert.equal(flat.Q1_1_item, "apple");
  assert.equal(flat.Q1_2_item, "pear");
  assert.equal(flat.Q1_3_item, "", "the unused slot exports empty, not missing");

  const names = questionVariables(def.questions[0]).map((v) => v.name);
  assert.deepEqual(names, ["Q1_N", "Q1_1_item", "Q1_2_item", "Q1_3_item"]);
});

test("a repeating form enforces minRepeats and each entry's required fields", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "repeating_group",
      variant: "form.repeating", text: "Household",
      rows: [
        { code: "name", label: "Name", fieldType: "text", required: true },
        { code: "email", label: "Email", fieldType: "email" },
      ],
      settings: { minRepeats: 2, maxRepeats: 5 },
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  assert.deepEqual(msgs(def, [{ name: "Ada" }]), ["Please add at least 2 entries."]);
  const out = msgs(def, [{ name: "Ada" }, { email: "b@example.com" }]);
  assert.deepEqual(out, ["Entry 2: Name is required."]);
  assert.deepEqual(msgs(def, [{ name: "Ada" }, { name: "Bob" }]), []);
});

test("a star matrix's required rule is the ordinary matrix one — every visible row", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "S", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "matrix_numeric",
      variant: "matrix.star_matrix", text: "Rate these", required: true,
      rows: [{ code: "1", label: "Speed" }, { code: "2", label: "Price" }],
      settings: { minValue: 1, maxValue: 5 },
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  assert.deepEqual(msgs(def, { "1": 4 }), ['Please answer for "Price".']);
  assert.deepEqual(msgs(def, { "1": 4, "2": 2 }), []);
});

/* --------------------------------------------------------- registry sanity */

test("all eight grids / lists / forms variants are selectable with the promised model", () => {
  const expected: [string, string, string, string | undefined][] = [
    ["matrix.slider_matrix", "matrix_numeric", "per_row", "slidermatrix"],
    ["matrix.star_matrix", "matrix_numeric", "per_row", "starmatrix"],
    ["matrix.constant_sum", "composite", "cells", "summatrix"],
    ["matrix.dragdrop_matrix", "matrix_single", "per_row", "dragmatrix"],
    ["list.dynamic_list", "repeating_group", "fields", "dynamiclist"],
    ["list.editable_table", "custom_table", "cells", "spreadsheet"],
    ["form.repeating", "repeating_group", "fields", "repeatform"],
    ["form.conditional", "text_list", "fields", undefined],
  ];
  for (const [id, baseType, model, renderer] of expected) {
    const v = resolveVariant(id);
    assert.ok(v, `${id} is registered`);
    assert.ok(isSelectableVariant(v!), `${id} is offered as stable`);
    assert.equal(v!.baseType, baseType, `${id} base type`);
    assert.equal(v!.responseModel, model, `${id} response model`);
    assert.equal(v!.renderer, renderer, `${id} renderer key`);
  }
});

test("the constant-sum grid ships rows, because composite is not row-driven", () => {
  const v = resolveVariant("matrix.constant_sum")!;
  assert.equal(v.defaults?.rows?.length, 3);
  assert.equal(v.defaults?.settings?.rowSum, true);
  assert.equal(v.defaults?.settings?.sumTarget, 100);
});

test("the slider matrix reuses the slider family's renderer, laid out as a grid", () => {
  const v = resolveVariant("matrix.slider_matrix")!;
  assert.equal(v.defaults?.settings?.sliderLayout, "grid");
  assert.equal(v.renderer, "slidermatrix");
});
