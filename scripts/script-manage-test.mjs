/**
 * S3b — MANAGING SCRIPTS in a real browser (Research tools → All code and the script editors).
 *
 *   node scripts/script-manage-test.mjs     (studio :3000 with AI_API_URL=fake:; no runtime needed)
 *
 *   1  enable / disable   a behaviour script switched off in its card header: the row says off, the definition stores
 *                         enabled:false, the sandbox audit log records script.disabled; switched on again
 *   2  duplicate          a behaviour script and a logic script: "(copy)", a new id, switched off
 *   3  all code           one row per code item, kinds / filters, a row opens its editor in place
 *   4  import / export    export every script as a rescript-scripts bundle; import it back with an unmappable item
 *                         added: imported items arrive off, the unmapped one is listed
 *   5  history            an edit, then History: a line diff of THIS script between the session's version and now
 *   6  test run           a script with a runtime error on line 2: Run in a test session → ran-error and an error marker
 *                         on line 2; fixed (not saved) and run again → no error, no marker
 *   7  snippets           "Insert snippet…" puts a snippet in; completion offers "snippet highlight on select"
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTabKey } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ✔ ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const def = {
  meta: { id: "sandbox", code: "SM", title: "Script management", version: "1.0" },
  questions: [
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q_brand", code: "Q2", variableName: "Q2", type: "single_choice", text: "Which brand?", options: [{ code: "1", label: "Coke" }, { code: "2", label: "Pepsi" }] },
    { id: "q_comp", code: "COMP", variableName: "COMP", type: "custom_component", text: "Widget", customHtml: "<div class=\"w\">widget</div>", customJs: "el.classList.add('ready');" },
  ],
  flow: [{ id: "p1", type: "page", questionIds: ["q_age", "q_brand", "q_comp"] }],
  calculations: [{ id: "c1", targetVariable: "TOTAL", label: "Total", expression: "AGE" }],
  scripts: [{ id: "s_calc", name: "Calc", scope: "survey", event: "on_submit", code: "const t = get('AGE');\nlog(t);", enabled: true }],
  branding: { customCss: ".rs-shell { color: #111; }" },
  ux: { styles: [], animations: [], behaviors: [
    { id: "uxb_pop", label: "Pop", target: { kind: "question", questionId: "q_brand" }, effects: [], script: 'rs.listen("select", "self", (e) => {\n  rs.animate("self", "pop");\n});', createdAt: "2026-10-30T00:00:00.000Z" },
  ] },
};

const browser = await chromium.launch();
const pageErrors = [];
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk|ResizeObserver loop/.test(String(e))) pageErrors.push(String(e)); });
page.on("dialog", (d) => d.accept());
await page.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, def);
for (let i = 0; ; i++) {
  try { await page.goto(`${STUDIO}/sandbox?tab=json`, { waitUntil: "networkidle", timeout: 240000 }); break; }
  catch (e) { if (i >= 3) throw e; await sleep(8000); }
}
await page.waitForSelector("textarea.code", { timeout: 120000 });

const P = '[data-testid="allcode-panel"]';
const ED = '[data-testid="allcode-editor"]';
const row = (key) => `${P} [data-testid="allcode-row"][data-key="${key}"]`;
const rows = () => page.$$eval(`${P} [data-testid="allcode-row"]`, (r) => r.map((x) => ({ key: x.getAttribute("data-key"), kind: x.getAttribute("data-kind"), enabled: x.getAttribute("data-enabled"), verdict: x.getAttribute("data-verdict"), name: x.querySelector('[data-testid="allcode-open"]').textContent })));
async function readDef() {
  await openTabKey(page, "json");
  await page.waitForSelector("textarea.code");
  const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  await openTabKey(page, "allcode");
  await page.waitForSelector(`${P} [data-testid="allcode-table"]`);
  return d;
}
async function openRow(key) {
  if (await page.$(`${ED}[data-key="${key}"]`)) return;
  await page.click(`${row(key)} [data-testid="allcode-open"]`);
  await page.waitForSelector(`${ED}[data-key="${key}"]`);
}
const auditLog = async () => (await (await fetch(`${STUDIO}/api/surveys/sandbox/script-audit`, { cache: "no-store" })).json()).entries ?? [];
async function waitFor(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(250); }
}
const markerLines = (sel, sev) => page.$$eval(`${sel} .cm-lintRange-${sev}`, (els) => els.map((el) => { const line = el.closest(".cm-line"); return [...line.parentElement.querySelectorAll(":scope > .cm-line")].indexOf(line) + 1; }));

/* ================================================================================================ 3 */
console.log("\n3 Research tools → All code");
await openTabKey(page, "allcode");
await page.waitForSelector(`${P} [data-testid="allcode-table"]`, { timeout: 120000 });
let rs = await rows();
assert.deepEqual(rs.map((r) => r.key).sort(), ["branding_css:branding:css", "component_html:q_comp:html", "component_js:q_comp:js", "logic_script:s_calc", "ux_script:uxb_pop"]);
assert.equal(rs.find((r) => r.key === "ux_script:uxb_pop").enabled, "true");
assert.equal(rs.find((r) => r.key === "branding_css:branding:css").enabled, "n/a");
assert.match(await page.textContent(row("ux_script:uxb_pop")), /Q2/);
assert.match(await page.textContent(row("logic_script:s_calc")), /on_submit/);
ok(`one row per code item (${rs.length}): kind, where it runs, events, on/off, check verdict`);
await page.selectOption(`${P} [data-testid="allcode-kind"]`, "logic");
assert.deepEqual((await rows()).map((r) => r.key), ["logic_script:s_calc"]);
await page.selectOption(`${P} [data-testid="allcode-kind"]`, "all");
await page.fill(`${P} [data-testid="allcode-search"]`, "animate");
assert.deepEqual((await rows()).map((r) => r.key), ["ux_script:uxb_pop"]);
await page.fill(`${P} [data-testid="allcode-search"]`, "");
ok("filters: kind (logic → 1 row), text search in the code (\"animate\" → the Pop script)");
await openRow("logic_script:s_calc");
assert.equal(await page.$eval(`${ED} [data-testid="script-code"]`, (e) => e.value), "const t = get('AGE');\nlog(t);");
await openRow("ux_script:uxb_pop");
await page.waitForSelector(`${ED} [data-code-editor="ux-script"][data-editor="ready"]`, { timeout: 120000 });
ok("a row opens its own editor in place (logic script card; then the behaviour script card)");

/* ================================================================================================ 1 */
console.log("\n1 enable / disable");
const card = `${ED} [data-testid="ux-item"][data-id="uxb_pop"]`;
await page.uncheck(`${card} [data-testid="ux-item-enabled"]`);
await page.waitForSelector(`${card}[data-enabled="false"] [data-testid="ux-item-off-note"]`);
await waitFor(async () => (await rows()).find((r) => r.key === "ux_script:uxb_pop")?.enabled === "false", "row off");
let d = await readDef();
assert.equal(d.ux.behaviors.find((b) => b.id === "uxb_pop").enabled, false);
const offEntry = await waitFor(async () => (await auditLog()).find((e) => e.action === "script.disabled" && e.detail?.itemId === "uxb_pop"), "script.disabled in the audit log", 30000);
ok(`switched off in the card header: row "off", stored enabled:false, audit "${offEntry.text}"`);
await openRow("ux_script:uxb_pop");
await page.check(`${card} [data-testid="ux-item-enabled"]`);
await waitFor(async () => (await rows()).find((r) => r.key === "ux_script:uxb_pop")?.enabled === "true", "row on");
d = await readDef();
assert.equal("enabled" in d.ux.behaviors.find((b) => b.id === "uxb_pop"), false, "on = the key goes");
await waitFor(async () => (await auditLog()).some((e) => e.action === "script.enabled" && e.detail?.itemId === "uxb_pop"), "script.enabled", 30000);
ok("switched on again: the key is gone, audit script.enabled");

/* ================================================================================================ 2 */
console.log("\n2 duplicate");
await openRow("ux_script:uxb_pop");
await page.click(`${card} [data-testid="ux-item-duplicate"]`);
const copy = await waitFor(async () => (await rows()).find((r) => r.name === "Pop (copy)"), "the copy's row");
assert.equal(copy.enabled, "false");
assert.notEqual(copy.key, "ux_script:uxb_pop");
await openRow("logic_script:s_calc");
await page.click(`${ED} [data-testid="script-duplicate"]`);
const lcopy = await waitFor(async () => (await rows()).find((r) => r.name === "Calc (copy)"), "the logic copy's row");
assert.equal(lcopy.enabled, "false");
d = await readDef();
assert.equal(d.ux.behaviors.length, 2);
assert.equal(d.ux.behaviors[1].label, "Pop (copy)");
assert.equal(d.ux.behaviors[1].script, d.ux.behaviors[0].script);
assert.equal(d.scripts[1].name, "Calc (copy)");
assert.equal(d.scripts[1].enabled, false);
ok(`duplicates: "Pop (copy)" (${copy.key}) and "Calc (copy)" — new ids, same code, switched off`);

/* ================================================================================================ 4 */
console.log("\n4 export / import");
await page.click(`${P} [data-testid="bundle-toggle"]`);
await page.click(`${P} [data-testid="bundle-export-all"]`);
const bundle = JSON.parse(await page.$eval(`${P} [data-testid="bundle-json"]`, (e) => e.value));
assert.equal(bundle.format, "rescript-scripts");
assert.equal(bundle.version, 1);
assert.deepEqual(bundle.items.map((i) => i.name), ["Pop", "Pop (copy)", "Calc", "Calc (copy)"]);
assert.deepEqual(bundle.items[0].target, { kind: "question", question: "Q2" });
assert.ok(!JSON.stringify(bundle).includes("q_brand"), "no question ids in the bundle");
assert.ok(await page.$(`${P} [data-testid="bundle-download"][download]`));
ok("export: rescript-scripts v1, 4 items, targets by question code (no ids), a download link");
bundle.items = [bundle.items[0], bundle.items[2], { kind: "behavior", name: "Elsewhere", code: 'rs.addClass("self", "x");', target: { kind: "question", question: "NOPE" } }];
await page.fill(`${P} [data-testid="bundle-import-text"]`, JSON.stringify(bundle));
await page.click(`${P} [data-testid="bundle-import-check"]`);
await page.waitForSelector(`${P} [data-testid="bundle-preview"]`);
assert.equal(await page.textContent(`${P} [data-testid="bundle-preview"] [data-testid="bundle-added-count"]`), "2");
assert.match(await page.textContent(`${P} [data-testid="bundle-preview"] [data-testid="bundle-unmapped"]`), /Elsewhere.*no question NOPE/);
await page.click(`${P} [data-testid="bundle-import-apply"]`);
await page.waitForSelector(`${P} [data-testid="bundle-import-result"]`);
d = await readDef();
const imported = d.ux.behaviors.filter((b) => /Imported from SM/.test(b.notes ?? ""));
assert.equal(imported.length, 1);
assert.equal(imported[0].enabled, false);
assert.equal(imported[0].target.questionId, "q_brand");
assert.equal(d.scripts.filter((s) => /Imported from SM/.test(s.notes ?? "") && s.enabled === false).length, 1);
ok("import: 2 mapped and imported switched off with a review note (question code Q2 → q_brand), \"Elsewhere\" listed as unmapped");

/* ================================================================================================ 5 + 6 + 7 */
console.log("\n5 history · 6 test run · 7 snippets");
await openRow("ux_script:uxb_pop");
const SC = `${card} [data-code-editor="ux-script"]`;
await page.waitForSelector(`${SC}[data-editor="ready"]`);
// 5: an edit, committed by leaving the field
await page.fill(`${card} [data-testid="ux-script"]`, 'rs.listen("select", "self", (e) => {\n  rs.animate("self", "shake");\n});');
await page.click(`${P} h2`);
await waitFor(async () => (await readDef()).ux.behaviors.find((b) => b.id === "uxb_pop").script.includes("shake"), "the edit saved");
await openRow("ux_script:uxb_pop");
await page.click(`${card} [data-testid="code-history-toggle"]`);
await page.waitForSelector(`${card} [data-testid="code-history-diff"]`, { timeout: 20000 });
const diffAdd = await page.$$eval(`${card} [data-testid="code-history-diff"] [data-op="add"]`, (l) => l.map((x) => x.textContent));
const diffDel = await page.$$eval(`${card} [data-testid="code-history-diff"] [data-op="del"]`, (l) => l.map((x) => x.textContent));
assert.ok(diffAdd.some((t) => t.includes('"shake"')), JSON.stringify(diffAdd));
assert.ok(diffDel.some((t) => t.includes('"pop"')), JSON.stringify(diffDel));
assert.match(await page.textContent(`${card} [data-testid="code-history-stats"]`), /\+1 −1/);
ok("History: this script's code diff between the session's earlier version and now — − pop / + shake (+1 −1), code lines, not JSON");

// 6: a runtime error on line 2 (passes the gate, throws when it runs), unsaved
await page.fill(`${card} [data-testid="ux-script"]`, 'const a = 1;\nnotDefinedAnywhere(a);\nrs.addClass("self", "x");');
await page.click(`${card} [data-testid="code-run"]`);
await page.waitForSelector(`${card} [data-testid="code-run-panel"]`, { timeout: 30000 });
const v1 = await page.getAttribute(`${card} [data-testid="code-run-panel"]`, "data-verdict");
assert.equal(v1, "ran-error", await page.textContent(`${card} [data-testid="code-run-panel"]`));
assert.match(await page.textContent(`${card} [data-testid="code-run-log"]`), /error \(line 2\).*notDefinedAnywhere/);
const errLines = await waitFor(async () => { const l = await markerLines(SC, "error"); return l.length ? l : null; }, "a marker");
assert.deepEqual([...new Set(errLines)], [2]);
ok(`Run in a test session (unsaved text): verdict ran-error, the log names line 2, an error marker on line 2`);
await page.fill(`${card} [data-testid="ux-script"]`, 'const a = 1;\nrs.log("a is", a);\nrs.addClass("self", "x");');
await page.click(`${card} [data-testid="code-run"]`);
await waitFor(async () => { const v = await page.getAttribute(`${card} [data-testid="code-run-panel"]`, "data-verdict").catch(() => null); return v && v !== "ran-error" ? v : null; }, "a clean run", 30000);
const v2 = await page.getAttribute(`${card} [data-testid="code-run-panel"]`, "data-verdict");
assert.ok(["ran-ok", "ran-no-effect"].includes(v2), v2);
assert.match(await page.textContent(`${card} [data-testid="code-run-log"]`), /log.*a is/);
await sleep(600);
assert.deepEqual(await markerLines(SC, "error"), []);
ok(`fixed and run again: verdict ${v2}, the rs.log line is in the run log, no error marker`);

// 7: the snippet menu and the completion entry
await page.fill(`${card} [data-testid="ux-script"]`, "");
await page.click(`${card} [data-testid="ux-script"]`);
await page.selectOption(`${card} [data-testid="code-snippet-menu"]`, "highlight-on-select");
await waitFor(async () => (await page.$eval(`${card} [data-testid="ux-script"]`, (e) => e.value)).includes('rs.addClass("self", "rs-highlight")'), "the snippet inserted");
ok("Insert snippet… → highlight on select is in the editor");
await page.click(`${card} [data-testid="ux-script"]`);
await page.keyboard.press("Control+End");
await page.keyboard.type("\ncountd");
const labels = await waitFor(async () => { const l = await page.$$eval(".cm-tooltip-autocomplete li .cm-completionLabel", (x) => x.map((y) => y.textContent)); return l.includes("snippet countdown display") ? l : null; }, "the snippet completion");
assert.ok(labels.includes("snippet countdown display"));
await page.keyboard.press("Escape");
ok('completion: typing "countd" offers "snippet countdown display" (type snippet)');

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
await browser.close();
console.log(`\nscript-manage-test: ${passed} passed`);
