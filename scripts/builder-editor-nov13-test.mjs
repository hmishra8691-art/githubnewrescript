/**
 * 13/11/2026 sheet — the programmer's half, in the Studio sandbox (the respondent's half is builder-items-nov13-test):
 *
 *   CARRY FORWARD   the "carried options" table in the question's editor: wording per option, always show, exclude,
 *                   wording for all — each lands in `carryForward` and nowhere else; the source is not edited
 *   SETTINGS        single-option rule, consent, total label, sum-matrix axis + column target, task paging and
 *                   auto-next on a conjoint — each control writes its setting
 *   COLUMNS         every matrix column is its own numbered card
 *   CODES           retyping a code's prefix in an automatic block renumbers that block from there
 *   FONT SIZE       a typed size applies to the SELECTED words (the selection is kept while the box has focus)
 *
 *   node scripts/builder-editor-nov13-test.mjs      (Studio on :3000; set STUDIO_URL to override)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }];
const seed = {
  meta: { id: "sandbox", code: "SBX", title: "Editor", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands have you bought?", options: BRANDS, required: true },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which would you buy again?", options: [], required: true, carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "allocation", text: "Split 100 points", options: [{ code: 1, label: "Price" }, { code: 2, label: "Quality" }], required: true, settings: { sumTarget: 100 } },
    { id: "q4", code: "Q4", variableName: "Q4", type: "composite", variant: "matrix.constant_sum", text: "Split the budget", required: true,
      rows: [{ code: "r1", label: "North" }, { code: "r2", label: "South" }],
      columns: [{ id: "c1", label: "Online", responseType: "numeric", variableStem: "Q4_C1", min: 0 }, { id: "c2", label: "Store", responseType: "numeric", variableStem: "Q4_C2", min: 0 }],
      settings: { rowSum: true, sumTarget: 100 } },
    { id: "q5", code: "Q5", variableName: "Q5", type: "conjoint_task", variant: "conjoint.cbc", text: "Which would you buy?", required: true, settings: {} },
  ],
  flow: [{ type: "page", id: "blkA", title: "Main", autoCode: true, questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
};
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addInitScript((s) => { window.__rescriptSandboxSeed = s; }, seed);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForSelector('[data-testid="qcard"]', { timeout: 60000 });
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await openTab(page, "Questions");
  await page.waitForSelector('[data-testid="qcard"]');
  return JSON.parse(json);
};
const qOf = async (id) => (await readDef()).questions.find((q) => q.id === id);
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const openQ = async (id) => {
  if (!(await page.$(`${card(id)}.selected`))) await page.click(`${card(id)} [data-testid="qcard-toggle"]`);
  await page.waitForSelector(`${card(id)}.selected`);
};
const type = async (sel, v) => { await page.fill(sel, v); await page.dispatchEvent(sel, "blur"); await page.waitForTimeout(120); };

console.log("\nCARRY FORWARD — the carried-options table");
await openQ("q2");
await page.waitForSelector(`${card("q2")} [data-testid="carried-options"]`);
assert.equal(await page.locator(`${card("q2")} [data-testid="carried-row"]`).count(), 3, "one row per option of the source");
ok("a question that carries options from Q1 shows Q1's three options as rows");
await type(`${card("q2")} [data-testid="carried-label-1"]`, "Nike products");
await page.check(`${card("q2")} [data-testid="carried-always-2"]`);
await page.check(`${card("q2")} [data-testid="carried-exclude-3"]`);
await type(`${card("q2")} [data-testid="carried-template"]`, "{{label}} items");
{
  const d = await readDef();
  const cf = d.questions.find((q) => q.id === "q2").carryForward;
  assert.equal(cf.labels?.["1"], "Nike products");
  assert.deepEqual((cf.always ?? []).map(String), ["2"]);
  assert.deepEqual((cf.exclude ?? []).map(String), ["3"]);
  assert.equal(cf.labelTemplate, "{{label}} items");
  assert.equal(cf.sourceQuestionId, "q1"); assert.equal(cf.filter, "selected");
  assert.deepEqual(d.questions.find((q) => q.id === "q1").options.map((o) => o.label), ["Nike", "Adidas", "Puma"], "the source keeps its own wording");
}
ok("wording, always show, exclude and wording-for-all are saved on this question's carry-forward; Q1 is not edited");

console.log("\nSETTINGS — each control writes its setting");
await openQ("q1");
await page.selectOption(`${card("q1")} [data-testid="question-single-option"]`, "select");
await page.selectOption(`${card("q1")} [data-testid="question-consent"]`, "yes");
{
  const s = (await qOf("q1")).settings ?? {};
  assert.equal(s.singleOption, "select"); assert.equal(s.consent, true);
}
ok("single-option rule → select; consent → yes");
await openQ("q3");
await type(`${card("q3")} [data-testid="total-label"]`, "Grand Total");
assert.equal(((await qOf("q3")).settings ?? {}).totalLabel, "Grand Total");
ok("allocation total label saved");
await openQ("q4");
assert.equal(await page.locator(`${card("q4")} [data-testid="column-card"]`).count(), 2);
assert.deepEqual((await page.locator(`${card("q4")} [data-testid="column-heading"]`).allInnerTexts()).map((t) => t.trim().toLowerCase()), ["column 1", "column 2"]);
ok("each matrix column is its own numbered card");
await page.selectOption(`${card("q4")} [data-testid="summatrix-axis"]`, "both");
await page.waitForSelector(`${card("q4")} [data-testid="summatrix-column-target"]`);
await type(`${card("q4")} [data-testid="summatrix-column-target"]`, "80");
await type(`${card("q4")} [data-testid="summatrix-total-label-input"]`, "Sum");
{
  const s = (await qOf("q4")).settings ?? {};
  assert.equal(s.sumAxis, "both"); assert.equal(Number(s.columnSumTarget), 80); assert.equal(s.totalLabel, "Sum"); assert.equal(s.sumTarget, 100);
}
ok("sum matrix: axis both, column target 80, label “Sum”; the row target is untouched");
await openQ("q5");
await page.selectOption(`${card("q5")} [data-testid="question-task-paging"]`, "all");
assert.equal(((await qOf("q5")).settings ?? {}).taskPaging, "all");
await openQ("q5");
assert.equal(await page.$(`${card("q5")} [data-testid="question-task-auto-next"]`), null, "auto-next is only offered when tasks are paged");
await page.selectOption(`${card("q5")} [data-testid="question-task-paging"]`, "one");
await page.selectOption(`${card("q5")} [data-testid="question-task-auto-next"]`, "on");
{
  const s = (await qOf("q5")).settings ?? {};
  assert.ok(s.taskPaging === "one" || s.taskPaging === undefined); assert.equal(s.taskAutoNext, true);
}
ok("conjoint: all tasks on one page ↔ one at a time; auto-next offered only when paged, and saved");

console.log("\nCODES — a new prefix renumbers the automatic block");
await openQ("q1");
await type(`${card("q1")} [data-testid="question-code"]`, "S1");
await page.waitForTimeout(400);
{
  const d = await readDef();
  assert.deepEqual(d.questions.map((q) => q.code), ["S1", "S2", "S3", "S4", "S5"]);
  assert.equal(new Set(d.questions.map((q) => q.variableName)).size, 5, "variable names stay unique");
}
ok("Q1 retyped as S1 in an automatic block → S1…S5");

console.log("\nFONT SIZE — applies to the selected words");
await openQ("q3");
const ed = page.locator(`${card("q3")} [contenteditable="true"]`).first();
await ed.click();
await page.keyboard.press("Control+a");
const size = page.locator(`${card("q3")} [data-testid="rte-font-size"]`).first();
await size.click();
await size.fill("27");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await page.click(`${card("q3")} [data-testid="total-label"]`);
await page.waitForTimeout(300);
{
  const t = (await qOf("q3")).text;
  assert.match(t, /font-size:\s*27px/, `the size is on the text: ${t}`);
  assert.match(t.replace(/<[^>]+>/g, ""), /Split 100 points/);
}
ok("select the text, type 27 in the size box, Enter → the selected words are 27px");

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\n13/11 BUILDER EDITOR: ${passed} checks passed`);
