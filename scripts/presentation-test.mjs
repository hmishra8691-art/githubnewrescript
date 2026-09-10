/**
 * PRESENTATION MODES — conversational and voice — over an unchanged survey.
 *
 *   Studio: Branding → AI Conversational Survey: behaviour, interaction, dialect
 *       ↓
 *   Runtime, conversational: one question at a time within each page, the
 *   earlier ones above as a transcript; validation per question; Back walks
 *   the transcript; the page still turns where it always did
 *       ↓
 *   Runtime, voice: each question spoken as it appears (mocked speech
 *   synthesis) — the question, then each option as its own utterance — with
 *   mute / replay; the voice console takes dictation and spoken answers
 *
 * The legacy settings (`layout.presentation`, `layout.voice`) are still what
 * this suite writes; the runtime reads them through the unified AI
 * Conversational Survey engine (`effectiveAiConversation`), so a survey saved
 * with them behaves as it always did — see ai-conversation-test for the new
 * `branding.aiConversation` object.
 *
 * The point under test is that the SURVEY is the same: same pages, same
 * display logic, same answers, same step index — only the presentation
 * differs. A "conversational survey" or a "voice survey" is a layout setting,
 * not a question type.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

const survey = (layout) => ({
  meta: { id: "sandbox", code: "PRES", title: "Presentation", version: "1.0" },
  branding: { layout },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How was your visit?", required: true,
      options: [{ code: 1, label: "Great" }, { code: 2, label: "Fine" }, { code: 3, label: "Poor" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "Why do you say {{Q1}}?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many times have you visited?",
      displayLogic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "ne", value: 3 } },
    { id: "q4", code: "Q4", variableName: "Q4", type: "single_select", text: "Would you come back?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
    { type: "page", id: "p2", questionIds: ["q4"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

console.log("\nSTUDIO — presentation and voice are ONE branding setting (AI Conversational Survey); the older layout fields follow it");
await h.loadDef(survey({}));
await h.goTab("Branding");
await h.page.waitForSelector('[data-testid="presentation-mode"]');
await h.page.selectOption('[data-testid="presentation-mode"]', "conversational");
await h.page.selectOption('[data-testid="ai-interaction"]', "text_voice");
await h.page.click('[data-testid="ai-advanced"]');
await h.page.waitForSelector('[data-testid="voice-lang"]');
await h.page.fill('[data-testid="voice-lang"]', "en-GB");
await h.page.waitForTimeout(300);
let def = await h.readDef();
assert.equal(def.branding.aiConversation.enabled, true);
assert.equal(def.branding.aiConversation.conversation, "conversational");
assert.equal(def.branding.aiConversation.interaction, "text_voice");
assert.equal(def.branding.aiConversation.voice.locale.dialect, "en-GB");
assert.equal(def.branding.layout.presentation, "conversational", "the older field mirrors the new object");
assert.deepEqual(def.branding.layout.voice, { readAloud: true, dictation: true, lang: "en-GB" }, "…and so does layout.voice");
assert.equal(def.questions.length, 4, "no question was added or changed");
assert.equal(def.flow.length, 3, "the flow is the flow");
console.log("  ok   branding.aiConversation { conversational, text + voice, en-GB }; layout.presentation / layout.voice mirrored; questions and flow untouched");

/* a preview page with speech synthesis mocked: every utterance is recorded */
const openVoicePreview = async (definition) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await pv.addInitScript(() => {
    window.__spoken = [];
    const synth = {
      speaking: false,
      cancel() { window.__spoken.push({ cancel: true }); synth.speaking = false; },
      speak(u) { window.__spoken.push({ text: u.text, lang: u.lang }); synth.speaking = true; setTimeout(() => { synth.speaking = false; u.onend?.({}); }, 20); },
      getVoices() { return []; },
      addEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ""; this.rate = 1; };
    // a recogniser that exists (so the dictation control renders) and does nothing — dictation itself is speech-input-test's job
    window.SpeechRecognition = function () { this.start = () => {}; this.stop = () => {}; this.abort = () => {}; };
    delete window.webkitSpeechRecognition;
  });
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition }, { selector: "[data-qid]" });
  return pv;
};
const spoken = (pv) => pv.evaluate(() => window.__spoken.filter((s) => !s.cancel));
const waitSpoken = (pv, re) => pv.waitForFunction((src) => window.__spoken.some((s) => !s.cancel && new RegExp(src).test(s.text)), re.source, { timeout: 10000 });
const idle = (pv) => pv.waitForFunction(() => document.querySelector('[data-testid="rs-voice-bar"]')?.getAttribute("data-speaking") === "0", null, { timeout: 15000 });
/** utterances joined into one line per question, so "text, then options" can be asserted whatever the pauses */
const script = (said) => said.map((s) => s.text).join(" | ");
const qids = (pv) => pv.$$eval("#rs-questions [data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")));
const stepIndex = (pv) => pv.evaluate(() => window.__rescriptState.stepIndex);

console.log("\nRUNTIME — conversational: one question at a time, validated one at a time, page turns where it always did");
let pv = await openVoicePreview(def);
assert.deepEqual(await qids(pv), ["q1"], "only the first question of page 1 is on screen");
assert.equal(await stepIndex(pv), 0);
assert.ok(!(await pv.$('[data-testid="rs-back"]')), "nothing to go back to yet");
await waitSpoken(pv, /^Poor$/); // the question and its options have been read before we act
// required Q1: Next refuses, on THIS question
await h.next(pv);
await pv.waitForTimeout(150);
assert.deepEqual(await qids(pv), ["q1"], "still Q1");
assert.match(await pv.evaluate(() => document.body.innerText), /required/i);
await pv.click('[data-qid="q1"] input[value="1"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
assert.deepEqual(await qids(pv), ["q2"], "Q2 alone");
assert.equal(await stepIndex(pv), 0, "SAME page — the flow has not moved");
// the transcript above shows Q1 and its answer label
const turns = await pv.$$eval('[data-testid="rs-convo-turn"]', (els) => els.map((e) => ({ qid: e.getAttribute("data-qid"), q: e.querySelector(".rs-bubble-q").textContent, a: e.querySelector(".rs-bubble-a").textContent })));
assert.deepEqual(turns, [{ qid: "q1", q: "How was your visit?", a: "Great" }]);
assert.match(await pv.textContent('[data-qid="q2"]'), /Why do you say Great\?/, "piping into the current question works as ever");
// dictation was switched on survey-wide: Q2 has the microphone control although its own settings never asked for it
assert.ok(await pv.$('[data-testid="rs-voice-mic"]'), "dictation via voice.dictation: the voice console's microphone");
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-lang"), "en-GB", "…in the voice language");
await pv.fill('[data-qid="q2"] textarea', "Friendly staff.");
await h.next(pv);
await pv.waitForSelector('[data-qid="q3"]');
assert.deepEqual(await qids(pv), ["q3"], "Q3 shown: its display logic (Q1 ≠ Poor) holds");
assert.equal((await pv.$$('[data-testid="rs-convo-turn"]')).length, 2);
// Back walks within the page
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await stepIndex(pv), 0);
assert.equal(await pv.inputValue('[data-qid="q2"] textarea'), "Friendly staff.", "the answer is still there");
assert.equal((await pv.$$('[data-testid="rs-convo-turn"]')).length, 1, "transcript shrank with it");
await h.next(pv);
await pv.waitForSelector('[data-qid="q3"]');
await pv.fill('[data-qid="q3"] input', "4");
await h.next(pv);
await pv.waitForSelector('[data-qid="q4"]');
assert.equal(await stepIndex(pv), 1, "NOW the page turned — Q3 was the last visible question of page 1");
const turns2 = await pv.$$eval('[data-testid="rs-convo-turn"]', (els) => els.map((e) => e.getAttribute("data-qid")));
assert.deepEqual(turns2, ["q1", "q2", "q3"], "the transcript spans pages");
// Back from page 2 lands on page 1's LAST question, not its first
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-qid="q3"]');
assert.equal(await stepIndex(pv), 0);
assert.deepEqual(await qids(pv), ["q3"]);
console.log("  ok   Q1 → Q2 → Q3 → page 2 → back to Q3; validation per question; step index 0 until the page's last question");

console.log("\nRUNTIME — conversational: display logic still hides; changing Q1 to Poor removes Q3 from the walk");
await pv.click('[data-testid="rs-back"]');
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-qid="q1"]');
await pv.click('[data-qid="q1"] input[value="3"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="q4"]');
assert.equal(await stepIndex(pv), 1, "Q3 hidden → Q2 was the page's last question → page turned");
const turns3 = await pv.$$eval('[data-testid="rs-convo-turn"]', (els) => els.map((e) => e.getAttribute("data-qid")));
assert.deepEqual(turns3, ["q1", "q2"], "no Q3 in the transcript either");
console.log("  ok   hidden questions are simply not walked");

console.log("\nRUNTIME — voice: each question is spoken as it appears, in the configured language; mute and replay");
await waitSpoken(pv, /^No$/);
await idle(pv);
let said = await spoken(pv);
const first = said.find((s) => /How was your visit/.test(s.text));
assert.ok(first, "Q1 was read aloud");
assert.equal(first.lang, "en-GB");
assert.match(script(said), /How was your visit\? \| Great \| Fine \| Poor/, "text, then each option as its own utterance");
assert.ok(said.some((s) => /Why do you say Poor\?/.test(s.text)), "Q2 spoken with its piping RESOLVED — what is heard is what is shown");
assert.match(script(said), /Would you come back\? \| Yes \| No/, "Q4 on page 2 spoken on arrival");
const before = said.length;
await pv.click('[data-testid="rs-voice-replay"]');
await pv.waitForTimeout(100);
await idle(pv);
said = await spoken(pv);
if (said.length !== before + 3) console.log("DEBUG", JSON.stringify(await pv.evaluate(() => window.__spoken.slice(-12))), await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-speaking"));
assert.equal(said.length, before + 3, "replay speaks the current question again (question + 2 options)");
assert.match(said[before].text, /Would you come back/);
await pv.click('[data-testid="rs-voice-mute"]');
assert.equal(await pv.getAttribute('[data-testid="rs-voice-bar"]', "data-muted"), "1");
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-qid="q2"]');
await pv.waitForTimeout(150);
assert.equal((await spoken(pv)).length, before + 3, "muted: navigating speaks nothing");
console.log("  ok   spoken text = shown text with options; lang en-GB; replay; mute silences navigation");
await pv.close();

console.log("\nRUNTIME — pages mode with voice: the whole page is read in order; nothing else changes");
const pagesVoice = survey({ presentation: "pages", voice: { readAloud: true, dictation: false, lang: "en-US" } });
pv = await openVoicePreview(pagesVoice);
assert.deepEqual(await qids(pv), ["q1", "q2", "q3"], "pages mode: the page's visible questions together (Q1 ≠ Poor holds while Q1 is unanswered)");
await waitSpoken(pv, /How many times have you visited/);
await idle(pv);
said = await spoken(pv);
assert.match(script(said), /^How was your visit\? \| Great \| Fine \| Poor \| Why do you say \? \| How many times have you visited\?$/, "questions in page order, one reading");
assert.equal(said[0].lang, "en-US");
assert.ok(!(await pv.$('[data-testid="rs-voice-mic"]')), "dictation off → no microphone");
assert.ok(!(await pv.$('[data-testid="rs-convo-transcript"]')), "no transcript in pages mode");
await pv.close();

console.log("\nRUNTIME — the default is exactly what every survey did before: no bar, no transcript, no microphone");
pv = await openVoicePreview(survey({}));
assert.deepEqual(await qids(pv), ["q1", "q2", "q3"]);
assert.ok(!(await pv.$('[data-testid="rs-voice-bar"]')));
assert.ok(!(await pv.$('[data-testid="rs-convo-transcript"]')));
assert.equal((await spoken(pv)).length, 0, "nothing spoken");
await pv.close();
console.log("  ok   unchanged default");

await h.close();
console.log("\nALL PRESENTATION CHECKS PASSED");
