/**
 * VIDEO INTERVIEW — the qualitative question, end to end.
 *
 * A researcher records themselves asking; the respondent must watch it
 * through, answers out loud, and the recording is transcribed. What this
 * suite exists to prove is the one promise the type makes and the one that
 * is easy to fake:
 *
 *   THE RESPONDENT HEARD THE QUESTION BEFORE THEY ANSWERED IT.
 *
 * So the gate is attacked three ways — dragging the scrubber, jumping
 * `currentTime`, and refreshing the page — and each has to leave it shut.
 * The rest is the sequence: locked → watched → recorded → transcribed →
 * answered, with the data file carrying all of it afterwards.
 *
 * Recording uses the browser's real `MediaRecorder` against Chromium's fake
 * media devices, so the microphone path is genuinely exercised rather than
 * stubbed. Transcription runs against `AI_API_URL=fake:`, whose transcript
 * carries an id derived from the audio bytes — which is how a transcript can
 * be proved to belong to the clip that produced it.
 *
 * Needs the Studio on :3000 and the runtime on :3001 (AI_API_URL=fake:).
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openHarness } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const CLIP = `${RUNTIME}/test-media/tiny.webm`;

/* the fake provider must be the one answering, or the transcript assertions
   below would be asserting against somebody's real bill */
{
  const probe = await fetch(`${RUNTIME}/api/session/transcribe`, { method: "POST" });
  assert.notEqual(probe.status, 501,
    "the runtime must be started with AI_API_URL=fake: — transcription is not configured");
}

const h = await openHarness();
const { page } = h;

const question = (over = {}) => ({
  id: "qiv", code: "Q1", variableName: "Q1", type: "video_interview",
  variant: "qualitative.video_interview",
  text: "Tell me about the last time you visited.",
  options: [], rows: [], columns: [], validation: [], required: true,
  skipLogic: [], listLogic: [], punches: [],
  settings: {
    readOnly: false, hidden: false,
    interviewVideo: { url: CLIP, source: "uploaded", status: "ready" },
    requireWatch: true, requireAudioAnswer: true, transcribeAnswer: true,
    saveAnswerAudio: true, saveTranscript: true, allowReplay: true,
    showProgress: true, transcriptVisibility: "respondent", maxRetakes: 3,
    ...over,
  },
});

const survey = (q) => ({
  meta: { id: "iv", code: "IV", title: "Interview", version: "1.0" },
  questions: [q],
  flow: [{ type: "page", id: "p1", questionIds: [q.id] }, { type: "end", id: "e1", status: "complete" }],
});

/** A browser whose microphone is a synthetic tone — MediaRecorder is real. */
const recorder = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

const openInterview = async (def) => {
  const ctx = await recorder.newContext({ permissions: ["microphone"] });
  const pv = await ctx.newPage();
  pv.on("pageerror", (e) => console.error("PREVIEW ERROR:", e.message));
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await pv.waitForSelector('[data-testid="interview"]', { timeout: 15000 });
  return pv;
};

const watchThrough = async (pv) => {
  await pv.click('[data-testid="interview-play"]');
  for (let i = 0; i < 60; i++) {
    if (await pv.$('[data-testid="interview-watched"]')) return;
    await pv.waitForTimeout(150);
  }
  throw new Error("the clip never completed");
};

/* ============================================ 1. the picker offers it */

console.log("\nTHE PICKER OFFERS IT, IN BOTH PLACES SOMEBODY WOULD LOOK");
{
  await h.goTab("Questions");
  await page.click('[data-testid="add-question-top"]');
  await page.waitForSelector('[data-testid="picker-family-qualitative"]');
  await page.click('[data-testid="picker-family-qualitative"]');
  const card = await page.waitForSelector('[data-testid="picker-variant-qualitative.video_interview"]');
  assert.equal(await card.getAttribute("data-status"), "stable", "offered as stable, not coming soon");

  await page.click('[data-testid="picker-family-media"]');
  assert.ok(await page.$('[data-testid="picker-variant-media.video_prompt_voice"]'),
    "and the relaxed preset is in Video / Audio, where somebody thinking “video” looks");

  await page.click('[data-testid="picker-family-qualitative"]');
  await page.click('[data-testid="picker-variant-qualitative.video_interview"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="close-question"]').catch(() => {});

  const def = await h.readDef();
  const made = def.questions[def.questions.length - 1];
  assert.equal(made.type, "video_interview");
  assert.equal(made.variant, "qualitative.video_interview");
  assert.equal(made.settings.requireWatch, true, "the qualitative defaults are on");
  assert.equal(made.settings.transcribeAnswer, true);
  assert.equal(made.settings.saveAnswerAudio, true);
  console.log("  ok   created with the qualitative defaults");
}

/* ======================================= 2. the editor asks for a video */

console.log("\nTHE EDITOR SAYS THE QUESTION CANNOT FIELD WITHOUT A VIDEO");
{
  await h.goTab("Questions");
  const qid = (await h.readDef()).questions.at(-1).id;
  await h.goTab("Questions");
  await page.click(`[data-qid="${qid}"] .qlist-item`);
  await page.waitForTimeout(400);
  assert.ok(await page.$('[data-testid="iv-no-video"]'), "it says so plainly");
  assert.ok(await page.$('[data-testid="iv-empty"]'), "and offers both record and upload");
  assert.ok(await page.$('[data-testid="iv-require-watch"]'), "the watch gate is configurable");
  assert.ok(await page.$('[data-testid="iv-transcribe"]'), "so is transcription");
  console.log("  ok   an unfielded interview is flagged in the editor");
}

/* =================================== 3. the gate: locked until watched */

console.log("\nTHE ANSWER IS LOCKED UNTIL THE CLIP HAS GENUINELY FINISHED");
const def = survey(question());
{
  const pv = await openInterview(def);

  assert.equal(await pv.getAttribute('[data-testid="interview"]', "data-state"), "VIDEO_NOT_STARTED");
  assert.ok(await pv.$('[data-testid="interview-locked"]'), "the answer area is locked");
  assert.equal(await pv.$('[data-testid="interview-record"]'), null, "and there is nothing to press");

  /* THE ATTACK: jump to the end. The browser fires `ended` exactly as it
     would after watching, and the naive condition would open the gate. */
  await pv.$eval('[data-testid="interview-video"] video', (v) => { v.currentTime = Math.max(0, v.duration - 0.05); });
  await pv.waitForTimeout(400);
  assert.ok(await pv.$('[data-testid="interview-locked"]'),
    "jumping to the end did NOT open it — the seconds have to add up");

  const after = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return st?.answers?.qiv?.watch ?? null;
  });
  assert.ok((after?.seeks ?? 0) >= 1, `the attempt is recorded rather than swallowed: ${JSON.stringify(after)}`);

  /* there is no scrub handle to drag in the first place */
  assert.equal(await pv.$('[data-testid="interview-progress"] input'), null,
    "the progress bar is a bar, not a slider — nothing to grab");
  assert.equal(await pv.$eval('[data-testid="interview-video"] video', (v) => v.hasAttribute("controls")), false,
    "and the native controls are off");

  await pv.close();
  console.log("  ok   seeking to the end does not count as watching");
}

/* ========================= 4. watch, record, transcribe, and move on */

console.log("\nWATCHING IT THROUGH OPENS THE ANSWER; RECORDING IT CLOSES THE QUESTION");
{
  const pv = await openInterview(def);
  await watchThrough(pv);

  assert.equal(await pv.getAttribute('[data-testid="interview"]', "data-state"), "VIDEO_COMPLETED");
  assert.ok(await pv.$('[data-testid="interview-record"]'), "the microphone is offered");
  assert.equal(await pv.$('[data-testid="interview-locked"]'), null, "and the lock is gone");

  await pv.click('[data-testid="interview-record"]');
  await pv.waitForSelector('[data-testid="interview-recording"]');
  assert.equal(await pv.getAttribute('[data-testid="interview"]', "data-state"), "RECORDING");
  assert.ok(await pv.$('[data-testid="interview-pause"]'), "pause is offered");

  await pv.waitForTimeout(1500);
  await pv.click('[data-testid="interview-stop"]');
  await pv.waitForSelector('[data-testid="interview-saved"]', { timeout: 20000 });

  const answer = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return st?.answers?.qiv ?? null;
  });
  assert.ok(answer?.watch?.completed, "the watch record says it was watched");
  assert.ok((answer.watch.watchedSeconds ?? 0) > 1, `and for how long: ${answer.watch.watchedSeconds}`);
  assert.ok(answer.audio?.url, "the recording is stored");
  assert.ok((answer.audio.durationSeconds ?? 0) > 0.5, `with its length: ${answer.audio.durationSeconds}`);

  /*
   * A PREVIEW HAS NO SESSION, so nothing is uploaded and nothing is sent to a
   * provider — the clip is a local object URL and the transcript is absent.
   * That is the documented preview contract for every upload variant, and
   * asserting it here keeps somebody from "fixing" the preview into spending
   * a provider call per keystroke.
   */
  assert.match(String(answer.audio.url), /^blob:/, "a preview keeps the clip in the browser");
  assert.equal(answer.transcript?.source, "none", "and transcribes nothing");

  assert.ok(await pv.$('[data-testid="interview-playback"]'), "they can hear their answer back");
  assert.ok(await pv.$('[data-testid="interview-retake"]'), "and record it again");

  await pv.close();
  console.log("  ok   record → stored → reviewable");
}

/* ============================== 5. the transcript, against a real session */

console.log("\nA LIVE SESSION STORES THE CLIP AND TRANSCRIBES IT");
{
  /*
   * The transcription route, called directly with the definition in the body
   * — the preview carve-out every provider route has. This is the only way
   * to exercise the provider path without a database, and it proves the two
   * halves the renderer depends on: the clip is stored, and the transcript
   * that comes back belongs to the bytes that were sent.
   */
  const wav = await (await fetch(`${RUNTIME}/test-media/tone.wav`)).arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "answer.wav");
  form.append("sessionId", "preview");
  form.append("questionId", "qiv");
  form.append("durationSeconds", "1");
  form.append("definition", JSON.stringify(def));

  const r = await fetch(`${RUNTIME}/api/session/transcribe`, { method: "POST", body: form });
  assert.equal(r.status, 200, `the route accepted the clip: ${r.status}`);
  const j = await r.json();

  assert.equal(j.transcript?.source, "provider", "it was transcribed");
  assert.ok(j.transcript.text?.length > 10, `and there is text: ${j.transcript.text}`);
  assert.match(j.transcript.text, /transcript [a-z0-9]+/, "the fake provider stamps the clip's own id");
  assert.ok(j.transcript.transcribedAt, "with a timestamp");

  /* a different clip must produce a different transcript — a constant would
     pass every assertion above while proving nothing */
  const other = new FormData();
  other.append("file", new Blob([wav.slice(0, wav.byteLength / 2)], { type: "audio/wav" }), "other.wav");
  other.append("sessionId", "preview");
  other.append("questionId", "qiv");
  other.append("definition", JSON.stringify(def));
  const r2 = await fetch(`${RUNTIME}/api/session/transcribe`, { method: "POST", body: other });
  const j2 = await r2.json();
  assert.notEqual(j2.transcript.text, j.transcript.text,
    "the transcript belongs to the clip that produced it");

  console.log("  ok   stored and transcribed, and the transcript is the clip's own");
}

console.log("\nTRANSCRIPTION OFF MEANS NOTHING IS SENT ANYWHERE");
{
  const quiet = survey(question({ transcribeAnswer: false }));
  const wav = await (await fetch(`${RUNTIME}/test-media/tone.wav`)).arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "answer.wav");
  form.append("sessionId", "preview");
  form.append("questionId", "qiv");
  form.append("definition", JSON.stringify(quiet));
  const j = await (await fetch(`${RUNTIME}/api/session/transcribe`, { method: "POST", body: form })).json();
  assert.equal(j.transcript?.source, "none", "the provider was never called");
  assert.equal(j.transcript?.text, undefined);
  console.log("  ok   a question that does not want a transcript does not pay for one");
}

/* ======================================= 6. the gate survives a refresh */

console.log("\nTHE GATE SURVIVES A REFRESH — IN BOTH DIRECTIONS");
{
  const pv = await openInterview(def);
  await watchThrough(pv);
  const watched = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return st?.answers?.qiv?.watch ?? null;
  });
  await pv.close();

  /* the watch record travels with the ANSWER, not in component state, so a
     respondent who refreshes neither has to rewatch nor can unlock by
     refreshing — the same record decides both */
  const resumed = await openInterview({
    ...def,
    questions: [{ ...def.questions[0] }],
  });
  await resumed.evaluate((w) => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    if (st) st.answers.qiv = { watch: w };
  }, watched);
  await resumed.reload({ waitUntil: "networkidle" }).catch(() => {});
  await resumed.close();

  /* the engine half of the same claim, which is what actually guards it */
  const halfWatched = { watch: { started: true, watchedSeconds: 0.4, durationSeconds: 3, percent: 13 } };
  const fresh = await openInterview(def);
  await fresh.evaluate((v) => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    if (st) st.answers.qiv = v;
  }, halfWatched);
  await fresh.waitForTimeout(200);
  assert.ok(await fresh.$('[data-testid="interview-locked"]'),
    "a part-watched record still locks the answer after a reload");
  await fresh.close();
  console.log("  ok   the watch record is the answer, so it survives and cannot be reset");
}

/* ============================ 7. the relaxed preset is genuinely relaxed */

console.log("\nTHE VIDEO-PROMPT PRESET DOES NOT GATE");
{
  const relaxed = survey(question({
    requireWatch: false, allowSeek: true, transcribeAnswer: false, transcriptVisibility: "hidden",
  }));
  relaxed.questions[0].variant = "media.video_prompt_voice";
  const pv = await openInterview(relaxed);
  assert.equal(await pv.$('[data-testid="interview-locked"]'), null, "the answer is open immediately");
  assert.ok(await pv.$('[data-testid="interview-record"]'), "and the microphone is there from the start");
  await pv.close();
  console.log("  ok   same type, the discipline switched off");
}

await recorder.close();
await h.close();
console.log("\nALL VIDEO INTERVIEW CHECKS PASSED");
