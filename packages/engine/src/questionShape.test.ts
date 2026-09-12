/**
 * A TYPE CHANGE IS A SCHEMA CHANGE — proved field by field.
 *
 * The bug these tests close: changing a question's type wrote two strings and
 * left the rest of the question exactly as it was, so a matrix that became an
 * open end still carried rows, a scale, a row mask and a `minSelections`.
 * Nothing showed them, and everything that reads the schema rather than the
 * screen — the grid detector, the validator, the exporter, the Logic Builder's
 * operator list — went on believing them.
 *
 * So each test here asks the same question twice: is the new question clean,
 * and was the person TOLD what happened to the old one. A migration that
 * quietly does the right thing is only half of the requirement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Question as QuestionSchema, type Question } from "@rescript/schema";
import { migrateQuestionType, staleFields, shapeHasAxis, settingsOf, SHAPES } from "./questionShape.js";

const q = (over: Partial<Question> = {}): Question =>
  QuestionSchema.parse({
    id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Favourite?",
    options: [{ code: "1", label: "Tea" }, { code: "2", label: "Coffee" }, { code: "3", label: "Neither" }] as any,
    ...over,
  });

const removed = (m: ReturnType<typeof migrateQuestionType>) =>
  m.changes.filter((c) => c.kind === "removed").map((c) => c.field);
const transformed = (m: ReturnType<typeof migrateQuestionType>) =>
  m.changes.filter((c) => c.kind === "transformed").map((c) => c.field);

/* ------------------------------------------------------------------ the table */

test("every response model declares a shape", () => {
  for (const model of Object.keys(SHAPES)) {
    const spec = SHAPES[model as keyof typeof SHAPES];
    assert.ok(spec.label, `${model} has words a person can read`);
    for (const a of spec.axes) assert.ok(["options", "rows", "columns"].includes(a));
  }
});

test("a shape is asked, never counted — a text question has no rows however many it carries", () => {
  const stale = q({ type: "open_text", options: [], rows: [{ code: "r1", label: "leftover" }] as any });
  assert.equal(shapeHasAxis(stale, "rows"), false, "the TYPE decides, not rows.length");
  assert.equal(shapeHasAxis(q({ type: "matrix_single" }), "rows"), true);
  assert.equal(shapeHasAxis(q({ type: "composite" }), "columns"), true);
  assert.equal(shapeHasAxis(q(), "columns"), false);
});

test("universal settings belong to every shape; owned ones do not", () => {
  for (const model of Object.keys(SHAPES)) {
    assert.ok(settingsOf(model as any).has("readOnly"), `${model} honours readOnly`);
    assert.ok(settingsOf(model as any).has("accessibility"), `${model} honours accessibility`);
  }
  assert.ok(settingsOf("multiple_choice").has("maxSelections"));
  assert.ok(!settingsOf("text").has("maxSelections"), "text has nothing to select");
  assert.ok(settingsOf("numeric").has("minValue"));
  assert.ok(!settingsOf("numeric").has("geoMode"));
});

/* --------------------------------------------------------- the reported bug */

test("single select → open end: the option list goes, and is named as going", () => {
  const m = migrateQuestionType(q(), { baseType: "open_text" });
  assert.equal(m.safe, false);
  assert.deepEqual(m.q.options, [], "an open end holds no codes");
  assert.deepEqual(removed(m), ["options"]);
  assert.match(m.changes[0].detail, /3 options/, "the person is told how many: " + m.changes[0].detail);
  assert.equal(m.q.text, "Favourite?", "the question itself is untouched");
  assert.equal(m.q.variableName, "Q1");
});

test("a matrix becoming an open end takes NOTHING with it", () => {
  const before = q({
    type: "matrix_single",
    rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Taste" }] as any,
    options: [{ code: "1", label: "Low" }, { code: "5", label: "High" }] as any,
    rowMask: { expr: { kind: "ref", questionId: "q0", selection: "selected" }, action: "display" } as any,
    randomization: { enabled: true, scope: "rows", method: "shuffle" } as any,
    settings: { minSelections: 2, maxSelections: 4, readOnly: false, hidden: false } as any,
  });
  const m = migrateQuestionType(before, { baseType: "open_text" });

  assert.deepEqual(m.q.rows, []);
  assert.deepEqual(m.q.options, []);
  assert.equal((m.q as any).rowMask, undefined, "a mask over rows that do not exist is not a mask");
  assert.equal((m.q as any).randomization, undefined);
  assert.equal((m.q.settings as any).minSelections, undefined);
  assert.equal((m.q.settings as any).maxSelections, undefined);

  const fields = removed(m);
  for (const f of ["rows", "options", "rowMask", "randomization", "settings.minSelections", "settings.maxSelections"]) {
    assert.ok(fields.includes(f), `${f} is reported, not just deleted — got ${fields.join(", ")}`);
  }
  /* and nothing survived that the new shape cannot read */
  assert.deepEqual(staleFields(m.q), [], "the migrated question is clean by its own account");
});

/* ------------------------------------------------------------ transformations */

test("single select → text list: the options become the fields, codes intact", () => {
  const m = migrateQuestionType(q(), { baseType: "text_list" });
  assert.equal(m.q.rows.length, 3, "nobody retypes the list");
  assert.deepEqual(m.q.rows.map((r) => r.code), ["1", "2", "3"], "codes do not change");
  assert.deepEqual(m.q.rows.map((r) => r.label), ["Tea", "Coffee", "Neither"]);
  assert.deepEqual(m.q.options, []);
  assert.deepEqual(transformed(m), ["rows"]);
  assert.equal(removed(m).length, 0, "nothing was lost, so nothing is reported lost");
  QuestionSchema.parse(m.q);
});

test("text list → single select: the fields become the options again", () => {
  const list = q({ type: "text_list", options: [], rows: [{ code: "a", label: "One" }, { code: "b", label: "Two" }] as any });
  const m = migrateQuestionType(list, { baseType: "single_select" });
  assert.deepEqual(m.q.options.map((o) => o.code), ["a", "b"]);
  assert.deepEqual(m.q.rows, []);
  QuestionSchema.parse(m.q);
});

test("a mask follows its list across the change", () => {
  const before = q({ mask: { expr: { kind: "ref", questionId: "q0", selection: "selected" }, action: "display" } as any });
  const m = migrateQuestionType(before, { baseType: "text_list" });
  assert.ok((m.q as any).rowMask, "masking the options now masks the fields they became");
  assert.equal((m.q as any).mask, undefined);
  assert.ok(transformed(m).includes("rowMask"));
});

test("randomization and carry-forward are retargeted, not thrown away", () => {
  const before = q({
    randomization: { enabled: true, scope: "options", method: "shuffle" } as any,
    carryForward: { sourceQuestionId: "q0", filter: "selected", into: "options", keepOwn: false } as any,
  });
  const m = migrateQuestionType(before, { baseType: "text_list" });
  assert.equal(m.q.randomization?.scope, "rows");
  assert.equal(m.q.carryForward?.into, "rows");
  assert.equal(removed(m).length, 0);
});

test("matrix → composite: the shared scale becomes the one column it is", () => {
  const before = q({
    type: "matrix_single",
    rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Taste" }] as any,
    options: [{ code: "1", label: "Low" }, { code: "2", label: "Mid" }, { code: "3", label: "High" }] as any,
  });
  const m = migrateQuestionType(before, { baseType: "composite" });
  assert.equal(m.q.rows.length, 2, "the statements stay statements");
  assert.equal(m.q.columns.length, 1, "and the scale is a column");
  assert.equal(m.q.columns[0].options.length, 3);
  assert.deepEqual(m.q.columns[0].options.map((o) => o.code), ["1", "2", "3"]);
  assert.equal(m.q.columns[0].responseType, "single");
  assert.deepEqual(m.q.options, []);
  QuestionSchema.parse(m.q);

  /* and back again */
  const back = migrateQuestionType(m.q, { baseType: "matrix_single" });
  assert.deepEqual(back.q.options.map((o) => o.code), ["1", "2", "3"], "the round trip keeps the scale");
  assert.equal(back.q.columns.length, 0);
  assert.equal(back.q.rows.length, 2);
});

test("a composite with several columns does not pretend to be a scale", () => {
  const before = q({
    type: "composite", options: [],
    rows: [{ code: "r1", label: "Brand A" }] as any,
    columns: [
      { id: "c1", label: "Awareness", responseType: "single", variableStem: "AW", options: [{ code: "1", label: "Yes" }] },
      { id: "c2", label: "Usage", responseType: "numeric", variableStem: "US", options: [] },
    ] as any,
  });
  const m = migrateQuestionType(before, { baseType: "matrix_single" });
  assert.deepEqual(m.q.options, [], "two differently-typed columns are not a shared scale");
  assert.equal(m.q.columns.length, 2,
    "they are kept as the columns they are — a per-row grid reads a scale from columns[0], "
    + "so this is a real state, and throwing away authored columns to tidy it would be the loss");
  assert.equal(removed(m).length, 0, "nothing was lost, so nothing is reported lost");
  assert.equal(transformed(m).length, 0, "and nothing was reinterpreted behind anyone's back");
});

/* --------------------------------------------------------------- capabilities */

test("a variant that does not offer a setting does not inherit it", () => {
  const before = q({ type: "multi_select", settings: { minSelections: 1, maxSelections: 3, readOnly: false, hidden: false } as any });
  const m = migrateQuestionType(before, {
    baseType: "single_select", id: "single_select.radio", responseModel: "single_choice",
    capabilities: ["options", "other_specify"],
  });
  assert.equal((m.q.settings as any).maxSelections, undefined, "one choice has no maximum");
  assert.ok(removed(m).some((f) => f === "settings.maxSelections"));
});

test("exclusive flags are cleared where the type cannot honour them", () => {
  const before = q({
    type: "multi_select",
    options: [{ code: "1", label: "Tea", flags: [] }, { code: "9", label: "None", flags: ["none_of_above"] }] as any,
  });
  const m = migrateQuestionType(before, {
    baseType: "single_select", id: "single_select.radio", responseModel: "single_choice",
    capabilities: ["options"],
  });
  assert.deepEqual(m.q.options[1].flags, []);
  assert.ok(m.changes.some((c) => c.kind === "reset" && c.field === "options[].flags"));
  assert.equal(m.q.options.length, 2, "the option itself stays — only the flag it cannot keep goes");
});

/* -------------------------------------------------------------- safe changes */

test("a change within one response model moves nothing and says so", () => {
  const before = q({ variant: "single_select.radio" });
  const m = migrateQuestionType(before, {
    baseType: "dropdown", id: "single_select.dropdown", responseModel: "single_choice",
    capabilities: ["options", "other_specify", "search"],
  });
  assert.equal(m.safe, true);
  assert.equal(m.q.options.length, 3, "radio to dropdown is a rendering choice");
  assert.equal(m.changes.length, 0, "and there is nothing to warn about");
});

test("the input is never mutated", () => {
  const before = q();
  const copy = JSON.parse(JSON.stringify(before));
  migrateQuestionType(before, { baseType: "open_text" });
  assert.deepEqual(before, copy, "a preview must be able to show the change without making it");
});

/* ------------------------------------------------------------- legacy survey */

test("staleFields finds what a type change made before this existed", () => {
  /* exactly what the old switcher left behind */
  const legacy = q({
    type: "open_text",
    options: [{ code: "1", label: "Tea" }] as any,
    rows: [{ code: "r1", label: "Price" }] as any,
    settings: { minSelections: 2, readOnly: false, hidden: false } as any,
  });
  const found = staleFields(legacy);
  const fields = found.map((c) => c.field);
  assert.ok(fields.includes("options"));
  assert.ok(fields.includes("rows"));
  assert.ok(fields.includes("settings.minSelections"));
  assert.ok(found.every((c) => c.kind === "removed"), "nothing is transformed when the type is not changing");
});

test("a question in good order is reported clean", () => {
  assert.deepEqual(staleFields(q()), []);
  assert.deepEqual(staleFields(q({ type: "open_text", options: [] })), []);
  assert.deepEqual(staleFields(q({
    type: "matrix_single", rows: [{ code: "r1", label: "Price" }] as any,
  })), []);
});

test("a display-only block cannot stay required", () => {
  const m = migrateQuestionType(q({ required: true }), { baseType: "html" });
  assert.equal(m.q.required, false);
  assert.ok(m.changes.some((c) => c.kind === "reset" && c.field === "required"));
});
