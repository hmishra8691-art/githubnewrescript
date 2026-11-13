/**
 * Browser suite — "Show [only the answers they chose at] [Q1]" (2026-11-13, engine listGoals.ts).
 *
 * The researcher says what the list should show; the engine picks list logic or carry-forward, says what it will do
 * before anything is stored, and adds an ordinary rule of that tool.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/list-goal-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }];
const seed = {
  meta: { id: "sandbox", code: "SBX", title: "Lists", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands do you know?", options: BRANDS },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Overall?", options: [{ code: 1, label: "Good" }, { code: 2, label: "Poor" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Which have you bought?", options: BRANDS },
    { id: "q4", code: "Q4", variableName: "Q4", type: "multi_select", text: "Which would you never buy?", options: [] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "e", status: "complete" }],
};
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addInitScript((s) => { window.__rescriptSandboxSeed = s; }, seed);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 150000 });
await page.waitForSelector('[data-testid="qcard"]', { timeout: 90000 });
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const select = async (id) => { if (!(await page.$(`${card(id)}.selected`))) await page.click(`${card(id)} [data-testid="qcard-toggle"]`); await page.waitForSelector(`${card(id)}.selected`); };
const readDef = async () => {
  await openTab(page, "JSON"); await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await openTab(page, "Questions"); await page.waitForSelector('[data-testid="qcard"]');
  return JSON.parse(json);
};
const preview = () => page.textContent('[data-testid="alr-goal-preview"], [data-testid="alr-goal-reason"]').then((t) => t.replace(/\s+/g, " ").trim());

console.log("\nANSWER LIST — say what it should show");
{
  await select("q3");
  await page.waitForSelector('[data-testid="alr-goal"]');
  assert.equal(await page.inputValue('[data-testid="alr-goal-source"]'), "q1", "the nearest earlier multi-select is chosen, not the nearer single-select");
  const sources = await page.$$eval('[data-testid="alr-goal-source"] option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(sources, ["Q2", "Q1"], "only earlier questions, nearest first");
  assert.equal(await page.isVisible('[data-testid="alr-tool-list-logic"]'), false, "the four tools wait behind “Something else?”");
  assert.match(await preview(), /This will: Keeps only the options selected at Q1\. \(list logic\)/);
  assert.equal((await readDef()).questions[2].listLogic?.length ?? 0, 0, "the preview stores nothing");
  ok("a plain question opens on “Show [only the answers they chose at] [Q1]”, with what it will do, before anything is stored");
}
{
  await select("q3");
  await page.selectOption('[data-testid="alr-goal-what"]', "chosen_first");
  assert.match(await preview(), /to the top/);
  await page.click('[data-testid="alr-goal-apply"]');
  await page.waitForSelector('[data-testid="alr-step"][data-section="list-logic"]');
  const q3 = (await readDef()).questions[2];
  assert.equal(q3.listLogic.length, 1);
  assert.deepEqual({ ...q3.listLogic[0], id: "x" }, { id: "x", sourceQuestionId: "q1", action: "prioritize", which: "selected" });
  ok("Apply adds an ordinary list-logic rule (same answer list as Q1) and the overview shows it");
}
{
  await select("q3");
  await page.click('[data-testid="alr-add"] > summary');
  await page.waitForSelector('[data-testid="alr-add"] [data-testid="alr-goal"]');
  await page.selectOption('[data-testid="alr-add"] [data-testid="alr-goal-what"]', "chosen_first");
  assert.match(await page.textContent('[data-testid="alr-add"] [data-testid="alr-goal-reason"]'), /already does that/);
  assert.equal(await page.isDisabled('[data-testid="alr-add"] [data-testid="alr-goal-apply"]'), true);
  ok("with a rule in place the builder is under “Add another rule” and refuses a duplicate, saying why");
}
{
  await select("q4");
  await page.waitForSelector('[data-testid="alr-goal"]');
  await page.selectOption('[data-testid="alr-goal-what"]', "except_chosen");
  assert.match(await preview(), /carry-forward/);
  await page.click('[data-testid="alr-goal-apply"]');
  await page.waitForSelector('[data-testid="alr-step"][data-section="carry-forward"]');
  const q4 = (await readDef()).questions[3];
  assert.deepEqual(q4.carryForward, { sourceQuestionId: "q3", filter: "not_selected", into: "options", keepOwn: false });
  ok("a question with no answers of its own gets carry-forward from the nearest multi-select (Q3), not selected");
}
{
  await select("q1");
  await page.waitForSelector('[data-testid="alr-goal-none"]');
  ok("the first question says there is nothing earlier to follow");
}
{
  await select("q2");
  const title = await page.textContent('[data-testid="psec-head-auto-punch"]');
  assert.match(title, /Select answers automatically \(auto punch\)/);
  ok("auto punch is named for what it does, its technical name kept in brackets");
}
assert.deepEqual(errors, []);
await browser.close();
console.log(`\nlist-goal-test: ${passed} checks passed`);
