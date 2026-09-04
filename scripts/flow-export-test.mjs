/**
 * Survey Flow at block level, groups, moving questions, and both exports.
 *
 * Every assertion is either about the STORED definition (read back from the
 * JSON tab, not from the screen) or about a real HTTP response from the
 * export route. Nothing here trusts a rendered label on its own.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};
const toFlow = async () => { await page.click(".leftnav >> text=Survey Flow"); await page.waitForTimeout(200); };
const toQuestions = async () => { await page.click(".leftnav >> text=Questions"); await page.waitForTimeout(200); };

const addQuestion = async (text) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(280);
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

for (const t of ["Age?", "Gender?", "Region?"]) await addQuestion(t);
await page.fill('[data-testid="block-title"]', "Screener");
await page.waitForTimeout(200);
await page.click('[data-testid="add-block"]');
await page.waitForTimeout(250);
let titles = await page.$$('[data-testid="block-title"]');
await titles[1].fill("Product usage");
await page.waitForTimeout(200);
// give block 2 a question so moves have somewhere to land
const bars = await page.$$(".insert-bar");
await (await bars[bars.length - 1].$("text=+ Question")).click();
await page.waitForSelector(".qcard.selected .rte-surface");
await page.keyboard.type("Which product?");
await page.waitForTimeout(300);

/* ------------------------------------------- 1. the flow is blocks, not pages */

await toFlow();
await page.waitForSelector('[data-testid="flow-block"]');
const blockCards = await page.$$eval('[data-testid="flow-block"] .block-badge', (els) => els.map((e) => e.textContent.trim()));
assert.deepEqual(blockCards, ["BLOCK 1", "BLOCK 2"], `the flow lists blocks: ${blockCards}`);
const flowText = await page.$eval(".flow-panel", (e) => e.innerText);
assert.ok(!/\bPage 1\b/.test(flowText), "no top-level 'Page 1' — pages are not the flow's unit");
// block names live in editable inputs, so read their values rather than text
const flowTitles = await page.$$eval('[data-testid="flow-block-title"]', (els) => els.map((e) => e.value));
assert.deepEqual(flowTitles, ["Screener", "Product usage"], `named in the flow: ${flowTitles}`);
console.log("✔ the Survey Flow shows Blocks, not pages:", blockCards.join(", "));

/* ------------------------- page breaks stay inside their block, not in the flow */

await toQuestions();
const qbars = await page.$$(".insert-bar");
const pb = await qbars[1].$('[data-testid="add-page-break"]');
await pb.click();
await page.waitForTimeout(320);
await toFlow();
const afterBreak = await page.$$eval('[data-testid="flow-block"] .block-badge', (els) => els.length);
assert.equal(afterBreak, 2, "a page break did NOT add a flow entry");
const b1text = await page.$eval('[data-testid="flow-block"]', (e) => e.innerText);
assert.match(b1text, /2 pages/, `the block reports its pages instead: ${b1text.replace(/\n/g, " ")}`);
console.log("✔ adding a page break changes the block, not the flow");

/* ----------------------------------------- 2. a node between every two blocks */

const inserts = await page.$$('[data-testid="flow-insert"], [data-testid="flow-insert-end"]');
assert.ok(inserts.length >= 3, `an insertion point before, between and after: ${inserts.length}`);
// these ARE the buttons — one before each entry, one after the last
await inserts[1].click();
await page.waitForSelector('[data-testid="insert-branch"]');
await page.click('[data-testid="insert-branch"]');
await page.waitForTimeout(320);

let def = await readDef();
assert.deepEqual(
  def.flow.map((n) => n.type),
  ["block", "branch", "page", "end"],
  `the branch landed between the two blocks: ${def.flow.map((n) => n.type)}`,
);
console.log("✔ “+ Add element” inserts a branch between Block 1 and Block 2");

await toFlow();
const elCard = await page.$eval('[data-testid="flow-element"]', (e) => e.innerText);
assert.match(elCard, /Branch \/ condition/, `elements are named in plain language: ${elCard.split("\n")[0]}`);
console.log("✔ flow elements read as “Branch / condition”, not “branch”");

/* --------------------------------------------------- 4. groups of blocks */

await page.click('[data-testid="add-group"]');
await page.waitForSelector('[data-testid="flow-group"]');
await page.fill('[data-testid="group-title"]', "Demographics");
await page.waitForTimeout(250);

// move Block 2 into the group through its ⋮ menu. The per-block "group…"
// dropdown this used to drive is gone: "Move into…" replaced it, and lists
// every container that would accept the block, not only groups.
const blockEls = await page.$$('[data-testid="flow-block"]');
await blockEls[1].$eval('[data-testid="node-menu"]', (b) => b.click());
await page.waitForSelector('[data-testid="node-menu-open"]');
await page.click('[data-testid="move-into"] >> text=Group \u201cDemographics\u201d');
await page.waitForTimeout(320);

def = await readDef();
const group = def.flow.find((n) => n.type === "section");
assert.ok(group, "the group is a section node — the schema already had one");
assert.equal(group.title, "Demographics");
assert.equal(group.children.length, 1, "the block moved inside it");
assert.equal(group.children[0].title, "Product usage");
console.log("✔ a Group is a section node, and a block moves into it");

// grouping must not reorder the survey
const orderedBlockTitles = (d) => {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === "page") out.push(n.title ?? "(untitled)");
      else if (n.type === "block") out.push(n.title ?? "(untitled)");
      else if (n.type === "section") walk(n.children ?? []);
    }
  };
  walk(d.flow);
  return out;
};
assert.deepEqual(orderedBlockTitles(def), ["Screener", "Product usage"],
  "execution order is unchanged by grouping");
console.log("✔ grouping did not change the order the survey runs in");

await toFlow();
await page.waitForSelector('[data-testid="group-toggle"]');
let groupBody = await page.$$eval('.flow-group .fg-body', (els) => els.length);
assert.equal(groupBody, 1, "the group is expanded");
await page.click('[data-testid="group-toggle"]');
await page.waitForTimeout(200);
groupBody = await page.$$eval('.flow-group .fg-body', (els) => els.length);
assert.equal(groupBody, 0, "and collapses");
const shut = await page.$eval(".fg-shut", (e) => e.innerText);
assert.match(shut, /Product usage/, `a collapsed group still says what is inside: ${shut}`);
await page.click('[data-testid="group-toggle"]');
console.log("✔ groups collapse and expand, and name their contents when shut");

// ungroup returns the block to the top level, and keeps it
await page.click('[data-testid="ungroup"]');
await page.waitForTimeout(300);
def = await readDef();
assert.ok(!def.flow.some((n) => n.type === "section"), "the group is gone");
assert.deepEqual(orderedBlockTitles(def), ["Screener", "Product usage"], "both blocks survived it");
console.log("✔ “ungroup” removes the group and keeps its blocks in place");

/* --------------------------------------- 3. move a question between blocks */

await toQuestions();
await page.click('[data-testid="move-question-btn"] >> nth=0');
await page.waitForSelector('[data-testid="move-question"]');

// pick the second block, then an explicit position
const blockRadios = await page.$$('[data-testid="move-blocks"] input[type=radio]');
assert.ok(blockRadios.length >= 2, "every block is offered as a destination");
await blockRadios[1].check();
await page.waitForTimeout(200);
const posRadios = await page.$$('[data-testid="move-positions"] input[type=radio]');
assert.ok(posRadios.length >= 2, `positions within the destination: ${posRadios.length}`);
await posRadios[0].check(); // beginning of the page
await page.click('[data-testid="do-move"]');
await page.waitForTimeout(350);

def = await readDef();
const pagesOf = (d) => {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) {
    if (n.type === "page") out.push(n);
    if (n.children) walk(n.children);
  } };
  walk(d.flow);
  return out;
};
const allPages = pagesOf(def);
const q1 = def.questions[0];
const holder = allPages.find((p) => p.questionIds.includes(q1.id));
assert.equal(holder.questionIds[0], q1.id, "it landed at the beginning, as asked");
assert.ok(!allPages[0].questionIds.includes(q1.id), "and left the block it came from");
console.log("✔ a question moves to a chosen block AND a chosen position");

// the question object itself is untouched — this is the whole point
const moved = def.questions.find((x) => x.id === q1.id);
assert.equal(moved.code, q1.code);
assert.equal(moved.text, q1.text);
assert.equal(moved.type, q1.type);
assert.deepEqual(moved.options, q1.options);
assert.equal(def.questions.length, 4, "nothing was duplicated");
console.log("✔ the move preserved id, code, text, type and options — it is a move, not a copy");

/* ------------------------------------------------ 5 & 6. the exports */

await readDef(); // leaves the JSON tab mounted, which the byte probe below reads
await page.click('[data-testid="export-survey"]');
await page.waitForSelector('[data-testid="export-dialog"]');

// presets really change the selection
await page.click('[data-testid="preset-basic"]');
await page.waitForTimeout(150);
let skipTicked = await page.$eval('[data-testid="field-skipLogic"]', (e) => e.checked);
assert.equal(skipTicked, false, "the basic preset does not include skip logic");
await page.click('[data-testid="preset-spec"]');
await page.waitForTimeout(150);
skipTicked = await page.$eval('[data-testid="field-skipLogic"]', (e) => e.checked);
assert.equal(skipTicked, true, "the programming spec does");
let state = await page.$eval('[data-testid="preset-state"]', (e) => e.textContent);
assert.match(state, /Programming specification/, state);
console.log("✔ export presets change what is ticked:", state.trim());

// unticking one box makes it a custom selection
await page.click('[data-testid="field-piping"]');
await page.waitForTimeout(150);
state = await page.$eval('[data-testid="preset-state"]', (e) => e.textContent);
assert.match(state, /Custom/, `an edited preset is honestly labelled Custom: ${state}`);
console.log("✔ editing a preset reports “Custom” rather than pretending");

/*
 * The Word export, as a REQUEST.
 *
 * The bytes are no longer inspected here: `packages/exporters` already asserts
 * that `exportSurveyDocx` produces a real zip with content, which is where a
 * pure function belongs, and duplicating it through a browser proved nothing
 * extra. What only this test can prove is that the dialog sends what the
 * programmer selected — the format and the exact field set.
 */
const docxReq = page.waitForRequest((r) => r.url().includes("/export/survey") && r.method() === "POST");
const docxRes = page.waitForResponse((r) => r.url().includes("/export/survey") && r.request().method() === "POST");
await page.click('[data-testid="do-export"]');
const sentDocx = (await docxReq).postDataJSON();
assert.equal(sentDocx.format, "docx", "the chosen format is sent");
assert.ok(sentDocx.definition?.questions?.length, "with the live editor state, not a stale copy");
assert.equal(sentDocx.fields.blockName, true, "and the ticked fields");
console.log("✔ the Word export sends the live definition and the selected fields");

/*
 * And the export route is now BEHIND AUTHORIZATION.
 *
 * This fixture has no session — it drives the Studio with no project row — so
 * the honest answer from the route is 401. That is the assertion worth making:
 * an endpoint that renders a project must not answer an unauthenticated
 * caller, and before the accounts layer it did.
 */
const res = await docxRes;
assert.equal(res.status(), 401, `an unauthenticated export must be refused, got ${res.status()}`);
console.log("✔ the export route refuses a caller with no session (accounts layer)");

/* the JSON export, through the same configuration */
await page.waitForTimeout(400);
/*
 * The dialog is still open: the export was refused, and a dialog that closed
 * on failure would throw away the programmer's field selection along with the
 * error. Reopen it only if it actually closed.
 */
if (!(await page.$('[data-testid="export-dialog"]'))) {
  await page.click('[data-testid="export-survey"]');
  await page.waitForSelector('[data-testid="export-dialog"]');
}
await page.click('[data-testid="preset-full"]');
await page.click('[data-testid="fmt-json"] input');
await page.waitForTimeout(150);
const jsonReq = page.waitForRequest((r) => r.url().includes("/export/survey") && r.method() === "POST");
await page.click('[data-testid="do-export"]');
const sentJson = (await jsonReq).postDataJSON();
assert.equal(sentJson.format, "json", "the JSON format is sent");
assert.equal(sentJson.fields.branchLogic, true, "with the Full preset's fields");

/*
 * The exported document, built by the REAL exporter from the EXACT definition
 * the editor put on the wire.
 *
 * The route only wraps this pure function, and the fixture has no session to
 * call it with — so running it here loses nothing and gains something: the
 * assertions below now pin the editor's own output rather than a round trip,
 * and they fail if the dialog sends a stale definition.
 */
const { exportSurveyJsonConfigured, ALL_FIELDS } = await import("../packages/exporters/dist/index.js");
// the route computes `complete` from the field set before calling the
// exporter, so the same derivation is applied here rather than assumed
const doc = exportSurveyJsonConfigured(sentJson.definition, sentJson.fields, {
  version: sentJson.definition.meta.version,
  complete: ALL_FIELDS.every((f) => sentJson.fields[f]),
});
assert.equal(doc.complete, true, "a full export is complete");
assert.ok(doc.definition, "and carries the canonical definition");
assert.deepEqual(
  doc.flow.map((e) => e.kind),
  ["block", "element", "block", "element"],
  `the JSON flow matches the editor: ${doc.flow.map((e) => e.kind)}`,
);
// a new block must never land after the End node, where nobody would reach it
assert.equal(doc.flow[doc.flow.length - 1].type, "end", "the survey still ends with End");
const jsonBlock = doc.flow.find((e) => e.kind === "block");
assert.equal(jsonBlock.title, "Screener");
assert.ok(Array.isArray(jsonBlock.pages), "page breaks are pages inside the block");
console.log("✔ JSON export carries the same blocks, groups and elements the flow shows");

/* the export reflects the EDITOR, not the last saved version */
assert.equal(doc.definition.questions.length, 4, "including edits never saved as a version");
console.log("✔ both exports are built from what is on screen, not from the last saved version");

/* ------------------------------- regressions from the adversarial review */

/*
 * The export dialog is still open — it stays open on a refused export so the
 * error and the field selection are both still there. Close it, or its modal
 * backdrop swallows every click that follows.
 */
if (await page.$('[data-testid="export-dialog"]')) {
  await page.click(".modal-back", { position: { x: 5, y: 5 } });
  await page.waitForSelector('[data-testid="export-dialog"]', { state: "detached" });
}

// leaving a group must put the block BEFORE the End node, not after it
await page.click(".leftnav >> text=Survey Flow");
await page.waitForSelector('[data-testid="flow-block"]');
await page.click('[data-testid="add-group"]');
await page.waitForSelector('[data-testid="flow-group"]');
await page.fill('[data-testid="group-title"]', "Temp group");
await page.waitForTimeout(250);
const moveVia = async (blockIndex, destination) => {
  const cards = await page.$$('[data-testid="flow-block"]');
  await cards[blockIndex].$eval('[data-testid="node-menu"]', (b) => b.click());
  await page.waitForSelector('[data-testid="node-menu-open"]');
  await page.click(`[data-testid="move-into"] >> text=${destination}`);
  await page.waitForTimeout(320);
};
await moveVia(1, "Group \u201cTemp group\u201d");
await moveVia(1, "Top level of the survey");

def = await readDef();
const endIdx = def.flow.findIndex((n) => n.type === "end");
const afterEnd = def.flow.slice(endIdx + 1).filter((n) => n.type === "page" || n.type === "block");
assert.equal(afterEnd.length, 0,
  `no block may sit after the End node, where nobody would reach it: ${def.flow.map((n) => n.type)}`);
console.log("✔ a block leaving a group lands before End, not after it");

await page.screenshot({ path: "/tmp/st-flow-export.png", fullPage: false });
await browser.close();
console.log("\nALL FLOW + EXPORT CHECKS PASSED");
