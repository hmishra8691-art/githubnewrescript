/**
 * §17–§19/§43: row masking and column masking on a real grid, simultaneously,
 * driven in Studio and checked in the real runtime.
 *
 * `masking-test.mjs` proves the option-level mask end to end; the engine
 * tests in `setExpression.test.ts` prove `runRows`/`runColumns` filter
 * correctly in isolation. What neither proves is that a respondent actually
 * SEES the intersection — that Studio's new per-dimension masking panels
 * (`masking-builder-rowMask` / `masking-builder-columnMask`) write a mask
 * that survives to the real grid renderer, on a question type
 * (`composite`) where `columns` genuinely drives the rendered header axis
 * rather than falling back to the question's own `options` (only
 * `composite`/`custom_table` render every `view.columns` entry as its own
 * header + cell column — see `QuestionRenderer.tsx`'s `Composite`).
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openPreview } from "./lib/preview.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Matrix masking", version: "1.0" },
  questions: [
    {
      id: "qp", code: "QP", variableName: "QP", type: "multi_select", text: "Which products?",
      options: [
        { code: "a", label: "Product A" }, { code: "b", label: "Product B" },
        { code: "c", label: "Product C" }, { code: "d", label: "Product D" },
      ],
    },
    {
      id: "qf", code: "QF", variableName: "QF", type: "multi_select", text: "Which fields?",
      options: [
        { code: "f1", label: "Field 1" }, { code: "f2", label: "Field 2" }, { code: "f3", label: "Field 3" },
      ],
    },
    {
      id: "qm", code: "QM", variableName: "QM", type: "composite", text: "Rate each product",
      rows: [
        { code: "a", label: "Product A" }, { code: "b", label: "Product B" },
        { code: "c", label: "Product C" }, { code: "d", label: "Product D" },
      ],
      columns: [
        { id: "f1", label: "Field 1", responseType: "text", variableStem: "F1" },
        { id: "f2", label: "Field 2", responseType: "text", variableStem: "F2" },
        { id: "f3", label: "Field 3", responseType: "text", variableStem: "F3" },
      ],
      rowMask: { expr: { kind: "ref", questionId: "qp", selection: "selected" }, action: "display", keepAlwaysShow: false },
      columnMask: { expr: { kind: "ref", questionId: "qf", selection: "selected" }, action: "display", keepAlwaysShow: false },
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["qp", "qf"] },
    { type: "page", id: "p2", questionIds: ["qm"] },
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

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 3);
console.log("✔ fixture loaded: two source questions plus a composite grid with rowMask + columnMask preset");

/* ------------------------------------- Studio: both panels render, and agree */

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards = await page.$$(".qcard");
await cards[cards.length - 1].click(); // qm is the last question
await page.waitForSelector('[data-testid="masking-builder-rowMask"]');
await page.waitForSelector('[data-testid="masking-builder-columnMask"]');
await page.$eval('[data-testid="masking-builder-rowMask"]', (e) => e.scrollIntoView({ block: "center" }));
console.log('✔ §28: row masking and column masking each render their own panel on a question with both rows and columns');

const exprOf = async (field) => {
  const scope = `[data-testid="masking-builder-${field}"]`;
  await page.click(`${scope} [data-testid="mask-mode-expression"]`);
  await page.waitForSelector(`${scope} [data-testid="mask-expression"]`);
  return (await page.inputValue(`${scope} [data-testid="mask-expression"]`)).trim();
};
assert.equal(await exprOf("rowMask"), "QP.Selected", "the row mask's tree round-trips to its expression");
assert.equal(await exprOf("columnMask"), "QF.Selected", "the column mask's tree round-trips to its expression");
console.log("✔ §22: both panels read back the exact expression the fixture set — same builder, two independent fields");

const finalDef = await readDef();
assert.deepEqual(finalDef.questions[2].rowMask.expr, { kind: "ref", questionId: "qp", selection: "selected" });
assert.deepEqual(finalDef.questions[2].columnMask.expr, { kind: "ref", questionId: "qf", selection: "selected" });

await page.screenshot({ path: "/tmp/st-masking-matrix.png", fullPage: false });

/* ------------------------------------------------- the real runtime, §43 */

const preview = await openPreview(
  browser,
  "http://localhost:3001",
  { definition: finalDef },
  { selector: ".rs-option", viewport: { width: 1000, height: 1000 } },
);

assert.equal((await preview.$$("[data-qid]")).length, 2, "page 1 holds QP and QF");
for (const [qid, labels] of [
  ["qp", ["Product A", "Product C"]],
  ["qf", ["Field 2", "Field 3"]],
]) {
  for (const label of labels) {
    await preview.click(`[data-qid="${qid}"] .rs-option:has-text("${label}")`);
    await preview.waitForTimeout(90);
  }
}
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForSelector('[data-qid="qm"]');
await preview.waitForTimeout(400);

/*
 * QP.Selected = {a, c} drives rowMask; QF.Selected = {f2, f3} drives
 * columnMask. Neither mask touches the other dimension — the grid a
 * respondent actually sees should be exactly the 2x2 intersection.
 */
const rowIds = await preview.$$eval('[data-qid="qm"] [data-rs-el="row"]', (els) =>
  els.map((e) => e.getAttribute("data-rs-id")).filter((v, i, a) => a.indexOf(v) === i));
const colIds = await preview.$$eval('[data-qid="qm"] [data-rs-el="column"]', (els) =>
  els.map((e) => e.getAttribute("data-rs-id")));
const cellIds = await preview.$$eval('[data-qid="qm"] [data-rs-el="cell"]', (els) =>
  els.map((e) => e.getAttribute("data-rs-id")));

assert.deepEqual(rowIds, ["a", "c"], `rowMask left only Product A and C: ${rowIds}`);
assert.deepEqual(colIds, ["f2", "f3"], `columnMask left only Field 2 and 3: ${colIds}`);
assert.equal(cellIds.length, 4, `2 rows x 2 columns = 4 cells: ${cellIds}`);
for (const id of ["a::f2", "a::f3", "c::f2", "c::f3"]) {
  assert.ok(cellIds.includes(id), `expected cell ${id} in the intersection: ${cellIds}`);
}
for (const id of ["b::f1", "a::f1", "d::f3"]) {
  assert.ok(!cellIds.includes(id), `${id} is outside the intersection and must not render`);
}
console.log("✔ §19/§43: the real grid shows only the intersection — Product A/C rows crossed with Field 2/3 columns");

await preview.screenshot({ path: "/tmp/rt-masking-matrix.png" });
await preview.close();
await browser.close();
console.log("\nALL MATRIX MASKING CHECKS PASSED");
