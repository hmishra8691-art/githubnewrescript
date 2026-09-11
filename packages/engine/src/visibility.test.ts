import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { compileFlow, visibleQuestions, setAnswer, advance } from "./flow.js";
import { effectiveQuestion } from "./carryforward.js";
import { explainVisibility, explainQuestionVisibility, pruneHiddenSelections } from "./visibility.js";
import { validatePage } from "./validate.js";

/**
 * QUESTION-LEVEL AND OPTION-LEVEL DISPLAY LOGIC ARE NOT PEERS.
 *
 * The question is the parent scope. These tests pin the four statements that
 * follow from that, in the words of the brief: a hidden question's options are
 * unavailable even when their own rule says show; option logic is evaluated
 * only for a visible question; a visible question shows exactly the options
 * that survive; and a selection of something no longer offered stops being a
 * selection.
 */

const opt = (code: string, label: string, extra: Record<string, unknown> = {}) => ({ code, label, flags: [], ...extra });

/** Q0 drives everything; Q1 is the question under test. */
function fixture(opts: {
  questionLogic?: unknown;
  optionB?: unknown;
  type?: "single_select" | "multi_select";
}): SurveyDefinition {
  const q1: Question = {
    id: "q1", code: "Q1", variableName: "Q1", type: opts.type ?? "multi_select", text: "Pick",
    options: [
      opt("A", "Option A"),
      opt("B", "Option B", opts.optionB ? { visibleIf: opts.optionB } : {}),
      opt("C", "Option C"),
    ],
    rows: [], columns: [], validation: [], required: false,
    settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
    ...(opts.questionLogic ? { displayLogic: opts.questionLogic } : {}),
  } as unknown as Question;
  const q0: Question = {
    id: "q0", code: "Q0", variableName: "Q0", type: "single_select", text: "Driver",
    options: [opt("yes", "Yes"), opt("no", "No")],
    rows: [], columns: [], validation: [], required: false,
    settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
  } as unknown as Question;
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Display logic", version: "1.0" },
    questions: [q0, q1],
    flow: [{ id: "p1", type: "page", questionIds: ["q0", "q1"] }],
  });
}

const showsWhenYes = { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" };

test("question hidden + option shown = hidden: option-level logic cannot override the parent scope", () => {
  // Q1 shows only when Q0 = yes; option B shows ALWAYS (a rule that is true no matter what)
  const def = fixture({ questionLogic: showsWhenYes, optionB: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "answered" } });
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  setAnswer(def, st, "q0", "no");

  const steps = compileFlow(def, st, {});
  const page = steps.find((s) => s.kind === "page") as never;

  // the runtime never puts it on the page …
  assert.deepEqual(visibleQuestions(def, page, st).map((q) => q.id), ["q0"], "Q1 is not rendered");

  // … and the explanation says why, for the question AND for every one of its items
  const [, v] = explainVisibility(def, page, st);
  assert.equal(v.code, "Q1");
  assert.equal(v.visible, false);
  assert.equal(v.decidedBy, "display_logic");
  assert.match(v.reason, /Q1 is hidden: its display logic evaluated FALSE/);
  assert.equal(v.items.length, 3, "every authored option is accounted for");
  assert.ok(v.items.every((i) => !i.visible && i.decidedBy === "question_hidden"), "including the one whose own rule says show");
  assert.match(v.items.find((i) => i.ref === "B")!.reason, /Q1 is hidden, so this option is not available/);

  // and the validator is never handed it, so a required hidden question cannot block
  assert.deepEqual(validatePage(def, visibleQuestions(def, page, st), { def, state: st }).filter((e) => e.questionId === "q1"), []);
});

test("question visible: option-level logic then decides, one option at a time", () => {
  const def = fixture({
    questionLogic: showsWhenYes,
    optionB: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "no" },
  });
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  setAnswer(def, st, "q0", "yes");
  const page = compileFlow(def, st, {}).find((s) => s.kind === "page") as never;

  assert.deepEqual(visibleQuestions(def, page, st).map((q) => q.id), ["q0", "q1"], "Q1 is rendered");
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  assert.deepEqual(view.options.map((o) => o.code), ["A", "C"], "B's own condition is false");

  const [, v] = explainVisibility(def, page, st);
  assert.equal(v.visible, true);
  assert.equal(v.decidedBy, "shown");
  assert.deepEqual(v.items.filter((i) => i.visible).map((i) => i.ref), ["A", "C"]);
  const b = v.items.find((i) => i.ref === "B")!;
  assert.equal(b.visible, false);
  assert.equal(b.decidedBy, "item_pipeline", "the item's own rule decided this one, not the question");
  assert.match(b.reason, /display condition evaluated FALSE/);
});

test("a hidden question of any kind reports the same way — settings.hidden and engine-filled types", () => {
  const def = fixture({});
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  const ctx = { def, state: st };
  const hiddenSetting = { ...def.questions[1], settings: { ...def.questions[1].settings, hidden: true } } as Question;
  const v1 = explainQuestionVisibility(hiddenSetting, ctx);
  assert.equal(v1.visible, false); assert.equal(v1.decidedBy, "hidden_setting");
  assert.ok(v1.items.every((i) => i.decidedBy === "question_hidden"));

  const calculated = { ...def.questions[1], type: "calculated" } as Question;
  const v2 = explainQuestionVisibility(calculated, ctx);
  assert.equal(v2.visible, false); assert.equal(v2.decidedBy, "type");
  assert.match(v2.reason, /filled by the engine, never asked/);
});

test("a selection of an option that is no longer offered stops being a selection", () => {
  const def = fixture({ optionB: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" } });
  const st = createResponseState(def, { seed: 1, sessionId: "t" });

  // B is offered, and chosen alongside A
  setAnswer(def, st, "q0", "yes");
  setAnswer(def, st, "q1", ["A", "B"]);
  assert.deepEqual(effectiveQuestion(def.questions[1], { def, state: st }).options.map((o) => o.code), ["A", "B", "C"]);

  // the earlier answer changes, and B is no longer offered
  setAnswer(def, st, "q0", "no");
  assert.deepEqual(effectiveQuestion(def.questions[1], { def, state: st }).options.map((o) => o.code), ["A", "C"]);
  assert.deepEqual(st.answers.q1, ["A", "B"], "the stored answer still names it until something prunes");

  const pruned = pruneHiddenSelections(def, [def.questions[1]], { def, state: st });
  assert.deepEqual(st.answers.q1, ["A"], "B is gone from the response");
  assert.deepEqual(pruned, [{ questionId: "q1", scope: "option", removed: ["B"] }]);

  // pruning is idempotent and leaves a clean answer alone
  assert.deepEqual(pruneHiddenSelections(def, [def.questions[1]], { def, state: st }), []);
  assert.deepEqual(st.answers.q1, ["A"]);
});

test("a single-select answer that is no longer offered is dropped with its Other text", () => {
  const def = fixture({ type: "single_select", optionB: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" } });
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  setAnswer(def, st, "q0", "yes");
  setAnswer(def, st, "q1", "B");
  st.answers.q1__other = "typed against B" as never;
  setAnswer(def, st, "q0", "no");
  pruneHiddenSelections(def, [def.questions[1]], { def, state: st });
  assert.equal(st.answers.q1, undefined);
  assert.equal(st.answers.q1__other, undefined, "the text that belonged to it goes too");
});

test("navigation prunes on arrival, and a hidden question's answer is left exactly where the respondent left it", () => {
  const def = fixture({ questionLogic: showsWhenYes, optionB: { type: "rule", source: { kind: "question", ref: "Q0" }, operator: "eq", value: "yes" } });
  const st = createResponseState(def, { seed: 1, sessionId: "t" });
  setAnswer(def, st, "q0", "yes");
  setAnswer(def, st, "q1", ["A", "B"]);

  // Q1 becomes hidden entirely: its answer is NOT touched — the respondent was never asked to change it
  setAnswer(def, st, "q0", "no");
  advance(def, st, {});
  assert.deepEqual(st.answers.q1, ["A", "B"], "a hidden question's answer is preserved");

  // Q1 comes back, with B no longer offered: now it is pruned on arrival
  setAnswer(def, st, "q0", "yes");
  st.answers.q1 = ["A", "B"] as never;
  st.stepIndex = 0;
  advance(def, st, {});
  assert.deepEqual(st.answers.q1, ["A", "B"], "arrival on the same step does not re-enter the page");
  const page = compileFlow(def, st, {}).find((s) => s.kind === "page") as never;
  pruneHiddenSelections(def, visibleQuestions(def, page, st), { def, state: st });
  assert.deepEqual(st.answers.q1, ["A", "B"], "B is offered again when Q0 = yes");
  setAnswer(def, st, "q0", "no");
  pruneHiddenSelections(def, visibleQuestions(def, page, st), { def, state: st });
  assert.deepEqual(st.answers.q1, ["A", "B"], "…and while Q1 itself is hidden it is not pruned either");
});
