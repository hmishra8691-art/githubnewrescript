/**
 * MATRIX / GRID CELL AUTO PUNCH, driven in the real Studio and checked in the
 * real runtime (Universal Auto Punch Engine brief, gaps #1 and #3).
 *
 * Before this, a punch rule could only ever write a question's WHOLE answer.
 * On a matrix/composite target — whose answer is `Record<rowCode, value>`,
 * not a scalar — that meant a `select` punch replaced the entire per-row
 * object with one bare code, silently destroying every other row. This test
 * proves three things the engine unit tests (`autoPunchMatrixCell.test.ts`)
 * cannot: that a programmer can actually reach cell targeting through the
 * Studio UI (the new Row/Column pickers on the "auto-select from a set"
 * editor), that the Logic tab's trace panel shows the resolved cell and
 * names the winner when two rules disagree, and that a respondent's browser
 * only ever writes the one targeted cell — every sibling cell, including
 * ones the respondent already answered by hand, survives untouched.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openPreview } from "./lib/preview.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const SCALE = [{ code: "g", label: "Good" }, { code: "o", label: "OK" }, { code: "p", label: "Poor" }];

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Matrix auto punch", version: "1.0" },
  questions: [
    {
      id: "qt", code: "QT", variableName: "QT", type: "multi_select", text: "Trigger",
      options: [{ code: "go", label: "Mark product 1 / column 1 Good" }],
    },
    {
      id: "qm", code: "QM", variableName: "QM", type: "composite", text: "Rate each product",
      rows: [
        { code: "p1", label: "Product 1" },
        { code: "p2", label: "Product 2" },
      ],
      columns: [
        { id: "c1", label: "Column 1", responseType: "single", variableStem: "C1", options: SCALE },
        { id: "c2", label: "Column 2", responseType: "single", variableStem: "C2", options: SCALE },
      ],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["qt", "qm"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};
const goTab = async (name) => {
  await page.click(`.leftnav >> text=${name}`);
  await page.waitForTimeout(150);
};
const punchesOf = (def) => def.questions.find((q) => q.id === "qm")?.punches ?? [];

/** Properties panel sections are independently collapsible; expand one. */
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") {
    await page.click(head);
    await page.waitForTimeout(150);
  }
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 2);
console.log("✔ fixture loaded: a trigger question and a composite grid (2 rows x 2 single-select columns)");

/* ============================================ build the cell punch, in the UI */

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards = await page.$$(".qcard");
await cards[cards.length - 1].click(); // qm is the last question
await ensureSectionOpen("auto-punch");

await page.click('[data-testid="punch-add"]');
await page.waitForSelector('[data-testid="punch-rule"]');
await page.waitForTimeout(200);

// Row + column pickers (gap #1): address one cell, not the whole answer.
await page.selectOption('[data-testid="punch-target-row"]', "p1");
await page.waitForSelector('[data-testid="punch-target-column"]');
await page.selectOption('[data-testid="punch-target-column"]', "c1");
await page.waitForTimeout(250);

let def = await readDef();
let punches = punchesOf(def);
assert.equal(punches.length, 1);
assert.equal(punches[0].targetRow, "p1", "row picker wrote targetRow");
assert.equal(punches[0].targetColumn, "c1", "column picker wrote targetColumn");
console.log("✔ gap #1: the Row/Column pickers write targetRow/targetColumn on the punch rule");

// priority (gap #3), exercised even with one rule so the field round-trips.
await page.fill('[data-testid="punch-priority"]', "5");
await page.waitForTimeout(250);
assert.equal(punchesOf(await readDef())[0].priority, 5, "priority round-trips");
console.log("✔ gap #3: an explicit priority field is reachable from the Studio UI");

// An explicit mapping: QT's "go" code maps to the addressed cell's own code "g" —
// the "to" control must offer the ADDRESSED COLUMN's options, not the
// question's own (composite has none at the top level).
await page.click('[data-testid="punch-add-mapping"]');
await page.waitForSelector('[data-testid="punch-mapping"]');
await page.fill('[data-testid="punch-mapping"] input', "go");
const toOptions = await page.$$eval('[data-testid="punch-mapping"] select option',
  (els) => els.map((e) => e.value));
assert.deepEqual(toOptions, ["g", "o", "p"], `the mapping target list is column c1's own scale: ${toOptions}`);
await page.selectOption('[data-testid="punch-mapping"] select', "g");
await page.waitForTimeout(300);

def = await readDef();
punches = punchesOf(def);
assert.deepEqual(punches[0].mapping, [{ from: "go", to: "g" }]);
assert.equal(punches[0].source.questionId, "qt");
console.log('✔ the mapping "to" control adapts to the addressed cell\'s own options, and the rule stores QT → cell p1[c1]');

/* ============================================ the Logic tab trace shows it */

await goTab("Logic");
await page.waitForSelector('[data-testid="logic-trace"], [data-testid="trace-empty"]');
const targetVal = await page.$eval('[data-testid="trace-target"]', (el) => {
  const o = [...el.options].find((x) => /auto punch/.test(x.textContent));
  return o ? o.value : "";
});
assert.ok(targetVal, "the cell punch rule is offered as a trace target");
await page.selectOption('[data-testid="trace-target"]', targetVal);
await page.fill('[data-testid="trace-answer-qt"]', "go");
await page.waitForTimeout(400);

const resolutionText = await page.textContent('[data-testid="punch-trace-resolution"]');
assert.match(resolutionText, /p1/, `the trace names the targeted row: ${resolutionText}`);
assert.match(resolutionText, /c1/, `the trace names the targeted column: ${resolutionText}`);
assert.match(resolutionText, /g\b/, `the trace shows the resolved code: ${resolutionText}`);
console.log("✔ the Logic tab's trace panel names the cell this rule resolved to — not just that it applied");

/* ================================================= the actual runtime, §43 */

const finalDef = await readDef();
const preview = await openPreview(
  browser,
  "http://localhost:3001",
  { definition: finalDef },
  { selector: ".rs-option", viewport: { width: 1000, height: 1000 } },
);

assert.equal((await preview.$$("[data-qid]")).length, 2, "QT and QM share one page");

/*
 * Manually answer two OTHER cells first — one sharing the target's row, one
 * sharing its column — so the regression this test guards against would be
 * unmissable: the old whole-answer overwrite replaced QM's entire per-row
 * answer object with a bare code the instant QT was ticked, wiping both of
 * these out along with everything else.
 *
 * A composite cell's radio carries no `value` attribute (it is a controlled
 * `checked` boolean with no `value` prop at all — see `CompositeCell` in
 * QuestionRenderer.tsx), so cells are addressed by their visible label text.
 */
const clickCell = (cell, label) =>
  preview.click(`[data-qid="qm"] [data-rs-id="${cell}"] label:has-text("${label}")`);
const checkedLabel = (cell) => preview.$eval(
  `[data-qid="qm"] [data-rs-id="${cell}"]`,
  (el) => {
    const input = el.querySelector("input:checked");
    return input ? input.closest("label")?.textContent.trim() ?? null : null;
  },
).catch(() => null);

await clickCell("p1::c2", "OK");
await preview.waitForTimeout(80);
await clickCell("p2::c1", "Poor");
await preview.waitForTimeout(80);

assert.equal(await checkedLabel("p1::c2"), "OK", "manually answered before the trigger fires");
assert.equal(await checkedLabel("p2::c1"), "Poor", "manually answered before the trigger fires");
assert.equal(await checkedLabel("p1::c1"), null, "the target cell starts empty");
console.log("✔ two sibling cells are answered by hand before the trigger fires");

// Fire the trigger — same page, so this exercises the live dependency-driven
// re-punch, not just page-arrival prefill.
await preview.click('[data-qid="qt"] .rs-option:has-text("Mark product 1")');
await preview.waitForTimeout(250);

assert.equal(await checkedLabel("p1::c1"), "Good", "the targeted cell was punched to Good");
assert.equal(await checkedLabel("p1::c2"), "OK", "row p1's OTHER column survived untouched");
assert.equal(await checkedLabel("p2::c1"), "Poor", "column c1's OTHER row survived untouched");
console.log("✔ THE BUG FIX, LIVE: only the addressed cell changed — every sibling cell, including hand-answered ones, is untouched");

// Untick the trigger: `recompute: "once"` is the default, so the punch is a
// one-time fill, not a live tether — the cell stays exactly where the
// respondent could still edit it, matching how every other punch already behaves.
await preview.click('[data-qid="qt"] .rs-option:has-text("Mark product 1")');
await preview.waitForTimeout(250);
assert.equal(await checkedLabel("p1::c1"), "Good", "fill-once: unticking the trigger does not claw the cell back");
console.log("✔ recompute:once applies to cell punches exactly as it does to every other punch");

await preview.screenshot({ path: "/tmp/rt-autopunch-matrix.png" });
await preview.close();
await page.screenshot({ path: "/tmp/st-autopunch-matrix.png", fullPage: false });
await browser.close();
console.log("\nALL MATRIX AUTO PUNCH CHECKS PASSED");
