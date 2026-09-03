/**
 * Image / Video-Audio / Hotspot / Upload variant families (10 variants):
 * created from the picker, rendered in the runtime, answered with the mouse
 * (and the keyboard where the control is a custom widget), and the answer
 * checked against the response model its base type owns.
 *
 * Media comes from the runtime's own public folder — no network, no service:
 *   /test-media/tiny.webm   3s 320×180 VP8 clip (generated with ffmpeg)
 *   /test-media/tone.wav    1s 440Hz mono tone, used as an "uploaded" answer
 *   /test-media/stimulus.png 480×320 stimulus for the annotation / regions
 *
 * Recording and camera capture cannot be exercised headless (no devices), so
 * the suite drives the fallback each renderer is required to offer.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = path.join(ROOT, "apps/runtime/public/test-media");
const WAV = path.join(MEDIA, "tone.wav");
const PNG = path.join(MEDIA, "stimulus.png");
const BIG = path.join("/tmp", "variants-g5-big.bin");
if (!fs.existsSync(BIG)) fs.writeFileSync(BIG, Buffer.alloc(1_500_000, 7));
for (const f of [WAV, PNG]) assert.ok(fs.existsSync(f), `${f} exists (generated with ffmpeg)`);

// absolute, because the Studio's own previews (the region editor, the image
// thumbnail) load them from the Studio's origin, not the runtime's
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const IMG = `${RUNTIME}/test-media/stimulus.png`;
const CLIP = `${RUNTIME}/test-media/tiny.webm`;

const h = await openHarness();
const made = {};
const id = (k) => made[k].id;
const at = (k, sel) => `[data-qid="${made[k].id}"] ${sel}`;

/** Every preview gets the stimulus/media URLs a programmer would have set. */
function dress(d) {
  for (const q of d.questions) {
    if (q.type === "annotation") q.settings.imageUrl = IMG;
    if (q.variant === "hotspot.regions") q.settings.imageUrl = IMG;
    if (["media.video_rating", "media.video_timeline", "media.watch_time"].includes(q.variant)) {
      q.settings.mediaUrl = CLIP;
    }
  }
}
/** Wait until every image has actually loaded — an <img> with no intrinsic
 *  size yet makes its stage the wrong height, and every percentage measured
 *  against it lands somewhere else. */
const waitImages = (page, sel = "[data-qid] img") => page.waitForFunction(
  (s) => {
    // a page of videos has no images at all — "all of none" is loaded
    const imgs = Array.from(document.querySelectorAll(s));
    return imgs.every((im) => im.complete && im.naturalWidth > 0);
  },
  sel, { timeout: 15000 },
);
const preview = async (ids, extra) => {
  const pv = await h.preview(ids, (d) => { dress(d); extra?.(d); });
  await waitImages(pv);
  await pv.waitForTimeout(150);
  return pv;
};
const qOf = (d, k) => d.questions.find((q) => q.id === made[k].id);

/* ------------------------------------------------ create every variant */
made.annotation = await h.createFromPicker("image", "image.annotation");
made.regions = await h.createFromPicker("hotspot", "hotspot.regions");
made.draw = await h.createFromPicker("hotspot", "hotspot.draw");
made.video_rating = await h.createFromPicker("media", "media.video_rating");
made.video_timeline = await h.createFromPicker("media", "media.video_timeline");
made.watch_time = await h.createFromPicker("media", "media.watch_time");
made.audio_recording = await h.createFromPicker("media", "media.audio_recording");
made.file = await h.createFromPicker("upload", "upload.file");
made.photo = await h.createFromPicker("upload", "upload.photo");
made.signature = await h.createFromPicker("upload", "upload.signature");
console.log("✔ all 10 image / media / hotspot / upload variants are stable in the picker");

/* base types and seeded defaults */
assert.equal(made.annotation.type, "annotation");
assert.deepEqual(made.annotation.settings.tools, ["pin", "pen"]);
assert.equal(made.annotation.settings.penColor, "#e11d48");
assert.equal(made.annotation.settings.penWidth, 3);
assert.equal(made.draw.type, "annotation");
assert.deepEqual(made.draw.settings.tools, ["pen", "highlight"], "draw-on-image offers the drawing tools only");
assert.equal(made.regions.type, "image_select");
assert.equal(made.regions.options.length, 2, "regions seed two starter areas");
assert.deepEqual(made.regions.options[0].meta.region, { x: 5, y: 5, w: 90, h: 42 });
assert.equal(made.regions.settings.maxSelections, 1, "one region unless the programmer says otherwise");
assert.equal(made.video_rating.type, "numeric");
assert.equal(made.video_rating.settings.requireComplete, true);
assert.equal(made.video_rating.settings.maxValue, 5);
assert.equal(made.video_timeline.type, "media_timeline");
assert.equal(made.video_timeline.settings.timelineMode, "options");
assert.deepEqual(made.video_timeline.options.map((o) => o.code), ["like", "dislike", "confusing"]);
assert.equal(made.watch_time.type, "numeric_list");
assert.deepEqual(made.watch_time.rows.map((r) => r.code), ["watched", "duration", "percent", "completed"]);
assert.ok(made.watch_time.rows.every((r) => r.fieldType === "number"));
assert.equal(made.audio_recording.type, "upload");
assert.equal(made.audio_recording.settings.accept, "audio/*");
for (const k of ["file", "photo", "signature"]) assert.equal(made[k].type, "upload", `${k} stores an upload`);
assert.equal(made.file.settings.maxFiles, 1);
assert.equal(made.photo.settings.accept, "image/*");
console.log("✔ base types and seeded defaults are right");

/* Speech-to-Text still needs a speech service — it must stay "coming soon" */
await h.goTab("Questions");
await h.page.click('[data-testid="add-question-top"]');
await h.page.click('[data-testid="picker-family-media"]');
const stt = await h.page.waitForSelector('[data-testid="picker-variant-media.speech_to_text_response"]');
assert.equal(await stt.getAttribute("data-status"), "planned", "Speech-to-Text Response is still coming soon");
await h.page.click(".modal button:has-text('close')");
await h.page.waitForTimeout(200);
console.log("✔ Speech-to-Text Response is still offered as coming soon (deferred: needs a speech service)");

/* ------------------------------------- Studio: the region editor draws regions */
await h.setQuestion(id("regions"), (q) => {
  q.settings.imageUrl = IMG;
  q.options = [
    { code: "sky", label: "The sky", flags: [] },
    { code: "ground", label: "The ground", flags: [] },
  ];
});
await h.goTab("Questions");
const cards = await h.page.$$('[data-testid="qcard"]');
await cards[1].click(); // the regions question
await h.page.waitForSelector('[data-testid="region-canvas"]');
await waitImages(h.page, '[data-testid="region-canvas"] img');
await h.page.click('[data-testid="region-pick-ground"]');
{
  // with ten cards in the list the editor sits below the fold; a mouse event
  // outside the viewport lands nowhere at all
  await (await h.page.$('[data-testid="region-canvas"]')).scrollIntoViewIfNeeded();
  const box = await h.page.$eval('[data-testid="region-canvas"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await h.page.mouse.move(box.x + box.w * 0.1, box.y + box.h * 0.6);
  await h.page.mouse.down();
  await h.page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.8, { steps: 6 });
  await h.page.mouse.move(box.x + box.w * 0.9, box.y + box.h * 0.95, { steps: 6 });
  await h.page.mouse.up();
  await h.page.waitForTimeout(300);
}
// the rectangle is drawn back onto the image straight away…
assert.ok(await h.page.$('[data-testid="region-box-ground"]'), "the region is drawn back on the image");
assert.equal(await h.page.$('[data-testid="region-box-sky"]'), null, "and only for the option being edited");
// …and it is written to the option, in percentages
let def = await h.readDef();
const ground = qOf(def, "regions").options.find((o) => o.code === "ground");
assert.ok(ground.meta?.region, "dragging on the image defines the active option's region");
assert.ok(ground.meta.region.w > 50 && ground.meta.region.h > 20,
  `the rectangle is what was dragged (${JSON.stringify(ground.meta.region)})`);
assert.ok(ground.meta.region.x < 20 && ground.meta.region.y > 40,
  `and where it was dragged (${JSON.stringify(ground.meta.region)})`);
assert.equal(qOf(def, "regions").options.find((o) => o.code === "sky").meta?.region, undefined,
  "the other option is untouched");

// a region can be deleted again
await h.goTab("Questions");
await (await h.page.$$('[data-testid="qcard"]'))[1].click();
await h.page.waitForSelector('[data-testid="region-pick-ground"]');
await h.page.click('[data-testid="region-pick-ground"]');
await h.page.waitForSelector('[data-testid="region-del-ground"]');
await h.page.click('[data-testid="region-del-ground"]');
await h.page.waitForTimeout(250);
assert.equal(await h.page.$('[data-testid="region-box-ground"]'), null, "delete clears it from the image");
def = await h.readDef();
assert.equal(qOf(def, "regions").options.find((o) => o.code === "ground").meta?.region, undefined, "delete removes it");
// put it back, by hand this time, so the runtime checks have two regions
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});
await h.setQuestion(id("regions"), (q) => {
  q.options = [
    { code: "sky", label: "The sky", flags: [], meta: { region: { x: 4, y: 4, w: 92, h: 40 } } },
    { code: "ground", label: "The ground", flags: [], meta: { region: { x: 4, y: 52, w: 92, h: 44 } } },
  ];
});
console.log("✔ Studio: the region editor defines, redraws and deletes option regions by pointer");

/* ------------------------------- Studio: every variant has its settings block */
const openCard = async (i) => {
  await h.goTab("Questions");
  const cs = await h.page.$$('[data-testid="qcard"]');
  await cs[i].click();
};
// creation order → card index
const CARD = { annotation: 0, regions: 1, draw: 2, video_rating: 3, video_timeline: 4,
  watch_time: 5, audio_recording: 6, file: 7, photo: 8, signature: 9 };
const BLOCK = { annotation: "annotate", regions: "regions", draw: "annotate", video_rating: "videorating",
  video_timeline: "videotimeline", watch_time: "watchtime", audio_recording: "audiorec",
  file: "base-upload", photo: "camera", signature: "signature" };
for (const [k, key] of Object.entries(BLOCK)) {
  await openCard(CARD[k]);
  await h.page.waitForSelector(`[data-testid="variant-settings-${key}"]`);
  await h.page.click('[data-testid="close-question"]').catch(() => {});
}
console.log("✔ Studio: all ten variants render their own settings block");

// and the blocks write what they promise
await openCard(CARD.annotation);
await h.page.click('[data-testid="annot-tool-highlight"]');
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.deepEqual(qOf(def, "annotation").settings.tools, ["pin", "pen", "highlight"], "a tool checkbox writes settings.tools");
await openCard(CARD.annotation);
await h.page.click('[data-testid="annot-tool-highlight"]');
await h.page.waitForTimeout(250);

await openCard(CARD.video_rating);
await h.page.fill('[data-testid="media-url"]', CLIP);
await h.page.click('[data-testid="media-require-complete"]');
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.equal(qOf(def, "video_rating").settings.mediaUrl, CLIP, "the media URL field writes settings.mediaUrl");
assert.equal(qOf(def, "video_rating").settings.requireComplete, false, "and the gate can be turned off");
await openCard(CARD.video_rating);
await h.page.click('[data-testid="media-require-complete"]');
await h.page.waitForTimeout(250);

await openCard(CARD.file);
await h.page.fill('[data-testid="upload-maxfiles"]', "3");
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.equal(qOf(def, "file").settings.maxFiles, 3, "the file count is a CountInput on settings.maxFiles");
assert.equal(qOf(def, "annotation").settings.tools.length, 2, "the tool checkbox toggles back off");
assert.equal(qOf(def, "video_rating").settings.requireComplete, true, "the gate goes back on");
await openCard(CARD.file);
await h.page.fill('[data-testid="upload-maxfiles"]', "1");
await h.page.waitForTimeout(250);
await h.page.click('[data-testid="close-question"]').catch(() => {});
console.log("✔ Studio: tools, media URL, require-complete and file count write through to settings");

/* ------------------------------------------------------- runtime: annotation */
let pv = await preview([id("annotation"), id("draw"), id("regions")]);

/** The element's box, scrolled into view first: a mouse event dispatched at a
 *  point outside the viewport reaches nothing. */
const surfaceBox = async (page, sel) => {
  const el = await page.$(sel);
  assert.ok(!!el, `${sel} exists`);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(60);
  return page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
};

async function drawStroke(page, sel, y = 0.72) {
  const b = await surfaceBox(page, sel);
  await page.mouse.move(b.x + b.w * 0.15, b.y + b.h * y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(b.x + b.w * (0.15 + i * 0.07), b.y + b.h * (y - i * 0.015), { steps: 2 });
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}

async function placePin(page, k, fx, fy, comment) {
  const sel = at(k, '[data-testid="annot-surface"]');
  const b = await surfaceBox(page, sel);
  await page.mouse.click(b.x + b.w * fx, b.y + b.h * fy);
  await page.waitForTimeout(120);
  if (comment != null) {
    const n = (await page.$$(at(k, ".rs-annot-pin"))).length - 1;
    await page.fill(at(k, `[data-testid="pin-comment-${n}"]`), comment);
    await page.press(at(k, `[data-testid="pin-comment-${n}"]`), "Enter");
    await page.waitForTimeout(120);
  }
}

await placePin(pv, "annotation", 0.25, 0.2, "This corner is too busy");
await placePin(pv, "annotation", 0.7, 0.35, "Love this bit");
let a = await h.answerOf(pv, id("annotation"));
assert.equal(a.pins.length, 2, "two clicks place two pins");
assert.equal(a.pins[0].comment, "This corner is too busy", "the comment box writes onto the pin");
assert.equal(a.pins[1].comment, "Love this bit");
assert.ok(a.pins[0].x > 15 && a.pins[0].x < 40 && a.pins[0].y > 10 && a.pins[0].y < 32,
  `pins store percent coordinates (${JSON.stringify(a.pins[0])})`);
assert.deepEqual(a.strokes, []);

await pv.click(at("annotation", '[data-tool="pen"]'));
await drawStroke(pv, at("annotation", '[data-testid="annot-surface"]'));
a = await h.answerOf(pv, id("annotation"));
assert.equal(a.strokes.length, 1, "a pointer drag stores one stroke");
assert.equal(a.strokes[0].tool, "pen");
assert.ok(a.strokes[0].points.length >= 4, `the stroke keeps its points (${a.strokes[0].points.length})`);
assert.ok(a.strokes[0].points.every((pt) => pt.x >= 0 && pt.x <= 100 && pt.y >= 0 && pt.y <= 100), "in percent");
assert.equal(a.pins.length, 2, "drawing did not disturb the pins");
assert.match(await pv.textContent(at("annotation", '[data-testid="annot-status"]')), /2 pins · 1 stroke/);

await pv.click(at("annotation", '[data-testid="annot-undo"]'));
await pv.waitForTimeout(120);
a = await h.answerOf(pv, id("annotation"));
assert.equal(a.strokes.length, 0, "Undo takes back the last stroke");
assert.equal(a.pins.length, 2, "and only the stroke");

// removing a pin, through its comment bubble
await pv.click(at("annotation", '.rs-annot-pin[data-pin="1"]'));
await pv.click(at("annotation", '[data-testid="pin-remove-1"]'));
await pv.waitForTimeout(120);
assert.equal((await h.answerOf(pv, id("annotation"))).pins.length, 1, "a pin can be taken back");
console.log("✔ image annotation: pins with comments + freehand strokes, in percent, undo per stroke");

/* draw-on-image: same base type, drawing tools only */
assert.equal((await pv.$$(at("draw", '[data-tool="pin"]'))).length, 0, "draw-on-image offers no pin tool");
await drawStroke(pv, at("draw", '[data-testid="annot-surface"]'), 0.5);
let dv = await h.answerOf(pv, id("draw"));
assert.equal(dv.strokes.length, 1);
assert.equal(dv.strokes[0].tool, "pen");
assert.deepEqual(dv.pins, []);
await pv.click(at("draw", '[data-tool="highlight"]'));
await drawStroke(pv, at("draw", '[data-testid="annot-surface"]'), 0.8);
dv = await h.answerOf(pv, id("draw"));
assert.equal(dv.strokes.length, 2);
assert.equal(dv.strokes[1].tool, "highlight", "the highlighter is recorded as such");
console.log("✔ draw-on-image: pen and highlighter strokes on the annotation base type");

/* regions: one region, then several, mouse and keyboard */
await pv.click(at("regions", '.rs-region[data-code="sky"]'));
assert.deepEqual(await h.answerOf(pv, id("regions")), ["sky"], "a region stores its option code");
await pv.click(at("regions", '.rs-region[data-code="ground"]'));
assert.deepEqual(await h.answerOf(pv, id("regions")), ["ground"], "maxSelections 1 replaces rather than ignoring");
await pv.press(at("regions", '.rs-region[data-code="sky"]'), "Enter");
assert.deepEqual(await h.answerOf(pv, id("regions")), ["sky"], "Enter on a focused region selects it");
await pv.press(at("regions", '.rs-region[data-code="sky"]'), "Enter");
assert.equal(await h.answerOf(pv, id("regions")), null, "and toggles it off again");
assert.equal(await pv.getAttribute(at("regions", '.rs-region[data-code="ground"]'), "aria-checked"), "false");
await pv.close();

pv = await preview([id("regions")], (d) => { qOf(d, "regions").settings.maxSelections = 99; });
await pv.click(at("regions", '.rs-region[data-code="sky"]'));
await pv.click(at("regions", '.rs-region[data-code="ground"]'));
assert.deepEqual(await h.answerOf(pv, id("regions")), ["sky", "ground"], "multi-region collects codes");
await pv.close();
console.log("✔ region selection: codes on the image_select model, single and multi, keyboard included");

/* ----------------------------------------------------------- runtime: media */
pv = await preview([id("video_rating"), id("video_timeline"), id("watch_time")]);

/** Play the clip to its end — really if the browser can, synthetically if not. */
async function playToEnd(page, sel) {
  await page.$eval(sel, (v) => { v.playbackRate = 2; const r = v.play(); if (r) r.catch(() => {}); });
  for (let i = 0; i < 40; i++) {
    if (await page.$eval(sel, (v) => v.ended)) return "played";
    await page.waitForTimeout(150);
  }
  await page.$eval(sel, (v) => v.dispatchEvent(new Event("ended")));
  await page.waitForTimeout(150);
  return "synthetic";
}

const starSel = at("video_rating", '.rs-stars button[aria-label="4 stars"]');
assert.ok(await pv.isDisabled(starSel), "requireComplete: the stars are disabled before the clip ends");
assert.match(await pv.textContent(at("video_rating", '[data-testid="rating-locked"]')), /Watch to the end/);
await pv.click(starSel, { force: true }).catch(() => {});
assert.equal(await h.answerOf(pv, id("video_rating")), undefined, "and a click on them stores nothing");

const how = await playToEnd(pv, at("video_rating", '[data-testid="media-el"]'));
assert.equal((await pv.$$(at("video_rating", '[data-testid="rating-locked"]'))).length, 0,
  "the gate opens when the clip ends");
assert.ok(!(await pv.isDisabled(starSel)));
await pv.click(starSel);
assert.equal(await h.answerOf(pv, id("video_rating")), 4, "the rating stores a plain number");
console.log(`✔ video rating: gated on watching (${how} playback), stores numeric`);

/* timeline reactions */
const tl = at("video_timeline", '[data-testid="media-el"]');
await pv.$eval(tl, (v) => { v.currentTime = 0.4; });
await pv.waitForTimeout(150);
await pv.click(at("video_timeline", '.rs-tl-opt[data-code="like"]'));
await pv.$eval(tl, (v) => { v.currentTime = 1.9; });
await pv.waitForTimeout(150);
await pv.click(at("video_timeline", '.rs-tl-opt[data-code="confusing"]'));
let marks = await h.answerOf(pv, id("video_timeline"));
assert.equal(marks.length, 2, "each tap stores one reaction");
assert.deepEqual(marks.map((m) => m.code), ["like", "confusing"]);
assert.ok(marks[0].t < marks[1].t, `reactions are sorted by time (${JSON.stringify(marks)})`);
assert.ok(marks[1].t > 1, "the reaction carries the moment it was made");
assert.equal((await pv.$$(at("video_timeline", ".rs-tl-mark"))).length, 2, "and a marker on the strip");
await pv.click(at("video_timeline", '[data-testid="timeline-remove-0"]'));
await pv.waitForTimeout(120);
marks = await h.answerOf(pv, id("video_timeline"));
assert.equal(marks.length, 1, "a reaction can be taken back");
assert.equal(marks[0].code, "confusing");
console.log("✔ video timeline: {t, code} reactions, sorted, markers removable");

/* watch time */
const wt = at("watch_time", '[data-testid="media-el"]');
await pv.waitForFunction(
  (sel) => {
    const st = window.__rescriptState;
    const qid = document.querySelector(sel).closest("[data-qid]").getAttribute("data-qid");
    return st?.answers?.[qid]?.duration > 0;
  },
  wt, { timeout: 10000 },
);
let w = await h.answerOf(pv, id("watch_time"));
assert.ok(w.duration > 2 && w.duration < 4, `the clip's duration is recorded (${w.duration}s)`);
assert.equal(w.watched, 0, "nothing watched yet");
assert.equal(w.completed, 0);
assert.equal((await pv.$$(at("watch_time", "input"))).length, 0, "watch-time shows no fields to fill in");

await playToEnd(pv, wt);
await pv.waitForTimeout(300);
w = await h.answerOf(pv, id("watch_time"));
assert.equal(w.completed, 1, "reaching the end records completion");
assert.ok(w.watched > 0.5, `seconds actually played are summed (${w.watched}s)`);
assert.ok(w.percent >= 90, `percent watched (${w.percent}%)`);
assert.match(await pv.textContent(at("watch_time", '[data-testid="watch-status"]')), /Watched .* of .*%/);
await pv.close();
console.log("✔ watch-time tracking: watched / duration / percent / completed, no inputs shown");

/* requireComplete is an engine rule, not a renderer manner */
pv = await preview([id("watch_time")], (d) => { qOf(d, "watch_time").settings.requireComplete = true; });
await pv.waitForSelector(at("watch_time", '[data-testid="media-el"]'));
await h.next(pv);
assert.ok(await pv.$(at("watch_time", "")), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /watch the video to the end/i);
await playToEnd(pv, at("watch_time", '[data-testid="media-el"]'));
await pv.waitForTimeout(300);
await h.next(pv);
assert.equal(await pv.$(`[data-qid="${id("watch_time")}"]`), null, "and it lets you through once you have");
await pv.close();
console.log("✔ requireComplete blocks Next until the clip has finished (engine rule + unit test)");

/* ---------------------------------------------------------- runtime: upload */
pv = await preview([id("audio_recording"), id("file"), id("photo"), id("signature")]);

/* audio: the fallback every recorder must offer (no microphone headless) */
await pv.setInputFiles(at("audio_recording", '[data-testid="audio-input"]'), WAV);
await pv.waitForSelector(at("audio_recording", '[data-testid="audio-playback"]'));
let up = await h.answerOf(pv, id("audio_recording"));
assert.equal(up.name, "tone.wav");
assert.ok(up.size > 1000, "the file's size is stored");
assert.match(up.url, /^data:audio\/wav/, "in preview the answer keeps the file locally as a data URL");
await pv.click(at("audio_recording", '[data-testid="audio-redo"]'));
assert.equal(await h.answerOf(pv, id("audio_recording")), null, "re-record clears the answer");
await pv.setInputFiles(at("audio_recording", '[data-testid="audio-input"]'), WAV);
await pv.waitForSelector(at("audio_recording", '[data-testid="audio-playback"]'));
console.log("✔ audio recording: microphone-less fallback stores an upload object");

/* file upload */
await pv.setInputFiles(at("file", '[data-testid="upload-input"]'), PNG);
await pv.waitForSelector(at("file", ".rs-up-row"));
up = await h.answerOf(pv, id("file"));
assert.equal(up.name, "stimulus.png");
assert.equal(up.type, "image/png");
assert.ok(!Array.isArray(up), "one file stores one object");
await pv.click(at("file", ".rs-up-x"));
await pv.waitForTimeout(120);
assert.equal(await h.answerOf(pv, id("file")), null, "removing the file clears the answer");
await pv.setInputFiles(at("file", '[data-testid="upload-input"]'), PNG);
await pv.waitForSelector(at("file", ".rs-up-row"));
console.log("✔ file upload: one file → one {url,name,size,type}");

await pv.close();
pv = await preview([id("file")], (d) => { qOf(d, "file").settings.maxFiles = 2; });
await pv.setInputFiles(at("file", '[data-testid="upload-input"]'), [PNG, WAV]);
await pv.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, at("file", ".rs-up-row"), { timeout: 8000 });
up = await h.answerOf(pv, id("file"));
assert.ok(Array.isArray(up) && up.length === 2, "maxFiles 2 stores an array of two");
assert.deepEqual(up.map((f) => f.name), ["stimulus.png", "tone.wav"]);
await pv.close();

pv = await preview([id("file")], (d) => { qOf(d, "file").settings.maxSizeMb = 1; });
await pv.setInputFiles(at("file", '[data-testid="upload-input"]'), BIG);
await pv.waitForSelector(at("file", '[data-testid="upload-error"]'));
assert.match(await pv.textContent(at("file", '[data-testid="upload-error"]')), /limit is 1 MB/);
assert.equal(await h.answerOf(pv, id("file")), undefined, "an oversize file is refused before it uploads");
await pv.close();
console.log("✔ file upload: several files as an array, oversize refused with a message");

/* photo capture: the fallback for a device with no camera */
pv = await preview([id("photo"), id("signature")]);
await pv.setInputFiles(at("photo", '[data-testid="photo-input"]'), PNG);
await pv.waitForSelector(at("photo", '[data-testid="photo-preview"]'));
up = await h.answerOf(pv, id("photo"));
assert.equal(up.name, "stimulus.png");
assert.match(up.url, /^data:image\/png/);
console.log("✔ photo capture: camera-less fallback stores the photo as an upload");

/* signature */
{
  const b = await surfaceBox(pv, at("signature", '[data-testid="signature-pad"]'));
  await pv.mouse.move(b.x + 30, b.y + b.h * 0.7);
  await pv.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await pv.mouse.move(b.x + 30 + i * 14, b.y + b.h * (0.7 - (i % 2 ? 0.25 : 0)), { steps: 2 });
  }
  await pv.mouse.up();
}
await pv.waitForTimeout(150);
assert.equal(await h.answerOf(pv, id("signature")), undefined, "nothing is stored until Done");
await pv.click(at("signature", '[data-testid="signature-done"]'));
await pv.waitForSelector(at("signature", '[data-testid="signature-saved"]'));
up = await h.answerOf(pv, id("signature"));
assert.equal(up.name, "signature.png");
assert.match(up.url, /^data:image\/png/, "the signature is a PNG on the ordinary upload model");
assert.ok(up.size > 100);
await pv.click(at("signature", '[data-testid="signature-again"]'));
assert.equal(await h.answerOf(pv, id("signature")), null, "sign again starts over");
await pv.close();
console.log("✔ signature capture: pointer-drawn PNG through the upload path");

/* ------------------------------------------- the ordinary validators apply */
const REQUIRED = [
  ["annotation", {}],
  ["draw", {}],
  ["regions", {}],
  ["video_rating", { requireComplete: false }],
  ["video_timeline", {}],
  ["audio_recording", {}],
  ["file", {}],
  ["photo", {}],
  ["signature", {}],
];
for (const [k, tweak] of REQUIRED) {
  pv = await preview([id(k)], (d) => { const q = qOf(d, k); q.required = true; Object.assign(q.settings, tweak); });
  await h.next(pv);
  assert.ok(await pv.$(`[data-qid="${id(k)}"]`), `${k}: unanswered required question keeps you on the page`);
  assert.match(await pv.textContent(".rs-shell"), /required/i, `${k}: the ordinary required message`);
  await pv.close();
}
console.log("✔ required is enforced for all nine answer-bearing variants by the ordinary validator");

/* min_selections on an annotation counts pins + strokes */
pv = await preview([id("annotation")], (d) => { qOf(d, "annotation").settings.minSelections = 3; });
await placePin(pv, "annotation", 0.3, 0.25);
await placePin(pv, "annotation", 0.6, 0.25);
await h.next(pv);
assert.match(await pv.textContent(".rs-shell"), /at least 3/i, "min_selections blocks with two marks");
await placePin(pv, "annotation", 0.8, 0.25);
await h.next(pv);
assert.equal(await pv.$(`[data-qid="${id("annotation")}"]`), null, "and passes with three");
await pv.close();
console.log("✔ min/max selections apply to annotation marks");

/* ------------------------- missing or unplayable media never traps anybody */
pv = await h.preview([id("annotation"), id("video_rating")], (d) => {
  delete qOf(d, "annotation").settings.imageUrl;
  delete qOf(d, "video_rating").settings.mediaUrl;
});
assert.match(await pv.textContent(`[data-qid="${id("annotation")}"]`), /No stimulus image configured/,
  "an annotation with no image says so instead of drawing nothing");
assert.equal((await pv.$$(at("video_rating", '[data-testid="rating-locked"]'))).length, 0);
assert.ok(!(await pv.isDisabled(at("video_rating", '.rs-stars button[aria-label="4 stars"]'))),
  "with no clip to watch, the watch-to-rate gate cannot lock the respondent out");
await pv.click(at("video_rating", '.rs-stars button[aria-label="4 stars"]'));
assert.equal(await h.answerOf(pv, id("video_rating")), 4);
await pv.close();

pv = await h.preview([id("video_rating")], (d) => {
  qOf(d, "video_rating").settings.mediaUrl = `${RUNTIME}/test-media/does-not-exist.webm`;
});
await pv.waitForSelector(at("video_rating", '[data-testid="media-broken"]'));
assert.ok(!(await pv.isDisabled(at("video_rating", '.rs-stars button[aria-label="3 stars"]'))),
  "a clip that will not play unlocks the rating and says why");
await pv.click(at("video_rating", '.rs-stars button[aria-label="3 stars"]'));
assert.equal(await h.answerOf(pv, id("video_rating")), 3);
await pv.close();
console.log("✔ missing / unplayable media degrades to an explained, answerable question");

/* ------------------------------------------------------------- screenshots */
async function answerEverything(page) {
  await placePin(page, "annotation", 0.25, 0.2, "Too busy here");
  await placePin(page, "annotation", 0.7, 0.3, "This part works");
  await page.click(at("annotation", '[data-tool="pen"]'));
  await drawStroke(page, at("annotation", '[data-testid="annot-surface"]'));
  await drawStroke(page, at("draw", '[data-testid="annot-surface"]'), 0.45);
  await page.click(at("draw", '[data-tool="highlight"]'));
  await drawStroke(page, at("draw", '[data-testid="annot-surface"]'), 0.8);
  await page.click(at("regions", '.rs-region[data-code="ground"]'));
  await playToEnd(page, at("video_rating", '[data-testid="media-el"]'));
  await page.click(at("video_rating", '.rs-stars button[aria-label="4 stars"]'));
  await page.$eval(at("video_timeline", '[data-testid="media-el"]'), (v) => { v.currentTime = 0.6; });
  await page.click(at("video_timeline", '.rs-tl-opt[data-code="like"]'));
  await page.$eval(at("video_timeline", '[data-testid="media-el"]'), (v) => { v.currentTime = 2.2; });
  await page.click(at("video_timeline", '.rs-tl-opt[data-code="confusing"]'));
  await playToEnd(page, at("watch_time", '[data-testid="media-el"]'));
  await page.setInputFiles(at("audio_recording", '[data-testid="audio-input"]'), WAV);
  await page.setInputFiles(at("file", '[data-testid="upload-input"]'), PNG);
  await page.setInputFiles(at("photo", '[data-testid="photo-input"]'), PNG);
  const b = await surfaceBox(page, at("signature", '[data-testid="signature-pad"]'));
  await page.mouse.move(b.x + 30, b.y + b.h * 0.7);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(b.x + 30 + i * 14, b.y + b.h * (0.7 - (i % 2 ? 0.25 : 0)), { steps: 2 });
  }
  await page.mouse.up();
  await page.click(at("signature", '[data-testid="signature-done"]'));
  await page.waitForTimeout(400);
}

const ALL = ["annotation", "draw", "regions", "video_rating", "video_timeline", "watch_time",
  "audio_recording", "file", "photo", "signature"].map((k) => id(k));
pv = await preview(ALL);
await answerEverything(pv);
await pv.screenshot({ path: "/tmp/variants-g5-variants.png", fullPage: true });
await pv.setViewportSize({ width: 380, height: 900 });
await pv.waitForTimeout(500);
/*
 * Nothing a variant renders may stick out sideways on a phone. Measured over
 * the question cards rather than the document, because the runtime's own
 * preview chrome — the inspector's `.rs-debug-toggle`, fixed to the right
 * edge — already overhangs a 380px viewport by 25px and is not this batch's
 * to fix.
 */
const overflow = await pv.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  let worst = 0;
  for (const el of document.querySelectorAll("[data-qid], [data-qid] *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) worst = Math.max(worst, r.right - vw, -r.left);
  }
  return Math.round(worst);
});
await pv.screenshot({ path: "/tmp/variants-g5-mobile.png", fullPage: true });
assert.ok(overflow <= 1, `nothing in a question card overflows horizontally at 380px (worst ${overflow}px)`);
await pv.close();
console.log("✔ screenshots written: /tmp/variants-g5-variants.png and /tmp/variants-g5-mobile.png");

await h.close();
console.log("\nALL G5 (IMAGE / MEDIA / HOTSPOT / UPLOAD) VARIANT CHECKS PASSED");
