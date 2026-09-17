import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerValueOf, beginFlow, continueFlow, forwardReferences, isShown, outstandingQuestions,
  resumeFlow, toResponseState, toSurveyDefinition, type FlowQuestion,
} from "./definition.js";
import { drawSequence } from "./selection.js";

/*
 * The adapter is exercised through the REAL engine — `start`, `advance`,
 * `resumeAt`, `evaluateCondition` from `@rescript/engine` — not a stub of it.
 * What is under test is the projection: that interview rows become a document
 * the engine walks the way an interviewer would expect.
 */

const project = { id: "p1", name: "Backend engineer" };

const rule = (ref: string, operator: string, value?: unknown) =>
  ({ type: "rule" as const, source: { kind: "question" as const, ref }, operator: operator as never, value });

const Q: FlowQuestion[] = [
  { id: "q_intro", code: "Q1", kind: "video", prompt: "Introduce yourself", required: true },
  {
    id: "q_lang", code: "Q2", kind: "single_choice", prompt: "Main language?", required: true,
    options: [{ code: "ts", label: "TypeScript" }, { code: "go", label: "Go" }, { code: "other", label: "Other" }],
  },
  {
    id: "q_ts", code: "Q3", kind: "long_text", prompt: "Favourite TS feature?", required: true,
    visibleIf: rule("q_lang", "eq", "ts"),
  },
  {
    id: "q_go", code: "Q4", kind: "long_text", prompt: "Favourite Go feature?", required: true,
    visibleIf: rule("q_lang", "eq", "go"),
  },
  { id: "q_close", code: "Q5", kind: "video", prompt: "Anything else?", required: false },
];
const SEQ = Q.map((q) => q.id);

test("the projection parses as a real SurveyDefinition with one page per question", () => {
  const def = toSurveyDefinition(project, Q, SEQ);
  assert.equal(def.questions.length, 5);
  assert.equal(def.flow.length, 5);
  assert.equal(def.questions[1]!.type, "single_select", "kinds map to types the survey side knows");
  assert.equal(def.questions[2]!.type, "long_text");
  assert.deepEqual(def.questions[1]!.options.map((o) => o.code), ["ts", "go", "other"]);
  /* the defaults the engine relies on were filled by the schema, not by us */
  assert.deepEqual(def.calculations, []);
  assert.deepEqual(def.displayRules, []);
});

test("an id in the sequence that no question answers to is dropped, not fatal", () => {
  const def = toSurveyDefinition(project, Q, ["q_intro", "gone", "q_close"]);
  assert.deepEqual(def.flow.map((f) => f.type === "page" && f.id), ["q_intro", "q_close"]);
});

test("DISPLAY LOGIC HIDES THE BRANCH NOT TAKEN, and says which questions it hid", () => {
  const def = toSurveyDefinition(project, Q, SEQ);
  const state = toResponseState(def, { id: "iv1", seed: "s" }, []);

  const first = beginFlow(def, state);
  assert.equal(first.questionId, "q_intro");

  state.answers["q_intro"] = "answered";
  const second = continueFlow(def, state);
  assert.equal(second.questionId, "q_lang");

  state.answers["q_lang"] = "go";
  const third = continueFlow(def, state);
  assert.equal(third.questionId, "q_go", "the Go question is asked");
  assert.deepEqual(third.hiddenByLogic, ["q_ts"], "and the TypeScript one is reported as hidden, so the runtime can mark it skipped");

  state.answers["q_go"] = "goroutines";
  const fourth = continueFlow(def, state);
  assert.equal(fourth.questionId, "q_close");

  state.answers["q_close"] = "answered";
  const end = continueFlow(def, state);
  assert.equal(end.done, true);
  assert.equal(end.questionId, null);
});

test("a hidden question is not outstanding, whatever its `required` flag says", () => {
  const def = toSurveyDefinition(project, Q, SEQ);
  const responses = [
    { questionId: "q_intro", status: "stored", answerKind: "video" },
    { questionId: "q_lang", status: "stored", answerKind: "single_choice", answerValue: "ts" },
    { questionId: "q_ts", status: "stored", answerKind: "long_text", answerText: "generics" },
    { questionId: "q_go", status: "pending" },       // hidden — never asked
    { questionId: "q_close", status: "pending" },    // optional
  ];
  const state = toResponseState(def, { id: "iv1", seed: "s" }, responses);
  const outstanding = outstandingQuestions(def, state, responses.map((r) => ({
    ...r, required: Q.find((q) => q.id === r.questionId)!.required,
  })));
  assert.deepEqual(outstanding, [], "q_go is required but hidden; q_close is optional");
  assert.equal(isShown(def, state, "q_go"), false);
  assert.equal(isShown(def, state, "q_ts"), true);
});

test("a required, visible, unanswered question IS outstanding", () => {
  const def = toSurveyDefinition(project, Q, SEQ);
  const responses = [
    { questionId: "q_intro", status: "stored", answerKind: "video" },
    { questionId: "q_lang", status: "stored", answerKind: "single_choice", answerValue: "ts" },
    { questionId: "q_ts", status: "pending" },
  ];
  const state = toResponseState(def, { id: "iv1", seed: "s" }, responses);
  const outstanding = outstandingQuestions(def, state, responses.map((r) => ({ ...r, required: true })));
  assert.deepEqual(outstanding, ["q_ts"]);
});

test("SKIP LOGIC jumps over questions and reports the rule that fired", () => {
  const withSkip: FlowQuestion[] = [
    Q[0]!,
    {
      ...Q[1]!,
      skipLogic: [{ id: "r1", when: rule("q_lang", "eq", "other"), target: { kind: "question", ref: "q_close" } }],
    },
    Q[2]!, Q[3]!, Q[4]!,
  ];
  const def = toSurveyDefinition(project, withSkip, SEQ);
  const state = toResponseState(def, { id: "iv1", seed: "s" }, []);
  beginFlow(def, state);
  state.answers["q_intro"] = "answered";
  continueFlow(def, state);
  state.answers["q_lang"] = "other";
  const pos = continueFlow(def, state);
  assert.equal(pos.questionId, "q_close");
  assert.deepEqual(pos.skipped, [{ questionId: "q_lang", ruleId: "r1" }]);
});

test("RESUME lands on the saved question when it is still visible, and walks forward when it is not", () => {
  const def = toSurveyDefinition(project, Q, SEQ);
  /* saved on q_ts, having said TypeScript — still visible, so stay there */
  const stayed = toResponseState(def, { id: "iv1", seed: "s" }, [
    { questionId: "q_intro", status: "stored", answerKind: "video" },
    { questionId: "q_lang", status: "stored", answerKind: "single_choice", answerValue: "ts" },
  ]);
  assert.equal(resumeFlow(def, stayed, 2).questionId, "q_ts");

  /* saved on q_ts, but the answer says Go — q_ts is hidden now, so move on */
  const moved = toResponseState(def, { id: "iv1", seed: "s" }, [
    { questionId: "q_intro", status: "stored", answerKind: "video" },
    { questionId: "q_lang", status: "stored", answerKind: "single_choice", answerValue: "go" },
  ]);
  const pos = resumeFlow(def, moved, 2);
  assert.equal(pos.questionId, "q_go");
  assert.ok(pos.hiddenByLogic.includes("q_ts"));

  /*
   * A nonsense saved index is not a crash. Negative falls back to the start.
   * Past the end clamps to the engine's `end` step and reports done — which
   * `finish` then refuses if anything required is still outstanding, so a
   * corrupt index cannot skip the interview, only end the walk.
   */
  const fresh = toResponseState(def, { id: "iv1", seed: "s" }, []);
  assert.equal(resumeFlow(def, fresh, -5).questionId, "q_intro");
  assert.equal(resumeFlow(def, fresh, 99).done, true);
});

test("answer values are what the condition language can compare", () => {
  assert.equal(answerValueOf({ questionId: "q", status: "stored", answerKind: "video" }), "answered");
  assert.equal(answerValueOf({ questionId: "q", status: "stored", answerKind: "text", answerText: "hi" }), "hi");
  assert.equal(answerValueOf({ questionId: "q", status: "stored", answerKind: "single_choice", answerValue: "a" }), "a");
  assert.deepEqual(answerValueOf({ questionId: "q", status: "stored", answerKind: "multi_choice", answerValue: ["a", "b"] }), ["a", "b"]);
  /* a legacy row with no kind is a recorded answer */
  assert.equal(answerValueOf({ questionId: "q", status: "stored" }), "answered");
});

test("A CONDITION ON A LATER QUESTION IS FLAGGED — it would hide the question for everyone", () => {
  /*
   * Q2 shown only if Q4 equals something. Q4 has not been answered when Q2 is
   * reached, so the engine evaluates the rule as false and Q2 disappears for
   * every candidate, silently. The builder needs to be able to say this.
   */
  const bad: FlowQuestion[] = [
    Q[0]!,
    { ...Q[1]!, visibleIf: rule("q_go", "answered") },
    Q[2]!, Q[3]!, Q[4]!,
  ];
  assert.deepEqual(forwardReferences(bad, SEQ), [{ questionId: "q_lang", refersTo: "q_go" }]);
  assert.deepEqual(forwardReferences(Q, SEQ), [], "the good set has no forward references");
});

test("the frozen draw and the live logic compose: draw first, then walk", () => {
  /*
   * The seam the whole design rests on. `drawSequence` decides WHICH questions
   * this candidate gets and in what order, once, at invitation. The engine
   * then walks that order evaluating logic live. Neither knows about the
   * other; this test is the contract between them.
   */
  const pooled: FlowQuestion[] = [
    { id: "a", code: "A", kind: "video", prompt: "a", required: true },
    { id: "b", code: "B", kind: "video", prompt: "b", required: true },
    { id: "c", code: "C", kind: "video", prompt: "c", required: true },
  ];
  const draw = drawSequence({
    pools: [{ id: "pool", code: "P", draw: 2, position: 1, randomize: true }],
    questions: pooled.map((q, i) => ({ id: q.id, code: q.code, poolId: "pool", position: i + 1 })),
    seed: "iv-seed",
  });
  assert.equal(draw.sequence.length, 2, "two of three drawn");

  const def = toSurveyDefinition(project, pooled, draw.sequence.map((s) => s.questionId));
  assert.equal(def.flow.length, 2, "the engine sees only what was drawn");
  const state = toResponseState(def, { id: "iv", seed: "iv-seed" }, []);
  assert.equal(beginFlow(def, state).questionId, draw.sequence[0]!.questionId);
});
