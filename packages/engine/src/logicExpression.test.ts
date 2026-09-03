import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type ConditionGroup } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, referenceTree, OPERATOR_SPELLING,
} from "./logicExpression.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";

/* ------------------------------------------------------------- fixtures */

/**
 * One of each shape the reference syntax has to cope with:
 *   Q1  a plain multi-select      → Q1.brandA
 *   Q2  a matrix (rows × scale)   → Q2.R1.C2
 *   Q3  numeric                   → Q3 > 25
 *   Q4  a composite table         → Q4.R1.spend
 */
const def = () =>
  SurveyDefinition.parse({
    meta: { id: "ex", code: "EX", title: "Expressions", version: "1.0" },
    questions: [
      {
        id: "q_brand", code: "Q1", variableName: "BRAND", type: "multi_select", text: "Which brands?",
        options: [
          { code: "brandA", label: "Brand A" },
          { code: "brandB", label: "Brand B" },
          { code: "brandC", label: "Brand C" },
        ],
      },
      {
        id: "q_matrix", code: "Q2", variableName: "SAT", type: "matrix_single", text: "Rate each",
        options: [{ code: 1, label: "Poor" }, { code: 2, label: "OK" }, { code: 3, label: "Good" }],
        rows: [
          { code: 1, label: "Service", flags: [], validation: [], required: false },
          { code: 2, label: "Price", flags: [], validation: [], required: false },
        ],
      },
      { id: "q_age", code: "Q3", variableName: "AGE", type: "numeric", text: "Age" },
      {
        id: "q_tab", code: "Q4", variableName: "TAB", type: "composite", text: "Per brand",
        rows: [{ code: "a", label: "Brand A", flags: [], validation: [], required: false }],
        columns: [
          { id: "spend", label: "Spend", responseType: "numeric", variableStem: "SPEND", options: [], validation: [], readOnly: false },
          { id: "freq", label: "Frequency", responseType: "numeric", variableStem: "FREQ", options: [], validation: [], readOnly: false },
        ],
      },
    ],
    calculations: [
      { id: "c1", targetVariable: "SCORE", expression: "Q3", trigger: "on_page_submit" },
    ],
    embeddedData: [{ name: "PANEL" }],
  });

const parse = (src: string, opts?: { perOption?: boolean }) => parseLogicExpression(def(), src, opts);
const fmt = (c: Condition | undefined, pretty = false) =>
  formatCondition(def(), c, { pretty });

/** Parse, then evaluate against a set of answers. */
const run = (src: string, answers: Record<string, unknown>) => {
  const d = def();
  const { condition, errors } = parseLogicExpression(d, src);
  assert.deepEqual(errors, [], `parses: ${src}`);
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  return evaluateCondition(condition, { def: d, state, loop: null });
};

/** A parse that must succeed, returning the tree. */
const tree = (src: string): Condition => {
  const r = parse(src);
  assert.deepEqual(r.errors, [], `no errors for ${src}: ${JSON.stringify(r.errors)}`);
  assert.ok(r.condition, `a tree for ${src}`);
  return r.condition!;
};

/* ========================================================= §25: references */

test("a bare reference to an option means that option is selected", () => {
  const c = tree("Q1.brandA") as any;
  assert.equal(c.type, "rule");
  assert.equal(c.source.ref, "q_brand", "resolved to the question's id, not its code");
  assert.equal(c.operator, "selected");
  assert.equal(c.value, "brandA");
  assert.equal(c.source.rowCode, undefined);
});

test("a bare reference to a row means that row is answered", () => {
  const c = tree("Q2.R1") as any;
  assert.equal(c.source.ref, "q_matrix");
  assert.equal(c.source.rowCode, "1", "R1 resolved to the row whose code is 1");
  assert.equal(c.operator, "answered");
});

test("§25: row + column — Q2.R1.C2 is “row 1 answered scale point 2”", () => {
  const c = tree("Q2.R1.C2") as any;
  assert.equal(c.source.ref, "q_matrix");
  assert.equal(c.source.rowCode, "1");
  assert.equal(c.operator, "selected");
  assert.equal(c.value, "2", "the scale point lives in the value, as the visual builder stores it");
});

test("a composite table's third segment is a column, by id or by name", () => {
  const byId = tree("Q4.a.spend") as any;
  assert.equal(byId.source.rowCode, "a");
  assert.equal(byId.source.columnId, "spend");
  assert.equal(byId.operator, "answered");

  const byPosition = tree("Q4.R1.C2") as any;
  assert.equal(byPosition.source.rowCode, "a", "R1 fell through to the first row");
  assert.equal(byPosition.source.columnId, "freq", "C2 is the second column");
});

test("references resolve by code, variable name or id", () => {
  for (const ref of ["Q1.brandA", "BRAND.brandA", "q_brand.brandA"]) {
    assert.equal((tree(ref) as any).source.ref, "q_brand", ref);
  }
});

test("calculations, embedded data, loops and quotas have their own namespaces", () => {
  assert.equal((tree("calc.SCORE > 10") as any).source.kind, "calculation");
  assert.equal((tree("ed.PANEL = abc") as any).source.kind, "embedded");
  assert.equal((tree("loop.code = x") as any).source.kind, "loop");
  const c = tree("calc.SCORE > 10") as any;
  assert.equal(c.source.ref, "SCORE");
  assert.equal(c.value, 10, "a number stays a number");
});

test("“@option” is only legal in option-level logic", () => {
  const bad = parse("@option.code = brandA");
  assert.ok(bad.errors.length, "refused outside per-option logic");
  assert.match(bad.errors[0].message, /option-level/);

  const good = parse("@option.code = brandA", { perOption: true });
  assert.deepEqual(good.errors, []);
  assert.equal((good.condition as any).source.kind, "option");
});

/* ========================================================= §25: operators */

test("§25: AND, OR and NOT build the canonical groups", () => {
  const and = tree("Q1.brandA AND Q2.R1") as ConditionGroup;
  assert.equal(and.type, "group");
  assert.equal(and.op, "and");
  assert.equal(and.children.length, 2);

  const or = tree("Q1.brandA OR Q2.R1") as ConditionGroup;
  assert.equal(or.op, "or");

  const not = tree("NOT Q1.brandA") as ConditionGroup;
  assert.equal(not.op, "not");
  assert.equal(not.children.length, 1);
  assert.equal((not.children[0] as any).operator, "selected");
});

test("every operator can be written out, with a friendly spelling or its name", () => {
  const cases: [string, string, unknown, unknown?][] = [
    ["Q3 > 25", "gt", 25],
    ["Q3 >= 25", "gte", 25],
    ["Q3 < 25", "lt", 25],
    ["Q3 = 25", "eq", 25],
    ["Q3 != 25", "ne", 25],
    ["Q3 between 10 and 20", "between", 10, 20],
    ["Q3 between 10, 20", "between", 10, 20],
    ["Q1 contains brandA", "contains", "brandA"],
    ["Q1 contains any [brandA, brandB]", "containsAny", ["brandA", "brandB"]],
    ["Q1 contains all [brandA, brandB]", "containsAll", ["brandA", "brandB"]],
    ["Q1 in [brandA, brandB]", "in", ["brandA", "brandB"]],
    ["Q3 answered", "answered", undefined],
    ["Q3 unanswered", "unanswered", undefined],
    ["Q1 is empty", "isEmpty", undefined],
    ["Q1 selected brandA", "selected", "brandA"],
    ["Q1 not selected brandA", "notSelected", "brandA"],
    ["Q1 rank equals brandA and 2", "rankEquals", "brandA", 2],
    ["Q3 startsWith 2", "startsWith", 2],
  ];
  for (const [src, op, value, value2] of cases) {
    const c = tree(src) as any;
    assert.equal(c.operator, op, src);
    if (value !== undefined) assert.deepEqual(c.value, value, src);
    if (value2 !== undefined) assert.deepEqual(c.value2, value2, src);
  }
});

test("a quoted string keeps its spaces", () => {
  const c = tree('Q3 = "over 40"') as any;
  assert.equal(c.value, "over 40");
});

/* =========================================================== §25: nesting */

test("§25: parentheses decide the hierarchy — (A OR B) AND C", () => {
  const c = tree("(Q1.brandA OR Q1.brandB) AND Q2.R1") as ConditionGroup;
  assert.equal(c.op, "and");
  assert.equal(c.children.length, 2);
  const left = c.children[0] as ConditionGroup;
  assert.equal(left.type, "group");
  assert.equal(left.op, "or");
  assert.deepEqual(left.children.map((x: any) => x.value), ["brandA", "brandB"]);
  assert.equal((c.children[1] as any).operator, "answered");
});

test("§25: deep nesting — ((A OR B) AND C) OR D", () => {
  const c = tree("((Q1.brandA OR Q1.brandB) AND Q2.R1) OR Q3 > 25") as ConditionGroup;
  assert.equal(c.op, "or");
  const inner = c.children[0] as ConditionGroup;
  assert.equal(inner.op, "and");
  assert.equal((inner.children[0] as ConditionGroup).op, "or");
  assert.equal((c.children[1] as any).operator, "gt");
});

test("§25: NOT over a bracket — NOT ((A AND B) OR C)", () => {
  const c = tree("NOT ((Q1.brandA AND Q1.brandB) OR Q2.R1)") as ConditionGroup;
  assert.equal(c.op, "not");
  const or = c.children[0] as ConditionGroup;
  assert.equal(or.op, "or");
  assert.equal((or.children[0] as ConditionGroup).op, "and");
});

test("§25: matrix references combine like anything else", () => {
  const c = tree("(Q2.R1.C1 OR Q2.R2.C2) AND Q4.a.spend") as ConditionGroup;
  assert.equal(c.op, "and");
  const or = c.children[0] as ConditionGroup;
  assert.deepEqual(or.children.map((x: any) => [x.source.rowCode, x.value]),
    [["1", "1"], ["2", "2"]]);
  assert.equal((c.children[1] as any).source.columnId, "spend");
});

test("precedence is NOT, then AND, then OR — and mixing without brackets warns", () => {
  const r = parse("Q1.brandA OR Q1.brandB AND Q2.R1");
  assert.deepEqual(r.errors, []);
  const c = r.condition as ConditionGroup;
  assert.equal(c.op, "or", "OR is the outermost");
  assert.equal((c.children[1] as ConditionGroup).op, "and", "AND bound tighter");
  assert.equal(r.warnings.length, 1, "and it said so");
  assert.match(r.warnings[0].message, /AND binds tighter/);

  // with brackets there is nothing to warn about
  assert.equal(parse("(Q1.brandA OR Q1.brandB) AND Q2.R1").warnings.length, 0);
});

/* ========================================================= §9: bad input */

test("§9: malformed expressions are refused with a useful message", () => {
  const cases: [string, RegExp][] = [
    ["AND Q1.brandA", /cannot start with AND/],
    ["Q1.brandA OR", /ends with OR/],
    ["(Q1.brandA AND Q2.R1", /Missing closing parenthesis/],
    ["Q999.R1", /Q999 does not exist/],
    ["Q1.nope", /Q1 has no “nope”/],
    ["Q2.R1.nope", /has no “nope”/],
    ["Q1.brandA Q2.R1", /is an AND or OR missing/],
    ["Q1.brandA)", /Unmatched closing parenthesis/],
    ["Q3 >", /needs a value/],
    ['Q3 = "unterminated', /Unclosed quote/],
    ["Q1.brandA.brandB.brandC", /more parts than this question has dimensions/],
  ];
  for (const [src, re] of cases) {
    const r = parse(src);
    assert.ok(r.errors.length > 0, `refused: ${src}`);
    assert.match(r.errors[0].message, re, src);
    assert.equal(r.condition, undefined, `and produced no tree: ${src}`);
  }
});

test("an empty expression is not an error — it is just empty", () => {
  const r = parse("   ");
  assert.deepEqual(r.errors, []);
  assert.equal(r.condition, undefined);
});

/* ================================================ §14: canonical → text */

test("§14: a tree built visually prints as the expression that means it", () => {
  const visual: Condition = {
    type: "group", op: "and",
    children: [
      {
        type: "group", op: "or",
        children: [
          { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandA" },
          { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandB" },
        ],
      },
      { type: "rule", source: { kind: "question", ref: "q_matrix", rowCode: "1" }, operator: "answered" },
    ],
  };
  assert.equal(fmt(visual), "(Q1.brandA OR Q1.brandB) AND Q2.R1");
});

test("printed expressions are fully parenthesised, so they re-parse exactly", () => {
  const sources = [
    "Q1.brandA",
    "Q2.R1",
    "Q2.R1.C2",
    "Q4.a.spend",
    "Q3 > 25",
    "Q3 between 10 and 20",
    "Q1 contains any [brandA, brandB]",
    "Q1 not selected brandA",
    "Q3 unanswered",
    "NOT Q1.brandA",
    "Q1.brandA AND Q2.R1",
    "(Q1.brandA OR Q1.brandB) AND Q2.R1",
    "((Q1.brandA OR Q1.brandB) AND Q2.R1) OR Q3 > 25",
    "NOT ((Q1.brandA AND Q1.brandB) OR Q2.R1)",
    "(Q2.R1.C1 OR Q2.R2.C2) AND Q4.a.spend",
    "calc.SCORE > 10",
    'Q3 = "over 40"',
  ];
  for (const src of sources) {
    const first = tree(src);
    const printed = fmt(first);
    const second = tree(printed);
    assert.deepEqual(second, first, `round trip for ${src} (printed as ${printed})`);
    // and printing again is stable
    assert.equal(fmt(second), printed, `stable print for ${src}`);
  }
});

test("§25: expression → visual → expression comes back to the same text", () => {
  const src = "((Q1.brandA OR Q1.brandB) AND Q2.R1.C2) OR NOT Q3 > 25";
  const printed = fmt(tree(src));
  assert.equal(fmt(tree(printed)), printed);
  // the shape is what the brief describes
  const c = tree(printed) as ConditionGroup;
  assert.equal(c.op, "or");
  assert.equal((c.children[1] as ConditionGroup).op, "not");
});

test("NOT of a single rule needs no brackets; NOT of a group gets exactly one pair", () => {
  assert.equal(fmt(tree("NOT Q1.brandA")), "NOT Q1.brandA");
  assert.equal(fmt(tree("NOT (Q1.brandA OR Q2.R1)")), "NOT (Q1.brandA OR Q2.R1)");
  assert.equal(fmt(tree("NOT ((Q1.brandA AND Q1.brandB) OR Q2.R1)")),
    "NOT ((Q1.brandA AND Q1.brandB) OR Q2.R1)");
});

test("a multi-child NOT prints as NOT(a OR b) — “none of these”, not NAND", () => {
  /*
   * The visual builder can make one: select two conditions, Move to new group,
   * set NOT. It means "none of these are true". Printing it as
   * `NOT (a AND b)` would mean something else entirely — true as soon as
   * either one is false — so the shape changes on the round trip while the
   * meaning does not.
   */
  const d = def();
  const nor: Condition = {
    type: "group", op: "not",
    children: [
      { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandA" },
      { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandB" },
    ],
  };
  const printed = formatCondition(d, nor);
  assert.equal(printed, "NOT (Q1.brandA OR Q1.brandB)");

  const reparsed = parseLogicExpression(d, printed).condition!;
  for (const answers of [
    { q_brand: [] }, { q_brand: ["brandA"] }, { q_brand: ["brandB"] }, { q_brand: ["brandA", "brandB"] },
  ]) {
    const s1 = createResponseState(d); Object.assign(s1.answers, answers);
    const s2 = createResponseState(d); Object.assign(s2.answers, answers);
    assert.equal(
      evaluateCondition(reparsed, { def: d, state: s1, loop: null }),
      evaluateCondition(nor, { def: d, state: s2, loop: null }),
      `same meaning for ${JSON.stringify(answers)}`,
    );
  }
});

test("§18: long expressions print over indented lines when asked", () => {
  const src = "(Q1.brandA OR Q1.brandB OR Q1.brandC) AND (Q2.R1.C1 OR Q2.R2.C3) AND NOT Q3 > 25";
  const pretty = fmt(tree(src), true);
  assert.ok(pretty.includes("\n"), `breaks over lines:\n${pretty}`);
  // and it still parses back to the same tree
  assert.deepEqual(tree(pretty), tree(src));
});

/* =========================================== §21: one evaluator, one result */

test("§21: an expression evaluates exactly as the visual equivalent does", () => {
  // (Q1 has brandA OR brandB) AND Q2 row 1 answered
  const src = "(Q1.brandA OR Q1.brandB) AND Q2.R1";
  assert.equal(run(src, { q_brand: ["brandA"], q_matrix: { 1: 2 } }), true);
  assert.equal(run(src, { q_brand: ["brandC"], q_matrix: { 1: 2 } }), false, "neither brand");
  assert.equal(run(src, { q_brand: ["brandB"], q_matrix: {} }), false, "row not answered");

  // matrix scale points
  assert.equal(run("Q2.R1.C3", { q_matrix: { 1: 3 } }), true);
  assert.equal(run("Q2.R1.C3", { q_matrix: { 1: 2 } }), false);

  // numeric and NOT
  assert.equal(run("NOT Q3 > 25", { q_age: 30 }), false);
  assert.equal(run("NOT Q3 > 25", { q_age: 20 }), true);

  // a composite cell
  assert.equal(run("Q4.a.spend", { q_tab: { a: { spend: 12 } } }), true);
  assert.equal(run("Q4.a.spend", { q_tab: { a: {} } }), false);
});

test("§21: the same tree from either editor gives the same answers", () => {
  const d = def();
  const src = "(Q1.brandA OR Q1.brandB) AND NOT Q3 > 25";
  const fromText = parseLogicExpression(d, src).condition!;
  // the shape a programmer would build by hand in the visual builder
  const fromVisual: Condition = {
    type: "group", op: "and",
    children: [
      {
        type: "group", op: "or",
        children: [
          { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandA" },
          { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "selected", value: "brandB" },
        ],
      },
      {
        type: "group", op: "not",
        children: [{ type: "rule", source: { kind: "question", ref: "q_age" }, operator: "gt", value: 25 }],
      },
    ],
  };
  assert.deepEqual(fromText, fromVisual, "identical trees");

  for (const answers of [
    { q_brand: ["brandA"], q_age: 20 },
    { q_brand: ["brandA"], q_age: 30 },
    { q_brand: ["brandC"], q_age: 20 },
    {},
  ]) {
    const s1 = createResponseState(d); Object.assign(s1.answers, answers);
    const s2 = createResponseState(d); Object.assign(s2.answers, answers);
    assert.equal(
      evaluateCondition(fromText, { def: d, state: s1, loop: null }),
      evaluateCondition(fromVisual, { def: d, state: s2, loop: null }),
      JSON.stringify(answers),
    );
  }
});

/* ============================================== §5/§19: the reference tree */

test("the picker offers questions, their rows, and what sits under each row", () => {
  const nodes = referenceTree(def());
  const q1 = nodes.find((n) => n.token === "Q1")!;
  assert.equal(q1.kind, "question");
  assert.deepEqual(q1.children!.map((c) => c.token), ["Q1.brandA", "Q1.brandB", "Q1.brandC"],
    "a question without rows offers its options directly");

  const q2 = nodes.find((n) => n.token === "Q2")!;
  assert.deepEqual(q2.children!.map((c) => c.token), ["Q2.R1", "Q2.R2"]);
  assert.deepEqual(q2.children![0].children!.map((c) => c.token),
    ["Q2.R1.C1", "Q2.R1.C2", "Q2.R1.C3"], "and under a matrix row, its scale points");
  assert.equal(q2.children![0].label, "Service", "labelled with what the programmer typed");

  const q4 = nodes.find((n) => n.token === "Q4")!;
  assert.deepEqual(q4.children![0].children!.map((c) => c.token), ["Q4.a.spend", "Q4.a.freq"],
    "a composite row offers its columns");

  // every token the picker offers must parse
  const walk = (ns: typeof nodes) => {
    for (const n of ns) {
      const r = parse(n.token);
      if (n.kind !== "variable") {
        assert.deepEqual(r.errors, [], `${n.token} parses: ${JSON.stringify(r.errors)}`);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);

  assert.ok(nodes.some((n) => n.token === "calc.SCORE"));
  assert.ok(nodes.some((n) => n.token === "ed.PANEL"));
});

test("operator spellings are stable, so the chips and the parser agree", () => {
  assert.equal(OPERATOR_SPELLING("eq"), "=");
  assert.equal(OPERATOR_SPELLING("containsAny"), "contains any");
  assert.equal(OPERATOR_SPELLING("answered"), "answered");
});

/* ================================================ §22: save / reload shape */

test("§22: what is stored is the tree, so a reload reproduces both views", () => {
  const src = "(Q1.brandA OR Q1.brandB) AND Q2.R1.C2";
  const stored = tree(src);
  // a JSON round trip is what persistence does to it
  const reloaded = JSON.parse(JSON.stringify(stored)) as Condition;
  assert.deepEqual(reloaded, stored);
  assert.equal(fmt(reloaded), fmt(stored));
  assert.equal(fmt(reloaded), "(Q1.brandA OR Q1.brandB) AND Q2.R1.C2");
});
