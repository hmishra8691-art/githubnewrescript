/**
 * 13/11/2026 sheet — the respondent-facing half, in the runtime preview:
 *
 *   TOTAL LABEL   an allocation shows "Total" by default and the programmer's word when set; the sum rule is unchanged
 *   SUM MATRIX    calculation method: row totals (default), column totals under each column, or both; a wrong
 *                 column is named and Next is refused; the label follows `totalLabel`
 *   CARRY FORWARD the inherited options with this question's wording, an always-shown option, an excluded one,
 *                 the question's own options after them; the stored answer is the source's code
 *
 *   node scripts/builder-items-nov13-test.mjs      (runtime on :3001; set RUNTIME_URL to override)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const base = (id) => ({
  meta: { id, code: id.toUpperCase(), title: id, version: "1.0", schemaVersion: 1, status: "draft" },
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], designs: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const end = { type: "end", id: "e1", status: "complete" };
const after = { id: "q_after", code: "Q9", variableName: "AFTER", type: "open_text", required: false, text: "Anything else?" };
const browser = await chromium.launch();
const pageErrors = [];
const open = async (def, selector) => {
  SurveyDefinition.parse(def);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector });
  return page;
};
const next = async (page) => { await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(350); };
const answers = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState.answers)));
const fill = async (page, sel, v) => { await page.fill(sel, String(v)); await page.dispatchEvent(sel, "blur"); await page.waitForTimeout(80); };

console.log("\nTOTAL LABEL — allocation");
{
  const alloc = (id, settings) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "allocation", required: true, text: "Split 100 points", options: [{ code: 1, label: "Price" }, { code: 2, label: "Quality" }], settings: { sumTarget: 100, ...settings } });
  const def = { ...base("tl"), questions: [alloc("a1", {}), alloc("a2", { totalLabel: "Grand Total" }), after], flow: [{ type: "page", id: "p1", questionIds: ["a1", "a2"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, end] };
  const page = await open(def, '[data-qid="a1"]');
  assert.equal((await page.textContent('[data-qid="a1"] [data-testid="alloc-total-label"]')).trim(), "Total");
  assert.equal((await page.textContent('[data-qid="a2"] [data-testid="alloc-total-label"]')).trim(), "Grand Total");
  ok("default “Total”; a custom label on the question that sets one, independently");
  const boxes = await page.$$('[data-qid="a2"] input');
  await boxes[0].fill("60"); await boxes[1].fill("30"); await page.keyboard.press("Tab");
  assert.match(await page.textContent('[data-qid="a2"] .rs-alloc-total'), /Grand Total:\s*90\s*\/\s*100/);
  const b1 = await page.$$('[data-qid="a1"] input');
  await b1[0].fill("50"); await b1[1].fill("50"); await page.keyboard.press("Tab");
  await next(page);
  assert.ok(await page.$('[data-qid="a2"]'), "90 of 100 is still refused: the label changes no rule");
  await boxes[1].fill("40"); await page.keyboard.press("Tab");
  await next(page);
  await page.waitForSelector('[data-qid="q_after"]');
  ok("the custom label sits beside the running total; the sum rule is unchanged (90 refused, 100 accepted)");
  await page.close();
}

console.log("\nCONSTANT-SUM MATRIX — row / column / both");
{
  const grid = (id, settings) => ({
    id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "composite", variant: "matrix.constant_sum", required: true, text: "Split the budget",
    rows: [{ code: "r1", label: "North" }, { code: "r2", label: "South" }],
    columns: [{ id: "c1", label: "Online", responseType: "numeric", variableStem: `${id.toUpperCase()}_C1`, min: 0 }, { id: "c2", label: "Store", responseType: "numeric", variableStem: `${id.toUpperCase()}_C2`, min: 0 }],
    settings: { rowSum: true, sumTarget: 100, ...settings },
  });
  const cell = (q, r, c) => `[data-qid="${q}"] td[data-row="${r}"][data-col="${c}"] input`;
  for (const [axis, label] of [[undefined, undefined], ["column", "Sum"], ["both", undefined]]) {
    const def = { ...base(`sm_${axis ?? "row"}`), questions: [grid("g", { ...(axis ? { sumAxis: axis } : {}), ...(label ? { totalLabel: label } : {}) }), after], flow: [{ type: "page", id: "p1", questionIds: ["g"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, end] };
    const page = await open(def, '[data-qid="g"]');
    const rowTotals = await page.$$('[data-testid^="summatrix-total-r"]');
    const colTotals = await page.$('[data-testid="summatrix-coltotals"]');
    /* rows 100 / 100, columns 70 / 130 */
    await fill(page, cell("g", "r1", "c1"), 60); await fill(page, cell("g", "r1", "c2"), 40);
    await fill(page, cell("g", "r2", "c1"), 10); await fill(page, cell("g", "r2", "c2"), 90);
    if (!axis) {
      assert.equal(rowTotals.length, 2); assert.equal(colTotals, null);
      assert.equal((await page.textContent('[data-testid="summatrix-total-label"]')).trim(), "Total");
      await next(page); await page.waitForSelector('[data-qid="q_after"]');
      ok("row total (default): a total at the end of each row, no column totals, rows validated as before");
    } else if (axis === "column") {
      assert.equal(rowTotals.length, 0); assert.ok(colTotals);
      assert.equal((await page.textContent('[data-testid="summatrix-coltotal-label"]')).trim(), "Sum");
      assert.match(await page.textContent('[data-testid="summatrix-coltotal-c1"]'), /70\s*\/\s*100/);
      await next(page);
      assert.ok(await page.$('[data-qid="g"]'));
      assert.match(await page.evaluate(() => document.body.innerText), /Column “Online” must total 100 \(currently 70\)/);
      await fill(page, cell("g", "r2", "c1"), 40); await fill(page, cell("g", "r2", "c2"), 60);
      assert.match(await page.textContent('[data-testid="summatrix-coltotal-c1"]'), /100\s*\/\s*100/);
      await next(page); await page.waitForSelector('[data-qid="q_after"]');
      ok("column total: a live total under each column with the custom label; the wrong column is named; fixed → accepted (rows are not checked)");
    } else {
      assert.equal(rowTotals.length, 2); assert.ok(colTotals);
      await next(page);
      assert.ok(await page.$('[data-qid="g"]'), "rows are right but the columns are not");
      await fill(page, cell("g", "r2", "c1"), 40); await fill(page, cell("g", "r2", "c2"), 60);
      await next(page); await page.waitForSelector('[data-qid="q_after"]');
      assert.deepEqual((await answers(page)).g, { r1: { c1: 60, c2: 40 }, r2: { c1: 40, c2: 60 } }, "the stored cells are the same shape as ever");
      ok("both: row and column totals drawn, each checked on its own; the answer is the same cells");
    }
    await page.close();
  }
}

console.log("\nCARRY FORWARD — wording, always, exclude, own options");
{
  const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }, { code: 4, label: "Reebok" }, { code: 97, label: "Other", flags: ["other_specify"] }];
  const def = {
    ...base("cf"),
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", required: true, text: "Which of these brands have you purchased?", options: BRANDS },
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", required: true, text: "Why did you purchase these brands?",
        options: [{ code: 98, label: "None of these", flags: ["exclusive"] }, { code: 99, label: "Not sure" }],
        carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options", keepOwn: true, labels: { "1": "Nike products" }, labelTemplate: "{{label}} items", always: [4], exclude: [3] } },
      { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", required: true, text: "Which one most?", options: [], carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" } },
      after,
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "page", id: "p3", questionIds: ["q3"] }, { type: "page", id: "p4", questionIds: ["q_after"] }, end],
  };
  const page = await open(def, '[data-qid="q1"]');
  const labels = (qid) => page.$$eval(`[data-qid="${qid}"] label`, (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  const tick = async (qid, text) => { await page.click(`[data-qid="${qid}"] label:has-text("${text}")`); };
  await tick("q1", "Nike"); await tick("q1", "Adidas"); await tick("q1", "Puma");
  await next(page);
  await page.waitForSelector('[data-qid="q2"]');
  assert.deepEqual(await labels("q2"), ["Nike products", "Adidas items", "Reebok items", "None of these", "Not sure"]);
  ok("selected Nike, Adidas, Puma → “Nike products”, “Adidas items”, Reebok (always), no Puma (excluded), then the question's own options");
  await tick("q2", "Nike products"); await tick("q2", "Reebok items");
  await next(page);
  await page.waitForSelector('[data-qid="q3"]');
  assert.deepEqual(await labels("q3"), ["Nike", "Adidas", "Puma"], "a second question from the same source has its own rules");
  const a = await answers(page);
  assert.deepEqual(a.q2, [1, 4], "the stored answer is the source's codes, whatever the wording here");
  assert.deepEqual(a.q1, [1, 2, 3], "the source answer is untouched");
  ok("the answer stored is the source codes [1, 4]; Q1 unchanged; another question from the same source shows the plain list");
  await page.close();
}

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\n13/11 BUILDER ITEMS: ${passed} checks passed`);
