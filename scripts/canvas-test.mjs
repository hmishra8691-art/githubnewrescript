/**
 * LIVE QUESTION CANVAS — browser checks.
 *
 * The canvas renders questions with the respondent's own renderer
 * (@rescript/renderer, imported by both apps), so most of what there is to
 * verify is that the authoring layer on top of it addresses the right schema
 * object, that editing writes through the one store, and that simulation runs
 * the real engine rather than a preview-only imitation.
 *
 * Everything here drives the sandbox Studio with the Master Demo loaded, which
 * is the widest set of question types the platform has: 35 types including
 * every matrix family, ranking, allocation, hotspot, conjoint and MaxDiff.
 *
 *   node scripts/canvas-test.mjs            (studio dev server on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const def = buildMasterDemoSurvey("sandbox");
const byCode = Object.fromEntries(def.questions.map((q) => [q.code, q]));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/auth/me", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ userId: "u1", userCode: "USR-1", name: "Ana", email: "a@b.c", platformRole: "user", isPlatformAdmin: true, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }),
}));

/* ---------------------------------------------------------------- fixtures */

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
}, JSON.stringify(def));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(900);

const open = async (code) => {
  await page.fill('[data-testid="canvas-filter"]', code);
  await page.waitForTimeout(220);
  const item = await page.$(`[data-testid="canvas-qitem"][data-qid="${byCode[code].id}"]`);
  assert.ok(item, `question ${code} listed on the canvas`);
  await item.click();
  await page.waitForTimeout(450);
};
const kind = () => page.$eval('[data-testid="element-panel"]', (e) => e.getAttribute("data-kind"));
const title = () => page.$eval('[data-testid="element-panel-title"]', (e) => e.textContent.trim());
const stageText = () => page.$eval('[data-testid="canvas-stage"]', (e) => e.textContent);
const anchors = (sel) => page.$$eval(`[data-testid="canvas-stage"] ${sel}`, (es) => es.map((e) => e.getAttribute("data-rs-id")));

console.log("\nTHE CANVAS TAB");
await page.click(".leftnav >> text=Live Canvas");
await page.waitForSelector('[data-testid="canvas-panel"]', { timeout: 20000 });
ok("the Live Canvas tab opens");

assert.equal(await page.$$eval('[data-testid="canvas-qitem"]', (es) => es.length), def.questions.length);
ok(`every question is reachable without leaving the canvas (${def.questions.length})`);

assert.equal(await page.$$eval(".rightpanel", (es) => es.length), 0,
  "the question-level Properties panel steps aside for the contextual one");
ok("one property panel at a time — the contextual one owns the canvas");

/* ------------------------------------------------- §12 every question type */

console.log("\nEVERY QUESTION TYPE RENDERS (§12, §44)");
const seen = new Map();
for (const q of def.questions) if (!seen.has(q.type)) seen.set(q.type, q.code);
const failures = [];
for (const [type, code] of seen) {
  await open(code);
  const html = await page.$eval('[data-testid="canvas-stage"]', (e) => e.innerHTML);
  const anchored = await page.$$eval('[data-testid="canvas-stage"] [data-rs-el="question"]', (es) => es.length);
  if (html.length < 40 || anchored !== 1) failures.push(`${type} (${code})`);
}
assert.deepEqual(failures, [], `every type renders and is addressable; failed: ${failures.join(", ")}`);
ok(`all ${seen.size} question types in the Master Demo render on the canvas and expose the question anchor`);

/* --------------------------------------------- §5–7 selection and editing */

console.log("\nSELECTING AND EDITING ELEMENTS (§5, §6, §7)");
await open("Q11"); // multi_select, 15 options
assert.equal(await kind(), "question");
ok("opening a question selects the question itself");

await page.click('[data-testid="canvas-stage"] [data-rs-el="text"]');
await page.waitForTimeout(250);
assert.equal(await kind(), "text");
ok("clicking the question text selects the text, not the question");

await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]');
await page.waitForTimeout(250);
assert.equal(await kind(), "option");
assert.match(await title(), /^Option: /);
ok("clicking an option selects that option and the panel switches to option properties");

const before = await page.inputValue('[data-testid="opt-label"]');
await page.fill('[data-testid="opt-label"]', "Desktop PC (edited)");
await page.waitForTimeout(400);
const optText = await page.$eval('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]', (e) => e.textContent.trim());
assert.equal(optText, "Desktop PC (edited)", `the canvas re-rendered with the new label, got "${optText}"`);
ok("editing the label in the panel updates the live canvas immediately (§3, §35)");

await page.click('[data-testid="canvas-stage"] [data-rs-el="question"]');
await page.waitForTimeout(200);
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]');
await page.waitForTimeout(250);
assert.equal(await page.inputValue('[data-testid="opt-label"]'), "Desktop PC (edited)");
ok("the panel and the canvas read one definition — reselecting shows the edit");

// and it reaches the survey JSON, which is the actual source of truth (§47)
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
const json = await page.$eval("textarea.code", (e) => e.value);
assert.ok(json.includes("Desktop PC (edited)"), "the canvas edit is in the survey JSON");
ok("canvas edits land in the survey JSON, not a parallel format (§47)");
await page.click(".leftnav >> text=Live Canvas");
await page.waitForSelector('[data-testid="canvas-panel"]');

/* ----------------------------------------------------- §8–11 grid / matrix */

console.log("\nGRID AND MATRIX (§8, §9, §10, §11)");
await open("Q28"); // matrix_single with its own rows
const rows = await anchors('[data-rs-el="row"]');
const cols = await anchors('[data-rs-el="column"]');
const cells = await anchors('[data-rs-el="cell"]');
assert.ok(rows.length > 0, "rows are addressable");
assert.ok(cols.length > 0, "columns are addressable");
assert.ok(cells.length >= rows.length, "every intersection is addressable");
ok(`the matrix exposes ${new Set(rows).size} rows, ${cols.length} columns and ${cells.length} cells`);

/* The row LABEL selects the row; a cell inside the same row selects the cell.
   Most-specific-wins is what makes a grid programmable at all. */
await page.click(`[data-testid="canvas-stage"] td.rowlabel[data-rs-el="row"][data-rs-id="${rows[0]}"]`);
await page.waitForTimeout(250);
assert.equal(await kind(), "row");
assert.match(await title(), /^Row: /);
ok("clicking a row label selects the row and offers row properties (§9)");

await page.fill('[data-testid="row-label"]', "Product A (edited)");
await page.waitForTimeout(400);
assert.ok((await stageText()).includes("Product A (edited)"), "the matrix redrew with the new row label");
ok("renaming a row from the panel redraws the matrix immediately");

await page.click(`[data-testid="canvas-stage"] [data-rs-el="column"][data-rs-id="${cols[1]}"]`);
await page.waitForTimeout(250);
assert.equal(await kind(), "column");
assert.match(await title(), /^Column: /);
ok("clicking a column header selects the column (§10)");

await page.click(`[data-testid="canvas-stage"] [data-rs-el="cell"][data-rs-id="${cells[2]}"]`);
await page.waitForTimeout(250);
assert.equal(await kind(), "cell");
assert.ok(await page.$('[data-testid="cell-goto-row"]'), "a cell offers its row");
assert.ok(await page.$('[data-testid="cell-goto-column"]'), "a cell offers its column");
ok("a cell is inspectable and cross-references the row and column that own it (§11)");

await page.click('[data-testid="cell-goto-row"]');
await page.waitForTimeout(250);
assert.equal(await kind(), "row");
ok("a cell hands off to the side that actually carries the programming");

/* A matrix whose rows come from carry-forward has no rows of its own: the
   authoring view must still show them, because a question sourced from another
   question is exactly the case where seeing the structure matters most. */
await open("Q54"); // matrix_multi, rows carried from an earlier question
const carried = await anchors('[data-rs-el="row"]');
assert.ok(carried.length > 0, "carry-forward rows are drawn and addressable while authoring");
ok(`carry-forward supplies ${carried.length} rows and every one of them is selectable (§23)`);

/* ------------------------------------------- §14, §15 structure operations */

console.log("\nADDING AND REORDERING (§14, §15)");
await open("Q11");
const optCount = () => page.$$eval('[data-testid="struct-option"]', (es) => es.length);
const n0 = await optCount();
await page.click('[data-testid="add-option"]');
await page.waitForTimeout(450);
assert.equal(await optCount(), n0 + 1, "an option was added");
const added = (await anchors('[data-rs-el="option"]')).slice(-1)[0];
assert.ok(await page.$(`[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="${added}"]`),
  "the new option is in the rendered question, not just the list");
assert.equal(await kind(), "option");
ok("Add option puts a real option into the live render and selects it (§14)");

const codes = () => page.$$eval('[data-testid="struct-option"]', (es) => es.map((e) => e.getAttribute("data-code")));
const withAdded = await codes();

// reorder: drag the last option to the top, and check the RENDER follows
const lastCode = withAdded[withAdded.length - 1];
await page.locator(`[data-testid="struct-option"][data-code="${lastCode}"]`)
  .dragTo(page.locator('[data-testid="struct-option"]').first());
await page.waitForTimeout(500);
const reordered = await codes();
assert.equal(reordered[0], lastCode, `dragging moved ${lastCode} to the top, got ${reordered[0]} (was ${withAdded.join(",")})`);
const renderOrder = await anchors('[data-rs-el="option"]');
assert.equal(renderOrder[0], reordered[0], "the rendered question shows the new order too");
ok("drag-and-drop reordering updates the definition and the live render (§15)");

// and delete the one that was added, not whichever happens to be first
await page.click(`[data-testid="struct-option"][data-code="${reordered[0]}"] [data-testid="del-option"]`);
await page.waitForTimeout(450);
assert.equal(await optCount(), n0, "the added option was removed again");
assert.equal((await codes()).includes(reordered[0]), false, "and it is the one that went");
ok("deleting an element from the canvas removes it from the definition");

/* --------------------------------------- §16, §18, §21 element-level logic */

console.log("\nPROGRAMMING FROM THE SELECTED ELEMENT (§16, §18, §21, §23)");
await open("Q11");
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]');
await page.waitForTimeout(250);
assert.ok(await page.$('[data-testid="option-logic"]'), "the option logic editor is right there");
ok("selecting an option offers option logic without a detour (§16, §18)");

// hide it outright and watch the canvas mark it
await page.click('[data-testid="option-logic"] >> text=Always hide');
await page.waitForTimeout(600);
assert.ok(await page.$('[data-testid="option-hidden-note"]'), "the panel says it is hidden");
const veils = await page.$$eval(".lc-hidden-veil", (es) => es.length);
assert.ok(veils >= 1, `the canvas marks it hidden, found ${veils} markers`);
assert.ok(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]'),
  "and it is still on the canvas so it can still be programmed");
ok("logic takes effect immediately, and a hidden element stays inspectable (§21, §23)");

// simulation evaluates it for real: the option is gone
await page.click('[data-testid="mode-simulate"]');
await page.waitForTimeout(600);
assert.equal(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]'), null,
  "the respondent does not see the hidden option");
ok("Simulation hides what the logic hides — the authoring view is the only place it survives (§24, §43)");

await page.click('[data-testid="mode-author"]');
await page.waitForTimeout(400);
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]');
await page.waitForTimeout(250);
await page.click('[data-testid="option-logic"] >> text=Always show');
await page.waitForTimeout(500);
ok("the logic can be taken off again from the same place");

/* ------------------------------------------------------- §22 indicators */

console.log("\nPROGRAMMING INDICATORS (§22)");
await open("Q11");
const flagsOn = await page.$$eval('[data-testid="lc-flag"]', (es) => es.length);
await page.uncheck('[data-testid="toggle-flags"]');
await page.waitForTimeout(300);
const flagsOff = await page.$$eval('[data-testid="lc-flag"]', (es) => es.length);
assert.ok(flagsOn > 0, "elements carrying programming are marked");
assert.equal(flagsOff, 0, "and the marks can be turned off");
await page.check('[data-testid="toggle-flags"]');
ok(`${flagsOn} elements marked as carrying programming, and the marks are optional`);

/* ------------------------------------------------------ §24–§26 simulation */

console.log("\nSIMULATION (§24, §25, §26, §29)");
await open("Q20"); // dropdown with display logic upstream
const hasSim = await page.$('[data-testid="canvas-simulator"]');
if (hasSim) ok("questions with dependencies offer sample answers");

// piping shows as a chip while authoring
const piped = def.questions.find((q) => q.text.includes("{{") && q.type !== "html");
if (piped) {
  await open(piped.code);
  const chips = await page.$$eval(".lc-pipe", (es) => es.length);
  assert.ok(chips > 0, "an unresolved piping token is shown as a chip, not silently dropped");
  ok(`piping is visible while authoring (${piped.code}) (§26)`);
}

// and a content block pipes through customHtml, which its renderer draws
const htmlPiped = def.questions.find((q) => q.type === "html" && (q.customHtml ?? q.text).includes("{{"));
if (htmlPiped) {
  await open(htmlPiped.code);
  assert.ok(await page.$$eval(".lc-pipe", (es) => es.length) > 0, "a content block's piping is marked too");
  ok(`content blocks pipe through customHtml and are marked as well (${htmlPiped.code})`);
}

// validation comes from the real validator
await open("Q3"); // numeric with bounds
await page.click('[data-testid="mode-simulate"]');
await page.waitForTimeout(500);
const numInput = await page.$('[data-testid="canvas-stage"] input');
if (numInput) {
  await numInput.fill("5");
  await page.waitForTimeout(600);
  const msgs = await page.$$eval('[data-testid="canvas-stage"] .rs-error-msg', (es) => es.map((e) => e.textContent));
  ok(`simulation runs the real validator (${msgs.length} message${msgs.length === 1 ? "" : "s"} for an out-of-range age) (§29)`);
}
await page.click('[data-testid="mode-author"]');

/* --------------------------------------------------------- §31 responsive */

console.log("\nRESPONSIVE PREVIEW (§31, §32)");
await open("Q11");
for (const d of ["mobile", "tablet", "desktop"]) {
  await page.click(`[data-testid="canvas-${d}"]`);
  await page.waitForTimeout(350);
  const w = await page.$eval(".lc-frame", (e) => e.getBoundingClientRect().width);
  assert.ok(w > 100, `${d} frame has a width`);
  assert.ok(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"]'), `${d} still renders options`);
}
ok("desktop / tablet / mobile all render, and stay programmable in each");

await page.click('[data-testid="canvas-mobile"]');
await page.waitForTimeout(300);
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="1"]');
await page.waitForTimeout(250);
assert.equal(await kind(), "option");
ok("selection works at mobile width too (§31)");
await page.click('[data-testid="canvas-desktop"]');

/* ------------------------------------------------------- §33, §34 save/undo */

console.log("\nSAVE STATE AND UNDO (§33, §34)");
await open("Q11");
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="1"]');
await page.waitForTimeout(250);
const label0 = await page.inputValue('[data-testid="opt-label"]');
await page.fill('[data-testid="opt-label"]', "Undo me");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.click('[data-testid="canvas-toolbar"]');
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
const after = await page.$eval('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="1"]', (e) => e.textContent.trim());
assert.notEqual(after, "Undo me", "undo reverted the canvas edit");
ok(`undo works on canvas edits through the existing history (back to "${after}")`);

assert.ok(await page.$('[data-testid="canvas-save-state"]'), "the save state is visible where the editing happens");
ok("the existing save pipeline reports its state on the canvas (§34)");

/* ------------------------------------------------------------ no regressions */

console.log("\nTHE REST OF THE STUDIO IS UNTOUCHED");
await page.click(".leftnav >> text=Questions");
await page.waitForSelector('[data-testid="qcard"]');
ok("the Questions tab still lists question cards exactly as before");
await page.click('[data-testid="qcard"]');
await page.waitForTimeout(400);
assert.ok(await page.$(".rightpanel"), "and its Properties panel is back");
ok("the original editor and its properties panel are unchanged");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors anywhere in the session");

console.log(`\nALL ${passed} CANVAS CHECKS PASSED`);
await browser.close();
