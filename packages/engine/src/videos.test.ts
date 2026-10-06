import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { videoList, watchTimeRows, unfinishedClips, watchFieldCode } from "./videos.js";
import { validateQuestion } from "./validate.js";

test("videoList — the clip list, else the single older mediaUrl, else nothing", () => {
  assert.deepEqual(videoList({ settings: { videos: [{ url: "a.mp4", title: "A" }, { url: "b.mp4" }] } } as never).map((v) => v.url), ["a.mp4", "b.mp4"]);
  assert.deepEqual(videoList({ settings: { mediaUrl: "old.mp4" } } as never), [{ url: "old.mp4" }]);
  assert.deepEqual(videoList({ settings: { videos: [], mediaUrl: "old.mp4" } } as never), [{ url: "old.mp4" }], "an empty list falls back");
  assert.deepEqual(videoList({ settings: {} } as never), []);
  assert.deepEqual(videoList({ settings: { mediaUrl: "new.mp4", videos: [{ url: "old.mp4", title: "A" }, { url: "b.mp4" }] } } as never),
    [{ url: "new.mp4", title: "A" }, { url: "b.mp4" }], "a mediaUrl written elsewhere (Copilot, import, JSON) is the first clip");
});

test("watchTimeRows — four fixed fields per clip; the first clip keeps the names existing exports have", () => {
  assert.deepEqual(watchTimeRows(1).map((r) => r.code), ["watched", "duration", "percent", "completed"]);
  assert.deepEqual(watchTimeRows(2).map((r) => r.code),
    ["watched", "duration", "percent", "completed", "watched_2", "duration_2", "percent_2", "completed_2"]);
  assert.match(String(watchTimeRows(2)[4].label), /video 2/);
  assert.equal(watchFieldCode("percent", 2), "percent_3");
  assert.equal(watchTimeRows(0).length, 4, "no clip yet still has the first clip's fields");
});

test("must watch to the end — every clip, by number", () => {
  const rows = watchTimeRows(2);
  assert.deepEqual(unfinishedClips({ rows }, { completed: 1, completed_2: 0 }), [1]);
  assert.deepEqual(unfinishedClips({ rows }, {}), [0, 1]);
  assert.deepEqual(unfinishedClips({ rows }, { completed: 1, completed_2: 1 }), []);
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "w", code: "Q1", variableName: "Q1", type: "numeric_list", variant: "media.watch_time", text: "Watch",
      rows, settings: { requireComplete: true, videos: [{ url: "a.mp4" }, { url: "b.mp4" }] } }],
    flow: [{ type: "page", id: "p", questionIds: ["w"] }, { type: "end", id: "e", status: "complete" }],
  });
  const errs = (v: unknown) => validateQuestion(def, def.questions[0], v, { def, state: { answers: {}, embedded: {} } } as never).map((e) => e.message);
  assert.deepEqual(errs({ completed: 1, completed_2: 0 }), ["Please watch video 2 to the end."]);
  assert.deepEqual(errs({ completed: 1, completed_2: 1 }), []);
});
