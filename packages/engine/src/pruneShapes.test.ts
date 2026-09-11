import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { pruneHiddenSelections } from "./visibility.js";

/**
 * PRUNING TOUCHES ONLY WHAT THE OPTION PIPELINE ACTUALLY GOVERNS.
 *
 * The first version of `pruneHiddenSelections` walked any object answer as if
 * its keys were row codes. A `fields` answer — a dynamic list, a repeating
 * group — is an ARRAY OF RECORDS whose rows describe each record's columns,
 * not the answer's keys, so walking it emptied the respondent's list. The
 * browser suite caught it; these tests make sure nothing like it comes back.
 *
 * One case per response model that is NOT a choice: the answer must come out
 * byte-for-byte as it went in, whatever the question's rows and options say.
 */

function survey(q: Question): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Shapes", version: "1.0" },
    questions: [q],
    flow: [{ id: "p1", type: "page", questionIds: [q.id] }],
  });
}
const base = {
  id: "q1", code: "Q1", variableName: "Q1", text: "?",
  options: [], rows: [], columns: [], validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
};

const UNTOUCHED: { name: string; q: Record<string, unknown>; answer: unknown }[] = [
  {
    name: "a dynamic list / repeating group (fields): an array of records",
    q: { ...base, type: "repeating_group", rows: [{ code: "item", label: "Item", flags: [], validation: [], required: false }] },
    answer: [{ item: "Apples" }, { item: "Pears" }],
  },
  {
    name: "a text list (fields), keyed by field code",
    q: { ...base, type: "text_list", rows: [{ code: "a", label: "A", flags: [], validation: [], required: false }] },
    answer: { a: "written by the respondent", b: "a field that no longer exists" },
  },
  { name: "a number", q: { ...base, type: "numeric" }, answer: 42 },
  { name: "an open text", q: { ...base, type: "open_text" }, answer: "free text that names no option" },
  {
    name: "a ranking (rank_order): an ordered list of codes",
    q: { ...base, type: "ranking", options: [{ code: "1", label: "One", flags: [] }] },
    answer: ["1", "2", "3"],
  },
  {
    name: "an allocation: code → number",
    q: { ...base, type: "allocation", options: [{ code: "1", label: "One", flags: [] }] },
    answer: { "1": 50, "2": 50 },
  },
  {
    name: "a numeric grid (per_row with no scale): numbers per row",
    q: { ...base, type: "matrix_numeric", rows: [{ code: "A", label: "A", flags: [], validation: [], required: false }] },
    answer: { A: 7 },
  },
  { name: "a place (geo)", q: { ...base, type: "geo" }, answer: { lat: 51.5, lng: -0.12, address: "London" } },
];

for (const c of UNTOUCHED) {
  test(`pruning leaves ${c.name} exactly as it was`, () => {
    const def = survey(c.q as unknown as Question);
    const st = createResponseState(def, { seed: 1, sessionId: "t" });
    st.answers.q1 = structuredClone(c.answer) as never;
    const before = JSON.stringify(st.answers.q1);
    const removed = pruneHiddenSelections(def, def.questions, { def, state: st });
    assert.deepEqual(removed, [], "nothing is reported as removed");
    assert.equal(JSON.stringify(st.answers.q1), before, "and nothing is");
  });
}

/**
 * A GRID'S TWO AXES ARE PRUNED BY TWO DIFFERENT RULES, AND THEY MUST NOT MEET.
 *
 * Checking a row's VALUE against the option list is right for a Likert grid
 * and catastrophic for a numeric one, which has no option list at all: every
 * slider reading fails a membership test against an empty set. The browser
 * suite caught that too (a carousel judge in slider mode came back empty);
 * these three pin the rule that replaced it.
 */

test("a numeric grid keeps its numbers — even while carrying a scale it no longer answers with", () => {
  /*
   * The shape the browser suite caught: a carousel judge switched from a 1–5
   * choice scale to a slider. The base type becomes matrix_numeric, the old
   * options stay on the question, and the respondent's 6 is a reading — not a
   * selection of an option that has gone away.
   */
  const q = {
    ...base, type: "matrix_numeric",
    options: [
      { code: "1", label: "1", flags: [] }, { code: "2", label: "2", flags: [] },
      { code: "3", label: "3", flags: [] }, { code: "4", label: "4", flags: [] },
      { code: "5", label: "5", flags: [] },
    ],
    rows: [{ code: "1", label: "Item one", flags: [], validation: [], required: false }],
  } as unknown as Question;
  const def = survey(q);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  st.answers.q1 = { 1: 6 } as never;
  const removed = pruneHiddenSelections(def, def.questions, { def, state: st });
  assert.deepEqual(removed, []);
  assert.deepEqual(st.answers.q1, { 1: 6 }, "a slider resting at 6");
});

test("a text grid's typed answer is never measured against an option list", () => {
  const q = {
    ...base, type: "matrix_text",
    options: [{ code: "1", label: "leftover", flags: [] }],
    rows: [{ code: "A", label: "A", flags: [], validation: [], required: false }],
  } as unknown as Question;
  const def = survey(q);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  st.answers.q1 = { A: "whatever the respondent typed" } as never;
  assert.deepEqual(pruneHiddenSelections(def, def.questions, { def, state: st }), []);
  assert.deepEqual(st.answers.q1, { A: "whatever the respondent typed" });
});

test("a row the question does not author is never dropped — it was put there by something this function cannot see", () => {
  const q = {
    ...base, type: "matrix_text",
    rows: [{ code: "A", label: "A", flags: [], validation: [], required: false }],
  } as unknown as Question;
  const def = survey(q);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  // "apple" is how a carried-forward or list-filled row arrives: a code the
  // definition never spells. Deleting it would delete a real answer.
  st.answers.q1 = { A: "typed by the respondent", apple: "also typed by the respondent" } as never;
  const removed = pruneHiddenSelections(def, def.questions, { def, state: st });
  assert.deepEqual(removed, []);
  assert.deepEqual(st.answers.q1, { A: "typed by the respondent", apple: "also typed by the respondent" });
});

test("an authored row the pipeline has since hidden does go, and takes only itself", () => {
  const q = {
    ...base, type: "matrix_single",
    options: [{ code: "1", label: "Yes", flags: [] }],
    rows: [
      { code: "A", label: "A", flags: [], validation: [], required: false },
      {
        code: "B", label: "B", flags: [], validation: [], required: false,
        visibleIf: { type: "rule", source: { kind: "question", ref: "Q9" }, operator: "answered" },
      },
    ],
  } as unknown as Question;
  const def = survey(q);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  st.answers.q1 = { A: "1", B: "1" } as never;
  const removed = pruneHiddenSelections(def, def.questions, { def, state: st });
  assert.deepEqual(st.answers.q1, { A: "1" });
  assert.deepEqual(removed, [{ questionId: "q1", scope: "row", removed: ["B"] }]);
});
