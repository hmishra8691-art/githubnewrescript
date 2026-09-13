/**
 * THE VIDEO INTERVIEW — the gate, the states, and the columns.
 *
 * The thing this type promises is narrow and easy to get wrong: the
 * respondent heard the question before they answered it. A flag set when
 * Play is pressed does not prove that, and neither does `currentTime`
 * reaching the end — dragging the scrubber does both. So most of what is
 * proved here is about the difference between watching a clip and arriving
 * at the end of one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Question as QuestionSchema, SurveyDefinition, type Question } from "@rescript/schema";
import {
  foldWatchTick, interviewState, interviewAnswered, videoCompleted,
  interviewText, interviewProblems, requiresWatch, transcribes, savesAudio,
  retakeLimit, INTERVIEW_END_TOLERANCE,
} from "./interview.js";
import { buildVariableDictionary } from "./variables.js";
import { flattenVariables } from "./flatten.js";
import { createResponseState } from "./state.js";

const q = (over: Record<string, unknown> = {}): Question =>
  QuestionSchema.parse({
    id: "q1", code: "Q1", variableName: "Q1", type: "video_interview",
    variant: "qualitative.video_interview", text: "Tell me about your last visit.",
    settings: {
      readOnly: false, hidden: false,
      interviewVideo: { url: "https://example.test/ask.webm", source: "recorded", status: "ready", durationSeconds: 20 },
      ...((over.settings as object) ?? {}),
    },
    ...over,
  });

/** A one-question survey around the interview, with the schema's defaults. */
const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Interview", version: "1.0" },
  questions: [q()],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});

/** A watch record built by playing a clip honestly, one tick at a time. */
const watchHonestly = (duration: number, step = 0.5) => {
  let w;
  for (let t = step; t <= duration + 0.001; t += step) {
    w = foldWatchTick(w, { delta: step, position: Math.min(t, duration), duration });
  }
  return w;
};

/* ------------------------------------------------------------- the gate */

test("watching the clip through opens the gate", () => {
  const w = watchHonestly(20);
  assert.equal(w!.completed, true);
  assert.ok((w!.watchedSeconds ?? 0) >= 19.5, `seconds add up: ${w!.watchedSeconds}`);
  assert.equal(w!.seeks ?? 0, 0, "nothing was skipped");
  assert.equal(videoCompleted(q(), { watch: w }), true);
});

test("DRAGGING TO THE END DOES NOT — the bug this type exists to prevent", () => {
  /*
   * The respondent presses play, watches two seconds, then jumps to 19.9s.
   * `currentTime >= duration - tolerance` is satisfied and the browser fires
   * `ended`, so the condition the brief suggests would pass. The seconds do
   * not, and the seconds are what "watched" means.
   */
  let w = foldWatchTick(undefined, { delta: 0.5, position: 0.5, duration: 20 });
  w = foldWatchTick(w, { delta: 0.5, position: 1.0, duration: 20 });
  w = foldWatchTick(w, { delta: 0.5, position: 1.5, duration: 20 });
  w = foldWatchTick(w, { delta: 18.4, position: 19.9, duration: 20 });   // the drag

  assert.equal(w.seeks, 1, "the jump is counted, not silently swallowed");
  assert.ok((w.watchedSeconds ?? 0) < 2.5, `the jump added nothing: ${w.watchedSeconds}`);
  assert.equal(w.completed, undefined, "so the gate does not open");
  assert.equal(videoCompleted(q(), { watch: w }), false);
});

test("a browser that drops the last frames is not a respondent who skipped", () => {
  /* real players stop a shade short and never fire `ended` cleanly — a gate
     nobody can pass is worse than one that is a fraction generous */
  const w = watchHonestly(20 - INTERVIEW_END_TOLERANCE / 2);
  assert.equal(videoCompleted(q(), { watch: { ...w!, durationSeconds: 20, completed: true } }), true);
});

test("a clip with no measurable duration falls back to the end event", () => {
  /* a stream or a broken header: the seconds cannot be checked against
     anything, and refusing would strand the respondent */
  assert.equal(videoCompleted(q(), { watch: { completed: true, durationSeconds: 0, watchedSeconds: 0 } }), true);
});

test("a question that does not require watching is never gated", () => {
  const relaxed = q({ settings: { requireWatch: false } });
  assert.equal(requiresWatch(relaxed), false);
  assert.equal(videoCompleted(relaxed, {}), true);
});

test("a question with no video cannot demand one be watched", () => {
  const none = QuestionSchema.parse({
    id: "q2", code: "Q2", variableName: "Q2", type: "video_interview", text: "",
    settings: { readOnly: false, hidden: false },
  });
  assert.equal(requiresWatch(none), false, "otherwise the question is unanswerable by construction");
});

/* ----------------------------------------------------------- the states */

test("the states follow the interview, in order", () => {
  const Q = q();
  const w = watchHonestly(20);
  assert.equal(interviewState(Q, {}), "VIDEO_NOT_STARTED");
  assert.equal(interviewState(Q, { watch: { started: true, watchedSeconds: 3, durationSeconds: 20 } }), "VIDEO_PLAYING");
  assert.equal(interviewState(Q, { watch: w }), "VIDEO_COMPLETED");
  assert.equal(interviewState(Q, { watch: w }, { recording: true }), "RECORDING");
  assert.equal(interviewState(Q, { watch: w }, { uploading: true }), "PROCESSING");
  assert.equal(interviewState(Q, { watch: w }, { transcribing: true }), "TRANSCRIBING");
  assert.equal(interviewState(Q, { watch: w, audio: { url: "https://x/a.webm" } }), "ANSWER_COMPLETED");
  assert.equal(interviewState(Q, {}, { error: "no microphone" }), "ERROR");
});

test("an error outranks everything — it is what the respondent must act on", () => {
  const w = watchHonestly(20);
  assert.equal(interviewState(q(), { watch: w }, { recording: true, error: "x" }), "ERROR");
});

/* ---------------------------------------------------------- answeredness */

test("an answer needs the video watched AND the recording stored", () => {
  const Q = q();
  const w = watchHonestly(20);
  assert.equal(interviewAnswered(Q, { audio: { url: "https://x/a.webm" } }), false, "answering without watching is not answering the question asked");
  assert.equal(interviewAnswered(Q, { watch: w }), false, "watching is not answering");
  assert.equal(interviewAnswered(Q, { watch: w, audio: { url: "https://x/a.webm" } }), true);
});

test("A MISSING TRANSCRIPT DOES NOT BLOCK — the clip is the answer", () => {
  /*
   * No provider, an empty wallet, a timeout: all of them leave the recording
   * safely stored and the transcript absent. A transcript can be generated
   * again from a stored clip; an interview nobody could finish cannot.
   */
  const w = watchHonestly(20);
  const v = { watch: w, audio: { url: "https://x/a.webm" }, transcript: { source: "none" as const, failed: true } };
  assert.equal(interviewAnswered(q(), v), true);
  assert.equal(interviewState(q(), v), "ANSWER_COMPLETED");
});

test("when the recording is discarded by configuration, the transcript is the answer", () => {
  const Q = q({ settings: { saveAnswerAudio: false } });
  const w = watchHonestly(20);
  assert.equal(savesAudio(Q), false);
  assert.equal(interviewAnswered(Q, { watch: w }), false);
  assert.equal(interviewAnswered(Q, { watch: w, transcript: { text: "I went last Tuesday.", source: "provider" } }), true);
});

test("keeping no transcript turns transcription off rather than paying for nothing", () => {
  assert.equal(transcribes(q()), true);
  assert.equal(transcribes(q({ settings: { saveTranscript: false } })), false);
  assert.equal(transcribes(q({ settings: { transcribeAnswer: false } })), false);
});

/* ------------------------------------------------------------ the limits */

test("recording length is reported as a sentence, not a rejection", () => {
  const Q = q({ settings: { minAnswerSeconds: 10, maxAnswerSeconds: 60 } });
  const w = watchHonestly(20);
  assert.deepEqual(interviewProblems(Q, { watch: w, audio: { url: "u", durationSeconds: 30 } }), []);
  assert.match(interviewProblems(Q, { watch: w, audio: { url: "u", durationSeconds: 4 } })[0], /at least/);
  assert.match(interviewProblems(Q, { watch: w, audio: { url: "u", durationSeconds: 90 } })[0], /under/);
});

test("re-records default to three and can be set to one take", () => {
  assert.equal(retakeLimit(q()), 3);
  assert.equal(retakeLimit(q({ settings: { maxRetakes: 0 } })), 0);
  assert.equal(retakeLimit(q({ settings: { maxRetakes: 7 } })), 7);
});

/* ------------------------------------------------------------- the data */

test("the transcript is the textual form — what pipes, and what logic compares", () => {
  assert.equal(interviewText({ transcript: { text: "  I went last Tuesday.  " } }), "I went last Tuesday.");
  assert.equal(interviewText({ audio: { url: "https://x/a.webm" } }), "", "never a URL");
  assert.equal(interviewText(null), "");
});

test("every column the dictionary declares is a column the export writes", () => {
  const def = survey();
  const state = createResponseState(def, {});
  const w = watchHonestly(20);
  (state.answers as Record<string, unknown>).q1 = {
    watch: w,
    audio: { url: "https://x/a.webm", durationSeconds: 42.4, retakes: 1 },
    transcript: { text: "I went last Tuesday.", source: "provider" },
  };

  const declared = buildVariableDictionary(def).filter((v) => v.questionId === "q1").map((v) => v.name);
  const written = Object.keys(flattenVariables(def, state));
  for (const name of declared) {
    assert.ok(written.includes(name), `${name} is declared but never written`);
  }

  const flat = flattenVariables(def, state) as Record<string, unknown>;
  assert.equal(flat.Q1, "I went last Tuesday.", "the base column is what an analyst reads");
  assert.equal(flat.Q1_AUDIO_URL, "https://x/a.webm");
  assert.equal(flat.Q1_DURATION_S, 42.4);
  assert.equal(flat.Q1_RETAKES, 1);
  assert.equal(flat.Q1_TRANSCRIPT_SOURCE, "provider");
  assert.equal(flat.Q1_VIDEO_COMPLETED, 1);
  assert.ok((flat.Q1_WATCHED_S as number) >= 19.5);
});

test("a half-finished interview exports blanks, never a zero an analyst would count", () => {
  const def = survey();

  /* untouched: no columns at all, which is this platform's convention for
     every type — the exporter fills the blanks, so the data file is square */
  const empty = flattenVariables(def, createResponseState(def, {})) as Record<string, unknown>;
  assert.equal(empty.Q1, undefined, "an unanswered question writes nothing, as every type does");

  /* watched but not yet answered: the watch record IS known, the recording is
     not, and the difference has to survive into the data file */
  const state = createResponseState(def, {});
  (state.answers as Record<string, unknown>).q1 = { watch: watchHonestly(20) };
  const flat = flattenVariables(def, state) as Record<string, unknown>;
  assert.equal(flat.Q1, "", "no transcript yet");
  assert.equal(flat.Q1_AUDIO_URL, "");
  assert.equal(flat.Q1_DURATION_S, "", "blank, not 0 — they did not speak for zero seconds");
  assert.equal(flat.Q1_VIDEO_COMPLETED, 1, "but we do know they watched it");
});
