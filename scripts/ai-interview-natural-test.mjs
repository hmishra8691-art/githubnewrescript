/**
 * NATURAL AI INTERVIEWS, CHAT / HYBRID ANSWERING AND RESEARCH PLANNING (2026-11-08) — browser suite.
 *
 *   1  Studio → Qualitative → Plan: the researcher describes the study in their own words; the plan (rules draft on
 *      the fake provider) shows themes with depths and a DERIVED length; changing a depth changes the length; the
 *      researcher edits what respondents are told and approves → the guide and the AI settings (hybrid) exist; launch
 *   2  the respondent link: the purpose and why they were invited (from the approved plan) and the privacy panel
 *      before consent; a typed (chat) interview offers the microphone to dictate; "That's all." moves on — no probe
 *   3  hands-free voice: two pieces of speech with a 2-second thinking pause between them are ONE answer (the AI did
 *      not cut in), held with "Still listening", the model's "still talking" verdict honoured (the listen seam)
 *   4  no page errors
 *
 * Studio on :3000 and runtime on :3001, both with AI_API_URL=fake: and no database (the sandbox store).
 * Chromium's fake microphone plays a generated WAV: silence, speech 1.6 s, silence 2.0 s, speech 1.6 s, silence.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* restarting */ } await sleep(3000); } throw new Error(`${url} is not answering`); }
await waitUp(`${RUNTIME}/api/ai-interview/study?token=${"0".repeat(36)}`);
await waitUp(`${STUDIO}/sandbox?mode=studio`);

const WAV = (() => {
  const sr = 16000;
  const parts = [["silence", 9.0], ["speech", 1.6], ["silence", 2.0], ["speech", 1.6], ["silence", 25]];
  const total = Math.round(parts.reduce((a, [, s]) => a + s, 0) * sr);
  const pcm = new Int16Array(total);
  let i = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * sr);
    let phase = 0;
    for (let k = 0; k < n; k++, i++) {
      const t = k / sr;
      if (kind === "silence") { pcm[i] = Math.round(rnd() * 30); continue; }
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
  const dir = join(tmpdir(), `rescript-natural-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "pause.wav");
  writeFileSync(f, buf);
  return f;
})();

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"] });
const pageErrors = [];
const studio = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
studio.on("pageerror", (e) => pageErrors.push(`studio: ${e}`));
studio.on("dialog", (d) => d.accept());
await studio.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await studio.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(studio, "studio").catch(() => {});

let link;
console.log("\n1 — Plan: context in the researcher's words → a plan with derived length → approve → launch");
{
  await openTab(studio, "Qualitative");
  await studio.waitForSelector('[data-testid="qual-panel"]');
  await studio.click('[data-testid="qual-tab-plan"]');
  await studio.waitForSelector('[data-testid="qual-plan"]');
  await studio.fill('[data-testid="qp-context"]', "We are a mid-size bank. Young professionals aged 25-35 are leaving us for app-only banks. We want to understand why they switch banks, how they choose a new bank, how they feel about our mobile app, and what needs nobody meets today. We will use it to decide what to fix first in the next release.");
  await studio.click('[data-testid="qp-draft"]');
  await studio.waitForSelector('[data-testid="qp-plan"]', { timeout: 30000 });
  assert.equal(await studio.getAttribute('[data-testid="qp-plan"]', "data-source"), "rules", "no model here: a rules draft, labelled");
  assert.ok(await studio.$('[data-testid="qp-note"]'), "the page says it is a rules draft");
  const themes = await studio.$$('[data-testid="qp-theme"]');
  assert.ok(themes.length >= 2, `themes: ${themes.length}`);
  const rec = async () => Number((await studio.textContent('[data-testid="qp-minutes-rec"]')).match(/\d+/)[0]);
  const before = await rec();
  await studio.selectOption('[data-testid="qp-theme"]:nth-of-type(1) [data-testid="qp-depth"]', "brief").catch(async () => { const sel = (await studio.$$('[data-testid="qp-depth"]'))[0]; await sel.selectOption("brief"); });
  for (const sel of await studio.$$('[data-testid="qp-depth"]')) await sel.selectOption("deep");
  const deeper = await rec();
  assert.ok(deeper > before || deeper >= before, `deeper themes take at least as long (${before} → ${deeper})`);
  for (const sel of await studio.$$('[data-testid="qp-depth"]')) await sel.selectOption("brief");
  const briefer = await rec();
  assert.ok(briefer < deeper, `brief themes take less time (${deeper} → ${briefer})`);
  await studio.selectOption('[data-testid="qp-plan-format"]', "hybrid");
  await studio.fill('[data-testid="qp-purpose"]', "We want to understand how people choose and switch banks, so banking can work better for them.");
  await studio.click('[data-testid="qp-approve"]');
  await studio.waitForSelector('[data-testid="qp-done"]');
  await studio.click('[data-testid="qp-go-ai"]');
  await studio.waitForSelector('[data-testid="ai-interviews"]');
  assert.equal(await studio.isChecked('[data-testid="ai-setup-format-hybrid"]'), true, "the approved format is the study's");
  for (let attempt = 1; ; attempt++) {
    await studio.click('[data-testid="ai-launch-btn"]');
    if (await studio.waitForSelector('[data-testid="ai-study"][data-status="live"]', { timeout: 60000 }).then(() => true, () => false)) break;
    if (attempt >= 3) throw new Error(`the study did not launch: ${await studio.textContent('[data-testid="ai-tab-error"]').catch(() => "")}`);
  }
  link = await studio.inputValue('[data-testid="ai-link"]');
  ok(`rules draft with ${themes.length} themes; length follows depth (${deeper} min all deep → ${briefer} min all brief); approved as hybrid; launched ${link.replace(/[0-9a-f]{30}$/, "…")}`);
}

console.log("\n2 — the respondent's first screen; a chat answer by dictation is offered; “That's all.” moves on");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"], locale: "en-US" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await p.goto(link);
  await p.waitForSelector('[data-testid="ai-consent"]');
  assert.match(await p.textContent('[data-testid="ai-purpose"]'), /how people choose and switch banks/);
  const trust = await p.textContent('[data-testid="ai-trust"]');
  assert.match(trust, /masked before the AI reads/); assert.match(trust, /only if you tick the recording box/); assert.match(trust, /transcript/);
  await p.check('[data-testid="ai-agree"]');
  await p.check('[data-testid="ai-mode-text"]');
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"][data-mode="text"]', { timeout: 20000 });
  assert.ok(await p.$('[data-testid="ai-dictate"]'), "a typed interview of a hybrid study can dictate an answer");
  assert.ok(await p.$('[data-testid="ai-talk-instead"]'), "…or switch to talking");
  const firstQ = (await p.$$eval('[data-testid="ai-turn-moderator"] p', (e) => e.map((x) => x.textContent))).at(-1);
  await p.fill('[data-testid="ai-input"]', "I bank on my phone most days, mostly payments. That's all.");
  await p.press('[data-testid="ai-input"]', "Enter");
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length >= 2, null, { timeout: 30000 });
  const next = (await p.$$eval('[data-testid="ai-turn-moderator"] p', (e) => e.map((x) => x.textContent))).at(-1);
  assert.notEqual(next, firstQ);
  assert.doesNotMatch(next, /example|tell me more|could you say more/i, `no probe after “That's all.”: ${next}`);
  await ctx.close();
  ok(`purpose + privacy before consent; dictation and “Talk instead” offered in chat; after “That's all.” the moderator moved on: “${next.slice(0, 70)}…”`);
}

console.log("\n3 — hands-free: a 2-second thinking pause does not end the answer");
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"], locale: "en-US" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  /* the turn-taking model says "still talking" after the first piece (the fake provider's seam) */
  await p.addInitScript(() => { window.__aiListenScript = ["continuing", "complete"]; });
  const turns = [];
  p.on("request", (r) => { if (/\/api\/ai-interview\/turn$/.test(r.url())) { try { const b = JSON.parse(r.postData() ?? "{}"); if (b.input?.kind === "answer") turns.push(b.input.text); } catch { /* not json */ } } });
  await p.goto(link);
  await p.waitForSelector('[data-testid="ai-consent"]');
  await p.check('[data-testid="ai-agree"]');
  await p.check('[data-testid="ai-mode-conversation"]');
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-conv"]', { timeout: 20000 });
  await p.waitForSelector('[data-testid="ai-held"]', { timeout: 40000 });
  assert.match(await p.textContent('[data-testid="ai-conv-status"]'), /Still listening|Hearing you/);
  await p.waitForFunction(() => document.querySelectorAll('[data-testid="ai-turn-participant"]').length >= 1, null, { timeout: 40000 });
  await p.waitForTimeout(1500);
  assert.equal(turns.length, 1, `one answer was sent, not one per pause: ${JSON.stringify(turns)}`);
  const pieces = (turns[0].match(/simulated transcript/g) ?? []).length;
  assert.equal(pieces, 2, `both pieces of speech are in the one answer: ${turns[0]}`);
  await ctx.close();
  ok(`two pieces of speech around a 2 s pause were held (“Still listening”) and sent as one answer: “${turns[0].slice(0, 90)}…”`);
}

console.log("\n4 — no page errors");
assert.deepEqual(pageErrors, []);
ok("no page errors in the Studio or on the respondents' phones");
await browser.close();
console.log(`\n${passed} passed`);
