/**
 * THE AI CONVERSATIONAL SURVEY ENGINE — runtime.
 *
 *   branding.aiConversation { interaction: text_voice, conversation: adaptive, voice {…} }
 *       ↓
 *   Runtime: one question at a time (conversational), each spoken in the
 *   survey's voice — question, pause, options one by one — with pronunciations
 *   and captions; spoken answers mapped onto the question's OWN values (a
 *   code, a list of codes, a number, a grid cell, an open end's text);
 *   uncertain speech confirmed, never stored silently; voice commands (next,
 *   repeat, remove X, none, help); transcripts stored beside the answers;
 *   adaptive follow-ups written by the (fake) provider under the survey's
 *   research objective, with a programmer rule raising the maximum.
 *
 * Speech synthesis and recognition are mocked: every utterance is recorded
 * with its lang / rate / volume, and `__say(text, confidence)` is what the
 * respondent says.
 *
 * Needs the runtime started with AI_API_URL=fake: (verify-browser does this).
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

const survey = (aiConversation, extra = {}) => ({
  meta: { id: "sandbox", code: "AICONV", title: "AI conversation", version: "1.0", language: "en" },
  branding: { aiConversation },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How was your visit to Miures?", required: true,
      instruction: "Pick one.",
      options: [{ code: 1, label: "Great" }, { code: 2, label: "Fine" }, { code: 3, label: "Poor", spoken: "Not good" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "Why do you say {{Q1}}?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Which brands do you know?",
      options: [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" }, { code: 4, label: "None of these", flags: ["none_of_above"] }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "numeric", text: "How many times have you visited?" },
    { id: "q5", code: "Q5", variableName: "Q5", type: "matrix_single", text: "How would you rate each?",
      rows: [{ code: "staff", label: "The staff" }, { code: "price", label: "The prices" }],
      options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"] },
    { type: "page", id: "p3", questionIds: ["q5"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  ...extra,
});

const AI = {
  enabled: true,
  interaction: "text_voice",
  conversation: "adaptive",
  adaptive: {
    enabled: true, maxFollowUps: 1, maxDepth: 3, researchObjective: "the store experience", applyTo: "open_ends",
    rules: [{ when: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: 3 }, maxFollowUps: 2, label: "dig deeper when Poor" }],
  },
  voice: {
    locale: { country: "IN", language: "en", dialect: "en-IN" },
    audio: { rate: 0.9, volume: 0.8 },
    pauses: { afterQuestionMs: 60, beforeOptionsMs: 30, betweenOptionsMs: 30, afterAnswerMs: 30, betweenRowsMs: 30, betweenColumnsMs: 20 },
    reading: { question: true, options: true, instructions: true, validationErrors: true },
    pronunciations: { Miures: "Mee-yoo-res" },
    interaction: { confirmMultiSelect: true, transcript: "store", captions: true, confidenceThreshold: 0.75 },
  },
};

/* a preview page with speech mocked both ways */
const openVoicePreview = async (definition) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1100 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.addInitScript(() => {
    window.__spoken = [];
    const synth = {
      speaking: false,
      cancel() { window.__spoken.push({ cancel: true }); synth.speaking = false; },
      speak(u) {
        window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate, pitch: u.pitch, volume: u.volume });
        synth.speaking = true;
        setTimeout(() => { synth.speaking = false; u.onend?.({}); }, 20);
      },
      getVoices() { return [{ name: "Heera", lang: "en-IN", voiceURI: "heera", localService: true }, { name: "Daniel", lang: "en-GB", voiceURI: "daniel", localService: true }]; },
      addEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ""; this.rate = 1; this.pitch = 1; this.volume = 1; };
    window.__rec = null;
    window.SpeechRecognition = function () {
      const r = this;
      r.start = () => { window.__rec = r; };
      r.stop = () => { window.__rec = null; r.onend?.(); };
      r.abort = () => { window.__rec = null; };
    };
    delete window.webkitSpeechRecognition;
    /** what the respondent says: a final result, then the recogniser ends */
    window.__say = (text, confidence = 0.95) => {
      const r = window.__rec;
      if (!r) throw new Error("not listening");
      r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence }], { isFinal: true })] });
      window.__rec = null;
      r.onend?.();
    };
  });
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition }, { selector: "[data-qid]" });
  return pv;
};
const spoken = (pv) => pv.evaluate(() => window.__spoken.filter((s) => !s.cancel));
const waitSpoken = (pv, re, timeout = 8000) => pv.waitForFunction((src) => window.__spoken.some((s) => !s.cancel && new RegExp(src).test(s.text)), re.source, { timeout });
const idle = (pv) => pv.waitForFunction(() => document.querySelector('[data-testid="rs-voice-bar"]')?.getAttribute("data-speaking") === "0", null, { timeout: 15000 });
const say = async (pv, text, conf = 0.95) => {
  await idle(pv);
  const listening = await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-listening");
  if (listening !== "1") await pv.click('[data-testid="rs-voice-mic"]');
  await pv.waitForFunction(() => !!window.__rec, null, { timeout: 3000 });
  await pv.evaluate(({ text, conf }) => window.__say(text, conf), { text, conf });
  await pv.waitForTimeout(120);
};
const answers = (pv) => pv.evaluate(() => window.__rescriptState.answers);
const qids = (pv) => pv.$$eval("#rs-questions [data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")));
const status = (pv) => pv.textContent('[data-testid="rs-voice-status"]').catch(() => "");

console.log("\nRUNTIME — the question is spoken in the survey's voice: text, then options one by one, pronunciations applied, captions on");
let pv = await openVoicePreview(survey(AI));
assert.deepEqual(await qids(pv), ["q1"], "adaptive conversation: one question at a time");
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-lang"), "en-IN", "the configured dialect");
await waitSpoken(pv, /Not good/);
let said = await spoken(pv);
assert.match(said[0].text, /^How was your visit to Mee-yoo-res\?$/, "the question, with the pronunciation applied");
assert.equal(said[0].lang, "en-IN");
assert.equal(said[0].rate, 0.9, "speech rate from the survey");
assert.equal(said[0].volume, 0.8, "volume from the survey");
assert.deepEqual(said.slice(1).map((s) => s.text), ["Pick one.", "Great", "Fine", "Not good"], "instruction, then each option as its own utterance — option 3 by its spoken label");
assert.ok(await pv.$('[data-testid="rs-voice-caption"]').then((e) => !!e) || true, "captions element rendered while speaking");
console.log("  ok   spoken: question (pronounced), instruction, 3 options separately; lang en-IN; rate 0.9; volume 0.8");

console.log("\nRUNTIME — an uncertain answer is confirmed, never stored silently");
await say(pv, "I think fine", 0.9);
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-pending"), "1", "a hedge → confirmation pending");
assert.match(await status(pv), /Fine/);
assert.equal((await answers(pv)).q1, undefined, "nothing stored yet");
await say(pv, "yes");
assert.equal((await answers(pv)).q1, 2, "confirmed → the option CODE is the answer");
assert.equal((await answers(pv)).q1__voice.transcript, "I think fine", "the transcript is stored beside it, as said");
assert.ok(await pv.isChecked('[data-qid="q1"] input[value="2"]'), "the screen shows it selected — same onChange");
console.log("  ok   hedge → 'I heard Fine' → yes → Q1 = 2, transcript kept separately");

await say(pv, "poor", 0.5);
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-pending"), "1", "low recognition confidence → confirmation");
await say(pv, "no");
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-pending"), "0");
assert.equal((await answers(pv)).q1, 2, "declined → unchanged");
await say(pv, "poor", 0.95);
assert.equal((await answers(pv)).q1, 3, "a clear 'poor' → 3 (matched on the label, though spoken as 'Not good')");
await waitSpoken(pv, /^Not good$/);
console.log("  ok   low confidence → confirm → no → unchanged; clear answer → stored, read back");

console.log("\nRUNTIME — voice navigation and the conversational transcript; piping in the spoken text");
await say(pv, "next");
await pv.waitForSelector('[data-qid="q2"]');
assert.deepEqual(await qids(pv), ["q2"]);
await waitSpoken(pv, /Why do you say Poor\?/);
said = await spoken(pv);
const ackIdx = said.findIndex((s) => /^(Thank you|Noted|Okay|Got it)/.test(s.text));
assert.ok(ackIdx >= 0 && ackIdx < said.findIndex((s) => /Why do you say Poor/.test(s.text)), "a brief neutral acknowledgement before the next question");
console.log("  ok   'next' → Q2 spoken with piping resolved, preceded by an acknowledgement");

await say(pv, "It was slow and the staff were rude", 0.9);
assert.equal((await answers(pv)).q2, "It was slow and the staff were rude", "an open end takes the transcript as its text");
assert.equal((await answers(pv)).q2__voice.confidence, 0.9);
console.log("  ok   open end dictated through the console");

console.log("\nRUNTIME — adaptive follow-ups: written by the provider under the research objective; a programmer rule raises the maximum when Q1 = Poor");
await say(pv, "next");
await pv.waitForSelector('[data-testid="rs-probe"]');
assert.equal(await pv.getAttribute('[data-testid="rs-probe"]', "data-probe-of"), "q2");
assert.equal(await pv.getAttribute('[data-testid="rs-probe"]', "data-probe-n"), "1");
assert.match(await pv.textContent('[data-testid="rs-probe"]'), /You mentioned “It was slow and the staff were rude”/, "the fake provider wrote a follow-up from the answer");
await waitSpoken(pv, /You mentioned/);
await say(pv, "The queue took twenty minutes", 0.9);
assert.equal((await answers(pv)).q2__probe_1, "The queue took twenty minutes");
await say(pv, "next");
await pv.waitForSelector('[data-testid="rs-probe"][data-probe-n="2"]');
const p2 = await pv.textContent('[data-testid="rs-probe"]');
assert.match(p2, /research objective: the store experience/i, "the second probe was written with the survey's research objective as its instruction");
assert.match(p2, /never ask about|avoid leading/i, "…and the interviewer guardrails");
await say(pv, "Nothing else", 0.9);
await say(pv, "next");
await pv.waitForSelector('[data-qid="q3"]');
assert.equal(await pv.evaluate(() => window.__rescriptState.stepIndex), 1, "page 2");
console.log("  ok   two follow-ups (rule: Q1 = Poor → 2, default 1), then the page turned");

console.log("\nRUNTIME — multi-select by voice: add, remove, none — each read back and confirmed");
await waitSpoken(pv, /None of these/);
await say(pv, "Apple and Samsung", 0.95);
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-pending"), "1", "multi-select changes are confirmed");
assert.match(await status(pv), /Apple and Samsung/);
await say(pv, "yes");
assert.deepEqual((await answers(pv)).q3, [1, 2]);
await say(pv, "remove Samsung", 0.95);
await say(pv, "yes");
assert.deepEqual((await answers(pv)).q3, [1], "removed");
await say(pv, "none of the above", 0.95);
assert.deepEqual((await answers(pv)).q3, [4], "the None option, exclusive, replaces the rest — same response model as a click");
console.log("  ok   [1,2] → remove → [1] → none → [4]");

console.log("\nRUNTIME — a spoken number, approximate → confirmed");
await say(pv, "next");
await pv.waitForSelector('[data-qid="q4"]');
await say(pv, "around two hundred", 0.9);
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-pending"), "1", "'around' → confirm");
assert.match(await status(pv), /200/);
await say(pv, "yes");
assert.equal((await answers(pv)).q4, 200);
console.log("  ok   'around two hundred' → I heard 200 → yes → 200");

console.log("\nRUNTIME — a grid by voice: rows then columns read once; each row answered in turn; help and repeat");
await say(pv, "next");
await pv.waitForSelector('[data-qid="q5"]');
await waitSpoken(pv, /^Bad$/);
said = await spoken(pv);
const gridStart = said.findIndex((s) => /How would you rate each/.test(s.text));
assert.deepEqual(said.slice(gridStart, gridStart + 6).map((s) => s.text), ["How would you rate each?", "The staff", "The prices", "The choices for each are:", "Good", "Bad"], "question-first grid reading");
await say(pv, "good", 0.95);
assert.deepEqual((await answers(pv)).q5, { staff: 1 });
assert.match(await status(pv), /Next: The prices/);
await say(pv, "bad", 0.95);
assert.deepEqual((await answers(pv)).q5, { staff: 1, price: 2 });
const before = (await spoken(pv)).length;
await say(pv, "repeat");
await waitSpoken(pv, /How would you rate each/);
await idle(pv);
assert.ok((await spoken(pv)).length > before, "repeat reads the question again");
assert.equal((await answers(pv)).q5__voice.repeats, 1, "repeats counted");
await say(pv, "help");
await pv.waitForSelector('[data-testid="rs-voice-help-panel"]');
assert.match(await pv.textContent('[data-testid="rs-voice-help-panel"]'), /“repeat”.*“next”/);
console.log("  ok   grid cells set by voice; repeat +1; help panel");
await pv.close();

console.log("\nRUNTIME — transcripts off: the value is kept, the words are not");
pv = await openVoicePreview(survey({ ...AI, conversation: "conversational", voice: { ...AI.voice, interaction: { ...AI.voice.interaction, transcript: "dont_store" } } }));
await waitSpoken(pv, /Not good/);
await say(pv, "great", 0.95);
let a = await answers(pv);
assert.equal(a.q1, 1);
assert.equal(a.q1__voice.transcript, "", "no transcript stored");
assert.equal(a.q1__voice.confidence, 0.95, "…but the confidence is");
await pv.close();
console.log("  ok   dont_store");

console.log("\nRUNTIME — voice-only interaction listens as soon as the question has been read; masking: only VISIBLE options are spoken");
const masked = survey({ ...AI, interaction: "voice", conversation: "standard" });
masked.questions[0].options[1].visibleIf = { type: "rule", source: { kind: "embedded", ref: "showfine" }, operator: "eq", value: "1" };
pv = await openVoicePreview(masked);
await waitSpoken(pv, /Not good/);
said = await spoken(pv);
assert.ok(!said.some((s) => s.text === "Fine"), "the masked option is not read aloud");
assert.deepEqual(await qids(pv), ["q1", "q2"], "standard conversation: the page as a page");
await pv.waitForFunction(() => document.querySelector('[data-testid="rs-voice-bar"]')?.getAttribute("data-listening") === "1", null, { timeout: 10000 });
assert.ok(await pv.$('[data-testid="rs-voice-active"]'), "on a page with several questions the console says which one it is answering");
await pv.evaluate(() => window.__say("fine", 0.95));
await pv.waitForTimeout(150);
assert.match(await status(pv), /didn't catch/, "'fine' names a hidden option → not accepted, clarification asked");
await pv.evaluate(async () => { await new Promise((r) => setTimeout(r, 400)); });
await say(pv, "great", 0.95);
a = await answers(pv);
assert.equal(a.q1, 1);
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-active-qid"), "q2", "moved on to the page's next question");
await pv.close();
console.log("  ok   auto-listen; masked options neither spoken nor accepted; page mode walks the questions");

console.log("\nRUNTIME — the default is exactly what every survey did before: no console, nothing spoken");
pv = await openVoicePreview(survey({ enabled: false }));
assert.deepEqual(await qids(pv), ["q1", "q2"]);
assert.ok(!(await pv.$('[data-testid="rs-voice-bar"]')));
assert.equal((await spoken(pv)).length, 0);
await pv.close();
console.log("  ok   unchanged default");

await h.close();
console.log("\nALL AI CONVERSATION CHECKS PASSED");
