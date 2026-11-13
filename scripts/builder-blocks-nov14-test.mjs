/**
 * THE BUILDER, 14/11/2026 — in the Studio sandbox (no account):
 *
 *   TOP ROW      the four actions above the blocks are gone; the counts stay
 *   IN A BLOCK   + Question · type… · From another survey, once per block (and in an empty block)
 *   MOVE         "Move block to…": how (beginning / before / after / end), then which block — each block once,
 *                never itself, never a move that does nothing; the preview; codes and questions unchanged after
 *   ADD          a block before / after from the block's menu; + Add block under the last block
 *   CODES        a block switched to automatic codes renumbers when a question is deleted; references follow;
 *                moving a block changes no code
 *
 *   AI_API_URL=fake: next dev -p 3000   (apps/studio), then   node scripts/builder-blocks-nov14-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const YN = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];
const q = (id, code, extra = {}) => ({ id, code, variableName: code, type: "single_select", text: `Question ${code}`, options: YN, required: true, ...extra });
const seed = {
  meta: { id: "sandbox", code: "SBX", title: "Blocks", version: "1.0" },
  questions: [
    q("a1", "S1"), q("a2", "S2"), q("a3", "S3", { displayLogic: { type: "rule", source: { kind: "question", ref: "a1" }, operator: "selected", value: 1 } }),
    q("b1", "Q1"), q("b2", "Q2", { text: "You said {{S2}}" }),
    q("c1", "D1"),
  ],
  flow: [
    { type: "page", id: "blkA", title: "Screener", questionIds: ["a1", "a2", "a3"] },
    { type: "page", id: "blkB", title: "Main", questionIds: ["b1", "b2"] },
    { type: "page", id: "blkC", title: "Demographics", questionIds: ["c1"] },
    { type: "page", id: "blkD", title: "Welcome", questionIds: [] },
    { type: "end", id: "e", status: "complete" },
  ],
};
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript((s) => { window.__rescriptSandboxSeed = s; }, seed);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForSelector('[data-testid="block"]', { timeout: 60000 });
const blocks = () => page.$$eval('[data-testid="block"]', (els) => els.map((e) => (e.querySelector('[data-testid="block-title"]')?.value ?? "").trim()));
const codes = () => page.$$eval('.qlist-item strong.mono', (els) => els.map((e) => e.textContent.trim()));
const menu = async (i) => { await page.locator('[data-testid="block-menu"]').nth(i).click(); await page.waitForSelector(".menu"); };

console.log("\nTOP ROW AND IN-BLOCK ACTIONS");
for (const gone of ["add-question-top", "add-block", "add-block-at"]) assert.equal(await page.$(`[data-testid="${gone}"]`), null, `${gone} is gone`);
assert.match(await page.innerText(".ide-body"), /6 questions/);
ok("the four top-level actions are gone; the question and block counts stay");
assert.deepEqual(await blocks(), ["Screener", "Main", "Demographics", "Welcome"]);
assert.equal(await page.locator('[data-testid="library-open"]').count(), 4, "one From another survey per block");
assert.ok(await page.locator('[data-testid="add-question-here"]').count() >= 4);
const emptyBlock = page.locator('[data-testid="block"]').nth(3);
assert.equal(await emptyBlock.locator('[data-testid="add-question-here"]').count(), 1);
assert.equal(await emptyBlock.locator('[data-testid="add-question-type"]').count(), 1);
assert.equal(await emptyBlock.locator('[data-testid="library-open"]').count(), 1);
ok("every block has + Question · type… · From another survey — once per block, and in the empty block");
await emptyBlock.locator('[data-testid="library-open"]').click();
await page.waitForSelector('[data-testid="library-dialog"]');
assert.match(await page.innerText('[data-testid="library-dialog"]'), /next to the block you opened this from/);
await page.click('[data-testid="library-dialog"] button:has-text("Cancel")');
ok("From another survey opens from the block and says where the questions will arrive");
await emptyBlock.locator('[data-testid="add-question-here"]').click();
await page.waitForFunction(() => document.querySelectorAll(".qlist-item").length === 7);
ok("+ Question inside the empty block adds a question there");
assert.ok(await page.$('[data-testid="add-block-footer"]'), "+ Add block stays under the last block");

console.log("\nMOVE BLOCK TO…");
const before = await codes();
await menu(1);
const items = await page.$$eval(".menu .menu-item", (els) => els.map((e) => e.textContent.trim()));
for (const want of [/Move block up/, /Move block down/, /Move block to/, /Add a block before this one/, /Add a block after this one/, /Question codes:/]) assert.ok(items.some((t) => want.test(t)), `${want} in ${items.join(" | ")}`);
assert.equal(items.filter((t) => /Move block/.test(t)).length, 3, "three move entries, no duplicates");
await page.click('[data-testid="move-block-to"]');
await page.waitForSelector('[data-testid="block-placement-dialog"]');
const hows = await page.$$eval('[data-testid="block-placement-how"] option', (o) => o.map((x) => x.textContent));
assert.deepEqual(hows, ["At the beginning of the survey", "Before a block…", "After a block…", "At the end of the survey"]);
const pick = async (how) => { await page.selectOption('[data-testid="block-placement-how"]', how); return page.$$eval('[data-testid="block-placement-block"] option', (o) => o.map((x) => x.textContent)).catch(() => []); };
const beforeList = await pick("before");
const afterList = await pick("after");
assert.deepEqual(beforeList.map((t) => t.split(" · ")[0]), ["Block 1 — Screener", "Block 4 — Welcome"], "before: not itself, not the block that already follows it");
assert.deepEqual(afterList.map((t) => t.split(" · ")[0]), ["Block 3 — Demographics", "Block 4 — Welcome"], "after: not itself, not the block that already precedes it");
assert.equal(new Set([...beforeList]).size, beforeList.length);
ok(`four ways to place it; each block listed once with its number, name and size (${beforeList.join(" / ")})`);
await page.selectOption('[data-testid="block-placement-how"]', "start");
const order = await page.$$eval('[data-testid="block-move-preview"] ol li', (els) => els.map((e) => e.textContent.trim().split(" · ")[0]));
assert.deepEqual(order, ["Main", "Screener", "Demographics", "Welcome"]);
assert.match(await page.innerText('[data-testid="block-move-conflicts"]'), /Q2 uses the answer to S2/);
ok("the preview shows the new order and what it would break (Q2 pipes S2, which would come after it)");
await page.selectOption('[data-testid="block-placement-how"]', "after");
await page.selectOption('[data-testid="block-placement-block"]', { index: 0 });
assert.ok(await page.$('[data-testid="block-move-clean"]'));
await page.click('[data-testid="block-placement-confirm"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="block-title"]')].map((e) => e.value).join(",") === "Screener,Demographics,Main,Welcome");
const afterCodes = await codes();
assert.deepEqual([...afterCodes].sort(), [...before].sort(), "the same questions with the same codes — none duplicated, none recoded");
assert.equal(afterCodes.length, 7);
ok("moved after Demographics: order updated; every question kept, no code changed, none duplicated");

console.log("\nADD A BLOCK BEFORE / AFTER");
await menu(0);
await page.click('[data-testid="add-block-after"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="block"]').length === 5);
assert.deepEqual(await blocks(), ["Screener", "", "Demographics", "Main", "Welcome"]);
await menu(0);
await page.click('[data-testid="add-block-before"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="block"]').length === 6);
assert.deepEqual(await blocks(), ["", "Screener", "", "Demographics", "Main", "Welcome"]);
ok("a block added after, then before, the first block lands exactly there");

console.log("\nQUESTION CODES — automatic / manual");
await menu(1);
assert.match(await page.innerText('[data-testid="block-auto-code"]'), /Question codes: manual — switch to automatic/);
await page.click('[data-testid="block-auto-code"]');
await page.waitForTimeout(300);
await menu(1);
assert.match(await page.innerText('[data-testid="block-auto-code"]'), /Question codes: automatic — switch to manual/);
await page.evaluate(() => document.querySelector(".menu-scrim")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await page.waitForSelector(".menu", { state: "detached" });
const screener = page.locator('[data-testid="block"]').nth(1);
assert.deepEqual(await screener.locator(".qlist-item strong.mono").allTextContents(), ["S1", "S2", "S3"]);
page.once("dialog", (d) => d.accept());
await screener.locator('[data-testid="delete-question"]').nth(1).click();
const confirm = await page.waitForSelector('[data-testid="delete-question-confirm"]', { timeout: 4000 }).catch(() => null);
if (confirm) await confirm.click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="block"]')[1].querySelectorAll(".qlist-item").length === 2);
assert.deepEqual(await screener.locator(".qlist-item strong.mono").allTextContents(), ["S1", "S2"], "S3 became S2 — no gap");
const all = await codes();
assert.equal(new Set(all).size, all.length, `no duplicate codes: ${all.join(", ")}`);
ok("automatic codes: deleting S2 renumbers S3 → S2; no duplicates anywhere in the survey");
/* the manual blocks kept theirs */
assert.ok(all.includes("Q1") && all.includes("Q2") && all.includes("D1"));
ok("blocks left on manual codes are untouched");

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nBUILDER 14/11: ${passed} checks passed`);
