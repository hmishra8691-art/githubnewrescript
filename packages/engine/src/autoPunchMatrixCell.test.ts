import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { resolvePunches, applyPunches, evaluateSetExpr, parseSetExpression, formatSetExpression } from "./setExpression.js";
import { validateSetExpr } from "./setExpression.js";
import { createResponseState, answerKey } from "./state.js";
import { tracePunches } from "./logicTrace.js";
import type { EvalContext } from "./evaluate.js";

/**
 * MATRIX / COMPOSITE CELL TARGETING — the fix for the confirmed bug where a
 * `select` punch on a matrix/composite question replaced the WHOLE per-row
 * answer object with a bare code (see the plan's gap #1). Every test below
 * exercises `resolvePunches`/`applyPunches` directly, the same functions
 * `prefillQuestions`/the runtime call.
 */

const ctxFor = (d: SurveyDefinition, answers: Record<string, unknown> = {}): EvalContext => {
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  return { def: d, state, loop: null, quotaCounts: {} };
};

/* -------------------------------------------------------- fixtures */

const plainMatrixDef = (punches: any[] = []) =>
  SurveyDefinition.parse({
    meta: { id: "pm", code: "PM", title: "Plain matrix punch", version: "1.0" },
    questions: [
      {
        id: "src", code: "SRC", variableName: "SRC", type: "single_select", text: "Pick one",
        options: [
          { code: "hi", label: "High" },
          { code: "lo", label: "Low" },
        ],
      },
      {
        id: "qm", code: "QM", variableName: "QM", type: "matrix_single", text: "Rate each",
        rows: [
          { code: "apple", label: "Apple" },
          { code: "banana", label: "Banana" },
        ],
        options: [
          { code: "sat", label: "Satisfied" },
          { code: "dis", label: "Dissatisfied" },
        ],
        columns: [],
        punches,
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["src", "qm"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

const compositeDef = (punches: any[] = []) =>
  SurveyDefinition.parse({
    meta: { id: "cp", code: "CP", title: "Composite cell punch", version: "1.0" },
    questions: [
      {
        id: "src", code: "SRC", variableName: "SRC", type: "numeric", text: "A number",
      },
      {
        id: "qc", code: "QC", variableName: "QC", type: "composite", text: "Details",
        rows: [
          { code: "apple", label: "Apple" },
          { code: "banana", label: "Banana" },
        ],
        options: [],
        columns: [
          { id: "qty", label: "Quantity", responseType: "numeric", variableStem: "QC_QTY", options: [] },
          {
            id: "grade", label: "Grade", responseType: "single", variableStem: "QC_GRADE",
            options: [{ code: "a", label: "A" }, { code: "b", label: "B" }],
          },
        ],
        punches,
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["src", "qc"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

/* ----------------------------------------------- the confirmed bug, fixed */

test("BUG FIX: a select punch targeting one matrix row never overwrites the whole per-row answer object", () => {
  const d = plainMatrixDef([
    {
      id: "r1", source: { kind: "codes", codes: ["sat"] }, action: "select",
      targetRow: "apple", recompute: "always", mapping: [], ignoreUnmatched: true,
    },
  ]);
  const q = d.questions[1];
  const ctx = ctxFor(d, { qm: { banana: "dis" } }); // Banana already answered
  const written = applyPunches(q, ctx, (qq) => answerKey(qq.id, null));
  assert.ok(written);
  const value = ctx.state.answers[answerKey("qm", null)] as Record<string, unknown>;
  // Banana's prior answer must survive untouched — the old code replaced the
  // WHOLE object with the bare code "sat".
  assert.equal(value.banana, "dis");
  assert.equal(value.apple, "sat");
});

test("a plain matrix row punch writes only the addressed row's scale value", () => {
  const d = plainMatrixDef([
    {
      id: "r1", source: { kind: "ref", questionId: "src", selection: "selected" }, action: "select",
      targetRow: "banana", recompute: "always", mapping: [{ from: "hi", to: "sat" }, { from: "lo", to: "dis" }],
      ignoreUnmatched: true,
    },
  ]);
  const q = d.questions[1];
  const ctx = ctxFor(d, { src: "hi" });
  applyPunches(q, ctx, (qq) => answerKey(qq.id, null));
  const value = ctx.state.answers[answerKey("qm", null)] as Record<string, unknown>;
  assert.equal(value.banana, "sat");
  assert.equal(value.apple, undefined);
});

test("a matrix row target that does not exist reports every source code unmatched, and writes nothing", () => {
  const d = plainMatrixDef([
    {
      id: "r1", source: { kind: "codes", codes: ["sat"] }, action: "select",
      targetRow: "cherry", recompute: "always", mapping: [], ignoreUnmatched: false,
    },
  ]);
  const q = d.questions[1];
  const ctx = ctxFor(d);
  const result = resolvePunches(q, ctx);
  assert.deepEqual(result.unmatched, ["sat"]);
  assert.equal(result.cells.length, 0);
});

/* -------------------------------------------------- composite cell writes */

test("a composite cell punch (targetRow + targetColumn) writes only that cell — siblings untouched", () => {
  const d = compositeDef([
    {
      id: "r1", source: { kind: "codes", codes: [3] }, action: "set_value",
      targetRow: "apple", targetColumn: "qty", recompute: "always", mapping: [], ignoreUnmatched: true,
    },
  ]);
  const q = d.questions[1];
  const ctx = ctxFor(d, { qc: { apple: { grade: "a" }, banana: { qty: 9, grade: "b" } } });
  applyPunches(q, ctx, (qq) => answerKey(qq.id, null));
  const value = ctx.state.answers[answerKey("qc", null)] as any;
  assert.equal(value.apple.qty, 3);
  assert.equal(value.apple.grade, "a", "the row's other column survives");
  assert.deepEqual(value.banana, { qty: 9, grade: "b" }, "the other row is untouched");
});

test("a composite cell punch on a select-type column only accepts that column's own options", () => {
  const d = compositeDef([
    {
      id: "r1", source: { kind: "codes", codes: ["a", "z"] }, action: "select",
      targetRow: "apple", targetColumn: "grade", recompute: "always", mapping: [], ignoreUnmatched: false,
    },
  ]);
  const q = d.questions[1];
  const ctx = ctxFor(d);
  const result = resolvePunches(q, ctx);
  assert.deepEqual(result.unmatched, ["z"]);
  assert.equal(result.cells.length, 1);
  assert.deepEqual(result.cells[0].select, ["a"]);
});

/* ---------------------------------------------------- priority ordering */

test("§29-30: two independent set_value rules conflict — the HIGHER priority rule wins, not array order", () => {
  // set_value overwrites `result.setValue` outright (no array-position quirk
  // the way a whole-question select's "first code in the array wins" has),
  // so it is the clean case for proving priority actually decides the
  // winner: the LOWER-priority rule is later in the array — without
  // priority ordering it would be the one applied last and would win.
  const d = plainMatrixDef();
  const q = {
    ...d.questions[1],
    options: [{ code: "x", label: "X" }, { code: "y", label: "Y" }],
    rows: [],
    columns: [],
    punches: [
      { id: "high", source: { kind: "codes", codes: ["x"] }, action: "set_value", priority: 5, recompute: "always", mapping: [], ignoreUnmatched: true },
      { id: "low", source: { kind: "codes", codes: ["y"] }, action: "set_value", priority: 1, recompute: "always", mapping: [], ignoreUnmatched: true },
    ],
  } as any;
  const result = resolvePunches(q, ctxFor(d));
  assert.deepEqual(result.setValue, ["x"], "priority 5 wins even though it is earlier in the array");
});

test("priority absent everywhere reorders nothing — original array order is preserved", () => {
  const d = plainMatrixDef();
  const q = {
    ...d.questions[1],
    options: [{ code: "x", label: "X" }, { code: "y", label: "Y" }],
    rows: [],
    columns: [],
    punches: [
      { id: "r1", source: { kind: "codes", codes: ["x"] }, action: "select", recompute: "always", mapping: [], ignoreUnmatched: true },
      { id: "r2", source: { kind: "codes", codes: ["y"] }, action: "select", recompute: "always", mapping: [], ignoreUnmatched: true },
    ],
  } as any;
  const result = resolvePunches(q, ctxFor(d));
  assert.deepEqual(result.select, ["x", "y"], "no survey without priorities set sees its rule order change");
});

/* --------------------------------------------------- loopItem / expr kinds */

test("SetExpr loopItem: CURRENT_ITEM_CODE and CURRENT_ITEM.<ref> resolve via the same loop resolver conditions use", () => {
  const d = plainMatrixDef();
  const ctx: EvalContext = {
    def: d,
    state: createResponseState(d),
    loop: { loopVar: "l", code: "apple", label: "Apple", index: 1, references: { Product_ID: "P100" } },
    quotaCounts: {},
  };
  assert.deepEqual(evaluateSetExpr({ kind: "loopItem", ref: null }, ctx), ["apple"]);
  assert.deepEqual(evaluateSetExpr({ kind: "loopItem", ref: "Product_ID" }, ctx), ["P100"]);
  // outside a loop, resolves to nothing rather than guessing
  const outside: EvalContext = { def: d, state: createResponseState(d), loop: null, quotaCounts: {} };
  assert.deepEqual(evaluateSetExpr({ kind: "loopItem", ref: null }, outside), []);
});

test("SetExpr expr: a calculated value becomes a punch payload through the same resolver as a calculation/condition", () => {
  const d = plainMatrixDef();
  const state = createResponseState(d);
  state.calculated.SCORE = 7;
  const ctx: EvalContext = { def: d, state, loop: null, quotaCounts: {} };
  assert.deepEqual(evaluateSetExpr({ kind: "expr", expression: "SCORE * 2" }, ctx), [14]);
  // a broken/empty result punches nothing rather than throwing
  assert.deepEqual(evaluateSetExpr({ kind: "expr", expression: "NOT_A_REAL_NAME" }, ctx), []);
});

test("parseSetExpression / formatSetExpression round-trip CURRENT_ITEM, CURRENT_ITEM.<ref>, and EXPR(...)", () => {
  const d = plainMatrixDef();
  const a = parseSetExpression(d, "CURRENT_ITEM_CODE");
  assert.deepEqual(a.expr, { kind: "loopItem", ref: null });
  const b = parseSetExpression(d, "CURRENT_ITEM.Product_ID");
  assert.deepEqual(b.expr, { kind: "loopItem", ref: "Product_ID" });
  const c = parseSetExpression(d, "EXPR(SUM(Q1, Q2) + 5)");
  assert.equal(c.errors.length, 0);
  assert.deepEqual(c.expr, { kind: "expr", expression: "SUM(Q1, Q2) + 5" });
  assert.equal(formatSetExpression(d, c.expr), "EXPR(SUM(Q1, Q2) + 5)");
  const bad = parseSetExpression(d, "EXPR(1 +)");
  assert.ok(bad.errors.length > 0, "an unparseable calc expression is refused at parse time");
});

test("validateSetExpr flags CURRENT_ITEM used outside a loop", () => {
  const d = plainMatrixDef();
  const issues = validateSetExpr(d, "qm", { kind: "loopItem", ref: null });
  assert.ok(issues.some((i) => i.level === "warning" && /loop/i.test(i.message)));
});

/* --------------------------------------------------------- trace winner */

test("tracePunches names the final winning value when two independent rules conflict", () => {
  const d = plainMatrixDef([
    { id: "r1", label: "Set to sat", source: { kind: "codes", codes: ["sat"] }, action: "set_value", targetRow: "apple", priority: 1, recompute: "always", mapping: [], ignoreUnmatched: true },
    { id: "r2", label: "Set to dis", source: { kind: "codes", codes: ["dis"] }, action: "set_value", targetRow: "apple", priority: 5, recompute: "always", mapping: [], ignoreUnmatched: true },
  ]);
  const ctx = ctxFor(d);
  const trace = tracePunches(d, "qm", ctx);
  assert.ok(trace);
  assert.equal(trace!.rules.length, 2);
  assert.ok(trace!.rules.every((r) => r.applied), "both are independent rules — both apply");
  assert.ok(trace!.conflicts.length > 0, "the trace names the conflict");
  assert.match(trace!.conflicts[0], /Set to sat/);
  assert.match(trace!.conflicts[0], /Set to dis/);
  const cell = trace!.finalValue.cells.find((c) => String(c.row) === "apple");
  assert.equal(cell?.value, "dis", "priority 5 wins over priority 1");
});
