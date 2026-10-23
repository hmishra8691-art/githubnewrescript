/**
 * ALERTS AND PANEL RECRUITMENT (2026-10-22, G3) — docs/ALERTS-AND-PANELS-2026-10-22.md.
 *
 * A local test HTTP server stands in for Slack and for a webhook receiver (the Studio's sandbox may reach the local
 * network; a real installation may not). Everything else is real: the Studio's Alerts & panels tab and its routes, the
 * notification service (rules, redaction, signing, the delivery log), the runtime's AI-interview link with the panel
 * entry / dedupe / signed exits, and the group-session link's panel hooks.
 *
 *   1  Alerts & panels: a Slack channel and a signed webhook added (the webhook's signing secret shown once); "Send
 *      test" reaches the test server; three distress rules (Slack, webhook, my bell)
 *   2  panels: Prolific (completion + screen-out codes) and Cint (HMAC-SHA1) connected from the presets; Cint's secret
 *      stored (never shown); its test link is signed and verifies here
 *   3  launch the AI interviews; a Prolific participant screened out → back to Prolific with the screen-out code
 *   4  a Prolific participant in distress → Slack and the webhook receive the alert: redacted (no name, no e-mail), the
 *      pseudonym P<n>, a link to the live view; the webhook's X-Rescript-Signature verifies; the bell counts it
 *   5  a Prolific participant completes → back with ABC123 (code shown); the same PROLIFIC_PID again → refused
 *   6  a Cint participant completes → the end link is signed (verified with the secret)
 *   7  the live view shows panel ids and outcomes; the delivery log; entries and the reconciliation CSV
 *   8  a group session: a panel id joins once, the same id is refused, the end link once the conversation closed
 *   9  no page errors
 *
 *   Studio on :3000 and runtime on :3001, both AI_API_URL=fake: and no database (the sandboxes)
 *   node --experimental-strip-types --no-warnings scripts/alerts-panels-test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions, verifyPanelSignature, panelFromPreset } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the stand-in Slack and webhook receiver */
const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { received.push({ path: req.url, headers: req.headers, raw: body, body: (() => { try { return JSON.parse(body); } catch { return null; } })() }); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HOOK = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (label, fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`); await sleep(250); } };

/* ------------------------------------------------------------ resilience (shared dev servers restart under memory pressure) */
const serverUp = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const a = await fetch(`${STUDIO}/api/notify/channels`, { signal: AbortSignal.timeout(20000) }); // eslint-disable-line
      const b = await fetch(`${RUNTIME}/api/ai-interview/study?token=${"0".repeat(36)}`, { signal: AbortSignal.timeout(20000) });
      if (a.ok && b.status === 404) return;
    } catch { /* restarting */ }
    await sleep(2000);
  }
};
async function until(label, act, done, ms = 45000) {
  for (let attempt = 0; ; attempt++) {
    await act();
    try { return await done(ms); } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`  (${label}: not seen yet — ${String(e.message).split("\n")[0]}; waiting for the servers and doing it again)`);
      await serverUp();
      try { return await done(10000); } catch { /* do it again */ }
    }
  }
}
/* a request to a server that restarted under it is made again once it answers */
const rfetch = async (url, init) => { for (let i = 0; ; i++) { try { return await fetch(url, { ...init, signal: AbortSignal.timeout(120000) }); } catch (e) { if (i >= 4) throw e; await serverUp(); } } };
await serverUp();
{
  const r = await rfetch(`${STUDIO}/api/notify/channels`);
  const b = await r.json();
  assert.equal(b.sandbox, true, "the Studio runs the alerts sandbox (no database, the fake provider)");
  assert.equal(b.secrets.ready, true);
}

/* ------------------------------------------------------------ the study: a short interview guide, AI-moderated, with a screener */
const EMPTY = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "APN", title: "Broadband switching (alerts)", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const SETUP = [
  { op: "create_qual_guide", kind: "interview", title: "Why customers switch", durationMinutes: 10, objectives: ["Understand switching"],
    consent: { statement: "Taking part is voluntary; you can stop at any time." },
    sections: [{ title: "Intro", kind: "opening", script: "Thanks for joining." }, { title: "Switching", questions: ["Tell me about the last time you changed broadband provider."] }, { title: "Close", kind: "closing", questions: ["Is there anything else you would like to add?"] }] },
  { op: "configure_ai_interviews", modes: ["text"], defaultProbing: "none", persona: { name: "Maya" },
    screener: [{ text: "Who pays your household's broadband bill?", options: [{ label: "I do" }, { label: "Someone else", qualifies: false }] }] },
];
const c0 = coerceSurveyActions(SETUP); assert.deepEqual(c0.rejected, []);
const DEF = applySurveyActions(EMPTY, c0.actions); assert.deepEqual(DEF.errors, []);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`studio: ${e}`));
page.on("dialog", (d) => d.accept());
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
/* the sandbox's definition lives in the page: a dev server that restarts can reload it, so it is loaded again when lost */
const loadDef = async (def) => {
  await until("the Studio sandbox", async () => { if (!(await page.$(".block-badge"))) await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 180000 }).catch(() => {}); }, (ms) => page.waitForSelector(".block-badge", { timeout: Math.max(ms, 90000) }));
  await switchMode(page, "studio").catch(() => {});
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
};
const readDef = async () => {
  await switchMode(page, "studio").catch(() => {});
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
let savedDef = DEF.def;
await loadDef(DEF.def);
const openQual1 = async (tab) => { await switchMode(page, "studio").catch(() => {}); await goTab("Qualitative"); await page.waitForSelector('[data-testid="qual-panel"]'); await page.click(`[data-testid="qual-tab-${tab}"]`); await page.waitForTimeout(250); };
/* a Studio dev server that was restarted (out of memory) under the page can leave a click hanging: wait for it and do it again */
const openQual = async (tab) => { try { await openQual1(tab); } catch (e) { console.log(`  (opening ${tab}: ${String(e.message).split("\n")[0]} — waiting for the Studio and doing it again)`); await serverUp(); await openQual1(tab); } };

/*
 * The Studio's sandbox keeps the last panels / rules the tab handed it (a file in the OS temp directory): this suite
 * starts and ends with none, so other suites' links (ai-interview-test's ?pid=, group-session-test's joins) are never
 * judged by this suite's panels.
 */
const resetSandbox = async () => {
  await rfetch(`${STUDIO}/api/surveys/sandbox/panels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", panels: [], reset: true }) });
  await rfetch(`${STUDIO}/api/surveys/sandbox/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", alerts: null }) });
};
await resetSandbox();
/* a failing check still leaves the sandbox clean for the next suite */
process.once("uncaughtException", async (e) => { console.error(e); await resetSandbox().catch(() => {}); server.close(); process.exit(1); });
/* channels left by an earlier run of this suite (the sandbox keeps them in a file): removed, so names are free */
for (const c of (await (await rfetch(`${STUDIO}/api/notify/channels`)).json()).channels) await rfetch(`${STUDIO}/api/notify/channels?id=${encodeURIComponent(c.id)}`, { method: "DELETE" });

console.log("\n1 — channels: Slack and a signed webhook to the local test server; Send test; three distress rules");
let signingSecret;
{
  await openQual("alerts");
  await page.waitForSelector('[data-testid="ap-tab"]');
  await page.waitForSelector('[data-testid="ch-box"]');
  const addChannel = async (kind, name, url) => until(`adding ${name}`, async () => {
    if (await page.$(`[data-testid="ch-row"][data-name="${name}"]`)) return;
    await page.selectOption('[data-testid="ch-kind"]', kind);
    await page.fill('[data-testid="ch-name"]', name);
    await page.fill('[data-testid="ch-url"]', url);
    await page.click('[data-testid="ch-add"]');
  }, (ms) => page.waitForSelector(`[data-testid="ch-row"][data-name="${name}"]`, { timeout: ms }));
  await addChannel("slack", "#research-ops", `${HOOK}/slack/services/T000/B000/XYZsecretTOKEN123`);
  await addChannel("webhook", "ops-hook", `${HOOK}/hook`);
  signingSecret = (await page.textContent('[data-testid="ch-signing-secret"] code')).trim();
  assert.match(signingSecret, /^whsec_[A-Za-z0-9_-]{20,}$/, "the webhook's signing secret is shown once");
  const hint = await page.textContent('[data-testid="ch-row"][data-name="#research-ops"]');
  assert.doesNotMatch(hint, /T000\/B000/, "the webhook address is never shown back in full");
  const list = JSON.stringify(await (await rfetch(`${STUDIO}/api/notify/channels`)).json());
  assert.doesNotMatch(list, /XYZsecretTOKEN|T000\/B000|\/hook"|whsec_/, "nor returned by the API (a masked hint: the host and four characters)");
  const n = received.length;
  await page.click('[data-testid="ch-row"][data-name="#research-ops"] [data-testid="ch-test"]');
  await waitFor("the Slack test", () => received.slice(n).find((x) => x.path.startsWith("/slack/") && /Test alert/.test(x.raw)));
  await page.waitForSelector('[data-testid="ch-row"][data-name="#research-ops"] [data-testid="ch-status"] .badge.success', { timeout: 20000 });
  for (const [kind, to, word] of [["slack", "#research-ops", "Slack #research-ops"], ["webhook", "ops-hook", "Webhook ops-hook"], ["in_app", "@me", "In-app (you"]]) {
    await until(`a ${kind} rule`, async () => {
      if (await page.evaluate((w) => [...document.querySelectorAll('[data-testid="al-rule"]')].some((r) => r.textContent.includes(w)), word)) return;
      if (!(await page.isVisible('[data-testid="al-add"]'))) await page.click('[data-testid="al-rules"] details summary');
      if (!(await page.isChecked('[data-testid="al-ev-ai_interview.distress"]'))) await page.check('[data-testid="al-ev-ai_interview.distress"]');
      await page.selectOption('[data-testid="al-kind"]', kind);
      await page.waitForTimeout(200);
      await page.selectOption('[data-testid="al-to"]', to);
      await page.click('[data-testid="al-add"]');
    }, (ms) => page.waitForFunction((w) => [...document.querySelectorAll('[data-testid="al-rule"]')].some((r) => r.textContent.includes(w)), word, { timeout: ms }));
  }
  const rules = await page.$$eval('[data-testid="al-rule"]', (r) => r.map((x) => x.textContent));
  assert.ok(rules.some((r) => /Distress flagged.*Slack #research-ops.*Webhook ops-hook.*In-app \(you/.test(r)), rules.join(" | "));
  ok(`Slack + webhook channels (masked, secret shown once), test delivered to ${HOOK}; distress → Slack, webhook, bell`);
}

console.log("\n2 — panels: Prolific and Cint from the presets; Cint's secret stored; its test link is signed");
{
  const connect = async (preset, fill) => until(`connecting ${preset}`, async () => {
    if (await page.$(`[data-testid="pn-card"][data-key="${preset}"]`)) return;
    if (!(await page.isVisible('[data-testid="pn-add"]'))) await page.click('[data-testid="pn-box"] details summary');
    await page.selectOption('[data-testid="pn-preset"]', preset);
    await fill();
    await page.click('[data-testid="pn-add"]');
  }, (ms) => page.waitForSelector(`[data-testid="pn-card"][data-key="${preset}"]`, { timeout: ms }));
  await connect("prolific", async () => { await page.fill('[data-testid="pn-code"]', "ABC123"); await page.fill('[data-testid="pn-screenout-code"]', "SCR9"); });
  await connect("cint", async () => { await page.fill('[data-testid="pn-code"]', ""); await page.fill('[data-testid="pn-screenout-code"]', ""); });
  assert.match(await page.textContent('[data-testid="pn-card"][data-key="prolific"] [data-testid="pn-entry-link"]'), /rp=prolific&PROLIFIC_PID=\{\{%PROLIFIC_PID%\}\}&STUDY_ID=\{\{%STUDY_ID%\}\}&SESSION_ID=\{\{%SESSION_ID%\}\}/);
  const cint = '[data-testid="pn-card"][data-key="cint"]';
  /* the sandbox learns the panels from the tab: wait until the server lists both */
  await until("the panels reach the server", async () => {}, (ms) => page.waitForFunction(() => document.querySelectorAll('[data-testid="pn-card"] [data-testid="pn-secret"]').length === 1, null, { timeout: ms }));
  await until("Cint's secret", async () => { await page.fill(`${cint} [data-testid="pn-secret"]`, "cint-s3cret"); await page.click(`${cint} [data-testid="pn-secret-save"]`); }, (ms) => page.waitForSelector(`${cint} [data-testid="pn-secret-state"][data-set="1"]`, { timeout: ms }));
  assert.doesNotMatch(JSON.stringify(await (await rfetch(`${STUDIO}/api/surveys/sandbox/panels`)).json()), /cint-s3cret/, "the secret is never returned");
  await page.selectOption(`${cint} [data-testid="pn-test-outcome"]`, "complete");
  await page.fill(`${cint} [data-testid="pn-test-pid"]`, "R-TEST-1");
  await page.click(`${cint} [data-testid="pn-test-go"]`);
  await page.waitForSelector(`${cint} [data-testid="pn-test-url"][data-signed="1"]`);
  const testUrl = (await page.textContent(`${cint} [data-testid="pn-test-url"]`)).trim();
  assert.match(testUrl, /^https:\/\/samplicio\.us\/router\/ClientCallBack\.aspx\?RIS=10&RID=R-TEST-1&hash=[A-Za-z0-9_-]+$/);
  assert.ok(verifyPanelSignature(testUrl, panelFromPreset("cint").signing, "cint-s3cret", (alg, data, secret) => createHmac(alg === "hmac-sha256" ? "sha256" : "sha1", secret).update(data).digest()), "HMAC-SHA1 over the URL, base64url, verifies with the secret");
  savedDef = await readDef();
  assert.equal(savedDef.panels.length, 2); assert.equal(savedDef.alerts.rules.length, 1);
  ok("Prolific (codes ABC123 / SCR9) and Cint connected; Cint's secret sealed; its test link is signed and verifies");
}

console.log("\n3 — launch; a Prolific participant screened out goes back with the screen-out code");
let link = null;
const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
/* each participant is a different person: a fresh phone (the page keeps its resume token per link) */
const participant = async (query) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on("close", () => { void ctx.close().catch(() => {}); });
  p.on("pageerror", (e) => pageErrors.push(`participant: ${e}`));
  await until("the interview link", () => p.goto(`${link}${query}`, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {}), (ms) => p.waitForSelector('[data-testid="ai-consent"], [data-testid="ai-closed"]', { timeout: ms }));
  return p;
};
const start = async (p, answer = "I do") => {
  for (let i = 0; i < 40 && !(await p.isChecked('[data-testid="ai-agree"]')); i++) { await p.check('[data-testid="ai-agree"]').catch(() => {}); await p.waitForTimeout(250); }
  await p.check(`[data-testid="ai-screener-question"] label:has-text("${answer}") input`);
  await p.click('[data-testid="ai-start"]');
  await p.waitForSelector('[data-testid="ai-chat"], [data-testid="ai-screened"], [data-testid="ai-error"]', { timeout: 60000 });
};
const say = async (p, text) => {
  const n = await p.$$eval('[data-testid="ai-turn-moderator"]', (e) => e.length);
  await p.fill('[data-testid="ai-input"]', text);
  await p.keyboard.press("Enter");
  await p.waitForFunction((c) => document.querySelectorAll('[data-testid="ai-turn-moderator"]').length > c || document.querySelector('[data-testid="ai-done"]'), n, { timeout: 60000 });
};
/*
 * A participant's journey, done again if a server restarted under it (the runtime's sandbox forgets its studies on a
 * restart: the study is launched again; a panel id is single-use, so a repeat uses a fresh one) — never a skipped check.
 */
const ids = {};
const RUN = Date.now().toString(36).slice(-5);
const launch = async () => {
  await openQual("ai").catch(() => {});
  if (!(await page.$('[data-testid="ai-setup"][data-configured="1"]'))) { await loadDef(savedDef); await openQual("ai"); }
  await page.waitForSelector('[data-testid="ai-setup"][data-configured="1"]');
  const gone = link ? (await rfetch(`${RUNTIME}/api/ai-interview/study?token=${link.split("/i/")[1]}`)).status === 404 : false;
  /* a restarted runtime forgot the sandbox's study: the tab's handle on it is dropped and the tab opened afresh, so Launch is offered again */
  if (gone) { await page.evaluate(() => sessionStorage.removeItem("rescript.aiInterviews.sandboxKey")); await page.click('[data-testid="qual-tab-guide"]'); await page.waitForTimeout(300); await page.click('[data-testid="qual-tab-ai"]'); await page.waitForSelector('[data-testid="ai-setup"]'); }
  /* the tab's view loads from the runtime (Launch stays disabled until it has): wait for either; a reloading Studio gets the tab opened afresh */
  await until("launch", async () => {
    const live = '[data-testid="ai-study"][data-status="live"]', ready = '[data-testid="ai-launch-btn"]:not([disabled])';
    if (!(await page.waitForSelector(`${live}, ${ready}`, { timeout: 45000 }).catch(() => null))) { await openQual("guide").catch(() => {}); await openQual("ai").catch(() => {}); await page.waitForSelector(`${live}, ${ready}`, { timeout: 45000 }).catch(() => null); }
    if (!(await page.$(live))) await page.click(ready, { timeout: 15000 }).catch(() => {});
  }, (ms) => page.waitForSelector('[data-testid="ai-study"][data-status="live"]', { timeout: ms }));
  link = await page.inputValue('[data-testid="ai-link"]');
  /* the sandbox learns the panels from the Alerts & panels tab: hand them over again (a restarted Studio keeps them in its file) */
  await openQual("alerts");
  await page.waitForSelector('[data-testid="pn-card"][data-key="cint"]');
  await openQual("ai");
};
async function journey(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn((pid) => (ids[pid] = `${pid}-${RUN}${attempt ? `-r${attempt}` : ""}`)); }
    catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  (${label}: ${String(e.message).split("\n")[0]} — waiting for the servers and doing it again with a fresh panel id)`);
      await serverUp();
      await launch();
    }
  }
}
const finish = async (p) => { for (let i = 0; i < 8 && !(await p.$('[data-testid="ai-done"]')); i++) await say(p, i === 0 ? "The price went up twice, so I compared offers and moved to a cheaper fibre plan." : "No, nothing more to add — thank you."); await p.waitForSelector('[data-testid="ai-done"]', { timeout: 30000 }); };
{
  await launch();
  assert.match(link, /\/i\/[0-9a-f]{36}$/);
  await journey("screen-out", async (pid) => {
    const p = await participant(`?PROLIFIC_PID=${pid("pp-screened")}&STUDY_ID=st1&SESSION_ID=se1`);
    try {
      const begun = [];
      p.on("response", (r) => { if (r.url().includes("/api/ai-interview/begin")) begun.push(r.text().catch(() => "")); });
      await start(p, "Someone else");
      await p.waitForSelector('[data-testid="ai-screened"]');
      const href = await p.getAttribute('[data-testid="ai-redirect"]', "href", { timeout: 5000 }).catch(async (e) => {
        const panels = await (await rfetch(`${STUDIO}/api/surveys/sandbox/panels`)).text().catch(() => "?");
        console.log(`  (diagnostic: card ${JSON.stringify((await p.textContent('[data-testid="ai-screened"]')).slice(0, 300))}; begin ${(await Promise.all(begun)).join(" | ").slice(-600)}; studio panels ${panels.slice(0, 300)})`);
        throw e;
      });
      assert.equal(href, "https://app.prolific.com/submissions/complete?cc=SCR9");
    } finally { await p.close(); }
  });
  ok("launched; screened out → https://app.prolific.com/submissions/complete?cc=SCR9");
}

console.log("\n4 — distress: Slack and the webhook get a redacted alert with the pseudonym and a link; the signature verifies; the bell");
{
  let p, slack, hook;
  await journey("distress", async (pid) => {
    const n = received.length;
    p = await participant(`?PROLIFIC_PID=${pid("pp-distress")}&STUDY_ID=st1&SESSION_ID=se2`);
    await start(p);
    await say(p, "Honestly some days I can't go on. My name is Priya Sharma, write to priya.sharma@example.com or call +91 98765 43210.");
    slack = await waitFor("the Slack alert", () => received.slice(n).find((x) => x.path.startsWith("/slack/") && /Distress flagged/.test(x.raw)));
    hook = await waitFor("the webhook alert", () => received.slice(n).find((x) => x.path === "/hook" && x.body?.type === "ai_interview.distress"));
  });
  for (const x of [slack, hook]) {
    assert.doesNotMatch(x.raw, /Priya|Sharma|priya\.sharma|98765/, "no name, e-mail or phone in the alert");
    assert.match(x.raw, /can't go on/, "a short redacted excerpt");
    assert.match(x.raw, /\[name\]/); assert.match(x.raw, /\[email\]/);
  }
  const blocks = slack.body.blocks;
  assert.match(blocks[0].text.text, /^URGENT: Distress flagged in an AI interview/);
  assert.ok(blocks.every((b) => !b.text || b.text.type === "plain_text"), "participant words only as plain_text");
  const button = blocks.find((b) => b.type === "actions").elements[0];
  assert.match(button.url, /\/sandbox\?mode=studio&tab=qualitative&qual=ai&interview=[0-9a-f-]{36}$/, "a link to the live view");
  assert.match(hook.body.participant, /^P\d+$/);
  assert.equal(hook.body.severity, "critical");
  assert.match(hook.body.link, /qual=ai&interview=/);
  const sig = hook.headers["x-rescript-signature"];
  const [t, v1] = [/t=(\d+)/.exec(sig)[1], /v1=([0-9a-f]{64})/.exec(sig)[1]];
  assert.equal(v1, createHmac("sha256", signingSecret).update(`${t}.${hook.raw}`).digest("hex"), "the receiver verifies HMAC-SHA256(secret, t.body)");
  assert.ok(hook.headers["idempotency-key"]?.startsWith("ai_interview.distress:"), "an idempotency key");
  /* the participant stops: the interview ends as flagged */
  if (await p.$('[data-testid="ai-stop"]')) await p.click('[data-testid="ai-stop"]'); else await say(p, "I want to stop.");
  await p.waitForSelector('[data-testid="ai-done"]', { timeout: 30000 }).catch(() => {});
  await p.close();
  /* the bell polls every 20 s */
  await page.waitForSelector('[data-testid="bell-count"]', { timeout: 60000 });
  await page.click('[data-testid="bell-button"]');
  await page.waitForSelector('[data-testid="bell-item"][data-severity="critical"]');
  assert.doesNotMatch(await page.textContent('[data-testid="bell-list"]'), /Priya|priya\.sharma/);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="bell-list"]', { state: "detached" });
  ok(`Slack: ${blocks[0].text.text.slice(0, 50)}… (redacted, ${hook.body.participant}, live-view link); webhook signed (t=${t}); in the bell`);
}

console.log("\n5 — a Prolific participant completes → back with ABC123; the same PROLIFIC_PID again is refused");
{
  await journey("complete", async (pid) => {
    const p = await participant(`?PROLIFIC_PID=${pid("pp-complete")}&STUDY_ID=st1&SESSION_ID=se3`);
    try {
      await start(p);
      await finish(p);
      assert.equal(await p.getAttribute('[data-testid="ai-redirect"]', "href", { timeout: 5000 }), "https://app.prolific.com/submissions/complete?cc=ABC123");
      assert.match(await p.textContent('[data-testid="ai-code"]'), /ABC123/);
    } finally { await p.close(); }
  });
  const again = await participant(`?PROLIFIC_PID=${ids["pp-complete"]}&STUDY_ID=st1&SESSION_ID=se9`);
  await start(again);
  await again.waitForSelector('[data-testid="ai-screened"]', { timeout: 15000 }).catch(async (e) => { console.log("  (page shows:", (await again.textContent("body")).slice(0, 400), ")"); throw e; });
  assert.match(await again.textContent('[data-testid="ai-screened"]'), /already taken part/);
  assert.equal(await again.$('[data-testid="ai-chat"]'), null, "no interview");
  await again.close();
  /* two panels share the link: one named by ?rp= without its id is refused (a link with no panel at all passes, as before) */
  const none = await participant("?rp=prolific");
  await start(none);
  await none.waitForSelector('[data-testid="ai-screened"]');
  assert.match(await none.textContent('[data-testid="ai-screened"]'), /needs your Prolific id|PROLIFIC_PID|start again from/i);
  await none.close();
  ok("complete → cc=ABC123 (code shown); the same PROLIFIC_PID refused; ?rp=prolific without the id refused");
}

console.log("\n6 — a Cint participant completes → the end link is signed and verifies");
{
  let href;
  await journey("cint", async (pid) => {
    const p = await participant(`?rp=cint&RID=${pid("rid-7")}`);
    try {
      await start(p);
      await finish(p);
      href = await p.getAttribute('[data-testid="ai-redirect"]', "href", { timeout: 5000 });
      assert.match(href, new RegExp(`^https://samplicio\\.us/router/ClientCallBack\\.aspx\\?RIS=10&RID=${ids["rid-7"]}&hash=`));
    } finally { await p.close(); }
  });
  assert.ok(verifyPanelSignature(href, panelFromPreset("cint").signing, "cint-s3cret", (alg, data, secret) => createHmac("sha1", secret).update(data).digest()));
  ok(`Cint complete → ${href.slice(0, 80)}… (HMAC-SHA1 verified)`);
}

console.log("\n7 — the live view shows panel ids and outcomes; the delivery log; entries and the reconciliation CSV");
{
  await openQual("ai");
  await until("panel ids in the live view", () => page.waitForTimeout(500), (ms) => page.waitForSelector(`[data-testid="ai-panel"][data-pid="${ids["pp-complete"]}"][data-outcome="complete"]`, { timeout: ms }));
  for (const [key, outcome] of [["rid-7", "complete"], ["pp-screened", "screenout"]]) {
    try {
      await page.waitForSelector(`[data-testid="ai-panel"][data-pid="${ids[key]}"][data-outcome="${outcome}"]`, { timeout: 15000 });
    } catch (e) {
      const chips = await page.$$eval('[data-testid="ai-panel"]', (els) => els.map((el) => `${el.dataset.panel}:${el.dataset.pid}:${el.dataset.outcome}`));
      const entries = await (await rfetch(`${STUDIO}/api/surveys/sandbox/panels`)).text();
      throw new Error(`${key} (${ids[key]}) not shown as ${outcome}; chips ${JSON.stringify(chips)}; entries ${entries.slice(0, 1500)}`);
    }
  }
  await openQual("alerts");
  await page.waitForSelector('[data-testid="dl-row"][data-channel="slack"][data-status="sent"][data-event="ai_interview.distress"]', { timeout: 20000 });
  assert.ok(await page.$('[data-testid="dl-row"][data-channel="webhook"][data-status="sent"]'));
  assert.ok(await page.$('[data-testid="dl-row"][data-channel="in_app"][data-status="sent"]'));
  await page.waitForSelector(`[data-testid="pn-entry"][data-pid="${ids["pp-complete"]}"][data-outcome="complete"]`);
  const csv = await (await rfetch(`${STUDIO}/api/surveys/sandbox/panels?export=reconciliation`)).text();
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines[0], "panel,panel_id,outcome,status,link,started_at,ended_at,test");
  assert.ok(lines.some((l) => l.startsWith(`prolific,${ids["pp-complete"]},complete,`)), csv);
  assert.ok(lines.some((l) => l.startsWith(`prolific,${ids["pp-screened"]},screenout,`)));
  assert.ok(lines.some((l) => l.startsWith(`cint,${ids["rid-7"]},complete,`)));
  ok(`live view: pp-complete / rid-7 complete, pp-screened screen-out; log: slack, webhook, bell sent; CSV ${lines.length - 1} rows`);
}

console.log("\n8 — a group session: one entry per panel id; the end link once the conversation has closed");
{
  const sb = (body) => rfetch(`${STUDIO}/api/surveys/sandbox/qual/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const g = await sb({ action: "create", title: "Panel group", prompts: ["What matters most when you choose broadband?"] });
  assert.ok(g.ok, JSON.stringify(g));
  const list = await (await rfetch(`${STUDIO}/api/surveys/sandbox/qual/groups`)).json();
  const code = list.sessions.find((s) => s.id === g.id).joinCode;
  const rt = (body) => rfetch(`${RUNTIME}/api/group`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const j1 = await rt({ action: "join", consent: true, params: { PROLIFIC_PID: `pp-group-${RUN}`, STUDY_ID: "st1" } });
  assert.equal(j1.status, 200, JSON.stringify(j1.body));
  const j2 = await rt({ action: "join", consent: true, params: { PROLIFIC_PID: `pp-group-${RUN}` } });
  assert.equal(j2.status, 409); assert.equal(j2.body.code, "panel_duplicate");
  const j3 = await rt({ action: "join", consent: true, params: { PROLIFIC_PID: ids["pp-complete"] } });
  assert.equal(j3.body.code, "panel_duplicate", "a panel id that took part in the AI interviews is the same person");
  await sb({ action: "close", id: g.id });
  const v = await rt({ action: "view", token: j1.body.token });
  assert.equal(v.body.panel?.url, "https://app.prolific.com/submissions/complete?cc=ABC123");
  ok("joined once with PROLIFIC_PID; the same id (and an AI-interview id) refused; closed → cc=ABC123");
}

console.log("\n9 — no page errors");
{
  assert.deepEqual(pageErrors, []);
  ok("no page errors in the Studio or on the participant's phone");
}

await browser.close();
await resetSandbox();
server.close();
console.log(`\n${passed} passed`);
