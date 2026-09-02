/**
 * Phase 2 (blocks) and Phase 4 (option properties).
 *
 * Asserts that the editor presents a survey as Survey → Blocks → Questions,
 * that every block operation the brief asks for exists and writes the right
 * flow, and that an option can hold several properties at once — the
 * "Other + Exclusive" requirement that a single-value control made impossible.
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
const blockCount = () => page.$$eval(".block-badge", (els) => els.filter((e) => /BLOCK/.test(e.textContent)).length);
const perBlock = () => page.$$eval(".block", (els) => els.map((e) => e.querySelectorAll(".qcard").length));

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------- blocks, not page breaks */

const bodyText = await page.evaluate(() => document.body.innerText);
assert.match(bodyText, /BLOCK 1/, "the container is labelled as a Block");
// A page break is offered again — it paginates a block — but it is never a
// question card and never a block of its own; pagebreak-test.mjs proves that.
const breakIsACard = await page.$$eval(".qcard", (els) =>
  els.some((e) => /page break/i.test(e.textContent)));
assert.ok(!breakIsACard, "a page break is not presented as a question");
console.log("✔ the editor shows Blocks, and a page break is structure rather than content");

/* ------------------------------------------------------------ add + rename */

await page.fill('[data-testid="block-title"]', "Introduction");
await page.waitForTimeout(250);
let def = await readDef();
const firstPage = def.flow.find((n) => n.type === "page");
assert.equal(firstPage.title, "Introduction", "renaming a block writes its title");
console.log("✔ a block can be named — stored on the page node");

await page.click('[data-testid="add-block"]');
await page.waitForTimeout(250);
assert.equal(await blockCount(), 2, "a second block appears");
console.log("✔ blocks can be added");

/* -------------------------------------------- questions inside their block */

const addQuestionTo = async (blockIdx, text) => {
  const blocks = await page.$$(".block");
  const bar = await blocks[blockIdx].$(".insert-bar >> text=+ Question");
  await bar.click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(350);
};

await addQuestionTo(0, "What is your age?");
await addQuestionTo(0, "What is your occupation?");
await addQuestionTo(1, "Which product do you prefer?");
await page.waitForTimeout(200);
assert.deepEqual(await perBlock(), [2, 1], `questions land in their own block: ${await perBlock()}`);
console.log("✔ questions live inside the block they were added to (2 + 1)");

def = await readDef();
const pages = def.flow.filter((n) => n.type === "page");
assert.equal(pages.length, 2);
assert.equal(pages[0].questionIds.length, 2);
assert.equal(pages[1].questionIds.length, 1);
console.log("✔ the flow matches the visual hierarchy");

/* ------------------------------------------------- move a question across */

// the cramped "move to…" select became a dialog that also picks the position;
// flow-export-test.mjs covers the position choice, this covers the move
const moveBtn = await page.$('[data-testid="move-question-btn"]');
assert.ok(moveBtn, "each question offers a move control");
await moveBtn.click();
await page.waitForSelector('[data-testid="move-question"]');
const dests = await page.$$('[data-testid="move-blocks"] input[type=radio]');
await dests[1].check();
await page.click('[data-testid="do-move"]');
await page.waitForTimeout(350);
assert.deepEqual(await perBlock(), [1, 2], `question moved between blocks: ${await perBlock()}`);
console.log("✔ a question can be moved into another block");

/* ------------------------------------------------------------- reorder */

let titles = await page.$$eval(".block-title", (els) => els.map((e) => e.value));
const menus = await page.$$('[data-testid="block-menu"]');
await menus[1].click();
await page.click('.menu-item:has-text("Move block up")');
await page.waitForTimeout(250);
const reordered = await page.$$eval(".block-title", (els) => els.map((e) => e.value));
assert.deepEqual(reordered, [titles[1], titles[0]], `blocks reorder: ${reordered}`);
console.log("✔ blocks can be reordered");

/* ----------------------------------------------------------- duplicate */

const before = await blockCount();
const menus2 = await page.$$('[data-testid="block-menu"]');
await menus2[0].click();
await page.click('.menu-item:has-text("Duplicate block")');
await page.waitForTimeout(300);
assert.equal(await blockCount(), before + 1, "duplicating adds a block");
def = await readDef();
const codes = def.questions.map((q) => q.code);
assert.ok(codes.some((c) => /_COPY$/.test(c)), `duplicated questions get fresh codes: ${codes.join(",")}`);
assert.equal(new Set(def.questions.map((q) => q.id)).size, def.questions.length, "ids stay unique");
console.log("✔ duplicating a block copies its questions with fresh ids and codes");

/* ------------------------------------------------------------- collapse */

await page.click(".block .block-toggle");
await page.waitForTimeout(200);
const collapsedBodies = await page.$$eval(".block.collapsed", (els) => els.length);
assert.equal(collapsedBodies, 1, "a block collapses");
await page.click(".block .block-toggle");
await page.waitForTimeout(200);
console.log("✔ blocks collapse and expand");

/* --------------------------------------------------------------- delete */

const beforeDelete = await blockCount();
const menus3 = await page.$$('[data-testid="block-menu"]');
await menus3[menus3.length - 1].click();
await page.click('.menu-item:has-text("Delete block")');
await page.waitForTimeout(350);
assert.equal(await blockCount(), beforeDelete - 1, "deleting removes the block");
console.log("✔ a block can be deleted, with its questions");

/* ============================ Phase 4: option properties combine freely == */

// "Other + Exclusive" is a MULTI-select requirement — a single-select is
// exclusive by definition, and the editor correctly does not offer the flag
// there. Add a multi-select, which is the brief's own example.
await page.click('[data-testid="add-question-top"]');
await page.waitForSelector(".card.selectable");
await page.click("text=Multi Select");
await page.waitForTimeout(200);
await page.click(".card.selectable >> nth=0");
await page.waitForSelector(".qcard.selected .rte-surface");
await page.keyboard.type("Which products do you use?");
await page.waitForTimeout(350);

const hasOption = await page.$('.qcard.selected input[data-oidx="0"]');
if (!hasOption) await page.click('.qcard.selected [data-testid="add-option"]');
await page.click('.qcard.selected input[data-oidx="0"]');
await page.keyboard.type("Other");
await page.waitForTimeout(300);
await page.waitForSelector('.qcard.selected [data-testid="option-flags-0"]');
await page.click('.qcard.selected [data-testid="option-flags-0"]');
await page.waitForSelector('[data-testid="option-flag-0-other_specify"]');

// the exact combination the brief calls out: Other + Exclusive, together
await page.check('[data-testid="option-flag-0-other_specify"]');
await page.waitForTimeout(150);
await page.check('[data-testid="option-flag-0-exclusive"]');
await page.waitForTimeout(300);

def = await readDef();
const withFlags = def.questions.find((q) => (q.options ?? []).some((o) => (o.flags ?? []).length > 0));
const flags = withFlags.options.find((o) => (o.flags ?? []).length > 0).flags;
assert.ok(flags.includes("other_specify"), `other survives: ${flags}`);
assert.ok(flags.includes("exclusive"), `exclusive survives alongside it: ${flags}`);
assert.equal(flags.length, 2, `both properties are held at once: ${flags}`);
console.log(`✔ an option holds several properties at once: ${flags.join(" + ")}`);

// anchor top and bottom remain genuinely mutually exclusive
await page.click('.qcard.selected [data-testid="option-flags-0"]').catch(() => {});
await page.waitForSelector('[data-testid="option-flag-0-anchor_top"]');
await page.check('[data-testid="option-flag-0-anchor_top"]');
await page.waitForTimeout(150);
await page.check('[data-testid="option-flag-0-anchor_bottom"]');
await page.waitForTimeout(300);
def = await readDef();
const anchored = def.questions
  .flatMap((q) => q.options ?? [])
  .find((o) => (o.flags ?? []).includes("anchor_bottom"));
assert.ok(!anchored.flags.includes("anchor_top"),
  `an option cannot be pinned to both ends: ${anchored.flags}`);
console.log("✔ anchor top / bottom stay mutually exclusive — the one pair that must be");

await browser.close();
console.log("\nALL BLOCK + OPTION PROPERTY CHECKS PASSED");

/* =================== Phase 3 + 5: IF/THEN logic, full-page test, debug === */

await (async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  // --- Phase 3: display and skip logic read as IF → THEN
  await p.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
  await p.click(".insert-bar >> text=+ Question");
  await p.waitForSelector(".qcard.selected");
  await p.waitForTimeout(300);

  const ifThen = await p.$eval(".rightpanel", (e) => e.innerText.replace(/\s+/g, " "));
  assert.match(ifThen, /IF/, `display logic is framed as IF: ${ifThen.slice(0, 120)}`);
  assert.match(ifThen, /THEN show/, `and states the action: ${ifThen.slice(0, 200)}`);
  console.log("✔ display logic reads IF → conditions → THEN show <question>");

  await p.click('.rightpanel >> text=+ skip rule');
  await p.waitForSelector(".skip-target");
  const skipText = await p.$eval(".rightpanel", (e) => e.innerText.replace(/\s+/g, " "));
  assert.match(skipText, /THEN GO TO/, `skip logic states its action: ${skipText.slice(0, 200)}`);
  console.log("✔ skip logic reads IF → conditions → THEN GO TO <target>");

  // --- Phase 5: the survey runs full-page, debug is optional
  const def = {
    meta: { id: "p5", code: "P5", title: "Phase 5", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "Pick one",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q2", code: "Q2", variableName: "B", type: "open_text", text: "Why?" },
    ],
    flow: [
      { type: "page", id: "b1", title: "Intro", questionIds: ["q1"] },
      { type: "page", id: "b2", title: "Detail", questionIds: ["q2"] },
      { type: "end", id: "e", status: "complete" },
    ],
  };
  await p.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
  await p.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await p.waitForSelector(".rs-card");

  // no inspector until asked for — the survey gets the whole page
  let inspectorOpen = await p.$$eval(".rs-inspector", (els) => els.length);
  assert.equal(inspectorOpen, 0, "debug is off by default");
  const shellWidth = await p.$eval(".rs-shell, .rs-card", (e) => e.getBoundingClientRect().width);
  const pageWidth = await p.evaluate(() => document.documentElement.clientWidth);
  assert.ok(shellWidth > pageWidth * 0.4,
    `the survey is not squeezed into a column: ${shellWidth.toFixed(0)} of ${pageWidth}`);
  console.log(`✔ preview runs full-page (${shellWidth.toFixed(0)}px of ${pageWidth}px), no docked panel`);

  // block position, as a respondent sees it
  const pos = await p.$eval('[data-testid="block-position"]', (e) => e.textContent.trim());
  // steps are PAGES, and a block may hold several — so the label counts pages
  // and names the block they sit in
  assert.equal(pos, "Intro · Page 1 of 2", `the toolbar reports position: ${pos}`);
  console.log(`✔ the runtime reports “${pos}”`);

  // debug on demand, showing real logic evaluation
  await p.click('[data-testid="debug-toggle"]');
  await p.waitForSelector(".rs-inspector");
  const dbg = (await p.$eval(".rs-inspector", (e) => e.innerText)).toLowerCase();
  for (const section of ["session", "display logic", "answers"]) {
    assert.ok(dbg.includes(section), `debug shows ${section}: ${dbg.slice(0, 120)}`);
  }
  console.log("✔ debug opens on demand with session, display-logic evaluation and answers");

  await p.click('[data-testid="debug-toggle"]');
  inspectorOpen = await p.$$eval(".rs-inspector", (els) => els.length);
  assert.equal(inspectorOpen, 0, "debug closes again");
  console.log("✔ debug closes, returning the full page to the survey");

  // the real engine drives it: answering advances the block
  await p.click(".rs-option");
  await p.click("text=Next");
  await p.waitForTimeout(400);
  const pos2 = await p.$eval('[data-testid="block-position"]', (e) => e.textContent.trim());
  assert.equal(pos2, "Detail · Page 2 of 2", `real navigation, not a mock: ${pos2}`);
  console.log("✔ preview executes the real engine — answering advances to the next page");

  await b.close();
})();

console.log("\nALL PHASE 3 + 5 CHECKS PASSED");
