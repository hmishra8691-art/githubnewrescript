import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type SurveyDefinition as Def } from "@rescript/schema";
import { parsePunchExpression, formatPunchExpression } from "./autoPunch.js";
import { parseLogicExpression, formatCondition } from "./logicExpression.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState, answerKey } from "./state.js";
import { start, advance, setAnswer, visibleQuestions, compileFlow, type RuntimeStep } from "./flow.js";
import { questionDependencies } from "./dependencies.js";
import {
  editableCondition, canonicalCondition, groupSelection, setOperatorAt,
  setGroupConnector, appendTo, newConditionRule, countGroups,
} from "./logicTree.js";

/*
 * AUTO PUNCH WITH NESTED CONDITIONS — THE SEVEN TESTS THE BRIEF NAMES,
 * AND THE PARITY ASSERTION THAT IS THE REASON THEY PASS.
 *
 * The report was that a punch gated on `A AND (B OR C)` did not fire
 * correctly, and that multiple nested groups lost their grouping. The first
 * thing to establish was whether Auto Punch evaluates conditions ITSELF or
 * borrows the engine's evaluator, because those are different bugs with
 * different fixes — and a second evaluator is the kind of thing that gets
 * written once and then disagrees with the first one for ever.
 *
 * It borrows. `parsePunchExpression` hands the whole IF half to
 * `parseLogicExpression` unchanged; the rule stores an ordinary `Condition`;
 * `applyPunches` asks `evaluateCondition`. There is one tree and one
 * evaluator, which is why the tests below pass as written.
 *
 * So these tests are not a fix. They are the assertion that was missing:
 * nothing in the suite held Auto Punch to nested conditions at all, which is
 * exactly how a regression in the shared parser or the shared evaluator would
 * have reached a punch rule unnoticed — and a punch that does not fire is
 * silent. Nobody sees a missing tick; they see a data file, months later,
 * where a derived variable is empty for a third of the sample.
 *
 * The last test is the load-bearing one: the SAME condition tree, read
 * through display logic and through a punch rule, must give the same answer
 * for the same respondent. That is the brief's §5 requirement stated as
 * something that can fail.
 */

/* ---------------------------------------------------------------- fixtures */

const opts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ code: String(i + 1), label: `Option ${i + 1}` }));

const question = (code: string) => ({
  id: code.toLowerCase(), code, variableName: code, type: "multi_select",
  text: `${code}?`, options: opts(6),
});

/**
 * Q1–Q5 on page one, Q6 on page two.
 *
 * The target is on a LATER page on purpose: that is the arrival path through
 * the flow interpreter, the one a real questionnaire takes. The same-page
 * path (Runner's `onChange`) is a different caller of the same
 * `applyPunches`, and it is gated by `questionDependencies`, which is
 * asserted separately below.
 */
function survey(rules: { expr: string }[]): Def {
  const def = SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-0000000apn01", code: "APN", title: "Auto punch, nested" },
    questions: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"].map(question),
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] },
      { type: "page", id: "p2", questionIds: ["q6"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  for (const { expr } of rules) {
    const parsed = parsePunchExpression(def, expr);
    assert.deepEqual(parsed.errors, [], `the rule did not parse: ${expr}`);
    for (const { targetQuestionId, rule } of parsed.rules) {
      const target = def.questions.find((q) => q.id === targetQuestionId)!;
      target.punches = [...(target.punches ?? []), rule];
    }
  }
  return def;
}

/** Answer page one, advance onto page two, and read what the punch left. */
function punched(def: Def, answers: Record<string, string[]>, target = "q6"): string[] {
  const state = createResponseState(def);
  start(def, state);
  for (const [qid, v] of Object.entries(answers)) setAnswer(def, state, qid, v);
  advance(def, state);
  const got = state.answers[answerKey(target, null)];
  return Array.isArray(got) ? got.map(String) : got == null ? [] : [String(got)];
}

/** The `when` of the single rule on a question. */
const whenOf = (def: Def, qid: string): Condition =>
  def.questions.find((q) => q.id === qid)!.punches![0].when!;

/* ============================================================= the brief's 7 */

test("Test 1 — a simple condition: IF Q1=1 THEN PUNCH Q6.3", () => {
  const def = survey([{ expr: "IF Q1.1 IS SELECTED THEN SELECT Q6.3" }]);
  assert.deepEqual(punched(def, { q1: ["1"] }), ["3"]);
  assert.deepEqual(punched(def, { q1: ["2"] }), []);
});

test("Test 2 — AND: both halves are required", () => {
  const def = survey([{ expr: "IF Q1.1 IS SELECTED AND Q2.2 IS SELECTED THEN SELECT Q6.4" }]);
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["4"]);
  assert.deepEqual(punched(def, { q1: ["1"] }), [], "one half is not enough for AND");
  assert.deepEqual(punched(def, { q2: ["2"] }), [], "nor is the other");
});

test("Test 3 — OR: either half is enough, and neither is not", () => {
  const def = survey([{ expr: "IF Q1.1 IS SELECTED OR Q2.2 IS SELECTED THEN SELECT Q6.4" }]);
  assert.deepEqual(punched(def, { q1: ["1"] }), ["4"]);
  assert.deepEqual(punched(def, { q2: ["2"] }), ["4"]);
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["4"], "both is still once");
  assert.deepEqual(punched(def, { q1: ["5"], q2: ["5"] }), []);
});

test("Test 4 — nested: IF Q1=1 AND (Q2=2 OR Q2=3) THEN PUNCH Q6.4", () => {
  const def = survey([{
    expr: "IF Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED) THEN SELECT Q6.4",
  }]);

  /*
   * The stored shape first. If the bracket were flattened into one AND list
   * the values below would still come out right for some of these rows and
   * wrong for others — `Q2=2` alone would start punching — so the structure
   * is asserted before the behaviour, not instead of it.
   */
  const when = whenOf(def, "q6");
  assert.equal(when.type, "group");
  assert.equal((when as { op: string }).op, "and");
  const kids = (when as { children: Condition[] }).children;
  assert.equal(kids.length, 2, "an AND of two things, not a flattened list of three");
  assert.equal(kids[0].type, "rule");
  assert.equal(kids[1].type, "group");
  assert.equal((kids[1] as { op: string }).op, "or");
  assert.equal((kids[1] as { children: Condition[] }).children.length, 2);

  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["4"]);
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["3"] }), ["4"]);
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["4"] }), [], "the inner OR is not satisfied");
  assert.deepEqual(punched(def, { q1: ["1"] }), [], "nor by nothing at all");
  assert.deepEqual(punched(def, { q2: ["2"] }), [], "the outer AND still needs Q1");
  assert.deepEqual(punched(def, { q2: ["2", "3"] }), [], "and both inner arms do not replace it");
});

test("Test 5 — two nested groups joined by OR, each with its own inner OR", () => {
  const def = survey([{
    expr:
      "IF (Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED))"
      + " OR (Q4.4 IS SELECTED AND (Q5.5 IS SELECTED OR Q5.6 IS SELECTED))"
      + " THEN SELECT Q6.1",
  }]);

  /* the exact tree the brief drew, asserted branch by branch */
  const root = whenOf(def, "q6") as { op: string; children: Condition[] };
  assert.equal(root.op, "or");
  assert.equal(root.children.length, 2);
  for (const branch of root.children) {
    const b = branch as { type: string; op: string; children: Condition[] };
    assert.equal(b.type, "group");
    assert.equal(b.op, "and", "each branch is an AND of a rule and an inner OR");
    assert.equal(b.children.length, 2);
    assert.equal(b.children[0].type, "rule");
    assert.equal((b.children[1] as { type: string; op: string }).type, "group");
    assert.equal((b.children[1] as { op: string }).op, "or");
  }

  /* left branch */
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["1"]);
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["3"] }), ["1"]);
  /* right branch */
  assert.deepEqual(punched(def, { q4: ["4"], q5: ["5"] }), ["1"]);
  assert.deepEqual(punched(def, { q4: ["4"], q5: ["6"] }), ["1"]);
  /* half of a branch is not a branch */
  assert.deepEqual(punched(def, { q1: ["1"] }), []);
  assert.deepEqual(punched(def, { q4: ["4"] }), []);
  assert.deepEqual(punched(def, { q2: ["2"] }), []);
  assert.deepEqual(punched(def, { q5: ["5"] }), []);
  /*
   * THE CASE THAT CATCHES A FLATTENED TREE. One half of each branch is
   * satisfied and neither branch is. A single OR list over all six leaves
   * would punch here; the tree must not.
   */
  assert.deepEqual(punched(def, { q1: ["1"], q5: ["5"] }), [], "grouping is not interchangeable");
  assert.deepEqual(punched(def, { q4: ["4"], q2: ["2"] }), [], "nor the other way round");
});

test("Test 6 — a false condition does not punch, and does not clear either", () => {
  const def = survey([{ expr: "IF Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED) THEN SELECT Q6.4" }]);
  assert.deepEqual(punched(def, { q1: ["2"], q2: ["5"] }), []);
  assert.deepEqual(punched(def, {}), []);

  /*
   * And a false rule leaves an answer the respondent gave alone. A punch that
   * silently erased an answer when its condition stopped holding would be
   * worse than one that never fired.
   */
  const state = createResponseState(def);
  start(def, state);
  setAnswer(def, state, "q1", ["5"]);
  advance(def, state);
  setAnswer(def, state, "q6", ["2"]);
  assert.deepEqual(state.answers[answerKey("q6", null)], ["2"]);
});

test("Test 7 — several rules on one question run independently", () => {
  const def = survey([
    { expr: "IF Q1.1 IS SELECTED THEN SELECT Q6.1" },
    { expr: "IF Q2.2 IS SELECTED AND (Q3.3 IS SELECTED OR Q3.4 IS SELECTED) THEN SELECT Q6.2" },
    { expr: "IF Q4.4 IS SELECTED THEN SELECT Q6.3" },
  ]);
  assert.equal(def.questions.find((q) => q.id === "q6")!.punches!.length, 3);

  assert.deepEqual(punched(def, { q1: ["1"] }), ["1"], "only the rule whose condition holds");
  assert.deepEqual(punched(def, { q2: ["2"], q3: ["3"] }), ["2"]);
  assert.deepEqual(punched(def, { q4: ["4"] }), ["3"]);

  /* two at once, and neither overwrites the other */
  assert.deepEqual(punched(def, { q1: ["1"], q4: ["4"] }).sort(), ["1", "3"]);
  /* all three, with the middle one's nested condition satisfied by its second arm */
  assert.deepEqual(
    punched(def, { q1: ["1"], q2: ["2"], q3: ["4"], q4: ["4"] }).sort(),
    ["1", "2", "3"],
  );
  /* the middle one's outer AND still bites when only its inner OR holds */
  assert.deepEqual(punched(def, { q1: ["1"], q3: ["3"] }), ["1"]);
});

/* ===================================================== grouping and precedence */

test("AND binds tighter than OR, and the stored tree says so", () => {
  const def = survey([{ expr: "IF Q1.1 IS SELECTED OR Q2.2 IS SELECTED AND Q3.3 IS SELECTED THEN SELECT Q6.1" }]);
  const root = whenOf(def, "q6") as { op: string; children: Condition[] };
  assert.equal(root.op, "or", "the top of A OR B AND C is the OR");
  assert.equal(root.children[0].type, "rule");
  assert.equal((root.children[1] as { op: string }).op, "and");

  assert.deepEqual(punched(def, { q1: ["1"] }), ["1"], "A alone is enough");
  assert.deepEqual(punched(def, { q2: ["2"] }), [], "B alone is not");
  assert.deepEqual(punched(def, { q2: ["2"], q3: ["3"] }), ["1"], "B AND C is");
});

test("the brackets decide, not the order: (A OR B) AND C differs from A OR (B AND C)", () => {
  const loose = survey([{ expr: "IF Q1.1 IS SELECTED OR Q2.2 IS SELECTED AND Q3.3 IS SELECTED THEN SELECT Q6.1" }]);
  const tight = survey([{ expr: "IF (Q1.1 IS SELECTED OR Q2.2 IS SELECTED) AND Q3.3 IS SELECTED THEN SELECT Q6.1" }]);
  const answers = { q1: ["1"] };
  assert.deepEqual(punched(loose, answers), ["1"]);
  assert.deepEqual(punched(tight, answers), [], "the bracket makes Q3 mandatory");
  assert.deepEqual(punched(tight, { q1: ["1"], q3: ["3"] }), ["1"]);
});

test("NOT over a bracket is NONE-of, at three levels of nesting", () => {
  const def = survey([{
    expr: "IF Q1.1 IS SELECTED AND NOT (Q2.2 IS SELECTED OR (Q3.3 IS SELECTED AND Q4.4 IS SELECTED)) THEN SELECT Q6.1",
  }]);
  assert.deepEqual(punched(def, { q1: ["1"] }), ["1"], "nothing to negate");
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), [], "the NOT bites");
  assert.deepEqual(punched(def, { q1: ["1"], q3: ["3"] }), ["1"], "the inner AND is not satisfied");
  assert.deepEqual(punched(def, { q1: ["1"], q3: ["3"], q4: ["4"] }), [], "now it is");
});

test("a multi-child NOT is NONE-of, not NAND", () => {
  /*
   * The visual builder can set a group's operator to NOT with several
   * children in it; the text parser cannot (`NOT (a OR b)` is a one-child NOT
   * over an OR). So this shape only ever arrives from the builder — and it is
   * the only shape where the two readings of NOT differ at all.
   *
   * NONE-of is false as soon as ANY child is true. NAND — which is what the
   * evaluator used to compute — is true unless EVERY child is true, so it
   * fires on the middle two rows below while the editor's own label says
   * "none of these may be true". Every single-child NOT in the tests above
   * passes identically under both readings, which is exactly why this case
   * has to be written out: without it, a regression to NAND is invisible.
   */
  const def = survey([]);
  const rule = (ref: string, value: string) =>
    ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value }) as Condition;
  def.questions.find((q) => q.id === "q6")!.punches = [{
    id: "p1", source: { kind: "codes", codes: ["1"] }, action: "select",
    mapping: [], ignoreUnmatched: true, recompute: "always",
    when: { type: "group", op: "not", children: [rule("q1", "1"), rule("q2", "2")] },
  }];

  assert.deepEqual(punched(def, {}), ["1"], "neither is true — none-of holds");
  assert.deepEqual(punched(def, { q1: ["1"] }), [], "one is true, so NOT of them is false");
  assert.deepEqual(punched(def, { q2: ["2"] }), [], "and the other way round");
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), [], "both true is still false");
});

test("depth survives: four levels of alternating AND/OR evaluate as written", () => {
  const def = survey([{
    expr: "IF Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR (Q3.3 IS SELECTED AND (Q4.4 IS SELECTED OR Q5.5 IS SELECTED))) THEN SELECT Q6.1",
  }]);
  let node: Condition = whenOf(def, "q6");
  let depth = 0;
  while (node.type === "group") { depth += 1; node = node.children[node.children.length - 1]; }
  assert.equal(depth, 4, "the tree really is four groups deep");

  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["1"]);
  assert.deepEqual(punched(def, { q1: ["1"], q3: ["3"] }), [], "the innermost OR is unmet");
  assert.deepEqual(punched(def, { q1: ["1"], q3: ["3"], q5: ["5"] }), ["1"]);
  assert.deepEqual(punched(def, { q3: ["3"], q5: ["5"] }), [], "the outermost AND still needs Q1");
});

/* =========================================== the same-page path's own gate */

test("every question named anywhere in a nested condition is a dependency", () => {
  /*
   * THE OTHER CALLER, AND THE ONE A PREVIEW ACTUALLY USES.
   *
   * On arrival at a page the flow interpreter runs every punch on it. On the
   * SAME page — which is what a researcher clicking through Preview sees, and
   * what a one-page questionnaire is — the Runner recomputes a punch only
   * when the question just answered is in `questionDependencies(def, target)`.
   *
   * So a dependency walk that stopped at the top level of a condition would
   * produce exactly the reported symptom, and only for nested rules: the
   * punch fires when Q1 changes (named at the top) and not when Q2 changes
   * (named inside the bracket), so `A AND (B OR C)` appears to work
   * intermittently, depending on which box the researcher ticked last.
   *
   * `conditionRefs` does recurse. This is the assertion that says so, at
   * every depth the brief asks for.
   */
  const def = survey([{
    expr:
      "IF (Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED))"
      + " OR (Q4.4 IS SELECTED AND (Q5.5 IS SELECTED OR Q5.6 IS SELECTED))"
      + " THEN SELECT Q6.1",
  }]);
  const target = def.questions.find((q) => q.id === "q6")!;
  const deps = questionDependencies(def, target);

  for (const id of ["q1", "q2", "q4", "q5"]) {
    assert.ok(deps.has(id), `${id} is read by the rule but is not a dependency — a same-page edit to it would not re-punch`);
  }
  assert.ok(!deps.has("q3"), "q3 is named nowhere in the rule and must not be dragged in");

  /* and the depth-4 shape, so the walk is not merely two levels deep */
  const deep = survey([{
    expr: "IF Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR (Q3.3 IS SELECTED AND (Q4.4 IS SELECTED OR Q5.5 IS SELECTED))) THEN SELECT Q6.1",
  }]);
  const deepDeps = questionDependencies(deep, deep.questions.find((q) => q.id === "q6")!);
  for (const id of ["q1", "q2", "q3", "q4", "q5"]) {
    assert.ok(deepDeps.has(id), `${id} sits four levels down and was not found`);
  }
});

/* ========================================================= the round trip */

test("every nesting shape survives print → re-parse unchanged", () => {
  /*
   * The editor prints a rule into its text box on every definition change and
   * re-parses it on blur. A shape that does not survive that is a shape the
   * Studio quietly rewrites while the programmer is looking at it — which is
   * indistinguishable, from the outside, from an evaluator that gets nesting
   * wrong.
   */
  const shapes = [
    "IF Q1.1 IS SELECTED THEN SELECT Q6.1",
    "IF Q1.1 IS SELECTED AND Q2.2 IS SELECTED THEN SELECT Q6.1",
    "IF Q1.1 IS SELECTED OR Q2.2 IS SELECTED THEN SELECT Q6.1",
    "IF Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED) THEN SELECT Q6.1",
    "IF (Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED)) OR (Q4.4 IS SELECTED AND (Q5.5 IS SELECTED OR Q5.6 IS SELECTED)) THEN SELECT Q6.1",
    "IF Q1.1 IS SELECTED AND NOT (Q2.2 IS SELECTED OR Q3.3 IS SELECTED) THEN SELECT Q6.1",
    "IF Q1.1 IS SELECTED OR Q2.2 IS SELECTED AND Q3.3 IS SELECTED THEN SELECT Q6.1",
  ];
  for (const expr of shapes) {
    const def = survey([{ expr }]);
    const target = def.questions.find((q) => q.id === "q6")!;
    const rule = target.punches![0];
    const printed = formatPunchExpression(def, target, rule);
    const again = parsePunchExpression(def, printed);
    assert.deepEqual(again.errors, [], `re-parsing its own printing failed: ${printed}`);
    assert.deepEqual(
      again.rules[0].rule.when, rule.when,
      `the tree changed on the round trip.\n  from: ${expr}\n  printed: ${printed}`,
    );
  }
});

/* ============================================ the visual builder's own moves */

test("the visual builder produces the same tree the expression does", () => {
  /*
   * Most nested conditions are not typed, they are clicked: add three
   * conditions, select two, "move to new group", set that group to OR. If
   * those moves produced a different tree from the equivalent text, the two
   * editors would disagree about the same rule — and only one of them would
   * match what the evaluator does.
   */
  const def = survey([]);
  const rule = (ref: string, value: string) =>
    ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value }) as Condition;

  let root = editableCondition(null);
  root = appendTo(root, [], rule("q1", "1"));
  root = appendTo(root, [], rule("q2", "2"));
  root = appendTo(root, [], rule("q2", "3"));
  const grouped = groupSelection(root, [[1], [2]], "and");
  assert.equal(grouped.ok, true, grouped.reason);
  root = setOperatorAt(grouped.root, grouped.groupPath!, "or");

  const built = canonicalCondition(root)!;
  const typed = parseLogicExpression(
    def, "Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED)",
  ).condition!;
  assert.deepEqual(built, typed, "clicked and typed must be the same rule");
  assert.equal(countGroups(root), 1, "exactly one bracket was created");
});

test("the connector control materialises precedence as real groups", () => {
  /*
   * Four conditions in one list with the third gap set to OR is
   * `(A AND B) OR (C AND D)` — the brief's Test 5 shape, built without
   * anybody pressing "group". The result must be a tree, not a list with a
   * remembered operator per gap: a list cannot be evaluated unambiguously,
   * which is the whole complaint.
   */
  let root = editableCondition(null);
  const rule = (ref: string, value: string) =>
    ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value }) as Condition;
  for (const [ref, v] of [["q1", "1"], ["q2", "2"], ["q4", "4"], ["q5", "5"]] as const) {
    root = appendTo(root, [], rule(ref, v));
  }
  const next = setGroupConnector(root, [], 1, "or");
  assert.equal(next.op, "or");
  assert.equal(next.children.length, 2);
  for (const child of next.children) {
    assert.equal(child.type, "group");
    assert.equal((child as { op: string }).op, "and");
    assert.equal((child as { children: Condition[] }).children.length, 2);
  }

  /* and it evaluates as the brackets say */
  const def = survey([]);
  const built = canonicalCondition(next)!;
  def.questions.find((q) => q.id === "q6")!.punches = [{
    id: "p1", source: { kind: "codes", codes: ["1"] }, action: "select",
    mapping: [], ignoreUnmatched: true, recompute: "always", when: built,
  }];
  assert.deepEqual(punched(def, { q1: ["1"], q2: ["2"] }), ["1"]);
  assert.deepEqual(punched(def, { q4: ["4"], q5: ["5"] }), ["1"]);
  assert.deepEqual(punched(def, { q1: ["1"], q5: ["5"] }), [], "not across the brackets");
});

/* ===================================================== ONE MEANING, EVERYWHERE */

test("PARITY: the same condition punches and shows for exactly the same respondents", () => {
  /*
   * §5 of the brief, as an assertion rather than an intention: "the same
   * logical condition should produce the same result throughout Rescript
   * Studio".
   *
   * One condition tree, two consumers — a punch rule on Q6 and Q6's own
   * display logic — over every combination of five yes/no answers. If Auto
   * Punch ever grows an evaluator of its own, or the shared one is changed
   * for one caller's benefit, this is the test that stops it: the two
   * columns below have to agree 32 times out of 32.
   */
  const EXPR =
    "Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED)"
    + " OR NOT (Q4.4 IS SELECTED OR Q5.5 IS SELECTED)";

  const forPunch = survey([]);
  const when = parseLogicExpression(forPunch, EXPR).condition!;
  forPunch.questions.find((q) => q.id === "q6")!.punches = [{
    id: "p1", source: { kind: "codes", codes: ["1"] }, action: "select",
    mapping: [], ignoreUnmatched: true, recompute: "always", when,
  }];

  const forDisplay = survey([]);
  forDisplay.questions.find((q) => q.id === "q6")!.displayLogic =
    parseLogicExpression(forDisplay, EXPR).condition!;

  const values: Record<string, string[]>[] = [];
  const cells: [string, string][] = [["q1", "1"], ["q2", "2"], ["q2", "3"], ["q4", "4"], ["q5", "5"]];
  for (let mask = 0; mask < 1 << cells.length; mask++) {
    const a: Record<string, string[]> = {};
    cells.forEach(([q, code], i) => {
      if (mask & (1 << i)) a[q] = [...(a[q] ?? []), code];
    });
    values.push(a);
  }

  let agreed = 0;
  let everTrue = 0;
  let everFalse = 0;
  for (const answers of values) {
    const didPunch = punched(forPunch, answers).includes("1");

    const state = createResponseState(forDisplay);
    start(forDisplay, state);
    for (const [qid, v] of Object.entries(answers)) setAnswer(forDisplay, state, qid, v);
    advance(forDisplay, state);
    const steps: RuntimeStep[] = compileFlow(forDisplay, state);
    const page2 = steps.find(
      (s): s is Extract<RuntimeStep, { kind: "page" }> =>
        s.kind === "page" && s.questionIds.includes("q6"),
    );
    const shown = page2
      ? visibleQuestions(forDisplay, page2, state).some((q) => q.id === "q6")
      : false;

    assert.equal(
      didPunch, shown,
      `the same condition disagreed with itself for ${JSON.stringify(answers)}: `
      + `punch=${didPunch}, display=${shown}`,
    );
    agreed += 1;
    if (didPunch) everTrue += 1; else everFalse += 1;
  }

  assert.equal(agreed, 32, "every combination was actually evaluated");
  /*
   * Without these two, a condition that is constantly true — or an evaluator
   * that answers `true` for everything, which is what a dropped tree looks
   * like — would satisfy the equality above perfectly.
   */
  assert.ok(everTrue > 0, "the condition was never true — the test proves nothing");
  assert.ok(everFalse > 0, "the condition was never false — the test proves nothing");
});

test("PARITY: a printed condition reads back the same for both consumers", () => {
  const def = survey([]);
  const EXPR = "Q1.1 IS SELECTED AND (Q2.2 IS SELECTED OR Q2.3 IS SELECTED)";
  const tree = parseLogicExpression(def, EXPR).condition!;
  const printed = formatCondition(def, tree);
  const reparsed = parseLogicExpression(def, printed).condition!;
  assert.deepEqual(reparsed, tree, `formatCondition → parseLogicExpression is not identity: ${printed}`);
});
