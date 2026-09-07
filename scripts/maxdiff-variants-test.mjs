/**
 * MAXDIFF BEYOND STANDARD, IN THE RUNTIME (§17).
 *
 *   anchored (dual-response)  the follow-up renders under each set, blocks a
 *                             half-answered set, and reaches the response
 *   express / sparse          a respondent sees only their version's subset
 *
 * The design generator and the analysis are unit-tested (designs
 * maxdiffVariants.test.ts, analytics maxdiffAnchored.test.ts). What only the
 * runtime can prove is that the anchor is asked at all — an anchored design
 * whose follow-up never renders produces an absolute-looking utility scale
 * identified by nothing, which is worse than not offering the variant.
 *
 *   node scripts/maxdiff-variants-test.mjs      (runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const ITEMS = ["Battery life", "Camera", "Price", "Storage"];

/** Two tasks over four items, one version — small enough to answer by hand. */
const DESIGN_ROWS = [
  { version: 1, task: 1, position: 1, item_index: 1, item_label: ITEMS[0] },
  { version: 1, task: 1, position: 2, item_index: 2, item_label: ITEMS[1] },
  { version: 1, task: 1, position: 3, item_index: 3, item_label: ITEMS[2] },
  { version: 1, task: 2, position: 1, item_index: 2, item_label: ITEMS[1] },
  { version: 1, task: 2, position: 2, item_index: 3, item_label: ITEMS[2] },
  { version: 1, task: 2, position: 3, item_index: 4, item_label: ITEMS[3] },
];

const survey = (config) => ({
  meta: { id: "mdv", code: "MDV", title: "MaxDiff variants", version: "1.0", schemaVersion: 1, status: "draft" },
  designs: [{
    id: "d_md", kind: "maxdiff", name: "MD", config,
    file: { format: "json", columns: ["version", "task", "position", "item_index", "item_label"], rows: DESIGN_ROWS },
  }],
  questions: [{
    id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", required: true,
    text: "For each set, pick the one that matters most and the one that matters least.",
    settings: { designRef: "d_md" },
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }, { type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const load = async (def) => {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await page.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await page.waitForSelector('[data-qid="q_md"]');
};

/* ================================================== standard: no follow-up */

console.log("\nA STANDARD DESIGN IS UNTOUCHED");

await load(survey({ items: ITEMS, itemsPerTask: 3 }));
assert.equal(await page.$$eval('[data-testid^="md-anchor-"]', (els) => els.length), 0,
  "no anchor controls appear on a design that did not ask for them");
ok("a standard MaxDiff renders exactly as before — no follow-up anywhere");

/* ========================================================= anchored design */

console.log("\nANCHORED (DUAL-RESPONSE) MAXDIFF");

await load(survey({
  items: ITEMS, itemsPerTask: 3, anchored: true,
  anchorPrompt: "How many of these are important to you?",
}));

const anchorGroups = await page.$$eval('[data-testid^="md-anchor-"]', (els) => els.length);
assert.equal(anchorGroups, 6, "three choices under each of the two sets");
ok("the follow-up renders under every set, not once for the question");

const promptCount = await page.$$eval("body *", (els) =>
  els.filter((e) => e.children.length === 0 && /How many of these are important to you\?/.test(e.textContent ?? "")).length);
assert.ok(promptCount >= 2, `the configured wording is asked per set (found ${promptCount})`);
ok("the design's own wording is what gets asked");

/* the three points of the scale, in the order that reads as a scale */
const labels = await page.$$eval('[data-testid^="md-anchor-1-"]', (els) =>
  els.map((e) => e.parentElement.textContent.trim()));
assert.equal(labels.length, 3);
assert.match(labels[0], /^All of them/);
assert.match(labels[1], /^Some of them/);
assert.match(labels[2], /^None of them/);
ok("all / some / none — the three answers that identify an anchor");

/* answering best and worst is NOT a complete answer any more */
await page.click('input[name="q_md_1_best"] >> nth=0');
await page.click('input[name="q_md_1_worst"] >> nth=1');
await page.click('input[name="q_md_2_best"] >> nth=0');
await page.click('input[name="q_md_2_worst"] >> nth=1');
await page.click('[data-testid="rs-next"]').catch(() => page.click('button:has-text("Next")'));
await page.waitForTimeout(400);
assert.ok(await page.$('[data-qid="q_md"]'), "still on the same page");
const errText = await page.textContent("body");
assert.match(errText, /follow-up question for sets? 1/,
  "and it names the set that is missing its answer");
ok("a set with best and worst but no follow-up is refused, naming the set");

/* answer the follow-ups and the page accepts */
await page.click('[data-testid="md-anchor-1-some"]');
await page.click('[data-testid="md-anchor-2-none"]');
const stored = await page.evaluate(() => window.__rescriptState?.answers?.q_md ?? null);
/*
 * Asserted by SHAPE, not by item index: on-screen order is rolled per
 * respondent per task on purpose (position effects are real), so which item
 * sits in the first row is not knowable from here — and a test that pinned it
 * would be testing the shuffle rather than the anchor.
 */
assert.deepEqual(Object.keys(stored).sort(), ["1", "2"], JSON.stringify(stored));
assert.equal(stored["1"].anchor, "some");
assert.equal(stored["2"].anchor, "none");
for (const [t, expectItems] of [["1", ["1", "2", "3"]], ["2", ["2", "3", "4"]]]) {
  assert.ok(expectItems.includes(stored[t].best), `set ${t} best is one of its own items`);
  assert.ok(expectItems.includes(stored[t].worst), `set ${t} worst is one of its own items`);
  assert.notEqual(stored[t].best, stored[t].worst, `set ${t} cannot be both best and worst`);
}
ok("the anchor is stored inside the task answer, beside best and worst, per set");

await page.click('[data-testid="rs-next"]').catch(() => page.click('button:has-text("Next")'));
await page.waitForTimeout(500);
assert.ok(!(await page.$('[data-qid="q_md"]')), "the page advances once every set is complete");
ok("a fully answered anchored question continues");

/* ======================================================= express / sparse */

console.log("\nEXPRESS: A RESPONDENT SEES THEIR VERSION'S SUBSET");

/*
 * Two versions with disjoint item sets. Whichever version this respondent is
 * assigned, they must see only that version's items — the check that the
 * express design is honoured at fielding and not merely generated.
 */
const expressRows = [
  { version: 1, task: 1, position: 1, item_index: 1, item_label: ITEMS[0] },
  { version: 1, task: 1, position: 2, item_index: 2, item_label: ITEMS[1] },
  { version: 2, task: 1, position: 1, item_index: 3, item_label: ITEMS[2] },
  { version: 2, task: 1, position: 2, item_index: 4, item_label: ITEMS[3] },
];
const expressDef = survey({ items: ITEMS, itemsPerTask: 2, versions: 2, itemsPerVersion: 2 });
expressDef.designs[0].file.rows = expressRows;
expressDef.questions[0].required = false;
await load(expressDef);

const shown = await page.$$eval('[data-qid="q_md"] td.rowlabel', (els) => els.map((e) => e.textContent.trim()));
const v1 = [ITEMS[0], ITEMS[1]], v2 = [ITEMS[2], ITEMS[3]];
const isV1 = shown.every((s) => v1.includes(s));
const isV2 = shown.every((s) => v2.includes(s));
assert.ok(isV1 || isV2, `a respondent sees one version's items, not a mixture: ${JSON.stringify(shown)}`);
assert.equal(shown.length, 2);
ok(`only this respondent's version is fielded (${shown.join(", ")})`);

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
console.log(`\nALL ${passed} MAXDIFF VARIANT CHECKS PASSED`);
await browser.close();
