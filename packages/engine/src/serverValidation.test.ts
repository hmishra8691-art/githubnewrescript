import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { answerKeyBase, checkSubmission } from "./serverValidation.js";

/**
 * RUNTIME-01 (audit 2026-10-16): the save route used to store whatever the
 * client posted. These are the payloads it must now tell apart from an
 * honest interview — replayed with the same engine the browser ran.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Trust" },
  questions: [
    { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }, { kind: "integer" }] },
    { id: "q_brand", code: "Q2", variableName: "BRAND", type: "single_select", text: "Brand?", required: true, options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }] },
    { id: "q_why", code: "Q3", variableName: "WHY", type: "open_text", text: "Why Beta?", required: true, displayLogic: { type: "rule", source: { kind: "question", ref: "q_brand" }, operator: "eq", value: "2" } },
    { id: "q_end", code: "Q4", variableName: "END", type: "single_select", text: "Done?", options: [{ code: 1, label: "Yes" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_age"] },
    { type: "page", id: "p2", questionIds: ["q_brand"] },
    { type: "page", id: "p3", questionIds: ["q_why"] },
    { type: "page", id: "p4", questionIds: ["q_end"] },
    { type: "end", id: "e", status: "complete" },
  ],
});
const prior = { seed: 7, sessionId: "sess-1" };
const check = (posted: Partial<Parameters<typeof checkSubmission>[0]["posted"]>) =>
  checkSubmission({ def, prior, posted: { answers: {}, stepIndex: 0, status: "in_progress", ...posted } });

test("an honest in-progress save and an honest completion pass", () => {
  const p1 = check({ answers: { q_age: "34" }, stepIndex: 1 });
  assert.equal(p1.ok, true); assert.deepEqual(p1.soft, []);
  const done = check({ answers: { q_age: "34", q_brand: "1", q_end: "1" }, stepIndex: 4, status: "complete", completed: true });
  assert.equal(done.ok, true, JSON.stringify(done.hard)); assert.equal(done.endStatus, "complete"); assert.deepEqual(done.soft, []);
  // the branch: Beta asks why
  const beta = check({ answers: { q_age: "34", q_brand: "2", q_why: "cheaper", q_end: "1" }, stepIndex: 4, status: "complete", completed: true });
  assert.equal(beta.ok, true, JSON.stringify(beta.hard));
});

test("the page being filled in is not validated yet; a page already passed is", () => {
  // on page 1, nothing answered: fine
  assert.equal(check({ answers: {}, stepIndex: 0 }).ok, true);
  // claims to be on page 2 with page 1 unanswered: the browser would not have allowed it
  const r = check({ answers: {}, stepIndex: 1 });
  assert.equal(r.ok, false); assert.equal(r.hard[0].code, "invalid_answer"); assert.equal(r.hard[0].questionId, "q_age");
});

test("out-of-range, wrong-type and decimal answers on a passed page are refused with the engine's own message", () => {
  for (const [v, re] of [["999", /at most 99/], ["25.5", /whole number/], ["abc", /whole number/], ["", /required/]] as const) {
    const r = check({ answers: { q_age: v }, stepIndex: 1 });
    assert.equal(r.ok, false, v); assert.match(r.hard[0].message, re);
  }
});

test("a claimed completion must reach an end; unknown questions and bad shapes are hard problems", () => {
  const r = check({ answers: { q_age: "34" }, stepIndex: 1, status: "complete", completed: true });
  assert.equal(r.ok, false); assert.equal(r.hard[0].code, "invalid_answer"); // q_brand required on page 2
  const unknown = check({ answers: { q_age: "34", q_fake: "x" }, stepIndex: 1 });
  assert.equal(unknown.ok, false); assert.equal(unknown.hard[0].code, "unknown_question");
  assert.equal(check({ answers: [] as unknown as object, stepIndex: 1 }).hard[0].code, "bad_shape");
  assert.equal(check({ answers: {}, stepIndex: -1 }).hard[0].code, "bad_shape");
  assert.equal(check({ answers: {}, stepIndex: 0, status: "hacked" as never }).hard[0].code, "bad_shape");
  assert.equal(check({ answers: { ["__proto__"]: { x: 1 } } as never, stepIndex: 0 }).hard[0].code, "bad_shape");
});

test("an answer for a question display logic never showed is a soft problem, not a refusal", () => {
  const r = check({ answers: { q_age: "34", q_brand: "1", q_why: "sneaky", q_end: "1" }, stepIndex: 4, status: "complete", completed: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.soft.map((s) => [s.code, s.questionId]), [["not_asked", "q_why"]]);
});

test("companion keys and loop suffixes resolve to their question", () => {
  assert.equal(answerKeyBase("q_brand__other"), "q_brand");
  assert.equal(answerKeyBase("q_brand@apple@pro"), "q_brand");
  assert.equal(answerKeyBase("q_brand@apple__other__9"), "q_brand");
  assert.equal(answerKeyBase("q_why__voice"), "q_why");
  const r = check({ answers: { q_age: "34", q_brand: "1", q_brand__other: "n/a" }, stepIndex: 2 });
  assert.equal(r.ok, true, JSON.stringify(r.hard));
});

test("a stale in-progress index past the end is soft; the replay is bounded", () => {
  const r = check({ answers: { q_age: "34", q_brand: "1", q_end: "1" }, stepIndex: 40 });
  assert.equal(r.ok, true); assert.equal(r.soft[0]?.code, "step_unreachable");
  const bounded = checkSubmission({ def, prior, posted: { answers: { q_age: "34", q_brand: "1", q_end: "1" }, stepIndex: 4, status: "complete" }, maxPages: 1 });
  assert.equal(bounded.ok, false); assert.equal(bounded.hard[0].code, "incomplete");
});
