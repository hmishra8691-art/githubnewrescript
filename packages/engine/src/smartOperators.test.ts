import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type ConditionRule } from "@rescript/schema";
import {
  createResponseState, evaluateCondition, start, lintSurveyLogic, operatorsForQuestion, gridCellOperators,
  operatorMenu, operandTypeOf, entryForRule, applyOperatorEntry, operatorStatus, ruleSentence,
  conditionTestInputs, evaluateWithTestInputs, parseLogicExpression, formatCondition, runQualityCheck,
  conditionSentence, conditionFromText,
} from "./index.js";

/**
 * SMART OPERATORS + LIST ITEMS (documents 15/10 and 16/10, October 2026).
 */

const opt = (code: string, label = code) => ({ code, label });
const row = (code: string, label = code) => ({ code, label });
const q = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: `${id} text`, ...extra });

const ZIPS = "10001, 10002, 10003, 10004, 10005";

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "smart", code: "S", title: "Smart", version: "1" },
    questions: [
      q("q1", "single_select", { options: [opt("1", "Tea"), opt("2", "Coffee"), opt("3", "Water")] }),
      q("q2", "multi_select", { options: [opt("a", "Apple"), opt("b", "Banana"), opt("c", "Cherry")] }),
      q("q3", "numeric"),
      q("q4", "open_text"),
      q("q5", "matrix_single", { options: [opt("1", "Poor"), opt("2", "OK"), opt("3", "Good")], rows: [row("r1", "Service"), row("r2", "Price")] }),
      q("q6", "matrix_multi", { options: [opt("a", "Web"), opt("b", "App")], rows: [row("r1", "Morning"), row("r2", "Evening")] }),
      q("q7", "matrix_numeric", { rows: [row("r1", "Adults"), row("r2", "Kids")] }),
      q("q8", "allocation", { options: [opt("1", "Rent"), opt("2", "Food")] }),
      q("q9", "ranking", { options: [opt("x", "X"), opt("y", "Y"), opt("z", "Z")] }),
      q("q10", "maxdiff_task", { options: [opt("1", "One"), opt("2", "Two"), opt("3", "Three")] }),
      q("q11", "date"),
      q("q12", "time"),
      q("q13", "upload"),
      q("q14", "nps", { options: Array.from({ length: 11 }, (_, i) => opt(String(i))) }),
      q("q15", "single_select", { variant: "single.stars", options: [opt("1"), opt("2"), opt("3"), opt("4"), opt("5")] }),
      q("q16", "single_select", { variant: "single.likelihood", options: [opt("lo", "Unlikely"), opt("hi", "Likely")] }),
      q("zip", "open_text"),
    ],
    flow: [
      { type: "embedded_data", id: "ed", fields: [
        { name: "ZIP_Code_DMA", source: "static", value: ZIPS, dataType: "string" },
        { name: "PANEL", source: "url", dataType: "boolean" },
        { name: "SCORE", source: "url", dataType: "integer" },
        { name: "SEGMENT", source: "url" },
      ] },
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11", "q12", "q13", "q14", "q15", "q16", "zip"] },
    ],
    ...extra,
  });
}

const rule = (source: Record<string, unknown>, operator: string, value?: unknown, value2?: unknown): ConditionRule =>
  ({ type: "rule", source: { kind: "question", ...source }, operator, value, value2 } as ConditionRule);

function holds(def: SurveyDefinition, c: Condition, answers: Record<string, unknown> = {}, embedded: Record<string, unknown> = {}) {
  const state = createResponseState(def, { seed: 1, embedded: embedded as never });
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def, state, loop: null });
}

/* ============================================================ 1. list items */

test("Contains item on an Embedded Data list: the document's table", () => {
  const def = survey();
  const ed = (operator: string, value: unknown, list: unknown = ZIPS) =>
    holds(def, rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, operator, value), {}, { ZIP_Code_DMA: list });
  assert.equal(ed("containsItem", "10003"), true, "10001..10005 contains 10003");
  assert.equal(ed("containsItem", "10009"), false, "…not 10009");
  assert.equal(ed("containsItem", "99999"), false);
  assert.equal(ed("containsItem", "10001, 10003"), true, "a list needle: any item matches");
  assert.equal(ed("containsItem", "10009, 10003"), true);
  assert.equal(ed("containsItem", "10008, 10009"), false);
  assert.equal(ed("containsItem", ["10009", "10002"]), true, "the needle as an array");
  assert.equal(ed("containsItem", 10005), true, "a number needle");
  assert.equal(ed("containsItem", "10001", "110001, 20002"), false, "10001 never matches 110001");
  assert.equal(ed("containsItem", "1000"), false, "no partial item");
  assert.equal(ed("containsItem", " 10002 "), true, "spaces around the needle");
  assert.equal(ed("containsItem", "10002", "10001 ,10002,10003"), true, "spaces around stored items");
  assert.equal(ed("containsItem", "02108", "02108, 02109"), true, "leading zeros kept");
  assert.equal(ed("containsItem", "2108", "02108, 02109"), false, "2108 is not 02108");
  assert.equal(ed("containsItem", "10005", "10005"), true, "a one-item list");
  assert.equal(ed("containsItem", "10005", ""), false, "an empty field holds nothing");
  assert.equal(ed("containsItem", "10005", null), false);
  assert.equal(ed("containsItem", "x", ["10001", "X"]), true, "an array list, case-insensitive");
  assert.equal(ed("notContainsItem", "10009"), true);
  assert.equal(ed("notContainsItem", "10003"), false);
  assert.equal(ed("notContainsItem", "10008, 10003"), false, "none of the items — 10003 is there");
  assert.equal(ed("containsAllItems", "10001, 10005"), true);
  assert.equal(ed("containsAllItems", "10001, 10009"), false);
  assert.equal(ed("containsAllItems", ""), false, "all of nothing is not a match");
  assert.equal(ed("containsExactly", "10005, 10004, 10003, 10002, 10001"), true, "same items, any order");
  assert.equal(ed("containsExactly", "10001, 10002"), false);
});

test("legacy `contains` on text is UNCHANGED: still a case-insensitive substring", () => {
  const def = survey();
  const ed = (operator: string, value: unknown, list: unknown = ZIPS) =>
    holds(def, rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, operator, value), {}, { ZIP_Code_DMA: list });
  assert.equal(ed("contains", "10003"), true);
  assert.equal(ed("contains", "1000"), true, "a substring — this is why “contains item” exists");
  assert.equal(ed("contains", "10001", "110001, 20002"), true, "the stored meaning is kept for existing surveys");
  assert.equal(ed("contains", "10001, 10003"), false, "a list needle is one piece of text to `contains`");
  assert.equal(holds(def, rule({ ref: "q4" }, "contains", "blue"), { q4: "Light Blue sky" }), true, "open ends keep substring matching");
});

test("Contains item with the comparison value taken from a question's answer (IF ZIP_Code_DMA contains item Q.ZIP)", () => {
  const def = survey();
  const c = rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, "containsItem", { $question: "zip" });
  assert.equal(holds(def, c, { zip: "10004" }, { ZIP_Code_DMA: ZIPS }), true);
  assert.equal(holds(def, c, { zip: "10040" }, { ZIP_Code_DMA: ZIPS }), false);
  assert.equal(holds(def, c, {}, { ZIP_Code_DMA: ZIPS }), false, "unanswered holds nothing");
  /* and the other way round: the typed ZIP is one of a list — `in` on a text question */
  assert.equal(holds(def, rule({ ref: "zip" }, "in", ["10001", "02108"]), { zip: "02108" }), true);
  assert.equal(holds(def, rule({ ref: "zip" }, "in", ["10001", "02108"]), { zip: "2108" }), false);
});

test("piped text as the comparison value: {{ZIP}} resolved at evaluation, printed and parsed as PIPED(…)", () => {
  const def = survey();
  const c = rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, "containsItem", { $pipe: "{{ZIP}}" });
  assert.equal(holds(def, c, { zip: "10004" }, { ZIP_Code_DMA: ZIPS }), true);
  assert.equal(holds(def, c, { zip: "10040" }, { ZIP_Code_DMA: ZIPS }), false);
  assert.equal(holds(def, rule({ ref: "q3" }, "gt", { $pipe: "{{ed.SCORE}}" }), { q3: 30 }, { SCORE: 25 }), true, "a piped number compares as a number");
  assert.equal(holds(def, rule({ ref: "q4" }, "eq", "{{ZIP}}"), { q4: "{{ZIP}}", zip: "1" }), true, "a LITERAL value with braces keeps its literal meaning");
  const text = formatCondition(def, c);
  assert.equal(text, 'ed.ZIP_Code_DMA contains item PIPED("{{ZIP}}")');
  assert.deepEqual(parseLogicExpression(def, text).condition, { type: "rule", source: c.source, operator: "containsItem", value: { $pipe: "{{ZIP}}" } }, "round trip");
  assert.match(ruleSentence(def, c), /the piped value \{\{ZIP\}\}/);
  const bad = survey({ questions: [...survey().questions, q("qx", "open_text", { displayLogic: rule({ ref: "q4" }, "eq", { $pipe: "{{NOPE_NOT_HERE}}" }) })] });
  assert.ok(lintSurveyLogic(bad).some((i) => i.path.endsWith(".value") && i.level === "warning"), "an unresolvable token is reported");
});

/* ============================================================ 2. the ZIP branch, end to end */

function zipFlowSurvey(dataType: string | undefined, operator: string, value: unknown) {
  return SurveyDefinition.parse({
    meta: { id: "zipflow", code: "Z", title: "Z", version: "1" },
    questions: [q("hit", "open_text"), q("miss", "open_text")],
    flow: [
      { type: "embedded_data", id: "ed", fields: [{ name: "ZIP_Code_DMA", source: "static", value: ZIPS, ...(dataType ? { dataType } : {}) }] },
      { type: "branch", id: "br", branches: [{ id: "b1", when: { type: "rule", source: { kind: "embedded", ref: "ZIP_Code_DMA" }, operator, value }, children: [{ type: "page", id: "p_hit", questionIds: ["hit"] }] }],
        otherwise: [{ type: "page", id: "p_miss", questionIds: ["miss"] }] },
    ],
  });
}
const routed = (def: SurveyDefinition) => {
  const st = createResponseState(def, { seed: 1 });
  const nav = start(def, st);
  return (nav.steps[nav.stepIndex] as { pageId?: string }).pageId;
};

test("the ZIP branch routes through the real flow evaluator: 10003 in, 10009 out, 110001 never", () => {
  for (const dataType of [undefined, "string"]) {
    assert.equal(routed(zipFlowSurvey(dataType, "containsItem", "10003")), "p_hit", `${dataType}: 10003`);
    assert.equal(routed(zipFlowSurvey(dataType, "containsItem", "10009")), "p_miss", `${dataType}: 10009`);
    assert.equal(routed(zipFlowSurvey(dataType, "containsItem", "10001, 10003")), "p_hit", `${dataType}: a list needle`);
    assert.equal(routed(zipFlowSurvey(dataType, "notContainsItem", "10009")), "p_hit");
  }
  /* a field TYPED as a list ("list", or "auto" holding one — both new types): `contains` itself matches whole items */
  for (const dataType of ["list", "auto"]) {
    assert.equal(routed(zipFlowSurvey(dataType, "contains", "10003")), "p_hit", `${dataType}: contains 10003`);
    assert.equal(routed(zipFlowSurvey(dataType, "contains", "10009")), "p_miss", `${dataType}: contains 10009`);
    assert.equal(routed(zipFlowSurvey(dataType, "contains", "1000")), "p_miss", `${dataType}: no partial item`);
    assert.equal(routed(zipFlowSurvey(dataType, "contains", "10001, 10003")), "p_hit", `${dataType}: a list needle`);
    assert.equal(routed(zipFlowSurvey(dataType, "notContains", "10009")), "p_hit", `${dataType}: does not contain 10009`);
    assert.equal(routed(zipFlowSurvey(dataType, "containsItem", "10003")), "p_hit");
    const menu = operatorMenu(zipFlowSurvey(dataType, "contains", "x"), { kind: "embedded", ref: "ZIP_Code_DMA" });
    assert.equal(menu.type, "list");
    assert.ok(!menu.entries.some((x) => x.op === "contains"), `${dataType}: “contains text” is not offered where contains means item`);
  }
  /* untyped and "string" fields keep `contains` as text — what every stored survey has */
  assert.equal(routed(zipFlowSurvey(undefined, "contains", "1000")), "p_hit", "untyped: substring, as before");
  assert.equal(routed(zipFlowSurvey("string", "contains", "1000")), "p_hit", "string: substring, as before");
  /* the root cause for "only works when the whole list is entered": as TEXT, a list needle never matched */
  assert.equal(routed(zipFlowSurvey("string", "contains", "10001, 10003")), "p_miss", "legacy contains: the whole needle must appear as written");
  /* and the parser writes the same rule the builder does */
  const def = zipFlowSurvey("string", "containsItem", "10003");
  const parsed = parseLogicExpression(def, 'ed.ZIP_Code_DMA contains item "10001, 10003"');
  assert.ok(parsed.condition, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.condition, { type: "rule", source: { kind: "embedded", ref: "ZIP_Code_DMA" }, operator: "containsItem", value: "10001, 10003" });
  assert.equal(formatCondition(def, parsed.condition!), 'ed.ZIP_Code_DMA contains item "10001, 10003"', "round trip");
  const nl = conditionFromText(def, "ed.ZIP_Code_DMA contains the item 10003");
  assert.equal((nl.condition as ConditionRule)?.operator, "containsItem", `plain words: ${JSON.stringify(nl)}`);
  const nlNot = conditionFromText(def, "ed.ZIP_Code_DMA doesn't include item 10003");
  assert.equal((nlNot.condition as ConditionRule)?.operator, "notContainsItem", `plain words: ${JSON.stringify(nlNot)}`);
  const zero = parseLogicExpression(def, "ed.ZIP_Code_DMA contains item 02108");
  assert.equal((zero.condition as ConditionRule).value, "02108", "a leading zero survives the expression editor");
});

/* ============================================================ 3. every operator, per type */

test("every curated operator per question type — TRUE and FALSE cases through evaluateCondition", () => {
  const def = survey();
  const cases: [string, Condition, Record<string, unknown>, Record<string, unknown>][] = [
    /* single select */
    ["single =", rule({ ref: "q1" }, "eq", "1"), { q1: "1" }, { q1: "2" }],
    ["single ≠", rule({ ref: "q1" }, "ne", "1"), { q1: "2" }, { q1: "1" }],
    ["single in", rule({ ref: "q1" }, "in", ["1", "2"]), { q1: "2" }, { q1: "3" }],
    ["single not in", rule({ ref: "q1" }, "notIn", ["1", "2"]), { q1: "3" }, { q1: "1" }],
    ["single answered", rule({ ref: "q1" }, "answered"), { q1: "3" }, {}],
    ["single unanswered", rule({ ref: "q1" }, "unanswered"), {}, { q1: "3" }],
    /* multi select */
    ["multi has selected", rule({ ref: "q2" }, "selected", "a"), { q2: ["a", "b"] }, { q2: ["b"] }],
    ["multi hasn't selected", rule({ ref: "q2" }, "notSelected", "a"), { q2: ["b"] }, { q2: ["a"] }],
    ["multi any of", rule({ ref: "q2" }, "containsAny", ["a", "c"]), { q2: ["c"] }, { q2: ["b"] }],
    ["multi all of", rule({ ref: "q2" }, "containsAll", ["a", "c"]), { q2: ["a", "b", "c"] }, { q2: ["a"] }],
    ["multi none of", rule({ ref: "q2" }, "containsNone", ["a", "c"]), { q2: ["b"] }, { q2: ["a"] }],
    ["multi exactly", rule({ ref: "q2" }, "containsExactly", ["a", "c"]), { q2: ["c", "a"] }, { q2: ["a", "b", "c"] }],
    ["multi exactly (subset)", rule({ ref: "q2" }, "containsExactly", ["a", "c"]), { q2: ["a", "c"] }, { q2: ["a"] }],
    ["multi count =", rule({ ref: "q2", count: { of: "selected", scope: "options" } }, "eq", 2), { q2: ["a", "b"] }, { q2: ["a"] }],
    ["multi count >", rule({ ref: "q2", count: { of: "selected", scope: "options" } }, "gt", 1), { q2: ["a", "b"] }, { q2: ["a"] }],
    ["multi count <", rule({ ref: "q2", count: { of: "selected", scope: "options" } }, "lt", 2), { q2: ["a"] }, { q2: ["a", "b"] }],
    /* numeric */
    ["numeric =", rule({ ref: "q3" }, "eq", "5"), { q3: 5 }, { q3: 6 }],
    ["numeric ≠", rule({ ref: "q3" }, "ne", "5"), { q3: 6 }, { q3: 5 }],
    ["numeric >", rule({ ref: "q3" }, "gt", "5"), { q3: 6 }, { q3: 5 }],
    ["numeric ≥", rule({ ref: "q3" }, "gte", "5"), { q3: 5 }, { q3: 4 }],
    ["numeric <", rule({ ref: "q3" }, "lt", "5"), { q3: 4 }, { q3: 5 }],
    ["numeric ≤", rule({ ref: "q3" }, "lte", "5"), { q3: 5 }, { q3: 6 }],
    ["numeric between", rule({ ref: "q3" }, "between", "10", "20"), { q3: 20 }, { q3: 21 }],
    ["numeric not between", rule({ ref: "q3" }, "notBetween", "10", "20"), { q3: 9 }, { q3: 10 }],
    /* text */
    ["text =", rule({ ref: "q4" }, "eq", "yes"), { q4: "yes" }, { q4: "no" }],
    ["text contains", rule({ ref: "q4" }, "contains", "blue"), { q4: "Light Blue" }, { q4: "red" }],
    ["text doesn't contain", rule({ ref: "q4" }, "notContains", "blue"), { q4: "red" }, { q4: "blue" }],
    ["text starts with", rule({ ref: "q4" }, "startsWith", "ab"), { q4: "abc" }, { q4: "cab" }],
    ["text ends with", rule({ ref: "q4" }, "endsWith", "bc"), { q4: "abc" }, { q4: "bca" }],
    ["text is one of", rule({ ref: "q4" }, "in", ["10001", "10002"]), { q4: "10002" }, { q4: "110002" }],
    ["text regex", rule({ ref: "q4" }, "matches", "^[0-9]{5}$"), { q4: "10002" }, { q4: "1002" }],
    /* single grid: row is / any row is / row in list */
    ["grid row is", rule({ ref: "q5", rowCode: "r1", columnId: "3" }, "selected"), { q5: { r1: "3", r2: "1" } }, { q5: { r1: "1", r2: "3" } }],
    ["grid row is not", rule({ ref: "q5", rowCode: "r1", columnId: "3" }, "notSelected"), { q5: { r1: "1" } }, { q5: { r1: "3" } }],
    ["grid any row is", rule({ ref: "q5", columnId: "3" }, "selected"), { q5: { r1: "1", r2: "3" } }, { q5: { r1: "1", r2: "2" } }],
    ["grid row in list", rule({ ref: "q5", rowCode: "r2" }, "in", ["2", "3"]), { q5: { r2: "2" } }, { q5: { r2: "1" } }],
    ["grid row ≥", rule({ ref: "q5", rowCode: "r2" }, "gte", "2"), { q5: { r2: "3" } }, { q5: { r2: "1" } }],
    ["grid row answered", rule({ ref: "q5", rowCode: "r2" }, "answered"), { q5: { r2: "3" } }, { q5: { r1: "1" } }],
    /* multi grid */
    ["multi grid row has selected", rule({ ref: "q6", rowCode: "r1", columnId: "b" }, "selected"), { q6: { r1: ["a", "b"] } }, { q6: { r1: ["a"] } }],
    ["multi grid row any of", rule({ ref: "q6", rowCode: "r1" }, "containsAny", ["b"]), { q6: { r1: ["b"] } }, { q6: { r1: ["a"] } }],
    /* numeric grid */
    ["numeric grid row >", rule({ ref: "q7", rowCode: "r2" }, "gt", 2), { q7: { r1: 1, r2: 3 } }, { q7: { r1: 9, r2: 1 } }],
    /* constant sum: field */
    ["constant sum field =", rule({ ref: "q8", rowCode: "1" }, "eq", 60), { q8: { 1: 60, 2: 40 } }, { q8: { 1: 40, 2: 60 } }],
    ["constant sum field between", rule({ ref: "q8", rowCode: "2" }, "between", 30, 50), { q8: { 1: 60, 2: 40 } }, { q8: { 1: 40, 2: 60 } }],
    /* ranking */
    ["ranked at position", rule({ ref: "q9" }, "rankEquals", "y", 2), { q9: ["x", "y", "z"] }, { q9: ["y", "x", "z"] }],
    ["ranked above", rule({ ref: "q9" }, "rankLessThan", "z", 3), { q9: ["z", "x"] }, { q9: ["x", "y", "z"] }],
    ["ranked below", rule({ ref: "q9" }, "rankGreaterThan", "x", 1), { q9: ["y", "x"] }, { q9: ["x", "y"] }],
    ["is ranked", rule({ ref: "q9" }, "contains", "z"), { q9: ["z"] }, { q9: ["x"] }],
    ["is not ranked", rule({ ref: "q9" }, "notRanked", "z"), { q9: ["x"] }, { q9: ["z"] }],
    ["ranked top N", rule({ ref: "q9" }, "rankedTopN", "z", 2), { q9: ["x", "z"] }, { q9: ["x", "y", "z"] }],
    /* MaxDiff */
    ["most preferred, any task", rule({ ref: "q10", columnId: "best" }, "eq", "2"), { q10: { 1: { best: "1", worst: "3" }, 2: { best: "2" } } }, { q10: { 1: { best: "1" } } }],
    ["never most preferred", rule({ ref: "q10", columnId: "best" }, "ne", "2"), { q10: { 1: { best: "1" } } }, { q10: { 1: { best: "2" } } }],
    ["least preferred in task 1", rule({ ref: "q10", rowCode: "1", columnId: "worst" }, "eq", "3"), { q10: { 1: { best: "1", worst: "3" } } }, { q10: { 1: { best: "3", worst: "1" } } }],
    /* date */
    ["date on", rule({ ref: "q11" }, "dateEquals", "2026-03-01"), { q11: "2026-03-01" }, { q11: "2026-03-02" }],
    ["date not on", rule({ ref: "q11" }, "ne", "2026-03-01"), { q11: "2026-03-02" }, { q11: "2026-03-01" }],
    ["date before", rule({ ref: "q11" }, "dateBefore", "2026-03-01"), { q11: "2026-02-28" }, { q11: "2026-03-01" }],
    ["date after", rule({ ref: "q11" }, "dateAfter", "2026-03-01"), { q11: "2026-03-02" }, { q11: "2026-03-01" }],
    ["date on or before", rule({ ref: "q11" }, "lte", "2026-03-01"), { q11: "2026-03-01" }, { q11: "2026-03-02" }],
    ["date on or after", rule({ ref: "q11" }, "gte", "2026-03-01"), { q11: "2026-03-01" }, { q11: "2026-02-28" }],
    ["date between", rule({ ref: "q11" }, "dateBetween", "2026-01-01", "2026-12-31"), { q11: "2026-06-01" }, { q11: "2027-01-01" }],
    ["date not between", rule({ ref: "q11" }, "notBetween", "2026-01-01", "2026-12-31"), { q11: "2027-01-01" }, { q11: "2026-06-01" }],
    /* time */
    ["time at", rule({ ref: "q12" }, "eq", "09:30"), { q12: "09:30" }, { q12: "09:31" }],
    ["time before", rule({ ref: "q12" }, "lt", "12:00"), { q12: "09:30" }, { q12: "13:00" }],
    ["time after", rule({ ref: "q12" }, "gt", "12:00"), { q12: "13:00" }, { q12: "09:30" }],
    ["time between", rule({ ref: "q12" }, "between", "09:00", "17:00"), { q12: "12:00" }, { q12: "18:00" }],
    /* file upload */
    ["has uploaded", rule({ ref: "q13" }, "answered"), { q13: { url: "u", name: "a.pdf", size: 10, type: "application/pdf" } }, {}],
    ["has not uploaded", rule({ ref: "q13" }, "unanswered"), {}, { q13: { url: "u", name: "a.pdf" } }],
    /* ratings */
    ["NPS ≥ 9", rule({ ref: "q14" }, "gte", "9"), { q14: 10 }, { q14: 8 }],
    ["stars between", rule({ ref: "q15" }, "between", "4", "5"), { q15: "4" }, { q15: "3" }],
    ["label rating =", rule({ ref: "q16" }, "eq", "hi"), { q16: "hi" }, { q16: "lo" }],
    /* embedded data by type */
    ["ED boolean is true", rule({ kind: "embedded", ref: "PANEL" }, "eq", true), {}, {}],
  ];
  for (const [name, c, yes, no] of cases) {
    if (name === "ED boolean is true") {
      assert.equal(holds(def, c, {}, { PANEL: true }), true, name);
      assert.equal(holds(def, c, {}, { PANEL: false }), false, name);
      assert.equal(holds(def, rule({ kind: "embedded", ref: "PANEL" }, "eq", false), {}, { PANEL: false }), true, "is false");
      assert.equal(holds(def, rule({ kind: "embedded", ref: "PANEL" }, "answered"), {}, { PANEL: false }), true, "is set");
      assert.equal(holds(def, rule({ kind: "embedded", ref: "PANEL" }, "unanswered"), {}, {}), true, "is not set");
      continue;
    }
    assert.equal(holds(def, c, yes), true, `${name}: TRUE case`);
    assert.equal(holds(def, c, no), false, `${name}: FALSE case`);
  }
  /* numeric and string embedded fields */
  assert.equal(holds(def, rule({ kind: "embedded", ref: "SCORE" }, "between", 10, 20), {}, { SCORE: 15 }), true);
  assert.equal(holds(def, rule({ kind: "embedded", ref: "SEGMENT" }, "eq", "panel"), {}, { SEGMENT: "panel" }), true);
});

/* ============================================================ 4. menus: types, groups, defaults */

test("operatorMenu: the type, the default and the groups for each kind of source", () => {
  const def = survey();
  const m = (source: Record<string, unknown>) => operatorMenu(def, { kind: "question", ...source } as never);
  const ids = (menu: ReturnType<typeof m>) => menu.entries.map((x) => x.id);
  const expect: [Record<string, unknown>, string, string][] = [
    [{ ref: "q1" }, "single", "eq"],
    [{ ref: "q2" }, "multi", "selected"],
    [{ ref: "q3" }, "numeric", "eq"],
    [{ ref: "q4" }, "text", "eq"],
    [{ ref: "q5" }, "grid_single", "selected"],
    [{ ref: "q6" }, "grid_multi", "selected"],
    [{ ref: "q7" }, "grid_numeric", "eq"],
    [{ ref: "q8" }, "constant_sum", "eq"],
    [{ ref: "q9" }, "ranking", "rankEquals"],
    [{ ref: "q10" }, "maxdiff", "best:eq"],
    [{ ref: "q11" }, "date", "dateEquals"],
    [{ ref: "q12" }, "time", "eq"],
    [{ ref: "q13" }, "file", "answered"],
    [{ ref: "q14" }, "rating_numeric", "eq"],
    [{ ref: "q15" }, "rating_numeric", "eq"],
    [{ ref: "q16" }, "rating_label", "eq"],
    [{ kind: "embedded", ref: "ZIP_Code_DMA" }, "list", "containsItem"],
    [{ kind: "embedded", ref: "PANEL" }, "boolean", "isTrue"],
    [{ kind: "embedded", ref: "SCORE" }, "numeric", "eq"],
    [{ kind: "embedded", ref: "SEGMENT" }, "text", "eq"],
  ];
  for (const [src, type, def0] of expect) {
    const menu = m(src);
    assert.equal(menu.type, type, `${JSON.stringify(src)} type`);
    assert.equal(menu.defaultEntry?.id, def0, `${JSON.stringify(src)} default`);
  }
  /* single select: only its own operators — no >, <, between or contains for a categorical answer */
  const single = ids(m({ ref: "q1" }));
  assert.deepEqual(single, ["eq", "ne", "in", "notIn", "displayed", "notDisplayed", "answered", "unanswered"]);
  /* multi select: its groups */
  const multi = m({ ref: "q2" });
  assert.deepEqual(multi.groups.map((g) => g.id), ["primary", "count", "display", "status"]);
  assert.ok(!ids(multi).includes("eq"), "Equals is not a multi-select operator");
  assert.deepEqual(multi.groups.find((g) => g.id === "count")!.entries.map((x) => x.id), ["count:eq", "count:gt", "count:gte", "count:lt", "count:lte"]);
  assert.deepEqual(multi.groups.find((g) => g.id === "status")!.entries.map((x) => x.label), ["is answered", "is unanswered"]);
  /* numeric: between takes two values */
  assert.equal(m({ ref: "q3" }).entries.find((x) => x.op === "between")!.value, "numberRange");
  /* grids show a row selector */
  assert.equal(m({ ref: "q5" }).rowSelector, "row");
  assert.equal(m({ ref: "q8" }).rowSelector, "field");
  assert.equal(m({ ref: "q10" }).rowSelector, "task");
  /* the ED list: item vs text, explicit */
  const list = operatorMenu(def, { kind: "embedded", ref: "ZIP_Code_DMA" });
  assert.equal(list.typeLabel, "Embedded data — list");
  assert.ok(list.entries.find((x) => x.id === "containsItem")!.hint!.includes("110001"));
  assert.ok(list.entries.find((x) => x.id === "contains")!.label === "contains text");
  assert.ok(!list.entries.some((x) => x.op.startsWith("rank") || x.op === "displayed"));
  /* a count is a number */
  assert.deepEqual(operatorMenu(def, { kind: "question", ref: "q2", count: { of: "selected", scope: "options" } } as never).entries.map((x) => x.op).sort(),
    ["between", "eq", "gt", "gte", "lt", "lte", "ne"].sort());
});

test("every menu entry is an operator the linter accepts for that source — a menu-built rule is never a lint error", () => {
  const def = survey();
  for (const qq of def.questions) {
    const menu = operatorMenu(def, { kind: "question", ref: qq.id });
    const valid = new Set([...operatorsForQuestion(qq), ...gridCellOperators(qq)]);
    for (const x of menu.entries) {
      if (x.group === "count") continue;
      assert.ok(valid.has(x.op), `${qq.code} (${qq.type}) offers ${x.id}, which the linter refuses`);
      const built = applyOperatorEntry({ type: "rule", source: { kind: "question", ref: qq.id }, operator: "eq", value: "" }, x);
      assert.equal(operatorStatus(def, built).status, "ok", `${qq.code} ${x.id} reads back as itself`);
      assert.equal(entryForRule(menu, built)?.id, x.id);
    }
  }
});

test("applyOperatorEntry: count entries add the count, presets fill the value, a different value kind clears it", () => {
  const def = survey();
  const menu = operatorMenu(def, { kind: "question", ref: "q2" });
  const base: ConditionRule = { type: "rule", source: { kind: "question", ref: "q2" }, operator: "selected", value: "a" };
  const counted = applyOperatorEntry(base, menu.entries.find((x) => x.id === "count:gte")!, menu.entries[0]);
  assert.deepEqual([counted.operator, counted.source.count, counted.value], ["gte", { of: "selected", scope: "options" }, 1]);
  const back = applyOperatorEntry(counted, menu.entries.find((x) => x.id === "selected")!, menu.entries.find((x) => x.id === "count:gte"));
  assert.equal(back.source.count, undefined, "leaving the count group drops the count");
  const keep = applyOperatorEntry(base, menu.entries.find((x) => x.id === "notSelected")!, menu.entries[0]);
  assert.equal(keep.value, "a", "has selected → hasn't selected keeps the option");
  const list = applyOperatorEntry(base, menu.entries.find((x) => x.id === "containsAny")!, menu.entries[0]);
  assert.deepEqual(list.value, [], "one option → a list of options starts empty");
  const bool = operatorMenu(def, { kind: "embedded", ref: "PANEL" });
  assert.equal(applyOperatorEntry({ type: "rule", source: { kind: "embedded", ref: "PANEL" }, operator: "eq" }, bool.entries.find((x) => x.id === "isFalse")!).value, false);
  const md = operatorMenu(def, { kind: "question", ref: "q10" });
  assert.equal(applyOperatorEntry({ type: "rule", source: { kind: "question", ref: "q10" }, operator: "eq" }, md.entries.find((x) => x.id === "worst:eq")!).source.columnId, "worst");
});

/* ============================================================ 5. invalid after a type change */

test("a source whose type changed: the rule is marked NEEDS UPDATE, kept as written, and blocks deployment", () => {
  const withRule = (type: string) => SurveyDefinition.parse({
    meta: { id: "tc", code: "T", title: "T", version: "1" },
    questions: [
      q("qs", type, { options: [opt("a", "A"), opt("b", "B")] }),
      q("qt", "single_select", { options: [opt("1", "Yes")], displayLogic: { type: "rule", source: { kind: "question", ref: "qs" }, operator: "containsAny", value: ["a"] } }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["qs"] }, { type: "page", id: "p2", questionIds: ["qt"] }, { type: "end", id: "e", status: "complete" }],
  });
  const before = withRule("multi_select");
  const r = before.questions[1].displayLogic as ConditionRule;
  assert.equal(operatorStatus(before, r).status, "ok");
  assert.ok(!lintSurveyLogic(before).some((i) => i.level === "error" && /needs updating/.test(i.message)));

  const after = withRule("numeric");
  const stale = after.questions[1].displayLogic as ConditionRule;
  assert.equal(stale.operator, "containsAny", "the stored operator is not replaced");
  const status = operatorStatus(after, stale);
  assert.equal(status.status, "needsUpdate");
  const errors = lintSurveyLogic(after).filter((i) => i.level === "error" && /needs updating/.test(i.message));
  assert.equal(errors.length, 1, "an error-level lint");
  const gate = runQualityCheck(after);
  assert.equal(gate.deployable, false, "the deploy gate refuses it");
  /* the menu offers the numeric operators to choose from */
  assert.equal(operatorMenu(after, stale.source).type, "numeric");
});

test("an embedded field with a ranking or display operator needs updating; a valid-but-uncurated operator is 'other', not broken", () => {
  const def = survey();
  const ed = rule({ kind: "embedded", ref: "SEGMENT" }, "rankedFirst", "x");
  assert.equal(operatorStatus(def, ed).status, "needsUpdate");
  const withEd = survey({ questions: [...survey().questions, q("qz", "open_text", { displayLogic: ed })] });
  assert.ok(lintSurveyLogic(withEd).some((i) => i.level === "error" && /embedded field SEGMENT/.test(i.message)));
  /* `Q1 > 2` on a single select: not offered any more, still valid, evaluates as before */
  const legacy = rule({ ref: "q1" }, "gt", "2");
  assert.equal(operatorStatus(def, legacy).status, "other");
  assert.equal(holds(def, legacy, { q1: "3" }), true);
});

/* ============================================================ 6. sentences and the test control */

test("ruleSentence: a plain sentence for one rule", () => {
  const def = survey();
  assert.equal(ruleSentence(def, rule({ ref: "q1" }, "in", ["1", "2"])), "the respondent selects “Tea” or “Coffee” at Q1");
  assert.equal(ruleSentence(def, rule({ ref: "q2" }, "containsAll", ["a", "c"])), "the respondent selects all of “Apple” and “Cherry” at Q2");
  assert.equal(ruleSentence(def, rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, "containsItem", "10005")), "ZIP_Code_DMA contains the item “10005”");
  assert.equal(ruleSentence(def, rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, "containsItem", "10001, 10003")), "ZIP_Code_DMA contains any of the items “10001” or “10003”");
  assert.equal(ruleSentence(def, rule({ ref: "q3" }, "between", "10", "20")), "Q3 is between 10 and 20");
  assert.equal(ruleSentence(def, rule({ ref: "q9" }, "rankEquals", "y", 2)), "“Y” is ranked at position 2 at Q9");
  assert.equal(ruleSentence(def, rule({ ref: "q5", rowCode: "r1", columnId: "3" }, "selected")), "Q5 “Service” is “Good”");
  assert.equal(ruleSentence(def, rule({ ref: "q2", count: { of: "selected", scope: "options" } }, "gte", 2)), "the number selected at Q2 is at least 2");
  assert.equal(ruleSentence(def, rule({ kind: "embedded", ref: "PANEL" }, "eq", true)), "PANEL is true");
  assert.equal(
    conditionSentence(def, { type: "group", op: "and", children: [rule({ ref: "q1" }, "in", ["1", "2"]), rule({ ref: "q3" }, "gte", "18")] }, "Display Q4 if"),
    "Display Q4 if the respondent selects “Tea” or “Coffee” at Q1 and Q3 is at least 18.",
  );
});

test("Test condition: typed answers, the real evaluator, TRUE / FALSE", () => {
  const def = survey();
  const c: Condition = { type: "group", op: "and", children: [
    rule({ ref: "q1" }, "in", ["1", "2"]),
    rule({ kind: "embedded", ref: "ZIP_Code_DMA" }, "containsItem", "10003"),
    rule({ ref: "q5", rowCode: "r1" }, "gte", "2"),
  ] };
  const inputs = conditionTestInputs(def, c);
  assert.deepEqual(inputs.map((i) => i.key), ["q:q1", "embedded:ZIP_Code_DMA", "q:q5[r1]"]);
  assert.equal(inputs[0].choices?.length, 3);
  assert.equal(evaluateWithTestInputs(def, c, { "q:q1": "2", "embedded:ZIP_Code_DMA": ZIPS, "q:q5[r1]": "3" }).result, true);
  assert.equal(evaluateWithTestInputs(def, c, { "q:q1": "3", "embedded:ZIP_Code_DMA": ZIPS, "q:q5[r1]": "3" }).result, false);
  assert.equal(evaluateWithTestInputs(def, c, { "q:q1": "2", "embedded:ZIP_Code_DMA": "10001, 10009", "q:q5[r1]": "3" }).result, false);
  const multi = rule({ ref: "q2", count: { of: "selected", scope: "options" } }, "gte", 2);
  assert.equal(evaluateWithTestInputs(def, multi, { "q:q2": "a, c" }).result, true);
  assert.equal(evaluateWithTestInputs(def, multi, { "q:q2": "a" }).result, false);
  const r = evaluateWithTestInputs(def, rule({ ref: "q3" }, "between", 10, 20), { "q:q3": "15" });
  assert.equal(r.result, true);
  assert.equal(r.trace.length, 1, "the trace says what was compared");
});

test("operandTypeOf: sources other than questions", () => {
  const def = survey();
  assert.equal(operandTypeOf(def, { kind: "loop", ref: "index" } as never), "numeric");
  assert.equal(operandTypeOf(def, { kind: "loop", ref: "first" } as never), "boolean");
  assert.equal(operandTypeOf(def, { kind: "calculation", ref: "X" } as never), "any");
  assert.equal(operandTypeOf(def, { kind: "question", ref: "ZIP_Code_DMA" } as never), "list", "a bare name resolving to the field");
});
