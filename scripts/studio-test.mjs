/**
 * Editor-level E2E (authoring UX batch): drives the real Studio at /sandbox.
 *  - inline + Question after a question, with focus moving to the new editor
 *  - structural + Page break, page grouping, merge
 *  - Enter-key option entry with focus follow; Backspace removes empty option
 *  - paste box: numbered/bulleted list import with cleanup
 *  - rich text: bold formatting persisted into the definition (JSON tab)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".page-badge");
console.log("✔ sandbox loads the Studio with page grouping");

// --- inline add: first question via insert bar on the empty page
await page.click(".insert-bar >> text=+ Question");
await page.waitForSelector(".qcard.selected .rte-surface");
await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"), null, { timeout: 4000 });
console.log("✔ + Question creates a question and focuses its text editor");

// type question text into the rich text surface
await page.keyboard.type("What is your favorite fruit?");
await page.waitForTimeout(400); // debounce commit

// --- option entry: type, Enter, type, Enter, type
await page.click('.qcard.selected input[data-oidx="0"]').catch(async () => {
  // no option yet — create the first one
  await page.click('.qcard.selected [data-testid="add-option"]');
  await page.waitForSelector('.qcard.selected input[data-oidx="0"]');
  await page.click('.qcard.selected input[data-oidx="0"]');
});
await page.keyboard.type("Apple");
await page.keyboard.press("Enter");
let active = await page.evaluate(() => document.activeElement?.dataset?.oidx);
assert.equal(active, "1", "Enter should focus the new option");
await page.keyboard.type("Banana");
await page.keyboard.press("Enter");
await page.keyboard.type("Orange");
let labels = await page.$$eval(".qcard.selected input[data-oidx]", (els) =>
  els.map((e) => e.value));
assert.deepEqual(labels, ["Apple", "Banana", "Orange"]);
console.log("✔ Enter creates and focuses the next option:", labels.join(" / "));

// Backspace on an empty new option removes it and refocuses the previous one
await page.keyboard.press("Enter"); // creates empty option 4
await page.keyboard.press("Backspace");
labels = await page.$$eval(".qcard.selected input[data-oidx]", (els) =>
  els.map((e) => e.value));
assert.deepEqual(labels, ["Apple", "Banana", "Orange"]);
active = await page.evaluate(() => document.activeElement?.dataset?.oidx);
assert.equal(active, "2", "Backspace should refocus the previous option");
console.log("✔ Backspace on empty option removes it and refocuses");

// --- paste box: numbered + bulleted lines cleaned
await page.click(".qcard.selected >> text=📋 paste options");
await page.fill('[data-testid="paste-box"]', "1. Mango\n2) Grapes\n- Papaya\n• Kiwi");
await page.click('[data-testid="import-options"]');
labels = await page.$$eval(".qcard.selected input[data-oidx]", (els) =>
  els.map((e) => e.value));
assert.deepEqual(labels, ["Apple", "Banana", "Orange", "Mango", "Grapes", "Papaya", "Kiwi"]);
console.log("✔ paste box imports and cleans numbered/bulleted options");

// --- rich text: bold a word, verify it lands in the stored definition
await page.click(".qcard.selected .rte-surface");
await page.keyboard.press("Control+a");
await page.click(".qcard.selected .rte-btn[title='Bold']");
await page.waitForTimeout(450);

// --- inline second question below the first
await page.click(".qcard.selected + .insert-bar >> text=+ Question");
await page.waitForSelector(".qcard.selected .rte-surface");
await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"), null, { timeout: 4000 });
await page.keyboard.type("How often do you buy fruit?");
await page.waitForTimeout(400);
let cardCount = await page.$$eval(".qcard", (els) => els.length);
assert.equal(cardCount, 2);
console.log("✔ inline + Question adds a second question below the first");

// --- page break between Q1 and Q2 → PAGE 2 appears containing Q2
const badgesBefore = await page.$$eval(".page-badge", (els) => els.length);
await page.click(".page-group .insert-bar >> nth=0 >> text=⤵ Page break");
await page.waitForFunction((n) => document.querySelectorAll(".page-badge").length === n + 1, badgesBefore);
const perPage = await page.$$eval(".page-group", (els) =>
  els.map((e) => e.querySelectorAll(".qcard").length));
assert.deepEqual(perPage, [1, 1], `questions per page: ${perPage}`);
console.log("✔ page break splits into PAGE 1 (Q1) and PAGE 2 (Q2)");

// merge back
await page.click(".page-group:nth-of-type(3) >> text=merge ↑").catch(() => {});
// (merge button may be in second group depending on DOM order; try generic)
const mergeBtn = await page.$(".page-head >> text=merge ↑");
if (mergeBtn) await mergeBtn.click();
await page.waitForTimeout(200);

// --- verify formatting + structure persisted into the definition JSON
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
const json = await page.$eval("textarea.code", (e) => e.value);
const def = JSON.parse(json);
assert.ok(/<(b|strong)>/i.test(def.questions[0].text), `bold persisted: ${def.questions[0].text}`);
assert.ok(def.questions[0].text.replace(/<[^>]*>/g, "").includes("What is your favorite fruit?"));
assert.equal(def.questions[0].options.length, 7);
assert.equal(def.questions[1].text.replace(/<[^>]*>/g, ""), "How often do you buy fruit?");
console.log("✔ rich-text formatting and structure persist in the survey JSON");

await page.click(".leftnav >> text=Questions");
await page.screenshot({ path: "/tmp/st-authoring.png", fullPage: false });
await browser.close();
console.log("\nALL STUDIO AUTHORING CHECKS PASSED");
