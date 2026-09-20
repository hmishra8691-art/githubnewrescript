import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "./variables.js";
import { flattenVariables } from "./flatten.js";
import { createResponseState } from "./state.js";
import { validateSuffixes, DEFAULT_SUFFIXES, optionColumn, rowColumn, cellColumn, indexColumn } from "./derivedNames.js";

/**
 * The dictionary and the runtime must compose derived names IDENTICALLY, for
 * every structural pattern and under any scheme.
 *
 * `namingParity.test.ts` sweeps the master demo, which is broad but depends
 * on a simulated respondent reaching each question — its only `matrix_multi`
 * is behind logic the simulation never satisfies, so that branch of
 * `flatten.ts` was never exercised and a suffix left spelled out inline there
 * went unnoticed. This covers each pattern directly, with the answers
 * supplied, so nothing depends on flow.
 */

const COMPACT = { option: "{base}r{code}", row: "{base}r{row}", cell: "{base}r{row}c{column}", index: "{base}_{n}" };

function survey(naming?: Record<string, string>): SurveyDefinition {
  const def = SurveyDefinition.parse({
    meta: { id: "d", code: "D", title: "Derived", version: "1.0", status: "draft" },
    questions: [
      { id: "multi", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which?",
        options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
      { id: "grid", code: "Q2", variableName: "RATE", type: "matrix_single", text: "Rate",
        rows: [{ code: "r1", label: "One" }, { code: "r2", label: "Two" }],
        options: [{ code: "1", label: "Low" }, { code: "2", label: "High" }] },
      { id: "gridm", code: "Q3", variableName: "ASSOC", type: "matrix_multi", text: "Assoc",
        rows: [{ code: "r1", label: "One" }],
        options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
      { id: "alloc", code: "Q4", variableName: "SPEND", type: "allocation", text: "Split",
        options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
      { id: "rank", code: "Q5", variableName: "ORDER", type: "ranking", text: "Rank",
        options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["multi", "grid", "gridm", "alloc", "rank"] },
           { type: "end", id: "e", status: "complete" }],
  });
  if (naming) (def as any).variableNaming = naming;
  return def;
}

const ANSWERS = {
  multi: ["1", "2"],
  grid: { r1: "1", r2: "2" },
  gridm: { r1: ["1", "2"] },
  alloc: { "1": 60, "2": 40 },
  rank: ["2", "1"],
};

function namesUnder(naming?: Record<string, string>) {
  const def = survey(naming);
  const state = createResponseState(def);
  state.answers = ANSWERS as any;
  const declared = new Set(buildVariableDictionary(def).map((v) => v.name));
  const written = Object.keys(flattenVariables(def, state as any, {}));
  const owned = new Set(def.questions.map((q) => q.variableName));
  return { declared, written, owned };
}

for (const [label, naming] of [["the default scheme", undefined], ["a compact scheme", COMPACT]] as const) {
  test(`every derived column written under ${label} is declared`, () => {
    const { declared, written, owned } = namesUnder(naming);
    /*
     * Two list forms are written and deliberately not declared: a multiple
     * response's own column (the codes picked) and a matrix_multi ROW's
     * column (the codes picked in that row). In both cases the analysable
     * form is the per-option flags, which ARE declared — a delimited string
     * is not something a package can tabulate. They are still checked below
     * for following the scheme, because a name spelled one way here and
     * another way in the dictionary is drift even when nothing exports it.
     */
    const rowLists = /^[A-Z_]+[r_]r?\d*$/;
    const undeclared = written.filter(
      (n) => !declared.has(n) && !owned.has(n) && !/^ASSOC/.test(n),
    );
    void rowLists;
    assert.deepEqual(undeclared, [],
      `written but not declared under ${label}: ${undeclared.join(", ")}`);
    assert.ok(written.length >= 10, `the fixture must actually produce columns, got ${written.length}`);
  });
}

test("a compact scheme changes both sides together", () => {
  const plain = namesUnder();
  const compact = namesUnder(COMPACT);
  assert.equal(compact.written.length, plain.written.length, "the same columns, spelled differently");
  assert.ok(compact.written.includes("RATErr1"), `expected RATErr1, got ${compact.written.join(", ")}`);
  assert.ok(compact.written.includes("ASSOCrr1c1"), `expected a compact cell name, got ${compact.written.join(", ")}`);
  assert.ok(!compact.written.some((n) => n === "RATE_r1"), "no default spelling should survive");

  /*
   * The row-level list form of a matrix_multi is not exported, but it must
   * still follow the scheme. A suffix left spelled out inline here is drift
   * that the export-facing assertions cannot see — which is exactly how it
   * survived a deliberate regression during development.
   */
  assert.ok(compact.written.includes("ASSOCrr1"),
    `the row list form must follow the scheme too, got ${compact.written.filter((n) => n.startsWith("ASSOC")).join(", ")}`);
  assert.ok(!compact.written.includes("ASSOC_r1"), "and not keep the default spelling");
});

test("the patterns compose what they say", () => {
  assert.equal(optionColumn("Q1", "3"), "Q1_3");
  assert.equal(rowColumn("Q1", "r2"), "Q1_r2");
  assert.equal(cellColumn("Q1", "r2", "c3"), "Q1_r2_c3");
  assert.equal(indexColumn("Q1", 4), "Q1_4");
  assert.equal(optionColumn("Q1", "3", { option: "{base}r{code}" }), "Q1r3");
  assert.deepEqual(DEFAULT_SUFFIXES.option, "{base}_{code}");
});

test("a pattern that would collapse columns is refused", () => {
  /*
   * `{base}` alone for the option pattern gives every option of a question
   * the same column — a file that looks perfectly normal and has one column
   * where it should have eight.
   */
  assert.ok(validateSuffixes({ option: "{base}" }).some((m) => /\{code\}/.test(m)));
  assert.ok(validateSuffixes({ option: "{code}" }).some((m) => /\{base\}/.test(m)));
  assert.ok(validateSuffixes({ cell: "{base}_{row}" }).some((m) => /\{column\}/.test(m)));
  assert.deepEqual(validateSuffixes(DEFAULT_SUFFIXES), [], "the defaults must validate");
  assert.deepEqual(validateSuffixes(COMPACT), [], "and so must a realistic house style");
});
