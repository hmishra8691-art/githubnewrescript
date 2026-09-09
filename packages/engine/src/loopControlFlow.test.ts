import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  MAX_LOOP_ITERATIONS,
  createResponseState,
  lintSurveyLogic,
  loopVariables,
  resolveLoopItems,
  validateQuestion,
} from "./index.js";

/**
 * LOOP CONTROL FLOW AND THE NEW SOURCES.
 *
 * The loop node already resolved items through one pipeline
 * (source → filter → eligibleIf → order → count → contexts) and everything
 * read it. These tests pin what was added to that pipeline rather than beside
 * it: SKIP as a filter stage, BREAK as a truncation of the ordered sequence,
 * matrix rows/columns and set expressions as sources, aggregates over what the
 * iterations answered, and the two safety ceilings.
 *
 * The first test is the one that matters most: a loop written before any of
 * this must resolve to exactly what it always did.
 */

const q = (o: any): any => ({
  id: o.id, code: o.code ?? o.id.toUpperCase(), variableName: o.code ?? o.id.toUpperCase(),
  type: o.type ?? "multi_select", text: o.text ?? o.id,
  options: o.options ?? [], rows: o.rows ?? [], columns: o.columns ?? [],
  validation: o.validation ?? [], skipLogic: [], punches: [],
  settings: {}, required: o.required ?? false,
});

const BRANDS = [
  { code: "apple", label: "Apple" },
  { code: "google", label: "Google" },
  { code: "xiaomi", label: "Xiaomi" },
  { code: "other", label: "Other" },
];

/** A survey with Q1 (brands), Q7 (a rating asked inside the loop), and one loop. */
const build = (loopExtra: Record<string, unknown>, questions: any[] = []) =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "loops", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: BRANDS }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
      ...questions,
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "BRAND",
        source: { kind: "question", questionId: "q1", filter: "selected" },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
        ...loopExtra,
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

const stateWith = (def: any, answers: Record<string, unknown>) => {
  const st = createResponseState(def);
  Object.assign(st.answers, answers);
  return st;
};

const loopNode = (def: any) => def.flow.find((n: any) => n.type === "loop");
const codesOf = (def: any, st: any) =>
  resolveLoopItems(def, st, loopNode(def)).map((i) => i.code);

/* =========================================== nothing existing changed */

test("a loop written before any of this resolves exactly as before", () => {
  const def = build({});
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"] });
  assert.deepEqual(codesOf(def, st), ["apple", "google", "xiaomi"]);
});

/* ================================================== SKIP / CONTINUE */

test("skipIf drops an item without consuming its position (§13, §15)", () => {
  const def = build({
    skipIf: { type: "rule", source: { kind: "loop", ref: "code" }, operator: "eq", value: "other" },
  });
  const st = stateWith(def, { q1: ["apple", "other", "xiaomi"] });
  assert.deepEqual(codesOf(def, st), ["apple", "xiaomi"]);
});

test("a skipped item does not consume a max-count slot", () => {
  const def = build({
    skipIf: { type: "rule", source: { kind: "loop", ref: "code" }, operator: "eq", value: "apple" },
    count: { mode: "max", value: 2 },
  });
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"] });
  // apple is skipped BEFORE the cap, so the cap still yields two real items
  assert.deepEqual(codesOf(def, st), ["google", "xiaomi"]);
});

/* ========================================================= BREAK */

test("breakIf keeps the triggering iteration and drops the rest (§14)", () => {
  // "run the block, then break if this brand scored 5 or more"
  const def = build({
    breakIf: { type: "rule", source: { kind: "question", ref: "Q7" }, operator: "gte", value: 5 },
  });
  const st = stateWith(def, {
    q1: ["apple", "google", "xiaomi"],
    "q7@apple": 3,
    "q7@google": 7,   // this iteration triggers the break
  });
  assert.deepEqual(codesOf(def, st), ["apple", "google"]);
});

test("breakIf truncates nothing while the answers that would trigger it are absent", () => {
  const def = build({
    breakIf: { type: "rule", source: { kind: "question", ref: "Q7" }, operator: "gte", value: 5 },
  });
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"] });
  assert.deepEqual(codesOf(def, st), ["apple", "google", "xiaomi"],
    "iterations the respondent has not reached must not break the loop early");
});

test("editing the answer away restores the later iterations", () => {
  const def = build({
    breakIf: { type: "rule", source: { kind: "question", ref: "Q7" }, operator: "gte", value: 5 },
  });
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"], "q7@apple": 9 });
  assert.deepEqual(codesOf(def, st), ["apple"]);
  st.answers["q7@apple"] = 1;
  assert.deepEqual(codesOf(def, st), ["apple", "google", "xiaomi"]);
});

/* ============================================== matrix rows / columns */

test("a loop can iterate a matrix's rows (§22)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "m", version: "1.0" },
    questions: [
      q({
        id: "m1", code: "M1", type: "matrix_single",
        rows: [{ code: "r1", label: "Apple" }, { code: "r2", label: "Samsung" }],
        options: [{ code: "1", label: "Poor" }, { code: "5", label: "Great" }],
      }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "ROW",
        source: { kind: "question", questionId: "m1", dimension: "rows", filter: "all" },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = stateWith(def, {});
  const items = resolveLoopItems(def, st, loopNode(def));
  assert.deepEqual(items.map((i) => i.code), ["r1", "r2"]);
  assert.deepEqual(items.map((i) => i.label), ["Apple", "Samsung"],
    "rows must carry their real labels, not bare codes");
});

test("iterating only the matrix rows that were answered", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "m", version: "1.0" },
    questions: [
      q({
        id: "m1", code: "M1", type: "matrix_single",
        rows: [{ code: "r1", label: "Apple" }, { code: "r2", label: "Samsung" }],
        options: [{ code: "1", label: "Poor" }, { code: "5", label: "Great" }],
      }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "ROW",
        source: { kind: "question", questionId: "m1", dimension: "rows", filter: "selected" },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = stateWith(def, { m1: { r2: "5" } });
  assert.deepEqual(resolveLoopItems(def, st, loopNode(def)).map((i) => i.code), ["r2"]);
});

test("a loop can iterate a matrix's columns (§23)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "m", version: "1.0" },
    questions: [
      q({
        id: "m1", code: "M1", type: "matrix_single",
        rows: [{ code: "r1", label: "Apple" }],
        options: [{ code: "never", label: "Never" }, { code: "often", label: "Often" }],
      }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "COL",
        source: { kind: "question", questionId: "m1", dimension: "columns", filter: "all" },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const items = resolveLoopItems(def, stateWith(def, {}), loopNode(def));
  assert.deepEqual(items.map((i) => i.label), ["Never", "Often"]);
});

/* ==================================================== set expression */

test("a loop can iterate the intersection of two questions (§20)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "sets", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: BRANDS }),
      q({ id: "q2", code: "Q2", options: BRANDS }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "COMMON",
        source: {
          kind: "setExpression",
          expr: {
            kind: "op", operator: "intersection",
            left: { kind: "ref", questionId: "q1", selection: "selected" },
            right: { kind: "ref", questionId: "q2", selection: "selected" },
          },
        },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"], q2: ["google", "xiaomi", "other"] });
  const items = resolveLoopItems(def, st, loopNode(def));
  assert.deepEqual(items.map((i) => i.code), ["google", "xiaomi"]);
  assert.deepEqual(items.map((i) => i.label), ["Google", "Xiaomi"],
    "codes from a set expression must resolve to their source question's labels");
});

/* ======================================================= aggregates */

test("loop aggregates publish results usable in later logic (§11, §12, §37)", () => {
  const def = build({
    aggregates: [
      { name: "AVG_SCORE", questionRef: "Q7", op: "avg" },
      { name: "TOTAL", questionRef: "Q7", op: "sum" },
      { name: "ANSWERED", questionRef: "Q7", op: "count" },
      {
        name: "HIGH", questionRef: "Q7", op: "countIf",
        where: { type: "rule", source: { kind: "question", ref: "Q7" }, operator: "gte", value: 4 },
      },
    ],
  });
  const st = stateWith(def, {
    q1: ["apple", "google", "xiaomi"],
    "q7@apple": 5, "q7@google": 3, "q7@xiaomi": 4,
  });
  const vars = loopVariables(def, st);
  assert.equal(vars.LOOP_BRAND_TOTAL, 12);
  assert.equal(vars.LOOP_BRAND_AVG_SCORE, 4);
  assert.equal(vars.LOOP_BRAND_ANSWERED, 3);
  assert.equal(vars.LOOP_BRAND_HIGH, 2);
});

test("an average ignores iterations the respondent has not answered", () => {
  const def = build({ aggregates: [{ name: "AVG_SCORE", questionRef: "Q7", op: "avg" }] });
  const st = stateWith(def, { q1: ["apple", "google", "xiaomi"], "q7@apple": 4, "q7@google": 6 });
  assert.equal(loopVariables(def, st).LOOP_BRAND_AVG_SCORE, 5,
    "two answers average 5 — blanks must not drag it toward zero");
});

/* ==================================================== validation (§28) */

test("a validation error inside a loop names its iteration", () => {
  const def = build({});
  const target = q({
    id: "q7", code: "Q7", type: "numeric",
    validation: [{ id: "v1", kind: "max_value", value: 5, message: "Rate 1-5." }],
  });
  const st = stateWith(def, { q1: ["apple", "google"] });
  const errs = validateQuestion(def, target, 9, {
    def, state: st,
    loop: { loopVar: "BRAND", code: "google", label: "Google", index: 2, loopId: "L1", count: 2 },
  });
  assert.equal(errs.length, 1);
  assert.deepEqual(errs[0].loop, {
    loopId: "L1", loopVar: "BRAND", itemCode: "google", itemLabel: "Google", index: 2,
  });
});

test("a validation error outside any loop carries no iteration", () => {
  const def = build({});
  const target = q({
    id: "q7", code: "Q7", type: "numeric",
    validation: [{ id: "v1", kind: "max_value", value: 5, message: "Rate 1-5." }],
  });
  const errs = validateQuestion(def, target, 9, { def, state: stateWith(def, {}) });
  assert.equal(errs[0].loop, undefined);
});

/* ========================================================== safety (§42) */

test("an absurd numeric count is capped rather than allocating forever", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "c", version: "1.0" },
    questions: [q({ id: "n1", code: "N1", type: "numeric" }), q({ id: "q7", code: "Q7", type: "numeric" })],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "I",
        source: { kind: "count", count: { kind: "question", ref: "N1" } },
        children: [{ type: "page", id: "p1", questionIds: ["q7"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = stateWith(def, { n1: 1_000_000 });
  assert.equal(resolveLoopItems(def, st, loopNode(def)).length, MAX_LOOP_ITERATIONS);
});

test("nesting loops too deeply is an author-time error", () => {
  const nest = (depth: number): any =>
    depth === 0
      ? { type: "page", id: "pInner", questionIds: ["q7"] }
      : {
          type: "loop", id: `L${depth}`, loopVar: `V${depth}`,
          source: { kind: "question", questionId: "q1", filter: "selected" },
          children: [nest(depth - 1)],
        };
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "deep", version: "1.0" },
    questions: [q({ id: "q1", code: "Q1", options: BRANDS }), q({ id: "q7", code: "Q7", type: "numeric" })],
    flow: [nest(6), { type: "end", id: "e1", status: "complete" }],
  });
  const issues = lintSurveyLogic(def);
  assert.ok(
    issues.some((i) => i.level === "error" && /nested 6 deep/.test(i.message)),
    `expected a nesting-depth error, got: ${issues.map((i) => i.message).join(" | ")}`,
  );
});

/* ============================================ resolve-once mode (§32) */

test("resolveSource:\"once\" freezes the iteration list after it first resolves", () => {
  const def = build({ resolveSource: "once" });
  const st = stateWith(def, { q1: ["apple", "google"] });
  assert.deepEqual(codesOf(def, st), ["apple", "google"]);
  // the respondent goes back and adds a brand mid-loop
  st.answers.q1 = ["apple", "google", "xiaomi"];
  assert.deepEqual(codesOf(def, st), ["apple", "google"],
    "a frozen loop must not renumber iterations the respondent has already answered");
});

test("the default mode still re-evaluates", () => {
  const def = build({});
  const st = stateWith(def, { q1: ["apple", "google"] });
  assert.deepEqual(codesOf(def, st), ["apple", "google"]);
  st.answers.q1 = ["apple", "google", "xiaomi"];
  assert.deepEqual(codesOf(def, st), ["apple", "google", "xiaomi"]);
});

test("resolve-once does not freeze an empty list before the loop is reached", () => {
  const def = build({ resolveSource: "once" });
  const st = stateWith(def, {});
  assert.deepEqual(codesOf(def, st), []);
  st.answers.q1 = ["apple"];
  assert.deepEqual(codesOf(def, st), ["apple"],
    "the snapshot must be taken when there is something to snapshot");
});
