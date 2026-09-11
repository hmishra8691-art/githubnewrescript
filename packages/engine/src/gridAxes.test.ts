import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { evaluateCondition } from "./evaluate.js";
import { lintQuestionLogic } from "./lintLogic.js";
import { gridAxes, valueChoicesFor, referenceShape, describeReference, gridScaleOptions } from "./gridAxes.js";

/**
 * ROWS ARE NOT COLUMNS, AND A COLUMN IS NOT ALWAYS A COLUMN.
 *
 * The brief's test: a matrix with rows A and B and columns Yes and No must
 * address four distinct cells with no ambiguity. These tests pin that, and
 * the two spellings of "column" the platform actually has — the scale of a
 * Likert grid, and a real column of a composite grid — so the lint, the
 * builder and the evaluator cannot drift apart again.
 */

const matrix: Question = {
  id: "m1", code: "Q1", variableName: "Q1", type: "matrix_single", text: "Rate these",
  options: [{ code: "Yes", label: "Yes", flags: [] }, { code: "No", label: "No", flags: [] }],
  rows: [
    { code: "A", label: "Product A", flags: [], validation: [], required: false },
    { code: "B", label: "Product B", flags: [], validation: [], required: false },
  ],
  columns: [], validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
} as unknown as Question;

const composite: Question = {
  id: "c1", code: "Q2", variableName: "Q2", type: "composite", text: "Tell us",
  options: [],
  rows: [{ code: "A", label: "Product A", flags: [], validation: [], required: false }],
  columns: [
    { id: "col_rating", label: "Rating", responseType: "single", variableStem: "RATE", options: [{ code: "1", label: "Poor", flags: [] }, { code: "2", label: "Good", flags: [] }], validation: [], readOnly: false },
    { id: "col_note", label: "Note", responseType: "text", variableStem: "NOTE", options: [], validation: [], readOnly: false },
  ],
  validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
} as unknown as Question;

const def = (q: Question) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Grid", version: "1.0" },
  questions: [q],
  flow: [{ id: "p1", type: "page", questionIds: [q.id] }],
});

test("a Likert grid: rows are the statements, the columns ARE the scale, and columnId holds a scale code", () => {
  const a = gridAxes(matrix);
  assert.equal(a.model, "per_row");
  assert.equal(a.isGrid, true);
  assert.deepEqual(a.rows.map((r) => r.ref), ["A", "B"]);
  assert.deepEqual(a.columns.map((c) => c.ref), ["Yes", "No"], "the scale is the column axis");
  assert.equal(a.columnMeaning, "option_code", "so a columnId is an option code, not a column id");
  assert.deepEqual(a.columns.map((c) => c.label), ["Yes", "No"]);

  // the four cells the brief names, each addressed without ambiguity
  assert.equal(describeReference(matrix, { rowCode: "A", columnId: "Yes" }), "Q1[Product A].Yes");
  assert.equal(describeReference(matrix, { rowCode: "A", columnId: "No" }), "Q1[Product A].No");
  assert.equal(describeReference(matrix, { rowCode: "B", columnId: "Yes" }), "Q1[Product B].Yes");
  assert.equal(describeReference(matrix, { rowCode: "B", columnId: "No" }), "Q1[Product B].No");
  assert.equal(referenceShape(matrix, { rowCode: "A", columnId: "Yes" }), "cell");
  assert.equal(referenceShape(matrix, { rowCode: "A" }), "row");
  assert.equal(referenceShape(matrix, { columnId: "Yes" }), "column");
  assert.equal(referenceShape(matrix, {}), "whole");

  // every row shares one scale, so the value list is the same whichever row is named
  assert.deepEqual(valueChoicesFor(matrix, { rowCode: "A" }).map((v) => v.ref), ["Yes", "No"]);
  assert.deepEqual(valueChoicesFor(matrix, {}).map((v) => v.ref), ["Yes", "No"]);
});

test("a composite grid: real columns, each with its own answer vocabulary", () => {
  const a = gridAxes(composite);
  assert.equal(a.model, "cells");
  assert.deepEqual(a.columns.map((c) => c.ref), ["col_rating", "col_note"]);
  assert.equal(a.columnMeaning, "column_id");
  // the value list follows the COLUMN, not the question
  assert.deepEqual(valueChoicesFor(composite, { columnId: "col_rating" }).map((v) => v.ref), ["1", "2"]);
  assert.deepEqual(valueChoicesFor(composite, { columnId: "col_note" }), [], "a text column has no code list");
  assert.deepEqual(valueChoicesFor(composite, {}), [], "and with no column named there is no single vocabulary");
  assert.equal(describeReference(composite, { rowCode: "A", columnId: "col_rating" }), "Q2[Product A].Rating");
});

test("a flat question has no axes at all", () => {
  const flat = { ...matrix, type: "single_select", rows: [] } as unknown as Question;
  const a = gridAxes(flat);
  assert.equal(a.model, "flat");
  assert.equal(a.isGrid, false);
  assert.deepEqual(a.rows, []); assert.deepEqual(a.columns, []);
  assert.equal(a.columnMeaning, "none");
  assert.deepEqual(valueChoicesFor(flat, {}).map((v) => v.ref), ["Yes", "No"], "its options are its values");
});

test("the scale is found wherever the question keeps it — q.options or columns[0].options", () => {
  assert.deepEqual(gridScaleOptions(matrix).map((o) => o.code), ["Yes", "No"]);
  const onColumn = {
    ...matrix, options: [],
    columns: [{ id: "c", label: "Scale", responseType: "single", variableStem: "S", options: [{ code: "1", label: "Low", flags: [] }, { code: "5", label: "High", flags: [] }], validation: [], readOnly: false }],
  } as unknown as Question;
  assert.deepEqual(gridScaleOptions(onColumn).map((o) => o.code), ["1", "5"], "the spelling the renderer accepts");
  assert.deepEqual(gridAxes(onColumn).columns.map((c) => c.ref), ["1", "5"]);
});

test("the lint knows which axis it is validating — the supported matrix reference stops being reported as a mistake", () => {
  const d = def({
    ...matrix,
    displayLogic: { type: "rule", source: { kind: "question", ref: "Q1", columnId: "Yes" }, operator: "answered" },
  } as unknown as Question);
  const issues = lintQuestionLogic(d, d.questions[0]);
  assert.equal(issues.filter((i) => /has no column/.test(i.message)).length, 0, "“any row answered Yes” is a real, tested reference");

  // a scale point that does not exist is still reported, in the grid's own words
  const bad = def({
    ...matrix,
    displayLogic: { type: "rule", source: { kind: "question", ref: "Q1", columnId: "Maybe" }, operator: "answered" },
  } as unknown as Question);
  const badIssues = lintQuestionLogic(bad, bad.questions[0]);
  assert.ok(badIssues.some((i) => /no scale point coded “Maybe”/.test(i.message)), badIssues.map((i) => i.message).join(" | "));

  // and a composite's real column id is validated as a column
  const comp = def({
    ...composite,
    displayLogic: { type: "rule", source: { kind: "question", ref: "Q2", rowCode: "A", columnId: "col_nope" }, operator: "answered" },
  } as unknown as Question);
  assert.ok(lintQuestionLogic(comp, comp.questions[0]).some((i) => /has no column “col_nope”/.test(i.message)));
});

test("a grid rule that names neither axis is flagged — it reads the whole grid and can never match", () => {
  const d = def({
    ...matrix,
    displayLogic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: "Yes" },
  } as unknown as Question);
  const issues = lintQuestionLogic(d, d.questions[0]);
  assert.ok(issues.some((i) => /is a grid, so “eq” needs a row or a column/.test(i.message)), issues.map((i) => i.message).join(" | "));

  // and it really cannot match: the evidence behind the warning
  const st = createResponseState(d, { seed: 1, sessionId: "t" });
  st.answers.m1 = { A: "Yes", B: "No" } as never;
  assert.equal(evaluateCondition(d.questions[0].displayLogic, { def: d, state: st }), false);
  // …while the same rule WITH an axis matches
  assert.equal(evaluateCondition(
    { type: "rule", source: { kind: "question", ref: "Q1", rowCode: "A" }, operator: "eq", value: "Yes" } as never,
    { def: d, state: st },
  ), true, "Q1[Product A] = Yes");
  assert.equal(evaluateCondition(
    { type: "rule", source: { kind: "question", ref: "Q1", columnId: "Yes" }, operator: "answered" } as never,
    { def: d, state: st },
  ), true, "any row answered Yes");
  assert.equal(evaluateCondition(
    { type: "rule", source: { kind: "question", ref: "Q1", columnId: "Maybe" }, operator: "answered" } as never,
    { def: d, state: st },
  ), false, "no row answered Maybe");
  assert.equal(evaluateCondition(
    { type: "rule", source: { kind: "question", ref: "Q1", rowCode: "B", columnId: "Yes" }, operator: "eq", value: "Yes" } as never,
    { def: d, state: st },
  ), false, "Q1[Product B].Yes — the cell, not the row, not the column");
  assert.equal(evaluateCondition(
    { type: "rule", source: { kind: "question", ref: "Q1", rowCode: "B" }, operator: "eq", value: "No" } as never,
    { def: d, state: st },
  ), true, "Q1[Product B] = No");
});

test("a row code is not an answer: comparing a grid's value against one is reported", () => {
  const d = def({
    ...matrix,
    displayLogic: { type: "rule", source: { kind: "question", ref: "Q1", rowCode: "A" }, operator: "eq", value: "B" },
  } as unknown as Question);
  const issues = lintQuestionLogic(d, d.questions[0]);
  assert.ok(issues.some((i) => /has no option coded “B”/.test(i.message)), issues.map((i) => i.message).join(" | "));
});
