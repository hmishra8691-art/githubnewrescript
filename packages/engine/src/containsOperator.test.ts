import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type ConditionRule } from "@rescript/schema";
import {
  createResponseState, evaluateCondition, start, advance, setAnswer, visibleQuestions, lintSurveyLogic,
  operatorMenu, operatorStatus, entryForRule, applyContainsReplacement, containsReplacementFor, offersContains,
  evaluateWithTestInputs, type RuntimeStep,
} from "./index.js";

/**
 * THE CONTAINS OPERATOR AND OPEN-ENDED ANSWERS (2026-10-24, client Excel
 * 19/10 items A46 and A48).
 *
 *   · an open-ended answer with several comma-separated values is read value
 *     by value by `between`, the numeric comparisons and `in` / `notIn` —
 *     the client's table, verbatim;
 *   · display logic and branch logic give the same answer (one evaluator);
 *   · `contains` stays a text operator: offered on open ends, not on choice
 *     questions; a stored one on a choice question is "needs update" with
 *     the operator that names what it does, and still evaluates as before;
 *   · Embedded Data evaluates exactly as before (the compat snapshot proves
 *     the rest).
 */

const opt = (code: string, label = code) => ({ code, label });
const row = (code: string, label = code) => ({ code, label });
const q = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: `${id} text`, ...extra });

const between = (ref: string, lo: unknown, hi: unknown): ConditionRule => ({ type: "rule", source: { kind: "question", ref }, operator: "between", value: lo, value2: hi });
const rule = (ref: string, operator: string, value?: unknown, value2?: unknown, extra: Record<string, unknown> = {}): ConditionRule =>
  ({ type: "rule", source: { kind: "question", ref, ...extra }, operator, value, value2 } as ConditionRule);

function survey(extraQuestions: Record<string, unknown>[] = []) {
  return SurveyDefinition.parse({
    meta: { id: "contains", code: "C", title: "Contains", version: "1" },
    questions: [
      q("q_text", "open_text"),
      q("q_num", "numeric"),
      q("q_single", "single_select", { options: [opt("1", "Tea"), opt("2", "Coffee")] }),
      q("q_multi", "multi_select", { options: [opt("a", "Apple"), opt("b", "Banana")] }),
      q("q_rank", "ranking", { options: [opt("x"), opt("y")] }),
      q("q_grid", "matrix_single", { options: [opt("1", "Poor"), opt("3", "Good")], rows: [row("r1"), row("r2")] }),
      q("q_tgrid", "matrix_text", { rows: [row("r1"), row("r2")] }),
      q("q_ngrid", "matrix_numeric", { rows: [row("r1"), row("r2")] }),
      q("q_fields", "text_list", { rows: [{ code: "a", label: "A", fieldType: "text" }, { code: "n", label: "N", fieldType: "number" }] }),
      q("q_sum", "allocation", { options: [opt("1", "Rent"), opt("2", "Food")] }),
      q("q_comp", "composite", { rows: [row("r1")], columns: [{ id: "c_text", label: "Text", responseType: "text", variableStem: "T" }, { id: "c_sel", label: "Pick", responseType: "single", variableStem: "P", options: [opt("1"), opt("2")] }] }),
      ...extraQuestions,
    ],
    flow: [
      { type: "embedded_data", id: "ed", fields: [{ name: "ED_STR", source: "url", dataType: "string" }] },
      { type: "page", id: "p1", questionIds: ["q_text", "q_num", "q_single", "q_multi", "q_rank", "q_grid", "q_tgrid", "q_ngrid", "q_fields", "q_sum", "q_comp"] },
    ],
  });
}

function holds(def: SurveyDefinition, c: Condition, answers: Record<string, unknown> = {}, embedded: Record<string, unknown> = {}) {
  const state = createResponseState(def, { seed: 1, embedded: embedded as never });
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def, state, loop: null });
}

/* ========================================================= 1. the client's table */

/** the client's expected results for "Q1 → 1–100" on an open end that takes comma-separated numbers */
const CLIENT_TABLE: [string, boolean][] = [
  ["1", true], ["5", true], ["25,26,27,45,39,50", true], ["50", true], ["99", true], ["100", true],
  ["99.100,101", false], ["150", false],
];

test("Between 1–100 on a text open end reads each comma-separated number: the client's table", () => {
  const def = survey();
  for (const [typed, want] of CLIENT_TABLE) {
    assert.equal(holds(def, between("q_text", 1, 100), { q_text: typed }), want, `"${typed}" → ${want}`);
    assert.equal(holds(def, between("q_text", "1", "100"), { q_text: typed }), want, `"${typed}" with the bounds typed as text → ${want}`);
  }
  /* a numeric question holds one number: the same rule, the same answers */
  assert.equal(holds(def, between("q_num", 1, 100), { q_num: 25 }), true);
  assert.equal(holds(def, between("q_num", 1, 100), { q_num: 100 }), true, "inclusive");
  assert.equal(holds(def, between("q_num", 1, 100), { q_num: 150 }), false);
  assert.equal(holds(def, between("q_num", 1, 100), { q_num: 0 }), false);
  assert.equal(holds(def, between("q_num", 1, 100), {}), false, "unanswered: fail-closed");
});

test("comma-separated numbers are parsed robustly: spaces, trailing commas, decimals, negatives, empty items; a non-number fails", () => {
  const def = survey();
  const t = (typed: string, lo: number, hi: number) => holds(def, between("q_text", lo, hi), { q_text: typed });
  assert.equal(t(" 25 , 26 ,", 1, 100), true, "spaces and a trailing comma");
  assert.equal(t("25,,26", 1, 100), true, "an empty item is ignored");
  assert.equal(t("25;26", 1, 100), true, "semicolons separate too");
  assert.equal(t("-3, 2.5, 4.75", -5, 5), true, "decimals and negatives");
  assert.equal(t("-3, 2.5, 6", -5, 5), false, "one value out of range: false");
  assert.equal(t("abc, 5", 1, 100), false, "a value that is not a number fails the numeric comparison");
  assert.equal(t("25, twenty", 1, 100), false);
  assert.equal(t("", 1, 100), false, "an empty answer is not in any range");
  assert.equal(t("99.100,101", 1, 100), false, "the client's case");
  assert.equal(t("1e2, 50", 1, 100), true, "exponent notation is a number (100)");
});

test("the other numeric comparisons and the negations read a list value by value", () => {
  const def = survey();
  const t = (operator: string, typed: string, v: unknown, v2?: unknown) => holds(def, rule("q_text", operator, v, v2), { q_text: typed });
  assert.equal(t("gte", "25, 26", 25), true, "every value ≥ 25");
  assert.equal(t("gte", "24, 26", 25), false);
  assert.equal(t("gt", "30, 31", 25), true);
  assert.equal(t("lt", "30, 31", 25), false);
  assert.equal(t("lte", "1, 25", 25), true);
  assert.equal(t("lte", "1, 26", 25), false);
  assert.equal(t("notBetween", "150, 200", 1, 100), true, "no value in the range");
  assert.equal(t("notBetween", "25, 150", 1, 100), false, "one value in the range: not “not between”");
  assert.equal(t("notBetween", "abc, 150", 1, 100), false, "a non-number is never outside a numeric range either");
  assert.equal(t("notBetween", "150", 1, 100), true, "a scalar, as before");
  assert.equal(t("notBetween", "50", 1, 100), false);
});

test("In list: the whole answer is one of the values; a comma-separated answer needs every value in the list", () => {
  const def = survey();
  const LIST = ["1", "5", "10", "25", "50", "100"];
  const t = (operator: string, typed: unknown, list: unknown = LIST, ref = "q_text") => holds(def, rule(ref, operator, list), { [ref]: typed });
  assert.equal(t("in", "25"), true, "the client's §3C: 25 is in 1, 5, 10, 25, 50, 100");
  assert.equal(t("in", "26"), false, "…26 is not");
  assert.equal(t("in", "25, 50"), true, "every value in the list");
  assert.equal(t("in", "25, 26"), false, "26 is not in the list");
  assert.equal(t("in", "25,50,100,"), true, "trailing comma, no spaces");
  assert.equal(t("in", "25", "1, 5, 10, 25, 50, 100"), true, "the list typed as one comma-separated value");
  assert.equal(t("in", "26", "1, 5, 10, 25, 50, 100"), false);
  assert.equal(t("in", "a, b", ["a", "b", "c"]), true, "text values too");
  assert.equal(t("in", "a, b", ["a, b"]), true, "a value that contains a comma still matches as a whole, as before");
  assert.equal(t("notIn", "26, 27"), true, "no value in the list");
  assert.equal(t("notIn", "26, 25"), false, "25 is in the list");
  assert.equal(t("notIn", "26"), true);
  assert.equal(t("notIn", "25"), false);
  /* on a numeric question */
  assert.equal(t("in", 25, LIST, "q_num"), true);
  assert.equal(t("in", 26, LIST, "q_num"), false);
  assert.equal(t("in", 25, [1, 5, 10, 25], "q_num"), true, "numbers in the list");
  assert.equal(t("notIn", 26, LIST, "q_num"), true);
});

test("Contains text on an open end is still a substring test — a list answer is one text", () => {
  const def = survey();
  const t = (typed: string, needle: string) => holds(def, rule("q_text", "contains", needle), { q_text: typed });
  assert.equal(t("Light blue", "blue"), true);
  assert.equal(t("25, 26, 27", "26"), true, "as text, “26” is in there");
  assert.equal(t("25, 26, 27", "5, 2"), true, "any part of the text");
  assert.equal(t("25", "1-100"), false, "a range is not something a text can contain");
  assert.equal(holds(def, rule("q_text", "notContains", "blue"), { q_text: "Light blue" }), false);
});

/* ================================================ 2. display logic = branch logic */

function flowSurvey(condition: Condition, qtype: "open_text" | "numeric") {
  return SurveyDefinition.parse({
    meta: { id: "parity", code: "P", title: "P", version: "1" },
    questions: [
      q("q1", qtype),
      q("q_display", "open_text", { displayLogic: condition }),
      q("q_always", "open_text"),
      q("q_hit", "open_text"),
      q("q_miss", "open_text"),
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q_display", "q_always"] },
      { type: "branch", id: "br", branches: [{ id: "b1", when: condition, children: [{ type: "page", id: "p_hit", questionIds: ["q_hit"] }] }],
        otherwise: [{ type: "page", id: "p_miss", questionIds: ["q_miss"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

/** run the respondent through: did display logic show Q_DISPLAY, and did the branch route to P_HIT? */
function runBoth(def: SurveyDefinition, answer: unknown): { displayed: boolean; branched: boolean } {
  const st = createResponseState(def, { seed: 1 });
  start(def, st);
  setAnswer(def, st, "q1", answer as never);
  let nav = advance(def, st);
  const page = nav.steps[nav.stepIndex] as Extract<RuntimeStep, { kind: "page" }>;
  assert.equal(page.pageId, "p2");
  const displayed = visibleQuestions(def, page, st).some((x) => x.id === "q_display");
  nav = advance(def, st);
  const branched = (nav.steps[nav.stepIndex] as { pageId?: string }).pageId === "p_hit";
  return { displayed, branched };
}

test("display logic and branch logic agree on every row of the client's table — one evaluator", () => {
  const def = flowSurvey(between("q1", 1, 100), "open_text");
  for (const [typed, want] of CLIENT_TABLE) {
    const r = runBoth(def, typed);
    assert.equal(r.displayed, want, `display: "${typed}" → ${want}`);
    assert.equal(r.branched, want, `branch: "${typed}" → ${want}`);
  }
  const num = flowSurvey(between("q1", 1, 100), "numeric");
  for (const [n, want] of [[25, true], [100, true], [150, false], [0, false]] as [number, boolean][]) {
    const r = runBoth(num, n);
    assert.deepEqual([r.displayed, r.branched], [want, want], `numeric ${n}`);
  }
  const list = flowSurvey(rule("q1", "in", ["1", "5", "10", "25", "50", "100"]), "open_text");
  for (const [typed, want] of [["25", true], ["26", false], ["25, 50", true], ["25, 26", false]] as [string, boolean][]) {
    const r = runBoth(list, typed);
    assert.deepEqual([r.displayed, r.branched], [want, want], `in list "${typed}"`);
  }
});

test("the builder's Test condition panel uses the same evaluator", () => {
  const def = survey();
  const c = between("q_text", 1, 100);
  for (const [typed, want] of CLIENT_TABLE) {
    assert.equal(evaluateWithTestInputs(def, c, { "q:q_text": typed }).result, want, `test panel "${typed}"`);
  }
});

/* ======================================================= 3. where Contains lives */

test("the operator menu: Contains on open ends only; In list and Between where numbers are typed", () => {
  const def = survey();
  const ops = (ref: string, extra: Record<string, unknown> = {}) => operatorMenu(def, { kind: "question", ref, ...extra }).entries.map((x) => x.op);
  const labels = (ref: string) => operatorMenu(def, { kind: "question", ref }).entries.map((x) => x.label);
  /* text: contains text, is in list, is between (numbers) */
  assert.ok(ops("q_text").includes("contains") && ops("q_text").includes("notContains"));
  assert.ok(labels("q_text").includes("is in list") && labels("q_text").includes("is not in list"), labels("q_text").join(" | "));
  assert.ok(labels("q_text").includes("is between (numbers)") && labels("q_text").includes("is not between (numbers)"));
  assert.equal(operatorMenu(def, { kind: "question", ref: "q_text" }).entries.find((x) => x.op === "between")?.value, "numberRange", "two number inputs");
  assert.equal(operatorMenu(def, { kind: "question", ref: "q_text" }).entries.find((x) => x.op === "in")?.value, "textList");
  /* numeric: the comparisons, between, is in list — no contains */
  assert.ok(!ops("q_num").includes("contains"), "a number is not searched as text");
  assert.ok(labels("q_num").includes("is in list") && labels("q_num").includes("is not in list"), labels("q_num").join(" | "));
  assert.equal(operatorMenu(def, { kind: "question", ref: "q_num" }).entries.find((x) => x.op === "in")?.value, "numberList");
  assert.ok(ops("q_num").includes("between"));
  /* choice questions and grids: no contains at all */
  for (const ref of ["q_single", "q_multi", "q_grid"]) {
    assert.ok(!ops(ref).includes("contains") && !ops(ref).includes("notContains"), `${ref} offers no contains: ${ops(ref)}`);
  }
  /* kept where it has its own meaning: ranking "is ranked", text grid, text fields, text column */
  const rank = operatorMenu(def, { kind: "question", ref: "q_rank" }).entries.find((x) => x.op === "contains");
  assert.equal(rank?.label, "is ranked");
  assert.ok(ops("q_tgrid").includes("contains") && labels("q_tgrid").includes("is between (numbers)"));
  assert.ok(ops("q_fields").includes("contains"));
  assert.ok(ops("q_comp", { columnId: "c_text" }).includes("contains"));
  assert.ok(!ops("q_comp", { columnId: "c_sel" }).includes("contains"), "a single-select column has no contains");
  assert.ok(ops("q_ngrid").includes("in") && !ops("q_ngrid").includes("contains"), "a numeric grid: in list, no contains");
  assert.ok(ops("q_sum").includes("in") && !ops("q_sum").includes("contains"), "constant sum: in list, no contains");
  /* `offersContains` says the same thing */
  for (const [ref, want] of [["q_text", true], ["q_num", false], ["q_single", false], ["q_multi", false], ["q_rank", true], ["q_grid", false], ["q_tgrid", true], ["q_ngrid", false], ["q_fields", true], ["q_sum", false]] as [string, boolean][]) {
    assert.equal(offersContains(def.questions.find((x) => x.id === ref)), want, ref);
  }
});

test("a stored `contains` on a choice question: needs update, names its replacement, and still evaluates as before", () => {
  const def = survey();
  /* single select: contains "2" was equals */
  const single = rule("q_single", "contains", "2");
  assert.equal(holds(def, single, { q_single: "2" }), true, "evaluates as it always did");
  assert.equal(holds(def, single, { q_single: "1" }), false);
  let st = operatorStatus(def, single);
  assert.equal(st.status, "needsUpdate");
  assert.equal(st.replacement?.op, "eq");
  assert.match(st.message ?? "", /text operator/);
  assert.deepEqual(containsReplacementFor(def.questions[2], "contains"), { op: "eq", label: "equals" });
  assert.deepEqual(containsReplacementFor(def.questions[2], "notContains"), { op: "ne", label: "does not equal" });
  /* applying the replacement keeps the value and gives the same answer */
  const fixed = applyContainsReplacement(single, st.replacement!);
  assert.equal(fixed.operator, "eq");
  assert.equal(fixed.value, "2", "the value is kept");
  assert.equal(holds(def, fixed, { q_single: "2" }), true);
  assert.equal(holds(def, fixed, { q_single: "1" }), false);
  /* multi select: contains "a" was has selected */
  const multi = rule("q_multi", "contains", "a");
  assert.equal(holds(def, multi, { q_multi: ["a", "b"] }), true);
  st = operatorStatus(def, multi);
  assert.equal(st.status, "needsUpdate");
  assert.equal(st.replacement?.op, "selected");
  assert.deepEqual(containsReplacementFor(def.questions[3], "notContains"), { op: "notSelected", label: "hasn't selected" });
  const fixedMulti = applyContainsReplacement(multi, st.replacement!);
  assert.equal(holds(def, fixedMulti, { q_multi: ["a", "b"] }), true);
  assert.equal(holds(def, fixedMulti, { q_multi: ["b"] }), false);
  /* grid */
  assert.equal(containsReplacementFor(def.questions[5], "contains")?.op, "selected");
  assert.equal(operatorStatus(def, rule("q_grid", "contains", "3", undefined, { rowCode: "r1" })).status, "needsUpdate");
  /* kept cases are fine */
  assert.equal(operatorStatus(def, rule("q_text", "contains", "x")).status, "ok");
  assert.equal(operatorStatus(def, rule("q_rank", "contains", "x")).status, "ok", "“is ranked”");
  assert.equal(containsReplacementFor(def.questions[4], "contains"), null);
  assert.equal(containsReplacementFor(def.questions[0], "contains"), null);
  assert.equal(containsReplacementFor(def.questions[6], "contains"), null, "a text grid keeps contains");
  assert.equal(containsReplacementFor(def.questions[1], "contains"), null, "numeric: invalid, not deprecated (the error path)");
  assert.equal(operatorStatus(def, rule("q_num", "contains", "5")).status, "needsUpdate", "…and the builder marks it");
  assert.equal(operatorStatus(def, rule("q_num", "contains", "5")).replacement, undefined);
  /* entryForRule still finds nothing for the stored operator (it is not in the menu) */
  assert.equal(entryForRule(operatorMenu(def, single.source), single), undefined);
});

test("the linter WARNS about contains on a choice question and offers the replacement; it does not block deployment", () => {
  const withRules = survey([
    q("qa", "open_text", { displayLogic: rule("q_single", "contains", "2") }),
    q("qb", "open_text", { displayLogic: rule("q_multi", "notContains", "a") }),
    q("qc", "open_text", { displayLogic: rule("q_text", "contains", "blue") }),
    q("qd", "open_text", { displayLogic: between("q_text", 1, 100) }),
    q("qe", "open_text", { displayLogic: rule("q_num", "contains", "5") }),
  ]);
  const issues = lintSurveyLogic(withRules);
  const a = issues.find((i) => i.questionId === "qa" && /contains/.test(i.message));
  assert.ok(a, "contains on a single select is reported");
  assert.equal(a!.level, "warning");
  assert.match(a!.message, /needs updating/);
  assert.match(a!.message, /use “equals” \(eq\)/);
  const b = issues.find((i) => i.questionId === "qb" && /notContains/.test(i.message));
  assert.equal(b?.level, "warning");
  assert.match(b!.message, /use “hasn't selected” \(notSelected\)/);
  assert.ok(!issues.some((i) => i.questionId === "qc" && /contains|needs updating/.test(i.message)), `contains on a text question is fine: ${issues.filter((i) => i.questionId === "qc").map((i) => i.message)}`);
  assert.ok(!issues.some((i) => i.questionId === "qd" && /between|needs updating|cannot be used/.test(i.message)), `between on a text question is valid now: ${issues.filter((i) => i.questionId === "qd").map((i) => i.message)}`);
  const e = issues.find((i) => i.questionId === "qe");
  assert.equal(e?.level, "error", "contains on a NUMERIC question was never valid: still the blocking error");
});

/* ================================================ 4. nothing else moves */

test("Embedded Data and choice answers evaluate exactly as before", () => {
  const def = survey();
  const ed = (operator: string, v: unknown, v2: unknown, stored: unknown) => holds(def, { type: "rule", source: { kind: "embedded", ref: "ED_STR" }, operator, value: v, value2: v2 } as ConditionRule, {}, { ED_STR: stored });
  assert.equal(ed("between", 1, 100, "25, 26"), false, "an Embedded Data string list is not read value by value (its own item operators do that)");
  assert.equal(ed("between", 1, 100, "25"), true);
  assert.equal(ed("in", ["25", "26"], undefined, "25, 26"), false);
  assert.equal(ed("contains", "26", undefined, "25, 26"), true, "substring, as always");
  /* a multi-select array through `in` is untouched */
  assert.equal(holds(def, rule("q_multi", "in", ["a"]), { q_multi: ["a"] }), holds(survey(), rule("q_multi", "in", ["a"]), { q_multi: ["a"] }));
  /* a single value on a text question: exactly the old results */
  assert.equal(holds(def, rule("q_text", "in", ["25", "50"]), { q_text: "25" }), true);
  assert.equal(holds(def, rule("q_text", "in", ["25", "50"]), { q_text: "2" }), false);
  assert.equal(holds(def, rule("q_text", "eq", "25, 26"), { q_text: "25, 26" }), true, "equals compares the whole text");
});
