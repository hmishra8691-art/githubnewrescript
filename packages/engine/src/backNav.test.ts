import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, goBack, setAnswer } from "./flow.js";

/** LOGIC-04: Back returns to the page the respondent came from, not the previous page in compiled order. */
const survey = () => SurveyDefinition.parse({
  meta: { id: "f", code: "F", title: "Flow", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }],
      skipLogic: [{ id: "sk1", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" }, target: { kind: "question", ref: "q4" } }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Which car?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age" },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Anything else" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "page", id: "p4", questionIds: ["q4"] },
    { type: "end", id: "e", status: "complete" },
  ],
});
const at = (r: ReturnType<typeof advance>) => {
  const s = r.steps[r.stepIndex];
  return s?.kind === "page" ? s.pageId : s?.kind;
};

test("skip then Back returns to the page the skip left, not the skipped page before the target", () => {
  const def = survey();
  const st = createResponseState(def);
  assert.equal(at(start(def, st)), "p1");
  setAnswer(def, st, "q1", "2", null);
  assert.equal(at(advance(def, st)), "p4");
  assert.equal(at(goBack(def, st)), "p1");
});

test("Back without skips walks the pages in order, and Forward after Back re-grows the trail", () => {
  const def = survey();
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "1", null);
  assert.equal(at(advance(def, st)), "p2");
  assert.equal(at(advance(def, st)), "p3");
  assert.equal(at(goBack(def, st)), "p2");
  assert.equal(at(goBack(def, st)), "p1");
  setAnswer(def, st, "q1", "2", null);
  assert.equal(at(advance(def, st)), "p4");
  assert.equal(at(goBack(def, st)), "p1");
});

test("Back with an empty trail (a resumed session) falls back to the previous visible page", () => {
  const def = survey();
  const st = createResponseState(def);
  st.stepIndex = 2;
  assert.equal(at(goBack(def, st)), "p2");
});

test("the trail lives in state.meta, not in answers / calculated (never posted or exported)", () => {
  const def = survey();
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", "1", null);
  advance(def, st);
  assert.deepEqual(st.calculated, {});
  assert.ok(Array.isArray(st.meta?.__visited));
});
