/**
 * The tester's sheet of 2026-09-03, checked in the real Studio and runtime:
 *
 *   3. a question open inside a block can be CLOSED (Done, Esc, block Close)
 *   4. block names can be hidden from respondents — survey-wide and per block
 *   5. "Other (specify)" cannot be left blank
 *   6. count fields refuse negative numbers
 *
 * (1 and 2 — per-bracket AND/OR — are covered by logic-builder-test.)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Tester fixes", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Relationship?",
      options: [
        { code: 1, label: "Student" }, { code: 2, label: "Alumni" },
        { code: 99, label: "Other (please specify)", flags: ["other_specify"] },
      ],
    },
    {
      id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which apply?",
      options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }],
    },
  ],
  flow: [
    { type: "page", id: "p1", title: "Relationship and familiarity", questionIds: ["q1"] },
    { type: "page", id: "p2", title: "Second block", questionIds: ["q2"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const loadFixture = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await loadFixture(FIXTURE);
assert.equal((await readDef()).questions.length, 2);
console.log("✔ fixture loaded");

/* ============================================================ 3. closing */
await goTab("Questions");
await page.waitForSelector('[data-testid="qcard"]');
const cards = () => page.$$('[data-testid="qcard"]');

assert.ok(!(await page.$('[data-testid="close-question"]')), "nothing is open, so no Done button");
await (await cards())[0].click();
await page.waitForSelector('[data-testid="close-question"]');
assert.ok(await page.$('[data-testid="close-question-bottom"]'), "Done is offered at the bottom of the editor too");
await page.click('[data-testid="close-question"]');
await page.waitForTimeout(100);
assert.ok(!(await page.$('[data-testid="close-question"]')), "Done closed the question");
assert.equal((await page.$$(".qcard.selected")).length, 0);
console.log("✔ Done closes an open question");

await (await cards())[0].click();
await page.waitForSelector('[data-testid="close-question"]');
await page.click('[data-testid="qcard"] >> nth=0 >> .qcard-text');   // the header row, not the editor
await page.waitForTimeout(100);
assert.ok(!(await page.$('[data-testid="close-question"]')), "clicking the open card's header collapses it");
console.log("✔ the header toggles");

await (await cards())[0].click();
await page.waitForSelector('[data-testid="close-question"]');
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
assert.ok(!(await page.$('[data-testid="close-question"]')), "Esc closes it");
console.log("✔ Esc closes an open question");

await (await cards())[0].click();
await page.waitForSelector('[data-testid="close-question"]');
const closeBtns = await page.$$('[data-testid="block-close"]');
assert.ok(closeBtns.length >= 2, "every expanded block offers Close");
await closeBtns[0].click();
await page.waitForTimeout(150);
assert.ok(!(await page.$('[data-testid="close-question"]')), "closing the block closed the question inside it");
const firstBlock = (await page.$$('[data-testid="block"]'))[0];
assert.ok((await firstBlock.getAttribute("class")).includes("collapsed"), "and collapsed the block");
assert.equal((await readDef()).questions.length, 2, "nothing was deleted along the way");
console.log("✔ the block's Close collapses it and closes the question inside — deleting nothing");

/* ============================================================ 4. names */
// default: names reach respondents, as they always did
const preview = await browser.newPage({ viewport: { width: 900, height: 900 } });
preview.on("pageerror", (e) => console.error("PREVIEW ERROR:", e.message));
const show = async (def) => {
  await preview.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
  await preview.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await preview.waitForSelector(".rs-option");
};
await show(await readDef());
assert.equal(await preview.textContent('[data-testid="rs-block-title"]'), "Relationship and familiarity");
assert.match(await preview.textContent('[data-testid="block-position"]'), /^Relationship and familiarity · Page 1/);
console.log("✔ by default the block name is the page heading (unchanged behaviour)");

// survey-wide: Branding → Block names → hidden
await goTab("Branding");
await page.waitForSelector('[data-testid="show-block-titles"]');
await page.selectOption('[data-testid="show-block-titles"]', "hide");
await page.waitForTimeout(300);
let def = await readDef();
assert.equal(def.branding.layout.showBlockTitles, false);
await show(def);
assert.ok(!(await preview.$('[data-testid="rs-block-title"]')), "no heading for respondents");
assert.match(await preview.textContent('[data-testid="block-position"]'), /hidden from respondents/,
  "preview still tells the programmer the name exists, marked hidden");
console.log("✔ survey-wide setting hides every block name from respondents");

// the Studio shows the state on the block head
await goTab("Questions");
await page.waitForSelector('[data-testid="block-title-hidden"]');
assert.equal((await page.$$('[data-testid="block-title-hidden"]')).length, 2, "both named blocks flag 'name hidden'");

// per block: override the second block back to shown
const menus = await page.$$('[data-testid="block-menu"]');
await menus[1].click();
await page.waitForSelector('[data-testid="block-title-show"]');
await page.click('[data-testid="block-title-show"]');
await page.waitForTimeout(300);
def = await readDef();
assert.equal(def.flow[1].showTitle, true, "the override is stored on the block");
assert.equal(def.flow[0].showTitle, undefined, "the other block still inherits");
await goTab("Questions");
assert.equal((await page.$$('[data-testid="block-title-hidden"]')).length, 1, "only one block is flagged now");
await show(def);
assert.ok(!(await preview.$('[data-testid="rs-block-title"]')), "block 1 hidden");
// advance to block 2 — answer Q1 with a non-Other option first
await preview.click('[data-qid="q1"] .rs-option:has-text("Student")');
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForSelector('[data-qid="q2"]');
assert.equal(await preview.textContent('[data-testid="rs-block-title"]'), "Second block", "block 2 shows its name");
console.log("✔ a block overrides the survey default in either direction");

/* ============================================================ 5. other specify */
def = await readDef();
await show(def);
await preview.click('[data-qid="q1"] .rs-option:has-text("Other")');
await preview.waitForSelector(".rs-other-input");
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForTimeout(200);
assert.ok(await preview.$('[data-qid="q1"]'), "still on page 1");
const errText = await preview.textContent(".rs-shell");
assert.match(errText, /say what “Other” is/, "the respondent is told what is missing");
console.log("✔ Other without text does not advance");

await preview.fill(".rs-other-input", "   ");
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForTimeout(200);
assert.ok(await preview.$('[data-qid="q1"]'), "whitespace is not an answer");
await preview.fill(".rs-other-input", "Parent of a student");
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForSelector('[data-qid="q2"]');
console.log("✔ Other with text advances");

// the programmer can relax it
await goTab("Questions");
await (await cards())[0].click();
await page.waitForSelector('[data-testid="other-specify-required"]');
await page.click('[data-testid="other-specify-required"] input');
await page.waitForTimeout(300);
def = await readDef();
assert.equal(def.questions[0].settings.otherSpecifyOptional, true);
await show(def);
await preview.click('[data-qid="q1"] .rs-option:has-text("Other")');
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForSelector('[data-qid="q2"]');
console.log("✔ …unless the programmer makes the text optional for that question");

/* ============================================================ 6. counts */
await goTab("Questions");
await page.click('[data-testid="close-question"]').catch(() => {});
await (await cards())[1].click();
await page.waitForSelector('[data-testid="min-selections"]');
const minSel = await page.$('[data-testid="min-selections"]');
await minSel.click();
await minSel.fill("");
await page.keyboard.type("-5");
await page.waitForTimeout(300);
def = await readDef();
const stored = def.questions[1].settings.minSelections;
assert.ok(stored === 5 || stored === 0 || stored === undefined,
  `a negative count is never stored (got ${stored})`);
await goTab("Questions");
await page.waitForSelector('[data-testid="min-selections"]');
assert.equal(await page.$eval('[data-testid="min-selections"]', (e) => e.min), "0", "the field itself declares the floor");
console.log(`✔ typing -5 into min selections stores ${stored ?? "nothing"}, never -5`);

// a value pasted or set programmatically below zero is clamped on the way in
await page.$eval('[data-testid="max-selections"]', (e) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(e, "-3");
  e.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(300);
def = await readDef();
assert.equal(def.questions[1].settings.maxSelections, 0, "a pasted -3 is clamped to 0");
console.log("✔ a pasted negative is clamped, not stored");

// and the engine lint reports one that arrives by other means
await loadFixture({
  ...FIXTURE,
  questions: FIXTURE.questions.map((q, i) => i === 1 ? { ...q, settings: { minSelections: -5, maxSelections: 3 } } : q),
});
await goTab("Logic");
await page.waitForTimeout(300);
const logicText = await page.textContent("body");
assert.match(logicText, /minSelections is -5/, "the survey-wide logic check names the bad count");
console.log("✔ a negative count arriving from JSON is reported by the logic check");

await browser.close();
console.log("\nALL TESTER-FIX CHECKS PASSED");
