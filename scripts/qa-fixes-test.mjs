/**
 * Browser regression tests for the QA batch reported from the Studio.
 * Drives the real runtime at /preview with purpose-built definitions.
 *
 *  - allocation / numeric decimals survive typing ("90.09", not "909")
 *  - the emoji scale follows min–max instead of always drawing five
 *  - the NPS label row is as wide as the scale, not the card
 *  - Rank Top N caps at N; Rank All shows progress
 *  - a swipe deck with no cards says so instead of "0 cards judged"
 *  - "Other — please specify" is typable, at any position
 *  - the essay counter shows the minimum it is holding you to
 *  - the column layout setting reaches the image grid
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const survey = (questions) => ({
  meta: { id: "qa", code: "QA", title: "QA fixes", version: "1.0" },
  questions,
  flow: [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }],
});

/** Push a definition into the preview page and wait for it to render. */
const load = async (def) => {
  await page.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
  await page.evaluate((d) => {
    window.postMessage({ type: "rescript:preview", definition: d }, "*");
  }, def);
  await page.waitForSelector(".rs-card", { timeout: 8000 });
  await page.waitForTimeout(200);
};

/* ------------------------------------------------ decimals (suraj 8) */

await load(survey([
  {
    id: "alloc", code: "Q1", variableName: "ALLOC", type: "allocation", text: "Split 100",
    options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }],
    settings: { sumTarget: 100 },
  },
]));
const allocInput = ".rs-alloc-row input";
await page.click(allocInput);
await page.type(allocInput, "90.09", { delay: 40 });
let typed = await page.$eval(allocInput, (e) => e.value);
assert.equal(typed, "90.09", `allocation kept the decimal: got "${typed}"`);
await page.click("body");
await page.waitForTimeout(150);
typed = await page.$eval(allocInput, (e) => e.value);
assert.equal(typed, "90.09", "value survives blur");
const total = await page.$eval(".rs-alloc-total", (e) => e.textContent);
assert.match(total, /90\.09/, `running total uses the decimal: ${total}`);
console.log("✔ allocation accepts 90.09 (was silently becoming 909)");

/* -------------------------------------------------- emoji scale (oweas 5) */

await load(survey([
  {
    id: "emo", code: "Q1", variableName: "EMO", type: "numeric", variant: "slider.emoji",
    text: "How do you feel?", settings: { minValue: 1, maxValue: 10 },
  },
]));
let faces = await page.$$eval(".rs-emoji button", (els) => els.length);
assert.equal(faces, 10, `1–10 renders ten faces, got ${faces}`);
await page.click(".rs-emoji button:nth-child(7)");
await page.waitForTimeout(150);
const chosen = await page.$$eval(".rs-emoji button.on", (els) => els.map((e) => e.getAttribute("aria-label")));
assert.deepEqual(chosen, ["7 of 10"], `selected value maps to the scale: ${chosen}`);
console.log("✔ emoji scale follows min–max (10 faces, stores 7)");

await load(survey([
  { id: "emo", code: "Q1", variableName: "EMO", type: "numeric", variant: "slider.emoji", text: "Feel?" },
]));
faces = await page.$$eval(".rs-emoji button", (els) => els.length);
assert.equal(faces, 5, "the default is still a five-point scale");
console.log("✔ emoji default is unchanged at 5");

/* ------------------------------------------------ NPS labels (oweas 6, 7) */

await load(survey([
  {
    id: "nps", code: "Q1", variableName: "NPS", type: "nps", text: "Recommend us?",
    settings: { minValue: 1, maxValue: 7, npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely" },
  },
]));
const geom = await page.evaluate(() => {
  const scale = document.querySelector(".rs-nps").getBoundingClientRect();
  const labels = document.querySelector(".rs-nps-labels").getBoundingClientRect();
  const right = document.querySelector(".rs-nps-labels span:last-child").getBoundingClientRect();
  return { scaleRight: scale.right, labelsRight: labels.right, rightLabelRight: right.right };
});
assert.ok(
  Math.abs(geom.rightLabelRight - geom.scaleRight) < 40,
  `right label ends near the scale end (scale ${geom.scaleRight.toFixed(0)}, label ${geom.rightLabelRight.toFixed(0)})`,
);
console.log("✔ NPS end label aligns with the scale, not the card edge");

/* --------------------------------------------------- ranking (suraj 11) */

const rankOpts = [1, 2, 3, 4, 5].map((n) => ({ code: String(n), label: `Item ${n}` }));
await load(survey([
  {
    id: "rk", code: "Q1", variableName: "RK", type: "ranking", variant: "ranking.top_n",
    text: "Rank your top 3", options: rankOpts,
    settings: { rankMode: "top_n", maxSelections: 3 },
  },
]));
let progress = await page.$eval('[data-testid="rank-progress"]', (e) => e.textContent.trim());
assert.equal(progress, "0 of 3 ranked");
for (let i = 0; i < 5; i++) {
  const item = await page.$(".rs-rank-item:not(.rs-rank-locked) .rs-rank-num.empty");
  if (item) await item.click();
  await page.waitForTimeout(120);
}
progress = await page.$eval('[data-testid="rank-progress"]', (e) => e.textContent.trim());
assert.equal(progress, "3 of 3 ranked", `Top-N stops at 3: ${progress}`);
const locked = await page.$$eval(".rs-rank-locked", (els) => els.length);
assert.equal(locked, 2, "the remaining items lock once the top N is full");
console.log("✔ Rank Top N caps at N and locks the rest");

await load(survey([
  {
    id: "rk", code: "Q1", variableName: "RK", type: "ranking", variant: "ranking.rank_all",
    text: "Rank them all", options: rankOpts, settings: { rankMode: "all" },
  },
]));
progress = await page.$eval('[data-testid="rank-progress"]', (e) => e.textContent.trim());
assert.equal(progress, "0 of 5 ranked", `Rank All counts every item: ${progress}`);
console.log("✔ Rank All shows progress toward every item");

/* ------------------------------------------------------ swipe (suraj 1, 2) */

await load(survey([
  {
    id: "sw", code: "Q1", variableName: "SW", type: "matrix_single", variant: "swipe.tinder",
    text: "Swipe", options: [{ code: 0, label: "👎" }, { code: 1, label: "👍" }], rows: [],
  },
]));
await page.waitForSelector('[data-testid="swipe-no-cards"]');
const hint = await page.$eval('[data-testid="swipe-no-cards"]', (e) => e.textContent);
assert.match(hint, /Rows/, "an empty deck explains itself instead of claiming 0 cards judged");
assert.ok(!/0 cards judged/.test(hint));
console.log("✔ an empty swipe deck says what is missing");

await load(survey([
  {
    id: "sw", code: "Q1", variableName: "SW", type: "matrix_single", variant: "swipe.tinder",
    text: "Swipe", options: [{ code: 0, label: "👎" }, { code: 1, label: "👍" }],
    rows: [{ code: "r1", label: "Statement 1" }, { code: "r2", label: "Statement 2" }],
  },
]));
await page.waitForSelector(".rs-swipe-card, .rs-swipe");
const cardText = await page.evaluate(() => document.body.innerText);
assert.match(cardText, /Statement 1/, "the first card renders");
console.log("✔ a seeded swipe deck shows its cards");

/* ------------------------------------------------ other-specify (oweas 2, 8) */

await load(survey([
  {
    id: "ms", code: "Q1", variableName: "MS", type: "multi_select", text: "Pick any",
    options: [
      { code: "1", label: "One" },
      { code: "2", label: "Two" },
      { code: "9", label: "Other", flags: ["other_specify"] },
    ],
  },
]));
await page.click(".rs-option:last-child input[type=checkbox]");
await page.waitForSelector(".rs-other-input");
const boxW = await page.$eval(".rs-other-input", (e) => e.getBoundingClientRect().width);
assert.ok(boxW > 120, `the specify box is usable, not a 17px stub (got ${boxW.toFixed(0)}px)`);
await page.fill(".rs-other-input", "Something else");
assert.equal(await page.$eval(".rs-other-input", (e) => e.value), "Something else");
console.log(`✔ other-specify box is ${boxW.toFixed(0)}px wide and typable at the end of the list`);

/* --------------------------------------------------------- essay (oweas 11) */

await load(survey([
  {
    id: "es", code: "Q1", variableName: "ES", type: "long_text", variant: "text.essay", text: "Tell us more",
    validation: [{ kind: "min_length", value: 100, message: "Please write at least 100 characters." }],
  },
]));
await page.fill(".rs-textarea", "Too short.");
await page.waitForTimeout(150);
const counter = await page.$eval('[data-testid="char-counter"]', (e) => e.textContent.trim());
assert.match(counter, /10 \/ 100/, `counter shows the threshold: ${counter}`);
console.log("✔ essay shows a live character counter against its minimum");

/* ------------------------------------------------- column layout (suraj 6) */

const imgOpts = [1, 2, 3, 4, 5, 6].map((n) => ({ code: String(n), label: `Img ${n}`, imageUrl: "" }));
await load(survey([
  {
    id: "im", code: "Q1", variableName: "IM", type: "image_select", text: "Pick",
    options: imgOpts, settings: { columnsLayout: 3 },
  },
]));
const cols = await page.$eval(".rs-imggrid", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
assert.equal(cols, 3, `image grid honours columnsLayout: got ${cols}`);
console.log("✔ the column layout setting reaches the image grid");

/* ------------------------------------ live preview (suraj 5, 6, 9 root cause) */

// Preview used to post a snapshot captured at click time, so every later edit
// was invisible and three separate renderer "bugs" were really this.
const studio = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await studio.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await studio.click(".insert-bar >> text=+ Question");
await studio.waitForSelector(".qcard.selected .rte-surface");
await studio.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
await studio.keyboard.type("First version of the question");
await studio.waitForTimeout(400);

const [previewTab] = await Promise.all([
  studio.context().waitForEvent("page"),
  studio.click("text=▶ Preview"),
]);
await previewTab.waitForLoadState("networkidle");
await previewTab.waitForSelector(".rs-card", { timeout: 8000 });
await previewTab.waitForTimeout(600);
let shown = await previewTab.evaluate(() => document.body.innerText);
assert.match(shown, /First version of the question/, "preview shows the question");

// now edit WITHOUT touching Preview again
await studio.click(".qcard.selected .rte-surface");
await studio.keyboard.press("Control+a");
await studio.keyboard.type("Edited after preview opened");
await studio.waitForTimeout(1200);
shown = await previewTab.evaluate(() => document.body.innerText);
assert.match(shown, /Edited after preview opened/, `live preview followed the edit: ${shown.slice(0, 120)}`);
console.log("✔ preview updates live as the survey is edited");

/* ------------------------------------------- matrix authoring (prince 1–3) */

await studio.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await studio.click(".insert-bar >> text=▾ type…");
await studio.waitForSelector(".vp-modal, .card.selectable");
// pick the Grid / Matrix family, then Single-Select Matrix
await studio.click("text=Grid / Matrix");
await studio.waitForTimeout(200);
await studio.click(".card.selectable >> text=Single-Select Matrix");
await studio.waitForSelector(".qcard.selected");
await studio.waitForTimeout(400);

// a matrix is born with rows rather than an empty grid
const rowInputs = async () =>
  studio.$$eval('.qcard.selected input[data-oidx]', (els) => els.map((e) => e.value));
const rowCodes = async () =>
  studio.$$eval('.qcard.selected .opt-row .code-input', (els) => els.map((e) => e.value));

let labels = await rowInputs();
assert.ok(labels.length >= 3, `a new matrix seeds rows: ${labels.length}`);
console.log(`✔ a new matrix starts with ${labels.length} rows and its scale, not an empty grid`);

// row codes and option codes both start at 1 and never duplicate
const allCodes = await rowCodes();
assert.ok(allCodes.includes("1"), `codes start at 1: ${allCodes.join(",")}`);
assert.equal(new Set(allCodes).size, allCodes.length, `no duplicate codes: ${allCodes.join(",")}`);
console.log(`✔ codes are unique and start at 1 (${allCodes.join(", ")})`);

// row flags are offered (anchor top/bottom), which the engine already honoured.
// The control is a multi-select property list now, not a single-value dropdown.
await studio.click('.qcard.selected [data-testid="option-flags-0"]');
await studio.waitForSelector(".opt-flags-menu");
const rowFlagOptions = await studio.$$eval(
  ".opt-flags-menu .opt-flag-row",
  (els) => els.map((e) => e.textContent.trim()),
);
assert.ok(rowFlagOptions.some((t) => /anchor bottom/.test(t)),
  `row flags offered: ${rowFlagOptions.join(" | ")}`);
console.log(`✔ matrix rows offer ${rowFlagOptions.join(", ")}`);

/* ------------------------------- condition builder layout (screenshot issue) */

// A five-control rule row in a 340px panel clipped its buttons and overlapped
// its hint text. The row now wraps, and nothing may escape the panel.
await studio.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await studio.click(".insert-bar >> text=+ Question");
await studio.waitForSelector(".qcard.selected .rte-surface");
await studio.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
await studio.keyboard.type("Layout check");
await studio.waitForTimeout(350);

await studio.click('.rightpanel >> text=+ skip rule');
// conditions first: the builder opens empty, so build two and group them
await studio.waitForSelector('.rightpanel [data-testid="logic-builder"]');
await studio.click('.rightpanel [data-testid="lb-add-condition"]');
await studio.waitForTimeout(200);
await studio.click('.rightpanel [data-testid="lb-add-condition"] >> nth=0');
await studio.waitForTimeout(250);
const picks = await studio.$$('.rightpanel .lb-list.root > .lb-row > .lb-pick > input');
await picks[0].click();
await picks[1].click();
await studio.waitForTimeout(150);
await studio.click('.rightpanel [data-testid="lb-move-to-group"]');
await studio.waitForSelector('.rightpanel [data-testid="lb-group"]');
await studio.waitForTimeout(200);
const targetSel = await studio.$$('.rightpanel .skip-target select');
await targetSel[0].selectOption("url");
await studio.waitForTimeout(300);

/*
 * Each group owns exactly one operator control, in its own header. That is
 * what fixed "change the nested OR and the parent AND changes": a bracketed
 * group holding a single condition used to show no control of its own, so the
 * nearest dropdown belonged to its parent.
 *
 * The top level has no header — it is a list, not a bracket — so its operator
 * is the connector between the rows, and the connectors inside a group are
 * plain words that mirror the header.
 */
const groupOps = await studio.$$eval(".rightpanel [data-testid='group-op']", (els) => els.length);
const groups = await studio.$$eval(".rightpanel .lb-group", (els) => els.length);
assert.equal(groupOps, groups,
  `every group has exactly one operator control of its own (${groupOps} controls, ${groups} groups)`);
const insideJoins = await studio.$$eval(".rightpanel .lb-group .lb-join select", (els) => els.length);
assert.equal(insideJoins, 0, "a group's connectors are words, not a second control for its operator");
console.log(`✔ each of the ${groups} groups owns its operator, and no connector duplicates it`);

// nothing may overflow its box or escape the panel
const layout = await studio.evaluate(() => {
  const root = document.querySelector(".rightpanel");
  const r = root.getBoundingClientRect();
  const clipped = [];
  const spill = [];
  for (const el of root.querySelectorAll("select, button, input, .cond-rule, .lb-row, .lb-group-head, .lb-actions")) {
    const b = el.getBoundingClientRect();
    if (b.width === 0) continue;
    if (el.scrollWidth > el.clientWidth + 2 && !el.matches("textarea")) {
      clipped.push(`${el.className}|${(el.textContent || "").slice(0, 20)}`);
    }
    if (b.right > r.right + 1 || b.left < r.left - 1) spill.push(el.className);
  }
  return { clipped, spill, width: r.width };
});
assert.deepEqual(layout.clipped, [], `no control is clipped: ${layout.clipped.join(", ")}`);
assert.deepEqual(layout.spill, [], `nothing escapes the panel: ${layout.spill.join(", ")}`);
console.log(`✔ every control fits inside the ${layout.width}px properties panel`);

// the external-URL field gets a usable width instead of a stub
const urlW = await studio.$eval(".rightpanel .skip-url", (e) => e.getBoundingClientRect().width);
assert.ok(urlW > 250, `the URL field is usable: ${urlW.toFixed(0)}px`);
console.log(`✔ the external URL field is ${urlW.toFixed(0)}px wide`);

await browser.close();
console.log("\nALL QA FIX CHECKS PASSED");
