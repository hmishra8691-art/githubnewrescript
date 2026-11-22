import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { videoAnswerTranscript, videoAnswerText, transcribesVideo } from "./videoRecording.js";
import { buildVariableDictionary } from "./index.js";
import { flattenVariables } from "./flatten.js";

/* Q7 — a recorded video answer's transcript: on the video file's answer, in the variable dictionary and the data */

const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "media.video_recording", text: "Show us your kitchen", code: "V1" },
  ] as SurveyAction[]).def;
})();
const q = def.questions[0];
const state = (answer: unknown) => ({ answers: { [q.id]: answer }, calculated: {}, embedded: {}, flags: [], loopStack: [] }) as never;

test("the transcript rides on the video file's answer; read from an object or a list; transcription defaults on", () => {
  const file = { url: "/api/media/m1", name: "recording.webm", size: 1000, type: "video/webm", transcript: { text: "  I cook here every day  ", source: "provider", language: "en", status: "completed" } };
  assert.deepEqual(videoAnswerTranscript(file), { text: "  I cook here every day  ", language: "en", source: "provider", status: "completed" });
  assert.equal(videoAnswerText([file]), "I cook here every day");
  assert.equal(videoAnswerTranscript({ url: "x" }), null);
  assert.equal(videoAnswerText(null), "");
  assert.equal(transcribesVideo(q), true);
  assert.equal(transcribesVideo({ ...q, settings: { ...q.settings, transcribeAnswer: false } }), false);
  assert.equal(transcribesVideo({ ...q, variant: "upload.file" } as never), false);
});

test("the dictionary declares the transcript columns and the data fills them, in step", () => {
  const vars = buildVariableDictionary(def).filter((v) => v.questionId === q.id).map((v) => v.name);
  const name = q.variableName;
  assert.ok(vars.includes(`${name}_TRANSCRIPT`) && vars.includes(`${name}_TRANSCRIPT_SOURCE`), vars.join(","));
  const said = flattenVariables(def, state({ url: "/api/media/m1", name: "r.webm", size: 10, type: "video/webm", transcript: { text: "I cook here", source: "provider" } }));
  assert.equal(said[`${name}_TRANSCRIPT`], "I cook here");
  assert.equal(said[`${name}_TRANSCRIPT_SOURCE`], "provider");
  assert.equal(said[`${name}_URL`] !== undefined, true);
  const none = flattenVariables(def, state({ url: "/api/media/m1", name: "r.webm", size: 10, type: "video/webm" }));
  assert.equal(none[`${name}_TRANSCRIPT`], "");
  assert.equal(none[`${name}_TRANSCRIPT_SOURCE`], "none", "a video with no transcript says so");
  const skipped = flattenVariables(def, state(undefined));
  assert.ok(!skipped[`${name}_TRANSCRIPT_SOURCE`], "no answer, no source");
});
