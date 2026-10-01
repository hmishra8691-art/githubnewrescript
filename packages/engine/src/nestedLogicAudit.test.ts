import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, isEmptyConditionTree, optionLogicHasEffect, type Condition, type Question } from "@rescript/schema";
import {
  createResponseState, evaluateCondition, conditionFires, isVacuousCondition,
  parseLogicExpression, formatCondition, conditionSummary,
  constantCondition, constantValueOf, stripVacuous, conditionDepth, MAX_CONDITION_DEPTH,
  start, advance, setAnswer, compileFlow, recomputePunchesAfterChange, visibleQuestions,
  parsePunchExpression, formatPunchExpression, optionRule, simpleView, applyParsedPunch,
  lintQuestionLogic, effectiveQuestion, rowHoldsColumn, unresolvableDisplayRules,
  applySurveyActions, validateQuestion, pruneReferencesTo, diagnoseQuestion,
  resolveLoopItems, nextProbe, pickAdaptive,
  type EvalContext, type RuntimeStep,
} from "./index.js";

/*
 * NESTED LOGIC — THE AUDIT'S ACCEPTANCE SUITE (2026-10-01).
 *
 * One survey, one evaluator, every place a condition is read. Each test names
 * the scenario from the brief (S1–S20) or the spreadsheet row it settles
 * (29-09 #n, Oweas #n, Prince n). Where a test pins a FIX, the comment says
 * what the engine did before.
 */

const opts = (n: number, label = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${label} ${i + 1}` }));
const Q = (id: string, code: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, code, variableName: code, type, text: `${code}?`, ...extra });

function survey(over: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "NL", title: "Nested logic", version: "1.0" },
    questions: [
      Q("q1", "Q1", "single_select", { options: opts(3) }),
      Q("q2", "Q2", "multi_select", { options: opts(4) }),
      Q("q3", "Q3", "numeric"),
      Q("q4", "Q4", "composite", { variant: "matrix.numeric",
        rows: [{ code: "R1", label: "Item 1" }, { code: "R2", label: "Item 2" }],
        columns: [
          { id: "c1", label: "Now", responseType: "numeric", variableStem: "Q4A" },
          { id: "c2", label: "Later", responseType: "numeric", variableStem: "Q4B" },
        ],
      }),
      Q("q5", "Q5", "allocation", { options: opts(3, "Brand") }),
      Q("q6", "Q6", "matrix_single", {
        rows: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }],
        options: [{ code: 1, label: "Aware" }, { code: 2, label: "Used" }, { code: 3, label: "Never heard" }],
      }),
      Q("q7", "Q7", "multi_select", { options: opts(3, "Target") }),
      Q("q8", "Q8", "hidden", { options: [{ code: 1, label: "Low" }, { code: 2, label: "Medium" }, { code: 3, label: "High" }] }),
      Q("q9", "Q9", "hidden", { options: [{ code: 1, label: "Not high" }, { code: 2, label: "High band" }] }),
      Q("q10", "Q10", "single_select", { options: opts(3) }),
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "page", id: "p2", questionIds: ["q4", "q5", "q6"] },
      { type: "page", id: "p3", questionIds: ["q7", "q8", "q9", "q10"] },
      { type: "end", id: "e", status: "complete" },
    ],
    ...over,
  });
}

const ctxWith = (answers: Record<string, unknown>, def = survey()): EvalContext => {
  const state = createResponseState(def, { seed: 7 });
  Object.assign(state.answers, answers);
  return { def, state, loop: null };
};
const parse = (text: string, def = survey()): Condition => {
  const r = parseLogicExpression(def, text);
  assert.deepEqual(r.errors, [], `“${text}” parses`);
  return r.condition!;
};
const holds = (text: string, answers: Record<string, unknown>) => {
  const ctx = ctxWith(answers);
  return evaluateCondition(parse(text, ctx.def), ctx);
};
const group = (op: "and" | "or" | "not", children: Condition[]) => ({ type: "group", op, children }) as Condition;
const EMPTY = group("and", []);
/** print → parse → print: the text is an identity of the tree */
const roundTrips = (text: string) => {
  const def = survey();
  const once = parse(text, def);
  const printed = formatCondition(def, once);
  const twice = parse(printed, def);
  assert.deepEqual(twice, once, `“${text}” → “${printed}” re-parses to the same tree`);
  return printed;
};

/* ======================================================= S1–S9: structure */

test("S1 single condition — true and false (S13, S14)", () => {
  assert.equal(holds("Q1 = 1", { q1: 1 }), true);
  assert.equal(holds("Q1 = 1", { q1: 2 }), false);
  assert.equal(holds("Q3 >= 18", { q3: 18 }), true);
  assert.equal(holds("Q3 >= 18", { q3: 17 }), false);
});

test("S2 multiple AND — every child must hold", () => {
  const t = "Q1 = 1 AND Q3 > 5 AND Q2.2";
  assert.equal(holds(t, { q1: 1, q3: 6, q2: [2] }), true);
  for (const miss of [{ q1: 2, q3: 6, q2: [2] }, { q1: 1, q3: 5, q2: [2] }, { q1: 1, q3: 6, q2: [1] }]) assert.equal(holds(t, miss), false);
});

test("S3 multiple OR — any child", () => {
  const t = "Q1 = 1 OR Q3 > 5 OR Q2.4";
  assert.equal(holds(t, { q1: 3, q3: 1, q2: [4] }), true);
  assert.equal(holds(t, { q1: 3, q3: 1, q2: [1] }), false);
});

test("S4 NOR / NOT — a multi-child NOT is “none of”", () => {
  const nor = group("not", [parse("Q1 = 1"), parse("Q1 = 2")]);
  assert.equal(evaluateCondition(nor, ctxWith({ q1: 3 })), true);
  assert.equal(evaluateCondition(nor, ctxWith({ q1: 2 })), false);
  assert.equal(holds("NOT (Q1 = 1 OR Q1 = 2)", { q1: 3 }), true);
  assert.equal(holds("!(Q1 = 1 || Q1 = 2)", { q1: 1 }), false, "the symbol spellings mean the same");
  assert.match(conditionSummary(survey(), nor), /none of|NOT|not/i);
});

test("S5 AND inside OR, S6 OR inside AND — brackets are kept", () => {
  const andInOr = "(Q1 = 1 AND Q3 > 5) OR (Q1 = 2 AND Q3 < 5)";
  assert.equal(holds(andInOr, { q1: 2, q3: 1 }), true);
  assert.equal(holds(andInOr, { q1: 2, q3: 9 }), false);
  const orInAnd = "(Q1 = 1 OR Q1 = 2) AND (Q2.1 OR Q2.3)";
  assert.equal(holds(orInAnd, { q1: 2, q2: [3] }), true);
  assert.equal(holds(orInAnd, { q1: 3, q2: [3] }), false);
  roundTrips(andInOr);
  roundTrips(orInAnd);
});

test("S7 / S8 multiple and deep nesting — evaluated and printed exactly", () => {
  const three = "Q1 = 1 AND (Q2.1 OR (Q3 > 10 AND NOT (Q2.4 OR Q3 = 50)))";
  assert.equal(holds(three, { q1: 1, q2: [4], q3: 20 }), false, "the innermost NOT bites");
  assert.equal(holds(three, { q1: 1, q2: [2], q3: 20 }), true);
  roundTrips(three);

  /* 40 alternating levels: deeper than anyone writes, inside every limit */
  let deep = "Q1 = 1";
  for (let i = 0; i < 40; i++) deep = i % 2 ? `(${deep} OR Q3 = ${1000 + i})` : `(${deep} AND Q3 >= 0)`;
  const c = parse(deep);
  assert.ok(conditionDepth(c) >= 40);
  assert.equal(evaluateCondition(c, ctxWith({ q1: 1, q3: 5 })), true);
  assert.equal(evaluateCondition(c, ctxWith({ q1: 2, q3: 5 })), false);
  roundTrips(deep);
});

test("S8 depth limits — the parser refuses runaway text, the evaluator stops past its limit, lint says why", () => {
  const silly = `${"(".repeat(70)}Q1 = 1${")".repeat(70)}`;
  assert.ok(parseLogicExpression(survey(), silly).errors.length, "70 brackets is refused, not a stack overflow");
  let tree: Condition = parse("Q1 = 1");
  for (let i = 0; i < MAX_CONDITION_DEPTH + 5; i++) tree = group("and", [tree]);
  assert.equal(evaluateCondition(tree, ctxWith({ q1: 1 })), false, "past the limit it fails closed");
  const def = survey();
  def.questions[1].displayLogic = tree;
  assert.ok(lintQuestionLogic(def, def.questions[1]).some((i) => i.level === "error" && /nests/.test(i.message)));
  let ten: Condition = parse("Q1 = 1");
  for (let i = 0; i < 10; i++) ten = group(i % 2 ? "or" : "and", [ten, parse("Q3 > 1")]);
  def.questions[1].displayLogic = ten;
  assert.ok(lintQuestionLogic(def, def.questions[1]).some((i) => i.level === "warning" && /levels deep/.test(i.message)));
});

test("S9 mixed operators at different levels", () => {
  const t = "(Q3 between 10 and 20 OR Q3 in [50, 60]) AND NOT Q2 contains any [3, 4] AND Q1 != 3";
  assert.equal(holds(t, { q3: 15, q2: [1], q1: 1 }), true);
  assert.equal(holds(t, { q3: 60, q2: [1], q1: 1 }), true);
  assert.equal(holds(t, { q3: 60, q2: [4], q1: 1 }), false);
  assert.equal(holds(t, { q3: 60, q2: [1], q1: 3 }), false);
});

/* ============================================ S10–S12: what a rule reads */

test("S10 question → row → column, and Oweas #7: a numeric grid row with ANY column", () => {
  const cells = { q4: { R1: { c1: 10, c2: 30 }, R2: { c1: 1, c2: 2 } } };
  assert.equal(holds("Q4.R1.c2 > 23", cells), true, "one named cell");
  assert.equal(holds("Q4.R1.c1 > 23", cells), false);
  /* before: the row read an OBJECT and `{…} > 23` was false for every respondent */
  assert.equal(holds("Q4.R1 > 23", cells), true, "row 1, any column");
  assert.equal(holds("Q4.R2 > 23", cells), false);
  assert.equal(holds("NOT (Q4.R1 > 23)", cells), false, "negating the any-column read is “no column”");
  /* a single-response grid: row Beta was “Used” */
  assert.equal(holds("Q6.2 = 2", { q6: { 1: 1, 2: 2 } }), true);
  assert.equal(holds("Q6.2 = 1", { q6: { 1: 1, 2: 2 } }), false);
});

test("Prince 44: constant sum per-option amounts — `Q5.1 < 6 OR Q5.2 > 6`", () => {
  /* before: `Q5.1` lost its option and compared the whole allocation map */
  const c = parse("Q5.1 < 6 OR Q5.2 > 6");
  assert.deepEqual((c as { children: { source: { rowCode?: string } }[] }).children.map((k) => k.source.rowCode), ["1", "2"]);
  assert.equal(evaluateCondition(c, ctxWith({ q5: { 1: 8, 2: 9, 3: 0 } })), true, "Brand 2 > 6");
  assert.equal(evaluateCondition(c, ctxWith({ q5: { 1: 8, 2: 2, 3: 0 } })), false);
  assert.equal(evaluateCondition(c, ctxWith({ q5: { 1: 5, 2: 2, 3: 0 } })), true, "Brand 1 < 6");
  const printed = roundTrips("Q5.1 < 6 OR Q5.2 > 6");
  assert.match(printed, /Q5\.O1 < 6 OR Q5\.O2 > 6/);
  assert.match(conditionSummary(survey(), c), /Brand 1/);
  roundTrips("Q5.1 > Q5.2");
});

test("S11 several questions in one nested condition", () => {
  const t = "(Q1 = 1 OR Q2.3) AND (Q3 > 5 OR Q4.R1.c1 > 5) AND NOT Q6.1 = 3";
  assert.equal(holds(t, { q1: 2, q2: [3], q3: 1, q4: { R1: { c1: 9 } }, q6: { 1: 1 } }), true);
  assert.equal(holds(t, { q1: 2, q2: [3], q3: 1, q4: { R1: { c1: 9 } }, q6: { 1: 3 } }), false);
});

test("S12 previous responses on the right-hand side", () => {
  assert.equal(holds("Q3 > Q4.R1.c1", { q3: 10, q4: { R1: { c1: 4 } } }), true);
  assert.equal(holds("Q3 > Q4.R1.c1", { q3: 1, q4: { R1: { c1: 4 } } }), false);
  assert.equal(holds("Q3 >= COUNT(Q2)", { q3: 2, q2: [1, 4] }), true);
  assert.equal(holds("Q3 >= COUNT(Q2)", { q3: 1, q2: [1, 4] }), false);
  roundTrips("Q3 > Q4.R1.c1 AND Q3 >= COUNT(Q2)");
});

test("COUNT where: the counted items carry their own condition", () => {
  const t = "COUNT(Q2, where (@option.code in [1, 2])) >= 2";
  assert.equal(holds(t, { q2: [1, 2, 4] }), true);
  assert.equal(holds(t, { q2: [1, 3, 4] }), false);
  roundTrips(t);
});

/* ============================== S15–S16: empty, missing, invalid, unresolved */

test("S15 empty / null / missing values fail closed; an empty group constrains nothing", () => {
  assert.equal(holds("Q3 > 5", {}), false, "unanswered is not > 5");
  assert.equal(holds("Q3 <= 5", {}), false, "…nor <= 5");
  assert.equal(holds("NOT (Q3 > 5)", {}), true);
  assert.equal(holds("Q3 unanswered", { q3: null }), true);
  assert.equal(holds("Q2 answered", { q2: [] }), false, "an empty selection is no answer");
  assert.equal(holds("Q4.R1 > 23", { q4: {} }), false, "a grid with no cells");
  for (const v of [EMPTY, group("or", []), group("not", [EMPTY]), group("and", [group("or", [])])]) {
    assert.equal(isVacuousCondition(v), true);
    assert.equal(evaluateCondition(v, ctxWith({})), true, "as a GATE: no constraint");
    assert.equal(conditionFires(v, ctxWith({})), false, "as a TRIGGER: not configured");
  }
  assert.equal(conditionFires(parse("Q1 = 1"), ctxWith({ q1: 1 })), true);
});

test("S16 invalid or unresolved references are refused, read as false, linted, and pruned on delete", () => {
  assert.ok(parseLogicExpression(survey(), "Q99 = 1").errors.length);
  assert.ok(parseLogicExpression(survey(), "Q4.R9 > 1").errors.length, "a row that does not exist");
  const ghost = { type: "rule", source: { kind: "question", ref: "q_gone" }, operator: "eq", value: 1 } as Condition;
  assert.equal(evaluateCondition(ghost, ctxWith({})), false);
  const def = survey();
  def.questions[9].displayLogic = group("and", [parse("Q1 = 1", def), ghost]);
  assert.ok(lintQuestionLogic(def, def.questions[9]).some((i) => i.level === "error"));
  /* deleting Q1: its rule leaves the AND, the rest is kept and the change is reported */
  const d2 = survey();
  d2.questions[9].displayLogic = parse("Q1 = 1 AND Q3 > 5", d2);
  const notes = pruneReferencesTo(d2, "q1");
  assert.ok(notes.length >= 1);
  assert.deepEqual(d2.questions[9].displayLogic && formatCondition(d2, d2.questions[9].displayLogic), "Q3 > 5");
});

/* ============================== S17–S19: rules together, cascades, the flow */

test("S17 several rules on the same question — first skip wins, HIDE beats SHOW", () => {
  const def = survey();
  def.questions[0].skipLogic = [
    { id: "s1", when: parse("Q1 = 1 AND (Q2.1 OR Q2.2)", def), target: { kind: "question", ref: "q10" } },
    { id: "s2", when: parse("Q1 = 1", def), target: { kind: "end" } },
  ] as never;
  const state = createResponseState(def, { seed: 1 });
  start(def, state);
  setAnswer(def, state, "q1", 1); setAnswer(def, state, "q2", [2]);
  const r = advance(def, state);
  assert.deepEqual(r.triggeredSkips.map((s) => s.ruleId), ["s1"]);
  const page = r.steps[r.stepIndex] as Extract<RuntimeStep, { kind: "page" }>;
  assert.ok(page.questionIds.includes("q10"));

  const d2 = survey({ displayRules: [
    { id: "show", action: "show", target: { kind: "question", ref: "q10" }, when: parse("Q1 = 1") },
    { id: "hide", action: "hide", target: { kind: "question", ref: "q10" }, when: parse("Q1 = 1 AND Q3 > 5") },
  ] });
  const st = createResponseState(d2, { seed: 1 });
  Object.assign(st.answers, { q1: 1, q3: 9 });
  const p3 = compileFlow(d2, st).find((s) => s.kind === "page" && s.pageId === "p3") as Extract<RuntimeStep, { kind: "page" }>;
  assert.ok(!visibleQuestions(d2, p3, st).some((q) => q.id === "q10"), "the HIDE rule wins");
});

test("S18 cascading punches: a numeric open end → a hidden single select → another hidden question, on one page (Prince 66)", () => {
  const def = survey();
  const q8 = def.questions.find((q) => q.id === "q8")!;
  const q9 = def.questions.find((q) => q.id === "q9")!;
  /* the punch reads a NUMERIC source — offered by the editor now, evaluated as a value test */
  q8.punches = [
    optionRule({ sourceQuestionId: "q3", sourceCode: "", test: "between", value: 0, value2: 3, action: "select", targetCodes: [1] }, "p_low"),
    { ...optionRule({ sourceQuestionId: "q3", sourceCode: "", test: "between", value: 4, value2: 7, action: "select", targetCodes: [2] }, "p_mid"), mode: "else_if" },
    { ...optionRule({ sourceQuestionId: "q3", sourceCode: "", test: "gt", value: 7, action: "select", targetCodes: [3] }, "p_high"), mode: "else_if" },
  ];
  q9.punches = [optionRule({ sourceQuestionId: "q8", sourceCode: 3, test: "selected", action: "select", targetCodes: [2] }, "p_band")];
  /* Q3, Q8 and Q9 on one page */
  def.flow = [{ type: "page", id: "p1", questionIds: ["q3", "q8", "q9"] }, { type: "end", id: "e", status: "complete" }] as never;
  const state = createResponseState(def, { seed: 1 });
  const ctx: EvalContext = { def, state, loop: null };
  const pageQs = ["q3", "q8", "q9"].map((id) => def.questions.find((q) => q.id === id)!) as Question[];
  setAnswer(def, state, "q3", 9);
  recomputePunchesAfterChange(def, state, "q3", pageQs, ctx);
  assert.deepEqual(state.answers.q8, 3, "Q8 = High");
  assert.deepEqual(state.answers.q9, 2, "…and Q9, which reads Q8, follows in the same change");
  setAnswer(def, state, "q3", 5);
  recomputePunchesAfterChange(def, state, "q3", pageQs, ctx);
  assert.deepEqual(state.answers.q8, 2, "the ELSE IF chain takes the middle band only");
  assert.equal(state.answers.q9, undefined, "Q9 is taken back — before: it kept “High band” after Q3 changed to 5");
  setAnswer(def, state, "q3", 20);
  recomputePunchesAfterChange(def, state, "q3", pageQs, ctx);
  assert.deepEqual([state.answers.q8, state.answers.q9], [3, 2], "and given again");
  /* the simple editor reads a value test back, and its text prints the chain */
  assert.equal(simpleView(q8.punches[1])?.test, "between");
  assert.match(formatPunchExpression(def, q8, q8.punches[1]), /^ELSE IF Q3 between 4 and 7 THEN SELECT Q8\.(2|Medium)/);
});

test("S19 nested logic through display, skip and branch in one run", () => {
  const def = survey({
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "branch", id: "br", branches: [
        { id: "a", when: parse("(Q1 = 1 OR Q1 = 2) AND NOT Q2.4"), children: [{ type: "page", id: "p2", questionIds: ["q4", "q5"] }] },
        { id: "b", when: parse("Q3 > 50 AND (Q2.1 OR Q2.2)"), children: [{ type: "page", id: "p3", questionIds: ["q7"] }] },
      ], otherwise: [{ type: "page", id: "p4", questionIds: ["q6"] }] },
      { type: "page", id: "p5", questionIds: ["q10"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  def.questions.find((q) => q.id === "q10")!.displayLogic = parse("Q1 = 3 OR (Q3 > 10 AND NOT Q2.4)", def);
  const pagesFor = (answers: Record<string, unknown>) => {
    const st = createResponseState(def, { seed: 1 });
    Object.assign(st.answers, answers);
    return compileFlow(def, st).filter((s): s is Extract<RuntimeStep, { kind: "page" }> => s.kind === "page").map((s) => s.pageId);
  };
  assert.deepEqual(pagesFor({ q1: 1, q2: [1], q3: 5 }), ["p1", "p2", "p5"]);
  assert.deepEqual(pagesFor({ q1: 1, q2: [4], q3: 60 }), ["p1", "p4", "p5"], "arm a fails on NOT Q2.4; arm b needs Q2.1 or Q2.2");
  assert.deepEqual(pagesFor({ q1: 3, q2: [2], q3: 60 }), ["p1", "p3", "p5"]);
});

/* ================================================= spreadsheet rows, one by one */

test("29-09 #3: auto punch on nested AND / OR / NOT of the same multi-select — and “BUT NOT”", () => {
  const def = survey();
  const r = parsePunchExpression(def, "IF Q2.1 AND Q2.2 THEN SELECT Q7.1");
  assert.deepEqual(r.errors, []);
  const butNot = parsePunchExpression(def, "IF Q2.1 BUT NOT Q2.2 THEN SELECT Q7.2");
  assert.deepEqual(butNot.errors, [], "“BUT NOT” is AND NOT in the expression box too");
  const not = parsePunchExpression(def, "IF NOT Q2.1 THEN SELECT Q7.3");
  const rules = [r, butNot, not].map((x) => x.rules[0].rule);
  const fired = (q2: unknown[]) => rules.filter((rule) => evaluateCondition(rule.when, ctxWith({ q2 }))).map((x) => x.source.kind === "codes" ? x.source.codes[0] : null);
  assert.deepEqual(fired([1, 2]), [1]);
  assert.deepEqual(fired([1]), [2]);
  assert.deepEqual(fired([3]), [3]);
});

test("Oweas #5: an ELSE IF rule prints as ELSE IF, and editing its text keeps the rule's own settings", () => {
  const def = survey();
  const q7 = def.questions.find((q) => q.id === "q7")!;
  const base = { ...optionRule({ sourceQuestionId: "q1", sourceCode: 3, test: "selected", action: "select", targetCodes: [3] }, "r2"), mode: "else_if" as const, recompute: "once" as const, label: "third" };
  assert.match(formatPunchExpression(def, q7, base), /^ELSE IF /);
  const typed = parsePunchExpression(def, "ELSE IF Q1 = 2 AND Q2.1 THEN SELECT Q7.2").rules[0].rule;
  const next = applyParsedPunch(base, typed);
  assert.equal(next.id, "r2");
  assert.equal(next.mode, "else_if");
  assert.equal(next.recompute, "once", "before: replaced by the parse result's default “always”");
  assert.equal(next.label, "third");
  assert.deepEqual(next.source, { kind: "codes", codes: [2] });
  const asIf = applyParsedPunch(base, parsePunchExpression(def, "IF Q1 = 2 THEN SELECT Q7.2").rules[0].rule);
  assert.equal(asIf.mode, undefined, "typing IF makes it an IF again");
  /* simple-mode edits keep the chain position too */
  assert.equal(optionRule(simpleView(base)!, base.id, base).mode, "else_if");
});

test("Oweas #4: the option “logic” marker counts only logic that does something", () => {
  assert.equal(optionLogicHasEffect(undefined), false);
  assert.equal(optionLogicHasEffect({ visibility: "hide_when", when: EMPTY } as never), false, "an unfinished Hide when");
  assert.equal(optionLogicHasEffect({ visibility: "default", when: parse("Q1 = 1") } as never), false, "a condition no mode reads");
  assert.equal(optionLogicHasEffect({ visibility: "hide_when", when: parse("Q1 = 1") } as never), true);
  assert.equal(optionLogicHasEffect({ visibility: "always_hide" } as never), true);
  assert.equal(optionLogicHasEffect({ visibility: "default", excludeWhen: group("or", []) } as never), false);
  assert.equal(isEmptyConditionTree(group("not", [EMPTY])), true);
});

test("an EMPTY trigger never fires — hide when, exclude when, move to top (before: the option vanished for everyone)", () => {
  const def = survey();
  const q10 = def.questions.find((q) => q.id === "q10")!;
  /* option 1 carries a REAL (false) ordering rule, so the ordering stage runs at all */
  q10.options[0].logic = { visibility: "hide_when", when: EMPTY, deprioritizeWhen: parse("Q1 = 3", def) } as never;
  q10.options[1].logic = { visibility: "default", excludeWhen: group("not", [EMPTY]) } as never;
  q10.options[2].logic = { visibility: "default", prioritizeWhen: EMPTY } as never;
  const view = effectiveQuestion(q10, ctxWith({}, def));
  assert.deepEqual(view.options.map((o) => o.code), [1, 2, 3]);
  /* and the same rules, configured, do act */
  q10.options[0].logic = { visibility: "hide_when", when: parse("Q1 = 1", def) } as never;
  q10.options[2].logic = { visibility: "default", prioritizeWhen: parse("Q1 = 1", def) } as never;
  assert.deepEqual(effectiveQuestion(q10, ctxWith({ q1: 1 }, def)).options.map((o) => o.code), [3, 2]);
  /* lint: an empty Hide when is reported like a missing one */
  q10.options[0].logic = { visibility: "hide_when", when: EMPTY } as never;
  assert.ok(lintQuestionLogic(def, q10).some((i) => /Hide when” has no condition/.test(i.message)));
});

test("a condition validation with an empty check does not block everyone; an “only when” gate is honoured", () => {
  const def = survey(); const q3Def = def;
  const q3 = def.questions.find((q) => q.id === "q3")!;
  q3.validation = [{ id: "v1", kind: "condition", check: EMPTY }] as never;
  assert.deepEqual(validateQuestion(q3Def, q3, 5, ctxWith({ q3: 5 }, def)).length, 0, "before: “Invalid answer.” for every respondent");
  q3.validation = [{ id: "v2", kind: "condition", check: parse("Q3 > 10 AND Q1 = 1", def), when: parse("Q1 != 3", def) }] as never;
  assert.ok(validateQuestion(q3Def, q3, 12, ctxWith({ q3: 12, q1: 1 }, def)).length > 0, "invalid when the check holds");
  assert.equal(validateQuestion(q3Def, q3, 12, ctxWith({ q3: 12, q1: 3 }, def)).length, 0, "…unless the gate is closed");
});

test("an unconditional skip rule is still an unconditional skip — and it is now flagged", () => {
  const def = survey();
  def.questions[0].skipLogic = [{ id: "s", when: EMPTY, target: { kind: "end" } }] as never;
  const issues = lintQuestionLogic(def, def.questions[0]);
  assert.ok(issues.some((i) => /has no condition, so it sends EVERY respondent to the end/.test(i.message)));
  assert.equal(diagnoseQuestion(def, "q10")!.verdict, "never", "backward compatible: it still skips");
  /* a HIDE display rule with no condition is reported too */
  const d2 = survey({ displayRules: [{ id: "h", action: "hide", target: { kind: "question", ref: "q10" }, when: EMPTY }] });
  assert.ok(unresolvableDisplayRules(d2).some((d) => /no condition/.test(d.reason)));
});

test("imported constants are real constants: TRUE = 1 = 1, FALSE = 0 = 1 (before: FALSE became NOT(empty), which is TRUE)", () => {
  const t = constantCondition(true); const f = constantCondition(false);
  assert.equal(evaluateCondition(t, ctxWith({})), true);
  assert.equal(evaluateCondition(f, ctxWith({})), false);
  assert.equal(conditionFires(t, ctxWith({})), true, "an imported ALWAYS skip still fires");
  assert.equal(constantValueOf(t), true); assert.equal(constantValueOf(f), false);
  assert.equal(conditionSummary(survey(), f), "never");
  const def = survey();
  assert.deepEqual(parse(formatCondition(def, f), def), f, "prints and re-parses");
  assert.equal(stripVacuous(f), f);
});

/* ======================================= carry forward: 29-09 #5, #6, Oweas 1–3, 6 */

test("29-09 #5 / #6: a grid source carries ROWS — displayed rows, and only the rows where a column was chosen", () => {
  const def = survey();
  const q10 = def.questions.find((q) => q.id === "q10")!;
  const q6 = def.questions.find((q) => q.id === "q6")!;
  q6.rows[2].visibleIf = parse("Q1 = 1", def);
  q10.options = [];
  q10.carryForward = { sourceQuestionId: "q6", filter: "displayed", into: "options", keepOwn: false } as never;
  /* before: “displayed” of a grid was its SCALE (Aware / Used / Never heard) */
  let view = effectiveQuestion(q10, ctxWith({ q1: 2 }, def));
  assert.deepEqual(view.options.map((o) => o.label), ["Alpha", "Beta"], "the rows Q6 showed, with the ROWS' labels");
  view = effectiveQuestion(q10, ctxWith({ q1: 1 }, def));
  assert.deepEqual(view.options.map((o) => o.label), ["Alpha", "Beta", "Gamma"]);
  /* the brands marked Used (scale 2) in Q6 */
  q10.carryForward = { sourceQuestionId: "q6", filter: "answered_rows", into: "options", keepOwn: false, columns: [2] } as never;
  view = effectiveQuestion(q10, ctxWith({ q6: { 1: 1, 2: 2, 3: 2 } }, def));
  assert.deepEqual(view.options.map((o) => String(o.code)), ["2", "3"]);
  /* before: a row code equal to a scale code took the SCALE label */
  q10.carryForward = { sourceQuestionId: "q6", filter: "selected", into: "options", keepOwn: false } as never;
  assert.deepEqual(effectiveQuestion(q10, ctxWith({ q6: { 1: 3 } }, def)).options.map((o) => o.label), ["Alpha"]);
  assert.equal(rowHoldsColumn([1, 3], [3]), true);
  assert.equal(rowHoldsColumn({ used: true }, ["used"]), true);
  assert.equal(rowHoldsColumn({ used: false }, ["used"]), false);
  assert.equal(rowHoldsColumn(2, [1]), false);
});

/* ======================================= flow elements that now take a condition */

test("randomizer, quota check and embedded field each honour their own condition; “show N” picks only eligible children", () => {
  const def = survey({
    quotas: [{ id: "qt", name: "All", mode: "hard", cells: [{ id: "c", label: "all", when: EMPTY, limit: 0 }], onFull: { kind: "terminate" } }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "embedded_data", id: "ed", fields: [{ name: "SEG", source: "static", value: "A", when: parse("Q1 = 1 AND NOT Q2.4") }] },
      { type: "randomizer", id: "rz", show: 1, visibleIf: parse("Q3 > 0"), children: [
        { type: "page", id: "pa", questionIds: ["q4"], visibleIf: parse("Q3 > 1000") },
        { type: "page", id: "pb", questionIds: ["q5"] },
      ] },
      { type: "quota_check", id: "qc", quotaIds: ["qt"], onFull: { kind: "terminate" }, when: parse("Q1 = 3") },
      { type: "page", id: "p9", questionIds: ["q10"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const st = createResponseState(def, { seed: 3 });
  Object.assign(st.answers, { q1: 1, q2: [1], q3: 5 });
  const steps = compileFlow(def, st);
  const pages = steps.filter((s): s is Extract<RuntimeStep, { kind: "page" }> => s.kind === "page").map((s) => s.pageId);
  assert.deepEqual(pages, ["p1", "pb", "p9"], "“show 1 of 2” draws from the eligible page only");
  assert.ok(!steps.some((s) => s.kind === "quota_check"), "the check is skipped while Q1 != 3");
  st.answers.q3 = 0;
  assert.ok(!compileFlow(def, st).some((s) => s.kind === "page" && s.pageId === "pb"), "the randomizer as a whole is gated");
  /* the embedded field is set only when its condition holds */
  const run = (answers: Record<string, unknown>) => {
    const s2 = createResponseState(def, { seed: 3 });
    start(def, s2);
    for (const [k, v] of Object.entries(answers)) setAnswer(def, s2, k, v);
    advance(def, s2);
    return s2.embedded?.SEG;
  };
  assert.equal(run({ q1: 1, q2: [1], q3: 5 }), "A");
  assert.notEqual(run({ q1: 1, q2: [4], q3: 5 }), "A");
});

/* =================================================== copilot: structured input */

test("the Copilot may write a condition as a tree, a conditional validation, and a branch with arms", () => {
  const tree = { type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: 1 },
    { type: "group", op: "or", children: [
      { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "selected", value: 2 },
      { type: "rule", source: { kind: "question", ref: "Q3" }, operator: "gt", value: 10 },
    ] },
  ] };
  const r = applySurveyActions(survey(), [
    { op: "set_display_logic", target: "Q10", expression: tree as never },
    { op: "set_validation", target: "Q3", rules: [{ kind: "condition", check: "Q3 <= 100", when: "Q1 = 1" }] },
  ]);
  assert.deepEqual(r.errors, []);
  const q10 = r.def.questions.find((q) => q.code === "Q10")!;
  assert.equal(evaluateCondition(q10.displayLogic, ctxWith({ q1: 1, q3: 11 }, r.def)), true);
  assert.equal(evaluateCondition(q10.displayLogic, ctxWith({ q1: 1, q3: 5 }, r.def)), false);
  const q3 = r.def.questions.find((q) => q.code === "Q3")!; const q3Def = r.def;
  assert.equal(validateQuestion(q3Def, q3, 50, ctxWith({ q3: 50, q1: 1 }, r.def)).length, 0, "“check” is what a VALID answer satisfies");
  assert.ok(validateQuestion(q3Def, q3, 500, ctxWith({ q3: 500, q1: 1 }, r.def)).length > 0);
  assert.equal(validateQuestion(q3Def, q3, 500, ctxWith({ q3: 500, q1: 2 }, r.def)).length, 0, "the gate");
  /* a new question's conditional rule is no longer dropped */
  const c = applySurveyActions(survey(), [{ op: "create_question", ref: "KIDS", type: "numeric", text: "How many?", validation: [{ kind: "max_value", value: 10, when: "Q1 = 1" }] }]);
  const kids = c.def.questions.find((q) => q.variableName === "KIDS")!;
  assert.ok(kids.validation[0].when, "before: shapeQuestion kept kind and value only");
});

/* ============================================= S20: save / reload / serialization */

test("S20 every condition-bearing field survives JSON → schema → JSON unchanged", () => {
  const def = survey({
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "randomizer", id: "rz", visibleIf: parse("Q1 = 1"), children: [{ type: "page", id: "p2", questionIds: ["q4"] }] },
      { type: "embedded_data", id: "ed", fields: [{ name: "X", source: "static", value: "1", when: parse("Q2.1 BUT NOT Q2.2") }] },
      { type: "quota_check", id: "qc", quotaIds: [], onFull: { kind: "flag" }, when: parse("NOT (Q3 > 5 OR Q1 = 2)") },
      { type: "page", id: "p3", questionIds: ["q5", "q6", "q7", "q8", "q9", "q10"] },
      { type: "end", id: "e", status: "complete" },
    ],
    scripts: [{ id: "sc", name: "s", scope: "survey", event: "on_load", code: "1", enabled: true, when: parse("Q5.1 < 6 OR Q5.2 > 6") }],
  });
  def.questions[9].carryForward = { sourceQuestionId: "q6", filter: "displayed", into: "options", keepOwn: false, columns: [2], where: parse("Q1 = 1") } as never;
  def.questions[9].displayLogic = parse("(Q4.R1 > 23 OR COUNT(Q2, where (@option.code in [1, 2])) >= 2) AND Q3 >= COUNT(Q2)", def);
  const json = JSON.stringify(def);
  const again = SurveyDefinition.parse(JSON.parse(json));
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(json), "nothing dropped, nothing added");
  /* and the reloaded tree still means the same thing */
  const answers = { q4: { R1: { c1: 30 } }, q2: [1], q3: 3 };
  assert.equal(evaluateCondition(again.questions[9].displayLogic, ctxWith(answers, again)), evaluateCondition(def.questions[9].displayLogic, ctxWith(answers, def)));
});

test("S20 backward compatibility: a survey written before this pass evaluates as it did", () => {
  /* the stored shapes the earlier engine wrote — no new fields — still parse and run */
  const legacy = survey();
  legacy.questions[9].displayLogic = { type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 },
    { type: "group", op: "not", children: [{ type: "rule", source: { kind: "question", ref: "q2" }, operator: "selected", value: 4 }] },
  ] } as Condition;
  legacy.questions[9].skipLogic = [{ id: "s", when: { type: "rule", source: { kind: "question", ref: "q3" }, operator: "gt", value: 5 } as Condition, target: { kind: "end" } }] as never;
  const re = SurveyDefinition.parse(JSON.parse(JSON.stringify(legacy)));
  assert.equal(evaluateCondition(re.questions[9].displayLogic, ctxWith({ q1: 1, q2: [1] }, re)), true);
  assert.equal(evaluateCondition(re.questions[9].displayLogic, ctxWith({ q1: 1, q2: [4] }, re)), false);
  /* a cell read named in full is unchanged by the any-cell reading */
  assert.equal(holds("Q4.R1.c1 > 5", { q4: { R1: { c1: 6, c2: 0 } } }), true);
});

/* ============================================ loops, probes, adaptive: the other triggers */

test("loop skipIf / breakIf / invalidIf: an EMPTY one is unset (before: every item skipped, or the loop stopped after one)", () => {
  const build = (extra: Record<string, unknown>) => SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "loops", version: "1.0" },
    questions: [Q("q1", "Q1", "multi_select", { options: opts(3) }), Q("q7", "Q7", "numeric")],
    flow: [
      { type: "loop", id: "L1", loopVar: "IT", source: { kind: "question", questionId: "q1", filter: "selected" }, children: [{ type: "page", id: "p1", questionIds: ["q7"] }], ...extra },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const codes = (extra: Record<string, unknown>) => {
    const d = build(extra);
    const st = createResponseState(d, { seed: 1 });
    st.answers.q1 = [1, 2, 3];
    return resolveLoopItems(d, st, d.flow[0] as never).map((i) => String(i.code));
  };
  assert.deepEqual(codes({}), ["1", "2", "3"]);
  assert.deepEqual(codes({ skipIf: EMPTY }), ["1", "2", "3"]);
  assert.deepEqual(codes({ breakIf: group("or", []) }), ["1", "2", "3"]);
  assert.deepEqual(codes({ source: { kind: "question", questionId: "q1", filter: "invalid" }, invalidIf: EMPTY }), []);
  /* a configured one still acts — nested, on the item */
  const skip = group("or", [{ type: "rule", source: { kind: "loop", ref: "code" }, operator: "eq", value: "2" } as Condition, group("and", [{ type: "rule", source: { kind: "loop", ref: "code" }, operator: "eq", value: "3" } as Condition])]);
  assert.deepEqual(codes({ skipIf: skip }), ["1"]);
});

test("a probe with an empty “stop when” is still asked; an adaptive alternative with an empty “when” is not picked", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "p", version: "1.0" },
    questions: [Q("q5", "Q5", "long_text", { probe: { maxProbes: 2, stopWhen: EMPTY } })],
    flow: [{ type: "page", id: "p1", questionIds: ["q5"] }, { type: "end", id: "e", status: "complete" }],
  });
  const st = createResponseState(d, { seed: 1 });
  setAnswer(d, st, "q5", "It was too expensive.");
  assert.equal(nextProbe(d.questions[0], { def: d, state: st, loop: null }), 1, "before: never asked — an empty stop-when held");
  const q = { settings: { adaptive: [{ label: "empty", when: EMPTY, text: "A" }, { label: "real", when: parse("Q1 = 1"), text: "B" }] } } as never;
  assert.equal(pickAdaptive(q, ctxWith({ q1: 1 }))?.label, "real");
  assert.equal(pickAdaptive(q, ctxWith({ q1: 2 })), undefined);
});
