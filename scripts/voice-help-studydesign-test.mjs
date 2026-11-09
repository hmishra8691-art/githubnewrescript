/**
 * VOICE IN HELP AND STUDY DESIGN (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox:
 * the fake speech provider, told what it "heard" through the platform's test seam, and a fake microphone).
 *
 *   1  Study design: the microphone sits beside "Recommend a methodology"; Listening → Stop → Transcribing → the words
 *      land in the objective, editable, and nothing is recommended until the researcher clicks
 *   2  Help (the Studio drawer): the microphone beside Ask; the spoken question lands in the box, unsent; edited and
 *      asked, it gets the right guide
 *   3  Cancel throws a recording away; nothing reaches the box
 *   4  a refused microphone says what to do; no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, permissions: ["microphone"] })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p, "studio").catch(() => {});

async function speak(scope, words) {
  await p.evaluate(([w]) => window.__rescriptVoiceHint(w, "en"), [words]);
  await p.click(`${scope} [data-testid="agw-mic"]`);
  await p.waitForFunction((s) => document.querySelector(`${s} [data-testid="agw-voice"]`)?.dataset.state === "recording", scope, { timeout: 10000 });
  assert.match(await p.textContent(`${scope} [data-testid="agw-voice"]`), /Listening…/);
  await p.waitForTimeout(800);
  await p.click(`${scope} [data-testid="agw-voice-stop"]`);
  await p.waitForFunction((s) => document.querySelector(`${s} [data-testid="agw-voice"]`)?.dataset.state === "idle", scope, { timeout: 20000 });
}

console.log("\n1 — Study design → Recommend a methodology");
await openTab(p, "Study design");
await p.waitForSelector('[data-testid="study-design"] [data-testid="agw-mic"]');
const SAID = "We are launching a premium subscription and need to know how much customers would pay for it";
await speak('[data-testid="study-design"]', SAID);
assert.equal(await p.inputValue('[data-testid="sd-objective"]'), SAID);
assert.equal(await p.$('[data-testid="study-design"] [data-testid="sd-rec"]'), null, "nothing recommended until the researcher clicks");
await p.fill('[data-testid="sd-objective"]', `${SAID}. Target: current customers in the UK.`);
await p.click('[data-testid="sd-recommend"]');
await p.waitForSelector('[data-testid="study-design"] [data-testid="sd-rec"]', { timeout: 10000 });
assert.match(await p.textContent('[data-testid="study-design"] [data-testid="sd-rec"]'), /Van Westendorp|Gabor|conjoint/i);
ok("spoken objective → in the box, editable → edited → Recommend → a pricing methodology");

console.log("\n2 — Help → Ask");
await openTab(p, "Questions");
await p.click('[data-testid="studio-help"]');
await p.waitForSelector('[data-testid="studio-help-drawer"] [data-testid="agw-mic"]');
await speak('[data-testid="studio-help-drawer"]', "how do I show a question only when someone answers yes");
assert.equal(await p.inputValue('[data-testid="help-input"]'), "how do I show a question only when someone answers yes");
assert.equal(await p.$$eval('[data-testid="help-answer"]', (a) => a.length), 0, "nothing asked until Ask");
await p.fill('[data-testid="help-input"]', "How do I show a question only when someone answers Yes to Q2?");
await p.click('[data-testid="help-send"]');
await p.waitForSelector('[data-testid="help-answer"]', { timeout: 20000 });
assert.match(await p.textContent('[data-testid="help-answer"]'), /display logic/i);
ok("spoken question → in the box, unsent → edited → Ask → the display-logic guide");

console.log("\n3 — Cancel");
await p.evaluate(() => window.__rescriptVoiceHint("this should never arrive", "en"));
await p.fill('[data-testid="help-input"]', "");
await p.click('[data-testid="studio-help-drawer"] [data-testid="agw-mic"]');
await p.waitForFunction(() => document.querySelector('[data-testid="studio-help-drawer"] [data-testid="agw-voice"]')?.dataset.state === "recording");
await p.click('[data-testid="studio-help-drawer"] [data-testid="agw-voice-cancel"]');
await p.waitForFunction(() => document.querySelector('[data-testid="studio-help-drawer"] [data-testid="agw-voice"]')?.dataset.state === "idle");
await p.waitForTimeout(800);
assert.equal(await p.inputValue('[data-testid="help-input"]'), "");
ok("Cancel discards the recording; the box stays empty");
await p.evaluate(() => window.__rescriptVoiceHint("", "en")).catch(() => {});

console.log("\n4 — microphone refused");
const b2 = await chromium.launch();
const p2 = await (await b2.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await p2.addInitScript(() => { const md = navigator.mediaDevices; if (md) md.getUserMedia = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })); });
await p2.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p2.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p2, "studio").catch(() => {});
await p2.click('[data-testid="studio-help"]');
await p2.click('[data-testid="studio-help-drawer"] [data-testid="agw-mic"]');
await p2.waitForSelector('[data-testid="studio-help-drawer"] .agw-voice-err');
assert.match(await p2.textContent('[data-testid="studio-help-drawer"] .agw-voice-err'), /allow it in the browser to ask by voice/);
await openTab(p2, "Study design");
await p2.click('[data-testid="study-design"] [data-testid="agw-mic"]');
await p2.waitForSelector('[data-testid="study-design"] .agw-voice-err');
assert.match(await p2.textContent('[data-testid="study-design"] .agw-voice-err'), /describe your research by voice/);
await b2.close();
ok("refused microphone: each place says how to allow it, in its own words");

assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);
