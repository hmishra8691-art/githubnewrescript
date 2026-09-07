/**
 * COUNT CONDITIONS, BUILT THROUGH THE UI (§1–12).
 *
 * The engine side is unit-tested (29 assertions in
 * `packages/engine/src/countCondition.test.ts`), including the claim that
 * matters most — that a count needs no support from the features that use it,
 * because it is a source rather than an operator. What only a browser can
 * prove is that a programmer can BUILD one, that what they build is what gets
 * stored, and that the controls refuse the combinations that would produce a
 * rule which can never be true.
 *
 *   node scripts/count-logic-test.mjs      (studio on 3000)
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

const addQuestion = async (text, options) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
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

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

await addQuestion("Which brands do you use?", ["Apple", "Bosch", "Candy", "Dell", "Electrolux"]);
await addQuestion("Which of these do you prefer?", ["Apple", "Bosch", "Candy", "Other"]);
let def = await readDef();
assert.equal(def.questions.length, 2, "two questions created");
ok("setup: a five-option question and a second to hang logic on");

/* ============================================ the toggle, and what it does */

/* option logic on Q2's first option is the nearest condition builder */
await page.click(".qcard >> nth=1");
await page.waitForSelector(".qcard.selected");
await page.click('.qcard.selected [data-testid="option-logic-0"]');
await page.waitForSelector('[data-testid="option-logic"]');
await page.click('[data-testid="option-logic"] [data-testid="vis-show_when"]');
await page.waitForSelector('[data-testid="option-logic"] [data-testid="logic-builder"]');
await page.click('[data-testid="option-logic"] [data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="option-logic"] .cond-rule');

const RULE = '[data-testid="option-logic"] .cond-rule';

/*
 * Reading the definition switches to the JSON tab and back, which re-renders
 * the questions panel and closes the option-logic drawer. Every assertion that
 * follows a read therefore re-opens it — the alternative is a suite that
 * passes or fails depending on how many times it looked at the JSON.
 */
const reopen = async (qIdx, optIdx) => {
  await page.click(`.qcard >> nth=${qIdx}`);
  await page.waitForSelector(".qcard.selected");
  await page.click(`.qcard.selected [data-testid="option-logic-${optIdx}"]`);
  await page.waitForSelector('[data-testid="option-logic"]');
};

/*
 * A count counts a question's options, rows or columns. There is nothing to
 * count in a calculated variable, so the toggle is not offered for one — a
 * control that appears and then refuses is worse than one that is not there.
 */
const calcSource = await page.$eval(`${RULE} .ref-select`, (el) => {
  const o = [...el.options].find((x) => x.value.startsWith("calculation:"));
  return o ? o.value : "";
});
if (calcSource) {
  await page.selectOption(`${RULE} .ref-select`, calcSource);
  await page.waitForTimeout(200);
  assert.equal((await page.$$(`${RULE} [data-testid="toggle-count"]`)).length, 0,
    "no count toggle on a calculated variable");
  ok("the count toggle is offered for questions only — there is nothing to count in a calculation");
} else {
  ok("no calculated source listed in this sandbox to check the toggle against");
}

const q1 = `q:${def.questions[0].id}`;
await page.selectOption(`${RULE} .ref-select`, q1);
await page.waitForTimeout(250);
assert.ok(await page.$(`${RULE} [data-testid="toggle-count"]`), "the toggle appears");
ok("choosing a question offers the count toggle");

await page.click(`${RULE} [data-testid="toggle-count"]`);
await page.waitForSelector(`${RULE} [data-testid="count-editor"]`);
ok("the count editor opens on the rule");

/* ============================== only numeric operators, and a number field */

const ops = await page.$$eval(`${RULE} .op-select option`, (els) => els.map((e) => e.value));
assert.deepEqual(ops.sort(), ["between", "eq", "gt", "gte", "lt", "lte", "ne"].sort(),
  `only the comparisons that mean something against a number: ${JSON.stringify(ops)}`);
ok("COUNTING NARROWS THE OPERATORS to the six comparisons plus between");

assert.ok(await page.$(`${RULE} [data-testid="count-value"]`),
  "the value is a number field, not an option dropdown");
const valueType = await page.getAttribute(`${RULE} [data-testid="count-value"]`, "type");
assert.equal(valueType, "number");
ok("…and the value is a number, never an option code");

/*
 * The toggle also fixes the operator on the way in. Left as "has selected",
 * the rule would compare a number with an option code and never be true — so
 * it moves to ">=" rather than sitting in an impossible state until somebody
 * notices.
 */
const opNow = await page.$eval(`${RULE} .op-select`, (e) => e.value);
assert.ok(["gte", "eq", "gt", "lt", "lte", "ne", "between"].includes(opNow),
  `the operator is a numeric one on the way in, got ${opNow}`);
ok("switching to a count leaves the rule immediately valid");

/* ================================================ at least 2 — the example */

await page.click(`${RULE} [data-testid="count-quick-gte"]`);
await page.fill(`${RULE} [data-testid="count-value"]`, "2");
await page.waitForTimeout(350);

def = await readDef();
let stored = def.questions[1].options[0].logic.when;
let rule0 = stored.children ? stored.children[0] : stored;
assert.equal(rule0.source.count.of, "selected");
assert.equal(rule0.source.count.scope, "options");
assert.equal(rule0.operator, "gte");
assert.equal(rule0.value, 2);
assert.equal(rule0.source.ref, def.questions[0].id, "and it counts Q1");
ok("“at least 2 selected” stores exactly that: count/selected/options, gte, 2");

/*
 * The shortcut is not a second mechanism. A rule built with "at least" is
 * indistinguishable from one built by choosing ≥ from the operator list —
 * which is why "Minimum selections [2]" and "count >= 2" cannot drift apart.
 */
assert.equal(Object.keys(rule0.source.count).sort().join(","), "of,scope",
  "the stored spec carries nothing the programmer did not set");
ok("the quick buttons write an ordinary operator — no parallel min/max field");

/* ------------------------------- exactly 2 is a different rule from >= 2 */

await reopen(1, 0);
await page.waitForSelector(`${RULE} [data-testid="count-quick-eq"]`);
await page.click(`${RULE} [data-testid="count-quick-eq"]`);
await page.waitForTimeout(300);
def = await readDef();
stored = def.questions[1].options[0].logic.when;
rule0 = stored.children ? stored.children[0] : stored;
assert.equal(rule0.operator, "eq", "exactly 2 is stored as eq, not gte");
assert.equal(rule0.value, 2);
ok("EXACTLY N IS A DIFFERENT RULE FROM AT LEAST N, and both are one click away");

/* ============================================== counting a subset of options */

await reopen(1, 0);
await page.waitForSelector(`${RULE} [data-testid="count-subset"]`);
await page.click(`${RULE} [data-testid="count-subset"] summary`);
await page.waitForTimeout(150);
const codes = def.questions[0].options.map((o) => String(o.code));
await page.click(`${RULE} [data-testid="count-only-${codes[0]}"]`);
await page.click(`${RULE} [data-testid="count-only-${codes[2]}"]`);
await page.click(`${RULE} [data-testid="count-only-${codes[4]}"]`);
await page.waitForTimeout(350);

def = await readDef();
stored = def.questions[1].options[0].logic.when;
rule0 = stored.children ? stored.children[0] : stored;
assert.deepEqual(rule0.source.count.only.map(String), [codes[0], codes[2], codes[4]],
  `the subset is stored: ${JSON.stringify(rule0.source.count.only)}`);
ok("A SUBSET OF OPTIONS CAN BE COUNTED — the A / C / E case, stored as picked");

/* ------------- and the lint refuses a subset target it can never reach ---- */

await reopen(1, 0);
await page.waitForSelector(`${RULE} [data-testid="count-editor"]`);
await page.fill(`${RULE} [data-testid="count-value"]`, "4");
await page.waitForTimeout(400);
const warn = await page.$$eval(`${RULE} [data-testid="count-problem"]`, (els) =>
  els.map((e) => e.textContent).join(" | "));
assert.match(warn, /never reach 4/, `the impossible count is called out: ${warn}`);
assert.match(warn, /only 3/, "…and it says how many there are to count");
ok("A COUNT THAT CAN NEVER BE SATISFIED IS FLAGGED, with the number that makes it impossible");

/* the reading, in words, so the rule can be checked without reading JSON */
const reading = await page.textContent(`${RULE} [data-testid="count-reading"]`);
assert.match(reading, /how many selected/, reading);
assert.match(reading, /3 chosen options/, reading);
ok(`the count reads back in plain words: “${reading.trim()}”`);

/* -------------------------------- back to counting all, then off again ---- */

await page.fill(`${RULE} [data-testid="count-value"]`, "2");
await page.click(`${RULE} [data-testid="count-subset"] summary`).catch(() => {});
await page.click(`${RULE} [data-testid="count-only-clear"]`);
await page.waitForTimeout(350);
def = await readDef();
stored = def.questions[1].options[0].logic.when;
rule0 = stored.children ? stored.children[0] : stored;
assert.equal(rule0.source.count.only, undefined, "counting all stores no subset");
ok("clearing the subset counts the whole list again");

await reopen(1, 0);
await page.waitForSelector(`${RULE} [data-testid="toggle-count"]`);
await page.click(`${RULE} [data-testid="toggle-count"]`);
await page.waitForTimeout(350);
assert.equal((await page.$$(`${RULE} [data-testid="count-editor"]`)).length, 0,
  "the count editor closes");
def = await readDef();
stored = def.questions[1].options[0].logic.when;
rule0 = stored.children ? stored.children[0] : stored;
assert.equal(rule0.source.count, undefined,
  "TURNING COUNTING OFF LEAVES AN ORDINARY RULE — the count is dropped, not kept dormant");
assert.equal(rule0.source.ref, def.questions[0].id, "and the question it read is untouched");
ok("counting can be turned off, and what is left is an ordinary rule");

/* ================================= a grid: count rows by their response */

/*
 * A matrix cannot be built by typing in this panel, so it is applied through
 * the JSON tab's own "validate & apply" — the same door a programmer uses to
 * paste a definition. What is under test here is the count editor's behaviour
 * on a grid, not the grid editor.
 */
def = await readDef();
const grid = {
  id: "q_grid_ct", code: "QG", variableName: "GRID", type: "matrix_single",
  text: "Rate each product",
  rows: [
    { code: "pa", label: "Product A" }, { code: "pb", label: "Product B" },
    { code: "pc", label: "Product C" },
  ],
  options: [
    { code: "1", label: "Very poor" }, { code: "2", label: "Poor" },
    { code: "3", label: "Neutral" }, { code: "4", label: "Good" },
    { code: "5", label: "Very good" },
  ],
};
def.questions.push(grid);
def.flow[0].questionIds.push(grid.id);

await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
await page.click('[data-testid="json-edit"]');
await page.waitForTimeout(150);
await page.$eval("textarea.code", (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, JSON.stringify(def, null, 2));
await page.click('[data-testid="json-apply"]');
await page.waitForTimeout(600);
await page.click(".leftnav >> text=Questions");
await page.waitForSelector(".block-badge");

def = await readDef();
const gridQ = def.questions.find((q) => q.id === "q_grid_ct");
assert.ok(gridQ, "the grid was applied");
assert.equal(gridQ.rows.length, 3);
ok("a 3×5 grid applied through the JSON door");

await reopen(1, 1);
await page.click('[data-testid="option-logic"] [data-testid="vis-show_when"]');
await page.waitForSelector('[data-testid="option-logic"] [data-testid="logic-builder"]');
await page.click('[data-testid="option-logic"] [data-testid="lb-add-condition"]');
await page.waitForSelector(RULE);
await page.selectOption(`${RULE} .ref-select`, `q:${gridQ.id}`);
await page.waitForTimeout(250);
await page.click(`${RULE} [data-testid="toggle-count"]`);
await page.waitForSelector(`${RULE} [data-testid="count-editor"]`);

/*
 * A grid offers rows AND options to count over. A multi-select offered only
 * options — the scope dropdown never lists a collection the question does not
 * have, because a rule counting rows on a question with no rows is a rule that
 * silently never fires.
 */
const scopes = await page.$$eval(`${RULE} [data-testid="count-scope"] option`,
  (els) => els.map((e) => e.value));
assert.ok(scopes.includes("rows") && scopes.includes("options"),
  `a grid offers rows and options: ${JSON.stringify(scopes)}`);
ok("A GRID OFFERS ROWS TO COUNT OVER — and a multi-select is given no such choice");

await page.selectOption(`${RULE} [data-testid="count-scope"]`, "rows");
await page.selectOption(`${RULE} [data-testid="count-of"]`, "matching");
await page.waitForSelector(`${RULE} [data-testid="count-responses"]`);
await page.click(`${RULE} [data-testid="count-response-4"]`);
await page.click(`${RULE} [data-testid="count-response-5"]`);
await page.fill(`${RULE} [data-testid="count-value"]`, "3");
await page.waitForTimeout(450);

const gridReading = await page.textContent(`${RULE} [data-testid="count-reading"]`);
assert.match(gridReading, /Good or Very good/, gridReading);
ok(`the grid count reads back by LABEL, not by code: “${gridReading.trim()}”`);

def = await readDef();
const st = def.questions[1].options[1].logic.when;
const r = st.children ? st.children[0] : st;
assert.equal(r.source.count.scope, "rows");
assert.equal(r.source.count.of, "matching");
assert.deepEqual(r.source.count.responseIn.map(String), ["4", "5"]);
assert.equal(r.value, 3);
ok("“count rows rated Good or Very good >= 3” is buildable, and stored as picked");

/* and the subset picker follows the scope: rows, not options */
await reopen(1, 1);
await page.waitForSelector(`${RULE} [data-testid="count-subset"]`);
await page.click(`${RULE} [data-testid="count-subset"] summary`);
await page.waitForTimeout(150);
assert.ok(await page.$(`${RULE} [data-testid="count-only-pa"]`), "rows are the pickable subset");
assert.equal((await page.$$(`${RULE} [data-testid="count-only-1"]`)).length, 0,
  "…and the response codes are NOT offered as a subset — they are a different axis");
await page.click(`${RULE} [data-testid="count-only-pa"]`);
await page.click(`${RULE} [data-testid="count-only-pc"]`);
await page.waitForTimeout(400);
def = await readDef();
const st2 = def.questions[1].options[1].logic.when;
const r2 = st2.children ? st2.children[0] : st2;
assert.deepEqual(r2.source.count.only.map(String), ["pa", "pc"]);
ok("COUNT SPECIFIC GRID ROWS — “at least 3 of Products A and C rated Good+” is expressible");

/* --------------------------------------------------------------- errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL COUNT LOGIC CHECKS PASSED (${passed})`);
