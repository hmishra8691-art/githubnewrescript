import test from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_KINDS, MEDIA_BUCKETS, RECORDING_CONSTRAINTS, STT_MAX_BYTES,
  expectedVideoBytes, expectedAudioBytes, extensionFor, safeSegment, mediaPath, secondsThatFit,
  withinLimit, acceptsType, transcriptPending, TRANSCRIPT_SAY,
} from "./plan.js";

/*
 * The policy, asserted without a database, a browser or a network — which is
 * the point of it being pure. Most of these are guarding a number that, when
 * it was absent, was the bug.
 */

/** Supabase's default project-wide upload ceiling, which no bucket may exceed. */
const DEFAULT_PROJECT_LIMIT = 50 * 1024 * 1024;

test("five minutes of video fits inside a DEFAULT Supabase project, with room to spare", () => {
  const fiveMinutes = expectedVideoBytes(300);
  assert.ok(fiveMinutes < DEFAULT_PROJECT_LIMIT * 0.85,
    `five minutes is ${Math.round(fiveMinutes / 1024 / 1024)} MB and a default project accepts ${DEFAULT_PROJECT_LIMIT / 1024 / 1024} MB`);
  /* the brief asks for five; the encoder overshoots, hence the margin */
  assert.ok(fiveMinutes < MEDIA_KINDS.question_video.maxBytes);
});

test("the recorder stops where storage stops, not where this package would like", () => {
  /* a default 50 MB project: five minutes must still be offered */
  const fits = secondsThatFit("question_video", DEFAULT_PROJECT_LIMIT);
  assert.ok(fits >= 300, `a default project should allow at least five minutes, got ${fits}s`);
  assert.ok(expectedVideoBytes(fits) < DEFAULT_PROJECT_LIMIT, "and what it allows must actually fit");

  /* a generous project is capped by the recorder's own ceiling instead */
  assert.equal(secondsThatFit("question_video", 5 * 1024 * 1024 * 1024), RECORDING_CONSTRAINTS.maxSeconds);

  /* a mean one still offers something rather than zero */
  assert.ok(secondsThatFit("question_video", 1024 * 1024) >= 30);

  /* audio is judged at the audio bitrate, so it fits far more */
  assert.ok(secondsThatFit("answer_audio", DEFAULT_PROJECT_LIMIT) > secondsThatFit("question_video", DEFAULT_PROJECT_LIMIT));
});

test("the size verdict measures against the ceiling it is given", () => {
  /* what the package would allow */
  assert.equal(withinLimit("question_video", 60 * 1024 * 1024).ok, true);
  /* what a default project actually allows */
  const no = withinLimit("question_video", 60 * 1024 * 1024, DEFAULT_PROJECT_LIMIT);
  assert.equal(no.ok, false);
  assert.match(no.message!, /50 MB/, "the message names the real ceiling, not the wished-for one");
  assert.match(no.message!, /this project/);
});

test("the old defaults would NOT have fitted — which is why it failed", () => {
  /* 1080p at Chrome's default ~2.5 Mbps, five minutes */
  const oldWay = Math.round((2_500_000 / 8) * 300);
  assert.ok(oldWay > 85 * 1024 * 1024, "the old recording really was that big");
  /* and far past what a serverless request body accepts */
  assert.ok(oldWay > 4.5 * 1024 * 1024 * 10);
});

test("the audio companion stays inside what a transcription service reads", () => {
  assert.ok(expectedAudioBytes(300) < STT_MAX_BYTES);
  assert.ok(expectedAudioBytes(RECORDING_CONSTRAINTS.maxSeconds) < STT_MAX_BYTES,
    "even a ten-minute take must be transcribable without extracting audio server-side");
  /* and a five-minute VIDEO would not be, which is why the companion exists */
  assert.ok(expectedVideoBytes(300) > STT_MAX_BYTES);
});

test("every kind names a bucket that the bucket list knows", () => {
  for (const [kind, spec] of Object.entries(MEDIA_KINDS)) {
    assert.ok(MEDIA_BUCKETS.includes(spec.bucket), `${kind} → ${spec.bucket}`);
    assert.ok(spec.maxBytes > 0 && spec.signedSeconds > 0);
  }
});

test("paths are keyed by their owner: survey for stimuli, session for answers", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    mediaPath("question_video", { surveyId: "sv1", questionId: "q1", fileName: "question.webm", now }),
    `sv1/q1/${now}-question.webm`,
  );
  assert.equal(
    mediaPath("answer_audio", { surveyId: "sv1", questionId: "q1", sessionId: "sess-abc", fileName: "answer.webm", now }),
    `sess-abc/q1/${now}-answer.webm`,
  );
});

test("a path segment can never collapse to nothing", () => {
  assert.equal(safeSegment(""), "_");
  assert.equal(safeSegment("../../etc/passwd"), "____etc_passwd");
  assert.equal(safeSegment("..."), "_");
  assert.equal(safeSegment("a/b\\c"), "a_b_c");
  assert.equal(safeSegment("question.webm"), "question.webm", "an ordinary name is untouched");
  /* a traversal attempt must not produce a path that leaves the folder */
  const p = mediaPath("question_video", { surveyId: "../other", questionId: "../..", fileName: "../x.webm", now: 1 });
  assert.equal(p.split("/").length, 3, p);
  assert.ok(!p.includes(".."), p);
});

test("extensions follow the content type, and default to what browsers record", () => {
  assert.equal(extensionFor("video/webm;codecs=vp9,opus"), "webm");
  assert.equal(extensionFor("video/mp4"), "mp4");
  assert.equal(extensionFor("audio/ogg;codecs=opus"), "ogg");
  assert.equal(extensionFor(undefined), "webm");
  assert.equal(extensionFor("application/x-nonsense"), "webm");
});

test("a file over the limit is refused with a sentence, not a status code", () => {
  const ok = withinLimit("question_video", 10 * 1024 * 1024);
  assert.equal(ok.ok, true);
  const no = withinLimit("question_video", 400 * 1024 * 1024);
  assert.equal(no.ok, false);
  assert.match(no.message!, /400 MB/);
  assert.match(no.message!, /150 MB/);
  assert.match(no.message!, /shorter take/);
  assert.ok(!/\b413\b/.test(no.message!), "a researcher cannot act on a status code");
});

test("a slot takes the kind of media it is for, and says which when it does not", () => {
  assert.equal(acceptsType("question_video", "video/webm").ok, true);
  assert.equal(acceptsType("question_video", "audio/webm").ok, false);
  assert.match(acceptsType("question_video", "image/png").message!, /image\/png/);
  assert.match(acceptsType("question_video", "image/png").message!, /video file/);
  assert.equal(acceptsType("answer_audio", "audio/webm").ok, true);
  /* the catch-all respondent upload takes anything, as it always did */
  assert.equal(acceptsType("answer_upload", "application/pdf").ok, true);
});

test("only the two audio kinds are transcribed", () => {
  assert.equal(MEDIA_KINDS.question_audio.transcribed, true);
  assert.equal(MEDIA_KINDS.answer_audio.transcribed, true);
  assert.equal(MEDIA_KINDS.question_video.transcribed, false);
  assert.equal(MEDIA_KINDS.answer_upload.transcribed, false);
  assert.equal(MEDIA_KINDS.localization_audio.transcribed, false);
});

test("pending is exactly the three states that still change on their own", () => {
  assert.equal(transcriptPending("waiting"), true);
  assert.equal(transcriptPending("processing"), true);
  assert.equal(transcriptPending("transcribing"), true);
  assert.equal(transcriptPending("completed"), false);
  assert.equal(transcriptPending("failed"), false);
  assert.equal(transcriptPending(undefined), false);
  /* every state has something to say */
  for (const [k, v] of Object.entries(TRANSCRIPT_SAY)) assert.ok(v.length > 0, k);
});
