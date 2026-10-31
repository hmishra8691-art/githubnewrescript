/**
 * THE STUDIO CODE EDITOR (S3a) — every kind of code field, in a real browser.
 *
 *   node scripts/code-editor-test.mjs     (studio :3000 with AI_API_URL=fake:; no runtime needed)
 *
 *   A  lazy chunk   no CodeMirror on a page without a code field; it loads when a code field is shown (size reported)
 *   B  logic        Scripts panel: completion of ctx helpers and a calculation name, a gate error marker on the right
 *                   line, the save refused, search & replace, Format (re-indent), full screen, Esc leaves the editor,
 *                   Mod-S saves, undo inside the editor vs the Studio's undo
 *   C  ux script    Styles, animations & scripts: rs. completion, a question code inside rs.getAnswer("…"), a gate
 *                   error marker on the right line, the reads / writes header
 *   D  component    JavaScript gate marker; HTML sanitiser marker
 *   E  branding     survey custom CSS is saved as typed; the sanitiser marks an @import line
 *   F  fallback     the editor chunk blocked: a plain textarea with the same test id still edits and saves
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const ok = (m) => console.log(`  ✔ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = /codeEditorSetup/;

const def = {
  meta: { id: "sandbox", code: "CE", title: "Code editor", version: "1.0" },
  questions: [
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q_brand", code: "Q2", variableName: "Q2", type: "single_choice", text: "Which brand?", options: [{ code: "1", label: "Coke" }, { code: "2", label: "Pepsi" }] },
    { id: "q_comp", code: "COMP", variableName: "COMP", type: "custom_component", text: "Widget", customHtml: "<div class=\"w\">widget</div>", customJs: "el.classList.add('ready');" },
  ],
  flow: [{ id: "p1", type: "page", questionIds: ["q_age", "q_brand", "q_comp"] }],
  calculations: [{ id: "c1", targetVariable: "TOTAL", label: "Total", expression: "AGE" }],
  scripts: [{ id: "s_calc", name: "Calc", scope: "survey", event: "on_submit", code: "const t = get('AGE');\nlog(t);", enabled: true }],
  ux: { styles: [], animations: [], behaviors: [
    { id: "uxb_pop", label: "Pop", target: { kind: "question", questionId: "q_brand" }, effects: [], script: 'rs.listen("select", "self", (e) => {\n  rs.animate("self", "pop");\n});', createdAt: "2026-10-30T00:00:00.000Z" },
  ] },
};

const browser = await chromium.launch();
const pageErrors = [];
async function open(url, { block = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk|ResizeObserver loop/.test(String(e))) pageErrors.push(String(e)); });
  page.on("dialog", (d) => d.accept());
  if (block) await page.route(CHUNK, (r) => r.abort());
  await page.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, def);
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 240000 }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(8000); }
  }
  return page;
}
const val = (page, testId) => page.$eval(`[data-testid="${testId}"]`, (e) => e.value);
const ready = (page, testId) => page.waitForSelector(`[data-code-editor="${testId}"][data-editor="ready"]`, { timeout: 120000 });
/** the 1-based line of the first lint range of a severity inside an editor */
const markerLines = (page, testId, sev) => page.$$eval(`[data-code-editor="${testId}"] .cm-lintRange-${sev}`, (els) => els.map((el) => {
  const line = el.closest(".cm-line");
  return [...line.parentElement.querySelectorAll(":scope > .cm-line")].indexOf(line) + 1;
}));
const completions = (page) => page.$$eval(".cm-tooltip-autocomplete li .cm-completionLabel", (l) => l.map((x) => x.textContent));
async function waitCompletion(page, label) {
  for (let i = 0; i < 30; i++) { const c = await completions(page); if (c.includes(label)) return c; await sleep(150); }
  throw new Error(`no completion "${label}" (have ${JSON.stringify(await completions(page))})`);
}
async function pick(page, label) {
  await waitCompletion(page, label);
  await sleep(200); // CodeMirror ignores Enter / arrows for 75 ms after the list opens (interactionDelay)
  for (let i = 0; i < 40; i++) {
    const sel = await page.$eval(".cm-tooltip-autocomplete li[aria-selected] .cm-completionLabel", (x) => x.textContent).catch(() => null);
    if (sel === label) { await page.keyboard.press("Enter"); return; }
    await page.keyboard.press("ArrowDown");
    await sleep(100);
  }
  throw new Error(`could not select ${label}: ${JSON.stringify(await page.$$eval(".cm-tooltip-autocomplete li", (l) => l.map((x) => [x.textContent, x.getAttribute("aria-selected")])))} doc=${JSON.stringify(await page.evaluate(() => document.activeElement?.value))}`);
}
async function readDef(page, back) {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  await openTab(page, back);
  return d;
}

/* ================================================================================================ A + B */
console.log("\nA the editor chunk is lazy · B a logic script in the Scripts panel");
const chunkLoads = [];
let chunkBytes = 0;
const page = await open(`${STUDIO}/sandbox?tab=json`);
page.on("response", async (r) => { if (CHUNK.test(r.url())) { chunkLoads.push(r.url()); try { chunkBytes = (await r.body()).length; } catch { /* aborted */ } } });
await page.waitForSelector("textarea.code", { timeout: 120000 });
await sleep(1500);
assert.equal(chunkLoads.length, 0, "the JSON tab (no code editor) did not load CodeMirror");
await openTab(page, "Scripts");
await ready(page, "script-code");
assert.equal(chunkLoads.length, 1, "the chunk loaded once, when the first code field appeared");
ok(`CodeMirror is a separate chunk, loaded only when a code field is shown (${chunkLoads[0].split("/").pop()}, ${(chunkBytes / 1024).toFixed(0)} KiB in dev, unminified)`);

const LOGIC = "script-code";
assert.equal(await val(page, LOGIC), "const t = get('AGE');\nlog(t);");
assert.ok(await page.$(`[data-code-editor="${LOGIC}"] [data-testid="script-health-chip"], [data-code-editor="${LOGIC}"] .code-editor-head`), "header present");
assert.match(await page.textContent(`[data-code-editor="${LOGIC}"] [data-testid="code-editor-refs"]`), /reads AGE/);
ok("header: reads AGE · writes nothing (scriptRefs)");

// completion: a ctx helper, then a calculation name inside its string
await page.click(`[data-testid="${LOGIC}"]`);
await page.keyboard.press("Control+End");
await page.keyboard.type("\nsetC");
await pick(page, "setCalc");
await page.keyboard.type('("');
const calcs = await waitCompletion(page, "TOTAL");
assert.deepEqual(calcs, ["TOTAL"]);
await pick(page, "TOTAL");
assert.match(await val(page, LOGIC), /setCalc\("TOTAL"\)/);
ok('completion: "setC" → setCalc (registry signature), then ("…") offers the calculation TOTAL');

// a gate error marker on the right line, and the save refused
await page.keyboard.press("Control+End");
await page.keyboard.type("\nwindow.x = 1;");
for (let i = 0; i < 20 && !(await markerLines(page, LOGIC, "error")).length; i++) await sleep(200);
assert.deepEqual(await markerLines(page, LOGIC, "error"), [4], "codeGate's `window is not available` is marked on line 4");
const gutter = await page.$$eval(`[data-code-editor="${LOGIC}"] .cm-lint-marker-error`, (l) => l.length);
assert.ok(gutter >= 1, "a gutter marker too");
await page.click("h2:has-text('Custom Scripts')"); // leave the field: the same save as before
await page.waitForSelector('[data-testid="script-refused"]');
assert.match(await page.textContent('[data-testid="script-refused"]'), /window is not available/);
ok("gate error marked on line 4 (range + gutter); leaving the field refuses the save with the gate's reason");

// Mod-S saves valid code
await page.fill(`[data-testid="${LOGIC}"]`, "const t = get('AGE');\nif (t > 10) {\nsetCalc('TOTAL', t);\n}");
await page.keyboard.press("Control+s");
for (let i = 0; i < 20 && (await page.$('[data-testid="script-save"]')); i++) await sleep(150);
assert.equal(await page.$('[data-testid="script-save"]'), null, "Mod-S committed it: nothing left to save");
assert.equal(await page.$('[data-testid="script-refused"]'), null);
ok("Mod-S saves through the gate (no refusal, no unsaved draft)");

// Format = re-indent
await page.click('[data-testid="code-editor-format"]');
assert.equal(await val(page, LOGIC), "const t = get('AGE');\nif (t > 10) {\n  setCalc('TOTAL', t);\n}");
assert.equal(await page.textContent('[data-testid="code-editor-formatted"]'), "re-indented");
ok("Format re-indents the if block (and says it re-indented)");

// search & replace
await page.click(`[data-testid="${LOGIC}"]`);
await page.keyboard.press("Control+f");
await page.waitForSelector(`[data-code-editor="${LOGIC}"] .cm-search input[name=search]`);
await page.fill(`[data-code-editor="${LOGIC}"] .cm-search input[name=search]`, "TOTAL");
await page.fill(`[data-code-editor="${LOGIC}"] .cm-search input[name=replace]`, "SUM_T");
await page.click(`[data-code-editor="${LOGIC}"] .cm-search button[name=replaceAll]`);
assert.match(await val(page, LOGIC), /setCalc\('SUM_T', t\)/);
await page.keyboard.press("Escape"); // closes the panel
await page.waitForSelector(`[data-code-editor="${LOGIC}"] .cm-search`, { state: "detached" });
ok("Ctrl-F opens search; replace-all rewrote TOTAL → SUM_T; Esc closes the panel");

// undo inside the editor is the editor's; the Studio's undo is outside it
await page.click(`[data-testid="${LOGIC}"]`);
await page.keyboard.press("Control+z");
assert.match(await val(page, LOGIC), /setCalc\('TOTAL', t\)/, "the editor undid its own replace");
await page.keyboard.press("Control+s");
await sleep(400);
let d = await readDef(page, "Scripts");
await ready(page, LOGIC);
assert.equal(d.scripts[0].code, "const t = get('AGE');\nif (t > 10) {\n  setCalc('TOTAL', t);\n}", "the survey holds the formatted, un-replaced code");
await page.click(`[data-testid="${LOGIC}"]`);
await page.keyboard.press("Control+End");
await page.keyboard.type("\n// tmp");
await page.keyboard.press("Control+z");
assert.ok(!(await val(page, LOGIC)).includes("// tmp"), "editor undo removed the typing");
await page.click("h2:has-text('Custom Scripts')");
await sleep(300);
d = await readDef(page, "Scripts");
await ready(page, LOGIC);
assert.equal(d.scripts[0].code, "const t = get('AGE');\nif (t > 10) {\n  setCalc('TOTAL', t);\n}", "…and did not reach the Studio's undo (the survey edit is still there)");
await page.click("h2:has-text('Custom Scripts')");
await page.keyboard.press("Control+z"); // outside the editor: the Studio's undo
for (let i = 0; i < 20 && (await val(page, LOGIC)).includes("  setCalc"); i++) await sleep(150);
assert.equal(await val(page, LOGIC), "const t = get('AGE');\nif (t > 10) {\nsetCalc('TOTAL', t);\n}", "the Studio's ⌘Z outside the editor undid the last survey edit (the formatted save), back to the Mod-S save before it");
ok("Ctrl-Z inside the editor undoes typing only; Ctrl-Z outside is the Studio's undo of the saved edit");

// full screen, Esc
await page.click('[data-testid="code-editor-full"]');
const box = await page.$eval(`[data-code-editor="${LOGIC}"]`, (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, full: e.classList.contains("full") }; });
assert.ok(box.full && box.w > 1300 && box.h > 900, JSON.stringify(box));
await page.keyboard.press("Escape");
assert.equal(await page.$eval(`[data-code-editor="${LOGIC}"]`, (e) => e.classList.contains("full")), false, "Esc leaves full screen");
await page.click(`[data-testid="${LOGIC}"]`);
await page.keyboard.press("Escape");
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "code-editor-full", "Esc leaves the editor (focus on its toolbar)");
await page.keyboard.press("Tab");
assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), LOGIC, "Tab moves on — no tab trap");
ok(`full screen (${Math.round(box.w)}×${Math.round(box.h)}), Esc exits it; Esc then leaves the editor and Tab moves on`);

/* ================================================================================================ C */
console.log("\nC a behaviour script in Styles, animations & scripts");
await openTab(page, "Questions");
await page.click('.qcard:has-text("Q2")');
await sleep(300);
if (!(await page.$('[data-testid="psec-body-ux"]'))) await page.click('[data-testid="psec-head-ux"]');
await ready(page, "ux-script");
assert.match(await page.textContent('[data-code-editor="ux-script"] [data-testid="code-editor-refs"]'), /reads nothing named · writes nothing/);
await page.click('[data-testid="ux-script"]');
await page.keyboard.press("Control+End");
await page.keyboard.type("\nrs.addC");
await pick(page, "addClass");
await page.keyboard.type('("self", "x");\nconst a = rs.getAnswer("');
await waitCompletion(page, "Q2");
const info = await page.$$eval(".cm-tooltip-autocomplete li", (l) => l.map((x) => x.textContent));
assert.ok(info.some((t) => t.startsWith("AGE")) && info.some((t) => t.startsWith("Q2")), JSON.stringify(info));
await pick(page, "Q2");
await page.keyboard.press("End");
await page.keyboard.type(";\nrs.wiggle(\"self\");");
for (let i = 0; i < 20 && !(await markerLines(page, "ux-script", "error")).length; i++) await sleep(200);
assert.deepEqual(await markerLines(page, "ux-script", "error"), [6], "rs.wiggle is marked on line 6");
assert.match(await val(page, "ux-script"), /rs\.addClass\("self", "x"\);\nconst a = rs\.getAnswer\("Q2"\);/);
await page.click('[data-testid="psec-body-ux"] [data-testid="ux-items"] > p.muted'); // leave the field
await page.waitForSelector('[data-testid="ux-item-errors"]');
assert.match(await page.textContent('[data-testid="ux-item-errors"]'), /rs\.wiggle is not part of the survey api/);
// fix it: remove the bad line, leave → saved
const fixed = (await val(page, "ux-script")).replace('\nrs.wiggle("self");', "");
await page.fill('[data-testid="ux-script"]', fixed);
await page.keyboard.press("Control+s");
await sleep(400);
assert.equal(await page.$('[data-testid="ux-item-errors"]'), null);
assert.match(await page.textContent('[data-code-editor="ux-script"] [data-testid="code-editor-refs"]'), /reads Q2/);
ok('rs.addC → addClass; rs.getAnswer("…") offers AGE / Q2 with their text; rs.wiggle marked on line 6 and refused; fixed and saved; header reads Q2');

/* ================================================================================================ D */
console.log("\nD a Custom Component's JavaScript and HTML");
for (let i = 0; i < 3 && !(await page.$('[data-testid="psec-head-component-code"]')); i++) {
  await page.keyboard.press("Escape");
  await page.click('.qcard:has-text("COMP")', { force: i > 0 });
  await page.waitForSelector('[data-testid="psec-head-component-code"]', { timeout: 8000 }).catch(async () => console.log("    (retry select COMP; selected:", await page.$eval(".qcard.selected, .qcard.active", (e) => e.textContent.slice(0, 30)).catch(() => "?"), ")"));
}
if (!(await page.$('[data-testid="psec-body-component-code"]'))) await page.click('[data-testid="psec-head-component-code"]');
await ready(page, "component-js");
await page.click('[data-testid="component-js"]');
await page.keyboard.press("Control+End");
await page.keyboard.type("\napi.");
await waitCompletion(page, "setValue");
await page.keyboard.press("Escape"); // closes the list, stays in the editor
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "component-js", "the first Esc only closed the completion list");
await page.keyboard.type("getValue();\nconst w = window.top;");
for (let i = 0; i < 20 && !(await markerLines(page, "component-js", "error")).length; i++) await sleep(200);
assert.deepEqual(await markerLines(page, "component-js", "error"), [3]);
await page.click('[data-testid="psec-body-component-code"] p.muted');
await page.waitForSelector('[data-testid="component-js-refused"]');
ok("component: api. offers getValue/setValue/onChange; window.top marked on line 3 and refused");
await ready(page, "component-html");
await page.click('[data-testid="component-html"]');
await page.keyboard.press("Control+End");
await page.keyboard.type('\n<img src="x" onerror="alert(1)">');
for (let i = 0; i < 20 && !(await markerLines(page, "component-html", "warning")).length; i++) await sleep(200);
assert.deepEqual(await markerLines(page, "component-html", "warning"), [2]);
ok("component HTML: the sanitiser's change is a warning on line 2");

/* ================================================================================================ E */
console.log("\nE Branding custom CSS");
await openTab(page, "Branding");
await ready(page, "branding-custom-css");
await page.click('[data-testid="branding-custom-css"]');
await page.keyboard.type(".rs-card { border-radius: 14px; }\n@import url(https://x.test/a.css);");
for (let i = 0; i < 20 && !(await markerLines(page, "branding-custom-css", "warning")).length; i++) await sleep(200);
assert.deepEqual(await markerLines(page, "branding-custom-css", "warning"), [2]);
d = await readDef(page, "Branding");
assert.match(d.branding.customCss, /^\.rs-card \{ border-radius: 14px; \}\n@import/, "saved as typed (the field never refused)");
ok("Branding CSS saved as typed; the @import line carries the sanitiser warning");
await page.close();

/* ================================================================================================ F */
console.log("\nF the editor chunk blocked (offline)");
const off = await open(`${STUDIO}/sandbox?tab=scripts`, { block: true });
await off.waitForSelector('[data-code-editor="script-code"][data-editor="fallback"]', { timeout: 120000 });
assert.equal(await off.$eval('[data-testid="script-code"]', (e) => e.tagName), "TEXTAREA");
assert.ok(await off.$('[data-testid="code-editor-fallback"]'));
await off.fill('[data-testid="script-code"]', "const t = get('AGE');\nwindow.y = 2;");
await off.click("h2:has-text('Custom Scripts')");
await off.waitForSelector('[data-testid="script-refused"]');
await off.fill('[data-testid="script-code"]', "const t = get('AGE');\nlog('offline');");
await off.click('[data-testid="script-save"]');
await sleep(300);
assert.equal(await off.$('[data-testid="script-refused"]'), null);
assert.equal(await off.$('[data-testid="script-save"]'), null, "saved");
ok("chunk aborted → a plain textarea with the same test id; the gate still refuses, a valid edit still saves");
await off.close();

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
console.log(`\nCODE-EDITOR OK — chunk ${(chunkBytes / 1024).toFixed(0)} KiB (dev)`);
await browser.close();
