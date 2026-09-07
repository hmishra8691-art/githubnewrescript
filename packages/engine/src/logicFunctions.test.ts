import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, evaluateCondition,
  createResponseState, setAnswer, evaluateExpression, safeExpression,
} from "./index.js";

/**
 * FUNCTIONS INSIDE A CONDITION (§9, §16, §18, §19).
 *
 * The claim under test is that this adds NO new engine. `COUNT(...)` compiles
 * to the count source the visual builder writes; everything else compiles to
 * an `expr` source evaluated by the calculation engine that already runs
 * `Calculation.expression`. So the tests check three things:
 *
 *   1. the text parses to the tree the builder would have produced
 *   2. the tree prints back to text that re-parses identically — the round
 *      trip the two editors depend on
 *   3. the rule evaluates through the ordinary `evaluateCondition`, which is
 *      what makes it work at all fourteen call sites without any of them
 *      knowing functions exist
 */

const def = SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "Functions", version: "1.0" },
  questions: [
    {
      id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Which?",
      options: [
        { code: "1", label: "Apple" }, { code: "2", label: "Samsung" },
        { code: "3", label: "Google" }, { code: "4", label: "Xiaomi" },
      ],
    },
    { id: "q_yes", code: "Q1", variableName: "Q1", type: "single_select", text: "Yes?",
      options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] },
    { id: "q_a", code: "Q5", variableName: "Q5", type: "numeric", text: "A" },
    { id: "q_b", code: "Q6", variableName: "Q6", type: "numeric", text: "B" },
    { id: "q_c", code: "Q7", variableName: "SPEND_C", type: "numeric", text: "C" },
    { id: "q_job", code: "Q10", variableName: "JOB", type: "text", text: "Job title" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_brands", "q_yes", "q_a", "q_b", "q_c", "q_job"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

const parse = (src: string) => parseLogicExpression(def, src);
const ok = (src: string) => {
  const r = parse(src);
  assert.deepEqual(r.errors, [], `${src} → ${JSON.stringify(r.errors)}`);
  assert.ok(r.condition, `${src} produced a tree`);
  return r.condition!;
};

const ctxWith = (answers: Record<string, unknown>) => {
  const state = createResponseState(def, { seed: 1 });
  for (const [k, v] of Object.entries(answers)) setAnswer(def, state, k, v);
  return { def, state, loop: null };
};
const holds = (src: string, answers: Record<string, unknown>) =>
  evaluateCondition(ok(src), ctxWith(answers) as never);

/* --------------------------------------------------------------- COUNT */

test("COUNT(Q2) >= 3 parses to the count SOURCE the visual builder writes", () => {
  const c = ok("COUNT(Q2) >= 3") as never as {
    type: string; operator: string; value: unknown;
    source: { kind: string; ref: string; count: { of: string; scope: string } };
  };
  assert.equal(c.type, "rule");
  assert.equal(c.source.kind, "question");
  assert.equal(c.source.ref, "q_brands");
  assert.deepEqual(c.source.count, { of: "selected", scope: "options" });
  assert.equal(c.operator, "gte");
  assert.equal(c.value, 3);
});

test("every count operator the brief lists parses", () => {
  for (const [src, op, val] of [
    ["COUNT(Q2) = 2", "eq", 2],
    ["COUNT(Q2) != 3", "ne", 3],
    ["COUNT(Q2) > 2", "gt", 2],
    ["COUNT(Q2) < 5", "lt", 5],
    ["COUNT(Q2) >= 2", "gte", 2],
    ["COUNT(Q2) <= 4", "lte", 4],
  ] as [string, string, number][]) {
    const c = ok(src) as never as { operator: string; value: number };
    assert.equal(c.operator, op, src);
    assert.equal(c.value, val, src);
  }
});

test("COUNT(Q2) BETWEEN 2 AND 4 parses to one between rule", () => {
  const c = ok("COUNT(Q2) between 2 and 4") as never as { operator: string; value: number; value2: number };
  assert.equal(c.operator, "between");
  assert.equal(c.value, 2);
  assert.equal(c.value2, 4);
});

test("the second argument chooses what is counted", () => {
  const of = (src: string) =>
    (ok(src) as never as { source: { count: { of: string; scope: string } } }).source.count;
  assert.deepEqual(of("COUNT(Q2, selected) >= 1"), { of: "selected", scope: "options" });
  assert.deepEqual(of("COUNT(Q2, notSelected) >= 1"), { of: "notSelected", scope: "options" });
  assert.deepEqual(of("COUNT(Q2, valid) >= 1"), { of: "valid", scope: "options" });
  assert.deepEqual(of("COUNT(Q2, invalid) = 1"), { of: "invalid", scope: "options" });
  assert.deepEqual(of("COUNT(Q2, visible) >= 1"), { of: "visible", scope: "options" });
});

test("the named arguments are order-free, because a positional fifth is unreadable", () => {
  const c = ok('COUNT(Q2, selected, only [1, 3], group "grp_a") >= 2') as never as {
    source: { count: { only: string[]; group: string } };
  };
  assert.deepEqual(c.source.count.only.map(String), ["1", "3"]);
  assert.equal(c.source.count.group, "grp_a");

  const flipped = ok('COUNT(Q2, group "grp_a", only [1, 3]) >= 2') as never as {
    source: { count: { only: string[]; group: string } };
  };
  assert.deepEqual(flipped.source.count.only.map(String), ["1", "3"]);
});

test("COUNT evaluates through the ordinary evaluator", () => {
  assert.equal(holds("COUNT(Q2) >= 3", { q_brands: ["1", "2", "3", "4"] }), true);
  assert.equal(holds("COUNT(Q2) >= 3", { q_brands: ["1"] }), false);
  assert.equal(holds("COUNT(Q2) = 1", { q_brands: ["1"] }), true);
  assert.equal(holds("COUNT(Q2) between 2 and 4", { q_brands: ["1", "2"] }), true);
  assert.equal(holds("COUNT(Q2) between 2 and 4", { q_brands: ["1"] }), false);
});

test("COUNT combines with everything else the language already had", () => {
  const src = 'COUNT(Q2) >= 3 AND Q1.1';
  assert.equal(holds(src, { q_brands: ["1", "2", "3"], q_yes: "1" }), true);
  assert.equal(holds(src, { q_brands: ["1", "2", "3"], q_yes: "2" }), false);
  assert.equal(holds(src, { q_brands: ["1"], q_yes: "1" }), false);
});

test("A COUNT OF EACH OF TWO QUESTIONS, added together (§5)", () => {
  /* the brief's `COUNT(Q2) + COUNT(Q3) > 5` shape, with the sum done by calc */
  assert.equal(holds("(Q5 + Q6) > 5", { q_a: 4, q_b: 3 }), true);
  assert.equal(holds("(Q5 + Q6) > 5", { q_a: 1, q_b: 1 }), false);
});

/* ------------------------------------------------------------ arithmetic */

test("(Q5 + Q6 + Q7) > 100 — the brief's example, verbatim", () => {
  const c = ok("(Q5 + Q6 + Q7) > 100") as never as {
    source: { kind: string; ref: string }; operator: string; value: number;
  };
  assert.equal(c.source.kind, "expr");
  assert.equal(c.operator, "gt");
  assert.equal(c.value, 100);
  assert.equal(holds("(Q5 + Q6 + Q7) > 100", { q_a: 50, q_b: 40, q_c: 20 }), true);
  assert.equal(holds("(Q5 + Q6 + Q7) > 100", { q_a: 1, q_b: 2, q_c: 3 }), false);
});

test("A BRACKET IS A CONDITION GROUP UNLESS A COMPARISON FOLLOWS IT", () => {
  /*
   * The one genuine ambiguity in the grammar. `(A OR B) AND C` and
   * `(Q5 + Q6) > 100` both open with a bracket; only the token after the
   * closing bracket tells them apart, so that is exactly what the lookahead
   * reads.
   */
  const group = ok("(Q1.1 OR Q1.2) AND Q5 > 3") as never as { type: string; op: string };
  assert.equal(group.type, "group", "a bracket followed by AND is still a group");

  const arithmetic = ok("(Q5 + Q6) > 100") as never as { type: string; source: { kind: string } };
  assert.equal(arithmetic.type, "rule", "a bracket followed by > is an expression");
  assert.equal(arithmetic.source.kind, "expr");
});

test("bare arithmetic without brackets works too", () => {
  const c = ok("Q5 + Q6 > 100") as never as { source: { kind: string } };
  assert.equal(c.source.kind, "expr");
  assert.equal(holds("Q5 + Q6 > 100", { q_a: 60, q_b: 50 }), true);
  assert.equal(holds("Q5 + Q6 > 100", { q_a: 6, q_b: 5 }), false);
});

test("AN ORDINARY RULE IS NOT MISTAKEN FOR ARITHMETIC", () => {
  /* the regression guard: no arithmetic operator, so no expr source */
  const c = ok("Q5 > 100") as never as { source: { kind: string; ref: string } };
  assert.equal(c.source.kind, "question");
  assert.equal(c.source.ref, "q_a");
});

test("REFERENCES ARE NORMALISED TO VARIABLE NAMES for the calc engine", () => {
  /*
   * Q7's code and variable name differ. A condition resolves a question by
   * code, variable name or id; calc resolves a name in the flat variable map.
   * Without the rewrite, `Q7 + 1 > 2` would silently resolve to nothing in
   * every survey where somebody renamed a variable.
   */
  const c = ok("Q7 + 1 > 2") as never as { source: { ref: string } };
  assert.match(c.source.ref, /SPEND_C/, `the code was rewritten to the variable: ${c.source.ref}`);
  assert.equal(holds("Q7 + 1 > 2", { q_c: 5 }), true);
  assert.equal(holds("Q7 + 1 > 2", { q_c: 0 }), false);
});

/* ------------------------------------------------------------- functions */

test("AVERAGE / SUM / MIN / MAX come from the calculation engine, already implemented", () => {
  assert.equal(holds("AVERAGE(Q5, Q6, Q7) >= 4", { q_a: 5, q_b: 4, q_c: 4 }), true);
  assert.equal(holds("AVERAGE(Q5, Q6, Q7) >= 4", { q_a: 1, q_b: 2, q_c: 3 }), false);
  assert.equal(holds("SUM(Q5, Q6, Q7) > 100", { q_a: 60, q_b: 30, q_c: 20 }), true);
  assert.equal(holds("MIN(Q5, Q6) < 2", { q_a: 1, q_b: 9 }), true);
  assert.equal(holds("MAX(Q5, Q6) > 8", { q_a: 1, q_b: 9 }), true);
  assert.equal(holds("ROUND(Q5 / 3, 0) = 2", { q_a: 5 }), true);
  assert.equal(holds("ABS(Q5 - Q6) > 3", { q_a: 1, q_b: 9 }), true);
});

test("string functions work in a condition, and are the same ones a calculation has", () => {
  assert.equal(holds('CONTAINS(Q10, "manager")', { q_job: "senior manager" }), true);
  assert.equal(holds('CONTAINS(Q10, "manager")', { q_job: "engineer" }), false);
  assert.equal(holds("LENGTH(Q10) < 10", { q_job: "cook" }), true);
  assert.equal(holds("LENGTH(Q10) < 10", { q_job: "chief executive officer" }), false);
  assert.equal(holds('LOWER(Q10) = "yes"', { q_job: "YES" }), true);
  assert.equal(holds('UPPER(Q10) = "YES"', { q_job: "yes" }), true);
  assert.equal(holds('TRIM(Q10) = "yes"', { q_job: "  yes  " }), true);
});

test("the new string functions are available in a calculation too — one table, both places", () => {
  const o = { resolver: (n: string) => ({ A: " Hello World " } as Record<string, unknown>)[n] };
  assert.equal(evaluateExpression("trim(A)", o), "Hello World");
  assert.equal(evaluateExpression("upper(A)", o), " HELLO WORLD ");
  assert.equal(evaluateExpression("lower(A)", o), " hello world ");
  assert.equal(evaluateExpression("substring(trim(A), 0, 5)", o), "Hello");
  assert.equal(evaluateExpression("replace(A, 'l', '')", o), " Heo Word ");
  assert.equal(evaluateExpression("length(trim(A))", o), 11);
  assert.equal(evaluateExpression("startswith(trim(A), 'Hell')", o), true);
  assert.equal(evaluateExpression("ceiling(1.2)", o), 2);
  assert.equal(evaluateExpression("average(1, 2, 3)", o), 2);
});

test("AN UNKNOWN FUNCTION IS A PARSE ERROR, not a rule that silently never fires", () => {
  const r = parse("FROBNICATE(Q5) > 1");
  assert.ok(r.errors.length > 0, "it is refused");
  assert.ok(!r.condition);
});

/* --------------------------------------------------------- the round trip */

test("THE ROUND TRIP HOLDS — text → tree → text → the same tree", () => {
  /*
   * The invariant the two editors depend on. A programmer who types an
   * expression, switches to the visual builder and switches back must get
   * their expression, not a re-derivation of it.
   */
  for (const src of [
    "COUNT(Q2) >= 3",
    "COUNT(Q2, notSelected) > 1",
    "COUNT(Q2, rows) = 0",
    'COUNT(Q2, only [1, 3]) >= 2',
    "COUNT(Q2) between 2 and 4",
    "(Q5 + Q6 + Q7) > 100",
    'CONTAINS(Q10, "manager") = true',
    "COUNT(Q2) >= 3 AND Q1.1",
  ]) {
    const first = ok(src);
    const printed = formatCondition(def, first);
    const again = parseLogicExpression(def, printed);
    assert.deepEqual(again.errors, [], `${src} printed as ${printed} → ${JSON.stringify(again.errors)}`);
    assert.deepEqual(again.condition, first, `${src} printed as ${printed}`);
  }
});

test("a count built by the VISUAL builder prints as a COUNT call", () => {
  const built = {
    type: "rule",
    source: { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } },
    operator: "gte", value: 2,
  };
  assert.equal(formatCondition(def, built as never), "COUNT(Q2) >= 2");
});

/* ------------------------------------------------------------- safety */

test("A BROKEN EXPRESSION IS FALSE, NOT A CRASH", () => {
  /*
   * `null` fails every comparison, so a rule whose expression cannot be
   * evaluated is false. Two of the calc engine's callers had no try/catch at
   * all, which is how a bad expression became a blank page.
   */
  assert.equal(safeExpression("NOSUCH + 1", def, createResponseState(def, { seed: 1 })), 1,
    "an unknown name is 0 in arithmetic, which is calc's existing behaviour");
  assert.equal(safeExpression("(((", def, createResponseState(def, { seed: 1 })), null,
    "…but a syntax error is null rather than a throw");

  const c = {
    type: "rule", source: { kind: "expr", ref: "((( " }, operator: "gt", value: 0,
  };
  assert.equal(evaluateCondition(c as never, ctxWith({}) as never), false,
    "and the rule is false");
});

test("THE CALC ENGINE NOW HAS DEPTH AND STEP LIMITS", () => {
  /*
   * It had neither. A hand-written recursive interpreter with no depth limit
   * and callers with no try/catch is a stack overflow waiting for a generated
   * expression.
   */
  const o = { resolver: () => 1 };
  /* a genuinely deep AST — brackets alone produce no nodes to recurse over */
  const deep = Array.from({ length: 120 }, () => "(1 + ").join("") + "1" + ")".repeat(120);
  assert.throws(() => evaluateExpression(deep, o), /nested more than/,
    "a 120-deep expression is refused with a message");

  /* and an honest expression is nowhere near the limit */
  assert.equal(evaluateExpression("((((1 + 2))))", o), 3);
});
