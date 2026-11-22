/**
 * Browser check — Q7: a recorded video answer also records its AUDIO track alone, for the transcript.
 *
 * Chromium's fake camera and microphone (--use-fake-device-for-media-stream) on a sandbox test link (/n/). The test
 * watches every MediaRecorder the page makes (an init script wraps the constructor) and checks:
 *   1. a transcribed video question makes two recorders: the video (video + audio tracks) and the audio track alone,
 *      and the audio one hands over data when the take stops; the video answer is saved as before
 *   2. a video question with transcription off makes only the video recorder
 * A test link keeps files in the browser (no storage, no transcription service), so the upload of the audio track and
 * the transcript itself are not exercised here: they need a live link and a configured speech-to-text service.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/q7-video-transcript-browser.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const survey = (id, settings) => ({
  meta: { id, code: id.toUpperCase(), title: id, version: "1" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "upload", variant: "media.video_recording", text: "Show us your kitchen", required: true,
    settings: { accept: "video/webm,video/mp4,video/quicktime", maxFiles: 1, maxSizeMb: 50, maxAnswerSeconds: 30, maxRetakes: 2, consentText: "I agree to be recorded.", ...settings } }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
});
async function launch(def) {
  const r = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
  const j = await r.json(); assert.ok(j.url, JSON.stringify(j)); return j.url;
}

/* every MediaRecorder: the kinds of track it records, its type, and the bytes it handed over */
const WATCH = () => {
  const made = (window.__recorders = []);
  const Orig = window.MediaRecorder;
  window.MediaRecorder = class extends Orig {
    constructor(stream, opts) {
      super(stream, opts);
      const rec = { kinds: stream.getTracks().map((t) => t.kind).sort(), mime: this.mimeType, bytes: 0, stopped: false };
      made.push(rec);
      this.addEventListener("dataavailable", (e) => { rec.bytes += e.data.size; });
      this.addEventListener("stop", () => { rec.stopped = true; });
    }
  };
  window.MediaRecorder.isTypeSupported = Orig.isTypeSupported.bind(Orig);
};

async function take(browser, def) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  await ctx.addInitScript(WATCH);
  await ctx.grantPermissions(["camera", "microphone"]).catch(() => {});
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => { if (!/ChunkLoadError|ResizeObserver/.test(String(e))) errors.push(e.message); });
  const url = await launch(def);
  for (let i = 0; ; i++) { try { await pg.goto(`${RUNTIME}${url}`, { waitUntil: "networkidle", timeout: 120000 }); break; } catch (e) { if (i >= 3) throw e; await sleep(5000); } }
  await pg.waitForSelector('[data-qid="q1"]', { timeout: 120000 });
  await pg.check('[data-testid="vrec-consent-box"]');
  await pg.click('[data-testid="vrec-camera"]');
  await pg.waitForFunction(() => { const v = document.querySelector('[data-testid="vrec-preview"]'); return !!v && v.srcObject && v.readyState >= 2; }, null, { timeout: 20000 });
  await pg.click('[data-testid="vrec-record"]');
  await sleep(2500);
  await pg.click('[data-testid="vrec-stop"]');
  await pg.waitForSelector('[data-testid="vrec-playback"]', { timeout: 20000 });
  await sleep(500);
  const recorders = await pg.evaluate(() => window.__recorders);
  const answer = await pg.evaluate(() => window.__rescriptState?.answers?.q1);
  await ctx.close();
  return { recorders, answer };
}

const cam = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  const on = await take(cam, survey("q7-on", {}));
  const video = on.recorders.find((r) => r.kinds.includes("video"));
  const audio = on.recorders.find((r) => !r.kinds.includes("video"));
  assert.equal(on.recorders.length, 2, JSON.stringify(on.recorders));
  assert.deepEqual(video.kinds, ["audio", "video"]);
  assert.deepEqual(audio.kinds, ["audio"]);
  assert.match(audio.mime, /^audio\//);
  assert.ok(audio.stopped && audio.bytes > 500, `audio track: ${audio.bytes} bytes`);
  const f = Array.isArray(on.answer) ? on.answer[0] : on.answer;
  assert.equal(f?.type, "video/webm");
  ok(`transcribed question: two recorders — the video (${video.bytes} bytes, audio + video) and the audio track alone (${audio.mime}, ${audio.bytes} bytes, handed over on stop); the video answer is saved (${f.size} bytes)`);

  const off = await take(cam, survey("q7-off", { transcribeAnswer: false }));
  assert.equal(off.recorders.length, 1, JSON.stringify(off.recorders));
  assert.deepEqual(off.recorders[0].kinds, ["audio", "video"]);
  ok("transcription off: only the video recorder");
  assert.deepEqual(errors, [], errors.join(" | "));
  ok("no page errors");
} finally { await cam.close(); }
console.log(`\nq7-video-transcript-browser: ${passed} passed`);
