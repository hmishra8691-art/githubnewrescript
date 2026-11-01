/**
 * Browser suite — S5a "MULTIMEDIA AND GAMIFICATION" (2026-11-01, docs/S5-EXTENDED-FEATURES-2026-11-01.md part A).
 *
 * The runtime preview (the real Runner, engine and renderer; no database) unless a section says otherwise.
 *
 *   A  image zoom (MM2-04): an option image's Enlarge button opens the lightbox (dialog, aria-modal, alt-text caption,
 *      focus inside, Tab trapped, + / − bounded, Esc closes, focus returns, the option is NOT selected); the stimulus
 *      image opens by keyboard; ZOOMED_Q1 counts each open; hover-magnifier shows the lens; zoom off = no button
 *   B  before / after (MM2-06): two images, the divider is a slider (arrows ±5 %, aria-valuenow), the rating after is
 *      the answer, BA_Q1_POSITION / _DWELL_BEFORE / _DWELL_AFTER recorded
 *   C  respondent video (MM2-09): Chromium's fake camera (--use-fake-device-for-media-stream --use-fake-ui-for-media-
 *      stream) on a sandbox test link /n/: consent gates the camera, preview, record, stop, playback, the answer is a
 *      video/webm file and reaches the sandbox store on Next; without devices: the file fallback refuses a PNG and
 *      takes a WebM
 *   D  gamification (GA-06/07, sandbox link): the HUD starts at 0, answering adds points, a badge opens the native
 *      popup once, the level changes, POINTS / BADGES / LEVEL_NAME are saved in the sandbox row
 *   E  review your answers (AQ-12): grouped by section, hidden question absent, long text cut, Change → back to the
 *      page, Return to review → the review shows the changed answer
 *   F  the Studio (needs :3000): Properties → Image zoom, Survey Flow page → Review page, Survey Settings →
 *      Gamification, the Before / After editor
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s5a-media-gamification-test.mjs
 *   SECTIONS=A,B,C,D,E,F (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D,E,F").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];

/* two distinguishable 1×1 PNGs */
const RED = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const BLUE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const watch = (pg, tag) => pg.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${tag}: ${e.message}`); });
async function open(def, opts = {}) {
  const ctx = await (opts.browser ?? browser).newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: opts.reducedMotion ?? "no-preference" });
  const pv = await ctx.newPage();
  watch(pv, def.meta.id);
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def });
  return pv;
}
async function launch(def) {
  const r = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
  const j = await r.json(); assert.ok(j.url, JSON.stringify(j)); return j.url;
}
async function openLink(url, b = browser, first = "[data-qid]") {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
  const pg = await ctx.newPage();
  watch(pg, url);
  await goto(pg, `${RUNTIME}${url}`);
  await pg.waitForSelector(first, { timeout: 120000 });
  return pg;
}
async function row(sessionId, pick, until) {
  let j = null;
  for (let i = 0; i < 80; i++) {
    j = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId, pick }) })).json();
    if (!until || until(j)) break;
    await sleep(250);
  }
  return j;
}
const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const sq = (id, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: `Question ${id}`, options: yesNo, required: false, settings: {}, ...extra });
const survey = (id, questions, pages, extra = {}) => ({ meta: { id, code: id.toUpperCase(), title: id, version: "1" }, questions, flow: [...pages, { type: "end", id: "e1", status: "complete" }], ...extra });
const embedded = (pv) => pv.evaluate(() => ({ ...(window.__rescriptState?.embedded ?? {}) }));
const answers = (pv) => pv.evaluate(() => ({ ...(window.__rescriptState?.answers ?? {}) }));
const next = async (pg) => { await pg.click('[data-testid="rs-next"]'); await sleep(400); };

/* ============================================================== A. image zoom */
if (SECTIONS.has("A")) {
  console.log("\nA  image zoom / lightbox");
  {
    const def = survey("s5a-a1", [
      { id: "q1", code: "Q1", variableName: "Q1", type: "image_select", variant: "image.choice", text: "Which pack?", required: false,
        options: [{ code: "1", label: "Red pack", imageUrl: RED, imageAlt: "The red pack" }, { code: "2", label: "Blue pack", imageUrl: BLUE, imageAlt: "The blue pack" }],
        settings: { zoom: "click", maxSelections: 1, mediaItems: [{ id: "m1", url: RED, alt: "Shelf photo" }] } },
      { id: "q2", code: "Q2", variableName: "Q2", type: "image_select", variant: "image.choice", text: "No zoom", required: false,
        options: [{ code: "1", label: "A", imageUrl: RED }], settings: { maxSelections: 1 } },
    ], [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"] [data-testid="rs-zoom-btn"]');
    assert.equal(await pv.$$eval('[data-qid="q2"] [data-testid="rs-zoom-btn"]', (e) => e.length), 0, "zoom absent = off: no button");
    const btn = '[data-qid="q1"] .rs-imgopt >> nth=1 >> [data-testid="rs-zoom-btn"]';
    assert.equal(await pv.getAttribute(btn, "aria-label"), "Enlarge image: The blue pack");
    await pv.click(btn);
    await pv.waitForSelector('[data-testid="rs-lightbox"]');
    const box = await pv.$eval('[data-testid="rs-lightbox"]', (e) => ({ modal: e.getAttribute("aria-modal"), role: e.getAttribute("role"), label: document.getElementById(e.getAttribute("aria-labelledby"))?.textContent, focus: document.activeElement?.getAttribute("data-testid") }));
    assert.deepEqual(box, { modal: "true", role: "dialog", label: "The blue pack", focus: "rs-lightbox-close" });
    assert.equal((await answers(pv)).q1, undefined, "the Enlarge button does not select the option");
    await pv.keyboard.press("+");
    await pv.keyboard.press("+");
    assert.equal(await pv.getAttribute('[data-testid="rs-lightbox"]', "data-scale"), "2");
    for (let i = 0; i < 12; i++) await pv.keyboard.press("+");
    assert.equal(await pv.getAttribute('[data-testid="rs-lightbox"]', "data-scale"), "5", "bounded at 5×");
    assert.equal(await pv.isDisabled('[data-testid="rs-lightbox-in"]'), true);
    for (let i = 0; i < 6; i++) await pv.keyboard.press("Tab");
    assert.ok(await pv.evaluate(() => !!document.activeElement?.closest('[data-testid="rs-lightbox"]')), "Tab stays inside the dialog");
    await pv.keyboard.press("Escape");
    await pv.waitForSelector('[data-testid="rs-lightbox"]', { state: "detached" });
    await sleep(100);
    assert.equal(await pv.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Enlarge image: The blue pack", "focus returns to the opener");
    assert.equal((await embedded(pv)).ZOOMED_Q1, 1);
    ok("option image: Enlarge opens a dialog (aria-modal, alt text caption, focus on close), + zooms bounded 1–5×, Tab trapped, Esc closes, focus returns, option not selected, ZOOMED_Q1 = 1");
    await pv.focus('[data-qid="q1"] [data-testid="rs-zoomable"]');
    await pv.keyboard.press("Enter");
    await pv.waitForSelector('[data-testid="rs-lightbox"]');
    assert.equal(await pv.textContent('[data-testid="rs-lightbox-caption"]'), "Shelf photo");
    await pv.click('[data-testid="rs-lightbox-close"]');
    await pv.waitForSelector('[data-testid="rs-lightbox"]', { state: "detached" });
    assert.equal((await embedded(pv)).ZOOMED_Q1, 2);
    await pv.click('[data-qid="q1"] .rs-imgopt >> nth=0 >> .cap');
    assert.equal(String((await answers(pv)).q1), "1", "clicking the image itself still selects");
    ok("stimulus image: Enter on the zoomable image opens it (caption = its alt), the close button closes; ZOOMED_Q1 = 2; the option card still selects");
    await pv.context().close();
  }
  {
    const def = survey("s5a-a2", [{ id: "q1", code: "Q1", variableName: "Q1", type: "html", text: "Look closely", settings: { zoom: "hover-magnifier", mediaItems: [{ id: "m1", url: RED, alt: "Detail" }] } }], [{ type: "page", id: "p1", questionIds: ["q1"] }]);
    const pv = await open(def);
    await pv.waitForSelector('[data-testid="rs-zoomable"][data-zoom="hover-magnifier"]');
    const bb = await pv.$eval('[data-testid="rs-zoomable"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await pv.mouse.move(bb.x, bb.y);
    await pv.waitForSelector('[data-testid="rs-magnifier"]', { timeout: 5000 });
    ok("hover-magnifier: a lens follows the pointer over the stimulus (the click / Enter lightbox stays available)");
    await pv.context().close();
  }
}

/* ============================================================== B. before / after */
if (SECTIONS.has("B")) {
  console.log("\nB  before / after comparison slider");
  const def = survey("s5a-b", [
    { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", variant: "comparison.before_after", text: "Compare the redesign", required: false,
      settings: { minValue: 1, maxValue: 5, recordPosition: true, beforeAfter: { beforeLabel: "Old", afterLabel: "New", startPosition: 50, askRating: true },
        mediaItems: [{ id: "b", url: RED, alt: "Old pack" }, { id: "a", url: BLUE, alt: "New pack" }] } },
  ], [{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const pv = await open(def);
  await pv.waitForSelector('[data-testid="ba-handle"]');
  assert.equal(await pv.getAttribute('[data-testid="ba-handle"]', "role"), "slider");
  assert.equal(await pv.$$eval('[data-qid="q1"] [data-testid="rs-qmedia"]', (e) => e.length), 0, "the two images are not drawn again as a stimulus");
  await pv.focus('[data-testid="ba-handle"]');
  await pv.keyboard.press("ArrowRight");
  await pv.keyboard.press("ArrowRight");
  assert.equal(await pv.getAttribute('[data-testid="ba-handle"]', "aria-valuenow"), "60");
  await pv.keyboard.press("End");
  assert.equal(await pv.getAttribute('[data-testid="ba-handle"]', "aria-valuenow"), "100");
  await sleep(600);
  const fr = await pv.$eval('[data-testid="ba-frame"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await pv.mouse.move(fr.x + fr.w * 0.5, fr.y + fr.h / 2);
  await pv.mouse.down(); await pv.mouse.move(fr.x + fr.w * 0.2, fr.y + fr.h / 2, { steps: 4 }); await pv.mouse.up();
  const v = Number(await pv.getAttribute('[data-testid="ba-handle"]', "aria-valuenow"));
  assert.ok(v >= 17 && v <= 23, `dragged to ~20 (${v})`);
  await pv.check('[data-testid="ba-rate-4"]');
  assert.equal((await answers(pv)).q1, 4);
  const em = await embedded(pv);
  assert.ok(Math.abs(em.BA_Q1_POSITION - v) <= 0.6, JSON.stringify(em));
  assert.ok(typeof em.BA_Q1_DWELL_BEFORE === "number" && typeof em.BA_Q1_DWELL_AFTER === "number" && em.BA_Q1_DWELL_BEFORE > 0, JSON.stringify(em));
  ok(`before/after: role=slider, arrows ±5 % (60), End 100, pointer drag (${v}), rating 4 is the answer, BA_Q1_POSITION / _DWELL_BEFORE ${em.BA_Q1_DWELL_BEFORE}s / _DWELL_AFTER ${em.BA_Q1_DWELL_AFTER}s recorded`);
  await pv.context().close();
}

/* ============================================================== C. respondent video */
if (SECTIONS.has("C")) {
  console.log("\nC  respondent video recording");
  const vdef = survey("s5a-c", [
    { id: "q1", code: "Q1", variableName: "Q1", type: "upload", variant: "media.video_recording", text: "Show us your kitchen", required: true,
      settings: { accept: "video/webm,video/mp4,video/quicktime", maxFiles: 1, maxSizeMb: 50, maxAnswerSeconds: 30, maxRetakes: 2, consentText: "I agree to be recorded." } },
    sq("q2"),
  ], [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }]);
  const cam = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const pg = await openLink(await launch(vdef), cam, '[data-qid="q1"]');
    await pg.context().grantPermissions(["camera", "microphone"]).catch(() => {});
    assert.equal(await pg.isDisabled('[data-testid="vrec-camera"]'), true, "the camera waits for consent");
    await pg.check('[data-testid="vrec-consent-box"]');
    await pg.click('[data-testid="vrec-camera"]');
    await pg.waitForSelector('[data-testid="vrec-preview"]', { timeout: 15000 });
    await pg.waitForFunction(() => { const v = document.querySelector('[data-testid="vrec-preview"]'); return !!v && v.srcObject && v.readyState >= 2; }, null, { timeout: 15000 });
    await pg.click('[data-testid="vrec-record"]');
    await pg.waitForSelector('[data-testid="vrec-stop"]');
    await sleep(2500);
    await pg.click('[data-testid="vrec-stop"]');
    await pg.waitForSelector('[data-testid="vrec-playback"]', { timeout: 20000 });
    const a = (await answers(pg)).q1;
    const f = Array.isArray(a) ? a[0] : a;
    assert.equal(f?.type, "video/webm", JSON.stringify(f)?.slice(0, 200));
    assert.ok(f.size > 1000, `size ${f.size}`);
    assert.equal(await pg.textContent('[data-testid="vrec-live"]'), "Video saved");
    ok(`fake camera: consent gates the camera → preview (live stream) → record 2.5 s → stop → playback; the answer is a video/webm file (${f.size} bytes); the live region says "Video saved"`);
    const sessionId = await pg.evaluate(() => window.__rescriptState.sessionId);
    await next(pg);
    await pg.waitForSelector('[data-qid="q2"]', { timeout: 15000 });
    const r = await row(sessionId, { answers: ["q1"] }, (j) => j?.picked?.answers?.q1);
    const stored = r.picked.answers.q1;
    assert.equal((Array.isArray(stored) ? stored[0] : stored)?.type, "video/webm", JSON.stringify(r).slice(0, 300));
    ok("Next saves the video answer into the sandbox store (the test link's session row holds the video/webm file answer)");
    await pg.context().close();
  } finally { await cam.close(); }
  /* no devices at all (the default headless browser): the file fallback, with the video rules */
  const pv = await open(vdef);
  await pv.check('[data-testid="vrec-consent-box"]');
  await pv.click('[data-testid="vrec-camera"]');
  await pv.waitForSelector('[data-testid="vrec-note"]', { timeout: 15000 });
  assert.match(await pv.textContent('[data-testid="vrec-note"]'), /upload a video file instead|not supported/);
  const png = Buffer.from(RED.split(",")[1], "base64");
  await pv.setInputFiles('[data-testid="vrec-input"]', { name: "fake.webm", mimeType: "image/png", buffer: png });
  await pv.waitForFunction(() => /WebM, MP4 or MOV/.test(document.querySelector('[data-testid="vrec-note"]')?.textContent ?? ""), null, { timeout: 5000 });
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 1)]);
  await pv.setInputFiles('[data-testid="vrec-input"]', { name: "answer.webm", mimeType: "video/webm", buffer: webm });
  await pv.waitForSelector('[data-testid="vrec-playback"]', { timeout: 10000 });
  ok("no camera: the note offers the file upload; a PNG is refused by the video rule (WebM, MP4 or MOV); a WebM file is taken as the answer");
  await pv.context().close();
}

/* ============================================================== D. gamification */
if (SECTIONS.has("D")) {
  console.log("\nD  points, badges, levels");
  const def = survey("s5a-d", [
    { ...sq("q1"), text: "Is the sky blue?", assessment: { correct: ["1"] } },
    { ...sq("q2"), text: "Is fire cold?", assessment: { correct: ["2"] } },
    sq("q3"),
  ], [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }], {
    gamification: {
      enabled: true, points: { perAnswer: 10, perCorrect: 5 },
      badges: [{ id: "first", title: "First answer", icon: "rocket", when: { type: "rule", source: { kind: "calculation", ref: "POINTS_ANSWERED" }, operator: "gte", value: 1 } },
        { id: "sharp", title: "Sharp mind", icon: "lightbulb", description: "Two right answers", when: { type: "rule", source: { kind: "calculation", ref: "POINTS_CORRECT" }, operator: "gte", value: 2 } }],
      levels: [{ name: "Bronze", minPoints: 10 }, { name: "Silver", minPoints: 30 }],
      hud: { show: true, position: "bottom-right" },
    },
  });
  const pg = await openLink(await launch(def), browser, '[data-qid="q1"]');
  await pg.waitForSelector('[data-testid="rs-gam-hud"]');
  assert.equal(await pg.getAttribute('[data-testid="rs-gam-hud"]', "data-points"), "0");
  assert.equal(await pg.getAttribute('[data-testid="rs-gam-hud"]', "role"), "status");
  assert.ok((await pg.getAttribute('[data-testid="rs-gam-hud"]', "class")).includes("rs-gam-bottom-right"));
  await pg.click('[data-qid="q1"] label:has-text("Yes")');
  await pg.waitForFunction(() => document.querySelector('[data-testid="rs-gam-hud"]')?.getAttribute("data-points") === "15");
  await pg.waitForSelector('[data-testid="rs-ux-popup"]:has-text("First answer")', { timeout: 5000 });
  assert.equal(await pg.textContent('[data-testid="rs-gam-level"]'), "· Bronze");
  ok("HUD (role=status, bottom-right) 0 → 15 after a correct answer; the “First answer” badge opens the native popup; level Bronze");
  await pg.click('[data-qid="q2"] label:has-text("No")');
  await pg.waitForFunction(() => document.querySelector('[data-testid="rs-gam-hud"]')?.getAttribute("data-points") === "30");
  await pg.waitForSelector('[data-testid="rs-ux-popup"]:has-text("Sharp mind")', { timeout: 5000 });
  assert.equal(await pg.textContent('[data-testid="rs-gam-level"]'), "· Silver");
  assert.equal(await pg.$$eval('[data-testid="rs-gam-badges"] [role="img"]', (e) => e.map((x) => x.getAttribute("aria-label")).join("|")), "Badge: First answer|Badge: Sharp mind");
  await pg.click('[data-qid="q2"] label:has-text("Yes")');
  await sleep(500);
  assert.equal(await pg.getAttribute('[data-testid="rs-gam-hud"]', "data-badges"), "first,sharp", "one-time: Sharp mind stays earned");
  ok("30 points → Sharp mind popup, level Silver, the HUD lists both badges by name; changing to a wrong answer keeps the badge (one-time)");
  const sessionId = await pg.evaluate(() => window.__rescriptState.sessionId);
  await next(pg);
  await pg.waitForSelector('[data-qid="q3"]', { timeout: 15000 });
  const r = await row(sessionId, { calculated: ["POINTS", "BADGES", "LEVEL", "LEVEL_NAME"] }, (j) => j?.picked?.calculated?.BADGES);
  assert.deepEqual(r.picked.calculated, { POINTS: 25, BADGES: "first,sharp", LEVEL: 1, LEVEL_NAME: "Bronze" }, JSON.stringify(r.picked));
  ok("saved in the sandbox row: POINTS 25, BADGES first,sharp, LEVEL 1 / Bronze (calculated variables)");
  await pg.context().close();
}

/* ============================================================== E. review your answers */
if (SECTIONS.has("E")) {
  console.log("\nE  review your answers");
  const def = survey("s5a-e", [
    sq("q1", { text: "Do you cook?" }),
    { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "What did you cook last?", required: false, settings: {} },
    sq("q3", { text: "Secret question", settings: { hidden: true } }),
    sq("q4", { text: "Do you bake?" }),
    { id: "rv", code: "RV", variableName: "RV", type: "html", text: "Please check.", settings: {} },
  ], [], {});
  def.flow = [
    { type: "block", id: "b1", title: "Cooking", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }] },
    { type: "block", id: "b2", title: "Baking", children: [{ type: "page", id: "p2", questionIds: ["q4"] }, { type: "page", id: "p3", questionIds: ["rv"], review: { enabled: true, title: "Check your answers", textLimit: 30 } }] },
    { type: "end", id: "e1", status: "complete" },
  ];
  const pv = await open(def);
  await pv.waitForSelector('[data-qid="q1"]');
  await pv.click('[data-qid="q1"] label:has-text("Yes")');
  await pv.fill('[data-qid="q2"] textarea', "A very long description of a lasagne with many layers");
  await next(pv);
  await pv.waitForSelector('[data-qid="q4"]');
  await pv.click('[data-qid="q4"] label:has-text("No")');
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-review"]');
  const groups = await pv.$$eval('[data-testid="rs-review-group"]', (gs) => gs.map((g) => ({ title: g.querySelector("h3")?.textContent, items: [...g.querySelectorAll('[data-testid="rs-review-item"]')].map((i) => `${i.querySelector("dt")?.textContent}=${i.querySelector('[data-testid="rs-review-answer"]')?.textContent}`) })));
  assert.deepEqual(groups.map((g) => g.title), ["Cooking", "Baking"]);
  assert.deepEqual(groups[0].items[0], "Do you cook?=Yes");
  assert.match(groups[0].items[1], /^What did you cook last\?=A very long description of a l…$/);
  assert.ok(!groups.flatMap((g) => g.items).some((i) => /Secret/.test(i)), "the hidden question is not listed");
  assert.equal(await pv.getAttribute('[data-testid="rs-review-change"] >> nth=2', "aria-label"), "Change your answer to: Do you bake?");
  ok("review page: grouped Cooking / Baking, labels not codes, long text cut at 30 with …, hidden question absent, Change buttons named by question");
  await pv.click('[data-testid="rs-review-change"] >> nth=2');
  await pv.waitForSelector('[data-qid="q4"]');
  await pv.click('[data-qid="q4"] label:has-text("Yes")');
  await pv.click('[data-testid="rs-review-return"]');
  await pv.waitForSelector('[data-testid="rs-review"]');
  const after = await pv.$$eval('[data-testid="rs-review-item"]', (e) => e.map((i) => i.querySelector('[data-testid="rs-review-answer"]')?.textContent));
  assert.equal(after[2], "Yes");
  ok("Change → page 2 (visited, Back's rule), the answer changed, Return to review → the review shows Yes");
  await pv.context().close();
}

/* ============================================================== F. Studio */
if (SECTIONS.has("F")) {
  console.log("\nF  Studio: Image zoom, Review page, Gamification, Before / After editor");
  const { openHarness } = await import("./lib/variantHarness.mjs");
  const h = await openHarness();
  try {
    await h.loadDef({
      meta: { id: "sandbox", code: "S5A", title: "S5a", version: "1.0" },
      questions: [
        { id: "q1", code: "Q1", variableName: "Q1", type: "image_select", variant: "image.choice", text: "Pack?", options: [{ code: "1", label: "A", imageUrl: RED }], settings: { maxSelections: 1 } },
        { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", variant: "comparison.before_after", text: "Compare", settings: { minValue: 1, maxValue: 5 } },
      ],
      flow: [{ type: "page", id: "p1", title: "Page one", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
    });
    await h.goTab("Questions");
    await h.page.click('[data-testid="qcard"][data-qid="q1"]');
    await h.page.waitForTimeout(250);
    const head = '[data-testid="psec-head-image-zoom"]';
    await h.page.waitForSelector(head, { timeout: 15000 });
    if ((await h.page.getAttribute(head, "aria-expanded")) !== "true") await h.page.click(head);
    await h.page.selectOption('[data-testid="question-zoom-mode"]', "hover-magnifier");
    await h.page.waitForTimeout(300);
    let def = await h.readDef();
    assert.equal(def.questions.find((q) => q.id === "q1").settings.zoom, "hover-magnifier");
    ok("Properties → Image zoom → hover-magnifier writes settings.zoom");

    await h.goTab("Questions");
    await h.page.click('[data-testid="qcard"][data-qid="q2"]');
    await h.page.waitForSelector('[data-testid="ba-editor"]', { timeout: 15000 });
    await h.page.fill('[data-testid="ba-before-label"]', "Old");
    await h.page.click('[data-testid="ba-record"]');
    await h.page.click('[data-testid="ba-ask-rating"]');
    await h.page.waitForTimeout(300);
    def = await h.readDef();
    const q2 = def.questions.find((q) => q.id === "q2");
    assert.equal(q2.settings.beforeAfter?.beforeLabel, "Old");
    assert.equal(q2.settings.recordPosition, true);
    assert.deepEqual([q2.settings.beforeAfter?.askRating, q2.settings.minValue, q2.settings.maxValue], [false, 0, 100]);
    ok("Before / After editor: label, record position, rating off → position 0–100 is the answer");

    await h.goTab("Survey Flow");
    const card = '[data-testid="flow-block"][data-node-id="p1"]';
    await h.page.waitForSelector(card, { timeout: 15000 });
    await h.page.click(`${card} .block-toggle >> nth=0`);
    await h.page.click('[data-testid="page-review-toggle-p1"] summary');
    await h.page.click('[data-testid="page-review-p1-on"]');
    await h.page.fill('[data-testid="page-review-p1-title"]', "Check");
    await h.page.waitForTimeout(300);
    def = await h.readDef();
    assert.deepEqual(def.flow.find((n) => n.id === "p1").review, { enabled: true, title: "Check" });
    ok("Survey Flow → page → Review page on + heading writes page.review");

    await h.goTab("Survey Settings");
    await h.page.waitForSelector('[data-testid="gamification-on"]', { timeout: 15000 });
    await h.page.click('[data-testid="gamification-on"]');
    await h.page.fill('[data-testid="gamification-per-answer"]', "20");
    await h.page.fill('[data-testid="gamification-badge-title"]', "Speedy");
    await h.page.selectOption('[data-testid="gamification-badge-icon"]', "fire");
    await h.page.fill('[data-testid="gamification-badge-rule"]', "POINTS >= 40");
    await h.page.click('[data-testid="gamification-badge-add"]');
    await h.page.click('[data-testid="gamification-level-add"]');
    await h.page.waitForTimeout(300);
    def = await h.readDef();
    assert.equal(def.gamification.points.perAnswer, 20);
    assert.deepEqual(def.gamification.badges.map((b) => [b.id, b.icon, b.when.source.ref, b.when.value]), [["speedy", "fire", "POINTS", 40]]);
    assert.equal(def.gamification.levels.length, 1);
    ok("Survey Settings → Gamification: 20 per answer, a fire badge at POINTS >= 40, a level");
  } finally { await h.close?.(); }
}

await browser.close();
if (allErrors.length) { console.error("page errors:\n  " + allErrors.join("\n  ")); process.exit(1); }
console.log(`\n${passed} passed`);
