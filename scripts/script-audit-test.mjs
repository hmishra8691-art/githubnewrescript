/**
 * Browser suite — S1c items 3 and 4 (docs/S1-ONE-SCRIPT-ENGINE-2026-10-30.md part C). Studio sandbox only (no DB,
 * no runtime needed).
 *
 *   A  legacy    a survey carrying old Custom code moved into a behaviour (`$`, `window`) and an imported Scripts-panel
 *                script the gate refuses (`window`, `setTimeout`): Survey Settings → Scripts shows the "will not run"
 *                banner with both, the names, the reasons, and "Show the code" reveals the code
 *   B  audit     editing the code of "Spend band" in the Scripts panel, then switching it off, writes two entries to
 *                the sandbox's script audit log (script.changed — passed the check; script.disabled); the log holds
 *                hashes and never the code; Versions → Script history shows the lines
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/script-audit-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allErrors = [];
const NEW_CODE = "setCalc('BAND', get('Q1') ? 2 : 1); // MARKER-NEW-CODE";

const def = {
  meta: { id: "sa", code: "SA", title: "Script audit", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick one", settings: {}, options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [
    { id: "s_band", name: "Spend band", scope: "survey", event: "on_submit", enabled: true, code: "setCalc('BAND', 1);" },
    { id: "s_old", name: "Old timer", scope: "survey", event: "on_load", enabled: false, code: "window.setTimeout(function () { set('Q1', 1); }, 10);", notes: "Script check: refused — window is not available." },
  ],
  ux: { styles: [], animations: [], behaviors: [
    { id: "uxb_q_q1", label: "Q1 custom JavaScript", target: { kind: "question", questionId: "q1" }, effects: [], source: "question_custom_js",
      script: "(function (el, api) {\n$('.legacy-box').hide(); window.legacyFlag = 1;\n})(document.querySelector('[data-qid=\"q1\"]'), {});" },
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
const auditLog = async () => (await fetch(`${STUDIO}/api/surveys/sandbox/script-audit`, { cache: "no-store" })).json();

/* ================================================================================================ A */
console.log("\nA code that will not run is listed where scripts are edited");
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
watch(page, "studio");
await page.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, def);
await goto(page, `${STUDIO}/sandbox?tab=scripts`);
await page.waitForSelector('[data-testid="legacy-scripts-banner"]', { timeout: 180000 });
const items = page.locator('[data-testid="legacy-scripts-banner"] [data-testid="legacy-script"]');
assert.equal(await items.count(), 2, await page.textContent('[data-testid="legacy-scripts-banner"]'));
const banner = await page.textContent('[data-testid="legacy-scripts-banner"]');
assert.match(banner, /2 scripts will not run/, banner);
assert.match(banner, /Q1 custom JavaScript/);
assert.match(banner, /question Q1's Custom code/);
assert.match(banner, /Old timer/);
const ux = page.locator('[data-testid="legacy-script"][data-id="uxb_q_q1"]');
const uxText = await ux.textContent();
assert.match(uxText, /uses \$, window/, uxText);
assert.match(uxText, /jQuery is not loaded/, uxText);
ok(`Scripts panel banner: 2 scripts will not run — "${uxText.replace(/\s+/g, " ").slice(0, 110)}…"`);
await ux.locator('[data-testid="legacy-script-show"]').click();
const shown = await ux.locator('[data-testid="legacy-script-code"]').textContent();
assert.ok(shown.includes("$('.legacy-box').hide()"), shown);
ok("Show the code reveals the moved code");

/* ================================================================================================ B */
console.log("\nB a code change and a switch-off are written to the script audit log");
await sleep(2500); // the editor's baseline reaches the server
const before = await auditLog();
const n0 = before.entries.length;
const card = page.locator(".card", { has: page.locator('input[value="Spend band"]') });
const ta = card.locator('[data-testid="script-code"]');
await ta.fill(NEW_CODE);
await card.locator('[data-testid="script-save"]').click();
let log = null;
for (let i = 0; i < 40; i++) { log = await auditLog(); if (log.entries.length > n0) break; await sleep(500); }
const changed = log.entries.find((e) => e.action === "script.changed" && e.detail.itemId === "s_band");
assert.ok(changed, JSON.stringify(log.entries));
assert.equal(changed.detail.verdict, "passed");
assert.match(changed.text, /^Logic script ‘Spend band’ changed by You \(sandbox\) — passed the check$/, changed.text);
assert.equal(String(changed.detail.afterHash).length, 16);
assert.notEqual(changed.detail.beforeHash, changed.detail.afterHash);
ok(`audit entry: "${changed.text}" (${String(changed.detail.beforeHash).slice(0, 8)} → ${String(changed.detail.afterHash).slice(0, 8)})`);
await card.locator('[data-testid="script-enabled"]').uncheck();
for (let i = 0; i < 40; i++) { log = await auditLog(); if (log.entries.some((e) => e.action === "script.disabled")) break; await sleep(500); }
const off = log.entries.find((e) => e.action === "script.disabled" && e.detail.itemId === "s_band");
assert.ok(off, JSON.stringify(log.entries));
assert.ok(!JSON.stringify(log).includes("MARKER-NEW-CODE"), "the log never holds the code");
assert.ok(!JSON.stringify(log).includes("setCalc"), "the log never holds the code");
ok(`switch-off: "${off.text}"; the log holds no code (${log.entries.length} entries)`);
await page.close();

{
  const v = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  watch(v, "versions");
  await v.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, def);
  await goto(v, `${STUDIO}/sandbox?tab=versions`);
  await v.waitForSelector('[data-testid="script-audit-line"]', { timeout: 120000 });
  const lines = await v.locator('[data-testid="script-audit-line"]').allTextContents();
  assert.ok(lines.some((l) => /Logic script ‘Spend band’ changed by You \(sandbox\) — passed the check/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /Logic script ‘Spend band’ switched off by You \(sandbox\)/.test(l)), lines.join("\n"));
  ok(`Versions → Script history shows ${lines.length} line(s): "${lines[0].replace(/\s+/g, " ").slice(0, 120)}"`);
  await v.close();
}

await browser.close();
assert.deepEqual(allErrors, [], allErrors.join("\n"));
console.log(`\nscript-audit-test: ${passed} passed`);
