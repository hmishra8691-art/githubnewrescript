import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type ConditionRule, type Condition } from "@rescript/schema";
import {
  createResponseState, setAnswer, evaluateCondition, visibleQuestions, runCalculations, lintSurveyLogic,
  parseLogicExpression, formatCondition, duplicateQuestion,
} from "./index.js";

/**
 * THE LOGIC AUDIT, AS A TEST — display / skip / branch conditions across question
 * types, and the P0 brief's regression scenarios that are not about a matrix's
 * answer column (those live in gridCondition.test.ts).
 */

const opt = (code: string, label: string) => ({ code, label });
const def = () => SurveyDefinition.parse({
  meta: { id: "a", code: "A", title: "Audit", version: "1.0" },
  questions: [
    { id: "q_single", code: "S1", variableName: "S1", type: "single_select", text: "single", options: [opt("1", "Yes"), opt("2", "No"), opt("01", "Padded")] },
    { id: "q_multi", code: "M1", variableName: "M1", type: "multi_select", text: "multi", options: [opt("a", "A"), opt("b", "B"), opt("c", "C")] },
    { id: "q_num", code: "N1", variableName: "N1", type: "numeric", text: "num" },
    { id: "q_text", code: "T1", variableName: "T1", type: "text", text: "text" },
    { id: "q_rank", code: "R1", variableName: "R1", type: "ranking", text: "rank", options: [opt("a", "A"), opt("b", "B"), opt("c", "C")] },
    { id: "q_slider", code: "L1", variableName: "L1", type: "slider", text: "slider", min: 0, max: 10 },
    { id: "q_t", code: "X1", variableName: "X1", type: "text", text: "target" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_single", "q_multi", "q_num", "q_text", "q_rank", "q_slider"] }, { type: "page", id: "p2", questionIds: ["q_t"] }, { type: "end", id: "e", status: "complete" }],
});
const r = (source: Record<string, unknown>, operator: string, value?: unknown, value2?: unknown): ConditionRule =>
  ({ type: "rule", source: { kind: "question", ...source }, operator, ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}) }) as ConditionRule;
const holds = (c: Condition, answers: Record<string, unknown> = {}) => {
  const d = def();
  const st = createResponseState(d);
  for (const [k, v] of Object.entries(answers)) setAnswer(d, st, k, v as never);
  return evaluateCondition(c, { def: d, state: st });
};

test("single select: selected / not selected / equals / not equals, and an unanswered question", () => {
  assert.equal(holds(r({ ref: "q_single" }, "selected", "1"), { q_single: "1" }), true);
  assert.equal(holds(r({ ref: "q_single" }, "selected", "1"), { q_single: "2" }), false);
  assert.equal(holds(r({ ref: "q_single" }, "notSelected", "1"), { q_single: "2" }), true);
  assert.equal(holds(r({ ref: "q_single" }, "eq", "2"), { q_single: "2" }), true);
  assert.equal(holds(r({ ref: "q_single" }, "ne", "2"), { q_single: "1" }), true);
  assert.equal(holds(r({ ref: "q_single" }, "selected", "1")), false, "unanswered is not selected");
  assert.equal(holds(r({ ref: "q_single" }, "unanswered")), true);
  assert.equal(holds(r({ ref: "q_single" }, "answered"), { q_single: "1" }), true);
});

test("code 1 and code 01 are different codes", () => {
  assert.equal(holds(r({ ref: "q_single" }, "selected", "01"), { q_single: "01" }), true);
  assert.equal(holds(r({ ref: "q_single" }, "selected", "01"), { q_single: "1" }), false);
  assert.equal(holds(r({ ref: "q_single" }, "selected", "1"), { q_single: "01" }), false);
});

test("multi select: any / all / none, selected / not selected, and counts", () => {
  const a = { q_multi: ["a", "b"] };
  assert.equal(holds(r({ ref: "q_multi" }, "selected", "a"), a), true);
  assert.equal(holds(r({ ref: "q_multi" }, "notSelected", "c"), a), true);
  assert.equal(holds(r({ ref: "q_multi" }, "containsAny", ["b", "c"]), a), true);
  assert.equal(holds(r({ ref: "q_multi" }, "containsAll", ["a", "c"]), a), false);
  assert.equal(holds(r({ ref: "q_multi" }, "containsNone", ["c"]), a), true);
  const count = (op: string, v: number, v2?: number) => r({ ref: "q_multi", count: { of: "selected", scope: "options" } }, op, v, v2);
  assert.equal(holds(count("gte", 2), a), true);
  assert.equal(holds(count("gt", 2), a), false);
  assert.equal(holds(count("eq", 0)), true, "nothing selected counts zero");
  assert.equal(holds(count("between", 1, 3), a), true);
});

test("numeric thresholds are exact at the boundary and honest about unanswered", () => {
  for (const [op, n, expect] of [["gt", 18, false], ["gte", 18, true], ["lt", 18, false], ["lte", 18, true], ["eq", 18, true], ["ne", 18, false]] as const)
    assert.equal(holds(r({ ref: "q_num" }, op, 18), { q_num: n }), expect, `${op} at 18`);
  assert.equal(holds(r({ ref: "q_num" }, "between", 10, 20), { q_num: 10 }), true, "between is inclusive at the low end");
  assert.equal(holds(r({ ref: "q_num" }, "between", 10, 20), { q_num: 20 }), true, "and the high end");
  assert.equal(holds(r({ ref: "q_num" }, "between", 10, 20), { q_num: 21 }), false);
  assert.equal(holds(r({ ref: "q_num" }, "gte", 0)), false, "no answer is not >= 0");
  assert.equal(holds(r({ ref: "q_num" }, "lt", 5)), false, "no answer is not < 5");
  assert.equal(holds(r({ ref: "q_num" }, "gt", 5), { q_num: "7" }), true, "a numeric string compares as a number");
  assert.equal(holds(r({ ref: "q_slider" }, "gte", 7), { q_slider: 7 }), true);
});

test("text entry: equals, contains, starts with, empty", () => {
  assert.equal(holds(r({ ref: "q_text" }, "eq", "hello"), { q_text: "hello" }), true);
  assert.equal(holds(r({ ref: "q_text" }, "contains", "ell"), { q_text: "hello" }), true);
  assert.equal(holds(r({ ref: "q_text" }, "startsWith", "he"), { q_text: "hello" }), true);
  assert.equal(holds(r({ ref: "q_text" }, "isEmpty")), true);
  assert.equal(holds(r({ ref: "q_text" }, "isNotEmpty"), { q_text: "x" }), true);
  assert.equal(holds(r({ ref: "q_text" }, "eq", "x"), { q_text: "   " }), false);
});

test("ranking: first / last / in top N / not ranked", () => {
  const ranked = { q_rank: ["b", "a", "c"] };
  assert.equal(holds(r({ ref: "q_rank" }, "rankedFirst", "b"), ranked), true);
  assert.equal(holds(r({ ref: "q_rank" }, "rankedLast", "c"), ranked), true);
  assert.equal(holds(r({ ref: "q_rank" }, "rankedTopN", "a", 2), ranked), true);
  assert.equal(holds(r({ ref: "q_rank" }, "rankedTopN", "c", 2), ranked), false);
});

test("AND / OR / NOT nest, and an empty group is neutral", () => {
  const t = r({ ref: "q_single" }, "selected", "1"), f = r({ ref: "q_single" }, "selected", "2");
  const a = { q_single: "1" };
  const g = (op: "and" | "or" | "not", ...children: Condition[]): Condition => ({ type: "group", op, children });
  assert.equal(holds(g("and", t, g("or", f, g("not", f))), a), true);
  assert.equal(holds(g("and", t, g("not", g("or", t, f))), a), false);
  assert.equal(holds(g("or", f, g("and", t, g("not", f))), a), true);
  assert.equal(holds(g("and"), a), true, "empty AND is always true");
});

test("a reference to a deleted question reports a problem and is false, never an exception", () => {
  const d = def();
  d.questions.find((q) => q.id === "q_t")!.displayLogic = r({ ref: "q_gone" }, "selected", "1");
  assert.equal(holds(r({ ref: "q_gone" }, "selected", "1"), {}), false);
  assert.ok(lintSurveyLogic(d).length > 0);
  assert.equal(holds(r({ ref: "q_single" }, "selected", "99"), { q_single: "1" }), false, "an unknown option code is false");
});

test("upstream answer change re-evaluates every dependent, both directions", () => {
  const d = def();
  d.questions.find((q) => q.id === "q_t")!.displayLogic = { type: "group", op: "and", children: [r({ ref: "q_single" }, "selected", "1"), r({ ref: "q_num" }, "gte", 18)] };
  const st = createResponseState(d);
  const page = { kind: "page" as const, pageId: "p2", showTitle: false, questionIds: ["q_t"], loop: null, sectionPath: [], nodePath: [] };
  const shown = () => visibleQuestions(d, page as never, st).length === 1;
  assert.equal(shown(), false);
  setAnswer(d, st, "q_single", "1"); setAnswer(d, st, "q_num", 30);
  assert.equal(shown(), true);
  setAnswer(d, st, "q_num", 17);
  assert.equal(shown(), false, "changed back: hidden again, no stale value");
  setAnswer(d, st, "q_num", 18);
  assert.equal(shown(), true, "boundary");
});

test("calculated and hidden variables drive conditions, and recompute on change", () => {
  const d = SurveyDefinition.parse({ ...def(), calculations: [{ id: "k", targetVariable: "SCORE", expression: "N1 * 2", trigger: "on_page_submit" }] });
  const st = createResponseState(d);
  setAnswer(d, st, "q_num", 5);
  runCalculations(d, st, "on_page_submit");
  const c: Condition = { type: "rule", source: { kind: "calculation", ref: "SCORE" }, operator: "gte", value: 10 } as never;
  assert.equal(evaluateCondition(c, { def: d, state: st }), true);
  setAnswer(d, st, "q_num", 4);
  runCalculations(d, st, "on_page_submit");
  assert.equal(evaluateCondition(c, { def: d, state: st }), false);
});

test("renaming a label, or reordering options, does not change what a condition reads", () => {
  const c = r({ ref: "q_single" }, "selected", "2");
  const base = def();
  const renamed = SurveyDefinition.parse({ ...base, questions: base.questions.map((q) => q.id === "q_single" ? { ...q, text: "renamed", options: [opt("2", "NO (new label)"), opt("1", "Yes"), opt("01", "Padded")] } : q) });
  const st = createResponseState(renamed);
  setAnswer(renamed, st, "q_single", "2");
  assert.equal(evaluateCondition(c, { def: renamed, state: st }), true, "same code, new label and new position");
  assert.match(formatCondition(renamed, c), /2/);
});

test("copying a condition onto several questions gives each the same logic, and unrelated questions are unchanged", () => {
  const d = def();
  const c: Condition = { type: "group", op: "and", children: [r({ ref: "q_single" }, "selected", "1"), r({ ref: "q_num" }, "gte", 18)] };
  const parsed = parseLogicExpression(d, formatCondition(d, c));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.condition, c);
  for (const id of ["q_t", "q_text"]) d.questions.find((q) => q.id === id)!.displayLogic = structuredClone(parsed.condition!);
  assert.deepEqual(d.questions.find((q) => q.id === "q_t")!.displayLogic, d.questions.find((q) => q.id === "q_text")!.displayLogic);
  assert.equal(d.questions.find((q) => q.id === "q_num")!.displayLogic, undefined, "a question that was not touched has no logic");
  /* duplicating a question that has logic keeps the original's logic byte for byte */
  const before = JSON.stringify(d.questions.find((q) => q.id === "q_t")!.displayLogic);
  duplicateQuestion(d, "q_t");
  assert.equal(JSON.stringify(d.questions.find((q) => q.id === "q_t")!.displayLogic), before);
});
