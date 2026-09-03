import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type ConditionGroup } from "@rescript/schema";
import {
  editableCondition, canonicalCondition, emptyGroup, newConditionRule,
  getAt, replaceAt, removeAt, appendTo, duplicateAt, setOperatorAt,
  groupSelection, ungroupAt, validateLogicTree, countConditions, countGroups,
  isUnder, OPERATOR_LABEL, connectorsOf, setGroupConnector,
} from "./logicTree.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";

/* ------------------------------------------------------------- fixtures */

const def = () =>
  SurveyDefinition.parse({
    meta: { id: "lt", code: "LT", title: "Logic tree", version: "1.0" },
    questions: [
      { id: "a1", code: "A1", variableName: "A1", type: "single_select", text: "One",
        options: [{ code: "yes", label: "Yes" }, { code: "no", label: "No" }, { code: "maybe", label: "Maybe" }] },
      { id: "a2", code: "A2", variableName: "A2", type: "single_select", text: "Two",
        options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
      { id: "a3", code: "A3", variableName: "A3", type: "numeric", text: "Age" },
    ],
  });

const rule = (ref: string, value: unknown, operator = "eq"): Condition =>
  ({ type: "rule", source: { kind: "question", ref }, operator: operator as any, value });

/** Evaluate a tree against a set of answers. */
const check = (c: Condition | undefined, answers: Record<string, unknown>) => {
  const d = def();
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def: d, state, loop: null });
};

/* ------------------------------------------- editable / canonical forms */

test("the builder always edits a group, whatever was stored", () => {
  // nothing yet
  assert.deepEqual(editableCondition(undefined), { type: "group", op: "and", children: [] });
  // a lone stored rule becomes a one-child list — the same thing to the evaluator
  const single = rule("a1", "yes");
  const ed = editableCondition(single);
  assert.equal(ed.children.length, 1);
  assert.deepEqual(ed.children[0], single);
  // a stored group is already the editing form
  const g: ConditionGroup = { type: "group", op: "or", children: [single] };
  assert.equal(editableCondition(g), g);
});

test("what gets stored is the smallest tree with the same meaning", () => {
  // one condition: no wrapper worth keeping
  const one = editableCondition(undefined);
  const withOne = appendTo(one, [], rule("a1", "yes"));
  assert.deepEqual(canonicalCondition(withOne), rule("a1", "yes"));

  // two conditions: the group carries the operator, so it stays
  const withTwo = appendTo(withOne, [], rule("a2", "m"));
  const stored = canonicalCondition(withTwo) as ConditionGroup;
  assert.equal(stored.type, "group");
  assert.equal(stored.children.length, 2);

  // an empty builder means "no logic at all"
  assert.equal(canonicalCondition(emptyGroup()), undefined);
  // …unless the caller needs a value, and then it is the harmless one
  assert.deepEqual(canonicalCondition(emptyGroup(), { allowEmpty: false }),
    { type: "group", op: "and", children: [] });

  // a single-child NOT is NOT collapsed — it negates
  const neg: ConditionGroup = { type: "group", op: "not", children: [rule("a1", "yes")] };
  assert.deepEqual(canonicalCondition(neg), neg);
});

test("an empty OR is never stored — it would read as “never”", () => {
  // the danger: set the operator to OR, then delete every condition
  let root = emptyGroup("or");
  root = appendTo(root, [], rule("a1", "yes"));
  root = removeAt(root, [0]);
  const stored = canonicalCondition(root, { allowEmpty: false }) as ConditionGroup;
  assert.equal(stored.op, "and", "the operator goes with the last condition");
  assert.equal(check(stored, {}), true, "and an empty tree constrains nothing");
});

test("a round trip through storage and back is stable", () => {
  const original: ConditionGroup = {
    type: "group", op: "and",
    children: [
      rule("a1", "yes"),
      { type: "group", op: "or", children: [rule("a2", "m"), rule("a3", 25, "gt")] },
    ],
  };
  const stored = canonicalCondition(editableCondition(original));
  assert.deepEqual(stored, original);
  assert.deepEqual(canonicalCondition(editableCondition(stored)), original);
});

/* ------------------------------------------------------- the core gesture */

test("§6: selecting two conditions and grouping them wraps exactly those", () => {
  let root = emptyGroup();
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a2", "m"), rule("a3", 25, "gt")]) {
    root = appendTo(root, [], r);
  }

  const res = groupSelection(root, [[0], [1]], "or");
  assert.ok(res.ok, res.reason);
  const next = res.root;

  // the group took the position of the first selected condition
  assert.equal(next.children.length, 3);
  const g = next.children[0] as ConditionGroup;
  assert.equal(g.type, "group");
  assert.equal(g.op, "or");
  assert.deepEqual(g.children, [rule("a1", "yes"), rule("a1", "no")]);
  // and the unselected ones stayed where they were, in order
  assert.deepEqual(next.children[1], rule("a2", "m"));
  assert.deepEqual(next.children[2], rule("a3", 25, "gt"));
  assert.deepEqual(res.groupPath, [0]);
});

test("grouping a selection from the middle keeps the survivors' order", () => {
  let root = emptyGroup();
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a2", "m"), rule("a3", 25, "gt")]) {
    root = appendTo(root, [], r);
  }
  const res = groupSelection(root, [[1], [3]], "and");
  assert.ok(res.ok);
  // group lands where the first selected item was
  assert.deepEqual(res.groupPath, [1]);
  assert.deepEqual(res.root.children[0], rule("a1", "yes"));
  assert.equal((res.root.children[1] as ConditionGroup).children.length, 2);
  assert.deepEqual(res.root.children[2], rule("a2", "m"));
});

test("§9: a group can be selected and grouped again, which is how nesting deepens", () => {
  let root = emptyGroup();
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a2", "m")]) {
    root = appendTo(root, [], r);
  }
  root = groupSelection(root, [[0], [1]], "or").root;      // (A1=yes OR A1=no), A2=m
  const second = groupSelection(root, [[0], [1]], "and");   // ((…) AND A2=m)
  assert.ok(second.ok, second.reason);
  const outer = second.root.children[0] as ConditionGroup;
  assert.equal(outer.op, "and");
  assert.equal((outer.children[0] as ConditionGroup).op, "or");
  assert.deepEqual(outer.children[1], rule("a2", "m"));
});

test("grouping across levels is refused with a reason, not guessed at", () => {
  let root = emptyGroup();
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a1", "no"));
  root = groupSelection(root, [[0], [1]], "or").root;
  root = appendTo(root, [], rule("a2", "m"));

  // one path inside the bracket, one outside it
  const bad = groupSelection(root, [[0, 0], [1]], "and");
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /same level/);
  assert.equal(bad.root, root, "and nothing changed");

  assert.equal(groupSelection(root, [], "and").ok, false);
  assert.equal(groupSelection(root, [[]], "and").ok, false);
});

test("ungrouping puts the children back where the bracket was", () => {
  let root = emptyGroup();
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a2", "m")]) {
    root = appendTo(root, [], r);
  }
  root = groupSelection(root, [[0], [1]], "or").root;
  const flat = ungroupAt(root, [0]);
  assert.deepEqual(flat.children, [rule("a1", "yes"), rule("a1", "no"), rule("a2", "m")]);
  // the root list is not a bracket, so there is nothing to ungroup there
  assert.equal(ungroupAt(root, []), root);
});

/* ------------------------------------------------- operator independence */

test("§10: changing one group's operator changes nothing else", () => {
  const root: ConditionGroup = {
    type: "group", op: "and",
    children: [
      { type: "group", op: "or", children: [rule("a1", "yes"), rule("a1", "no")] },
      { type: "group", op: "not", children: [rule("a2", "m")] },
      rule("a3", 25, "gt"),
    ],
  };
  const before = JSON.stringify(root);

  const changed = setOperatorAt(root, [0], "and");
  assert.equal((changed.children[0] as ConditionGroup).op, "and");
  // parent untouched
  assert.equal(changed.op, "and");
  // sibling group untouched
  assert.deepEqual(changed.children[1], root.children[1]);
  // sibling condition untouched
  assert.deepEqual(changed.children[2], root.children[2]);
  // and the original object was not mutated
  assert.equal(JSON.stringify(root), before);

  // the same for a deep group
  const deep: ConditionGroup = {
    type: "group", op: "and",
    children: [{ type: "group", op: "or", children: [{ type: "group", op: "not", children: [rule("a1", "yes")] }] }],
  };
  const deepChanged = setOperatorAt(deep, [0, 0], "and");
  assert.equal(((deepChanged.children[0] as ConditionGroup).children[0] as ConditionGroup).op, "and");
  assert.equal((deepChanged.children[0] as ConditionGroup).op, "or", "the parent bracket kept its own operator");
});

/* ----------------------------------------------------- edit primitives */

test("deleting the last condition in a bracket removes the bracket too", () => {
  let root = emptyGroup();
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a2", "m"));
  root = groupSelection(root, [[0]], "or").root;   // ((A1)), A2
  assert.equal((root.children[0] as ConditionGroup).children.length, 1);

  root = removeAt(root, [0, 0]);
  assert.equal(root.children.length, 1, "the empty bracket went with its last child");
  assert.deepEqual(root.children[0], rule("a2", "m"));
});

test("duplicate copies a node in place, deeply", () => {
  let root = emptyGroup();
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a2", "m"));
  root = groupSelection(root, [[0], [1]], "or").root;

  const dup = duplicateAt(root, [0]);
  assert.equal(dup.children.length, 2);
  assert.deepEqual(dup.children[0], dup.children[1]);
  // a real copy, not a shared reference
  const edited = setOperatorAt(dup, [0], "and");
  assert.equal((edited.children[1] as ConditionGroup).op, "or");
});

test("getAt / replaceAt / isUnder address the tree consistently", () => {
  const root: ConditionGroup = {
    type: "group", op: "and",
    children: [rule("a1", "yes"), { type: "group", op: "or", children: [rule("a2", "m")] }],
  };
  assert.deepEqual(getAt(root, []), root);
  assert.deepEqual(getAt(root, [0]), rule("a1", "yes"));
  assert.deepEqual(getAt(root, [1, 0]), rule("a2", "m"));
  assert.equal(getAt(root, [9]), null);
  assert.equal(getAt(root, [0, 0]), null);

  const swapped = replaceAt(root, [1, 0], rule("a3", 1, "gt"));
  assert.deepEqual((swapped.children[1] as ConditionGroup).children[0], rule("a3", 1, "gt"));
  assert.deepEqual(swapped.children[0], rule("a1", "yes"));

  assert.equal(isUnder([1, 0], [1]), true);
  assert.equal(isUnder([1], [1]), true);
  assert.equal(isUnder([0], [1]), false);
});

test("counts describe the tree for the builder's header", () => {
  const root: ConditionGroup = {
    type: "group", op: "and",
    children: [
      rule("a1", "yes"),
      { type: "group", op: "or", children: [rule("a2", "m"), { type: "group", op: "not", children: [rule("a3", 5, "gt")] }] },
    ],
  };
  assert.equal(countConditions(root), 3);
  assert.equal(countGroups(root), 2);
  assert.equal(OPERATOR_LABEL.not, "NOT");
});

/* ---------------------------------------------------------- validation */

test("§19: the builder can see what the evaluator could not process", () => {
  const withEmptyGroup: ConditionGroup = {
    type: "group", op: "and",
    children: [rule("a1", "yes"), { type: "group", op: "or", children: [] }],
  };
  const issues = validateLogicTree(withEmptyGroup);
  assert.ok(issues.some((i) => i.level === "error" && /empty/.test(i.message)));

  const noQuestion: ConditionGroup = {
    type: "group", op: "and",
    children: [{ type: "rule", source: { kind: "question", ref: "" }, operator: "eq", value: "x" } as Condition],
  };
  assert.ok(validateLogicTree(noQuestion).some((i) => i.level === "error" && /no question/.test(i.message)));

  const noValue: ConditionGroup = { type: "group", op: "and", children: [rule("a1", "")] };
  assert.ok(validateLogicTree(noValue).some((i) => i.level === "warning" && /no value/.test(i.message)));

  // operators that take no value are not nagged about one
  const answered: ConditionGroup = { type: "group", op: "and", children: [rule("a1", undefined, "answered")] };
  assert.deepEqual(validateLogicTree(answered), []);

  // an empty ROOT list is the normal starting state, not an error
  assert.deepEqual(validateLogicTree(emptyGroup()), []);
});

/* ------------------------------------------------------ §20: evaluation */

test("§20: a single condition", () => {
  const c = canonicalCondition(appendTo(emptyGroup(), [], rule("a1", "yes")));
  assert.equal(check(c, { a1: "yes" }), true);
  assert.equal(check(c, { a1: "no" }), false);
});

test("§20: AND and OR at the top level", () => {
  let root = emptyGroup("and");
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a2", "m"));
  const and = canonicalCondition(root);
  assert.equal(check(and, { a1: "yes", a2: "m" }), true);
  assert.equal(check(and, { a1: "yes", a2: "f" }), false);

  const or = canonicalCondition(setOperatorAt(root, [], "or"));
  assert.equal(check(or, { a1: "yes", a2: "f" }), true);
  assert.equal(check(or, { a1: "no", a2: "f" }), false);
});

test("§20: NOT negates the whole group", () => {
  let root = emptyGroup("not");
  root = appendTo(root, [], rule("a1", "yes"));
  const not = canonicalCondition(root);
  assert.equal(check(not, { a1: "yes" }), false);
  assert.equal(check(not, { a1: "no" }), true);
});

test("§20: A AND (B OR C) — built the way the UI builds it", () => {
  let root = emptyGroup("and");
  root = appendTo(root, [], rule("a1", "yes"));   // A
  root = appendTo(root, [], rule("a2", "m"));     // B
  root = appendTo(root, [], rule("a3", 25, "gt")); // C
  // select B and C, Move to New Group, choose OR
  root = groupSelection(root, [[1], [2]], "or").root;
  const c = canonicalCondition(root);

  assert.equal(check(c, { a1: "yes", a2: "m", a3: 10 }), true, "A and B");
  assert.equal(check(c, { a1: "yes", a2: "f", a3: 30 }), true, "A and C");
  assert.equal(check(c, { a1: "yes", a2: "f", a3: 10 }), false, "A but neither B nor C");
  assert.equal(check(c, { a1: "no", a2: "m", a3: 30 }), false, "not A");
});

test("§20: A OR (B AND C) — the same shape with the operators swapped", () => {
  let root = emptyGroup("or");
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a2", "m"));
  root = appendTo(root, [], rule("a3", 25, "gt"));
  root = groupSelection(root, [[1], [2]], "and").root;
  const c = canonicalCondition(root);

  assert.equal(check(c, { a1: "yes", a2: "f", a3: 1 }), true, "A alone");
  assert.equal(check(c, { a1: "no", a2: "m", a3: 30 }), true, "B and C");
  assert.equal(check(c, { a1: "no", a2: "m", a3: 10 }), false, "B without C");
});

test("§20: NOT(A OR B)", () => {
  let root = emptyGroup();
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], rule("a2", "m"));
  root = groupSelection(root, [[0], [1]], "or").root;
  root = setOperatorAt(root, [0], "or");
  // wrap the OR bracket in a NOT
  root = groupSelection(root, [[0]], "not").root;
  const c = canonicalCondition(root);

  assert.equal(check(c, { a1: "no", a2: "f" }), true, "neither");
  assert.equal(check(c, { a1: "yes", a2: "f" }), false, "A");
  assert.equal(check(c, { a1: "no", a2: "m" }), false, "B");
});

test("§20: four levels deep — AND → OR → NOT → AND", () => {
  const deep: ConditionGroup = {
    type: "group", op: "and",
    children: [
      rule("a1", "yes"),
      {
        type: "group", op: "or",
        children: [
          rule("a2", "f"),
          {
            type: "group", op: "not",
            children: [{ type: "group", op: "and", children: [rule("a2", "m"), rule("a3", 25, "gt")] }],
          },
        ],
      },
    ],
  };
  // A1=yes AND ( A2=f OR NOT(A2=m AND A3>25) )
  assert.equal(check(deep, { a1: "yes", a2: "f", a3: 30 }), true);
  assert.equal(check(deep, { a1: "yes", a2: "m", a3: 30 }), false, "the inner AND holds, so NOT is false");
  assert.equal(check(deep, { a1: "yes", a2: "m", a3: 10 }), true, "the inner AND fails, so NOT is true");
  assert.equal(check(deep, { a1: "no", a2: "f", a3: 30 }), false, "the outer AND still needs A1");

  // and the shape survives being edited at depth
  const flipped = setOperatorAt(deep, [1, 1, 0], "or");
  assert.equal(check(flipped, { a1: "yes", a2: "m", a3: 10 }), false,
    "the inner OR now holds (A2=m), so NOT is false");
  assert.equal((flipped.children[1] as ConditionGroup).op, "or", "outer brackets unchanged");
});

test("nesting is never flattened by the editing operations", () => {
  const original: ConditionGroup = {
    type: "group", op: "and",
    children: [
      { type: "group", op: "or", children: [rule("a1", "yes"), rule("a1", "no")] },
      { type: "group", op: "or", children: [rule("a1", "maybe"), rule("a2", "m")] },
    ],
  };
  // touch every level, then compare the stored form
  let root = setOperatorAt(original, [0], "or");
  root = replaceAt(root, [1, 0], rule("a1", "maybe"));
  root = appendTo(root, [1], rule("a3", 1, "gt"));
  const stored = canonicalCondition(root) as ConditionGroup;
  assert.equal(stored.children.length, 2);
  assert.equal((stored.children[0] as ConditionGroup).children.length, 2);
  assert.equal((stored.children[1] as ConditionGroup).children.length, 3);
  assert.equal((stored.children[0] as ConditionGroup).type, "group");
});

/* -------------------------------------------- existing logic keeps working */

test("§16: logic saved before this builder existed loads, means the same, and re-saves", () => {
  // the shapes older surveys actually contain
  const legacyRule = rule("a1", "yes");
  const legacyFlat: ConditionGroup = { type: "group", op: "and", children: [rule("a1", "yes"), rule("a2", "m")] };
  const legacyNested: ConditionGroup = {
    type: "group", op: "or",
    children: [rule("a1", "yes"), { type: "group", op: "and", children: [rule("a2", "m"), rule("a3", 25, "gt")] }],
  };

  for (const legacy of [legacyRule, legacyFlat, legacyNested] as Condition[]) {
    const answers = [
      { a1: "yes", a2: "m", a3: 30 },
      { a1: "no", a2: "m", a3: 30 },
      { a1: "yes", a2: "f", a3: 10 },
      { a1: "no", a2: "f", a3: 10 },
    ];
    const roundTripped = canonicalCondition(editableCondition(legacy));
    for (const a of answers) {
      assert.equal(check(roundTripped, a), check(legacy, a),
        `meaning preserved for ${JSON.stringify(legacy)} with ${JSON.stringify(a)}`);
    }
  }
});

/* ==========================================================================
 * Independent operators (the AND/OR-shared-state report).
 *
 * The data model was never shared state — every group has owned its own `op`
 * throughout, which the tests above prove. What was shared was the CONTROL:
 * a group has one operator, and the builder drew one dropdown per gap between
 * its children, so four conditions in one list put three dropdowns onto one
 * stored value. Setting one appeared to set the others, and
 * `C1 AND C2 OR C3 AND C4` could not be expressed at all.
 * ======================================================================== */

test("the reported symptom: one level, one operator, so every gap read the same", () => {
  let root = emptyGroup("and");
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a1", "maybe"), rule("a2", "m")]) {
    root = appendTo(root, [], r);
  }
  // three gaps, one stored operator — this is what the old control edited
  assert.deepEqual(connectorsOf(root), ["and", "and", "and"]);
  const allChanged = setOperatorAt(root, [], "or");
  assert.deepEqual(connectorsOf(allChanged), ["or", "or", "or"],
    "setting the group's operator moves every gap, by definition");
});

test("§1: setting ONE gap leaves the others alone — C1 AND C2 OR C3 AND C4", () => {
  let root = emptyGroup("and");
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a1", "maybe"), rule("a2", "m")]) {
    root = appendTo(root, [], r);
  }
  // change only the middle gap
  const next = setGroupConnector(root, [], 1, "or");

  // AND binds tighter, so the structure the edit means is (C1 AND C2) OR (C3 AND C4)
  assert.equal(next.op, "or");
  assert.equal(next.children.length, 2);
  const [left, right] = next.children as ConditionGroup[];
  assert.equal(left.op, "and");
  assert.equal(right.op, "and");
  assert.deepEqual(left.children.map((c: any) => c.value), ["yes", "no"]);
  assert.deepEqual(right.children.map((c: any) => c.value), ["maybe", "m"]);

  // and it evaluates as written
  assert.equal(check(next, { a1: "yes", a2: "f" }), false, "C1 alone is not enough");
  assert.equal(check(next, { a1: "yes", a2: "m" }), false, "C1 and C4 straddle the OR");
  const withLeft = canonicalCondition(next);
  assert.equal(check(withLeft, { a1: "yes" }), false);
});

test("§1: setting a gap back restores the meaning, and leaves the bracket to be ungrouped", () => {
  let root = emptyGroup("and");
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a1", "maybe")]) {
    root = appendTo(root, [], r);
  }
  const before = canonicalCondition(root);
  const split = setGroupConnector(root, [], 0, "or");   // C1 OR (C2 AND C3)
  assert.equal(split.op, "or");
  assert.equal((split.children[1] as ConditionGroup).op, "and");

  /*
   * Setting that gap back to AND gives `C1 AND (C2 AND C3)` — the same thing
   * as `C1 AND C2 AND C3` to the evaluator, but with the bracket still drawn.
   *
   * The bracket is NOT dissolved automatically. A bracket may have been
   * created deliberately with "Move to new group", and there is nothing in the
   * tree that distinguishes one the programmer made from one precedence
   * produced — so removing it on a hunch would silently delete structure
   * someone built. It is one visible click ("ungroup") away instead.
   */
  const merged = setGroupConnector(split, [], 0, "and");
  assert.equal(merged.op, "and");
  const answers = [
    { a1: "yes" }, { a1: "no" }, { a1: "maybe" }, {},
  ];
  for (const a of answers) {
    assert.equal(check(canonicalCondition(merged), a), check(before, a),
      `same meaning as the flat AND for ${JSON.stringify(a)}`);
  }
  // and ungrouping gets the flat list back exactly
  const flat = ungroupAt(merged, [1]);
  assert.deepEqual(flat.children.map((c: any) => c.value), ["yes", "no", "maybe"]);
});

test("§16 test 1–2: sibling groups keep their own operators", () => {
  const root: ConditionGroup = {
    type: "group", op: "and",
    children: [
      { type: "group", op: "and", children: [rule("a1", "yes"), rule("a2", "m")] },   // A
      { type: "group", op: "or", children: [rule("a1", "no"), rule("a3", 25, "gt")] }, // B
      { type: "group", op: "not", children: [rule("a1", "maybe")] },                  // C
    ],
  };
  const ops = (g: ConditionGroup) => g.children.map((c: any) => c.op);
  assert.deepEqual(ops(root), ["and", "or", "not"]);

  // change A, then B, then C — each time the other two are untouched
  const afterA = setOperatorAt(root, [0], "or");
  assert.deepEqual(ops(afterA), ["or", "or", "not"]);
  const afterB = setOperatorAt(afterA, [1], "and");
  assert.deepEqual(ops(afterB), ["or", "and", "not"]);
  const afterC = setOperatorAt(afterB, [2], "or");
  assert.deepEqual(ops(afterC), ["or", "and", "or"]);
  // the parent never moved
  assert.equal(afterC.op, "and");
});

test("§16 test 3: parent, child and grandchild are independent", () => {
  const root: ConditionGroup = {
    type: "group", op: "and",
    children: [
      rule("a1", "yes"),
      {
        type: "group", op: "or",
        children: [
          rule("a2", "m"),
          { type: "group", op: "not", children: [rule("a3", 25, "gt")] },
        ],
      },
    ],
  };
  const child = setOperatorAt(root, [1], "and");
  assert.equal(child.op, "and", "parent unchanged");
  assert.equal((child.children[1] as ConditionGroup).op, "and", "child changed");
  assert.equal(
    ((child.children[1] as ConditionGroup).children[1] as ConditionGroup).op, "not",
    "grandchild unchanged",
  );
});

test("§16 test 4: four sibling groups, four independent operators", () => {
  const pair = (op: ConditionGroup["op"]): Condition =>
    ({ type: "group", op, children: [rule("a1", "yes"), rule("a2", "m")] });
  let root: ConditionGroup = {
    type: "group", op: "and",
    children: [pair("and"), pair("or"), pair("and"), pair("or")],
  };
  root = setOperatorAt(root, [1], "and");
  root = setOperatorAt(root, [3], "not");
  assert.deepEqual(root.children.map((c: any) => c.op), ["and", "and", "and", "not"]);
  root = setOperatorAt(root, [0], "or");
  assert.deepEqual(root.children.map((c: any) => c.op), ["or", "and", "and", "not"]);
});

test("§16 test 5: a group made from a selection gets its own operator", () => {
  let root = emptyGroup("or");
  for (const r of [rule("a1", "yes"), rule("a1", "no"), rule("a1", "maybe"), rule("a2", "m")]) {
    root = appendTo(root, [], r);
  }
  // the list is OR; group two of them and make that bracket AND
  const grouped = groupSelection(root, [[0], [1]], "and");
  assert.ok(grouped.ok);
  const next = setOperatorAt(grouped.root, [0], "and");
  assert.equal(next.op, "or", "the level around it is still OR");
  assert.equal((next.children[0] as ConditionGroup).op, "and", "the new bracket is AND");
  // …and evaluates as (C1 AND C2) OR C3 OR C4
  assert.equal(check(canonicalCondition(next), { a1: "maybe", a2: "f" }), true);
  assert.equal(check(canonicalCondition(next), { a1: "yes", a2: "f" }), false,
    "the AND bracket needs both of its own conditions");
});

test("§16 test 7 / §14: every group's own operator drives the evaluation", () => {
  // A AND (B OR C)
  const andOr: Condition = {
    type: "group", op: "and",
    children: [rule("a1", "yes"), { type: "group", op: "or", children: [rule("a2", "m"), rule("a3", 25, "gt")] }],
  };
  assert.equal(check(andOr, { a1: "yes", a2: "m", a3: 1 }), true);
  assert.equal(check(andOr, { a1: "no", a2: "m", a3: 30 }), false);

  // A OR (B AND C) — same shape, different operators, different meaning
  const orAnd: Condition = {
    type: "group", op: "or",
    children: [rule("a1", "yes"), { type: "group", op: "and", children: [rule("a2", "m"), rule("a3", 25, "gt")] }],
  };
  assert.equal(check(orAnd, { a1: "yes", a2: "f", a3: 1 }), true);
  assert.equal(check(orAnd, { a1: "no", a2: "m", a3: 1 }), false);
});

test("§8: setting a gap does not flatten anything the programmer built", () => {
  // a hand-made bracket sits among bare conditions
  let root = emptyGroup("and");
  root = appendTo(root, [], rule("a1", "yes"));
  root = appendTo(root, [], { type: "group", op: "or", children: [rule("a2", "m"), rule("a2", "f")] });
  root = appendTo(root, [], rule("a3", 25, "gt"));

  const next = setGroupConnector(root, [], 1, "or");
  // the hand-made OR bracket is still a bracket, with its own children
  const kept = (next.children[0] as ConditionGroup).children[1] as ConditionGroup;
  assert.equal(kept.op, "or");
  assert.deepEqual(kept.children.map((c: any) => c.value), ["m", "f"]);
  // and the new structure is (C1 AND (m OR f)) OR C3
  assert.equal(next.op, "or");
  assert.equal((next.children[0] as ConditionGroup).op, "and");
});

test("a NOT group has no binary connector to set", () => {
  const root: ConditionGroup = {
    type: "group", op: "not",
    children: [rule("a1", "yes"), rule("a2", "m")],
  };
  assert.equal(setGroupConnector(root, [], 0, "or"), root, "NOT is left to its own control");
  // out-of-range gaps are refused rather than guessed at
  const two = { type: "group", op: "and", children: [rule("a1", "yes"), rule("a2", "m")] } as ConditionGroup;
  assert.equal(setGroupConnector(two, [], 5, "or"), two);
  assert.equal(setGroupConnector(emptyGroup(), [], 0, "or").children.length, 0);
});
