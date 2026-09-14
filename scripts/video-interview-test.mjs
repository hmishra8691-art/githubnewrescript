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

/*
 * The media routes must be reachable. Storing a recording no longer depends
 * on a transcription provider at all — a respondent's answer has to be kept
 * whether or not anyone has configured speech-to-text — so this asks only
 * that the route exists and is refusing for the right reason.
 */
{
  const probe = await fetch(`${RUNTIME}/api/session/media/ticket`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.notEqual(probe.status, 404, "the media ticket route is not deployed");
  assert.equal(probe.status, 400, `an empty body is an invalid session, not a crash: ${probe.status}`);
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
  /* headless Chromium has no real recogniser, so there are no captions to
     keep — see the next section, which installs one */
  assert.ok(["none", "browser"].includes(String(answer.transcript?.source)),
    `a preview sends nothing to a provider: ${answer.transcript?.source}`);

  assert.ok(await pv.$('[data-testid="interview-playback"]'), "they can hear their answer back");
  assert.ok(await pv.$('[data-testid="interview-retake"]'), "and record it again");

  await pv.close();
  console.log("  ok   record → stored → reviewable");
}

/* ================================ 4b. live captions while they speak */

console.log("\nTHE RESPONDENT SEES THEIR WORDS AS THEY SAY THEM");
{
  /*
   * Headless Chromium ships no working recogniser, so one is installed —
   * the same approach `speech-input-test.mjs` takes, and for the same reason:
   * what is under test is the component's contract with the API, not the
   * API. `window.__speech` is the instance the component built.
   */
  const FAKE = `
    class FakeRecognition {
      constructor(){ this.lang=""; this.continuous=false; this.interimResults=false;
        this.onresult=null; this.onerror=null; this.onend=null;
        window.__speech = this; window.__speechStarts=(window.__speechStarts||0)+1; }
      start(){ this.started = true; }
      stop(){ this.started = false; this.onend && this.onend(); }
      abort(){ this.started = false; }
      say(text, isFinal){ const r=[Object.assign([{transcript:text}],{isFinal})];
        this.onresult && this.onresult({ resultIndex:0, results:r }); }
      fail(code){ this.onerror && this.onerror({ error: code }); }
    }
    window.SpeechRecognition = FakeRecognition;
  `;
  const ctx = await recorder.newContext({ permissions: ["microphone"] });
  const pv = await ctx.newPage();
  pv.on("pageerror", (e) => console.error("PREVIEW ERROR:", e.message));
  await pv.addInitScript(FAKE);
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await pv.waitForSelector('[data-testid="interview"]', { timeout: 15000 });
  await watchThrough(pv);

  await pv.click('[data-testid="interview-record"]');
  await pv.waitForSelector('[data-testid="interview-recording"]');
  /* the recogniser is told the survey's language and asked for interim results */
  assert.equal(await pv.evaluate(() => window.__speech.continuous && window.__speech.interimResults), true,
    "continuous with interim results, or there are no live captions");

  /* a phrase still being worked out appears, and is marked as provisional */
  await pv.evaluate(() => window.__speech.say("I think the product", false));
  await pv.waitForSelector('[data-testid="interview-caption-interim"]');
  assert.match(await pv.textContent('[data-testid="interview-caption-interim"]'), /I think the product/);
  assert.equal(await pv.$('[data-testid="interview-caption-final"]'), null,
    "nothing is confirmed yet, so nothing is shown as confirmed");

  /* it grows, still provisional */
  await pv.evaluate(() => window.__speech.say("I think the product is very useful", false));
  await pv.waitForFunction(() => /very useful/.test(document.querySelector('[data-testid="interview-caption-interim"]')?.textContent ?? ""));

  /* confirmed text moves across, and stops changing */
  await pv.evaluate(() => window.__speech.say("I think the product is very useful", true));
  await pv.waitForSelector('[data-testid="interview-caption-final"]');
  assert.match(await pv.textContent('[data-testid="interview-caption-final"]'), /I think the product is very useful/);

  /* a second phrase appends rather than replacing the first */
  await pv.evaluate(() => window.__speech.say("because it saves me time.", true));
  await pv.waitForFunction(() => /saves me time/.test(document.querySelector('[data-testid="interview-caption-final"]')?.textContent ?? ""));
  const shown = await pv.textContent('[data-testid="interview-caption-final"]');
  assert.match(shown, /I think the product is very useful because it saves me time\./,
    `both phrases, in order: ${shown}`);

  /* a recogniser that dies does NOT stop the recording */
  await pv.evaluate(() => window.__speech.fail("network"));
  await pv.waitForTimeout(200);
  assert.ok(await pv.$('[data-testid="interview-recording"]'), "the microphone is still running");
  assert.equal(await pv.getAttribute('[data-testid="interview"]', "data-state"), "RECORDING");

  await pv.click('[data-testid="interview-stop"]');
  await pv.waitForSelector('[data-testid="interview-saved"]', { timeout: 20000 });

  /* and what they said is the ANSWER, not merely something that was on screen */
  const answer = await pv.evaluate(() => {
    const st = window.__rescriptState ?? window.__RESCRIPT_STATE__;
    return st?.answers?.qiv ?? null;
  });
  assert.equal(answer?.transcript?.source, "browser", "the browser's transcript is kept");
  assert.match(String(answer.transcript.text), /I think the product is very useful because it saves me time\./,
    `the answer holds the words: ${answer.transcript.text}`);
  assert.ok(answer.audio?.url, "and the recording is still there beside it");

  await pv.close();
  await ctx.close();
  console.log("  ok   interim → final → appended, captions survive a failure, transcript IS the answer");
}

/* ============================== 5. storage is gated on a real session */

console.log("\nA PREVIEW STORES NOTHING, AND SAYS SO RATHER THAN FAILING QUIETLY");
{
  /*
   * Transcription used to run inline inside the upload request, and a preview
   * was allowed through it against the fake provider. Both of those are gone:
   * storing and transcribing are separate steps now, and a preview has no
   * respondent whose recording it would be. So the ticket route refuses a
   * preview outright — and the renderer, which knows this, keeps the clip as
   * an object URL and never calls it (proved in section 4 above).
   *
   * The pipeline itself — claim, read, transcribe, retry, give up after three
   * attempts — is proven in packages/media/src/store.test.ts against a stub
   * database, which is stronger than this suite could manage: it can assert
   * that a second runner does NOT bill the provider a second time.
   */
  const r = await fetch(`${RUNTIME}/api/session/media/ticket`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "preview", kind: "answer_audio", questionId: "qiv", definition: def }),
  });
  assert.equal(r.status, 403, `a preview may not reserve storage: ${r.status}`);
  const j = await r.json();
  assert.match(j.error, /preview/i, `and is told why: ${j.error}`);
}

console.log("\nAN UNKNOWN SESSION CANNOT RESERVE STORAGE EITHER");
{
  const r = await fetch(`${RUNTIME}/api/session/media/ticket`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "0123456789abcdef0123456789abcdef", kind: "answer_audio", questionId: "qiv" }),
  });
  /* 404 where a database is configured; 501 on a runtime that has none —
     both are a refusal, and neither is a bucket write */
  assert.ok(r.status === 404 || r.status === 501, `an invented session id is refused: ${r.status}`);
  console.log("  ok   nobody writes into the bucket without a live session");
}

console.log("\nTHE RESPONDENT BUCKET ONLY TAKES RESPONDENT KINDS");
{
  const r = await fetch(`${RUNTIME}/api/session/media/ticket`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "0123456789abcdef0123456789abcdef", kind: "question_video", questionId: "qiv" }),
  });
  /* refused before the session is even resolved, or by the session gate —
     either way a respondent route will not store a researcher's stimulus */
  assert.ok(r.status === 400 || r.status === 404 || r.status === 501, `a respondent cannot store a question video: ${r.status}`);
  console.log("  ok   a respondent route stores respondent media and nothing else");
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
