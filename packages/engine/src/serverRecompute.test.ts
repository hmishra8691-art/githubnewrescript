import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkSubmission, summariseValue } from "./serverValidation.js";
import { createResponseState } from "./state.js";
import { start, advance, setAnswer } from "./flow.js";

/*
 * D7 (audit 2026-10-30, S0b): the replay recomputes derived punches and calculations from the posted answers and
 * compares them with what was posted — a tampered value is a soft `server_mismatch`, and `recomputed` carries the
 * server's values for RUNTIME_SERVER_RECOMPUTE=store.
 */

const segmentRule = (value: string, code: string) => ({
  id: `p_${code}`, source: { kind: "codes", codes: [code] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always",
  when: { type: "rule", source: { kind: "question", ref: "q_age" }, operator: value === "young" ? "lt" : "gte", value: 30 },
});

const def = SurveyDefinition.parse({
  meta: { id: "d7", code: "D7", title: "Recompute", version: "1.0" },
  questions: [
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "Age?" },
    { id: "h_seg", code: "SEG", variableName: "SEG", type: "hidden", text: "Segment",
      options: [{ code: "Y", label: "Young" }, { code: "O", label: "Older" }],
      punches: [segmentRule("young", "Y"), segmentRule("older", "O")] },
    { id: "q_open", code: "WHY", variableName: "WHY", type: "open_text", text: "Why?" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_age"] },
    { type: "page", id: "p2", questionIds: ["q_open"] },
    { type: "end", id: "e", status: "complete" },
  ],
  calculations: [{ id: "c1", targetVariable: "AGE_X2", expression: "AGE * 2", trigger: "on_page_submit" }],
});

/** an honest interview through the engine, the way the browser runs it */
function honest(age: number) {
  const state = createResponseState(def, { seed: 11, sessionId: "s-d7" });
  start(def, state);
  setAnswer(def, state, "q_age", age);
  advance(def, state);
  setAnswer(def, state, "q_open", "because my neighbour, Jane Example, said so");
  advance(def, state);
  return { answers: { ...state.answers }, calculated: { ...state.calculated }, embedded: state.embedded, flags: state.flags, stepIndex: state.stepIndex, status: state.status };
}
const check = (posted: ReturnType<typeof honest>, extra: Record<string, unknown> = {}) =>
  checkSubmission({ def, prior: { seed: 11, sessionId: "s-d7" }, posted: { ...posted, status: "complete", completed: true }, ...extra });
const mismatches = (r: ReturnType<typeof checkSubmission>) => r.soft.filter((x) => x.code === "server_mismatch");

test("an honest completion has zero mismatches (the derived punch and the calculation agree)", () => {
  const h = honest(25);
  assert.deepEqual(h.answers.h_seg, "Y", "the hidden segment was punched");
  assert.equal(h.calculated.AGE_X2, 50);
  const r = check(h);
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.deepEqual(mismatches(r), []);
  assert.deepEqual(r.recomputed, { answers: {}, calculated: {} });
});

test("a tampered derived punch is detected, with the server's value to store", () => {
  const h = honest(25);
  const r = check({ ...h, answers: { ...h.answers, h_seg: "O" } });
  assert.equal(r.ok, true, "soft: the save is not refused for it");
  const m = mismatches(r);
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.equal(m[0]!.questionId, "h_seg");
  assert.equal(m[0]!.posted, "O");
  assert.equal(m[0]!.server, "Y");
  assert.deepEqual(r.recomputed!.answers, { h_seg: "Y" });
});

test("a tampered calculation is detected, with the server's value to store", () => {
  const h = honest(40);
  const r = check({ ...h, calculated: { ...h.calculated, AGE_X2: 9999 } });
  const m = mismatches(r);
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.equal(m[0]!.variable, "AGE_X2");
  assert.equal(m[0]!.posted, 9999);
  assert.equal(m[0]!.server, 80);
  assert.deepEqual(r.recomputed!.calculated, { AGE_X2: 80 });
});

test("an exact-balance assignment is judged against the claim the server stored", () => {
  const h = honest(25);
  const claims = { RANDOMIZER_R1: "arm_b" };
  const agree = check({ ...h, calculated: { ...h.calculated, RANDOMIZER_R1: "arm_b" } }, { balanceClaims: claims });
  assert.deepEqual(mismatches(agree), []);
  const lied = check({ ...h, calculated: { ...h.calculated, RANDOMIZER_R1: "arm_a" } }, { balanceClaims: claims });
  const m = mismatches(lied);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.variable, "RANDOMIZER_R1");
  assert.deepEqual(lied.recomputed!.calculated, { RANDOMIZER_R1: "arm_b" });
});

test("recompute: false skips the comparison; logged values never carry an open end's text", () => {
  const h = honest(25);
  const r = checkSubmission({ def, prior: { seed: 11, sessionId: "s-d7" }, posted: { ...h, answers: { ...h.answers, h_seg: "O" }, status: "complete", completed: true }, recompute: false });
  assert.deepEqual(mismatches(r), []);
  assert.equal(r.recomputed, undefined);
  assert.equal(summariseValue("because my neighbour, Jane Example, said so"), "<text, 43 chars>");
  assert.equal(summariseValue("arm_b"), "arm_b");
  assert.deepEqual(summariseValue([1, "Y"]), [1, "Y"]);
});
