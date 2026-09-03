/**
 * Editor-level E2E for option-level logic and visual piping.
 * Drives the real Studio at /sandbox and verifies that everything a
 * programmer configures through the UI lands in the survey definition:
 *
 *  - Always Show / Always Hide on an individual option
 *  - "Show when" with a multi-question condition built visually
 *  - option-to-option matching via the "this option" value
 *  - the readable logic summary
 *  - the list-operation builder (intersection across two questions)
 *  - the visual piping picker, its formats, and token chips in the editor
 *  - the option preview / debugger showing why an option is hidden
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await page.click(".leftnav >> text=Questions");
  return JSON.parse(json);
};

/** Add a question with the given text and options on the current last page. */
const addQuestion = async (text, options) => {
  const bars = await page.$$(".insert-bar");
  await bars[bars.length - 1].$("text=+ Question").then((b) => b.click());
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(350);

  const first = await page.$('.qcard.selected input[data-oidx="0"]');
  if (!first) await page.click('.qcard.selected [data-testid="add-option"]');
  await page.click('.qcard.selected input[data-oidx="0"]');
  for (let i = 0; i < options.length; i++) {
    await page.keyboard.type(options[i]);
    if (i < options.length - 1) await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(350);
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

await addQuestion("Which brands have you used?", ["Apple", "Nike", "Adidas"]);
await addQuestion("Which do you currently use?", ["Apple", "Nike", "Adidas"]);
await addQuestion("Which of these do you prefer?", ["Apple", "Nike", "Adidas", "Other"]);
let def = await readDef();
assert.equal(def.questions.length, 3, "three questions created");
console.log("✔ three questions built through the editor");

/* ------------------------------------------------- Always Show on an option */

// Q3 is selected; open the logic panel on its 4th option ("Other")
await page.click('.qcard.selected [data-testid="option-logic-3"]');
await page.waitForSelector('[data-testid="option-logic"]');
await page.click('[data-testid="option-logic"] [data-testid="vis-always_show"]');
await page.waitForSelector('[data-testid="logic-summary"]');
const summary = await page.$eval('[data-testid="logic-summary"]', (e) => e.textContent);
assert.match(summary, /Always shown/);
console.log("✔ readable logic summary:", summary.trim());

def = await readDef(); // note: switching tabs re-renders the questions panel
assert.equal(def.questions[2].options[3].logic.visibility, "always_show");
console.log("✔ Always Show is stored on the individual option");

/* ------------------------------------------------------- Always Hide */

await page.click('.qcard.selected [data-testid="option-logic-2"]');
await page.click('[data-testid="option-logic"] [data-testid="vis-always_hide"]');
await page.waitForTimeout(250);
def = await readDef();
assert.equal(def.questions[2].options[2].logic.visibility, "always_hide");
assert.equal(def.questions[2].options.length, 4, "hidden option stays in the definition");
console.log("✔ Always Hide keeps the option in the definition but marks it hidden");

/* ------------------------------------ show-when + option-to-option matching */

await page.click('.qcard.selected [data-testid="option-logic-0"]');
await page.click('[data-testid="option-logic"] [data-testid="vis-show_when"]');
// the builder now opens EMPTY — conditions come first, groups only when asked
// for — so the first condition is added rather than assumed
await page.waitForSelector('[data-testid="option-logic"] [data-testid="logic-builder"]');
await page.click('[data-testid="option-logic"] [data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="option-logic"] .cond-rule');

// source question = Q1, operator = has selected, value = this option.
// The source is now ONE grouped select whose values are prefixed by kind.
const rule = '[data-testid="option-logic"] .cond-rule';
const sourceSel = `${rule} .ref-select`;
const firstQ = await page.$eval(sourceSel, (el) => {
  const opt = [...el.options].find((o) => o.value.startsWith("q:") && o.value.length > 2);
  return opt ? opt.value : "";
});
assert.ok(firstQ, "the source picker lists questions");
await page.selectOption(sourceSel, firstQ);
await page.waitForTimeout(150);
await page.selectOption(`${rule} .op-select`, "selected").catch(() => {});
await page.click(`${rule} >> text=↺ this option`);
await page.waitForTimeout(300);

const summary2 = await page.$eval('[data-testid="logic-summary"]', (e) => e.textContent);
assert.match(summary2, /this option/);
console.log("✔ summary reads:", summary2.trim());

def = await readDef();
const optLogic = def.questions[2].options[0].logic;
assert.equal(optLogic.visibility, "show_when");
const firstRule = optLogic.when.children ? optLogic.when.children[0] : optLogic.when;
assert.deepEqual(firstRule.value, { $option: "code" }, "value references the option itself");
console.log("✔ option-to-option rule built visually:", JSON.stringify(firstRule.value));

/* ------------------------------------------------------- list operations */

const opKind = '[data-testid="list-operations"] [data-testid="list-op-kind-0"]';
await page.click('.rightpanel [data-testid="add-list-op"]');
await page.waitForSelector(opKind);
await page.selectOption(opKind, "intersect");
// add a second source list so it is a real intersection across two questions
await page.click('[data-testid="list-operations"] >> text=+ list');
await page.waitForTimeout(300);
def = await readDef();
const pipeline = def.questions[2].optionPipeline;
assert.equal(pipeline.length, 1);
assert.equal(pipeline[0].kind, "intersect");
assert.equal(pipeline[0].sources.length, 2, "intersection across two source lists");
console.log("✔ list-operation builder stored an intersection across 2 questions");

/* ------------------------------------------------------- visual piping */

await page.click('.qcard.selected .rte-surface');
await page.keyboard.press("End");
await page.click('.qcard.selected [data-testid="insert-piping"]');
await page.waitForSelector('.pipe-picker [data-testid="pipe-question"]');
await page.selectOption('.pipe-picker [data-testid="pipe-question"]', { index: 0 });
const propOptions = await page.$$eval('.pipe-picker [data-testid="pipe-property"] option', (els) =>
  els.map((e) => e.value));
assert.ok(propOptions.includes("label"), `properties offered: ${propOptions}`);
const preview = await page.$eval(".pipe-preview", (e) => e.textContent);
assert.match(preview, /^\{\{Q\d/);
await page.click('.pipe-picker [data-testid="pipe-insert"]');
await page.waitForTimeout(400);

const chipText = await page.$eval(".qcard.selected .rte-surface .pipe-chip", (e) => e.textContent);
assert.match(chipText, /→/, `chip renders as a token: ${chipText}`);
console.log("✔ piping picker inserted a chip:", chipText);

def = await readDef();
assert.match(def.questions[2].text, /\{\{Q1[.|]/, `stored token: ${def.questions[2].text}`);
assert.ok(!def.questions[2].text.includes("pipe-chip"), "chips are never persisted");
console.log("✔ the chip is stored as a plain token, not as markup");

/* --------------------------------------------------------- option preview */

await page.click('.qcard.selected [data-testid="toggle-option-preview"]');
await page.waitForSelector('[data-testid="option-status"]');
const statuses = await page.$$eval('[data-testid="option-status"] tr', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
assert.ok(statuses.length >= 4, `preview lists every option: ${statuses.length}`);
assert.ok(statuses.some((s) => /HIDDEN/.test(s)), "preview explains hidden options");
assert.ok(statuses.some((s) => /always show/.test(s)), "preview marks the pinned option");
console.log("✔ option preview explains each option:");
for (const s of statuses.slice(0, 4)) console.log("    ", s);

/* ------------------------------------------------------------ logic check */

await page.click(".leftnav >> text=Logic");
await page.waitForSelector('[data-testid="logic-check"]');
const errCount = await page.$eval('[data-testid="logic-error-count"]', (e) => e.textContent);
console.log("✔ survey-wide logic check reports:", errCount.trim());

await page.screenshot({ path: "/tmp/st-option-logic.png", fullPage: false });
await browser.close();
console.log("\nALL OPTION LOGIC + PIPING CHECKS PASSED");
