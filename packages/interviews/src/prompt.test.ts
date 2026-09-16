import test from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_INFERENCES } from "./evidence.js";
import {
  analysisSystemPrompt, analysisUserPrompt, planAnalysisPrompt, readClaims,
} from "./prompt.js";

const reqs = [
  { id: "r1", code: "R1", title: "Handles ambiguity", criteria: "Describes a decision made without full information." },
  { id: "r2", code: "R2", title: "Communicates clearly" },
];

const src = (id: string, text: string) => ({
  responseId: id, questionId: `q-${id}`, questionCode: id.toUpperCase(), text,
});

/* ---------------------------------------------------------- the prompt */

test("THE FORBIDDEN LIST IS THE SAME ARRAY THE CAVEAT PROMISES", () => {
  /*
   * If the list were written twice, the day somebody adds "tone of voice" to
   * one is the day the product promises something the model was never told.
   */
  const system = analysisSystemPrompt();
  for (const forbidden of FORBIDDEN_INFERENCES) {
    assert.ok(system.includes(forbidden), `the prompt never mentions "${forbidden}"`);
  }
});

test("the prompt demands a verbatim quote and says what happens without one", () => {
  const system = analysisSystemPrompt();
  assert.match(system, /verbatim/i);
  assert.match(system, /discarded/i, "the model is told the consequence, not just the rule");
  assert.match(system, /do not paraphrase/i);
});

test("the prompt permits 'insufficient' as a correct answer", () => {
  /* A model that believes it must find something will find something. */
  assert.match(analysisSystemPrompt(), /insufficient[\s\S]*correct and useful/i);
});

test("the prompt forbids recommending a decision about the person", () => {
  assert.match(analysisSystemPrompt(), /not assessing the person/i);
});

test("requirements carry their criteria when there are any, and nothing when not", () => {
  const user = analysisUserPrompt(reqs, [src("a", "hello")]);
  assert.match(user, /Describes a decision made without full information/);
  const r2 = user.slice(user.indexOf("R2"));
  assert.doesNotMatch(r2.split("\n").slice(0, 3).join("\n"), /what meeting it looks like/);
});

test("every answer is labelled with the id the model must quote back", () => {
  const user = analysisUserPrompt(reqs, [src("a", "one"), src("b", "two")]);
  assert.match(user, /responseId: a/);
  assert.match(user, /responseId: b/);
});

/* ------------------------------------------------------ fitting the budget */

test("a set that fits is sent whole", () => {
  const plan = planAnalysisPrompt(reqs, [src("a", "short"), src("b", "also short")]);
  assert.deepEqual(plan.omitted, []);
  assert.match(plan.user, /responseId: a/);
  assert.match(plan.user, /responseId: b/);
});

test("AN ANSWER THAT DOES NOT FIT IS DROPPED WHOLE, NOT CUT", () => {
  /*
   * Truncating mid-answer would show the model a different text from the one
   * the verifier checks against — so a perfectly honest quote from the tail of
   * a long answer would be discarded as a fabrication.
   */
  const long = "x ".repeat(20_000);
  const plan = planAnalysisPrompt(reqs, [src("a", "short one"), src("b", long), src("c", "another")], 2_000);
  assert.ok(plan.omitted.length > 0, "something had to be left out");
  for (const id of plan.omitted) {
    assert.doesNotMatch(plan.user, new RegExp(`responseId: ${id}\\b`),
      "an omitted answer must be absent entirely");
  }
});

test("the FIRST answer is kept even when it alone exceeds the budget", () => {
  /* Sending nothing is not a better answer than sending one long answer. */
  const plan = planAnalysisPrompt(reqs, [src("a", "y ".repeat(20_000))], 500);
  assert.deepEqual(plan.omitted, []);
  assert.match(plan.user, /responseId: a/);
});

test("answers keep their order — an analysis must not prefer short ones", () => {
  const plan = planAnalysisPrompt(
    reqs,
    [src("a", "tiny"), src("b", "z ".repeat(8_000)), src("c", "tiny")],
    1_500,
  );
  const ai = plan.user.indexOf("responseId: a");
  const ci = plan.user.indexOf("responseId: c");
  if (ai >= 0 && ci >= 0) assert.ok(ai < ci, "kept answers stay in sequence");
});

/* ------------------------------------------------------- reading the reply */

test("claims are read from the shape the prompt asked for", () => {
  const { claims, narrative } = readClaims({
    claims: [{ requirementId: "r1", responseId: "a", verdict: "evidence", quote: "I decided", explanation: "why" }],
    narrative: "Covers two topics.",
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].requirementId, "r1");
  assert.equal(narrative, "Covers two topics.");
});

test("and from the shapes a model returns anyway", () => {
  assert.equal(readClaims({ findings: [{ requirementId: "r1", verdict: "partial" }] }).claims.length, 1);
  assert.equal(readClaims({ claims: [{ requirement_id: "r1", response_id: "a", verdict: "evidence" }] }).claims.length, 1);
});

test("a claim with no requirement or no verdict is dropped here rather than later", () => {
  const { claims } = readClaims({
    claims: [
      { responseId: "a", verdict: "evidence" },
      { requirementId: "r1" },
      { requirementId: "r2", verdict: "evidence" },
    ],
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].requirementId, "r2");
});

test("A QUOTE IS NEVER REPAIRED", () => {
  /*
   * The temptation is to trim, unwrap or normalise whitespace so more claims
   * survive verification. A nearly-right quote is a nearly-right finding, and
   * "nearly" is exactly what this mechanism refuses.
   */
  const { claims } = readClaims({
    claims: [{ requirementId: "r1", responseId: "a", verdict: "evidence", quote: "  I  decided  " }],
  });
  assert.equal(claims[0].quote, "  I  decided  ", "passed through untouched, for the verifier to judge");
});

test("nonsense from the provider produces no claims rather than an exception", () => {
  for (const reply of [null, undefined, "", 42, { nope: true }, { claims: "not a list" }]) {
    const out = readClaims(reply);
    assert.deepEqual(out.claims, [], JSON.stringify(reply));
    assert.equal(out.narrative, null);
  }
});

test("a blank narrative is null rather than an empty string on a report", () => {
  assert.equal(readClaims({ claims: [], narrative: "   " }).narrative, null);
});
