import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { authoringQuestionView, createResponseState, type EvalContext } from "./index.js";

/**
 * `authoringQuestionView` — the shared, design-time-or-live resolver behind
 * the Condition Builder, Count Editor, Live Canvas and every other
 * design-time list a carry-forward question needs to expose (P0 dynamic
 * option / carry-forward fix).
 */

function minimalDef(questions: Record<string, unknown>[]) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T", version: "1.0" },
    questions,
    flow: [
      { type: "page", id: "p1", questionIds: questions.map((q) => q.id as string) },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("authoringQuestionView: a question with no carry-forward is returned unchanged", () => {
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "Pick",
      options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }] },
  ]);
  const q1 = def.questions[0];
  const view = authoringQuestionView(q1, def);
  assert.equal(view, q1, "identical reference — zero cost, zero behavior change for ordinary questions");
});

test("authoringQuestionView: a single carry-forward hop resolves labels and tags source identity", () => {
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "Pick",
      options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" }] },
    { id: "q2", code: "Q2", variableName: "Q2V", type: "composite", text: "Matrix",
      carryForward: { sourceQuestionId: "q1", filter: "selected", into: "rows" },
      columns: [{ id: "c1", label: "Col", responseType: "text", variableStem: "C1" }] },
  ]);
  const q2 = def.questions.find((q) => q.id === "q2")!;
  const view = authoringQuestionView(q2, def);
  assert.deepEqual(view.rows.map((r) => r.label), ["Apple", "Samsung", "Google"],
    "with no answer yet, the design-time fallback shows the SOURCE's full list — the items that will arrive");
  assert.deepEqual(view.rows.map((r) => r.sourceQuestionId), ["q1", "q1", "q1"]);
  assert.deepEqual(view.rows.map((r) => r.sourceCode), [1, 2, 3]);
});

test("authoringQuestionView: a 3-deep chain still resolves real labels, not bare codes", () => {
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "Pick",
      options: [{ code: "a", label: "Apple" }, { code: "b", label: "Bosch" }] },
    { id: "q2", code: "Q2", variableName: "Q2V", type: "multi_select", text: "Narrow",
      carryForward: { sourceQuestionId: "q1", filter: "all", into: "options" } },
    { id: "q3", code: "Q3", variableName: "Q3V", type: "single_select", text: "Pick one",
      carryForward: { sourceQuestionId: "q2", filter: "all", into: "options" } },
    { id: "q4", code: "Q4", variableName: "Q4V", type: "composite", text: "Matrix",
      carryForward: { sourceQuestionId: "q3", filter: "all", into: "rows" },
      columns: [{ id: "c1", label: "Col", responseType: "text", variableStem: "C1" }] },
  ]);
  const q4 = def.questions.find((q) => q.id === "q4")!;
  const view = authoringQuestionView(q4, def);
  assert.deepEqual(view.rows.map((r) => r.label), ["Apple", "Bosch"],
    "three hops deep (q4 <- q3 <- q2 <- q1), the real labels survive");
  assert.deepEqual(view.rows.map((r) => r.sourceQuestionId), ["q1", "q1"],
    "identity traces all the way back to the ORIGINAL source, not the immediate one (q3)");
});

test("authoringQuestionView: a live, non-empty ctx wins over the static design-time fallback", () => {
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "Pick",
      options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" }] },
    { id: "q2", code: "Q2", variableName: "Q2V", type: "composite", text: "Matrix",
      carryForward: { sourceQuestionId: "q1", filter: "selected", into: "rows" },
      columns: [{ id: "c1", label: "Col", responseType: "text", variableStem: "C1" }] },
  ]);
  const q2 = def.questions.find((q) => q.id === "q2")!;
  const state = createResponseState(def, { seed: 1 });
  state.answers["q1"] = [2]; // respondent selected only Samsung
  const ctx: EvalContext = { def, state };

  const view = authoringQuestionView(q2, def, ctx);
  assert.deepEqual(view.rows.map((r) => r.label), ["Samsung"],
    "the REAL, live carried set (what this respondent actually selected) wins over the design-time fallback");
});

test("authoringQuestionView: an empty live answer falls back to the design-time list, not an empty grid", () => {
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "Pick",
      options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }] },
    { id: "q2", code: "Q2", variableName: "Q2V", type: "composite", text: "Matrix",
      carryForward: { sourceQuestionId: "q1", filter: "selected", into: "rows" },
      columns: [{ id: "c1", label: "Col", responseType: "text", variableStem: "C1" }] },
  ]);
  const q2 = def.questions.find((q) => q.id === "q2")!;
  const state = createResponseState(def, { seed: 1 }); // q1 not yet answered
  const ctx: EvalContext = { def, state };

  const view = authoringQuestionView(q2, def, ctx);
  assert.deepEqual(view.rows.map((r) => r.label), ["Apple", "Samsung"],
    "no answer yet is the normal state while programming — the programmer still sees a clickable grid");
});

test("authoringQuestionView: a cyclic carry-forward configuration terminates instead of recursing forever", () => {
  // A misconfigured pair — Q1 carries from Q2, Q2 carries from Q1. Studio's
  // detectLogicCycles blocks this at authoring time; this is the runtime
  // backstop that guarantees this resolver always returns rather than
  // recursing until the stack overflows.
  const def = minimalDef([
    { id: "q1", code: "Q1", variableName: "Q1V", type: "multi_select", text: "A",
      carryForward: { sourceQuestionId: "q2", filter: "all", into: "options" } },
    { id: "q2", code: "Q2", variableName: "Q2V", type: "multi_select", text: "B",
      carryForward: { sourceQuestionId: "q1", filter: "all", into: "options" } },
  ]);
  const q1 = def.questions.find((q) => q.id === "q1")!;
  assert.doesNotThrow(() => authoringQuestionView(q1, def));
});
