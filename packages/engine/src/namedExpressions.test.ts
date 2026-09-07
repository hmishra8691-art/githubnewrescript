import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  createResponseState, setAnswer, evaluateCondition, effectiveQuestion,
  parseLogicExpression, formatCondition,
  findNamedExpression, namedExpressionCycles, lintNamedExpressions, namedExpressionUsage,
} from "./index.js";

/**
 * NAMED EXPRESSIONS (§34, §35).
 *
 * The claim: the whole feature is a source kind and a resolver, so every
 * consumer of `evaluateCondition` supports it without being told. The tests
 * that matter are the ones that drive a macro through a DIFFERENT feature
 * from the one it was written for — display logic, option logic, auto punch —
 * and the ones that prove a self-referencing macro is refused rather than
 * hung.
 */

const HIGH = { id: "ne_high", name: "IS_HIGH_VALUE", when: cond.rule("q_income", "gte", 100000) };
const APPLE = { id: "ne_apple", name: "HAS_APPLE", when: cond.rule("q_brands", "selected", "apple") };

function survey(over: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Macros", version: "1.0" },
    namedExpressions: [HIGH, APPLE],
    questions: [
      { id: "q_income", code: "Q1", variableName: "INCOME", type: "numeric", text: "Income" },
      {
        id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands",
        options: [{ code: "apple", label: "Apple" }, { code: "dell", label: "Dell" }],
      },
      { id: "q_next", code: "Q10", variableName: "NEXT", type: "text", text: "Why?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_income", "q_brands", "q_next"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    ...over,
  });
}

const ctxWith = (answers: Record<string, unknown>, def = survey()) => {
  const state = createResponseState(def, { seed: 1 });
  for (const [k, v] of Object.entries(answers)) setAnswer(def, state, k, v);
  return { def, state, loop: null };
};

/** A reference to a named expression, as it is stored. */
const ref = (id: string) => ({ type: "rule", source: { kind: "rule", ref: id }, operator: "eq", value: true });

/* -------------------------------------------------------------- the basics */

test("a named expression is found by id, by name, and case-insensitively", () => {
  const def = survey();
  assert.equal(findNamedExpression(def, "ne_high")?.name, "IS_HIGH_VALUE");
  assert.equal(findNamedExpression(def, "IS_HIGH_VALUE")?.id, "ne_high");
  assert.equal(findNamedExpression(def, "is_high_value")?.id, "ne_high");
  assert.equal(findNamedExpression(def, "nope"), undefined);
});

test("A REFERENCE EVALUATES THE STORED CONDITION", () => {
  assert.equal(evaluateCondition(ref("ne_high") as never, ctxWith({ q_income: 150000 }) as never), true);
  assert.equal(evaluateCondition(ref("ne_high") as never, ctxWith({ q_income: 50000 }) as never), false);
});

test("references compose with everything else, because a reference IS a rule", () => {
  const rule = cond.and(ref("ne_high") as never, ref("ne_apple") as never);
  assert.equal(evaluateCondition(rule, ctxWith({ q_income: 150000, q_brands: ["apple"] }) as never), true);
  assert.equal(evaluateCondition(rule, ctxWith({ q_income: 150000, q_brands: ["dell"] }) as never), false);
  assert.equal(evaluateCondition(rule, ctxWith({ q_income: 10, q_brands: ["apple"] }) as never), false);

  const negated = cond.not(ref("ne_high") as never);
  assert.equal(evaluateCondition(negated, ctxWith({ q_income: 10 }) as never), true);
});

test("an operator on a reference still applies — `= false` is a way to spell NOT", () => {
  const isFalse = { type: "rule", source: { kind: "rule", ref: "ne_high" }, operator: "eq", value: false };
  assert.equal(evaluateCondition(isFalse as never, ctxWith({ q_income: 10 }) as never), true);
  assert.equal(evaluateCondition(isFalse as never, ctxWith({ q_income: 150000 }) as never), false);

  const notTrue = { type: "rule", source: { kind: "rule", ref: "ne_high" }, operator: "ne", value: true };
  assert.equal(evaluateCondition(notTrue as never, ctxWith({ q_income: 10 }) as never), true);
});

test("a macro may reference another macro", () => {
  const def = survey({
    namedExpressions: [
      HIGH, APPLE,
      { id: "ne_both", name: "PREMIUM_CUSTOMER", when: cond.and(ref("ne_high") as never, ref("ne_apple") as never) },
    ],
  });
  assert.equal(
    evaluateCondition(ref("ne_both") as never, ctxWith({ q_income: 150000, q_brands: ["apple"] }, def) as never),
    true,
  );
  assert.equal(
    evaluateCondition(ref("ne_both") as never, ctxWith({ q_income: 150000, q_brands: ["dell"] }, def) as never),
    false,
  );
});

test("A REFERENCE TO A DELETED EXPRESSION IS FALSE, and false is the safe direction", () => {
  /*
   * A display rule that shows a question stops showing it, rather than showing
   * it to everybody. The lint reports the dangling reference so it does not
   * stay quietly false.
   */
  assert.equal(evaluateCondition(ref("ne_gone") as never, ctxWith({ q_income: 150000 }) as never), false);
});

/* ============================================ the claim: every feature, free */

test("A MACRO DRIVES DISPLAY LOGIC — flow.ts was not told macros exist", () => {
  const def = survey({
    displayRules: [{
      id: "dr1", target: { kind: "question", ref: "q_next" }, action: "show",
      when: ref("ne_high"),
    }],
  });
  const visible = (income: number) => {
    const state = createResponseState(def, { seed: 1 });
    setAnswer(def, state, "q_income", income);
    /* the named-rule resolver runs inside the same evaluateCondition the
       display-rule engine already called */
    return evaluateCondition(def.displayRules[0].when, { def, state, loop: null } as never);
  };
  assert.equal(visible(150000), true);
  assert.equal(visible(10), false);
});

test("A MACRO DRIVES OPTION LOGIC — a different feature, the same resolver", () => {
  const def = survey({});
  const raw = JSON.parse(JSON.stringify(def));
  raw.questions[1].options[1].visibleIf = ref("ne_high");
  const withRule = SurveyDefinition.parse(raw);

  const shown = (income: number) => {
    const state = createResponseState(withRule, { seed: 1 });
    setAnswer(withRule, state, "q_income", income);
    return effectiveQuestion(withRule.questions[1], { def: withRule, state, loop: null } as never)
      .options.map((o) => String(o.code));
  };
  assert.deepEqual(shown(150000), ["apple", "dell"]);
  assert.deepEqual(shown(10), ["apple"], "Dell is gone — the macro hid it");
});

/* ------------------------------------------------------------- recursion */

test("A SELF-REFERENCING MACRO IS FALSE, NOT A HANG", () => {
  /*
   * The hazard that makes this feature dangerous without a guard. An
   * unbounded recursion is not a wrong answer — it takes the page with it.
   */
  const selfRef = { id: "ne_self", name: "LOOPY", when: ref("ne_self") };
  const def = survey({ namedExpressions: [selfRef] });
  assert.equal(evaluateCondition(ref("ne_self") as never, ctxWith({}, def) as never), false);
});

test("two macros referencing each other are also refused", () => {
  const def = survey({
    namedExpressions: [
      { id: "ne_a", name: "A", when: ref("ne_b") },
      { id: "ne_b", name: "B", when: ref("ne_a") },
    ],
  });
  assert.equal(evaluateCondition(ref("ne_a") as never, ctxWith({}, def) as never), false);
  assert.equal(evaluateCondition(ref("ne_b") as never, ctxWith({}, def) as never), false);
});

test("THE RESOLUTION STACK IS LEFT CLEAN, so one bad macro does not poison the next", () => {
  const def = survey({
    namedExpressions: [
      HIGH,
      { id: "ne_self", name: "LOOPY", when: ref("ne_self") },
    ],
  });
  evaluateCondition(ref("ne_self") as never, ctxWith({ q_income: 150000 }, def) as never);
  assert.equal(
    evaluateCondition(ref("ne_high") as never, ctxWith({ q_income: 150000 }, def) as never),
    true,
    "a normal macro still resolves after a cyclic one was attempted",
  );
});

test("the same macro used twice in one tree is not mistaken for a cycle", () => {
  /*
   * The guard is about RE-ENTRY, not about how many times an expression is
   * referenced. `A AND A` is legitimate and common once a macro is shared.
   */
  const rule = cond.and(ref("ne_high") as never, ref("ne_high") as never);
  assert.equal(evaluateCondition(rule, ctxWith({ q_income: 150000 }) as never), true);
});

/* ------------------------------------------------------------------ lint */

test("the lint names the whole cycle, in order", () => {
  const def = survey({
    namedExpressions: [
      { id: "ne_a", name: "IS_ELIGIBLE", when: ref("ne_b") },
      { id: "ne_b", name: "IS_HIGH_VALUE", when: ref("ne_a") },
    ],
  });
  const cycles = namedExpressionCycles(def);
  assert.equal(cycles.length, 1);
  const problems = lintNamedExpressions(def);
  assert.ok(problems.some((p) => /Circular named expressions/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /IS_ELIGIBLE → IS_HIGH_VALUE → IS_ELIGIBLE/.test(p)), problems.join(" | "));
});

test("the lint catches a dangling reference and a duplicate name", () => {
  const dangling = survey({
    namedExpressions: [{ id: "ne_a", name: "A", when: ref("ne_nope") }],
  });
  assert.ok(lintNamedExpressions(dangling).some((p) => /does not exist/.test(p)));

  const dupes = survey({
    namedExpressions: [
      { id: "ne_a", name: "SAME", when: cond.rule("q_income", "gte", 1) },
      { id: "ne_b", name: "same", when: cond.rule("q_income", "gte", 2) },
    ],
  });
  const problems = lintNamedExpressions(dupes);
  assert.ok(problems.some((p) => /are called “same”/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /the others can never be used/.test(p)));
});

test("a healthy set of macros lints silently", () => {
  assert.deepEqual(lintNamedExpressions(survey()), []);
  assert.deepEqual(namedExpressionCycles(survey()), []);
});

test("USAGE IS REPORTABLE, so deleting one is not a silent breakage", () => {
  const def = survey({
    displayRules: [{ id: "dr1", target: { kind: "question", ref: "q_next" }, action: "show", when: ref("ne_high") }],
  });
  const raw = JSON.parse(JSON.stringify(def));
  raw.questions[2].displayLogic = ref("ne_high");
  raw.questions[1].options[0].visibleIf = ref("ne_apple");
  const used = namedExpressionUsage(SurveyDefinition.parse(raw));

  const high = used.get("ne_high") ?? [];
  assert.equal(high.length, 2, `two places use IS_HIGH_VALUE: ${JSON.stringify(high)}`);
  assert.ok(high.some((u) => /display rule/.test(u.where)));
  assert.ok(high.some((u) => /Q10 display logic/.test(u.where)));

  const apple = used.get("ne_apple") ?? [];
  assert.equal(apple.length, 1);
  assert.match(apple[0].where, /Q2 option apple/);
});

/* --------------------------------------------------------- the text syntax */

test("A MACRO IS WRITTEN BY NAME IN THE EXPRESSION EDITOR", () => {
  const def = survey();
  const r = parseLogicExpression(def, "IS_HIGH_VALUE AND HAS_APPLE");
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(
    evaluateCondition(r.condition!, ctxWith({ q_income: 150000, q_brands: ["apple"] }, def) as never),
    true,
  );
  assert.equal(
    evaluateCondition(r.condition!, ctxWith({ q_income: 10, q_brands: ["apple"] }, def) as never),
    false,
  );
});

test("a bare macro needs no operator, which is the point of naming a condition", () => {
  const def = survey();
  const r = parseLogicExpression(def, "IS_HIGH_VALUE");
  assert.deepEqual(r.errors, []);
  const c = r.condition as never as { source: { kind: string; ref: string } };
  assert.equal(c.source.kind, "rule");
  assert.equal(c.source.ref, "ne_high", "stored by ID, so renaming the macro is free");
});

test("`rule.NAME` disambiguates when a question shares the name", () => {
  const def = survey();
  const r = parseLogicExpression(def, "rule.IS_HIGH_VALUE");
  assert.deepEqual(r.errors, []);
  assert.equal((r.condition as never as { source: { ref: string } }).source.ref, "ne_high");

  const bad = parseLogicExpression(def, "rule.NOPE");
  assert.ok(bad.errors.length > 0, "an unknown macro is a parse error");
  assert.match(bad.errors[0].message, /no named expression/i);
});

test("A QUESTION WINS OVER A MACRO OF THE SAME NAME", () => {
  /*
   * The same precedence a loopVar already gets. A survey that grows a macro
   * called Q1 does not silently change what every existing `Q1` rule means.
   */
  const def = survey({
    namedExpressions: [{ id: "ne_q1", name: "Q1", when: cond.rule("q_income", "gte", 1) }],
  });
  const r = parseLogicExpression(def, "Q1 > 5");
  assert.deepEqual(r.errors, []);
  const c = r.condition as never as { source: { kind: string; ref: string } };
  assert.equal(c.source.kind, "question");
  assert.equal(c.source.ref, "q_income");
});

test("THE ROUND TRIP HOLDS — a macro prints as its name and re-parses to its id", () => {
  const def = survey();
  for (const src of ["IS_HIGH_VALUE", "IS_HIGH_VALUE AND HAS_APPLE", "NOT IS_HIGH_VALUE"]) {
    const first = parseLogicExpression(def, src);
    assert.deepEqual(first.errors, [], src);
    const printed = formatCondition(def, first.condition!);
    const again = parseLogicExpression(def, printed);
    assert.deepEqual(again.errors, [], `${src} printed as ${printed}`);
    assert.deepEqual(again.condition, first.condition, `${src} printed as ${printed}`);
  }
});

test("RENAMING A MACRO DOES NOT BREAK ITS REFERENCES, because they store the id", () => {
  const def = survey();
  const stored = parseLogicExpression(def, "IS_HIGH_VALUE").condition!;

  const renamed = survey({
    namedExpressions: [{ ...HIGH, name: "BIG_SPENDER" }, APPLE],
  });
  assert.equal(
    evaluateCondition(stored, ctxWith({ q_income: 150000 }, renamed) as never),
    true,
    "the rule still resolves",
  );
  assert.equal(formatCondition(renamed, stored), "BIG_SPENDER", "and now prints under the new name");
});

/* ------------------------------------------------------- nothing else moved */

test("A SURVEY WITH NO NAMED EXPRESSIONS IS UNCHANGED", () => {
  const def = survey({ namedExpressions: [] });
  assert.deepEqual(lintNamedExpressions(def), []);
  assert.equal(namedExpressionUsage(def).size, 0);
  /* and an ordinary rule still parses to an ordinary source */
  const r = parseLogicExpression(def, "Q1 > 5");
  assert.equal((r.condition as never as { source: { kind: string } }).source.kind, "question");
});
