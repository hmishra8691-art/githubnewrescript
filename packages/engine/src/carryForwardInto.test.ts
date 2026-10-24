import test from "node:test";
import assert from "node:assert/strict";
import { carryForwardDestinations, normalizeCarryForwardInto, carryForwardDestinationIsFixed, carryForwardDestinationLabel } from "./carryForwardInto.js";

/** B47–B55 (23/10/2026): carry-forward destinations follow the target question's type. */
const values = (type: string, variant?: string) => carryForwardDestinations({ type, variant }).map((d) => d.value);
const labels = (type: string, variant?: string) => carryForwardDestinations({ type, variant }).map((d) => d.label);

test("single-select and multi-select have ONE destination — the answer list, labelled as rows", () => {
  for (const type of ["single_select", "multi_select", "dropdown", "multi_dropdown", "image_select", "ranking"]) {
    assert.deepEqual(values(type), ["options"], type);
    assert.match(labels(type)[0], /answer list \(rows\)/, type);
    assert.equal(carryForwardDestinationIsFixed({ type }), true, type);
  }
});

test("per-row grids offer rows and columns only — columns are stored as the grid's scale (options), never the inert question-level \"columns\"", () => {
  for (const type of ["matrix_single", "matrix_multi", "matrix_numeric", "matrix_text", "matrix_dropdown"]) {
    assert.deepEqual(labels(type), ["→ into rows", "→ into columns"], type);
    assert.deepEqual(values(type), ["rows", "options"], type);
    assert.ok(!labels(type).some((l) => /option/i.test(l)), `${type}: ${labels(type)}`);
    assert.equal(carryForwardDestinationIsFixed({ type }), false);
  }
  assert.equal(carryForwardDestinationLabel({ type: "matrix_multi" }, "options"), "→ into columns", "the brand-tracker grid reads as 'into columns'");
});

test("a column table carries into its rows (its columns carry per column)", () => {
  assert.deepEqual(values("composite"), ["rows"]);
  assert.deepEqual(values("custom_table"), ["rows"]);
});

test("a list of fields carries into its rows; a plain open end has nowhere to carry", () => {
  assert.deepEqual(values("text_list"), ["rows"]);
  assert.deepEqual(values("numeric_list"), ["rows"]);
  assert.deepEqual(values("open_text"), []);
  assert.deepEqual(values("numeric"), []);
});

test("stored values: a value the type takes is kept (behaviour identical); others normalise", () => {
  // what every existing choice question and grid stores — kept as is
  assert.equal(normalizeCarryForwardInto({ type: "single_select" }, "options"), "options");
  assert.equal(normalizeCarryForwardInto({ type: "matrix_multi" }, "options"), "options");
  assert.equal(normalizeCarryForwardInto({ type: "matrix_single" }, "rows"), "rows");
  // the client's vocabulary: "rows" of a single-select = its answer list
  assert.equal(normalizeCarryForwardInto({ type: "multi_select" }, "rows"), "options");
  assert.equal(normalizeCarryForwardInto({ type: "single_select" }, "columns"), "options");
  // a grid's inert "columns" means its column choices
  assert.equal(normalizeCarryForwardInto({ type: "matrix_single" }, "columns"), "options");
  assert.equal(normalizeCarryForwardInto({ type: "matrix_single" }, undefined), "rows");
  // fields / tables
  assert.equal(normalizeCarryForwardInto({ type: "text_list" }, "options"), "rows");
  assert.equal(normalizeCarryForwardInto({ type: "custom_table" }, "columns"), "rows");
  // no destination at all: the stored value is left alone rather than invented
  assert.equal(normalizeCarryForwardInto({ type: "open_text" }, "columns"), "columns");
  assert.equal(normalizeCarryForwardInto({ type: "open_text" }, undefined), "options");
});
