import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WEIGHT, MAX_ANSWER_SECONDS, QUESTION_KINDS, analysisReadiness, checkProject,
  checkQuestion, checkRequirement, isQuestionKind, nextCode, normaliseCode, positionsFor,
} from "./authoring.js";

/* ------------------------------------------------------------- questions */

test("a question with nothing to ask is refused", () => {
  const r = checkQuestion({ prompt: "   " });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /something to ask/i);
});

test("a minimum longer than the maximum is refused, because nobody could answer", () => {
  const r = checkQuestion({ prompt: "Tell me about a time…", minSeconds: 120, maxSeconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /shorter than the maximum/i);
});

test("equal minimum and maximum is refused too — the window is empty", () => {
  const r = checkQuestion({ prompt: "Q", minSeconds: 60, maxSeconds: 60 });
  assert.equal(r.ok, false);
});

test("an answer longer than the platform allows is refused at the point it is typed", () => {
  const r = checkQuestion({ prompt: "Q", maxSeconds: MAX_ANSWER_SECONDS + 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /15 minutes/);
  assert.equal(checkQuestion({ prompt: "Q", maxSeconds: MAX_ANSWER_SECONDS }).ok, true);
});

test("a very short limit WARNS rather than refusing — it is a choice, not a mistake", () => {
  const r = checkQuestion({ prompt: "Q", maxSeconds: 10 });
  assert.equal(r.ok, true, "the interviewer is allowed to want a ten second answer");
  assert.match(r.warnings.join(" "), /very short/i);
});

test("time limits on a typed answer are a setting that cannot do anything, and say so", () => {
  const r = checkQuestion({ prompt: "Paste the link", kind: "text", maxSeconds: 60 });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /do not apply to a typed answer/i);
});

test("a duplicate code is refused — two columns in an export cannot share a name", () => {
  const r = checkQuestion({ prompt: "Q", code: "q2" }, ["Q1", "Q2"]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /already uses the code Q2/);
});

test("a code is normalised rather than rejected — 'Q 1' means Q1", () => {
  assert.equal(normaliseCode("q 1"), "Q1");
  assert.equal(normaliseCode("  tech-2! "), "TECH2");
  assert.equal(normaliseCode(null), "");
});

test("every declared kind is accepted and anything else is not", () => {
  for (const k of QUESTION_KINDS) {
    assert.equal(checkQuestion({ prompt: "Q", kind: k }).ok, true, `${k} should be allowed`);
  }
  assert.equal(isQuestionKind("code"), false);
  assert.equal(checkQuestion({ prompt: "Q", kind: "code" }).ok, false);
});

test("retries and thinking time have bounds", () => {
  assert.equal(checkQuestion({ prompt: "Q", maxRetries: 11 }).ok, false);
  assert.equal(checkQuestion({ prompt: "Q", maxRetries: 10 }).ok, true);
  assert.equal(checkQuestion({ prompt: "Q", maxRetries: -1 }).ok, false);
  assert.equal(checkQuestion({ prompt: "Q", thinkSeconds: 601 }).ok, false);
});

/* ---------------------------------------------------------- requirements */

test("a requirement needs a name", () => {
  assert.equal(checkRequirement({ title: "" }).ok, false);
});

test("A REQUIREMENT WITH NO CRITERIA WARNS — that is what the model is actually shown", () => {
  /*
   * `criteria` is the only part of a requirement the analysis prompt presents
   * as "what meeting it looks like". Without it the model infers a standard,
   * and an invented standard applied to a person is the thing this product is
   * most obliged to avoid. It is still saveable: a requirement being drafted
   * is worth keeping.
   */
  const r = checkRequirement({ title: "Communicates clearly" });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /has to guess the standard/i);

  const full = checkRequirement({ title: "Communicates clearly", criteria: "Explains a technical idea to a non-technical listener without jargon." });
  assert.equal(full.warnings.length, 0);
});

test("weight is a multiplier with bounds, and zero is meaningful", () => {
  assert.equal(checkRequirement({ title: "T", weight: 0 }).ok, true, "zero means assess but do not rank on it");
  assert.equal(checkRequirement({ title: "T", weight: 11 }).ok, false);
  assert.equal(checkRequirement({ title: "T", weight: -1 }).ok, false);
  assert.equal(DEFAULT_WEIGHT, 1);
});

test("readiness says plainly when an interview cannot be evaluated", () => {
  assert.equal(analysisReadiness({ requirements: [], questions: [] }).ready, false);
  const noReqs = analysisReadiness({ requirements: [], questions: [{}] });
  assert.equal(noReqs.ready, false);
  assert.match(noReqs.say, /recorded and transcribed but not evaluated/i);

  const vague = analysisReadiness({ requirements: [{ criteria: "" }, { criteria: "x" }], questions: [{}] });
  assert.equal(vague.ready, true, "weak is not the same as broken");
  assert.match(vague.say, /1 of 2/);

  assert.equal(analysisReadiness({ requirements: [{ criteria: "x" }], questions: [{}] }).say, "Ready to evaluate.");
});

/* -------------------------------------------------------------- projects */

test("retention is bounded, and a short window is called out once", () => {
  assert.equal(checkProject({ retentionDays: 0 }).ok, false);
  assert.equal(checkProject({ retentionDays: 3651 }).ok, false);
  assert.equal(checkProject({ retentionDays: 1.5 }).ok, false, "days are whole");

  const short = checkProject({ retentionDays: 7 });
  assert.equal(short.ok, true);
  assert.match(short.warnings.join(" "), /deleted 7 days after/i);
  assert.match(short.warnings.join(" "), /cannot be undone/i);

  assert.equal(checkProject({ retentionDays: 90 }).warnings.length, 0);
});

test("consent text cannot be emptied — it is what the candidate agreed to", () => {
  assert.equal(checkProject({ consentText: "  " }).ok, false);
  /* absent is different from empty: a patch that does not mention it leaves it alone */
  assert.equal(checkProject({ name: "New name" }).ok, true);
});

test("only the four real statuses are accepted", () => {
  assert.equal(checkProject({ status: "open" }).ok, true);
  assert.equal(checkProject({ status: "live" }).ok, false);
});

/* ----------------------------------------------------------------- order */

test("reordering rewrites every position rather than swapping pairs", () => {
  const all = [
    { id: "a", position: 1 }, { id: "b", position: 2 }, { id: "c", position: 3 },
  ];
  assert.deepEqual(positionsFor(["c", "a", "b"], all), [
    { id: "c", position: 1 }, { id: "a", position: 2 }, { id: "b", position: 3 },
  ]);
});

test("A REORDER SENT AGAINST A STALE LIST DOES NOT DROP THE QUESTION SOMEBODY JUST ADDED", () => {
  /*
   * Two people in one project. One drags a question while the other adds one.
   * The drag arrives naming three ids of the four that now exist. Anything
   * unmentioned keeps its relative order and follows — it must not lose its
   * position, and it must certainly not be deleted by omission.
   */
  const all = [
    { id: "a", position: 1 }, { id: "b", position: 2 },
    { id: "c", position: 3 }, { id: "new", position: 4 },
  ];
  const out = positionsFor(["c", "a", "b"], all);
  assert.equal(out.length, 4, "nothing is dropped");
  assert.deepEqual(out.map((p) => p.id), ["c", "a", "b", "new"]);
  assert.deepEqual(out.map((p) => p.position), [1, 2, 3, 4], "positions are contiguous");
});

test("an id that does not belong to this project is ignored, not positioned", () => {
  const all = [{ id: "a", position: 1 }, { id: "b", position: 2 }];
  assert.deepEqual(positionsFor(["b", "somebody-elses-question", "a"], all).map((p) => p.id), ["b", "a"]);
});

test("generated codes do not collide with the ones already taken", () => {
  assert.equal(nextCode(["Q1", "Q2"], "Q"), "Q3");
  assert.equal(nextCode([], "R"), "R1");
  /* a gap in the sequence must not hand back a code that is already in use */
  const taken = ["Q1", "Q3"];
  assert.ok(!taken.includes(nextCode(taken, "Q")), "the generated code is free");
  /* nor may a differently-cased duplicate slip through */
  assert.ok(!["Q1", "q2"].map(normaliseCode).includes(nextCode(["Q1", "q2"], "Q")));
});
