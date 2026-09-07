/**
 * THE BLOCK ACTIONS ARE INDEPENDENT, AND ADD BLOCK ADDS A BLOCK.
 *
 * `blocks-test.mjs` clicks "+ Add block" on a flow where every block is still
 * a bare top-level page, and `pagebreak-test.mjs` never clicks it at all. That
 * gap is where the reported bug lived:
 *
 *     "+ Add block" found the last PAGE and inserted a sibling beside it. A
 *     page's parent array is whatever it actually sits in — so as soon as a
 *     block had a page break, the new "block" went into that block's children
 *     and became another page break. The block count did not move, and the
 *     button had performed a page-break action under an Add Block label.
 *
 * Nested in a group, a branch or a loop it was worse: the new block landed
 * inside the branch path and would have been seen by only some respondents.
 *
 * So every check here runs AFTER the flow has been made non-trivial. A test
 * that only ever exercises the one-block case is the test that let this
 * through.
 *
 *   node scripts/block-actions-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await page.click(".leftnav >> text=Questions");
  await page.waitForSelector(".block-badge");
  return JSON.parse(json);
};

/** Blocks as the engine counts them, read straight from the flow. */
const countBlocks = (flow) => {
  let n = 0;
  const walk = (nodes) => {
    for (const x of nodes ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.type === "page") { n++; continue; }
      if (x.type === "block") {
        if ((x.children ?? []).some((k) => k?.type === "page")) n++;
        walk((x.children ?? []).filter((k) => k?.type !== "page"));
        continue;
      }
      if (x.children) walk(x.children);
      if (x.branches) for (const b of x.branches) walk(b.children);
      if (x.otherwise) walk(x.otherwise);
    }
  };
  walk(flow);
  return n;
};

/** Pages inside a block wrapper — a page break each beyond the first. */
const pagesInWrappers = (flow) => {
  let n = 0;
  const walk = (nodes) => {
    for (const x of nodes ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.type === "block") n += (x.children ?? []).filter((k) => k?.type === "page").length;
      if (x.children) walk(x.children);
      if (x.branches) for (const b of x.branches) walk(b.children);
      if (x.otherwise) walk(x.otherwise);
    }
  };
  walk(flow);
  return n;
};

const badge = () => page.$$eval(".block-badge", (els) =>
  els.filter((e) => /BLOCK/.test(e.textContent)).length);

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/*
 * The sandbox opens on ONE EMPTY BLOCK, so the controls under test do not
 * exist yet: a page break needs a question to break after, and a split needs a
 * question with siblings above and below it. Three questions first.
 */
const addQuestion = async (blockIdx = 0) => {
  const blocks = await page.$$(".block");
  const bar = await blocks[blockIdx].$(".insert-bar >> text=+ Question");
  await bar.click();
  await page.waitForTimeout(220);
};
await addQuestion();
await addQuestion();
await addQuestion();
assert.equal((await page.$$(".qcard")).length, 3, "three questions to work with");
ok("set up: one block, three questions");

/* ================================================= every command is named */

/*
 * Nothing here shared a callback — but nothing could tell the controls apart
 * either: "+ Add block" appeared twice with one test id between them, and
 * "📋 paste options" (which belongs to the option list) is mounted once per
 * matrix column, so an unscoped selector hits whichever came first. Naming the
 * command on the button is what makes a swapped handler a failing assertion.
 */
const commands = await page.$$eval("[data-command]", (els) =>
  els.map((e) => ({ cmd: e.getAttribute("data-command"), text: e.textContent.trim() })));
const byCmd = (c) => commands.filter((x) => x.cmd === c);
assert.ok(byCmd("add-block").length >= 1, `add-block is named: ${JSON.stringify(commands)}`);
assert.ok(byCmd("add-page-break").length >= 1, "add-page-break is named");
for (const c of byCmd("add-block")) assert.match(c.text, /Add block/i);
for (const c of byCmd("add-page-break")) assert.match(c.text, /Page break/i);
ok("every block control carries its own command identifier");

/*
 * The two buttons that both say "+ Add block" are now distinguishable, and
 * both run the same command — which is the point: one label, one action.
 */
const addButtons = await page.$$eval('[data-command="add-block"]', (els) =>
  els.map((e) => e.getAttribute("data-testid")));
assert.deepEqual(addButtons.sort(), ["add-block", "add-block-footer"],
  `both Add block buttons are addressable: ${JSON.stringify(addButtons)}`);
ok("the header and footer Add block buttons are separately addressable and run one command");

/* ============================================ TEST A — add, then add again */

let def = await readDef();
const startBlocks = countBlocks(def.flow);
const startWrapped = pagesInWrappers(def.flow);

await page.click('[data-command="add-block"]');
await page.waitForTimeout(300);
def = await readDef();
assert.equal(countBlocks(def.flow), startBlocks + 1, "one more block");
assert.equal(pagesInWrappers(def.flow), startWrapped, "and no new page break");
ok("Add block adds a block on a simple flow (what the old test covered)");

/* ============ the sequence nothing tested: a page break, THEN add a block */

/*
 * Two clicks is all it took to reproduce. A page break wraps the block in a
 * `block` node, and from that moment the last page in the flow lives inside a
 * wrapper — so the old Add Block appended into `children`.
 */
const pbBefore = await (await page.$$(".block"))[0].$$('[data-command="add-page-break"]');
assert.ok(pbBefore.length >= 1, "the first block offers a page break");
await pbBefore[0].click();
await page.waitForTimeout(350);

def = await readDef();
const wrappedNow = pagesInWrappers(def.flow);
assert.ok(wrappedNow >= 2, `the block is now paginated: ${wrappedNow} pages in wrappers`);
const beforeBlocks = countBlocks(def.flow);
ok("a page break wraps its block — the state the old Add Block broke in");

await page.click('[data-command="add-block"]');
await page.waitForTimeout(350);
def = await readDef();

assert.equal(
  countBlocks(def.flow), beforeBlocks + 1,
  "ADD BLOCK MUST ADD A BLOCK: the block count moved",
);
assert.equal(
  pagesInWrappers(def.flow), wrappedNow,
  "…and it must NOT have added a page inside the existing block (that is a page break, not a block)",
);
ok("ADD BLOCK ADDS A BLOCK EVEN AFTER A PAGE BREAK EXISTS — the reported bug");

/*
 * Where it went matters as much as that it went somewhere. A new block belongs
 * at the top level, in front of the End node, which is what the Survey Flow
 * tab's own "+ Add block" has always done.
 */
const topLevel = def.flow.filter((n) => n.type === "page");
const endAt = def.flow.findIndex((n) => n.type === "end");
const lastPageAt = def.flow.map((n) => n.type).lastIndexOf("page");
assert.ok(topLevel.length >= 1, "the new block is a top-level page node");
if (endAt >= 0) {
  assert.ok(lastPageAt < endAt, `the new block sits in front of the End node (page ${lastPageAt}, end ${endAt})`);
  ok("a new block goes in front of the End node, where respondents can reach it");
} else {
  ok("a new block goes at the end of the top-level flow");
}

/*
 * And it is usable. The old bug's page was unreachable: the insert bar renders
 * per existing question and the empty-block bar keys off the whole block's
 * count, so a 0-question page inside a non-empty block got no "+ Question"
 * control at all.
 */
const lastBlock = (await page.$$(".block")).pop();
assert.ok(await lastBlock.$(".insert-bar"), "the new block offers a way to put a question in it");
ok("the new block is reachable — it has its own insert bar");

/* ================================== TEST B — Split Block only splits */

/*
 * Same defect class: splitBlock spliced into the PAGE's parent, so splitting
 * inside a paginated block produced another page break while toasting
 * "Block split".
 */
/** Every question, in the order the flow places it — no losses, no copies. */
const placedQuestionIds = (flow) => {
  const ids = [];
  const collect = (nodes) => {
    for (const x of nodes ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.type === "page") ids.push(...(x.questionIds ?? []));
      if (x.children) collect(x.children);
      if (x.branches) for (const b of x.branches) collect(b.children);
      if (x.otherwise) collect(x.otherwise);
    }
  };
  collect(flow);
  return ids;
};

/*
 * The "⤵" split needs a single-page block with a question above and below the
 * split point, so it goes in the block Add Block just made — which is also a
 * second check that that block is genuinely usable.
 */
const lastIdx = (await page.$$(".block")).length - 1;
await addQuestion(lastIdx);
await addQuestion(lastIdx);
await addQuestion(lastIdx);

def = await readDef();
const preSplitBlocks = countBlocks(def.flow);
const preSplitWrapped = pagesInWrappers(def.flow);
const preSplitPlaced = placedQuestionIds(def.flow);

const splitBtns = await (await page.$$(".block")).at(-1).$$('[data-command="split-block"]');
assert.ok(splitBtns.length >= 1,
  "a single-page block with three questions offers a split");
await splitBtns[0].click();
await page.waitForTimeout(350);
def = await readDef();

assert.equal(countBlocks(def.flow), preSplitBlocks + 1,
  "SPLIT BLOCK MUST SPLIT INTO A BLOCK: the block count moved");
assert.equal(pagesInWrappers(def.flow), preSplitWrapped,
  "…and it did not quietly add a page break inside the block instead");
ok("SPLIT BLOCK SPLITS INTO A BLOCK, not into another page break");

const postSplitPlaced = placedQuestionIds(def.flow);
assert.equal(new Set(postSplitPlaced).size, postSplitPlaced.length,
  `no question is on two pages: ${JSON.stringify(postSplitPlaced)}`);
assert.deepEqual(postSplitPlaced.slice().sort(), preSplitPlaced.slice().sort(),
  "exactly the same questions are placed, before and after");
assert.deepEqual(postSplitPlaced, preSplitPlaced,
  "and in the same order — a split moves a boundary, not the questions");
ok("a split moves the boundary, not the questions — none lost, copied or reordered");

/* ------- and the page-break "split block", which is the wrapped path ----- */

/*
 * The other split control: the one on a PAGE BREAK divider, which promotes
 * that page and everything below it out of the wrapper. This is the wrapped
 * case, and it is the reason `splitBlock` now works at block level too — the
 * two controls mean the same thing and must not disagree.
 */
const atBreak = await page.$('[data-command="split-block-at-break"]');
if (atBreak) {
  const beforeB = countBlocks(def.flow);
  const beforeW = pagesInWrappers(def.flow);
  const beforeP = placedQuestionIds(def.flow);
  await atBreak.click();
  await page.waitForTimeout(350);
  def = await readDef();
  assert.equal(countBlocks(def.flow), beforeB + 1, "the page became its own block");
  assert.ok(pagesInWrappers(def.flow) < beforeW,
    "…and it LEFT the wrapper rather than being copied out of it");
  assert.deepEqual(placedQuestionIds(def.flow), beforeP,
    "with every question still placed, in order");
  ok("the page-break split promotes a page out of its block, and agrees with the question split");
} else {
  ok("no page break remained to split at (the earlier split consumed it)");
}

/* ================================== TEST C — Paste is not a block command */

/*
 * The half of the report that said "Add Block opens Paste". Nothing can open
 * the paste box but its own control, which lives inside the SELECTED
 * QUESTION's option editor — several hundred pixels and one selection away
 * from the block toolbar. The likeliest story is that Add Block appeared to do
 * nothing (the bug above), and the next control anybody reaches for is
 * "📋 paste options" beside "+ option".
 *
 * Either way the two are now provably independent.
 */
await page.click(".qcard");
await page.waitForSelector(".qcard.selected");
const pasteBtn = await page.$('.qcard.selected [data-command="paste-options"]');
if (pasteBtn) {
  def = await readDef();
  const before = countBlocks(def.flow);
  await page.click(".qcard");
  await page.waitForSelector(".qcard.selected");
  await (await page.$('.qcard.selected [data-command="paste-options"]')).click();
  await page.waitForTimeout(250);
  assert.ok(await page.$('.qcard.selected [data-testid="paste-panel"]'),
    "the paste box opens when its own control is clicked");
  def = await readDef();
  assert.equal(countBlocks(def.flow), before, "opening the paste box creates no block");
  ok("PASTE OPENS PASTE, and touches no block");

  /* and the converse: adding a block does not open the paste box */
  await page.click('[data-command="add-block"]');
  await page.waitForTimeout(300);
  const panels = await page.$$('[data-testid="paste-panel"]');
  assert.equal(panels.length, 0, "adding a block did not open a paste box");
  ok("ADD BLOCK DOES NOT OPEN PASTE — the two are independent in both directions");
} else {
  ok("the paste box is scoped to a selected question's option list (not offered for this type)");
}

/* ------------------------------------------------------------- no errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL BLOCK ACTION CHECKS PASSED (${passed})`);
