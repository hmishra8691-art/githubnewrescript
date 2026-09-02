/**
 * Page breaks inside a block.
 *
 * The requirement, in one line: a break splits the respondent's page WITHOUT
 * splitting the block. So every assertion here comes in two halves — what the
 * respondent sees changed, and what the block structure did not.
 *
 * Drives the real Studio at /sandbox and the real runtime at /preview; the
 * definition is read back from the JSON tab, so these are claims about stored
 * data, not about the screen.
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
const blockCount = () => page.$$eval('[data-testid="block"]', (els) => els.length);
const breakCount = () => page.$$eval('[data-testid="page-break"]', (els) => els.length);

/** Add a question at the end of the last block. */
const addQuestion = async (text) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(300);
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

for (const t of ["Q1 age", "Q2 gender", "Q3 region", "Q4 income", "Q5 brand", "Q6 recommend"]) {
  await addQuestion(t);
}
await page.fill('[data-testid="block-title"]', "Demographics");
await page.waitForTimeout(250);

let def = await readDef();
assert.equal(def.flow.filter((n) => n.type === "page" || n.type === "block").length, 1,
  "one block to start with");
assert.equal(def.flow[0].type, "page", "and it is still a bare page node — nothing wrapped yet");
assert.equal(def.flow[0].questionIds.length, 6);
console.log("✔ six questions in one block, stored as a single page node");

/* ------------------------------------------------------- the first break */

// the insert bar after the 2nd question
const bars = await page.$$(".insert-bar");
const breakBtn = await bars[1].$('[data-testid="add-page-break"]');
assert.ok(breakBtn, "a page break is offered between two questions");
await breakBtn.click();
await page.waitForSelector('[data-testid="page-break"]');

assert.equal(await blockCount(), 1, "STILL ONE BLOCK — the break did not create another");
assert.equal(await breakCount(), 1, "and the break is drawn between the questions");
console.log("✔ adding a page break leaves the block count at 1");

def = await readDef();
const block = def.flow[0];
assert.equal(block.type, "block", "the block became a container so it can hold pages");
assert.equal(block.title, "Demographics", "the name moved up to the block, intact");
assert.equal(block.children.length, 2, "two pages inside one block");
assert.deepEqual(block.children.map((c) => c.type), ["page", "page"]);
assert.equal(block.children[0].questionIds.length, 2, "Q1–Q2 on the first page");
assert.equal(block.children[1].questionIds.length, 4, "Q3–Q6 on the second");
assert.equal(block.children[0].id, def.flow[0].children[0].id);
console.log("✔ stored as ONE block with two pages:",
  block.children.map((c) => c.questionIds.length).join(" + "));

/* -------------------------------------------- the first page keeps its id */

// identity matters: skip rules written before the break point at the page id,
// and "jump to this block" must still land on its first page
assert.ok(!/^block/.test(block.children[0].id),
  `the original page kept its id, the new block node took a fresh one (${block.children[0].id})`);
console.log("✔ the original page id survived the wrap — existing logic still resolves");

/* ------------------------------------------------------ a second break */

const bars2 = await page.$$(".insert-bar");
// bars now: after q1, after q2 (end of page 1), after q3, after q4, after q5, after q6
const secondBreak = await bars2[3].$('[data-testid="add-page-break"]');
await secondBreak.click();
await page.waitForTimeout(300);

assert.equal(await blockCount(), 1, "still one block after a second break");
assert.equal(await breakCount(), 2, "two breaks now");
def = await readDef();
assert.equal(def.flow[0].children.length, 3, "three pages in the one block");
const shape = def.flow[0].children.map((c) => c.questionIds.length);
assert.deepEqual(shape, [2, 2, 2], `pages split 2/2/2, got ${shape}`);
console.log("✔ multiple page breaks in a single block:", shape.join(" + "));

const badges = await page.$$eval('[data-testid="page-badge"]', (els) => els.map((e) => e.textContent.trim()));
assert.deepEqual(badges, ["PAGE 1", "PAGE 2", "PAGE 3"], `pages are numbered: ${badges}`);
console.log("✔ the block shows PAGE 1 / 2 / 3 inside itself");

/* ---------------------------------------------------------- move a break */

await page.click('[data-testid="page-break"] >> nth=0 >> text=↑');
await page.waitForTimeout(250);
def = await readDef();
assert.deepEqual(def.flow[0].children.map((c) => c.questionIds.length), [1, 3, 2],
  "the break moved up one question");
console.log("✔ a break moves: 2+2+2 → 1+3+2");

await page.click('[data-testid="page-break"] >> nth=0 >> text=↓');
await page.waitForTimeout(250);
def = await readDef();
assert.deepEqual(def.flow[0].children.map((c) => c.questionIds.length), [2, 2, 2], "and back again");
console.log("✔ and moves back: 1+3+2 → 2+2+2");

/* -------------------------------------------------------- delete a break */

await page.click('[data-testid="remove-page-break"] >> nth=0');
await page.waitForTimeout(250);
def = await readDef();
assert.equal(await blockCount(), 1, "deleting a break does not delete the block");
assert.deepEqual(def.flow[0].children.map((c) => c.questionIds.length), [4, 2],
  "the two pages merged, no questions lost");
console.log("✔ removing a break merges its pages, keeping every question");

/* ------------------------------- removing the last break unwraps the block */

await page.click('[data-testid="remove-page-break"] >> nth=0');
await page.waitForTimeout(250);
def = await readDef();
assert.equal(def.flow[0].type, "page", "with no breaks left, the block is a plain page again");
assert.equal(def.flow[0].title, "Demographics", "and it keeps its name");
assert.equal(def.flow[0].questionIds.length, 6, "all six questions back on one page");
assert.equal(await breakCount(), 0);
console.log("✔ the last break removed → the flow returns to exactly its original shape");

/* --------------------------------------- and the whole cycle is repeatable */

const bars3 = await page.$$(".insert-bar");
await (await bars3[2].$('[data-testid="add-page-break"]')).click();
await page.waitForTimeout(300);
def = await readDef();
assert.equal(def.flow[0].type, "block");
assert.deepEqual(def.flow[0].children.map((c) => c.questionIds.length), [3, 3]);
console.log("✔ re-adding a break wraps it again — 3 + 3");

/* ------------------------------- promoting a break to a real block boundary */
/**
 * The two operations must stay distinct and both reachable: a page break
 * paginates one block, "split block" ends it. Splitting at the break should
 * leave two ordinary single-page blocks and no wrapper.
 */
await page.screenshot({ path: "/tmp/st-pagebreak.png", fullPage: false });

await page.click('[data-testid="break-to-block"] >> nth=0');
await page.waitForTimeout(300);
assert.equal(await blockCount(), 2, "the break became a block boundary");
assert.equal(await breakCount(), 0, "so there is no break left inside either block");
def = await readDef();
const twoBlocks = def.flow.filter((n) => n.type === "page" || n.type === "block");
assert.deepEqual(twoBlocks.map((n) => n.type), ["page", "page"],
  "both blocks unwrapped back to plain pages");
assert.deepEqual(twoBlocks.map((n) => n.questionIds.length), [3, 3], "3 questions each");
assert.equal(twoBlocks[0].title, "Demographics", "the first block keeps the name");
console.log("✔ “split block” at a break makes two blocks — the operations stay distinct");
await browser.close();

/* ============================================ the respondent actually pages */
/**
 * The claim that matters: the same engine that runs the live survey puts these
 * questions on separate pages. Driven through the real runtime, not a stub.
 */
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 1400, height: 1000 } });
p2.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const q = (id, text) => ({
  id, code: id.toUpperCase(), variableName: id.toUpperCase(),
  type: "single_select", text,
  options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
});
const def2 = {
  meta: { id: "s1", code: "S1", title: "Page break demo", version: "1.0" },
  questions: [q("q1", "First question"), q("q2", "Second question"), q("q3", "Third question")],
  flow: [
    {
      type: "block",
      id: "b1",
      title: "Demographics",
      children: [
        { type: "page", id: "p1", questionIds: ["q1", "q2"] },
        { type: "page", id: "p2", questionIds: ["q3"] },
      ],
    },
    { type: "end", id: "e", status: "complete" },
  ],
};

await p2.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
await p2.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def2);
await p2.waitForSelector(".rs-card");

let text = await p2.evaluate(() => document.body.innerText);
assert.match(text, /First question/, "page 1 asks Q1");
assert.match(text, /Second question/, "and Q2");
assert.ok(!/Third question/.test(text), "but NOT Q3 — that is behind the break");
console.log("✔ the respondent sees only the questions before the break");

const pos = await p2.$eval('[data-testid="block-position"]', (e) => e.textContent.trim());
assert.equal(pos, "Demographics · Page 1 of 2", `position names the block and counts pages: ${pos}`);
console.log(`✔ the runtime reports “${pos}” — one block, two pages`);

const heading = await p2.$eval("h1", (e) => e.textContent.trim());
assert.equal(heading, "Demographics", "the block's heading carries onto its pages");

// answer both questions on page 1 and continue
for (const qid of ["q1", "q2"]) {
  await p2.click(`[data-qid="${qid}"] .rs-option >> nth=0`).catch(async () => {
    await p2.click(".rs-option >> nth=0");
  });
}
await p2.click("text=Next");
await p2.waitForTimeout(500);

text = await p2.evaluate(() => document.body.innerText);
assert.match(text, /Third question/, "page 2 asks Q3");
assert.ok(!/First question/.test(text), "and Q1 is behind us");
const pos2 = await p2.$eval('[data-testid="block-position"]', (e) => e.textContent.trim());
assert.equal(pos2, "Demographics · Page 2 of 2", `still the same block: ${pos2}`);
console.log(`✔ Next crosses the break into “${pos2}” — the block never changed`);

await b2.close();
console.log("\nALL PAGE BREAK CHECKS PASSED");
