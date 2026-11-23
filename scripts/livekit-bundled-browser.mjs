/**
 * Browser check — the BUNDLED LiveKit client (2026-11-23), in Chromium with fake camera and microphone, across the
 * two apps (Studio sandbox + runtime, no database, AI_API_URL=fake:):
 *
 * Two parts, because the two development servers and a browser do not fit in this sandbox's memory together:
 *
 *   PART=studio   (the Studio only)
 *     1  with LiveKit configured, scheduling offers "Connection: LiveKit" by default; a room for 8 (over the
 *        built-in 6) is scheduled on it
 *     2  the moderator's console loads livekit-client from the Studio's own origin (no LIVEKIT_CLIENT_URL) and
 *        opens LiveKit's signalling socket at LIVEKIT_URL/rtc with the token the server minted: HS256 under
 *        LIVEKIT_API_SECRET, iss = the API key, sub = the member, the room's id, publish allowed
 *     3  the stand-in refuses (it is not LiveKit) → the console says LiveKit is unreachable and why
 *   PART=runtime  (the Studio's API — no Studio page — and the runtime)
 *     4  a room scheduled through the API (LiveKit by default); the participant joins from the runtime link and
 *        waits — nothing is downloaded from LiveKit or sent to it from the waiting room
 *     5  once admitted, the participant page loads livekit-client from the runtime's own origin and opens /rtc
 *        with its own valid token; the stand-in refuses → back on the built-in connection, with no
 *        "reconnecting" warning shown to the participant
 *   PART=both     (the default) part 1 then part 2, for a machine with the memory for it
 *
 * Media over the built-in connection after the fall back is the unchanged mesh path (scripts/live-session-test.mjs).
 *
 * There is no real LiveKit server here (none can be downloaded in this environment): what a real server does after
 * the socket opens — the protobuf join, WebRTC to the SFU — is NOT exercised. The stand-in only records the
 * connection attempts.
 *
 * Start both apps with the stand-in's settings, e.g.
 *   LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=<32+ chars> AI_API_URL=fake: (both apps)
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
 *     node scripts/livekit-bundled-browser.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const SECRET = process.env.LIVEKIT_API_SECRET;
const PORT = Number(process.env.LIVEKIT_STANDIN_PORT ?? 7880);
assert.ok(SECRET, "LIVEKIT_API_SECRET (the same as the apps') is needed to check the tokens");
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const SLOW = 120000;
const TITLE = `LK ${Date.now().toString(36)}`;

/* ------------------------------------------------------------ the stand-in signalling server */
const attempts = [];
const standin = createServer((req, res) => {
  attempts.push({ kind: "http", url: req.url });
  res.writeHead(503, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  res.end("stand-in: not a LiveKit server");
});
standin.on("upgrade", (req, socket) => {
  attempts.push({ kind: "ws", url: req.url });
  socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((r) => standin.listen(PORT, "127.0.0.1", r));

const verify = (jwt) => {
  const [h, p, s] = jwt.split(".");
  const want = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  assert.equal(s, want, "the token is signed with LIVEKIT_API_SECRET");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "HS256");
  return JSON.parse(Buffer.from(p, "base64url"));
};

const DEF = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "LK", title: "LiveKit check", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  qualStudy: {
    kind: "focus_group", title: "Broadband", objectives: ["Reactions to the price"],
    consent: { statement: "You agree to take part in a research discussion.", recordingDisclosure: "The session is recorded (audio).", dataUse: "Quotes are anonymised." },
    sections: [{ id: "s1", title: "Warm-up", kind: "opening", minutes: 5, questions: [{ id: "s1q1", text: "Tell us about your provider" }] }],
  },
});

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const pageErrors = [];
const watch = (p, who) => { p.on("pageerror", (e) => { if (!/ChunkLoadError|ResizeObserver/.test(String(e))) pageErrors.push(`${who}: ${e}`); }); return p; };
/* which origin served the livekit-client code to each page (its protobuf type name "livekit.RegionSettings" survives minification and is in no other code) */
const lkScripts = { studio: new Set(), runtime: new Set() };
const sniff = (p, who) => p.on("response", async (r) => {
  if (r.request().resourceType() !== "script") return;
  try { if ((await r.text()).includes("livekit.RegionSettings")) lkScripts[who].add(new URL(r.url()).origin); } catch { /* redirects, aborted */ }
});
const waitFor = (p, fn, arg, ms = SLOW) => p.waitForFunction(fn, arg, { timeout: ms, polling: 500 });
const stats = (p) => p.evaluate(async () => (window.__rescriptLive ? await window.__rescriptLive.client.stats() : []));

const PART = process.env.PART ?? "both";
const checkToken = (claims, id, roomId, who) => {
  const c = claims.find((x) => x.sub === id);
  assert.ok(c, `${who}'s token reached LiveKit's /rtc (attempts: ${JSON.stringify(attempts.map((a) => a.kind + " " + a.url.split("?")[0]))})`);
  assert.equal(c.iss, KEY);
  assert.equal(c.video.room, roomId);
  assert.equal(c.video.roomJoin, true);
  assert.equal(c.video.canPublish, true);
  assert.ok(c.exp > Date.now() / 1000);
};
const claimsSoFar = () => {
  const out = new Map();
  for (const a of attempts.filter((x) => x.url.startsWith("/rtc"))) { const t = new URL(a.url, "http://x").searchParams.get("access_token"); if (t && !out.has(t)) out.set(t, verify(t)); }
  return [...out.values()];
};

try {
  if (PART === "studio" || PART === "both") {
    /* 1 — schedule on LiveKit */
    const studioCtx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["camera", "microphone"] });
    const page = sniff(watch(await studioCtx.newPage(), "studio"), "studio");
    await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: SLOW });
    await page.waitForSelector(".block-badge", { timeout: SLOW });
    await switchMode(page, "studio").catch(() => {});
    await openTab(page, "JSON");
    await page.waitForSelector("textarea.code");
    await page.click('button:has-text("edit")');
    await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(DEF));
    await page.click('button:has-text("validate & apply")');
    await page.waitForTimeout(1200);
    await openTab(page, "Qualitative");
    await page.waitForSelector('[data-testid="qual-panel"]', { timeout: SLOW });
    await page.click('[data-testid="qual-tab-live"]');
    await page.waitForSelector('[data-testid="live-transport"][data-sfu="1"]', { timeout: SLOW });
    assert.equal((await page.textContent('[data-testid="live-sfu"]')).trim(), "LiveKit configured (up to 30 participants)");
    assert.equal(await page.inputValue('[data-testid="live-connection"]'), "sfu", "LiveKit is the default connection");
    assert.equal(await page.getAttribute('[data-testid="live-max"]', "max"), "30");
    await page.fill('[data-testid="live-title"]', TITLE);
    await page.fill('[data-testid="live-max"]', "8");
    await page.fill('[data-testid="live-slots"]', "1");
    await page.click('[data-testid="live-schedule"]');
    await page.waitForSelector(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-detail"]`, { timeout: SLOW });
    const roomId = await page.getAttribute(`[data-testid="live-room"][data-title="${TITLE}"]`, "data-id");
    ok(`LiveKit offered as the default connection; a room for 8 participants (over the built-in 6) scheduled on it — ${roomId}`);

    /* 2, 3 — the moderator's console tries LiveKit with its token, then says it is unreachable */
    await page.click(`[data-testid="live-room"][data-title="${TITLE}"] [data-testid="live-moderate"]`);
    await page.waitForSelector('[data-testid="live-console"][data-phase="preview"]', { timeout: SLOW });
    await waitFor(page, () => { const v = document.querySelector('[data-testid="live-preview"] video'); return v && v.videoWidth > 0; });
    await page.click('[data-testid="live-enter"]');
    await page.waitForSelector('[data-testid="live-console"][data-phase="in"]', { timeout: SLOW });
    await page.waitForSelector('[data-testid="live-sfu-state"][data-state="fallback"]', { timeout: SLOW });
    const modId = await page.getAttribute('[data-testid="live-console"]', "data-member");
    checkToken(claimsSoFar(), modId, roomId, "the moderator");
    assert.ok(attempts.some((a) => a.kind === "ws" && a.url.startsWith("/rtc")), "a websocket was opened to /rtc");
    assert.deepEqual([...lkScripts.studio], [new URL(STUDIO).origin], "the Studio served livekit-client itself");
    ok(`the console loaded the bundled livekit-client from the Studio and opened LIVEKIT_URL/rtc with a valid token (HS256, iss ${KEY}, the moderator, the room, publish allowed)`);
    const note = await page.getAttribute('[data-testid="live-sfu-state"]', "title");
    assert.match(note, /^LiveKit could not be reached \(.+\): using the built-in connection instead\.$/);
    assert.match(await page.textContent('[data-testid="live-sfu-state"]'), /built-in connection \(LiveKit unreachable\)/);
    assert.equal(await page.$('[data-testid="live-reconnecting"]'), null, "the fall back is not shown as reconnecting");
    ok(`LiveKit unreachable → the console says so: “${note.slice(0, 110)}…”`);
    await studioCtx.close();
  }

  if (PART === "runtime" || PART === "both") {
    attempts.length = 0;
    /* 4 — a room through the Studio's API; the participant waits */
    const api = async (path, body) => { const r = await fetch(`${STUDIO}/api/surveys/sandbox/qual/live${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(SLOW) }); const j = await r.json(); assert.ok(r.ok, JSON.stringify(j)); return j; };
    const sch = await api("", { action: "schedule", guide: DEF.qualStudy, sessions: [{ title: `${TITLE} R`, kind: "focus_group", scheduledAt: new Date(Date.now() + 3600_000).toISOString(), timeZone: "UTC", slots: 1, settings: { maxParticipants: 8, durationMinutes: 60, record: false } }] });
    const room = sch.rooms[0];
    assert.equal(room.settings.transport, "sfu", "LiveKit by default through the API too");
    const link = room.invites.find((i) => i.role === "participant").link;
    const mod = await api("", { action: "join", id: room.id, role: "moderator" });
    await api("/room", { action: "op", token: mod.token, op: { op: "open" } });
    const pctx = await browser.newContext({ viewport: { width: 900, height: 900 }, permissions: ["camera", "microphone"] });
    const p1 = sniff(watch(await pctx.newPage(), "P1"), "runtime");
    await p1.goto(link, { waitUntil: "networkidle", timeout: SLOW });
    await p1.waitForSelector('[data-testid="live-page"][data-step="consent"]', { timeout: SLOW });
    await p1.check('[data-testid="live-consent-agree"]');
    await p1.check('[data-testid="live-consent-recording"]').catch(() => {});
    await p1.click('[data-testid="live-consent-continue"]');
    await p1.waitForSelector('[data-testid="live-page"][data-step="device"]', { timeout: SLOW });
    await waitFor(p1, () => { const v = document.querySelector('[data-testid="live-self"] video'); return v && v.videoWidth > 0; });
    await p1.click('[data-testid="live-join"]');
    await p1.waitForSelector('[data-testid="live-room"][data-state="waiting"]', { timeout: SLOW });
    await p1.waitForTimeout(3000);
    assert.equal(attempts.length, 0, "nothing reaches LiveKit from the waiting room");
    assert.equal(lkScripts.runtime.size, 0, "the waiting room does not download livekit-client");
    ok("a room scheduled through the API is on LiveKit by default; P1 waits — nothing downloaded from or sent to LiveKit yet");

    /* 5 — admitted: the bundled client, its own token, the fall back */
    await api("/room", { action: "op", token: mod.token, op: { op: "admit_all" } });
    await p1.waitForSelector('[data-testid="live-room"][data-state="admitted"]', { timeout: SLOW });
    await p1.waitForSelector('[data-testid="live-room"][data-sfu="fallback"]', { timeout: SLOW });
    const p1Id = await p1.getAttribute('[data-testid="live-room"]', "data-member");
    checkToken(claimsSoFar(), p1Id, room.id, "P1");
    assert.ok(attempts.some((a) => a.kind === "ws" && a.url.startsWith("/rtc")), "a websocket was opened to /rtc");
    assert.deepEqual([...lkScripts.runtime], [new URL(RUNTIME).origin], "the runtime served livekit-client itself");
    await p1.waitForTimeout(3000);
    assert.equal(await p1.$('[data-testid="live-reconnecting"]'), null, "the participant is not told it is reconnecting");
    ok("admitted → the participant page loaded the bundled livekit-client from the runtime and opened /rtc with its own valid token; LiveKit unreachable → the built-in connection, no warning to the participant");
  }

  assert.deepEqual(pageErrors, [], pageErrors.join(" | "));
  ok("no page errors");
} finally {
  await browser.close();
  standin.close();
}
console.log(`\nlivekit-bundled-browser: ${passed} passed`);
