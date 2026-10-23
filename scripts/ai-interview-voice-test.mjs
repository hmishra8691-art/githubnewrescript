/**
 * AI INTERVIEWS — VOICE CONVERSATION WITH BARGE-IN, AND THE PARTICIPANT PAGE IN EVERY LANGUAGE (G1 2026-10-22,
 * docs/AI-INTERVIEW-VOICE-I18N-2026-10-22.md).
 *
 * Chromium's fake media: the microphone plays a generated WAV (speech-like voiced bursts between silences)
 * — `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`.
 * Everything else is real: the page's voice-activity detection and barge-in, the runtime's routes, the
 * speech gate and the reply's sentences + audio in the NDJSON stream (fake text-to-speech), the fake
 * speech-to-text, the engine, the sandbox store, the Studio's AI interviews tab and its sandbox.
 *
 *   1  Studio: voice styles (hands-free on by default, realtime off and why), the Languages card — Translate
 *      now (the fake provider), review and edit one language's wording, launch with the wording
 *   2  a hands-free conversation: the opening is spoken sentence by sentence, the participant speaks over it
 *      (barge-in: playback stops, the interruption is recorded), utterances are sent at the end of the turn,
 *      the reply starts playing before the whole reply exists; the latency (end of speech → first audio) is
 *      measured and printed
 *   3  the live view: the voice chip (conversation · interruptions · latency), the interrupted moderator turn
 *   4  the scripted fallback in a THIRD language (Spanish): the page's labels in Spanish, the AI provider fails,
 *      the interview carries on with the guide's Spanish wording and the rules' Spanish words
 *   5  a language without built-in labels (Swahili): the page's labels from the study's translated wording,
 *      including the researcher's edit
 *   6  RTL: Urdu — the page is right-to-left (document and shell), the labels are Urdu, the moderator's bubble
 *      sits on the right and the participant's on the left
 *   7  no Web Audio (a phone browser without it): hands-free falls back to tap-to-talk and says why
 *   8  no page errors
 *
 *   Studio on :3000 and runtime on :3001, both with AI_API_URL=fake: and NO database (the sandbox store)
 *   node --experimental-strip-types --no-warnings scripts/ai-interview-voice-test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the servers are supervised: wait for them (a restart takes up to a minute) */
async function waitUp(url) {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* restarting */ } await sleep(3000); }
  throw new Error(`${url} is not answering`);
}
await waitUp(`${RUNTIME}/api/ai-interview/study?token=${"0".repeat(36)}`);
await waitUp(`${STUDIO}/sandbox?mode=studio`);

/* ------------------------------------------------------------ the microphone's audio: speech-like bursts between silences */
const WAV = (() => {
  const sr = 16000;
  const parts = [["silence", 3.4], ["speech", 1.9], ["silence", 4.2], ["speech", 1.6], ["silence", 4.5]];
  const total = Math.round(parts.reduce((a, [, s]) => a + s, 0) * sr);
  const pcm = new Int16Array(total);
  let i = 0, seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * sr);
    let phase = 0;
    for (let k = 0; k < n; k++, i++) {
      const t = k / sr;
      if (kind === "silence") { pcm[i] = Math.round(rnd() * 30); continue; }
      /* a voice: a gliding pitch (110–190 Hz) with harmonics, syllables (on 180 ms / off 70 ms), a breath of noise */
      const f0 = 150 + 40 * Math.sin(2 * Math.PI * 1.3 * t);
      phase += (2 * Math.PI * f0) / sr;
      const syl = (t % 0.25) < 0.18 ? Math.sin(Math.PI * ((t % 0.25) / 0.18)) : 0.05;
      const v = Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.35 * Math.sin(3 * phase) + 0.2 * Math.sin(5 * phase) + 0.05 * rnd();
      pcm[i] = Math.round(Math.max(-1, Math.min(1, 0.45 * syl * v / 1.6)) * 32767);
    }
  }
  const buf = Buffer.alloc(44 + total * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(total * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  const dir = join(tmpdir(), `rescript-g1-voice-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "speech.wav");
  writeFileSync(f, buf);
  return f;
})();

/* ------------------------------------------------------------ the study */
const EMPTY = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "AIV2", title: "Broadband switching", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const ACTIONS = [
  { op: "create_qual_guide", kind: "interview", title: "Why customers switch broadband", durationMinutes: 15,
    objectives: ["Understand what triggers switching"],
    consent: { statement: "Taking part is voluntary; you can stop at any time.", recordingDisclosure: "If you agree, your voice is recorded for the research team only." },
    sections: [
      { title: "Introduction", kind: "opening", minutes: 1, script: "Thank you for taking part. There are no right or wrong answers." },
      { title: "Switching triggers", minutes: 8, questions: ["Tell me about the last time you thought about changing your broadband provider.", "How did you feel about your provider at that point?", "When you compare providers, what do you look at first?"] },
      { title: "Close", kind: "closing", minutes: 2, questions: ["Is there anything else you would like to add?"] },
    ] },
  { op: "configure_ai_interviews", modes: ["text", "voice"], languages: ["en", "es", "ur", "sw"], defaultProbing: "none", persona: { name: "Maya", tone: "warm" } },
];
const c = coerceSurveyActions(ACTIONS);
assert.deepEqual(c.rejected, []);
const DEF = applySurveyActions(EMPTY, c.actions).def;
assert.ok(DEF.qualStudy?.aiModeration);

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"] });
const pageErrors = [];
let studio = null;
let sandboxKey = null;
/* a fresh Studio tab on the sandbox with the guide loaded — and, after a launch, the sandbox's study key
   (sessionStorage), so a tab that crashed (memory pressure) is replaced without losing the study */
async function newStudio() {
  studio = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  studio.on("pageerror", (e) => pageErrors.push(`studio: ${e}`));
  studio.on("dialog", (d) => d.accept());
  if (sandboxKey) await studio.addInitScript((k) => { try { sessionStorage.setItem("rescript.aiInterviews.sandboxKey", k); } catch { /* none */ } }, sandboxKey);
  await waitUp(`${STUDIO}/sandbox?mode=studio`);
  await studio.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await studio.waitForSelector(".block-badge");
  await switchMode(studio, "studio").catch(() => {});
  await goTab("JSON");
  await studio.waitForSelector("textarea.code");
  await studio.click('button:has-text("edit")');
  await studio.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(DEF));
  await studio.click('button:has-text("validate & apply")');
  await studio.waitForTimeout(1200);
}
const alive = async () => { try { return studio && !studio.isClosed() && (await studio.evaluate(() => 1)) === 1; } catch { return false; } };
const goTab = async (name) => { await openTab(studio, name); await studio.waitForTimeout(150); };
const openAi = async () => {
  if (!(await alive())) { console.log("  …   the Studio tab was gone (crashed): a fresh one, same sandbox study"); await studio?.context().close().catch(() => {}); await newStudio(); }
  await switchMode(studio, "studio").catch(() => {});
  /* the menubar can be slow to answer while the dev server compiles: try again before giving up */
  for (let i = 1; ; i++) { try { await goTab("Qualitative"); break; } catch (e) { if (i >= 4) throw e; if (!(await alive())) { await studio?.context().close().catch(() => {}); await newStudio(); } await studio.keyboard.press("Escape").catch(() => {}); await studio.waitForTimeout(3000); } }
  await studio.waitForSelector('[data-testid="qual-panel"]');
  await studio.click('[data-testid="qual-tab-ai"]');
  await studio.waitForSelector('[data-testid="ai-interviews"]');
};
await newStudio();

let link;
console.log("\n1 — Studio: voice styles, the Languages card (translate, review, edit), launch with the wording");
{
  await openAi();
  await studio.waitForSelector('[data-testid="ai-setup-voice-styles"]');
  assert.equal(await studio.isChecked('[data-testid="ai-setup-voice-conversation"]'), true, "hands-free is on by default");
  assert.equal(await studio.isChecked('[data-testid="ai-setup-voice-turn_based"]'), true);
  assert.equal(await studio.isDisabled('[data-testid="ai-setup-voice-realtime"]'), true, "realtime is off without a provider");
  assert.match(await studio.textContent('[data-testid="ai-setup-realtime-off"]'), /AI_REALTIME_API_URL|realtime/i);
  await studio.waitForSelector('[data-testid="ai-languages"]');
  const states = async () => studio.$$eval('[data-testid="ai-lang-row"]', (rs) => Object.fromEntries(rs.map((r) => [r.dataset.lang, r.dataset.state])));
  assert.deepEqual(await states(), { es: "none", ur: "none", sw: "none" });
  assert.match(await studio.textContent('[data-testid="ai-lang-row"][data-lang="sw"]'), /page labels translated/);
  assert.match(await studio.textContent('[data-testid="ai-lang-row"][data-lang="ur"]'), /page built in/);
  /* resilient to a Studio restart: translate again until every language is ready (a failed batch says so in the note) */
  for (let attempt = 1; ; attempt++) {
    await studio.click('[data-testid="ai-lang-translate-all"]');
    const ready = await studio.waitForFunction(() => [...document.querySelectorAll('[data-testid="ai-lang-row"]')].every((r) => r.getAttribute("data-state") === "ready"), null, { timeout: 60000 }).then(() => true, () => false);
    if (ready) break;
    console.log(`  …   translate attempt ${attempt}: ${await studio.textContent('[data-testid="ai-lang-note"]').catch(() => "(no note)")} ${JSON.stringify(await states())}`);
    if (attempt >= 4) throw new Error("the study languages were not translated");
    await waitUp(`${STUDIO}/sandbox?mode=studio`);
  }
  /* review Swahili: the researcher corrects the Start button and the first question */
  await studio.click('[data-testid="ai-lang-row"][data-lang="sw"] [data-testid="ai-lang-review"]');
  await studio.waitForSelector('[data-testid="ai-lang-editor"][data-lang="sw"]');
  const start = '[data-testid="ai-lang-text"][data-key="ui:start"]';
  assert.match(await studio.inputValue(start), /^\[sw\] Start the interview$/, "machine-translated by the fake provider");
  await studio.fill(start, "Anza mahojiano");
  await studio.click('[data-testid="ai-lang-save"]');
  await studio.waitForSelector('[data-testid="ai-lang-note"]');
  for (let attempt = 1; ; attempt++) {
    await studio.click('[data-testid="ai-launch-btn"]');
    if (await studio.waitForSelector('[data-testid="ai-study"][data-status="live"]', { timeout: 60000 }).then(() => true, () => false)) break;
    console.log(`  …   launch attempt ${attempt}: ${await studio.textContent('[data-testid="ai-tab-error"]').catch(() => "(no error shown)")}`);
    if (attempt >= 3) throw new Error("the study did not launch");
    await waitUp(`${STUDIO}/sandbox?mode=studio`); await waitUp(`${RUNTIME}/api/ai-interview/study?token=${"0".repeat(36)}`);
  }
  link = await studio.inputValue('[data-testid="ai-link"]');
  sandboxKey = await studio.evaluate(() => sessionStorage.getItem("rescript.aiInterviews.sandboxKey"));
  ok(`voice styles shown (realtime off: no provider); es/ur/sw wording translated, sw reviewed ("Anza mahojiano"); launched ${link.replace(/[0-9a-f]{30}$/, "…")}`);
}

const consent = async (p, { mode = "text", lang } = {}) => {
  await p.waitForSelector('[data-testid="ai-consent"]');
  if (lang) await p.selectOption('[data-testid="ai-language"]', lang);
  await p.check('[data-testid="ai-agree"]');
  if (await p.$(`[data-testid="ai-mode-${mode}"]`)) await p.check(`[data-testid="ai-mode-${mode}"]`);
};

let latency = null;
console.log("\n2 — a hands-free conversation: spoken opening, barge-in, utterances at the end of the turn, streamed speech, latency");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"], locale: "en-US" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  const speakEvents = [];
  p.on("response", async (r) => { if (/\/api\/ai-interview\/(turn|begin)/.test(r.url())) { const body = await r.text().catch(() => ""); speakEvents.push(...body.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })); } });
  await p.goto(link);
  await consent(p, { mode: "conversation" });
  assert.ok(await p.$('[data-testid="ai-headphones"]'), "the headphone hint");
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"][data-voice="conversation"]', { timeout: 20000 });
  await p.waitForSelector('[data-testid="ai-conv"]');
  /* the participant (the WAV) speaks at ~3.4 s, over the opening → barge-in; then their turn is sent */
  await p.waitForFunction(() => Number(document.querySelector('[data-testid="ai-conv"]')?.getAttribute("data-interruptions") ?? 0) >= 1, null, { timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-participant"]').length >= 1, null, { timeout: 40000 });
  assert.match((await p.$$eval('[data-testid="ai-turn-participant"] p', (e) => e.map((x) => x.textContent)))[0], /simulated transcript of a [\d.]+-second answer/, "the utterance, transcribed (fake STT), sent with no button");
  await p.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-testid="ai-conv"]')?.getAttribute("data-latency-ms") ?? ""), null, { timeout: 40000 });
  latency = Number(await p.getAttribute('[data-testid="ai-conv"]', "data-latency-ms"));
  const speaks = speakEvents.filter((e) => e.type === "speak"), audios = speakEvents.filter((e) => e.type === "audio");
  assert.ok(speaks.length >= 2 && audios.length >= 2, `the replies were spoken in sentences (${speaks.length} speak, ${audios.length} audio)`);
  assert.ok(audios.every((a) => a.none || (a.b64 && a.mime)), "each sentence has its audio (fake TTS) or none");
  assert.ok(latency > 0 && latency < 20000, `latency ${latency}`);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length >= 2, null, { timeout: 30000 });
  await ctx.close();
  ok(`opening spoken in ${speaks.length} sentence(s) with audio; barge-in recorded; utterance sent hands-free; end of speech → first audio ${latency} ms (fake STT + fake model + fake TTS on this machine)`);
}

console.log("\n3 — the live view: voice chip (interruptions, latency) and the interrupted moderator turn");
{
  await openAi();
  await studio.waitForSelector('[data-testid="ai-row"] [data-testid="ai-voice-stats"][data-style="conversation"]', { timeout: 20000 });
  const chip = await studio.$('[data-testid="ai-voice-stats"][data-style="conversation"]');
  assert.ok(Number(await chip.getAttribute("data-interruptions")) >= 1);
  const row = await studio.$('[data-testid="ai-row"]:has([data-testid="ai-voice-stats"][data-style="conversation"])');
  await (await row.$('[data-testid="ai-open"]')).click();
  await studio.waitForSelector('[data-testid="ai-transcript-turn"][data-interrupted="1"]', { timeout: 15000 });
  assert.ok(await studio.$('[data-testid="ai-interrupted"]'));
  ok(`live view: ${(await chip.textContent()).trim()}; the moderator turn the participant spoke over is marked`);
}

console.log("\n4 — the scripted fallback in a third language (Spanish), with the page in Spanish");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "es-ES", extraHTTPHeaders: { "accept-language": "es-ES,es;q=0.9" } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await p.goto(link);
  await p.waitForSelector('[data-testid="ai-consent"][data-lang="es"]');
  assert.equal((await p.textContent('[data-testid="ai-start"]')).trim(), "Empezar la entrevista", "picked from Accept-Language");
  assert.equal(await p.textContent('[data-testid="ai-consent-statement"]'), "[es] Taking part is voluntary; you can stop at any time.", "the consent statement in Spanish (the pack)");
  await consent(p, { mode: "text" });
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"]');
  const mods = () => p.$$eval('[data-testid="ai-turn-moderator"] > p', (e) => e.map((x) => x.textContent));
  assert.match((await mods())[0], /^Hola, soy Maya, un entrevistador de IA\. \[es\] Thank you for taking part\..*\[es\] Tell me about the last time/);
  await p.evaluate(() => { window.__aiInterviewScript = ["fail"]; });
  await p.fill('[data-testid="ai-input"]', "Cambié de compañía cuando la velocidad bajaba todas las noches durante un mes entero.");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length >= 2, null, { timeout: 30000 });
  assert.equal((await mods())[1], "Gracias. [es] How did you feel about your provider at that point?", "the provider failed: the guide's Spanish wording and the rules' Spanish words");
  assert.equal((await p.textContent('[data-testid="ai-send"]')).trim(), "Enviar");
  await ctx.close();
  ok("Spanish page; provider failure → “Gracias. [es] …” (the next question from the Spanish pack)");
}

console.log("\n5 — a language without built-in labels (Swahili): the study's translated labels, with the researcher's edit");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await p.goto(`${link}?lang=sw`);
  await p.waitForSelector('[data-testid="ai-consent"][data-lang="sw"]');
  assert.equal((await p.textContent('[data-testid="ai-start"]')).trim(), "Anza mahojiano", "the reviewed label");
  assert.match(await p.textContent('[data-testid="ai-about"]'), /^\[sw\] A conversation with Maya/);
  await consent(p, { mode: "text" });
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"]');
  assert.match(await p.textContent('[data-testid="ai-turn-moderator"] > p'), /^\[sw\] Hi, I'm Maya, an AI interviewer\./, "the rules' wording from the pack (no built-in Swahili)");
  await ctx.close();
  ok("Swahili labels and the rules' wording from the study's pack; the researcher's edit is live");
}

console.log("\n6 — RTL: Urdu");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ur-PK", extraHTTPHeaders: { "accept-language": "ur-PK,ur;q=0.9" } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await p.goto(link);
  await p.waitForSelector('[data-testid="ai-consent"][data-lang="ur"]');
  assert.equal(await p.getAttribute('[data-testid="ai-shell"]', "dir"), "rtl");
  assert.equal(await p.evaluate(() => document.documentElement.dir), "rtl");
  assert.equal((await p.textContent('[data-testid="ai-start"]')).trim(), "انٹرویو شروع کریں");
  await consent(p, { mode: "text" });
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"][data-dir="rtl"]');
  await p.fill('[data-testid="ai-input"]', "قیمت دو بار بڑھ گئی اور رفتار ہر شام کم ہو جاتی تھی۔");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length >= 2, null, { timeout: 30000 });
  const box = (sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  const log = await box('[data-testid="ai-log"]');
  const mod = await box('[data-testid="ai-turn-moderator"]'), you = await box('[data-testid="ai-turn-participant"]');
  assert.ok(log.right - mod.right < 30, `the moderator's bubble on the right (${JSON.stringify({ log, mod })})`);
  assert.ok(you.left - log.left < 30, `the participant's bubble on the left (${JSON.stringify({ log, you })})`);
  assert.equal((await p.textContent('[data-testid="ai-send"]')).trim(), "بھیجیں");
  const shot = join(tmpdir(), "ai-interview-rtl.png");
  await p.screenshot({ path: shot });
  await ctx.close();
  ok(`Urdu page right-to-left (document + shell), Urdu labels, bubbles mirrored (screenshot ${shot})`);
}

console.log("\n7 — no Web Audio: hands-free falls back to tap-to-talk, and says why");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"], locale: "en-US" });
  await ctx.addInitScript(() => { delete window.AudioContext; delete window.webkitAudioContext; });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await p.goto(link);
  await consent(p, { mode: "conversation" });
  assert.match(await p.textContent('[data-testid="ai-fallback-note"]'), /isn't available here \(this browser cannot process live audio\)/);
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"]');
  await p.waitForSelector('[data-testid="ai-rec-start"]');
  assert.equal(await p.$('[data-testid="ai-conv"]'), null);
  await p.fill('[data-testid="ai-input"]', "We switched because of the price.");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length >= 2, null, { timeout: 30000 });
  await ctx.close();
  await openAi();
  await studio.waitForFunction(() => [...document.querySelectorAll('[data-testid="ai-voice-stats"]')].some((c) => c.getAttribute("data-style") === "turn_based" && /fell back/.test(c.textContent ?? "")), null, { timeout: 20000 });
  ok("no AudioContext → the note says why; tap-to-talk shown; the live view records the fallback");
}

console.log("\n8 — no page errors");
{
  assert.deepEqual(pageErrors, []);
  ok("no page errors in the Studio or on the participants' phones");
}

await browser.close();
console.log(`\n${passed} passed — latency (end of speech → first audio): ${latency} ms`);
