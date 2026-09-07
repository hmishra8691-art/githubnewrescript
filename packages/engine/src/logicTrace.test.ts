import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  traceCondition, formatTrace, tracePunches,
  createResponseState, setAnswer, evaluateCondition,
  calculationCycles, calculationOrderProblems, lintCalculations,
} from "./index.js";

/**
 * THE LOGIC TRACE (§32, §33) AND THE CALCULATION DEPENDENCY GAP (§45).
 *
 * The trace's one hard requirement is that it can be incomplete but never
 * WRONG: it calls the real evaluator for every node rather than
 * reimplementing the logic, so it cannot disagree with what the respondent
 * got. There is a test for exactly that.
 */

const def = SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "Trace", version: "1.0" },
  namedExpressions: [
    { id: "ne_high", name: "IS_HIGH_VALUE", when: cond.rule("q_income", "gte", 100000) },
  ],
  questions: [
    { id: "q_income", code: "Q1", variableName: "INCOME", type: "numeric", text: "Income" },
    {
      id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands",
      options: [{ code: "a", label: "Apple" }, { code: "b", label: "Bosch" }, { code: "c", label: "Candy" }],
    },
    {
      id: "q_seg", code: "Q10", variableName: "SEGMENT", type: "single_select", text: "Segment",
      options: [
        { code: "heavy", label: "Heavy" }, { code: "medium", label: "Medium" }, { code: "light", label: "Light" },
      ],
      punches: [
        { id: "p1", label: "Heavy", mode: "if", action: "select",
          when: cond.minCount("q_brands", 3), source: { kind: "codes", codes: ["heavy"] } },
        { id: "p2", label: "Medium", mode: "else_if", action: "select",
          when: cond.minCount("q_brands", 2), source: { kind: "codes", codes: ["medium"] } },
        { id: "p3", label: "Light", mode: "else", action: "select",
          source: { kind: "codes", codes: ["light"] } },
      ],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_income", "q_brands", "q_seg"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

const ctxWith = (answers: Record<string, unknown>) => {
  const state = createResponseState(def, { seed: 1 });
  for (const [k, v] of Object.entries(answers)) setAnswer(def, state, k, v);
  return { def, state, loop: null } as never;
};

/* --------------------------------------------------------- the leaf trace */

test("a leaf records the value it read and the answer it gave", () => {
  const t = traceCondition(cond.rule("q_income", "gte", 100000), ctxWith({ q_income: 150000 }));
  assert.equal(t.result, true);
  assert.equal(t.left, 150000);
  assert.equal(t.right, 100000);
  assert.match(t.text, /Q1/);
  assert.match(t.because, /150000/);
});

test("an unanswered question reads as “no answer”, not as empty string", () => {
  /*
   * §31: answered, unanswered, null and empty are different states and the
   * trace must not blur them — "Q1 is (empty)" and "Q1 is (no answer)" send a
   * programmer to different places.
   */
  const t = traceCondition(cond.rule("q_income", "gte", 1), ctxWith({}));
  assert.equal(t.result, false);
  assert.match(t.because, /\(no answer\)/);

  const empty = traceCondition(cond.rule("q_brands", "contains", "a"), ctxWith({ q_brands: [] }));
  assert.match(empty.because, /\(nothing selected\)/);
});

/* -------------------------------------------------------- the group trace */

test("A GROUP IS A NODE WITH CHILDREN — the structure the old trace threw away", () => {
  const rule = cond.and(
    cond.rule("q_income", "gte", 100000),
    cond.rule("q_brands", "contains", "a"),
  );
  const t = traceCondition(rule, ctxWith({ q_income: 150000, q_brands: ["a"] }));
  assert.equal(t.kind, "and");
  assert.equal(t.result, true);
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].result, true);
  assert.equal(t.children[1].result, true);
  assert.match(t.because, /All 2 conditions held/);
});

test("A SKIPPED BRANCH IS RECORDED AS SKIPPED, not as false", () => {
  /*
   * "We never looked" and "we looked and it was false" are different facts,
   * and confusing them is how somebody spends an hour on the wrong branch.
   */
  const rule = cond.and(
    cond.rule("q_income", "gte", 100000),
    cond.rule("q_brands", "contains", "a"),
  );
  const t = traceCondition(rule, ctxWith({ q_income: 10 }));
  assert.equal(t.result, false);
  assert.equal(t.children[0].result, false);
  assert.equal(t.children[1].shortCircuited, true);
  assert.equal(t.children[1].result, false);
  assert.match(t.children[1].because, /Not evaluated/);
});

test("an OR says how many of its branches held", () => {
  const rule = cond.or(
    cond.rule("q_income", "gte", 100000),
    cond.rule("q_brands", "contains", "a"),
  );
  const t = traceCondition(rule, ctxWith({ q_income: 10, q_brands: ["a"] }));
  assert.equal(t.result, true);
  assert.match(t.because, /ANY of these needed to hold, and 1 did/);

  const none = traceCondition(rule, ctxWith({ q_income: 10, q_brands: ["b"] }));
  assert.match(none.because, /and none did/);
});

test("NOT explains what it requires", () => {
  const rule = cond.not(cond.rule("q_income", "gte", 100000));
  assert.match(traceCondition(rule, ctxWith({ q_income: 10 })).because, /NONE of these held/);
  assert.match(traceCondition(rule, ctxWith({ q_income: 999999 })).because, /at least one did/);
});

test("nesting is preserved to any depth", () => {
  const rule = cond.and(
    cond.rule("q_income", "gte", 1),
    cond.or(
      cond.rule("q_brands", "contains", "a"),
      cond.and(cond.rule("q_brands", "contains", "b"), cond.rule("q_income", "gte", 5)),
    ),
  );
  const t = traceCondition(rule, ctxWith({ q_income: 10, q_brands: ["b"] }));
  assert.equal(t.result, true);
  assert.equal(t.children[1].kind, "or");
  assert.equal(t.children[1].children[1].kind, "and");
  assert.equal(t.children[1].children[1].children.length, 2);
});

/* ----------------------------------------------------- counts and macros */

test("a COUNT shows the number it counted", () => {
  const t = traceCondition(cond.minCount("q_brands", 3), ctxWith({ q_brands: ["a", "b"] }));
  assert.equal(t.result, false);
  assert.equal(t.left, 2, "the count itself is the left-hand value");
  assert.match(t.because, /^2 does not satisfy/);
});

test("A NAMED EXPRESSION IS TRACED INTO — that is where the answer lives", () => {
  const ref = { type: "rule", source: { kind: "rule", ref: "ne_high" }, operator: "eq", value: true };
  const t = traceCondition(ref as never, ctxWith({ q_income: 150000 }));
  assert.equal(t.kind, "named");
  assert.equal(t.text, "IS_HIGH_VALUE");
  assert.equal(t.namedExpressionId, "ne_high");
  assert.equal(t.result, true);
  assert.equal(t.children.length, 1, "and the trace continues inside it");
  assert.equal(t.children[0].left, 150000);
});

test("a reference to a deleted expression says so", () => {
  const ref = { type: "rule", source: { kind: "rule", ref: "ne_gone" }, operator: "eq", value: true };
  const t = traceCondition(ref as never, ctxWith({}));
  assert.equal(t.result, false);
  assert.match(t.because, /no longer exists/);
});

/* =================================== the invariant: never disagree */

test("THE TRACE CAN BE INCOMPLETE BUT NEVER WRONG", () => {
  /*
   * The trace calls the real evaluator for every node rather than
   * reimplementing the logic. A debugger that disagrees with the thing it is
   * debugging is worse than no debugger.
   */
  const rules = [
    cond.rule("q_income", "gte", 100000),
    cond.and(cond.rule("q_income", "gte", 1), cond.rule("q_brands", "contains", "a")),
    cond.or(cond.rule("q_income", "gte", 999999), cond.rule("q_brands", "contains", "c")),
    cond.not(cond.rule("q_brands", "contains", "a")),
    cond.minCount("q_brands", 2),
  ];
  const states = [
    {}, { q_income: 150000 }, { q_brands: ["a"] },
    { q_income: 10, q_brands: ["a", "c"] }, { q_income: 150000, q_brands: [] },
  ];
  for (const rule of rules) {
    for (const answers of states) {
      const ctx = ctxWith(answers);
      assert.equal(
        traceCondition(rule, ctx).result,
        evaluateCondition(rule, ctx),
        `${JSON.stringify(answers)}`,
      );
    }
  }
});

/* --------------------------------------------------------------- as text */

test("the trace prints as indented text, with a mark per line", () => {
  const rule = cond.and(
    cond.rule("q_income", "gte", 100000),
    cond.rule("q_brands", "contains", "a"),
  );
  const text = formatTrace(traceCondition(rule, ctxWith({ q_income: 10 })));
  assert.match(text, /✗/, "a failing line is marked");
  assert.match(text, /–/, "and a skipped one differently");
  assert.match(text, /ALL of these must hold/);
});

/* ------------------------------------------------------ the punch trace */

test("THE PUNCH TRACE SHOWS WHICH BRANCH WON, AND WHY (§33)", () => {
  const heavy = tracePunches(def, "q_seg", ctxWith({ q_brands: ["a", "b", "c"] }))!;
  assert.equal(heavy.questionCode, "Q10");
  assert.deepEqual(heavy.rules.map((r) => [r.label, r.reached, r.applied]), [
    ["Heavy", true, true],
    ["Medium", false, false],
    ["Light", false, false],
  ]);
  assert.match(heavy.outcome, /Heavy applied/);
  assert.ok(heavy.rules[0].trace, "the winning branch carries its own trace");
  assert.equal(heavy.rules[0].trace!.left, 3, "…showing the count that decided it");
});

test("the middle branch, and the else", () => {
  const medium = tracePunches(def, "q_seg", ctxWith({ q_brands: ["a", "b"] }))!;
  assert.deepEqual(medium.rules.map((r) => r.applied), [false, true, false]);
  assert.equal(medium.rules[0].reached, true, "Heavy was reached and failed");
  assert.equal(medium.rules[2].reached, false, "Light was never reached");

  const light = tracePunches(def, "q_seg", ctxWith({ q_brands: ["a"] }))!;
  assert.deepEqual(light.rules.map((r) => r.applied), [false, false, true]);
  assert.match(light.outcome, /Light applied/);
});

test("a question with no rules says nothing applied, rather than nothing at all", () => {
  const t = tracePunches(def, "q_income", ctxWith({}))!;
  assert.deepEqual(t.rules, []);
  assert.match(t.outcome, /No rule applied/);
});

/* ============================ the calculation gap the audit found (§45) */

const withCalcs = (calculations: unknown[]) => SurveyDefinition.parse({
  meta: { id: "s2", code: "S2", title: "Calcs", version: "1.0" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "n" }],
  calculations,
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});

test("CALC-TO-CALC CYCLES WERE INVISIBLE, and now are not", () => {
  /*
   * `dependencyGraph` is question→question: its node set is `def.questions`
   * and it drops every edge whose target is not one, so calculations were
   * absent from cycle detection entirely.
   */
  const def2 = withCalcs([
    { id: "c1", targetVariable: "CALC_A", expression: "CALC_B + 1", trigger: "on_change", dataType: "numeric" },
    { id: "c2", targetVariable: "CALC_B", expression: "CALC_A * 2", trigger: "on_change", dataType: "numeric" },
  ]);
  const cycles = calculationCycles(def2);
  assert.equal(cycles.length, 1, JSON.stringify(cycles));
  assert.ok(lintCalculations(def2).some((p) => /Circular calculations/.test(p)));
  assert.ok(lintCalculations(def2).some((p) => /CALC_A → CALC_B → CALC_A/.test(p)));
});

test("A SELF-REFERENCING CALCULATION IS A CYCLE TOO", () => {
  const def2 = withCalcs([
    { id: "c1", targetVariable: "TALLY", expression: "TALLY + 1", trigger: "on_change", dataType: "numeric" },
  ]);
  assert.equal(calculationCycles(def2).length, 1);
});

test("ORDER DEPENDENCE IS REPORTED SEPARATELY — it is the harder kind to notice", () => {
  /*
   * Not a cycle: it produces an answer. Just the WRONG one on the first pass,
   * because `runCalculations` iterates the array in order and TOTAL is
   * computed before the SUBTOTAL it reads.
   */
  const def2 = withCalcs([
    { id: "c1", targetVariable: "TOTAL", expression: "SUBTOTAL * 1.2", trigger: "on_change", dataType: "numeric" },
    { id: "c2", targetVariable: "SUBTOTAL", expression: "Q1 + 1", trigger: "on_change", dataType: "numeric" },
  ]);
  assert.deepEqual(calculationCycles(def2), [], "not a cycle");
  const problems = calculationOrderProblems(def2);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TOTAL reads SUBTOTAL, which is calculated after it/);
  assert.match(problems[0], /move SUBTOTAL above it/);
});

test("the right order is silent, and a cycle is not also reported as an order problem", () => {
  const good = withCalcs([
    { id: "c2", targetVariable: "SUBTOTAL", expression: "Q1 + 1", trigger: "on_change", dataType: "numeric" },
    { id: "c1", targetVariable: "TOTAL", expression: "SUBTOTAL * 1.2", trigger: "on_change", dataType: "numeric" },
  ]);
  assert.deepEqual(lintCalculations(good), []);

  const cyclic = withCalcs([
    { id: "c1", targetVariable: "A", expression: "B + 1", trigger: "on_change", dataType: "numeric" },
    { id: "c2", targetVariable: "B", expression: "A + 1", trigger: "on_change", dataType: "numeric" },
  ]);
  assert.equal(calculationOrderProblems(cyclic).length, 0,
    "reported once, as a cycle — not twice");
});

test("a function name is not mistaken for a calculated variable", () => {
  /*
   * The list of function names used to be a hand-written duplicate of calc's
   * own, so a function added to the engine was reported here as an unknown
   * variable. Both now read the one exported list.
   */
  const def2 = withCalcs([
    { id: "c1", targetVariable: "AVG_SCORE", expression: "round(average(Q1, 2), 1)", trigger: "on_change", dataType: "numeric" },
  ]);
  assert.deepEqual(lintCalculations(def2), []);
});
