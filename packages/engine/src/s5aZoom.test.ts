import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, variantRegistry } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { zoomModeFor, questionZooms, zoomParadataKey, clampScale, clampPan, wheelScale, pinchScale, zoomKey, ZOOM_MAX, ZOOM_MIN } from "./mediaZoom.js";

/* S5a item 1 (MM2-04): image zoom / lightbox — the mode rule, the paradata key, the bounded zoom and the action */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Brand?", options: ["Acme", "Beta"] },
    { op: "create_question", type: "image.choice", text: "Which pack?", options: ["A", "B"] },
  ] as SurveyAction[]).def;
})();

test("zoom mode: item overrides question; absent = off (existing surveys unchanged)", () => {
  assert.equal(zoomModeFor({ settings: {} } as never), "off");
  assert.equal(zoomModeFor({ settings: { zoom: "click" } } as never), "click");
  assert.equal(zoomModeFor({ settings: { zoom: "click" } } as never, { zoom: "hover-magnifier" }), "hover-magnifier");
  assert.equal(zoomModeFor({ settings: { zoom: "click" } } as never, { zoom: "nonsense" }), "click");
  assert.equal(questionZooms({ settings: { mediaItems: [{ id: "a", url: "x", zoom: "click" }] } } as never), true);
  assert.equal(questionZooms({ settings: {} } as never), false);
});

test("new image questions zoom on click (variant defaults); a plain single choice does not", () => {
  for (const id of ["image.choice", "image.grid", "single_select.image", "multi_select.image", "ranking.image", "image.comparison"]) {
    assert.equal((variantRegistry.get(id)?.defaults?.settings as { zoom?: string } | undefined)?.zoom, "click", id);
  }
  const img = base.questions.find((q) => q.text.includes("pack"))!;
  assert.equal(zoomModeFor(img), "click");
  assert.equal(zoomModeFor(base.questions[0]), "off");
});

test("paradata key ZOOMED_<CODE>", () => {
  assert.equal(zoomParadataKey("Q2"), "ZOOMED_Q2");
  assert.equal(zoomParadataKey("q-2.a"), "ZOOMED_Q_2_A");
});

test("zoom and pan stay in bounds", () => {
  assert.equal(clampScale(0.2), ZOOM_MIN);
  assert.equal(clampScale(99), ZOOM_MAX);
  assert.equal(clampScale(Number.NaN), ZOOM_MIN);
  assert.deepEqual(clampPan({ x: 500, y: -500 }, 1, 400, 300), { x: 0, y: 0 });
  assert.deepEqual(clampPan({ x: 500, y: -500 }, 2, 400, 300), { x: 200, y: -150 });
  assert.ok(wheelScale(1, -100) > 1);
  assert.equal(wheelScale(1, 100), 1);
  assert.equal(wheelScale(ZOOM_MAX, -100), ZOOM_MAX);
  assert.equal(pinchScale(2, 100, 200), 4);
  assert.equal(pinchScale(2, 100, 1000), ZOOM_MAX);
  assert.equal(pinchScale(2, 0, 100), 2);
  assert.deepEqual(zoomKey("Escape"), { kind: "close" });
  assert.deepEqual(zoomKey("+"), { kind: "in" });
  assert.equal(zoomKey("a"), null);
});

test("set_question_media zoom: question level and per item; bad value refused", () => {
  const c = coerceSurveyActions([
    { op: "set_question_media", target: "Q1", items: [{ url: "https://cdn.example.com/a.jpg", alt: "A", zoom: "hover-magnifier" }], zoom: "click" },
  ]);
  assert.equal(c.actions.length, 1, JSON.stringify(c.rejected));
  const r = applySurveyActions(base, c.actions);
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions[0];
  assert.equal(q.settings.zoom, "click");
  assert.equal(q.settings.mediaItems?.[0].zoom, "hover-magnifier");
  assert.ok(SurveyDefinition.safeParse(r.def).success, "the zoom settings survive the schema");
  const off = applySurveyActions(r.def, coerceSurveyActions([{ op: "set_question_media", target: "Q1", zoom: "off" }]).actions);
  assert.equal(off.def.questions[0].settings.zoom, undefined);
  const bad = coerceSurveyActions([{ op: "set_question_media", target: "Q1", zoom: "giant" }]);
  assert.equal(bad.actions.length, 0);
  assert.match(JSON.stringify(bad.rejected), /zoom must be/);
});
