/**
 * Browser suite — S1c item 2: LIVE SCRIPT HEALTH (docs/S1-ONE-SCRIPT-ENGINE-2026-10-30.md part C). Runtime + Studio
 * sandbox (fake provider, no DB).
 *
 *   A  field     a sandbox TEST LINK whose survey has a UX script that throws on every page open (and once more with
 *                the respondent's typed answer in the message), and a Scripts-panel script that throws on submit;
 *                two respondent sessions complete it; each saved row holds `script_health` (ux_error, logic_error,
 *                counts, page, browser class) — and the typed answer is NOT in any stored message
 *   B  studio    the Studio sandbox on that survey (`?tab=scripts&health=<token>`): the summary says 2 of 2 sessions
 *                had a failure, the Scripts-panel script's chip says "failed in 2 of 2 sessions", its popover shows the
 *                message; the summary lists the UX script (Broken widget) too, without the typed answer
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/script-health-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allErrors = [];
const SECRET = "Zebra Quartz";

const def = {
  meta: { id: "sh", code: "SH", title: "Script health", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Your favourite word?", settings: {} },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Pick one", settings: {}, options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "end", id: "e", status: "complete" },
  ],
  scripts: [
    { id: "s_thrower", name: "Spend band", scope: "survey", event: "on_submit", enabled: true, code: "if (get('Q1')) throw new Error('spend band failed');" },
  ],
  ux: { styles: [], animations: [], behaviors: [
    { id: "uxb_thrower", label: "Broken widget", target: { kind: "question", questionId: "q1" }, effects: [],
      script: `rs.listen("change", "self", function (e) { throw new Error("cannot use " + e.value); });\nthrow new Error("widget failed on open");` },
  ] },
};

const browser = await chromium.launch();
async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 180000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const watch = (pv, tag) => { pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${tag}: ${e.message}`); }); };
const post = async (body) => (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

/* warm the Studio first: compiling /sandbox while the runtime holds its pages is what runs this box out of memory */
{
  const w = await browser.newPage();
  await goto(w, `${STUDIO}/sandbox?tab=scripts&health=${"0".repeat(24)}`);
  await w.waitForSelector('[data-testid="script-health-summary"]', { timeout: 180000 });
  await w.close();
}

/* ================================================================================================ A */
console.log("\nA two respondent sessions in the field");
const launch = await post({ action: "launch", definition: def });
assert.ok(launch.url && launch.token, JSON.stringify(launch));
const sessions = [];
for (let n = 1; n <= 2; n++) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const a = await ctx.newPage();
  watch(a, `session ${n}`);
  await goto(a, `${RUNTIME}${launch.url}`);
  await a.waitForSelector('[data-qid="q1"]', { timeout: 60000 });
  await sleep(1000); // the frame starts and throws
  await a.fill('[data-qid="q1"] textarea, [data-qid="q1"] input', SECRET);
  await sleep(600);
  await a.click('[data-testid="rs-next"]');
  await a.waitForSelector('[data-qid="q2"]', { timeout: 30000 });
  await a.click('[data-qid="q2"] label:has-text("Alpha")');
  await a.click('[data-testid="rs-next"]');
  await a.waitForSelector('[data-testid="rs-end"], .rs-end, [data-rs-end]', { timeout: 30000 }).catch(() => null);
  const sessionId = await a.evaluate(() => window.__rescriptState?.sessionId);
  assert.ok(sessionId, "the session id is visible in a test session");
  let row = null;
  for (let i = 0; i < 60; i++) {
    row = await post({ action: "row", sessionId });
    if (row?.status === "complete" && row.scriptHealth?.length >= 2) break;
    await sleep(250);
  }
  sessions.push(row);
  const kinds = row.scriptHealth.map((e) => `${e.script}:${e.kind}`).sort();
  assert.ok(kinds.includes("uxb_thrower:ux_error"), JSON.stringify(row.scriptHealth));
  assert.ok(kinds.includes("s_thrower:logic_error"), JSON.stringify(row.scriptHealth));
  const ux = row.scriptHealth.find((e) => e.script === "uxb_thrower");
  assert.equal(ux.page, "p1");
  assert.ok(ux.count >= 2, `the open and the change are counted: ${ux.count}`);
  assert.match(ux.browser ?? "", /Chrome/);
  assert.ok(!JSON.stringify(row.scriptHealth).includes(SECRET), `the typed answer never reaches the stored health: ${JSON.stringify(row.scriptHealth)}`);
  ok(`session ${n}: completed; the row holds ${row.scriptHealth.length} health entries (${kinds.join(", ")}), UX count ${ux.count}, page p1, ${ux.browser}, no answer text`);
  await ctx.close();
}
const health = await post({ action: "health", token: launch.token });
assert.equal(health.sessions, 2);
assert.equal(health.affected, 2);
assert.equal(health.scripts.find((x) => x.script === "s_thrower")?.sessions, 2, JSON.stringify(health));
ok(`the runtime's aggregate: ${health.affected} of ${health.sessions} sessions, ${health.scripts.length} scripts`);

/* ================================================================================================ B */
console.log("\nB the Studio shows it where scripts are managed");
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  watch(page, "studio");
  await page.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, def);
  await goto(page, `${STUDIO}/sandbox?tab=scripts&health=${launch.token}`);
  await page.waitForSelector('[data-testid="script-health-summary"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="script-health-totals"]', { timeout: 60000 });
  const totals = await page.textContent('[data-testid="script-health-totals"]');
  assert.match(totals, /2 of 2 sessions had a script failure/, totals);
  ok(`summary: "${totals.trim()}"`);
  const chip = page.locator('[data-testid="script-health-chip"][data-script="s_thrower"]');
  await chip.waitFor({ timeout: 30000 });
  const text = (await chip.textContent()).trim();
  assert.match(text, /failed in 2 of 2 sessions/, text);
  assert.equal(await chip.getAttribute("data-state"), "failed");
  await chip.click();
  const pop = await page.textContent('[data-testid="script-health-popover"]');
  assert.match(pop, /spend band failed/, pop);
  ok(`Scripts panel chip: "${text}"; the popover shows the message`);
  const list = await page.textContent('[data-testid="script-health-list"]');
  assert.match(list, /Broken widget/, list);
  assert.ok(!list.includes(SECRET));
  ok("the summary lists the UX script too (Broken widget), without the typed answer");
  await page.close();
}

await browser.close();
assert.deepEqual(allErrors, [], allErrors.join("\n"));
console.log(`\nscript-health-test: ${passed} passed`);
