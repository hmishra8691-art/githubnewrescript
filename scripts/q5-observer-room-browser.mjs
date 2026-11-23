/**
 * Browser check — Q5: a question from the observer room reaches the participant's interview.
 *
 * The runtime's sandbox (no database, AI_API_URL=fake:). A participant starts a text interview in the browser; the
 * research team (here: the sandbox API the Studio's observer room calls) posts a chat message, a marker and a
 * question; after the participant's next answer the moderator asks that question; the room shows it asked, with the
 * turn; the participant's page never shows the chat or the marker.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/q5-observer-room-browser.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const errors = [];
const api = async (body) => { const r = await fetch(`${RUNTIME}/api/ai-interview/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); assert.ok(r.ok, JSON.stringify(j)); return j; };

const guide = {
  kind: "interview", title: "Switching broadband", durationMinutes: 15, objectives: ["Understand what triggers switching"],
  consent: { statement: "Taking part is voluntary; you can stop at any time." },
  sections: [
    { id: "s1", title: "Intro", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "Triggers", questions: [{ id: "q1", text: "Tell me about the last time you thought about changing provider." }, { id: "q2", text: "How did you compare providers?" }] },
    { id: "s3", title: "Close", kind: "closing", questions: [{ id: "q9", text: "Anything else to add?" }] },
  ],
  aiModeration: { modes: ["text"], defaultProbing: "none", maxTurns: 30, costCapUsd: 1 },
};
const launched = await api({ action: "launch", guide, title: "Q5 check" });
const browser = await chromium.launch();
try {
  const pg = await browser.newPage({ viewport: { width: 900, height: 900 } });
  pg.on("pageerror", (e) => { if (!/ChunkLoadError|ResizeObserver/.test(String(e))) errors.push(e.message); });
  await pg.goto(`${RUNTIME}/i/${launched.linkToken}`, { waitUntil: "networkidle", timeout: 180000 });
  await pg.waitForSelector('[data-testid="ai-consent"]', { timeout: 120000 });
  await pg.check('[data-testid="ai-agree"]');
  await pg.click('[data-testid="ai-start"]');
  await pg.waitForSelector('[data-testid="ai-input"]', { timeout: 60000 });
  const list = await api({ action: "list", observerKey: launched.observerKey });
  const id = list.interviews[0].id;
  await api({ action: "observer", observerKey: launched.observerKey, id, note: { kind: "chat", text: "Price is coming up a lot" }, author: "Sam" });
  await api({ action: "observer", observerKey: launched.observerKey, id, note: { kind: "marker", text: "Contract ending" }, author: "Sam" });
  const queued = await api({ action: "observer", observerKey: launched.observerKey, id, note: { kind: "question", text: "What would have made you stay with them" }, author: "Priya" });
  assert.equal(queued.notes.find((n) => n.kind === "question").status, "queued");
  const refused = await fetch(`${RUNTIME}/api/ai-interview/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "observer", observerKey: launched.observerKey, id, note: { kind: "question", text: "What is your email address?" } }) });
  assert.equal(refused.status, 400);
  ok("the room takes a chat message, a marker and a question (queued); a question asking for contact details is refused");

  const turns = () => pg.$$eval('[data-testid="ai-turn-moderator"]', (ts) => ts.map((t) => t.querySelector(":scope > p")?.textContent ?? ""));
  const before = (await turns()).length;
  await pg.fill('[data-testid="ai-input"]', "We thought about it when the contract ended last spring.");
  await pg.click('[data-testid="ai-send"]');
  await pg.waitForFunction((n) => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length > n && !document.querySelector('[data-testid="ai-live"]'), before, { timeout: 60000 });
  const said = (await turns()).at(-1);
  assert.equal(said, "What would have made you stay with them?");
  ok(`after the participant's answer the moderator asks the observer's question: “${said}”`);
  const page = await pg.textContent('[data-testid="ai-log"]');
  assert.ok(!/Price is coming up a lot|Contract ending|Priya|Sam/.test(page), "the participant never sees the room");
  const notes = (await api({ action: "observer", observerKey: launched.observerKey, id })).notes;
  const q = notes.find((n) => n.kind === "question" && n.status !== "refused");
  assert.equal(q.status, "asked"); assert.ok(Number.isInteger(q.askedSeq));
  ok(`the room shows it asked at moderator turn ${q.askedSeq}; the chat and the marker never reach the participant's page`);
  await pg.fill('[data-testid="ai-input"]', "Honestly a lower price, and someone answering the phone when it broke.");
  await pg.click('[data-testid="ai-send"]');
  await pg.waitForFunction(() => /How did you compare providers\?/.test([...document.querySelectorAll('[data-testid="ai-turn-moderator"]')].at(-1)?.textContent ?? ""), null, { timeout: 60000 });
  ok("the next answer goes on with the guide");
  assert.deepEqual(errors, [], errors.join(" | "));
  ok("no page errors");
} finally { await browser.close(); }
console.log(`\nq5-observer-room-browser: ${passed} passed`);
