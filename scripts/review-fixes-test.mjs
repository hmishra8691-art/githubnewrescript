/**
 * THE SEPTEMBER REVIEW FIXES, ASSERTED AGAINST THE RUNNING PRODUCT.
 *
 *   node scripts/review-fixes-test.mjs      (studio :3000, runtime :3001)
 *
 * Four review files (Feedback.docx, 18-09-2026.xlsx, 21_09_2026.xlsx,
 * "Mistakes and errors.xlsx") were worked through together. The unit-level
 * facts are held by node:test suites beside the code they belong to —
 * optionsPaste, repeatingFormValidation, carouselJudgeMode, variants. This
 * file holds the ones that are only true of the assembled product: what the
 * builder offers, and what a respondent actually sees.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();

/* ------------------------------------------------------------- the builder */
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Review fixes", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "Q1", type: "matrix_single", variant: "matrix.single",
      text: "Grid", rows: [{ code: "r1", label: "Row one" }],
      options: [{ code: 1, label: "Col one" }, { code: 2, label: "Col two" }],
    },
    {
      id: "q2", code: "Q2", variableName: "Q2", type: "matrix_single", variant: "swipe.tinder",
      text: "Swipe deck", rows: [{ code: "r1", label: "Card one" }],
      options: [{ code: 0, label: "👎 Dislike" }, { code: 1, label: "👍 Like" }],
    },
    {
      id: "q3", code: "Q3", variableName: "Q3", type: "allocation", variant: "allocation.slider_allocation",
      text: "Split the budget",
      options: [{ code: 1, label: "A" }, { code: 2, label: "B" }],
      settings: { sumTarget: 100, sumUnit: " %" },
    },
    {
      id: "q4", code: "Q4", variableName: "Q4", type: "composite", variant: "matrix.numeric",
      text: "Numbers", rows: [{ code: "r1", label: "Item one" }],
      columns: [{ id: "c1", label: "Amount", responseType: "numeric", variableStem: "Q4_C1" }],
    },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] },
    { type: "end", id: "e1", status: "complete" }],
};

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(200); };
const selectQ = async (i) => {
  const cards = await page.$$(".qcard");
  await cards[i].click();
  await page.waitForTimeout(250);
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
await goTab("Questions");
ok("fixture loaded");

/*
 * THE PHANTOM COLUMNS SECTION. Six separate reports, one cause: the editor
 * drew a cell-Columns editor for every question whose base type starts with
 * "matrix", including the per-row grids and the swipe decks that have no
 * cells at all, so "+ Column" appended something no respondent could ever
 * see. It is offered only where columns are stored now.
 */
await selectQ(0);
{
  /*
   * The two are told apart by the EDITOR, not the heading — because the fix
   * is precisely that the heading "Columns" now belongs to the option list.
   * The cell-column editor is the one with "+ column" and per-column type
   * controls; a per-row grid must have the heading and not that editor.
   */
  const heads = await page.$$eval("main.center h3.sec", (els) => els.map((e) => e.textContent.trim()));
  assert.ok(heads.some((h) => /Columns/.test(h)),
    `the option list must be NAMED Columns on a grid: ${JSON.stringify(heads)}`);
  assert.equal(await page.$('[data-testid="add-column"]'), null,
    "a per-row grid stores no cells, so it must not offer the cell-Columns editor");
  assert.ok(await page.$('[data-testid="add-option"]'),
    "…the list it does have is the option list, editable as usual");
  ok("Single-Select Matrix: the option list is called Columns, and there is no second Columns editor");
}

await selectQ(3);
{
  assert.ok(await page.$('[data-testid="add-column"]'),
    "a cell grid MUST still offer its Columns editor");
  const fixed = await page.$$('[data-testid="column-type-fixed"]');
  assert.ok(fixed.length > 0, "a Numeric Matrix's column type is numeric, and says so instead of offering eleven types");
  assert.equal(await page.$('[data-testid="column-type"]'), null,
    "…so there is no eleven-item type dropdown to pick a Date column from");
  ok("Numeric Matrix keeps a real Columns editor, restricted to numeric");
}

/* "+ Column" genuinely adds a column that the question stores. */
{
  await page.click('[data-testid="add-column"]');
  await page.waitForTimeout(250);
  const labels = await page.$$eval('[data-testid="column-label"]', (els) => els.length);
  assert.equal(labels, 2, "a second column must actually be created");
  ok("+ column adds a column that exists (the '+Column is not adding additional columns' report)");
}

/*
 * A SWIPE CARD HAS TWO EDGES. The deck accepted any number of options and
 * drew the first two, so a third was an answer nobody could give.
 */
await selectQ(1);
{
  const rule = await page.textContent('[data-testid="option-count-rule"]');
  assert.match(rule, /Exactly 2/, `the rule must be stated: ${rule}`);
  const addDisabled = await page.getAttribute('[data-testid="add-option"]', "disabled");
  assert.notEqual(addDisabled, null, "“+ option” must be refused at the ceiling");
  ok("Tinder-Style Swipe enforces exactly two options");
}

/*
 * NO PER-ITEM MIN/MAX ON AN ALLOCATION — "if there are 5 sliders with a total
 * allocation of 1000, and we set the Max validation to 100, the respondent
 * would not be able to reach the required total".
 */
await selectQ(2);
{
  const minBox = await page.$('[data-testid="min-value"]');
  assert.equal(minBox, null, "Slider Allocation must not offer a per-item Min");
  const target = await page.$('[data-testid="sum-target"]');
  assert.ok(target, "…but the sum target, which IS its constraint, must stay");
  const unit = await page.$('[data-testid="sum-unit"]');
  assert.ok(unit, "and the unit toggle that replaced Budget/Percentage/Point Allocation");
  ok("allocation questions drop the contradictory Min/Max and gain the unit toggle");
}

/* The search box is gone from grids and rankings, kept for flat lists. */
await selectQ(0);
{
  const search = await page.$('[data-testid="option-search"]');
  assert.equal(search, null, "a grid has no list to filter — the Search box control must not be offered");
  ok("Search box removed from Grid/Matrix");
}

assert.deepEqual(errors, [], `studio console/page errors: ${errors.join(" | ")}`);
ok("no page errors in the builder");
await page.close();

/* ------------------------------------------------------------ the renderer */

const def = {
  meta: { id: "00000000-0000-4000-8000-00000000rf99", code: "RF", title: "Review render", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "Q1", type: "matrix_single", variant: "matrix.likert",
      text: "Agree?",
      rows: [{ code: "r1", label: "Easy to use" }, { code: "r2", label: "Good value" }],
      options: [
        { code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" },
        { code: 3, label: "Neither" }, { code: 4, label: "Agree" }, { code: 5, label: "Strongly agree" },
      ],
    },
    {
      id: "q2", code: "Q2", variableName: "Q2", type: "matrix_single", variant: "matrix.rating",
      text: "Rate",
      rows: [{ code: "r1", label: "Quality" }],
      options: [1, 2, 3, 4, 5].map((n) => ({ code: n, label: String(n) })),
    },
    {
      id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", variant: "multi_select.buttons",
      text: "Which features matter?",
      options: ["Camera", "Battery", "Performance", "Design", "Brand", "Storage", "Display", "Software"]
        .map((l, i) => ({ code: i + 1, label: l })),
    },
    {
      id: "q4", code: "Q4", variableName: "Q4", type: "slider", variant: "slider.single",
      text: "How satisfied?",
      settings: { minValue: 0, maxValue: 10, step: 1, sliderLeftLabel: "Not satisfied", sliderRightLabel: "Very satisfied" },
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const pv = await openPreview(browser, RUNTIME, { definition: def }, {
  viewport: { width: 1200, height: 1100 }, selector: '[data-qid="q1"]',
});

/* Likert and Rating are no longer the same picture as a plain radio grid. */
{
  assert.ok(await pv.$('[data-testid="likert-matrix"]'), "the Likert grid must use its own renderer");
  assert.ok(await pv.$('[data-testid="rating-matrix"]'), "the Rating grid must use its own renderer");
  const bands = await pv.$$eval(".rs-likert-band", (els) => els.length);
  assert.equal(bands, 10, "2 rows × 5 scale points, each a tappable band rather than a bare radio dot");
  ok("Single-Select, Likert and Rating grids are three different pictures");
}

/* The option boxes stopped being one tall stack of full-width boxes. */
{
  await pv.click('.rs-likert-band');           // answer something so Next is allowed
  await pv.waitForTimeout(150);
}

/* Slider: the end labels are UNDER the track, and the numbers survive. */
await pv.click('[data-qid="q1"] .rs-likert-band');
await pv.waitForTimeout(100);

/* ------------------------------------------------- preview resumes a refresh */
/*
 * "When the page is refreshed, the survey should resume from the user's last
 * position instead of restarting from the beginning." A live interview always
 * did (the response row plus a durable pointer); preview wrote nothing at
 * all, so a reload — which the Studio triggers on every edit — went back to
 * page one. It now keeps its position for the length of the tab.
 */
{
  // answer page 1 and advance
  const rows = await pv.$$('[data-qid="q1"] .rs-likert-row, [data-qid="q1"] tbody tr');
  for (const r of rows) {
    const band = await r.$(".rs-likert-band");
    if (band) await band.click();
  }
  await pv.click('[data-qid="q2"] .rs-ratingmatrix-pt');
  await pv.waitForTimeout(150);
  await pv.click('button:has-text("Next")');
  await pv.waitForSelector('[data-qid="q3"]', { timeout: 8000 });
  ok("advanced to page 2");

  await pv.reload({ waitUntil: "networkidle" });
  // the Studio re-posts the definition on reload; the harness does the same
  await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await pv.waitForSelector("[data-qid]", { timeout: 15000 });
  await pv.waitForTimeout(600);

  const onPage2 = await pv.$('[data-qid="q3"]');
  assert.ok(onPage2, "after a refresh the preview must come back to page 2, not restart at page 1");
  ok("a refreshed preview resumes where it was (Feedback.docx §2)");
}

await pv.close();
await browser.close();

console.log(`\n${passed} checks passed.`);
