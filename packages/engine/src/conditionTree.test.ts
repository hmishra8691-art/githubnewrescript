import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, type Condition } from "@rescript/schema";
import { createResponseState, evaluateCondition } from "./index.js";

/**
 * The condition tree, and the promise that matters most about it: the
 * structure a programmer builds is the structure that runs.
 *
 * Every logic type — display, skip, branch, option-level, validation — uses
 * this one evaluator, so these cases speak for all of them.
 */

function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "L", title: "Logic", version: "1.0" },
    questions: ["q1", "q2", "q3", "q4", "q5"].map((id, i) => ({
      id, code: `Q${i + 1}`, variableName: `Q${i + 1}`,
      type: i === 3 ? "numeric" : "single_select",
      text: id,
      options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }],
    })),
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }],
  });
}

const evalWith = (c: Condition, answers: Record<string, unknown>) => {
  const def = survey();
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def, state, loop: null });
};

const group = (op: "and" | "or" | "not", children: Condition[]): Condition =>
  ({ type: "group", op, children }) as Condition;

test("A AND (B OR C) brackets the way it is written", () => {
  // AND
  // ├── Q1 = 1
  // └── OR
  //     ├── Q2 = 1
  //     └── Q3 = 1
  const tree = group("and", [
    cond.rule("q1", "eq", 1),
    group("or", [cond.rule("q2", "eq", 1), cond.rule("q3", "eq", 1)]),
  ]);

  assert.equal(evalWith(tree, { q1: 1, q2: 1, q3: 2 }), true, "Q1 and the first arm");
  assert.equal(evalWith(tree, { q1: 1, q2: 2, q3: 1 }), true, "Q1 and the second arm");
  assert.equal(evalWith(tree, { q1: 2, q2: 1, q3: 1 }), false, "Q1 false fails the whole thing");
  assert.equal(evalWith(tree, { q1: 1, q2: 2, q3: 2 }), false, "neither arm");

  // the misreading this must never become: (A AND B) OR C
  const flat = group("or", [
    group("and", [cond.rule("q1", "eq", 1), cond.rule("q2", "eq", 1)]),
    cond.rule("q3", "eq", 1),
  ]);
  assert.equal(evalWith(flat, { q1: 2, q2: 2, q3: 1 }), true,
    "the flattened reading would be true here");
  assert.equal(evalWith(tree, { q1: 2, q2: 2, q3: 1 }), false,
    "the bracketed one is false — the two are genuinely different");
});

test("OR of two ANDs — the other shape", () => {
  // OR
  // ├── AND(Q1=1, Q2=2)
  // └── AND(Q3=3, Q4>10)
  const tree = group("or", [
    group("and", [cond.rule("q1", "eq", 1), cond.rule("q2", "eq", 2)]),
    group("and", [cond.rule("q3", "eq", 3), cond.rule("q4", "gt", 10)]),
  ]);
  assert.equal(evalWith(tree, { q1: 1, q2: 2, q3: 1, q4: 0 }), true, "first pair");
  assert.equal(evalWith(tree, { q1: 1, q2: 1, q3: 3, q4: 11 }), true, "second pair");
  assert.equal(evalWith(tree, { q1: 1, q2: 1, q3: 3, q4: 9 }), false, "half of each is not enough");
});

test("three levels deep, each level keeping its own operator", () => {
  // AND
  // ├── Q1 = 1
  // ├── OR
  // │   ├── Q2 = 1
  // │   ├── Q2 = 2
  // │   └── AND
  // │       ├── Q3 = 3
  // │       └── Q4 > 10
  // └── Q5 answered
  const tree = group("and", [
    cond.rule("q1", "eq", 1),
    group("or", [
      cond.rule("q2", "eq", 1),
      cond.rule("q2", "eq", 2),
      group("and", [cond.rule("q3", "eq", 3), cond.rule("q4", "gt", 10)]),
    ]),
    cond.rule("q5", "answered"),
  ]);

  assert.equal(evalWith(tree, { q1: 1, q2: 1, q5: 1 }), true, "via the innermost OR's first arm");
  assert.equal(evalWith(tree, { q1: 1, q2: 3, q3: 3, q4: 11, q5: 1 }), true,
    "via the deepest AND");
  assert.equal(evalWith(tree, { q1: 1, q2: 3, q3: 3, q4: 5, q5: 1 }), false,
    "the deepest AND fails on Q4, so the OR fails, so the whole thing fails");
  assert.equal(evalWith(tree, { q1: 1, q2: 1 }), false, "Q5 unanswered fails the outer AND");
});

test("changing a nested operator changes ONLY that group", () => {
  // This is the editor's contract expressed as data: the tree is recursive, so
  // rewriting one node's `op` cannot reach its parent or its siblings.
  const before = group("and", [
    cond.rule("q1", "eq", 1),
    group("or", [cond.rule("q2", "eq", 1), cond.rule("q3", "eq", 1)]),
  ]);

  const after = structuredClone(before) as any;
  after.children[1].op = "and"; // the nested OR becomes an AND

  assert.equal(after.op, "and", "the parent's operator is untouched");
  assert.equal(after.children[1].op, "and", "the nested one changed");
  assert.equal((before as any).children[1].op, "or", "and the original is not mutated");

  // and the meaning changes exactly where it should
  assert.equal(evalWith(before, { q1: 1, q2: 1, q3: 2 }), true);
  assert.equal(evalWith(after, { q1: 1, q2: 1, q3: 2 }), false,
    "the nested AND now needs both");
});

test("a NOR group means NONE of these, as the editor says it does", () => {
  const tree = group("and", [
    cond.rule("q1", "eq", 1),
    group("not", [cond.rule("q2", "eq", 2), cond.rule("q3", "eq", 3)]),
  ]);
  assert.equal(evalWith(tree, { q1: 1, q2: 1, q3: 1 }), true, "neither excluded value present");
  assert.equal(evalWith(tree, { q1: 1, q2: 2, q3: 1 }), false, "one of them is enough to fail");
  assert.equal(evalWith(tree, { q1: 1, q2: 2, q3: 3 }), false, "both present, certainly false");

  // a single-child NOR is a plain negation, and reads the same either way
  const single = group("not", [cond.rule("q2", "eq", 2)]);
  assert.equal(evalWith(single, { q2: 2 }), false);
  assert.equal(evalWith(single, { q2: 1 }), true);
});

test("a condition tree survives a JSON round trip unchanged", () => {
  // what the editor holds, what the database stores and what the runtime
  // evaluates must be the same object shape
  const tree = group("and", [
    cond.rule("q1", "eq", 1),
    group("or", [
      cond.rule("q2", "eq", 1),
      group("and", [cond.rule("q3", "eq", 3), cond.rule("q4", "gt", 10)]),
    ]),
  ]);

  const def = survey();
  def.questions[1].displayLogic = tree;
  const stored = SurveyDefinition.parse(JSON.parse(JSON.stringify(def)));
  const reloaded = stored.questions[1].displayLogic!;

  // compare like with like: JSON drops explicitly-undefined keys, which is
  // absence of data rather than loss of it
  assert.deepEqual(
    JSON.parse(JSON.stringify(reloaded)),
    JSON.parse(JSON.stringify(tree)),
    "not one operator, condition or nesting level lost",
  );
  assert.equal((reloaded as any).op, "and");
  assert.equal((reloaded as any).children[1].op, "or");
  assert.equal((reloaded as any).children[1].children[1].op, "and");

  // and it still evaluates identically after the round trip
  for (const answers of [
    { q1: 1, q2: 1 },
    { q1: 1, q2: 2, q3: 3, q4: 11 },
    { q1: 1, q2: 2, q3: 3, q4: 1 },
    { q1: 2, q2: 1 },
  ]) {
    assert.equal(evalWith(reloaded, answers), evalWith(tree, answers),
      `same verdict for ${JSON.stringify(answers)}`);
  }
});

test("skip logic and display logic evaluate through the same engine", () => {
  const def = survey();
  const tree = group("and", [
    cond.rule("q1", "eq", 1),
    group("or", [cond.rule("q2", "eq", 1), cond.rule("q3", "eq", 1)]),
  ]);
  def.questions[1].displayLogic = tree;
  def.questions[2].skipLogic = [
    { id: "s1", when: tree, target: { kind: "end", status: "screened" } },
  ] as any;

  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, { q1: 1, q2: 2, q3: 1 });
  const ctx = { def, state, loop: null };
  assert.equal(
    evaluateCondition(def.questions[1].displayLogic, ctx),
    evaluateCondition(def.questions[2].skipLogic[0].when, ctx),
    "one tree, one evaluator, one answer",
  );
});
