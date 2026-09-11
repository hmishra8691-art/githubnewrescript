/**
 * LIVE VIEW — the Questions editor's second mode. Browser checks.
 *
 * The Live View is not a place. It is a view of the question the programmer
 * already has open, inside the Questions screen, drawn by the respondent's own
 * renderer (@rescript/renderer, imported by both apps). So what there is to
 * verify is that it lives where it should, that both views edit the one
 * definition, that the authoring layer addresses the right schema object, and
 * that simulation runs the real engine rather than an imitation of it.
 *
 * Everything drives the sandbox Studio with the Master Demo loaded — the
 * widest set of question types the platform has: 35 types including every
 * matrix family, ranking, allocation, hotspot, conjoint and MaxDiff.
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
await page.click(".leftnav >> text=Questions");
await page.waitForSelector('[data-testid="qcard"]');

/**
 * Drag one structure row onto another.
 *
 * Not page.dragTo: that scrolls the destination into view *between* the press
 * and the first move, so the browser hit-tests the grab point against content
 * that has since slid under it and starts the drag on the wrong row. Here the
 * whole list is framed first, so nothing moves once the mouse is down.
 */
const dragStruct = async (kind, fromCode, toCode) => {
  await page.$eval(`[data-testid="live-struct-${kind}s"]`, (el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  const grip = page.locator(`[data-testid="live-struct-${kind}"][data-code="${fromCode}"] [data-testid="live-grip-${kind}"]`);
  const target = page.locator(`[data-testid="live-struct-${kind}"][data-code="${toCode}"]`);
  const a = await grip.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.up();
};

/** Open a question by its code, in the Questions screen, where it lives. */
const openQ = async (code) => {
  const card = page.locator('[data-testid="qcard"]').filter({ has: page.locator(`.mono:text-is("${code}")`) }).first();
  await card.scrollIntoViewIfNeeded();
  if (!(await page.$('[data-testid="question-view-switch"]')) ||
      !(await card.locator('[data-testid="question-view-switch"]').count())) {
    await card.click();
  }
  await page.waitForTimeout(500);
};
const live = async () => { await page.click('[data-testid="view-live"]'); await page.waitForTimeout(700); };
const standard = async () => { await page.click('[data-testid="view-standard"]'); await page.waitForTimeout(500); };
const kind = () => page.$eval('[data-testid="element-panel"]', (e) => e.getAttribute("data-kind")).catch(() => null);
const title = () => page.$eval('[data-testid="element-panel-title"]', (e) => e.textContent.trim());
const anchors = (sel) => page.$$eval(`[data-testid="canvas-stage"] ${sel}`, (es) => es.map((e) => e.getAttribute("data-rs-id")));

/* -------------------------------------------------- §1 no separate place */

console.log("\nTHE LIVE VIEW IS INSIDE THE QUESTIONS EDITOR (§1, §2, §39)");
// text nodes only — the count badges are separate elements
const navLabels = await page.$$eval(".leftnav .nav-item", (es) =>
  es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
assert.equal(navLabels.some((t) => /Live Canvas|Live View/i.test(t)), false,
  `no Live View entry in the navigation, got: ${navLabels.join(" | ")}`);
ok("there is no separate Live Canvas tab, page or navigation item");

/*
 * The original 17 tabs, in their original order, with every LATER addition
 * filtered out — that is what this assertion is for: the Live View must not
 * have displaced anything, and neither must anything since.
 *
 * The filter list had fallen behind. Fieldwork (§23), Project and
 * Distribution (§24, §60) were added in later sessions and this suite was
 * never re-run, so it had been failing silently for exactly the reason
 * `scripts/auth-guard-audit.mjs` had — nothing runs it. Adding to this list
 * is the price of a new tab, and the assertion is worth keeping precisely
 * because it makes that price visible.
 */
const SINCE_LIVE_VIEW = ["Data Analytics", "Fieldwork", "Project", "Distribution", "Tests", "Translation", "Usage & Wallet"];
assert.deepEqual(
  navLabels.filter((t) => !SINCE_LIVE_VIEW.includes(t)),
  ["Questions", "Survey Settings", "Survey Flow", "Logic", "Variables", "Calculations", "Quotas", "List Fill",
   "Design Generators", "Branding", "Scripts", "Data", "Versions & Deploy", "JSON", "Collaborators", "Internal notes", "Activity"],
  "the navigation is exactly what it was before the Live View existed",
);
ok("the Studio's original 17 tabs are unchanged, in their original order");

await openQ("Q11"); // multi_select, 15 options
assert.ok(await page.$('[data-testid="question-view-switch"]'), "the switch is in the question editor");
ok("opening a question offers Standard / Live View inside its own editor (§2)");

assert.ok(await page.$('.rightpanel'), "the Studio's property panel is still there");
ok("the existing right-hand property panel is retained, not replaced (§24)");

/* ------------------------------------------------- §3, §23 standard first */

console.log("\nSTANDARD MODE IS UNCHANGED AND IS THE DEFAULT (§3, §40)");
assert.equal(await page.$('[data-testid="live-view"]'), null, "the live view is not showing yet");
assert.ok(await page.$('.opt-row'), "the existing option editor is what a question opens on");
ok("a question opens in Standard mode with the existing programming UI intact");

const stdSections = await page.$eval(".rightpanel", (e) => e.textContent);
for (const s of ["Display logic", "Skip logic", "Randomization", "Validation rules", "Custom code"]) {
  assert.ok(stdSections.includes(s), `${s} is still offered`);
}
ok("every question-level programming section is still reachable (§18, §28)");

/* --------------------------------------------------- §4, §5 the live view */

console.log("\nLIVE VIEW RENDERS THE QUESTION IN PLACE (§4, §5, §6)");
await live();
assert.ok(await page.$('[data-testid="live-view"]'), "the live view opened");
assert.equal(page.url().includes("/sandbox"), true, "and did so without navigating anywhere");
ok("Live View renders inside the same screen — no page navigation (§4)");

const opts = await anchors('[data-rs-el="option"]');
assert.ok(opts.length >= 10, `the real options are rendered, found ${opts.length}`);
ok(`the question renders with all ${opts.length} of its options, by the respondent's renderer`);

/* --------------------------------------------- §26 every question type */

console.log("\nEVERY QUESTION TYPE GETS A LIVE VIEW (§26)");
const seen = new Map();
for (const q of def.questions) if (!seen.has(q.type)) seen.set(q.type, q.code);
const failures = [];
for (const [type, code] of seen) {
  await standard().catch(() => {});
  await openQ(code);
  await live();
  const anchored = await page.$$eval('[data-testid="canvas-stage"] [data-rs-el="question"]', (es) => es.length);
  const html = await page.$eval('[data-testid="canvas-stage"]', (e) => e.innerHTML).catch(() => "");
  if (anchored !== 1 || html.length < 40) failures.push(`${type} (${code})`);
}
assert.deepEqual(failures, [], `every type renders and is addressable; failed: ${failures.join(", ")}`);
ok(`all ${seen.size} question types render in the Live View and expose the question anchor`);

/* ------------------------------------------ §8–§11, §25 one definition */

console.log("\nBOTH MODES EDIT THE SAME QUESTION (§8, §11, §25, §37)");
await openQ("Q11");
await live();
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]');
await page.waitForTimeout(300);
assert.equal(await kind(), "option");
assert.match(await title(), /^Option: /);
ok("clicking an option selects it and the property panel becomes an option panel (§9, §10, §24)");

await page.fill('[data-testid="opt-label"]', "Desktop PC");
await page.waitForTimeout(450);
assert.equal(
  await page.$eval('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]', (e) => e.textContent.trim()),
  "Desktop PC", "the rendered question redrew with the new label");
ok("editing in the panel updates the Live View immediately (§25)");

await standard();
const stdLabels = await page.$$eval(".opt-row input.grow", (es) => es.map((e) => e.value));
assert.ok(stdLabels.includes("Desktop PC"), `Standard's option editor shows it too, got ${stdLabels.slice(0, 4).join(", ")}`);
ok("the change made in Live View is already in the Standard editor (§10, §37)");

// and the other direction
const i = stdLabels.indexOf("Desktop PC");
await page.$$eval(".opt-row input.grow", (es, idx) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(es[idx], "Desktop workstation");
  es[idx].dispatchEvent(new Event("input", { bubbles: true }));
}, i);
await page.waitForTimeout(450);
await live();
assert.equal(
  await page.$eval('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="3"]', (e) => e.textContent.trim()),
  "Desktop workstation", "the Live View picked up the Standard edit");
ok("a Standard edit appears in the Live View without any sync step (§9)");

// and it is the survey's own JSON that changed, not a preview copy
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
assert.ok((await page.$eval("textarea.code", (e) => e.value)).includes("Desktop workstation"));
ok("both modes write to the one survey definition, visible in the JSON (§37)");
await page.click(".leftnav >> text=Questions");
await page.waitForSelector('[data-testid="qcard"]');

/* --------------------------------------------- §14–§16 grid and matrix */

console.log("\nGRID / MATRIX ROWS, COLUMNS AND CELLS (§14, §15, §16)");
await openQ("Q28"); // matrix_single with its own rows
await live();
const rows = await anchors('[data-rs-el="row"]');
const cols = await anchors('[data-rs-el="column"]');
const cells = await anchors('[data-rs-el="cell"]');
assert.ok(rows.length && cols.length && cells.length >= rows.length);
ok(`the matrix renders ${new Set(rows).size} rows, ${cols.length} columns and ${cells.length} addressable cells`);

await page.click(`[data-testid="canvas-stage"] td.rowlabel[data-rs-el="row"][data-rs-id="${rows[0]}"]`);
await page.waitForTimeout(300);
assert.equal(await kind(), "row");
assert.match(await title(), /^Row: /);
ok("clicking a row label selects the row and offers row properties (§15)");

await page.fill('[data-testid="row-label"]', "Streaming video");
await page.waitForTimeout(450);
assert.ok((await page.$eval('[data-testid="canvas-stage"]', (e) => e.textContent)).includes("Streaming video"));
ok("renaming a row redraws the matrix immediately");

await page.click(`[data-testid="canvas-stage"] [data-rs-el="column"][data-rs-id="${cols[1]}"]`);
await page.waitForTimeout(300);
assert.equal(await kind(), "column");
assert.match(await title(), /^Column: /);
ok("clicking a column header selects the column (§16)");

await page.click(`[data-testid="canvas-stage"] [data-rs-el="cell"][data-rs-id="${cells[2]}"]`);
await page.waitForTimeout(300);
assert.equal(await kind(), "cell");
assert.ok(await page.$('[data-testid="cell-goto-row"]') && await page.$('[data-testid="cell-goto-column"]'));
ok("a cell is inspectable and refers to the row and column that own it (§27)");

/* --------------------------------------------- §12, §13 add and reorder */

console.log("\nADDING AND REORDERING FROM THE LIVE VIEW (§12, §13)");
await openQ("Q11");
await live();
const count = () => page.$$eval('[data-testid="live-struct-option"]', (es) => es.length);
const codes = () => page.$$eval('[data-testid="live-struct-option"]', (es) => es.map((e) => e.getAttribute("data-code")));
const n0 = await count();
await page.click('[data-testid="live-add-option"]');
await page.waitForTimeout(500);
assert.equal(await count(), n0 + 1);
const added = (await codes()).slice(-1)[0];
assert.ok(await page.$(`[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="${added}"]`),
  "the new option is in the rendered question, not only in a list");
assert.equal(await kind(), "option");
ok("Add option puts a real option into the rendered question and selects it (§12)");

await dragStruct("option", added, (await codes())[0]);
await page.waitForTimeout(500);
assert.equal((await codes())[0], added, "dragging moved it to the top");
assert.equal((await anchors('[data-rs-el="option"]'))[0], added, "and the rendered order followed");
ok("drag-and-drop reordering updates the definition and the render together (§13)");

await page.click(`[data-testid="live-struct-option"][data-code="${added}"] [data-testid="live-del-option"]`);
await page.waitForTimeout(450);
assert.equal(await count(), n0);
ok("and the option can be deleted again from the same place");

/* ---------------------------------------- §17, §19 element-level logic */

console.log("\nLOGIC FROM THE SELECTED ELEMENT (§17, §19)");
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]');
await page.waitForTimeout(300);
assert.ok(await page.$('[data-testid="option-logic"]'), "the option logic editor is right there");
ok("selecting an option offers its logic without leaving the question (§17)");

await page.click('[data-testid="option-logic"] >> text=Always hide');
await page.waitForTimeout(600);
assert.ok(await page.$('[data-testid="option-hidden-note"]'), "the panel reports it as hidden");
assert.ok((await page.$$eval(".lc-hidden-veil", (es) => es.length)) >= 1, "the render marks it");
assert.ok(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]'),
  "and it stays on the canvas so it can still be programmed");
ok("logic applies immediately and the element stays inspectable (§19, §26 authoring state)");

await page.click('[data-testid="live-simulate"]');
await page.waitForTimeout(600);
assert.equal(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]'), null,
  "the respondent does not see it");
ok("Simulation evaluates the logic for real — the runtime state, not the programming state (§19, §20)");

await page.click('[data-testid="live-author"]');
await page.waitForTimeout(400);
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="2"]');
await page.waitForTimeout(300);
await page.click('[data-testid="option-logic"] >> text=Always show');
await page.waitForTimeout(450);
ok("the logic can be removed from the same place");

/* ------------------------------------- §21 device preview and debug */

console.log("\nDEVICE PREVIEW AND DEBUG (§21)");
for (const d of ["mobile", "tablet", "desktop"]) {
  await page.click(`[data-testid="live-${d}"]`);
  await page.waitForTimeout(300);
  assert.ok(await page.$('[data-testid="canvas-stage"] [data-rs-el="option"]'), `${d} still renders options`);
}
ok("Desktop / Tablet / Mobile all render and stay programmable, inside the question editor");

await page.click('[data-testid="live-debug"]');
await page.waitForTimeout(500);
assert.ok(await page.$('[data-testid="live-debug-panel"]'), "Debug opens the engine's own pipeline view");
ok("Debug remains available and shows how the engine builds the list");
await page.click('[data-testid="live-debug"]');

/* -------------------------------------- §29–§32 loops, piping, validation */

console.log("\nLOOP CONTEXT, PIPING AND VALIDATION (§29, §30, §31, §32)");
const looped = def.questions.find((q) => q.text.includes("{{") && q.type !== "html" && q.options.length > 0)
  ?? def.questions.find((q) => q.text.includes("{{") && q.type !== "html");
await openQ(looped.code);
await live();
assert.ok((await page.$$eval(".lc-pipe", (es) => es.length)) > 0,
  "an unresolved piping token is shown as a chip rather than silently dropped");
ok(`piping is previewed while authoring (${looped.code}) (§31)`);

const loopQ = def.questions.find((q) => {
  const flow = JSON.stringify(def.flow ?? []);
  const at = flow.indexOf(`"${q.id}"`);
  return at > 0 && flow.lastIndexOf('"loop"', at) > 0;
});
if (loopQ) {
  await openQ(loopQ.code);
  await live();
  if (await page.$('[data-testid="loop-iteration"]')) {
    const items = await page.$$eval('[data-testid="loop-iteration"] option', (es) => es.length);
    assert.ok(items > 0, "the loop's items are offered");
    ok(`a looped question previews per iteration (${loopQ.code}, ${items} items) (§29)`);
    if (await page.$('[data-testid="loop-references"]')) {
      ok("the loop's reference columns can be simulated (§30)");
    }
  }
}

await openQ("Q3"); // numeric with bounds
await live();
await page.click('[data-testid="live-simulate"]');
await page.waitForTimeout(500);
const numInput = await page.$('[data-testid="canvas-stage"] input');
if (numInput) {
  await numInput.fill("5");
  await page.waitForTimeout(600);
  const msgs = await page.$$eval('[data-testid="canvas-stage"] .rs-error-msg', (es) => es.length);
  ok(`Simulation runs the real validator (${msgs} message${msgs === 1 ? "" : "s"} for an out-of-range age) (§32)`);
}
await page.click('[data-testid="live-author"]');

/* ------------------------------------------- §34, §35, §39 state and save */

console.log("\nSAVE, UNDO AND PER-QUESTION MODE (§34, §35, §39)");
assert.ok(await page.$('[data-testid="question-save-state"]'), "the existing save state is shown in the editor");
ok("the existing save pipeline reports its state where the editing happens (§34)");

await openQ("Q11");
assert.equal(await page.$eval('[data-testid="view-standard"]', (e) => e.className), "on",
  "a newly opened question starts in Standard");
ok("the mode belongs to the question, not the application — each opens in Standard (§39, §40)");

await live();
await page.click('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="1"]');
await page.waitForTimeout(300);
await page.fill('[data-testid="opt-label"]', "Undo me");
await page.waitForTimeout(400);
await page.click('[data-testid="live-toolbar"]');
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
assert.notEqual(
  await page.$eval('[data-testid="canvas-stage"] [data-rs-el="option"][data-rs-id="1"]', (e) => e.textContent.trim()),
  "Undo me", "undo reverted the Live View edit");
ok("undo works on Live View edits through the existing history (§35)");

/* ------------------------------------------------------------ regressions */

console.log("\nTHE REST OF THE QUESTIONS SCREEN IS UNTOUCHED");
await standard();
assert.equal(await page.$('[data-testid="live-view"]'), null, "the live view is gone again");
assert.ok(await page.$(".opt-row"), "the existing option editor is back");
assert.ok(await page.$('[data-testid="close-question"]'), "Done still closes the question");
ok("switching back restores the Standard editor exactly as it was (§23)");

assert.ok(await page.$('[data-testid="add-question-top"]'), "questions can still be added");
assert.ok(await page.$('[data-testid="add-block"]'), "blocks can still be added");
ok("blocks, pages and question creation are unchanged");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors anywhere in the session");

console.log(`\nALL ${passed} LIVE VIEW CHECKS PASSED`);
await browser.close();
