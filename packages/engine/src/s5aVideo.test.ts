import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { videoRecordingConfig, isVideoRecording, pickRecorderMime, lintVideoRecording, VIDEO_RECORDING_MAX_MB } from "./videoRecording.js";
import { variantCatalogue } from "./capabilityRegistry.js";
import { capabilitiesMentioned } from "./capabilities.js";

/* S5a item 3 (MM2-09): respondent video recording — the variant and its rules */

const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "media.video_recording", text: "Show us your kitchen" },
  ] as SurveyAction[]);
})();

test("media.video_recording: an upload answer, its own renderer, consent and limits by default", () => {
  const v = variantRegistry.get("media.video_recording")!;
  assert.equal(v.baseType, "upload");
  assert.equal(v.renderer, "videorecording");
  assert.ok(def.results.every((r) => r.ok), JSON.stringify(def.results));
  const q = def.def.questions[0];
  assert.ok(isVideoRecording(q));
  const c = videoRecordingConfig(q);
  assert.equal(c.maxSeconds, 60);
  assert.equal(c.maxSizeMb, 50);
  assert.equal(c.maxRetakes, 3);
  assert.equal(c.allowUpload, true);
  assert.match(c.consentText, /agree to be recorded/);
  assert.deepEqual(lintVideoRecording(q), []);
  const keys = variantCatalogue().find((x) => x.id === "media.video_recording")!.settings.map((s) => s.key);
  for (const k of ["maxAnswerSeconds", "maxRetakes", "maxSizeMb", "consentText", "allowFileUpload"]) assert.ok(keys.includes(k), k);
});

test("limits are bounded: 5–600 s, ≤ 50 MB; no consent text is linted", () => {
  const q = { code: "Q1", settings: { maxAnswerSeconds: 5000, maxSizeMb: 400 } };
  const c = videoRecordingConfig(q as never);
  assert.equal(c.maxSeconds, 600);
  assert.equal(c.maxSizeMb, VIDEO_RECORDING_MAX_MB);
  assert.equal(videoRecordingConfig({ settings: { maxAnswerSeconds: 1 } } as never).maxSeconds, 5);
  assert.equal(c.maxRetakes, null);
  const lint = lintVideoRecording(q as never).join(" ");
  assert.match(lint, /at most 600/); assert.match(lint, /50 MB/); assert.match(lint, /no consent text/);
});

test("recorder container: WebM first, MP4 when that is all the browser has", () => {
  assert.equal(pickRecorderMime(() => true), "video/webm;codecs=vp8,opus");
  assert.equal(pickRecorderMime((m) => m === "video/mp4"), "video/mp4");
  assert.equal(pickRecorderMime(() => false), null);
});

test("capabilities: respondent video is supported now", () => {
  const c = capabilitiesMentioned("record a video answer from the respondent's camera") as { id: string; status: string }[];
  assert.ok(c.some((x) => x.id === "platform:respondent_video" && x.status === "supported"), c.map((x) => x.id).join(","));
});
