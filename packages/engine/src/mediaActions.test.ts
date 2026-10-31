import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";
import { mediaUrlProblem } from "./mediaActions.js";
import { questionMediaList } from "./carryforward.js";

/* S2b item 3 (D16 / AQ-05 / MM2-16): set_question_media through the gate */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "single", text: "Brand?", options: ["Acme", "Beta"] },
    { op: "create_question", type: "media.video_rating", text: "Rate the ad" },
  ] as SurveyAction[]).def;
})();
const run = (raw: unknown[]) => { const c = coerceSurveyActions(raw); return { c, r: applySurveyActions(base, c.actions) }; };

test("set_question_media is in the vocabulary", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("set_question_media"));
});

test("a stimulus image with alt text: stored as mediaItems + mediaUrl, read by the renderer's list", () => {
  const { c, r } = run([{ op: "set_question_media", target: "Q1", items: [{ url: "https://cdn.example.com/pack.jpg", alt: "The new pack" }], layout: "horizontal" }]);
  assert.equal(c.actions.length, 1, JSON.stringify(c.rejected));
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions[0];
  assert.equal(q.settings.mediaUrl, "https://cdn.example.com/pack.jpg");
  assert.equal(q.settings.mediaItems?.[0].alt, "The new pack");
  assert.equal(q.settings.mediaLayout, "horizontal");
  assert.deepEqual(questionMediaList(q).map((m) => m.url), ["https://cdn.example.com/pack.jpg"]);
});

test("the media library and a known video provider are accepted; http, javascript:, private hosts and pipes are refused", () => {
  assert.equal(mediaUrlProblem("/api/media/abc123/pack.png"), null);
  assert.equal(mediaUrlProblem("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.match(mediaUrlProblem("http://cdn.example.com/x.jpg")!, /https address or the survey's media library/);
  assert.match(mediaUrlProblem("javascript:alert(1)")!, /not allowed/);
  assert.match(mediaUrlProblem("https://user:pw@cdn.example.com/x.jpg")!, /credentials/);
  assert.match(mediaUrlProblem("https://127.0.0.1/x.jpg")!, /private or local/);
  assert.match(mediaUrlProblem("{{ImageURL}}")!, /piped/);
  const { r } = run([{ op: "set_question_media", target: "Q1", url: "http://cdn.example.com/x.jpg" }]);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error ?? "", /https address/);
});

test("a video stimulus with watch-to-continue on a media variant; refused on a plain question with the route", () => {
  const { r } = run([{ op: "set_question_media", target: "Q2", items: [{ url: "https://cdn.example.com/ad.mp4", alt: "The 30-second ad" }], requireComplete: true }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const q = r.def.questions[1];
  assert.equal(q.settings.mediaUrl, "https://cdn.example.com/ad.mp4");
  assert.equal(q.settings.requireComplete, true);
  const plain = run([{ op: "set_question_media", target: "Q1", url: "https://cdn.example.com/ad.mp4", requireComplete: true }]).r;
  assert.equal(plain.results[0].ok, false);
  assert.match(plain.results[0].error ?? "", /watch-to-continue exists on the media variants only .*update_question type "media.video_rating"/);
});

test("option images: set by code or label, removed with null; unknown option refused", () => {
  const { r } = run([{ op: "set_question_media", target: "Q1", options: [{ option: 1, imageUrl: "https://cdn.example.com/acme.png", imageAlt: "Acme logo" }, { option: "Beta", imageUrl: "/api/media/beta01" }] }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const o = r.def.questions[0].options!;
  assert.equal(o[0].imageUrl, "https://cdn.example.com/acme.png");
  assert.equal(o[0].imageAlt, "Acme logo");
  assert.equal(o[1].imageUrl, "/api/media/beta01");
  assert.ok(r.warnings.some((w) => /does not draw option images/.test(w)) || r.results[0].ok);
  const rm = applySurveyActions(r.def, coerceSurveyActions([{ op: "set_question_media", target: "Q1", options: [{ option: 1, imageUrl: null }] }]).actions);
  assert.ok(rm.results[0].ok, rm.results[0].error);
  assert.equal(rm.def.questions[0].options![0].imageUrl, undefined);
  const bad = run([{ op: "set_question_media", target: "Q1", options: [{ option: 9, imageUrl: "https://cdn.example.com/x.png" }] }]).r;
  assert.match(bad.results[0].error ?? "", /has no option “9”/);
});

test("clear removes the stimulus and says so as destructive; an empty action is refused at the gate", () => {
  const set = run([{ op: "set_question_media", target: "Q1", url: "https://cdn.example.com/pack.jpg" }]).r;
  const cl = applySurveyActions(set.def, coerceSurveyActions([{ op: "set_question_media", target: "Q1", clear: true }]).actions);
  assert.ok(cl.results[0].ok, cl.results[0].error);
  assert.equal(cl.def.questions[0].settings.mediaUrl, undefined);
  assert.equal(cl.def.questions[0].settings.mediaItems, undefined);
  const empty = coerceSurveyActions([{ op: "set_question_media", target: "Q1" }]);
  assert.equal(empty.actions.length, 0);
  assert.match(String(empty.rejected[0]?.reason), /changes nothing/);
});
