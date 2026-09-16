import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drawSequence, explainDraw, seededRandom, shuffle, seedFor, DrawError,
  advanceInterview, advanceResponse, canRetake, canSkip, isAbandoned, isExpired,
  linkVerdict, progressOf, TransitionError, INTERVIEW_STATUSES, RESPONSE_STATUSES,
  INTERVIEW_SAY, RESPONSE_SAY,
  TELEMETRY_KINDS, TELEMETRY_SAY, summariseSignals, permissionAdvice, SIGNALS_CAVEAT,
  verifyEvidence, summariseRequirements, locateQuote, normaliseForMatch,
  VERDICTS, VERDICT_SAY, ANALYSIS_CAVEAT, FORBIDDEN_INFERENCES,
  limitStatus, projectLimits, blockingLimit, recordingSeconds, expectedBytes,
  secondsThatFit, retentionDue, retentionRemainingDays, jobBackoffMs,
  type QuestionSpec, type PoolSpec,
} from "./index.js";

/* ================================================================== draw */

const pool = (code: string, draw: number | null, position: number): PoolSpec =>
  ({ id: `p_${code}`, code, draw, position });
const q = (code: string, poolCode: string | null, position: number): QuestionSpec =>
  ({ id: `q_${code}`, code, poolId: poolCode ? `p_${poolCode}` : null, position });

/* the brief's own example: 3 of HR, 7 of 30 technical, 3 of behavioural */
const POOLS = [pool("HR", 3, 1), pool("TECH", 7, 2), pool("BEH", 3, 3)];
const QUESTIONS: QuestionSpec[] = [
  ...Array.from({ length: 10 }, (_, i) => q(`HR${i + 1}`, "HR", i)),
  ...Array.from({ length: 30 }, (_, i) => q(`T${i + 1}`, "TECH", i)),
  ...Array.from({ length: 15 }, (_, i) => q(`B${i + 1}`, "BEH", i)),
];

test("draw: the brief's arrangement produces the right shape", () => {
  const { sequence, shortfalls } = drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "iv-1" });
  assert.equal(sequence.length, 13, "3 + 7 + 3");
  assert.deepEqual(shortfalls, []);
  assert.deepEqual(sequence.map((s) => s.position), Array.from({ length: 13 }, (_, i) => i + 1));
  const kinds = sequence.map((s) => s.poolId);
  assert.deepEqual(kinds.slice(0, 3), ["p_HR", "p_HR", "p_HR"], "the pool blocks keep their order");
  assert.deepEqual(kinds.slice(3, 10), Array(7).fill("p_TECH"));
  assert.deepEqual(kinds.slice(10), Array(3).fill("p_BEH"));
  assert.equal(new Set(sequence.map((s) => s.questionId)).size, 13, "and nothing is asked twice");
});

test("draw: the same seed draws the same interview, every time and everywhere", () => {
  const a = drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "iv-1" }).sequence;
  const b = drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "iv-1" }).sequence;
  assert.deepEqual(a, b);
});

test("draw: consecutive seeds are not near-identical draws", () => {
  const a = drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "iv-1" }).sequence.map((s) => s.code);
  const b = drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "iv-2" }).sequence.map((s) => s.code);
  assert.notDeepEqual(a, b, "two candidates invited a moment apart get different interviews");
  const shared = a.filter((c) => b.includes(c)).length;
  assert.ok(shared < 13, `${shared}/13 shared — the seeds are too close together`);
});

test("draw: the whole pool is reachable across candidates", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    for (const s of drawSequence({ pools: POOLS, questions: QUESTIONS, seed: `iv-${i}` }).sequence) {
      seen.add(s.code);
    }
  }
  const tech = [...seen].filter((c) => c.startsWith("T"));
  assert.equal(tech.length, 30, "every one of the 30 technical questions can come up");
});

test("draw: taking a subset always shuffles — otherwise it is a list, not a pool", () => {
  const one = drawSequence({ pools: [pool("TECH", 7, 1)], questions: QUESTIONS.filter((x) => x.poolId === "p_TECH"), seed: "a" });
  const two = drawSequence({ pools: [pool("TECH", 7, 1)], questions: QUESTIONS.filter((x) => x.poolId === "p_TECH"), seed: "b" });
  assert.notDeepEqual(one.sequence.map((s) => s.code), two.sequence.map((s) => s.code));
});

test("draw: a subset is presented in the bank's own order unless randomize is on", () => {
  const { sequence } = drawSequence({ pools: [pool("TECH", 7, 1)], questions: QUESTIONS.filter((x) => x.poolId === "p_TECH"), seed: "a" });
  const positions = sequence.map((s) => Number(s.code.slice(1)));
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y),
    "a randomised SELECTION does not force a randomised PRESENTATION");
});

test("draw: loose questions bracket the randomised body", () => {
  const questions = [q("INTRO", null, -1), ...QUESTIONS, q("ANYTHING", null, 999)];
  const { sequence } = drawSequence({ pools: POOLS, questions, seed: "iv-1" });
  assert.equal(sequence[0]!.code, "INTRO", "the fixed opening stays first");
  assert.equal(sequence.at(-1)!.code, "ANYTHING", "and the fixed closing stays last");
  assert.equal(sequence.length, 15);
});

test("draw: a pool asking for more than it holds gets all of it, and says so", () => {
  const { sequence, shortfalls } = drawSequence({
    pools: [pool("HR", 20, 1)], questions: QUESTIONS.filter((x) => x.poolId === "p_HR"), seed: "a",
  });
  assert.equal(sequence.length, 10, "an interview one question short beats an interview that will not start");
  assert.deepEqual(shortfalls, [{ poolCode: "HR", wanted: 20, available: 10 }]);
});

test("draw: an empty pool contributes nothing rather than failing", () => {
  const { sequence } = drawSequence({ pools: [pool("EMPTY", 3, 1), pool("HR", 2, 2)], questions: QUESTIONS, seed: "a" });
  assert.equal(sequence.length, 2);
});

test("draw: no seed is refused — an unreproducible draw is not a draw", () => {
  assert.throws(() => drawSequence({ pools: POOLS, questions: QUESTIONS, seed: "" }), DrawError);
});

test("audit: a recorded sequence is explained against the bank as it is now", () => {
  const seed = seedFor("iv-7");
  const input = { pools: POOLS, questions: QUESTIONS, seed };
  const recorded = drawSequence(input).sequence;

  const same = explainDraw(recorded, input);
  assert.equal(same.matches, true, "an unchanged bank reproduces the sequence exactly");
  assert.deepEqual(same.onlyRecorded, []);

  /* somebody archives a question after the candidate sat */
  const edited = { ...input, questions: QUESTIONS.filter((x) => x.code !== recorded[5]!.code) };
  const after = explainDraw(recorded, edited);
  assert.equal(after.matches, false);
  assert.ok(after.onlyRecorded.includes(recorded[5]!.code),
    "and the audit says exactly which question is no longer in the bank");
  assert.ok(after.recomputed.length > 0, "while still showing what the bank would draw today");
});

test("random: the generator is deterministic and the shuffle is uniform-ish", () => {
  const a = Array.from({ length: 5 }, seededRandom("x"));
  const r1 = seededRandom("x"); const r2 = seededRandom("x");
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
  assert.notDeepEqual([seededRandom("x")()], [seededRandom("y")()]);
  void a;

  /* every element reaches every position over enough draws — the property a
     sort-based shuffle fails */
  const first = new Map<number, number>();
  for (let i = 0; i < 3000; i++) {
    const s = shuffle([1, 2, 3, 4, 5], seededRandom(`s${i}`));
    first.set(s[0]!, (first.get(s[0]!) ?? 0) + 1);
  }
  assert.equal(first.size, 5, "every element can come first");
  for (const [, n] of first) assert.ok(n > 400 && n < 800, `lopsided shuffle: ${n}/3000`);
});

/* ============================================================== the flow */

test("flow: every status has a sentence a person can read", () => {
  for (const s of INTERVIEW_STATUSES) assert.ok(INTERVIEW_SAY[s], `no wording for ${s}`);
  for (const s of RESPONSE_STATUSES) assert.ok(RESPONSE_SAY[s], `no wording for ${s}`);
});

test("flow: an answer is only ever `stored` after an upload", () => {
  assert.equal(advanceResponse("uploading", "stored"), "stored");
  for (const from of RESPONSE_STATUSES) {
    if (from === "uploading" || from === "stored") continue;
    assert.throws(() => advanceResponse(from, "stored"), TransitionError,
      `${from} → stored must be impossible: it is what lets somebody believe an answer is safe`);
  }
});

test("flow: a take can be retried, and a failure is recoverable", () => {
  assert.equal(advanceResponse("recording", "failed"), "failed");
  assert.equal(advanceResponse("failed", "recording"), "recording");
  assert.equal(advanceResponse("stored", "recording"), "recording", "a retake starts again");
  assert.equal(advanceInterview("failed", "in_progress"), "in_progress");
});

test("flow: an expired interview is the end of the line", () => {
  assert.throws(() => advanceInterview("expired", "in_progress"), TransitionError);
  assert.equal(advanceInterview("abandoned", "in_progress"), "in_progress",
    "but somebody who comes back to an abandoned link resumes it");
});

test("flow: progress counts what is stored, never what was sent", () => {
  const p = progressOf([
    { questionId: "a", status: "stored", required: true },
    { questionId: "b", status: "uploading", required: true },
    { questionId: "c", status: "skipped", required: false },
  ]);
  assert.equal(p.stored, 1, "an upload in flight is a promise, not progress");
  assert.equal(p.skipped, 1);
  assert.equal(p.outstanding, 1);
  assert.equal(p.complete, false);
  assert.ok(Math.abs(p.fraction - 2 / 3) < 1e-9);
});

test("flow: an interview is complete when every REQUIRED question is settled", () => {
  const p = progressOf([
    { questionId: "a", status: "stored", required: true },
    { questionId: "b", status: "pending", required: false },
  ]);
  assert.equal(p.complete, true, "an unanswered optional question does not hold it open");
});

test("flow: retries count discarded takes, so zero means one recording", () => {
  assert.equal(canRetake(0, 0), false, "zero retries is one take, not no takes");
  assert.equal(canRetake(0, 2), true);
  assert.equal(canRetake(2, 2), false);
  assert.equal(canSkip(false), true);
  assert.equal(canSkip(true), false);
});

test("flow: a link says the same thing to the page and to the route", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.deepEqual(linkVerdict({ status: "invited", expiresAt: null, now }), { ok: true, resuming: false });
  assert.deepEqual(linkVerdict({ status: "in_progress", expiresAt: null, now }), { ok: true, resuming: true });

  const expired = linkVerdict({ status: "invited", expiresAt: new Date("2026-05-01T00:00:00Z"), now });
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.reason, "expired");

  const done = linkVerdict({ status: "processed", expiresAt: null, now });
  assert.equal(done.ok, false);
  assert.equal(done.ok === false && done.reason, "finished");
  assert.match(done.ok === false ? done.message : "", /already been completed/);

  /* a completed interview whose link has passed its date is FINISHED, not expired */
  const both = linkVerdict({ status: "completed", expiresAt: new Date("2026-05-01T00:00:00Z"), now });
  assert.equal(both.ok === false && both.reason, "finished");
});

test("flow: somebody getting a glass of water has not abandoned the interview", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const ago = (m: number) => new Date(now.getTime() - m * 60_000);
  assert.equal(isAbandoned(ago(20), now), false, "twenty minutes is a phone call");
  assert.equal(isAbandoned(ago(180), now), true, "three hours is somebody not coming back");
  assert.equal(isAbandoned(null, now), false);
  assert.equal(isExpired(null, now), false);
});

/* =========================================================== telemetry */

test("telemetry: every event has a neutral sentence, and none of them accuses anybody", () => {
  for (const k of TELEMETRY_KINDS) {
    const say = TELEMETRY_SAY[k];
    assert.ok(say, `no wording for ${k}`);
    assert.doesNotMatch(say.toLowerCase(), /cheat|suspicious|violation|fraud|dishonest|caught/,
      `"${say}" is a judgement, not an observation`);
  }
  assert.match(SIGNALS_CAVEAT, /not evidence of anything on their own/);
});

test("telemetry: signals are counted per kind and never totalled into a score", () => {
  const out = summariseSignals([
    { kind: "visibility_hidden", detail: { seconds: 4 } },
    { kind: "visibility_hidden", detail: { seconds: 40 } },
    { kind: "copy" },
    { kind: "recording_started" },
  ]);
  const hidden = out.find((s) => s.kind === "visibility_hidden")!;
  assert.equal(hidden.count, 2);
  assert.equal(hidden.totalSeconds, 44);
  assert.equal(out.find((s) => s.kind === "copy")!.totalSeconds, null,
    "an event with no duration does not get a made-up one");
  assert.equal(out.find((s) => s.kind === "recording_started"), undefined,
    "ordinary progress is not an environment signal");
  assert.ok(!("score" in (out[0] as object)) && !("severity" in (out[0] as object)));
});

test("telemetry: a blocked camera is told apart from one nobody has asked about", () => {
  assert.match(permissionAdvice("camera", "denied")!, /site settings/);
  assert.match(permissionAdvice("microphone", "prompt")!, /Allow/);
  assert.match(permissionAdvice("camera", "unavailable")!, /connected/);
  assert.equal(permissionAdvice("camera", "granted"), null);
});

/* ============================================================ evidence */

const SOURCES = [{
  responseId: "r1", questionId: "q1", questionCode: "Q1",
  text: "I spent three years at a fintech building services in Python, and we ran everything on AWS Lambda.",
  segments: [
    { start: 0, end: 4, text: "I spent three years at a fintech" },
    { start: 4, end: 9, text: "building services in Python," },
    { start: 9, end: 14, text: "and we ran everything on AWS Lambda." },
  ],
}];
const REQS = [
  { id: "req1", code: "R1", title: "Strong Python experience" },
  { id: "req2", code: "R2", title: "AWS experience" },
  { id: "req3", code: "R3", title: "Team leadership" },
];

test("evidence: a real quote is kept, located and timestamped", () => {
  const { evidence } = verifyEvidence([{
    requirementId: "req1", responseId: "r1", verdict: "evidence",
    explanation: "Names Python directly.", quote: "building services in Python",
  }], SOURCES, REQS);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.verdict, "evidence");
  assert.equal(evidence[0]!.quoteStartSeconds, 4);
  assert.equal(evidence[0]!.quoteEndSeconds, 9);
  assert.equal(evidence[0]!.questionId, "q1");
});

test("evidence: an INVENTED quote is downgraded — this is the hallucination check", () => {
  const { evidence } = verifyEvidence([{
    requirementId: "req3", responseId: "r1", verdict: "evidence",
    explanation: "They led a team of six engineers.",
    quote: "I led a team of six engineers for two years",
  }], SOURCES, REQS);
  assert.equal(evidence[0]!.verdict, "insufficient",
    "a confident paragraph about something nobody said must not become a finding");
  assert.equal(evidence[0]!.downgradedFrom, "evidence");
  assert.match(evidence[0]!.downgradeReason!, /does not appear/);
  assert.equal(evidence[0]!.quote, null, "and the fabrication is not shown to anybody");
});

test("evidence: a claim with no quote at all is downgraded", () => {
  const { evidence } = verifyEvidence([{
    requirementId: "req2", responseId: "r1", verdict: "partial",
    explanation: "Seems to know cloud platforms.", quote: null,
  }], SOURCES, REQS);
  assert.equal(evidence[0]!.verdict, "insufficient");
  assert.match(evidence[0]!.downgradeReason!, /no supporting passage/);
});

test("evidence: a citation to an answer that is not in this interview is dropped", () => {
  const { evidence, dropped } = verifyEvidence([
    { requirementId: "req1", responseId: "ghost", verdict: "evidence", explanation: "x", quote: "Python" },
    { requirementId: "nope", responseId: "r1", verdict: "evidence", explanation: "x", quote: "Python" },
  ], SOURCES, REQS);
  assert.equal(evidence.length, 0);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0]!.reason, /not part of this interview/);
  assert.match(dropped[1]!.reason, /does not have/);
});

test("evidence: `insufficient` needs no quote and is not a verdict about the person", () => {
  const { evidence } = verifyEvidence([{
    requirementId: "req3", responseId: null, verdict: "insufficient",
    explanation: "Nothing in these answers covers leadership.",
  }], SOURCES, REQS);
  assert.equal(evidence[0]!.verdict, "insufficient");
  assert.equal(evidence[0]!.downgradedFrom, undefined, "it was not downgraded — it was already honest");
  assert.deepEqual(VERDICTS, ["evidence", "partial", "insufficient"]);
  assert.equal(VERDICT_SAY.insufficient, "Insufficient evidence");
});

test("evidence: matching survives tidied punctuation but not a paraphrase", () => {
  assert.equal(normaliseForMatch("  We’re “done” — really.  "), 'we\'re "done" - really');
  const ok = verifyEvidence([{
    requirementId: "req2", responseId: "r1", verdict: "evidence", explanation: "x",
    quote: "we ran everything on AWS Lambda.",
  }], SOURCES, REQS).evidence[0]!;
  assert.equal(ok.verdict, "evidence", "trailing punctuation and case do not break a real quote");

  const paraphrase = verifyEvidence([{
    requirementId: "req2", responseId: "r1", verdict: "evidence", explanation: "x",
    quote: "everything we ran was on AWS Lambda",
  }], SOURCES, REQS).evidence[0]!;
  assert.equal(paraphrase.verdict, "insufficient", "a reordered sentence is not a quote");
});

test("evidence: a quote spanning segments still gets a timestamp", () => {
  const at = locateQuote(SOURCES[0]!, "in Python, and we ran everything");
  assert.equal(at.start, 4);
  assert.equal(at.end, 14);
  assert.deepEqual(locateQuote(SOURCES[0]!, "nothing like this"), { start: null, end: null });
});

test("evidence: the roll-up takes the strongest finding per requirement", () => {
  const { evidence } = verifyEvidence([
    { requirementId: "req1", responseId: "r1", verdict: "partial", explanation: "x", quote: "three years at a fintech" },
    { requirementId: "req1", responseId: "r1", verdict: "evidence", explanation: "x", quote: "building services in Python" },
    { requirementId: "req3", responseId: "r1", verdict: "evidence", explanation: "x", quote: "invented" },
  ], SOURCES, REQS);
  const summary = summariseRequirements(REQS, evidence);
  assert.equal(summary.find((s) => s.code === "R1")!.verdict, "evidence",
    "a skill shown once is not un-shown by the next answer");
  assert.equal(summary.find((s) => s.code === "R2")!.verdict, "insufficient");
  assert.equal(summary.find((s) => s.code === "R3")!.downgraded, 1,
    "and a reviewer can see the model was checked");
});

test("evidence: the caveats exist and name what may not be inferred", () => {
  assert.match(ANALYSIS_CAVEAT, /not an assessment of the candidate/);
  for (const f of ["facial appearance", "emotion", "accent", "eye movement", "disability", "personality"]) {
    assert.ok(FORBIDDEN_INFERENCES.includes(f), `${f} must be on the forbidden list`);
  }
});

/* ============================================================== limits */

test("limits: a cap warns before it bites", () => {
  assert.equal(limitStatus({ used: 10, limit: 100, unit: "x" }).level, "ok");
  assert.equal(limitStatus({ used: 85, limit: 100, unit: "x" }).level, "approaching");
  assert.equal(limitStatus({ used: 100, limit: 100, unit: "x" }).level, "reached");
  assert.equal(limitStatus({ used: 1e9, limit: null, unit: "x" }).level, "ok");
  assert.equal(limitStatus({ used: 1e9, limit: null, unit: "x" }).message, null);
  assert.match(limitStatus({ used: 90, limit: 100, unit: "recording minutes" }).message!, /10 of 100/);
});

test("limits: a recording is bounded by the smallest opinion, not the most specific", () => {
  assert.equal(recordingSeconds({ questionMaxSeconds: 600, projectMaxSeconds: 300 }), 300,
    "a question set longer than the project allows does not get to spend the money");
  assert.equal(recordingSeconds({ questionMaxSeconds: 120, projectMaxSeconds: 300 }), 120);
  assert.equal(recordingSeconds({}), 900);
  assert.equal(recordingSeconds({ questionMaxSeconds: 0 }), 900, "a nonsense limit is ignored");
});

test("limits: the size of a recording is known before anybody speaks", () => {
  const fiveMinutes = expectedBytes(300);
  assert.ok(fiveMinutes > 40e6 && fiveMinutes < 50e6, `five minutes is ${fiveMinutes} bytes`);
  assert.ok(expectedBytes(300, "audio") < 3e6, "the audio companion is small enough to transcribe");
  assert.ok(Math.abs(secondsThatFit(expectedBytes(300)) - 300) <= 1, "the inverse agrees");
  assert.equal(secondsThatFit(0), 0);
});

test("limits: the first thing that would stop a recording is named exactly", () => {
  const usage = { storageBytes: 50 * 1024 ** 3, recordingSeconds: 100, transcriptionSeconds: 0, analyses: 0 };
  const caps = { maxStorageBytes: 10 * 1024 ** 3, maxRecordingSeconds: null, maxTranscriptionSeconds: null, maxAiAnalyses: null };
  assert.match(blockingLimit(usage, caps)!, /storage/);
  assert.equal(blockingLimit(usage, { ...caps, maxStorageBytes: null }), null);
  const l = projectLimits(usage, caps);
  assert.equal(l.storage.level, "reached");
  assert.equal(l.recording.level, "ok");
});

test("limits: retention is due after the window and counts down before it", () => {
  const done = new Date("2026-01-01T00:00:00Z");
  const later = (d: number) => new Date(done.getTime() + d * 86400000);
  assert.equal(retentionDue(done, 30, later(29)), false);
  assert.equal(retentionDue(done, 30, later(31)), true);
  assert.equal(retentionDue(done, null, later(9999)), false, "no policy means keep it");
  assert.equal(retentionDue(null, 30, later(99)), false, "an unfinished interview is not due");
  assert.equal(retentionRemainingDays(done, 30, later(10)), 20);
  assert.equal(retentionRemainingDays(done, 30, later(99)), 0);
  assert.equal(retentionRemainingDays(done, null, later(1)), null);
});

test("limits: job backoff grows, caps at an hour, and is jittered", () => {
  assert.equal(jobBackoffMs(1, () => 1), 30_000);
  assert.equal(jobBackoffMs(2, () => 1), 60_000);
  assert.equal(jobBackoffMs(20, () => 1), 3_600_000);
  assert.ok(jobBackoffMs(3, () => 0) < jobBackoffMs(3, () => 1));
});
