import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  nextProbe, dueProbes, probeQuestion, probeTranscript, recordProbePrompt, forgetProbe,
  probeAnswerKey, probePromptKey, renderFixedProbe, fakeProbe, lintProbes, lintQuestionLogic,
  buildVariableDictionary, flattenVariables, createResponseState, setAnswer, validatePage, runCalculations,
} from "./index.js";

/**
 * FOLLOW-UP PROBES — the pure half (probe.ts).
 *
 * What the runtime does with a probe — show one screen, store the answer,
 * carry on — is proven in the browser suite. What is proven here is every
 * decision the engine makes without a screen: when a probe is due, what the
 * synthetic question looks like, where the answers land, that the dictionary
 * and the export know about them up front, and that lint says the right
 * things.
 */

const def = (probe: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "Probe", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SCORE", type: "numeric", text: "Score?" },
    { id: "q5", code: "Q5", variableName: "WHY", type: "long_text", text: "Why?", probe, ...extra },
    { id: "q6", code: "Q6", variableName: "NEXT", type: "numeric", text: "Next?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q5"] }, { type: "page", id: "p2", questionIds: ["q6"] }, { type: "end", id: "e1", status: "complete" }],
});
const ctxOf = (d: SurveyDefinition, state = createResponseState(d, { seed: 1 })) => ({ def: d, state, loop: null });

test("A PROBE IS DUE only for a non-empty answer, under maxProbes, with `when` true and `stopWhen` false", () => {
  const d = def({ maxProbes: 2 });
  const c = ctxOf(d);
  const q5 = d.questions[1];
  assert.equal(nextProbe(q5, c), null, "nothing answered → no probe");
  setAnswer(d, c.state, "q5", "   ");
  assert.equal(nextProbe(q5, c), null, "whitespace is not an answer");
  setAnswer(d, c.state, "q5", "It was too expensive.");
  assert.equal(nextProbe(q5, c), 1, "answered → the first follow-up is due");
  recordProbePrompt(c.state, "q5", 1, "Tell me more?");
  c.state.answers[probeAnswerKey("q5", 1)] = "The delivery fee.";
  assert.equal(nextProbe(q5, c), 2, "one asked of two → the second is due");
  recordProbePrompt(c.state, "q5", 2, "Anything else?");
  assert.equal(nextProbe(q5, c), null, "maxProbes reached");

  assert.equal(nextProbe(d.questions[0], c), null, "a question without a probe is never due");
});

test("`when`, `stopWhen` and minWords are honoured — the same Condition tree as display logic", () => {
  const gated = def({
    when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "lte", value: 6 },
    stopWhen: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: 0 },
    maxProbes: 3,
    minWords: 3,
  });
  const q5 = gated.questions[1];
  const c = ctxOf(gated);
  setAnswer(gated, c.state, "q5", "Expensive delivery fee here");
  setAnswer(gated, c.state, "q1", 9);
  assert.equal(nextProbe(q5, c), null, "`when` false (score 9 > 6) → no probe");
  setAnswer(gated, c.state, "q1", 4);
  assert.equal(nextProbe(q5, c), 1, "`when` true → due");
  setAnswer(gated, c.state, "q5", "Meh");
  assert.equal(nextProbe(q5, c), null, "one word < minWords 3 → not worth probing");
  setAnswer(gated, c.state, "q5", "Meh, too pricey overall");
  setAnswer(gated, c.state, "q1", 0);
  assert.equal(nextProbe(q5, c), null, "`stopWhen` true → stop, even though `when` also holds");
});

test("dueProbes walks a page in order and skips questions that are not due", () => {
  const d = def({ maxProbes: 1 });
  const c = ctxOf(d);
  setAnswer(d, c.state, "q5", "Too slow");
  const due = dueProbes(d.questions, c);
  assert.deepEqual(due.map((x) => [x.q.id, x.n]), [["q5", 1]]);
});

test("THE SYNTHETIC QUESTION renders through the ordinary machinery — a long_text whose id is the storage key", () => {
  const d = def({ maxProbes: 1, required: true });
  const q5 = d.questions[1];
  const pq = probeQuestion(q5, 1, "Could you say more?");
  assert.equal(pq.id, probeAnswerKey("q5", 1));
  assert.equal(pq.type, "long_text");
  assert.equal(pq.code, "Q5_PROBE_1");
  assert.equal(pq.variableName, "WHY_PROBE_1");
  assert.equal(pq.text, "Could you say more?");
  assert.equal(pq.required, true, "required follows the probe config");
  assert.equal(pq.probe, undefined, "a probe never has a probe");
  assert.equal(pq.displayLogic, undefined);

  // the ordinary validator sees it as a required question with no answer
  const state = createResponseState(d, { seed: 1 });
  const errs = validatePage(d, [pq], { def: d, state, loop: null });
  assert.equal(errs.length, 1, "required and unanswered → one error");
  state.answers[pq.id] = "Because of the fee";
  assert.equal(validatePage(d, [pq], { def: d, state, loop: null }).length, 0);

  const optional = probeQuestion(def({ maxProbes: 1 }).questions[1], 1, "x");
  assert.equal(optional.required, false, "default: a probe invites, it does not demand");
});

test("the transcript is read back in order, and an abandoned probe is forgotten cleanly", () => {
  const d = def({ maxProbes: 3 });
  const state = createResponseState(d, { seed: 1 });
  recordProbePrompt(state, "q5", 1, "First?");
  state.answers[probeAnswerKey("q5", 1)] = "A";
  recordProbePrompt(state, "q5", 2, "Second?");
  assert.deepEqual(probeTranscript(state, "q5"), [{ n: 1, prompt: "First?", answer: "A" }, { n: 2, prompt: "Second?", answer: undefined }]);
  forgetProbe(state, "q5", 2);
  assert.deepEqual(probeTranscript(state, "q5").map((t) => t.n), [1]);
  assert.equal(state.answers[probePromptKey("q5", 2)], undefined);
});

test("A FIXED WORDING pipes {answer} and ordinary tokens; the fake writer is deterministic", () => {
  const d = def({ maxProbes: 1, prompt: "You said “{answer}” after scoring us {{Q1}}. Why?" });
  const c = ctxOf(d);
  setAnswer(d, c.state, "q1", 3);
  setAnswer(d, c.state, "q5", "too pricey");
  assert.equal(renderFixedProbe(d.questions[1].probe!, "too pricey", c), "You said “too pricey” after scoring us 3. Why?");

  assert.equal(fakeProbe("Far too expensive. And slow.", 1), "You mentioned “Far too expensive”. Could you tell me a bit more about that?");
  assert.equal(fakeProbe("x", 2), "Thanks. What would have made that better?");
  assert.equal(fakeProbe("x", 2, "The delivery experience."), "Thanks. Thinking about the delivery experience — what else comes to mind?");
  assert.equal(fakeProbe("x", 3), "Is there anything else you would like to add?");
});

test("THE DICTIONARY DECLARES THE PROBE COLUMNS UP FRONT, and flatten fills them — same columns before the first respondent and after the last", () => {
  const d = def({ maxProbes: 2 });
  const names = buildVariableDictionary(d).map((v) => v.name);
  for (const n of ["WHY", "WHY_PROBE_1", "WHY_PROBE_1_Q", "WHY_PROBE_2", "WHY_PROBE_2_Q"]) assert.ok(names.includes(n), `${n} declared`);
  assert.ok(!names.includes("WHY_PROBE_3"), "no column beyond maxProbes");

  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "q5", "Too pricey");
  recordProbePrompt(state, "q5", 1, "Say more?");
  state.answers[probeAnswerKey("q5", 1)] = "The fee";
  const flat = flattenVariables(d, state);
  assert.equal(flat.WHY, "Too pricey");
  assert.equal(flat.WHY_PROBE_1, "The fee");
  assert.equal(flat.WHY_PROBE_1_Q, "Say more?");
  assert.equal("WHY_PROBE_2" in flat, false, "a follow-up never asked leaves its cell absent, not invented");

  // and a shown-but-unanswered probe exports its wording with an empty answer
  recordProbePrompt(state, "q5", 2, "Anything else?");
  const flat2 = flattenVariables(d, state);
  assert.equal(flat2.WHY_PROBE_2_Q, "Anything else?");
  assert.equal(flat2.WHY_PROBE_2, null);

  // a survey without probes declares nothing new
  assert.ok(!buildVariableDictionary(def(undefined)).some((v) => /_PROBE_/.test(v.name)));
});

test("runCalculations leaves probe keys alone; a probe key never collides with a loop-suffixed answer", () => {
  const d = def({ maxProbes: 1 });
  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "q5", "Too pricey");
  recordProbePrompt(state, "q5", 1, "Say more?");
  state.answers[probeAnswerKey("q5", 1)] = "The fee";
  runCalculations(d, state, "on_page_submit");
  assert.equal(state.answers[probeAnswerKey("q5", 1)], "The fee");
  assert.ok(!probeAnswerKey("q5", 1).startsWith("q5@"), "the generic loop flatten does not see it");
});

test("LINT: probe on a non-text question, no wording and no instruction, fixed wording repeated", () => {
  const onNumeric = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "P", version: "1.0" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "n", probe: { maxProbes: 1, prompt: "Why?" } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  assert.match(lintProbes(onNumeric)[0], /Q1: A follow-up probe asks about an open end; Q1 is numeric/);

  assert.match(lintProbes(def({ maxProbes: 1 }))[0], /neither a fixed wording nor an instruction/);
  assert.match(lintProbes(def({ maxProbes: 2, prompt: "Why?" }))[0], /asked 2 times word for word/);
  assert.deepEqual(lintProbes(def({ maxProbes: 2, instruction: "Find the reason" })), [], "AI wording with an instruction lints clean");
  assert.deepEqual(lintProbes(def({ maxProbes: 1, prompt: "Why {answer}?" })), [], "one fixed probe lints clean");

  // the per-question logic check carries the same, as warnings, with the Condition reference checks
  const d = def({ maxProbes: 1, when: { type: "rule", source: { kind: "question", ref: "Q6" }, operator: "eq", value: 1 } });
  const issues = lintQuestionLogic(d, d.questions[1]);
  assert.ok(issues.some((i) => i.path === "probe.when"), "a probe `when` that reads a LATER question is caught like any forward reference");
  assert.ok(issues.some((i) => i.path === "probe" && i.level === "warning"));
});
