/**
 * SPEECH INPUT — dictation into a text answer (the `speech_input` capability).
 *
 * What is proven: the toggle appears only where the capability is declared
 * (text types and their presets — not a numeric); the runtime shows a mic only
 * when the browser can recognise speech; a transcript APPENDS to typed text
 * through the field's own onChange, so the stored answer is a plain string
 * every validator and export already understands; interim results show live;
 * a refused microphone yields a reason, not a dead button; and a browser
 * without the API renders no control at all.
 *
 * Headless Chromium has no real recogniser, so one is installed with
 * `addInitScript` — deterministic, and it means the test exercises the
 * control's contract with the API rather than the API itself.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

/* a fake recogniser the test drives from outside via window.__speech */
const FAKE = `
  class FakeRecognition {
    constructor(){ this.lang=""; this.continuous=false; this.interimResults=false;
      this.onresult=null; this.onerror=null; this.onend=null; window.__speech = this; window.__speechStarts=(window.__speechStarts||0)+1; }
    start(){ this.started = true; }
    stop(){ this.started = false; this.onend && this.onend(); }
    abort(){ this.started = false; }
    /* helpers the test calls */
    say(text, isFinal){ const r=[Object.assign([{transcript:text}],{isFinal})]; this.onresult && this.onresult({ resultIndex:0, results:r }); }
    fail(code){ this.onerror && this.onerror({ error: code }); }
  }
  window.SpeechRecognition = FakeRecognition;
`;

console.log("\nSTUDIO — the toggle is offered where the capability is declared, and only there");
const text = await h.createFromPicker("text", "text.single_line");
const email = await h.createFromPicker("text", "text.email");
const num = await h.createFromPicker("numeric", "numeric.open");
await h.goTab("Questions");
const openQ = async (id) => {
  await h.goTab("Questions");
  const card = await h.page.waitForSelector(`[data-testid="qcard"][data-qid="${id}"]`);
  // clicking an already-selected card CLOSES it — only click to open
  if (!/\bselected\b/.test(await card.getAttribute("class"))) await card.click();
  await h.page.waitForTimeout(250);
  const head = '[data-testid="psec-head-state"]';
  if (await h.page.$(head) && (await h.page.getAttribute(head, "aria-expanded")) !== "true") await h.page.click(head);
  await h.page.waitForTimeout(150);
};
await openQ(text.id);
assert.ok(await h.page.$('[data-testid="speech-input-toggle"]'), "Single-Line Text offers dictation");
await openQ(email.id);
assert.ok(await h.page.$('[data-testid="speech-input-toggle"]'), "Email — a PRESET — inherits its parent's capability");
await openQ(num.id);
assert.ok(!(await h.page.$('[data-testid="speech-input-toggle"]')), "a numeric question does not");
console.log("  ok   toggle on text and its presets, absent on numeric");

console.log("\nSTUDIO — switching it on stores a plain setting, and the language field appears");
await openQ(text.id);
await h.page.click('[data-testid="speech-input-toggle"]');
await h.page.waitForSelector('[data-testid="speech-lang"]');
await h.page.fill('[data-testid="speech-lang"]', "hi-IN");
await h.page.waitForTimeout(300);
let def = await h.readDef();
let q = def.questions.find((x) => x.id === text.id);
assert.equal(q.settings.speechInput, true);
assert.equal(q.settings.speechLang, "hi-IN");
console.log("  ok   settings.speechInput = true, speechLang = hi-IN");

console.log("\nRUNTIME — a browser with speech recognition shows the mic; transcripts append through onChange");
def.flow = [{ type: "page", id: "p1", questionIds: [text.id, num.id] }, { type: "end", id: "e1", status: "complete" }];
const pv = await h.browser.newPage({ viewport: { width: 900, height: 900 } });
await pv.addInitScript(FAKE);
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(pv, { definition: def });
const field = `[data-qid="${text.id}"] input.rs-input`;
assert.ok(await pv.$(`[data-qid="${text.id}"] [data-testid="speech-toggle"]`), "mic button rendered on the text question");
assert.ok(!(await pv.$(`[data-qid="${num.id}"] [data-testid="speech-toggle"]`)), "…and not on the numeric one");

const toggle = `[data-qid="${text.id}"] [data-testid="speech-toggle"]`;
const startDictation = async () => { await pv.click(toggle); await pv.waitForSelector(`${toggle}[aria-pressed="true"]`); };
const stopDictation = async () => { await pv.click(toggle); await pv.waitForSelector(`${toggle}[aria-pressed="false"]`); };
await pv.fill(field, "I liked the");
await startDictation();
await pv.waitForSelector('[data-testid="speech-interim"]');
assert.equal(await pv.evaluate(() => window.__speech.lang), "hi-IN", "the recogniser is told the configured language");
assert.equal(await pv.evaluate(() => window.__speech.continuous && window.__speech.interimResults), true);

await pv.evaluate(() => window.__speech.say("packaging but", false));
assert.match(await pv.textContent('[data-testid="speech-interim"]'), /packaging but/, "interim result shown live");
assert.equal(await pv.inputValue(field), "I liked the", "…without touching the stored value yet");

await pv.evaluate(() => window.__speech.say("packaging but not the price", true));
assert.equal(await pv.inputValue(field), "I liked the packaging but not the price", "final transcript APPENDED to what was typed");
await stopDictation();
assert.ok(!(await pv.$('[data-testid="speech-interim"]')), "stopped: no live indicator");
const stored = await h.answerOf(pv, text.id);
assert.equal(stored, "I liked the packaging but not the price", "the STORED answer is the plain string — nothing knows it was spoken");
console.log("  ok   append semantics, live interim, plain string stored");

console.log("\nRUNTIME — the field stays editable, and a second dictation appends again");
await pv.fill(field, "I liked the packaging.");
await startDictation();
await pv.evaluate(() => window.__speech.say("Delivery was slow.", true));
assert.equal(await pv.inputValue(field), "I liked the packaging. Delivery was slow.");
await stopDictation();
console.log("  ok   edit, dictate again, appended");

console.log("\nRUNTIME — a refused microphone gives a reason instead of a dead button");
await startDictation();
await pv.evaluate(() => window.__speech.fail("not-allowed"));
await pv.waitForSelector('[data-testid="speech-reason"]');
assert.match(await pv.textContent('[data-testid="speech-reason"]'), /Microphone access was refused/);
assert.equal(await pv.getAttribute(`[data-qid="${text.id}"] [data-testid="speech-toggle"]`, "aria-pressed"), "false", "listening state cleared");
console.log("  ok   not-allowed → readable reason, button reset");
await pv.close();

console.log("\nRUNTIME — a browser WITHOUT speech recognition shows no control at all");
/*
 * Headless Chromium DOES ship `webkitSpeechRecognition` (the constructor exists
 * even where no service backs it), so "no API" has to be made true explicitly.
 * The first version of this test assumed a fresh page had no recogniser, saw a
 * button, and — handing the ElementHandle to assert.equal — was killed by the
 * cgroup while Node tried to print it. Both mistakes are recorded in
 * platform-status.md; this is the second time the second one bit.
 */
const pv2 = await h.browser.newPage({ viewport: { width: 900, height: 900 } });
await pv2.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
await pv2.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(pv2, { definition: def }, { selector: `[data-qid="${text.id}"]` });
assert.ok(!(await pv2.$('[data-testid="speech-toggle"]')), "no API, no button — never a button that fails");
assert.ok(await pv2.$(field), "the text field itself is untouched");
await pv2.close();
console.log("  ok   graceful absence");

await h.close();
console.log("\nALL SPEECH INPUT CHECKS PASSED");
