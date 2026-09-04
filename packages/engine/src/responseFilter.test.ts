import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { compileResponseFilter, matchesResponseCondition, responseMatchesText, rowToState } from "./responseFilter.js";

/**
 * The response filter's contract, in one sentence per test: the DATABASE
 * prefilter may only ever narrow to a superset, and the VERDICT is the survey
 * engine's. A prefilter that dropped a matching row would silently delete the
 * wrong responses, so every case here checks both halves.
 */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "s", version: "1" },
  questions: [
    { id: "gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
    { id: "age", code: "Q2", variableName: "AGE", type: "numeric", text: "Age" },
    { id: "brands", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }] },
    { id: "grid", code: "Q4", variableName: "GRID", type: "matrix_single", text: "Agree?", rows: [{ code: "r1", label: "One" }, { code: "r2", label: "Two" }], options: [{ code: "1", label: "No" }, { code: "2", label: "Yes" }] },
    { id: "comment", code: "Q5", variableName: "COMMENT", type: "long_text", text: "Why?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["gender", "age", "brands", "grid", "comment"] }, { type: "end", id: "e", status: "complete" }],
});

const row = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  session_id: "sess1", status: "complete", answers, calculated: {}, embedded: {}, flags: [], started_at: "2026-09-01T10:00:00Z", seed: 1, ...extra,
});

const rule = (ref: string, operator: string, value?: unknown, value2?: unknown, kind = "question") =>
  ({ type: "rule" as const, source: { kind, ref } as never, operator: operator as never, value, value2 });
const and = (...children: unknown[]) => ({ type: "group" as const, op: "and" as const, children: children as never[] });
const or = (...children: unknown[]) => ({ type: "group" as const, op: "or" as const, children: children as never[] });

test("an equality on a scalar answer compiles to an exact, index-backed containment test", () => {
  const c = compileResponseFilter(def, rule("gender", "eq", "m"));
  assert.deepEqual(c.clauses, [{ kind: "jsonEq", column: "answers", key: "gender", value: "m" }]);
  assert.equal(c.exact, true, "no engine pass needed — the count is one query");
  // and the verdict agrees
  assert.equal(matchesResponseCondition(def, rule("gender", "eq", "m"), row({ gender: "m" })), true);
  assert.equal(matchesResponseCondition(def, rule("gender", "eq", "m"), row({ gender: "f" })), false);
});

test("an AND of scalar equalities stays exact; every clause is emitted", () => {
  const c = compileResponseFilter(def, and(rule("gender", "eq", "m"), rule("age", "eq", 40)));
  assert.equal(c.clauses.length, 2);
  assert.equal(c.exact, true);
});

test("numeric comparisons narrow but never decide", () => {
  const c = compileResponseFilter(def, rule("age", "gt", 50));
  assert.deepEqual(c.clauses, [{ kind: "compare", column: "answers", key: "age", op: "gt", value: 50 }]);
  assert.equal(c.exact, false, "the text→number cast belongs to the engine, not the query");
  assert.equal(matchesResponseCondition(def, rule("age", "gt", 50), row({ age: 60 })), true);
  assert.equal(matchesResponseCondition(def, rule("age", "gt", 50), row({ age: 50 })), false);
  const b = compileResponseFilter(def, rule("age", "between", 30, 40));
  assert.equal(b.clauses.length, 2);
  assert.equal(matchesResponseCondition(def, rule("age", "between", 30, 40), row({ age: 35 })), true);
  assert.equal(matchesResponseCondition(def, rule("age", "between", 30, 40), row({ age: 41 })), false);
});

test("a multi-select is not narrowed to equality — the engine owns list semantics", () => {
  const c = compileResponseFilter(def, rule("brands", "selected", "b"));
  assert.deepEqual(c.clauses, [{ kind: "hasKey", column: "answers", key: "brands" }], "narrows to 'answered', which no match can fail");
  assert.equal(c.exact, false);
  assert.equal(matchesResponseCondition(def, rule("brands", "selected", "b"), row({ brands: ["a", "b"] })), true);
  assert.equal(matchesResponseCondition(def, rule("brands", "selected", "b"), row({ brands: ["a"] })), false);
});

test("a grid cell and a matrix question emit no equality clause", () => {
  const cell = { type: "rule", source: { kind: "question", ref: "grid", rowCode: "r1" }, operator: "eq", value: "2" } as never;
  assert.deepEqual(compileResponseFilter(def, cell).clauses, [], "a cell is not addressable by question id alone");
  assert.equal(matchesResponseCondition(def, cell, row({ grid: { r1: "2", r2: "1" } })), true);
  assert.equal(matchesResponseCondition(def, cell, row({ grid: { r1: "1", r2: "2" } })), false);
});

test("OR and NOT emit nothing — narrowing a branch would drop matching rows", () => {
  const c = compileResponseFilter(def, or(rule("gender", "eq", "m"), rule("gender", "eq", "f")));
  assert.deepEqual(c.clauses, []);
  assert.equal(c.exact, false);
  assert.match(c.reason ?? "", /OR/);
  assert.equal(matchesResponseCondition(def, or(rule("gender", "eq", "m"), rule("gender", "eq", "f")), row({ gender: "f" })), true);
  const notC = { type: "group", op: "not", children: [rule("gender", "eq", "m")] } as never;
  assert.deepEqual(compileResponseFilter(def, notC).clauses, []);
  assert.equal(matchesResponseCondition(def, notC, row({ gender: "f" })), true);
});

test("negative and unanswered operators emit no clause at all", () => {
  for (const op of ["ne", "notSelected", "unanswered", "notIn", "containsNone", "isEmpty"]) {
    const c = compileResponseFilter(def, rule("gender", op, "m"));
    assert.deepEqual(c.clauses, [], `${op} must not narrow`);
    assert.equal(c.exact, false);
  }
  assert.equal(matchesResponseCondition(def, rule("gender", "ne", "m"), row({ gender: "f" })), true);
  assert.equal(matchesResponseCondition(def, rule("gender", "unanswered"), row({})), true);
  assert.equal(matchesResponseCondition(def, rule("gender", "unanswered"), row({ gender: "m" })), false);
});

test("a nested AND under an OR contributes nothing, and the whole thing still evaluates", () => {
  const c = and(rule("gender", "eq", "m"), or(rule("age", "gt", 50), rule("brands", "selected", "a")));
  const compiled = compileResponseFilter(def, c);
  assert.deepEqual(compiled.clauses, [{ kind: "jsonEq", column: "answers", key: "gender", value: "m" }], "only the safe outer rule narrows");
  assert.equal(compiled.exact, false);
  assert.equal(matchesResponseCondition(def, c, row({ gender: "m", age: 60, brands: [] })), true);
  assert.equal(matchesResponseCondition(def, c, row({ gender: "m", age: 20, brands: ["a"] })), true);
  assert.equal(matchesResponseCondition(def, c, row({ gender: "m", age: 20, brands: ["b"] })), false);
  assert.equal(matchesResponseCondition(def, c, row({ gender: "f", age: 60, brands: ["a"] })), false);
});

test("calculations and embedded data filter on their own columns", () => {
  const c = compileResponseFilter(def, rule("SEGMENT", "eq", "A", undefined, "calculation"));
  assert.deepEqual(c.clauses, [{ kind: "jsonEq", column: "calculated", key: "SEGMENT", value: "A" }]);
  assert.equal(c.exact, true);
  assert.equal(matchesResponseCondition(def, rule("SEGMENT", "eq", "A", undefined, "calculation"), row({}, { calculated: { SEGMENT: "A" } })), true);
  const e = compileResponseFilter(def, rule("source", "eq", "panelX", undefined, "embedded"));
  assert.deepEqual(e.clauses, [{ kind: "jsonEq", column: "embedded", key: "source", value: "panelX" }]);
  assert.equal(matchesResponseCondition(def, rule("source", "eq", "panelX", undefined, "embedded"), row({}, { embedded: { source: "panelX" } })), true);
});

test("no condition matches everything, exactly", () => {
  const c = compileResponseFilter(def, null);
  assert.deepEqual(c.clauses, []);
  assert.equal(c.exact, true);
  assert.equal(matchesResponseCondition(def, null, row({})), true);
  assert.equal(compileResponseFilter(def, and()).exact, true, "an empty AND is not a filter");
});

test("free-text search reaches identifiers and exported variable values, not raw keys", () => {
  const r = row({ gender: "m", comment: "The dealer was helpful" }, { respondent_code: "TEST_000123" });
  assert.equal(responseMatchesText(def, r, "TEST_000123"), true);
  assert.equal(responseMatchesText(def, r, "test_0001"), true, "case-insensitive prefix");
  assert.equal(responseMatchesText(def, r, "dealer"), true, "open-end text");
  assert.equal(responseMatchesText(def, r, "GENDER"), true, "variable name");
  assert.equal(responseMatchesText(def, r, "helpful"), true);
  assert.equal(responseMatchesText(def, r, "nothing here"), false);
  assert.equal(responseMatchesText(def, r, "  "), true, "an empty search filters nothing");
});

test("rowToState carries what the evaluator reads and tolerates missing columns", () => {
  const st = rowToState(def, { session_id: "abc", answers: null, calculated: null, embedded: null, flags: null as never, seed: "7" as never });
  assert.deepEqual(st.answers, {});
  assert.deepEqual(st.flags, []);
  assert.equal(st.seed, 7);
  assert.equal(st.status, "complete", "a row without a status is treated as finished, not in progress");
  assert.equal(st.surveyId, def.meta.id);
});
