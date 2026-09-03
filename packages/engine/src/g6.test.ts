import { test } from "node:test";
import assert from "node:assert/strict";
import { Question, SurveyDefinition, cond, type Condition } from "@rescript/schema";
import { pickAdaptive, adaptedQuestion, pickArm } from "./adaptive.js";
import { createResponseState } from "./state.js";
import { questionVariables } from "./variables.js";
import { flattenVariables } from "./flatten.js";
import type { EvalContext } from "./evaluate.js";

/*
 * Engine behaviour the date/time, adaptive, gamified, experimental and
 * conversational variants rely on:
 *
 *  - pickAdaptive / pickArm: the two decisions the renderers make, kept pure
 *    so a respondent's adapted wording and assigned arm are reproducible
 *    outside a browser (the inspector and these tests read the same functions
 *    the runtime does).
 *  - the side-answer variables: a quiz score, a reaction time and an
 *    attention-check verdict are stored beside the answer like `__other`, so
 *    they need dictionary rows and export columns of their own or they are
 *    captured and then silently dropped.
 */

function question(patch: Record<string, unknown> = {}) {
  return Question.parse({
    id: "Q1", code: "Q1", variableName: "Q1", type: "single_select",
    text: "How do you feel?",
    options: [
      { code: 1, label: "Good" },
      { code: 2, label: "Bad" },
    ],
    ...patch,
  });
}

function ctxWith(answers: Record<string, unknown>, q = question()): EvalContext {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T", version: "1.0" },
    questions: [q, question({ id: "Q0", code: "Q0", variableName: "Q0" })],
    flow: [{ type: "page", id: "p1", questionIds: ["Q0", "Q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return { def, state, loop: null };
}

/* ------------------------------------------------------------ pickAdaptive */

test("pickAdaptive returns nothing when the question has no alternatives", () => {
  assert.equal(pickAdaptive(question(), ctxWith({})), undefined);
  assert.equal(pickAdaptive(question({ settings: { adaptive: [] } }), ctxWith({})), undefined);
});

test("pickAdaptive returns the FIRST alternative whose condition holds", () => {
  const q = question({
    settings: {
      adaptive: [
        { label: "detractor", when: cond.rule("Q0", "eq", 2), text: "What went wrong?" },
        { label: "any answer", when: cond.rule("Q0", "answered"), text: "Tell us more." },
      ],
    },
  });
  // Q0 = 2 satisfies BOTH — the earlier one wins, so the list reads as a
  // priority order rather than "whichever matched last"
  assert.equal(pickAdaptive(q, ctxWith({ Q0: 2 }))?.label, "detractor");
  assert.equal(pickAdaptive(q, ctxWith({ Q0: 1 }))?.label, "any answer");
  assert.equal(pickAdaptive(q, ctxWith({}))?.label, undefined);
});

test("pickAdaptive skips an alternative with no condition rather than matching it", () => {
  // the schema requires `when`, but a definition edited by hand (or an older
  // one) can still arrive with a half-built alternative; skipping it beats
  // treating "no condition" as "always"
  const q = {
    settings: {
      adaptive: [
        { label: "broken" } as unknown as { when: Condition; label: string },
        { label: "good", when: cond.rule("Q0", "answered") },
      ],
    },
  } as unknown as Parameters<typeof pickAdaptive>[0];
  assert.equal(pickAdaptive(q, ctxWith({ Q0: 1 }))?.label, "good");
});

test("adaptedQuestion substitutes text, instruction, options and bounds", () => {
  const q = question({
    instruction: "Pick one.",
    settings: {
      minValue: 0, maxValue: 10,
      adaptive: [{
        label: "alt",
        when: cond.rule("Q0", "eq", 1),
        text: "Which of these instead?",
        instruction: "Only one.",
        options: [{ code: "x", label: "Xylophone", flags: [] }, { code: "y", label: "Yacht", flags: [] }],
        minValue: 1, maxValue: 5,
      }],
    },
  });
  const hit = adaptedQuestion(q, ctxWith({ Q0: 1 }));
  assert.equal(hit.alt?.label, "alt");
  assert.equal(hit.q.text, "Which of these instead?");
  assert.equal(hit.q.instruction, "Only one.");
  assert.deepEqual(hit.q.options.map((o) => o.code), ["x", "y"]);
  assert.equal(hit.q.settings.minValue, 1);
  assert.equal(hit.q.settings.maxValue, 5);

  const miss = adaptedQuestion(q, ctxWith({ Q0: 2 }));
  assert.equal(miss.alt, undefined);
  assert.equal(miss.q.text, "How do you feel?");
  assert.deepEqual(miss.q.options.map((o) => o.code), [1, 2]);
  assert.equal(miss.q.settings.maxValue, 10);
});

/* ----------------------------------------------------------------- pickArm */

const ARMS = [
  { code: "A", label: "Control", weight: 1 },
  { code: "B", label: "Treatment", weight: 1 },
];

test("pickArm splits the unit interval by weight and is deterministic", () => {
  assert.equal(pickArm(ARMS, 0)?.code, "A");
  assert.equal(pickArm(ARMS, 0.49)?.code, "A");
  assert.equal(pickArm(ARMS, 0.5)?.code, "B");
  assert.equal(pickArm(ARMS, 0.999)?.code, "B");
  // the same draw always lands on the same arm — this is what makes an
  // assignment reproducible from a respondent's seed
  assert.equal(pickArm(ARMS, 0.3)?.code, pickArm(ARMS, 0.3)?.code);
});

test("pickArm never assigns a zero-weight arm", () => {
  const parked = [
    { code: "A", label: "Parked", weight: 0 },
    { code: "B", label: "Live", weight: 3 },
    { code: "C", label: "Also parked", weight: 0 },
  ];
  for (let i = 0; i < 200; i++) {
    assert.equal(pickArm(parked, i / 200)?.code, "B");
  }
});

test("pickArm treats missing weights as 1 and an all-zero list as an even split", () => {
  const unweighted = [
    { code: "A", label: "a" }, { code: "B", label: "b" }, { code: "C", label: "c" },
  ];
  assert.equal(pickArm(unweighted, 0.1)?.code, "A");
  assert.equal(pickArm(unweighted, 0.5)?.code, "B");
  assert.equal(pickArm(unweighted, 0.9)?.code, "C");

  const allZero = [{ code: "A", label: "a", weight: 0 }, { code: "B", label: "b", weight: 0 }];
  assert.equal(pickArm(allZero, 0.1)?.code, "A");
  assert.equal(pickArm(allZero, 0.9)?.code, "B");
});

test("pickArm handles an empty list and a nonsense draw without throwing", () => {
  assert.equal(pickArm([], 0.5), undefined);
  assert.equal(pickArm(undefined, 0.5), undefined);
  assert.equal(pickArm(ARMS, Number.NaN)?.code, "A");
  assert.equal(pickArm(ARMS, 1)?.code, "B");
  assert.equal(pickArm(ARMS, -3)?.code, "A");
});

/* ------------------------------------------- side-answer variables + export */

function defWith(q: ReturnType<typeof question>) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T", version: "1.0" },
    questions: [q],
    flow: [{ type: "page", id: "p1", questionIds: [q.id] }, { type: "end", id: "e1", status: "complete" }],
  });
}
const names = (q: ReturnType<typeof question>) => questionVariables(q).map((v) => v.name);

test("a quiz with a marked correct option gains a _CORRECT variable, and it exports", () => {
  const q = question({
    variant: "gamified.quiz",
    options: [{ code: 1, label: "Right", meta: { correct: true } }, { code: 2, label: "Wrong" }],
  });
  assert.deepEqual(names(q), ["Q1", "Q1_CORRECT"]);
  const correct = questionVariables(q).find((v) => v.name === "Q1_CORRECT")!;
  assert.equal(correct.dataType, "numeric");
  assert.deepEqual(correct.valueLabels, { "0": "Incorrect", "1": "Correct" });

  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q1 = 2;
  state.answers.Q1__correct = 0;
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q1, 2);
  assert.equal(flat.Q1_CORRECT, 0);
});

test("a question with no answer key gains no _CORRECT variable", () => {
  assert.deepEqual(names(question()), ["Q1"]);
});

test("a timed question gains _RT and _TIMEOUT, and both export", () => {
  const q = question({ variant: "gamified.timed", settings: { timeLimitSeconds: 8 } });
  assert.deepEqual(names(q), ["Q1", "Q1_RT", "Q1_TIMEOUT"]);

  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q1 = 1;
  state.answers.Q1__rt = 1420;
  state.answers.Q1__timeout = 0;
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q1_RT, 1420);
  assert.equal(flat.Q1_TIMEOUT, 0);
});

test("a time limit on some other kind of question invents no reaction-time columns", () => {
  // several families use `timeLimitSeconds` for a page clock or a media
  // stimulus; only the timed variant records a reaction time
  assert.deepEqual(names(question({ settings: { timeLimitSeconds: 8 } })), ["Q1"]);
});

test("an attention check gains _PASSED, and it exports", () => {
  const q = question({ variant: "experimental.attention_check", settings: { expectedCodes: [1] } });
  assert.deepEqual(names(q), ["Q1", "Q1_PASSED"]);

  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q1 = 2;
  state.answers.Q1__passed = 0;
  assert.equal(flattenVariables(def, state).Q1_PASSED, 0);
});

test("a reaction-time block gains one _RT per stimulus, and the map spreads on export", () => {
  const q = question({
    id: "Q2", code: "Q2", variableName: "Q2",
    type: "matrix_single", variant: "experimental.reaction_time",
    rows: [{ code: "s1", label: "Flower" }, { code: "s2", label: "Insect" }],
    options: [{ code: 1, label: "Pleasant" }, { code: 2, label: "Unpleasant" }],
  });
  assert.deepEqual(names(q), ["Q2_s1", "Q2_s2", "Q2_s1_RT", "Q2_s2_RT"]);

  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q2 = { s1: 1, s2: 2 };
  state.answers.Q2__rt = { s1: 512, s2: 749 };
  const flat = flattenVariables(def, state);
  assert.equal(flat.Q2_s1, 1);
  assert.equal(flat.Q2_s1_RT, 512);
  assert.equal(flat.Q2_s2_RT, 749);
  // the map never lands as one opaque column
  assert.equal(flat.Q2_RT, undefined);
});

test("a keyed matching task gains _CORRECT; an unkeyed one does not", () => {
  const base = {
    id: "Q3", code: "Q3", variableName: "Q3",
    type: "matrix_single", variant: "gamified.matching",
    options: [{ code: "a1", label: "One" }, { code: "a2", label: "Two" }],
  };
  const keyed = question({ ...base, rows: [{ code: "r1", label: "P1", meta: { answer: "a1" } }] });
  const bare = question({ ...base, rows: [{ code: "r1", label: "P1" }] });
  assert.ok(names(keyed).includes("Q3_CORRECT"));
  assert.ok(!names(bare).includes("Q3_CORRECT"));
});

test("side answers on an ordinary question do not invent columns", () => {
  // no variant, no key, no timer: the side-answer block must stay silent
  const q = question();
  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q1 = 1;
  const flat = flattenVariables(def, state);
  assert.deepEqual(Object.keys(flat).filter((k) => k.startsWith("Q1")), ["Q1"]);
  assert.deepEqual(names(q), ["Q1"]);
});

test("an experiment question's dictionary row carries the arm labels", () => {
  const q = question({
    id: "Q4", code: "Q4", variableName: "Q4", type: "experiment", variant: "experimental.ab",
    settings: { arms: [{ code: "A", label: "Control" }, { code: "B", label: "Treatment" }] },
  });
  const v = questionVariables(q)[0];
  assert.equal(v.name, "Q4");
  assert.deepEqual(v.valueLabels, { A: "Control", B: "Treatment" });

  const def = defWith(q);
  const state = createResponseState(def, { seed: 1 });
  state.answers.Q4 = "B";
  assert.equal(flattenVariables(def, state).Q4, "B");
});
