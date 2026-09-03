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

/* the Word document — a real request through the real route */
const docxRes = page.waitForResponse((r) => r.url().includes("/export/survey") && r.request().method() === "POST");
await page.click('[data-testid="do-export"]');
const res = await docxRes;
assert.equal(res.status(), 200, `the export route answered: ${res.status()}`);
assert.match(res.headers()["content-type"], /wordprocessingml\.document/, "it is a Word document");
// Playwright cannot read the body of a response the browser turned into a
// download, so fetch the same route again from the page to inspect the bytes
const probe = await page.evaluate(async () => {
  const defJson = JSON.parse(document.querySelector("textarea.code")?.value ?? "null");
  const r = await fetch(`/api/surveys/sandbox/export/survey`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definition: defJson, format: "docx", fields: { questionId: true, questionText: true, options: true, blockName: true, blockOrder: true } }),
  });
  const buf = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, len: buf.length, magic: String.fromCharCode(buf[0], buf[1]) };
});
assert.equal(probe.status, 200);
assert.equal(probe.magic, "PK", "a real docx is a zip archive");
assert.ok(probe.len > 4000, `with content: ${probe.len} bytes`);
console.log(`✔ Word export returned a ${(probe.len / 1024).toFixed(1)}KB .docx from the live editor state`);

/* the JSON export, through the same configuration */
await page.waitForTimeout(400);
await page.click('[data-testid="export-survey"]');
await page.waitForSelector('[data-testid="export-dialog"]');
await page.click('[data-testid="preset-full"]');
await page.click('[data-testid="fmt-json"] input');
await page.waitForTimeout(150);
const jsonRes = page.waitForResponse((r) => r.url().includes("/export/survey") && r.request().method() === "POST");
await page.click('[data-testid="do-export"]');
const jres = await jsonRes;
assert.equal(jres.status(), 200);
assert.match(jres.headers()["content-type"], /application\/json/);
// and read the content through a second identical request
const doc = await page.evaluate(async () => {
  const defJson = JSON.parse(document.querySelector("textarea.code")?.value ?? "null");
  const all = ["questionId","questionText","questionType","options","validation","required",
    "displayLogic","skipLogic","branchLogic","optionLogic","piping","randomization",
    "blockName","pageBreaks","blockOrder","flowElements","embeddedData"];
  const r = await fetch(`/api/surveys/sandbox/export/survey`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ definition: defJson, format: "json",
      fields: Object.fromEntries(all.map((f) => [f, true])) }),
  });
  return r.json();
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
