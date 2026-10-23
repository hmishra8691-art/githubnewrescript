/**
 * LIVE HUMAN-MODERATED SESSIONS (2026-10-22, G2) — a real multi-party video session across the two apps, in
 * Chromium with fake camera and microphone (docs/LIVE-SESSIONS-2026-10-22.md):
 *
 *   1  the moderator schedules a focus group from the guide (Research Tools → Qualitative → Live sessions):
 *      participant links and an observer link (the back room)
 *   2  two participants open their links (separate browser contexts): the consent screen gates the room (no
 *      recording consent → refused by the API; the button stays disabled), the device check shows the camera
 *      and a moving microphone level; they wait in the waiting room
 *   3  an external observer opens the observer link: confidentiality first, then the back room
 *   4  the moderator (a fourth context, the Studio) enters, opens the room, admits both, starts the session
 *   5  everyone sees and hears everyone they should: every peer connection "connected", inbound audio AND video
 *      RTP bytes growing (getStats) — moderator ↔ P1 ↔ P2 in a mesh; the observer receives the moderator's
 *      relay of all three
 *   6  the observer is invisible to participants: not in their peers, their stats, their page, or the API's answer
 *   7  the moderator pushes a stimulus from the guide → every participant and the observer see it; the section
 *      timer shows to the moderator and the observer only; mute reaches the participant
 *   8  the back room: observer → moderator chat and a timestamped note; participants get neither
 *   9  reconnection: P1 reloads mid-session → back in the room as P1, connections re-established
 *  10  recording: each person's chunks upload (fake STT transcribes them per speaker); the rolling transcript and
 *      the AI assist panel (stand-in model: probes cited, missed objectives) on the moderator's console
 *  11  end → Finalize → one transcript with Moderator, P1 and P2 as speakers (separate tracks), in the coding
 *      workspace
 *
 * Needs the Studio on :3000 and the runtime on :3001, both with AI_API_URL=fake: and no database (the runtime then
 * forwards participants to the Studio's sandbox; STUDIO_SANDBOX_URL overrides the address).
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/live-session-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const TITLE = `Live FG ${Date.now().toString(36)}`;
const DEF = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "LV", title: "Broadband live", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  qualStudy: {
    kind: "focus_group", title: "Broadband prices", objectives: ["Understand reactions to the monthly price", "Explore what makes people switch provider"],
    consent: { statement: "You agree to take part in a research discussion about broadband.", recordingDisclosure: "The session is recorded (audio) for analysis by the research team.", dataUse: "Quotes are anonymised." },
    sections: [
      { id: "s1", title: "Warm-up", kind: "opening", minutes: 5, questions: [{ id: "s1q1", text: "Tell us about your broadband provider" }] },
      { id: "s2", title: "Price", kind: "main", minutes: 20, stimuli: ["Concept A: unlimited data for 499 a month"], questions: [{ id: "s2q1", text: "What do you think of the monthly price?" }] },
    ],
  },
});

const MEDIA_ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
const browser = await chromium.launch({ args: MEDIA_ARGS });
const pageErrors = [];
const watch = (p, who) => { p.on("pageerror", (e) => pageErrors.push(`${who}: ${e}`)); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/*
 * Both development servers can be OOM-killed and restarted by their supervisor mid-suite; the sandbox's rooms
 * survive that (the Studio keeps them in a temp file) and every page reconnects by itself (long-polls back off and
 * retry). An action whose request died with a server is done again once both answer — never a skipped check.
 */
const serverUp = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const a = await fetch(`${STUDIO}/sandbox`, { signal: AbortSignal.timeout(20000) });
      /* the runtime answers a bad link with 404 only when it reached the Studio's sandbox */
      const b = await fetch(`${RUNTIME}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", invite: "x".repeat(40) }), signal: AbortSignal.timeout(20000) });
      if (a.ok && b.status === 404) return;
    } catch { /* restarting */ }
    await sleep(2000);
  }
};
async function until(label, act, done, ms = 60000) {
  for (let attempt = 0; ; attempt++) {
    await act();
    try { return await done(ms); } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  (${label}: not seen yet — ${String(e.message).split("\n")[0]}; waiting for the servers and doing it again)`);
      await serverUp();
      try { return await done(15000); } catch { /* do it again */ }
    }
  }
}
const SLOW = 120000;
/** poll a page-side condition (the session controller is window.__rescriptLive) */
const waitFor = (p, fn, arg, ms = SLOW) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const stats = (p) => p.evaluate(async () => (window.__rescriptLive ? await window.__rescriptLive.client.stats() : []));

await serverUp();

/* ------------------------------------------------------------ the Studio (moderator) */
const studioCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["camera", "microphone"] });
let page = watch(await studioCtx.newPage(), "studio");
await until("the Studio sandbox", () => page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: SLOW }).catch(() => {}), (ms) => page.waitForSelector(".block-badge", { timeout: ms }), SLOW);
await switchMode(page, "studio").catch(() => {});
await openTab(page, "JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(DEF));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(1200);
const openQual = async (tab) => { await switchMode(page, "studio").catch(() => {}); await openTab(page, "Qualitative"); await page.waitForSelector('[data-testid="qual-panel"]', { timeout: SLOW }); await page.click(`[data-testid="qual-tab-${tab}"]`); await page.waitForTimeout(300); };

console.log("\n1 — schedule a live focus group from the guide; participant and observer links");
let roomId, links, observerLink;
{
  await openQual("live");
  await page.waitForSelector('[data-testid="live-transport"]', { timeout: SLOW });
  assert.equal(await page.getAttribute('[data-testid="live-transport"]', "data-turn"), "none");
  assert.match(await page.textContent('[data-testid="live-turn-warning"]'), /corporate firewalls or on some mobile networks/);
  await page.fill('[data-testid="live-title"]', TITLE);
  await page.fill('[data-testid="live-max"]', "2");
  await page.fill('[data-testid="live-slots"]', "2");
  await until("scheduling", async () => { if (!(await page.$(`[data-testid="live-room"][data-title="${TITLE}"]`))) await page.click('[data-testid="live-schedule"]'); }, (ms) => page.waitForSelector(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-detail"]`, { timeout: ms }));
  roomId = await page.getAttribute(`[data-testid="live-room"][data-title="${TITLE}"]`, "data-id");
  links = await page.$$eval('[data-testid="live-invite-link"][data-role="participant"]', (es) => es.map((e) => e.value));
  assert.equal(links.length, 2);
  for (const l of links) assert.match(l, /^http:\/\/localhost:3001\/live\/[A-Za-z0-9_-]{43}$/);
  assert.notEqual(links[0], links[1], "a unique link per participant");
  await until("an observer link", async () => { if (!(await page.$('[data-testid="live-invite-link"][data-role="observer"]'))) await page.click('[data-testid="live-add-observer"]'); }, (ms) => page.waitForSelector('[data-testid="live-invite-link"][data-role="observer"]', { timeout: ms }));
  observerLink = await page.inputValue('[data-testid="live-invite-link"][data-role="observer"]');
  ok(`room ${roomId} scheduled; 2 unique participant links and an observer link; the missing TURN relay is stated`);
}

await page.close().catch(() => {});
console.log("\n2 — participants: consent gates the room, the device check, the waiting room");
const joinParticipant = async (link, who) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, permissions: ["camera", "microphone"] });
  const p = watch(await ctx.newPage(), who);
  await until(`${who}: the link`, () => p.goto(link, { waitUntil: "networkidle", timeout: SLOW }).catch(() => {}), (ms) => p.waitForSelector('[data-testid="live-page"][data-step="consent"]', { timeout: ms }));
  assert.match(await p.textContent('[data-testid="live-recording-disclosure"]'), /recorded/);
  /* no recording consent → the button stays disabled */
  for (let i = 0; i < 60 && !(await p.isChecked('[data-testid="live-consent-agree"]')); i++) { await p.check('[data-testid="live-consent-agree"]').catch(() => {}); await p.waitForTimeout(300); }
  assert.ok(await p.isDisabled('[data-testid="live-consent-continue"]'), "agreeing without the recording consent is not enough");
  await p.check('[data-testid="live-consent-recording"]');
  await p.click('[data-testid="live-consent-continue"]');
  await p.waitForSelector('[data-testid="live-page"][data-step="device"]', { timeout: SLOW });
  await waitFor(p, () => { const v = document.querySelector('[data-testid="live-self"] video'); return v && v.videoWidth > 0; });
  await waitFor(p, () => Number(document.querySelector('[data-testid="live-mic-level"]')?.dataset.level ?? 0) > 0.01, null, 30000);
  await until(`${who}: joining`, async () => { if (await p.$('[data-testid="live-join"]')) await p.click('[data-testid="live-join"]'); }, (ms) => p.waitForSelector('[data-testid="live-room"][data-state="waiting"]', { timeout: ms }));
  return p;
};
let p1, p2;
{
  /* the API refuses a join without the recording consent (the page cannot be talked past) */
  const token = links[0].split("/live/")[1];
  const refused = await fetch(`${RUNTIME}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", invite: token, consent: { agree: true } }) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "recording_consent_required");
  p1 = await joinParticipant(links[0], "P1");
  p2 = await joinParticipant(links[1], "P2");
  assert.deepEqual([await p1.getAttribute('[data-testid="live-room"]', "data-handle"), await p2.getAttribute('[data-testid="live-room"]', "data-handle")], ["P1", "P2"]);
  assert.match(await p1.textContent('[data-testid="live-message"]'), /moderator will let you in/);
  ok("no recording consent → 400 recording_consent_required and a disabled button; consent → camera preview + a moving mic level → P1 and P2 wait");
}

console.log("\n3 — an external observer: confidentiality first, then the back room");
let obs;
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  obs = watch(await ctx.newPage(), "observer");
  await until("observer: the link", () => obs.goto(observerLink, { waitUntil: "networkidle", timeout: SLOW }).catch(() => {}), (ms) => obs.waitForSelector('[data-testid="live-page"][data-step="consent"][data-role="observer"]', { timeout: ms }));
  assert.ok(await obs.isDisabled('[data-testid="live-join"]'));
  await obs.check('[data-testid="live-confidential"]');
  await until("observer: entering", async () => { if (await obs.$('[data-testid="live-join"]')) await obs.click('[data-testid="live-join"]'); }, (ms) => obs.waitForSelector('[data-testid="live-room"][data-role="observer"][data-state="admitted"]', { timeout: ms }));
  ok("the observer confirmed confidentiality and is in the back room");
}

console.log("\n4 — the moderator enters, opens the room, admits both, starts the session");
{
  /* a fresh Studio tab for the console (the scheduling tab sat through steps 2–3; memory here is shared and tight) */
  await page.close().catch(() => {});
  page = watch(await studioCtx.newPage(), "studio");
  await until("the Studio sandbox", () => page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: SLOW }).catch(() => {}), (ms) => page.waitForSelector(".block-badge", { timeout: ms }), SLOW);
  await openQual("live");
  await page.waitForSelector(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-moderate"]`, { timeout: SLOW });
  await page.click(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-moderate"]`);
  await page.waitForSelector('[data-testid="live-console"][data-phase="preview"]', { timeout: SLOW });
  await waitFor(page, () => { const v = document.querySelector('[data-testid="live-preview"] video'); return v && v.videoWidth > 0; });
  await page.click('[data-testid="live-enter"]');
  await page.waitForSelector('[data-testid="live-console"][data-phase="in"][data-status="scheduled"]', { timeout: SLOW });
  await until("opening the room", async () => { if (await page.$('[data-testid="live-open-room"]')) await page.click('[data-testid="live-open-room"]'); }, (ms) => page.waitForSelector('[data-testid="live-console"][data-status="open"]', { timeout: ms }));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="live-waiting-item"]').length === 2, null, { timeout: SLOW });
  for (const h of ["P1", "P2"]) await until(`admitting ${h}`, async () => { const b = await page.$(`[data-testid="live-waiting-item"][data-handle="${h}"] [data-testid="live-admit"]`); if (b) await b.click(); }, (ms) => page.waitForSelector(`[data-testid="live-member"][data-handle="${h}"]`, { timeout: ms }));
  for (const p of [p1, p2]) await p.waitForSelector('[data-testid="live-room"][data-state="admitted"]', { timeout: SLOW });
  await until("starting", async () => { if (await page.$('[data-testid="live-start"]')) await page.click('[data-testid="live-start"]'); }, (ms) => page.waitForSelector('[data-testid="live-console"][data-status="live"]', { timeout: ms }));
  for (const p of [p1, p2, obs]) await p.waitForSelector('[data-testid="live-room"][data-status="live"]', { timeout: SLOW });
  ok("open → P1, P2 admitted from the waiting room → live for everyone");
}

console.log("\n5 — everyone sees and hears everyone they should (connected peers, inbound audio + video RTP)");
const ids = {};
{
  ids.mod = await page.getAttribute('[data-testid="live-console"]', "data-member");
  ids.p1 = await p1.getAttribute('[data-testid="live-room"]', "data-member");
  ids.p2 = await p2.getAttribute('[data-testid="live-room"]', "data-member");
  ids.obs = await obs.getAttribute('[data-testid="live-room"]', "data-member");
  const flowing = async (p, who, expectPeers, opts = {}) => {
    const deadline = Date.now() + SLOW;
    let last = [], prev = null;
    while (Date.now() < deadline) {
      last = await stats(p).catch(() => []);
      const byPeer = Object.fromEntries(last.map((s) => [s.peer, s]));
      const want = expectPeers.filter((id) => !(opts.sendOnly ?? []).includes(id));
      const allConnected = expectPeers.every((id) => byPeer[id]?.state === "connected");
      const allIn = want.every((id) => byPeer[id]?.inboundAudioBytes > 0 && byPeer[id]?.inboundVideoBytes > 0);
      /* growing, not just non-zero: two samples a second apart */
      if (allConnected && allIn && prev && want.every((id) => byPeer[id].inboundVideoBytes > prev[id].inboundVideoBytes && byPeer[id].inboundAudioBytes > prev[id].inboundAudioBytes)) return last;
      prev = byPeer;
      await sleep(1000);
    }
    throw new Error(`${who}: not flowing — ${JSON.stringify(last)}`);
  };
  const ms = await flowing(page, "moderator", [ids.p1, ids.p2, ids.obs], { sendOnly: [ids.obs] });
  await flowing(p1, "P1", [ids.mod, ids.p2]);
  await flowing(p2, "P2", [ids.mod, ids.p1]);
  const os = await flowing(obs, "observer", [ids.mod]);
  assert.ok(ms.find((s) => s.peer === ids.obs).outboundBytes > 0, "the moderator sends to the observer (the relay)");
  /* the observer's tiles: the moderator's own camera and both participants', relayed */
  await waitFor(obs, (want) => want.every((id) => document.querySelector(`[data-testid="live-tile"][data-member="${id}"] video`)?.videoWidth > 0), [ids.mod, ids.p1, ids.p2]);
  await waitFor(p1, (want) => want.every((id) => document.querySelector(`[data-testid="live-tile"][data-member="${id}"] video`)?.videoWidth > 0), [ids.mod, ids.p2]);
  ok(`mesh: moderator↔P1↔P2 connected with inbound audio + video growing; the observer receives the relay of all three (${os.length} connection, ${await obs.$$eval('[data-testid="live-tile"]', (t) => t.length)} tiles)`);
}

console.log("\n6 — the observer is invisible to participants");
{
  for (const [p, who] of [[p1, "P1"], [p2, "P2"]]) {
    const peers = (await stats(p)).map((s) => s.peer);
    assert.ok(!peers.includes(ids.obs), `${who} has no connection to the observer`);
    const view = await p.evaluate(() => window.__rescriptLive.snapshot.view);
    assert.ok(!JSON.stringify(view).includes(ids.obs) && !/Observer/.test(JSON.stringify(view)), `${who}'s view names no observer`);
    assert.equal(view.members, undefined);
    assert.ok(!/Observer|back room/i.test(await p.textContent("body")), `${who}'s page says nothing about observers`);
  }
  /* the API's own answer to a participant (their member token is in their tab) */
  const tok = await p1.evaluate(() => { for (const k of Object.keys(sessionStorage)) if (k.startsWith("rs-live-")) return JSON.parse(sessionStorage.getItem(k)).token; return null; });
  const r = await (await fetch(`${RUNTIME}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "view", token: tok }) })).json();
  assert.ok(r.view && !JSON.stringify(r).includes(ids.obs) && r.chat === undefined && r.notes === undefined, "the participant API returns no observer and no back room");
  const sig = await (await fetch(`${RUNTIME}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signal", token: tok, signals: [{ to: ids.obs, type: "offer", payload: { description: { type: "offer", sdp: "v=0" } } }] }) })).json();
  assert.deepEqual([sig.sent, sig.refused], [0, 1], "a participant cannot even signal the observer");
  ok("no peer, no view entry, no page text, no API field, and a refused signal — participants cannot see the back room");
}

console.log("\n7 — a stimulus from the guide, the section timer, mute");
{
  await until("showing the stimulus", async () => { const b = await page.$('[data-testid="live-stimulus-item"][data-id="st1"] [data-testid="live-show"]:not([disabled])'); if (b) await b.click(); }, (ms) => page.waitForSelector('[data-testid="live-stage"] [data-testid="live-stimulus"][data-id="st1"]', { timeout: ms }));
  for (const p of [p1, p2, obs]) await p.waitForSelector('[data-testid="live-stimulus"][data-id="st1"]', { timeout: SLOW });
  assert.match(await p1.textContent('[data-testid="live-stimulus"]'), /unlimited data for 499/);
  await until("the section timer", async () => { const b = await page.$('[data-testid="live-section"][data-id="s2"] [data-testid="live-section-start"]'); if (b && !(await page.$('[data-testid="live-section-timer"][data-section="s2"]'))) await b.click(); }, (ms) => page.waitForSelector('[data-testid="live-section-timer"][data-section="s2"]', { timeout: ms }));
  await obs.waitForFunction(() => window.__rescriptLive?.snapshot.view?.stage.section?.id === "s2", null, { timeout: SLOW });
  assert.equal(await p1.evaluate(() => window.__rescriptLive.snapshot.view.stage.section), undefined, "participants do not see the moderator's timer");
  await until("muting P2", async () => { const b = await page.$('[data-testid="live-member"][data-handle="P2"] [data-testid="live-mute"]:not([disabled])'); if (b) await b.click(); }, (ms) => p2.waitForSelector('[data-testid="live-muted-notice"]', { timeout: ms }));
  assert.equal(await p2.evaluate(() => window.__rescriptLive.localStream.getAudioTracks()[0].enabled), false, "P2's microphone is off");
  await p2.click('[data-testid="live-mic"]');
  await p2.waitForSelector('[data-testid="live-muted-notice"]', { state: "detached", timeout: SLOW });
  ok("the concept reached P1, P2 and the observer; the timer shows to staff only; the moderator's mute reached P2, who unmuted");
}

console.log("\n8 — the back room: chat and timestamped notes, never seen by participants");
{
  await until("observer chat", async () => { await obs.fill('[data-testid="live-chat-input"]', "Ask P1 about the contract length"); await obs.click('[data-testid="live-chat-send"]'); }, (ms) => page.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-chat-msg"]')].some((m) => /contract length/.test(m.textContent)), null, { timeout: ms }));
  await until("observer note", async () => { await obs.fill('[data-testid="live-note-input"]', "P1 hesitates on price"); await obs.click('[data-testid="live-note-send"]'); }, (ms) => page.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-note-item"]')].some((m) => /hesitates/.test(m.textContent) && m.dataset.offset !== ""), null, { timeout: ms }));
  await page.fill('[data-testid="live-chat-input"]', "Will do");
  await page.click('[data-testid="live-chat-send"]');
  await obs.waitForFunction(() => [...document.querySelectorAll('[data-testid="live-chat-msg"]')].some((m) => /Will do/.test(m.textContent)), null, { timeout: SLOW });
  for (const p of [p1, p2]) assert.ok(!/contract length|hesitates|Will do/.test(await p.textContent("body")));
  ok("observer → moderator chat, moderator → observer reply, a note at its session second; participants see none of it");
}

console.log("\n9 — reconnection: P1 reloads mid-session and is back as P1");
{
  await p1.reload({ waitUntil: "networkidle", timeout: SLOW }).catch(() => {});
  await p1.waitForSelector('[data-testid="live-room"][data-state="admitted"][data-handle="P1"]', { timeout: SLOW });
  await waitFor(p1, (id) => document.querySelector(`[data-testid="live-tile"][data-member="${id}"] video`)?.videoWidth > 0, ids.mod);
  const deadline = Date.now() + SLOW;
  for (;;) {
    const s = (await stats(page)).find((x) => x.peer === ids.p1);
    if (s?.state === "connected" && s.inboundVideoBytes > 0) break;
    if (Date.now() > deadline) throw new Error(`the moderator did not reconnect to P1: ${JSON.stringify(s)}`);
    await sleep(1000);
  }
  ok("same member, same handle, the moderator's connection to P1 re-established with video flowing");
}

console.log("\n10 — recording per speaker; the rolling transcript; the AI assist panel");
{
  /* 30-second chunks: wait for each person's first chunk, uploaded and transcribed by the moderator's console */
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="live-rec"]')?.dataset.uploaded ?? 0) >= 1, null, { timeout: 150000 });
  for (const p of [p1, p2]) await p.waitForFunction(() => Number(document.querySelector('[data-testid="live-rec-indicator"]')?.dataset.uploaded ?? 0) >= 1, null, { timeout: 150000 });
  await page.waitForFunction(() => { const sp = new Set([...document.querySelectorAll('[data-testid="live-transcript-turn"]')].map((t) => t.dataset.speaker)); return sp.has("Moderator") && (sp.has("P1") || sp.has("P2")); }, null, { timeout: 150000 });
  await until("AI assist", async () => { if (await page.$('[data-testid="live-assist-run"]:not([disabled])')) await page.click('[data-testid="live-assist-run"]'); }, (ms) => page.waitForSelector('[data-testid="live-assist-result"][data-origin="fake"] [data-testid="live-assist-probe"]', { timeout: ms }));
  const probe = await page.textContent('[data-testid="live-assist-probe"]');
  assert.match(probe, /\?.*\[t\d+/, "a question citing a transcript turn");
  assert.match(await page.textContent('[data-testid="live-assist-progress"]'), /of 2 guide questions asked/);
  for (const p of [p1, p2]) assert.ok(!/Could you tell me more|AI assist/.test(await p.textContent("body")), "the AI never speaks to participants");
  ok(`chunks uploaded by the moderator, P1 and P2; the rolling transcript has the moderator and a participant; assist: “${probe.trim().slice(0, 70)}”`);
}

console.log("\n11 — end → Finalize → one transcript, the speakers from separate tracks");
{
  page.on("dialog", (d) => void d.accept());
  await until("ending", async () => { if (await page.$('[data-testid="live-end"]')) await page.click('[data-testid="live-end"]'); }, (ms) => page.waitForSelector('[data-testid="live-console"][data-status="ended"]', { timeout: ms }));
  for (const p of [p1, p2]) await p.waitForSelector('[data-testid="live-page"][data-step="ended"]', { timeout: SLOW });
  /* the last partial chunks upload after the end */
  await sleep(8000);
  /* the console's button; after a retry the console may have closed — the session row has the same button */
  await until("finalizing", async () => { if (await page.$('[data-testid="live-finalize"]:not([disabled])')) await page.click('[data-testid="live-finalize"]'); else if (await page.$(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-finalize-row"]`)) await page.click(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-finalize-row"]`); }, (ms) => page.waitForSelector('[data-testid="qual-note"]', { timeout: ms }), 180000);
  assert.match(await page.textContent('[data-testid="qual-note"]'), /now a source/);
  await openQual("transcripts");
  const title = `${TITLE} (live session)`;
  await page.waitForSelector(`[data-testid="qual-transcript"][data-title="${title}"]`, { timeout: SLOW });
  await page.click(`[data-testid="qual-transcript"][data-title="${title}"] [data-testid="qual-transcript-open"]`);
  const speakers = await page.$$eval('[data-testid="qual-speaker"]', (es) => es.map((e) => e.dataset.label));
  assert.deepEqual(speakers.sort(), ["Moderator", "P1", "P2"]);
  const roles = await page.$$eval('[data-testid="qual-segment"]', (rs) => rs.map((r) => r.dataset.role));
  assert.ok(roles.filter((r) => r === "moderator").length >= 1 && roles.filter((r) => r === "participant").length >= 2, roles.join(","));
  /* each speaker's words are their own chunks' transcripts (the fake STT says "… a simulated transcript of a N-second answer") */
  const bySpeaker = await page.$$eval('[data-testid="qual-segment"]', (rs) => { const o = {}; for (const r of rs) { const sp = r.children[1]?.textContent.replace(/\s*\(mod\).*$/, "").trim(); o[sp] = (o[sp] ?? "") + " " + r.children[3]?.textContent; } return o; });
  for (const sp of ["Moderator", "P1", "P2"]) assert.match(bySpeaker[sp] ?? "", /simulated/, `${sp}: ${JSON.stringify(bySpeaker).slice(0, 300)}`);
  ok(`“${title}”: Moderator, P1 and P2 from their own recordings, ${roles.length} turns ordered by time, in the coding workspace`);
}

/* a dev server restarting mid-load leaves a chunk-load / hydration error on the page the retry then reloaded — that is the
   environment, not the product; every other page error fails the suite */
const restartNoise = (e) => /ChunkLoadError|Loading chunk .* failed|error while hydrating/.test(e);
if (pageErrors.some(restartNoise)) console.log(`  (ignored ${pageErrors.filter(restartNoise).length} page error(s) from a server restart mid-load)`);
assert.deepEqual(pageErrors.filter((e) => !restartNoise(e)), [], pageErrors.join("\n"));
await browser.close();
console.log(`\nlive-session-test: ${passed} passed`);
