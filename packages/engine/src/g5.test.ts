import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry } from "@rescript/schema";
import {
  createResponseState,
  validateQuestion,
  flattenVariables,
  questionVariables,
  type EvalContext,
} from "./index.js";

/**
 * Engine behaviour for the image / media / hotspot / upload variant batch
 * (G5). The renderers are covered by scripts/variants-g5-test.mjs; what is
 * tested here is what the ENGINE does for them — the one validation rule the
 * batch added, and the promise that the new base types export and validate
 * without a renderer being involved at all.
 */

function survey(q: Record<string, unknown>) {
  const def = SurveyDefinition.parse({
    meta: { id: "s5", code: "G5", title: "Media variants", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "q",
      options: [], rows: [], columns: [], validation: [], required: false,
      settings: {}, skipLogic: [], listLogic: [],
      ...q,
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const state = createResponseState(def, { seed: 5 });
  const ctx: EvalContext = { def, state, loop: null };
  return { def, state, ctx, q: def.questions[0] };
}

const messages = (def: any, q: any, value: unknown, ctx: EvalContext) =>
  validateQuestion(def, q, value, ctx).map((e) => e.message);

/**
 * `AnswerValue` predates the base types this batch uses and has no member for
 * "an array of records" (a media timeline's reactions, a multi-file upload).
 * `setAnswer` casts, so the runtime is unaffected; the tests store directly
 * and so need the same widening.
 */
const put = (state: { answers: Record<string, unknown> }, id: string, v: unknown) => {
  state.answers[id] = v;
};

const WATCH_ROWS = [
  { code: "watched", label: "Seconds watched", fieldType: "number" },
  { code: "duration", label: "Clip duration (s)", fieldType: "number" },
  { code: "percent", label: "Percent watched", fieldType: "number" },
  { code: "completed", label: "Watched to the end", fieldType: "number" },
];

/* ------------------------------------------------- watch-time completion rule */

test("requireComplete on a watch-time question blocks until the clip finished", () => {
  const { def, q, ctx } = survey({
    type: "numeric_list", variant: "media.watch_time",
    rows: WATCH_ROWS, settings: { requireComplete: true, mediaUrl: "/test-media/tiny.webm" },
  });

  // nothing watched yet
  assert.ok(
    messages(def, q, { watched: 0, duration: 30, percent: 0, completed: 0 }, ctx)
      .includes("Please watch the video to the end."),
    "an unwatched clip is refused",
  );
  // watched most of it, but not to the end — still refused, because "most" is
  // not what the survey asked for
  assert.ok(
    messages(def, q, { watched: 27.4, duration: 30, percent: 91, completed: 0 }, ctx)
      .includes("Please watch the video to the end."),
  );
  // finished
  assert.deepEqual(
    messages(def, q, { watched: 30, duration: 30, percent: 100, completed: 1 }, ctx),
    [],
    "a completed clip passes",
  );
});

test("the completion rule touches nothing else: no setting, no `completed` row, no rule", () => {
  // same rows, requireComplete off
  const off = survey({ type: "numeric_list", rows: WATCH_ROWS, settings: {} });
  assert.deepEqual(messages(off.def, off.q, { watched: 0, duration: 30, percent: 0, completed: 0 }, off.ctx), []);

  // an ordinary numeric list that happens to carry requireComplete (a leftover
  // from a variant switch) must not acquire a video rule it cannot satisfy
  const ordinary = survey({
    type: "numeric_list",
    rows: [{ code: "adults", label: "Adults", fieldType: "number" }, { code: "kids", label: "Children", fieldType: "number" }],
    settings: { requireComplete: true },
  });
  assert.deepEqual(messages(ordinary.def, ordinary.q, { adults: 2, kids: 1 }, ordinary.ctx), []);

  // and the rule is not a general "requireComplete" rule for other types
  const rating = survey({ type: "numeric", settings: { requireComplete: true, minValue: 1, maxValue: 5 } });
  assert.deepEqual(messages(rating.def, rating.q, 4, rating.ctx), []);
});

test("a required watch-time question is satisfied by the telemetry it records", () => {
  // the renderer writes all four fields as soon as the metadata loads, so
  // "required" does not accuse the respondent of leaving a field blank
  const { def, q, ctx } = survey({
    type: "numeric_list", variant: "media.watch_time", required: true,
    rows: WATCH_ROWS, settings: { mediaUrl: "/test-media/tiny.webm" },
  });
  assert.deepEqual(messages(def, q, { watched: 0, duration: 3, percent: 0, completed: 0 }, ctx), []);
  assert.ok(messages(def, q, undefined, ctx).length > 0, "an absent answer is still refused");
});

/* --------------------------------------------- annotation: counts and export */

test("annotation counts pins and strokes together for min/max, whatever a stroke looks like", () => {
  const { def, q, ctx } = survey({
    type: "annotation", variant: "image.annotation",
    settings: { imageUrl: "/test-media/stimulus.png", minSelections: 2, maxSelections: 3 },
  });
  const pin = (x: number) => ({ x, y: 10, comment: "" });
  const objStroke = { tool: "pen", points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };
  const rawStroke = [{ x: 9, y: 9 }, { x: 20, y: 20 }]; // the base type's plain point-list shape

  assert.ok(messages(def, q, { pins: [pin(10)], strokes: [] }, ctx).some((m) => /at least 2/.test(m)));
  assert.deepEqual(messages(def, q, { pins: [pin(10)], strokes: [objStroke] }, ctx), []);
  assert.deepEqual(messages(def, q, { pins: [pin(10), pin(20)], strokes: [rawStroke] }, ctx), []);
  assert.ok(
    messages(def, q, { pins: [pin(1), pin(2), pin(3)], strokes: [objStroke, rawStroke] }, ctx)
      .some((m) => /at most 3/.test(m)),
  );
});

test("annotation flattens to counts plus JSON — a `{tool, points}` stroke exports intact", () => {
  const { def, state } = survey({
    type: "annotation", variant: "image.annotation", settings: { imageUrl: "/x.png" },
  });
  put(state, "q1", {
    pins: [{ x: 12.5, y: 40, comment: "too small" }],
    strokes: [{ tool: "highlight", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
  });
  const flat = flattenVariables(def, state);
  assert.equal(flat["Q1_PINS"], 1);
  assert.equal(flat["Q1_STROKES"], 1);
  const json = JSON.parse(String(flat["Q1_JSON"]));
  assert.equal(json.pins[0].comment, "too small");
  assert.equal(json.strokes[0].tool, "highlight", "the tool that drew it survives the export");
  assert.equal(json.strokes[0].points.length, 2);
});

/* ------------------------------------- media timeline + upload: shapes hold */

test("timeline reactions export a count per option and the whole list as JSON", () => {
  const { def, state } = survey({
    type: "media_timeline", variant: "media.video_timeline",
    options: [{ code: "like", label: "👍 Like", flags: [] }, { code: "dislike", label: "👎 Dislike", flags: [] }],
    settings: { mediaUrl: "/test-media/tiny.webm", timelineMode: "options" },
  });
  put(state, "q1", [{ t: 0.5, code: "like" }, { t: 1.8, code: "dislike" }, { t: 2.4, code: "like" }]);
  const flat = flattenVariables(def, state);
  assert.equal(flat["Q1_N"], 3);
  assert.equal(flat["Q1_like_N"], 2);
  assert.equal(flat["Q1_dislike_N"], 1);
  assert.equal(JSON.parse(String(flat["Q1_JSON"]))[1].t, 1.8);
});

test("an upload's size cap and file count are engine rules, not renderer manners", () => {
  const one = survey({ type: "upload", variant: "upload.file", settings: { maxFiles: 1, maxSizeMb: 2 } });
  const file = (size: number) => ({ url: "data:,x", name: "a.pdf", size, type: "application/pdf" });
  assert.deepEqual(messages(one.def, one.q, file(1024), one.ctx), []);
  assert.ok(messages(one.def, one.q, file(5 * 1024 * 1024), one.ctx).some((m) => /under 2 MB/.test(m)));

  const two = survey({ type: "upload", variant: "upload.file", settings: { maxFiles: 2 } });
  assert.deepEqual(messages(two.def, two.q, [file(10), file(20)], two.ctx), []);
  assert.ok(messages(two.def, two.q, [file(10), file(20), file(30)], two.ctx).some((m) => /at most 2 files/.test(m)));

  // two files means two sets of export columns
  const names = questionVariables(two.q).map((v) => v.name);
  assert.deepEqual(names, ["Q1_1_URL", "Q1_1_NAME", "Q1_1_SIZE", "Q1_2_URL", "Q1_2_NAME", "Q1_2_SIZE"]);
});

/* --------------------------------------------------------- registry wiring */

test("every G5 variant is registered against the base type that owns its data", () => {
  const expected: Record<string, string> = {
    "image.annotation": "annotation",
    "hotspot.draw": "annotation",
    "hotspot.regions": "image_select",
    "media.video_rating": "numeric",
    "media.video_timeline": "media_timeline",
    "media.watch_time": "numeric_list",
    "media.audio_recording": "upload",
    "upload.file": "upload",
    "upload.photo": "upload",
    "upload.signature": "upload",
  };
  for (const [id, baseType] of Object.entries(expected)) {
    const v = variantRegistry.get(id);
    assert.ok(v, `${id} is registered`);
    assert.equal(v!.status, "stable", `${id} is stable`);
    assert.equal(v!.baseType, baseType, `${id} stores as ${baseType}`);
  }
  // Speech-to-Text still needs a speech service: it stays "coming soon"
  assert.equal(variantRegistry.get("media.speech_to_text_response")?.status, "planned");

  // an `upload` question with no variant is a file upload, not a signature pad
  const uploads = Object.entries(expected).filter(([, b]) => b === "upload");
  assert.ok(uploads.length === 4);
  assert.equal(variantRegistry.get("upload.file")!.renderer, undefined,
    "upload.file is the base type's own presentation");
});
