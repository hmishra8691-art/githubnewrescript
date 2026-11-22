/**
 * Browser check — Q3 (moderator v2) on the participant page: a laddered question asks why it matters; a concept board
 * is shown as a card; a screen-share task offers "Share your screen", shares (Chromium's fake screen), and ends.
 *
 * The runtime's sandbox (no database, AI_API_URL=fake:): the moderator's turns come from the engine's stand-in model
 * (fakeModeratorReply), which ladders like a model would. Recording is not agreed to, so nothing is uploaded.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/q3-moderator-v2-browser.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const errors = [];

const guide = {
  kind: "interview", title: "Choosing a car", durationMinutes: 20,
  objectives: ["Understand what matters when choosing a car"],
  consent: { statement: "Taking part is voluntary; you can stop at any time." },
  sections: [
    { id: "s1", title: "Hello", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "What matters", questions: [{ id: "q1", text: "What matters most to you when you choose a car?" }] },
    { id: "s3", title: "Concept", kind: "concept", stimuli: ["Board A"], questions: [{ id: "q4", text: "What do you make of this idea?" }] },
    { id: "s4", title: "The website", stimuli: ["Book a test drive"] },
    { id: "s5", title: "Close", kind: "closing", questions: [{ id: "q9", text: "Anything else to add?" }] },
  ],
  aiModeration: {
    modes: ["text"], defaultProbing: "light", probing: [{ questionId: "q1", depth: "deep", ladder: 2 }], maxTurns: 30, costCapUsd: 1,
    stimuli: [
      { name: "Board A", kind: "concept", text: "A car subscription: one monthly price, insurance and servicing included." },
      { name: "Book a test drive", kind: "screen_share", text: "Go to the dealer's website and book a test drive for Saturday." },
    ],
  },
};

const r = await fetch(`${RUNTIME}/api/ai-interview/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", guide, title: "Q3 check" }) });
const j = await r.json();
assert.ok(j.linkToken, JSON.stringify(j));

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--enable-usermedia-screen-capturing"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => { if (!/ChunkLoadError|ResizeObserver/.test(String(e))) errors.push(e.message); });
  await pg.goto(`${RUNTIME}/i/${j.linkToken}`, { waitUntil: "networkidle", timeout: 180000 });
  await pg.waitForSelector('[data-testid="ai-consent"]', { timeout: 120000 });
  await pg.check('[data-testid="ai-agree"]');
  await pg.click('[data-testid="ai-start"]');
  await pg.waitForSelector('[data-testid="ai-input"]', { timeout: 60000 });
  const moderatorTurns = () => pg.$$eval('[data-testid="ai-turn-moderator"]', (ts) => ts.map((t) => t.querySelector(":scope > p")?.textContent ?? ""));
  const say = async (text) => {
    const before = (await moderatorTurns()).length;
    await pg.fill('[data-testid="ai-input"]', text);
    await pg.click('[data-testid="ai-send"]');
    await pg.waitForFunction((n) => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length > n && !document.querySelector('[data-testid="ai-live"]'), before, { timeout: 60000 });
    const all = await moderatorTurns();
    return all[all.length - 1];
  };
  assert.match((await moderatorTurns())[0], /What matters most to you when you choose a car\?/);
  const rung1 = await say("Reliability, mostly. It has to start every morning.");
  assert.match(rung1, /why does that matter to you\?/i, rung1);
  ok(`laddering: after the first answer the moderator asks why it matters — “${rung1.slice(0, 80)}”`);
  const after = await say("It gives me peace of mind so I can look after my family.");
  assert.match(after, /What do you make of this idea\?/, after);
  const card = await pg.$('[data-testid="ai-stimulus"][data-kind="concept"]');
  assert.ok(card, "the concept board is shown");
  const cardText = await card.textContent();
  assert.match(cardText, /Board A.*A car subscription: one monthly price/s);
  ok("a personal value ends the ladder; the concept board is shown as a card with its title and text");
  const share = await say("Interesting, but I would worry about the monthly cost adding up over the years.");
  assert.match(share, /book a test drive for Saturday/i, share);
  await pg.waitForSelector('[data-testid="ai-screen-share"] [data-testid="ai-screen-start"]', { timeout: 10000 });
  await pg.click('[data-testid="ai-screen-start"]');
  await pg.waitForSelector('[data-testid="ai-screen-share"][data-state="sharing"]', { timeout: 15000 });
  const notice = await pg.textContent('[data-testid="ai-screen-share"]');
  assert.match(notice, /being shared \(not recorded\)/, notice);
  await pg.click('[data-testid="ai-screen-stop"]');
  await pg.waitForSelector('[data-testid="ai-screen-done"]', { timeout: 15000 });
  ok("screen share task: “Share your screen” → shared (the participant did not agree to recording, so it says not recorded) → stopped");
  assert.deepEqual(errors, [], errors.join(" | "));
  ok("no page errors");
} finally { await browser.close(); }
console.log(`\nq3-moderator-v2-browser: ${passed} passed`);
