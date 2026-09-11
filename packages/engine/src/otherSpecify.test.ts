import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { setAnswer } from "./flow.js";
import { flattenVariables } from "./flatten.js";
import { lintVariables, nextQuestionNaming } from "./variables.js";
import {
  otherKey, otherTextOf, setOtherText, otherIsSelected, syncOtherText, otherSpecifyEntries,
} from "./otherSpecify.js";

/**
 * "OTHER, SPECIFY" — FOUR QUESTIONS, FOUR ANSWERS, NO LEAKS.
 *
 * The reported symptom was text typed into one question's Other box appearing
 * in another's. These tests pin the whole chain that has to hold for that to
 * be impossible: the key each box writes, what happens when the option that
 * opened it is unticked, what the export columns are called, and the naming
 * rule that stops two questions from claiming the same column in the first
 * place.
 */

const select = (id: string, code: string, name: string, type: "single_select" | "multi_select"): Question => ({
  id, code, variableName: name, type, text: `${code} question`,
  options: [
    { code: "1", label: "Option A", flags: [] },
    { code: "2", label: "Option B", flags: [] },
    { code: "99", label: "Other", flags: ["other_specify"] },
  ],
  rows: [], columns: [], validation: [], required: false,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
} as unknown as Question);

function survey(questions: Question[]): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Other specify", version: "1.0" },
    questions,
    flow: [{ id: "p1", type: "page", questionIds: questions.map((q) => q.id) }],
  });
}

test("four questions with an Other option keep four independent texts — single AND multi select", () => {
  const def = survey([
    select("q1", "Q1", "Q1", "single_select"),
    select("q2", "Q2", "Q2", "single_select"),
    select("q3", "Q3", "Q3", "multi_select"),
    select("q4", "Q4", "Q4", "multi_select"),
  ]);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });

  setAnswer(def, st, "q1", "99");
  setAnswer(def, st, "q2", "99");
  setAnswer(def, st, "q3", ["1", "99"]);
  setAnswer(def, st, "q4", ["99"]);
  setOtherText(st, "q1", "Apple");
  setOtherText(st, "q2", "Orange");
  setOtherText(st, "q3", "Mango");
  setOtherText(st, "q4", "Banana");

  // each box reads back exactly what was typed into it
  assert.equal(otherTextOf(st, "q1"), "Apple");
  assert.equal(otherTextOf(st, "q2"), "Orange");
  assert.equal(otherTextOf(st, "q3"), "Mango");
  assert.equal(otherTextOf(st, "q4"), "Banana");

  // and the keys are distinct — the property that makes a leak impossible
  assert.deepEqual(
    ["q1", "q2", "q3", "q4"].map((id) => otherKey(id)),
    ["q1__other", "q2__other", "q3__other", "q4__other"],
  );

  // changing one changes only that one
  setOtherText(st, "q1", "Pear");
  assert.deepEqual(["q1", "q2", "q3", "q4"].map((id) => otherTextOf(st, id)), ["Pear", "Orange", "Mango", "Banana"]);
  setOtherText(st, "q2", "Plum");
  assert.deepEqual(["q1", "q2", "q3", "q4"].map((id) => otherTextOf(st, id)), ["Pear", "Plum", "Mango", "Banana"]);

  // and they land in four separate export columns
  const flat = flattenVariables(def, st);
  assert.equal(flat.Q1_other, "Pear");
  assert.equal(flat.Q2_other, "Plum");
  assert.equal(flat.Q3_other, "Mango");
  assert.equal(flat.Q4_other, "Banana");

  const entries = otherSpecifyEntries(def, st);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.find((e) => e.questionId === "q3"), { questionId: "q3", variableName: "Q3", iteration: "", text: "Mango" });
});

test("the text goes with the selection: unticking Other removes it, through the one door every surface uses", () => {
  const def = survey([select("q1", "Q1", "Q1", "single_select"), select("q2", "Q2", "Q2", "multi_select")]);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  setAnswer(def, st, "q1", "99");
  setOtherText(st, "q1", "Apple");
  setAnswer(def, st, "q2", ["99", "1"]);
  setOtherText(st, "q2", "Mango");

  assert.equal(otherIsSelected(def.questions[0], "99"), true);
  assert.equal(otherIsSelected(def.questions[0], "1"), false);
  assert.equal(otherIsSelected(def.questions[1], ["1", "99"]), true);
  assert.equal(otherIsSelected(def.questions[1], ["1", "2"]), false);

  // the respondent changes their mind on Q1 — the abandoned text goes with it
  setAnswer(def, st, "q1", "1");
  assert.equal(otherTextOf(st, "q1"), "", "abandoned text is not kept");
  assert.equal(st.answers[otherKey("q1")], undefined, "and the key is gone, not blank");
  assert.equal(otherTextOf(st, "q2"), "Mango", "the other question is untouched");

  // Q2 keeps its text while Other is still among the selections
  setAnswer(def, st, "q2", ["99"]);
  assert.equal(otherTextOf(st, "q2"), "Mango");
  setAnswer(def, st, "q2", ["1", "2"]);
  assert.equal(otherTextOf(st, "q2"), "");

  // and an emptied box stores nothing rather than an empty string
  setOtherText(st, "q1", "x"); setOtherText(st, "q1", "");
  assert.equal(st.answers[otherKey("q1")], undefined);
  assert.equal(syncOtherText(st, def.questions[0]), false, "nothing to remove is not a change");
});

test("a loop iteration's Other text belongs to that iteration only", () => {
  const def = survey([select("q1", "Q1", "Q1", "single_select")]);
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  const apple = { loopId: "L", code: "apple", index: 0, parent: null } as never;
  const google = { loopId: "L", code: "google", index: 1, parent: null } as never;
  setOtherText(st, "q1", "for Apple", apple);
  setOtherText(st, "q1", "for Google", google);
  assert.equal(otherTextOf(st, "q1", apple), "for Apple");
  assert.equal(otherTextOf(st, "q1", google), "for Google");
  assert.equal(otherTextOf(st, "q1"), "", "and neither is the un-iterated answer");
  assert.notEqual(otherKey("q1", apple), otherKey("q1", google));
  const entries = otherSpecifyEntries(def, st);
  assert.deepEqual(entries.map((e) => e.iteration).sort(), ["@apple", "@google"]);
});

test("two questions may not claim the same export column — the naming rule, and the lint that catches what is already broken", () => {
  // the bug: Q3 deleted, a new question minted from the COUNT is a second Q3
  const def = survey([select("q1", "Q1", "Q1", "single_select"), select("q2", "Q2", "Q2", "single_select")]);
  const withGap = { ...def, questions: [def.questions[0], { ...def.questions[1], code: "Q3", variableName: "Q3" }] } as SurveyDefinition;
  assert.deepEqual(nextQuestionNaming(withGap), { code: "Q4", variableName: "Q4" }, "the next free name, not the next number");
  assert.deepEqual(nextQuestionNaming(survey([])), { code: "Q1", variableName: "Q1" });

  // an existing survey that already has the collision is reported, in the words that explain the symptom
  const clash = survey([
    select("q1", "Q3", "Q3", "single_select"),
    select("q2", "Q3", "Q3", "single_select"),
  ]);
  const problems = lintVariables(clash);
  assert.ok(problems.some((m) => /Duplicate variable "Q3"/.test(m) && /two different questions are both coded Q3/.test(m)), problems.join(" | "));
  assert.ok(problems.some((m) => /Duplicate variable "Q3_other"/.test(m)), "including the Other column they would share");

  // and with distinct names there is nothing to report
  assert.deepEqual(lintVariables(survey([select("q1", "Q1", "Q1", "single_select"), select("q2", "Q2", "Q2", "single_select")])), []);
});
