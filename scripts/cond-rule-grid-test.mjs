/**
 * `.cond-rule`'s GRID LAYOUT, WITH A SUB-EDITOR ATTACHED (Logic Builder UI
 * fix, part A bug 1).
 *
 * A live repro against a running dev server (throwaway, not part of this
 * corpus) reproduced the exact bug from the reported screenshot and pinned
 * it down: `.cond-rule` was an implicit 2-column CSS Grid with no
 * `grid-template-areas`, so a conditionally-rendered sub-editor
 * (`CountEditor`'s `.count-editor`, `ExprEditor`'s `.expr-editor`) got
 * auto-placed into the column meant for the remove button, ballooned that
 * column to its own content width, and starved `.cond-rule-main`'s `1fr`
 * column down to its explicit `0` floor — collapsing the source/operator/
 * value controls to an invisible sliver while the sub-editor ate the row.
 * `.cond-rule` now uses named `grid-template-areas` so a sub-editor always
 * gets a full-width row of its own regardless of DOM order or how many
 * "extra" rows appear. This is the browser-level regression test for that
 * fix: it measures actual computed layout, the same way the live repro that
 * found the bug did, rather than only checking that elements exist.
 *
 *   node scripts/cond-rule-grid-test.mjs      (studio on 3000)
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

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "CondRuleGrid", version: "1.0" },
  questions: [
    {
      id: "a3", code: "A3", variableName: "A3", type: "multi_select", text: "Which brands have you used?",
      options: [
        { code: "1", label: "Brand One" }, { code: "2", label: "Brand Two" },
        { code: "3", label: "Brand Three" }, { code: "4", label: "Brand Four" },
        { code: "5", label: "Brand Five" },
      ],
    },
    { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "How many total?" },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Follow-up",
      options: [{ code: "yes", label: "Yes" }, { code: "no", label: "No" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["a3", "q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
};

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") {
    await page.click(head);
    await page.waitForTimeout(150);
  }
};
const rect = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
const width = (sel) => page.$eval(sel, (el) => getComputedStyle(el).width);
/** True if two axis-aligned rects overlap on both axes. */
const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 3);
ok("fixture loaded");

/* ============================================================ COUNT case */

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards = await page.$$(".qcard");
await cards[cards.length - 1].click(); // Q2, the last question
await ensureSectionOpen("display-logic");

let addBtn = await page.$('[data-testid="optional-add"]');
if (addBtn) await addBtn.click();
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
await page.waitForTimeout(200);

await page.selectOption(".ref-select", { label: "A3 — A3" });
await page.waitForTimeout(200);
await page.click('[data-testid="toggle-count"]');
await page.waitForSelector(".count-editor");
await page.waitForTimeout(300);

const mainW = parseFloat(await width(".cond-rule-main"));
const countW = parseFloat(await width(".count-editor"));
assert.ok(mainW > 50, `.cond-rule-main must have real width, not be starved to 0: got ${mainW}px`);
assert.ok(countW > 50, `.count-editor must have real width: got ${countW}px`);
ok(`.cond-rule-main (${mainW.toFixed(0)}px) and .count-editor (${countW.toFixed(0)}px) both have real width`);

const mainRect = await rect(".cond-rule-main");
const countRect = await rect(".count-editor");
const actionsRect = await rect(".cond-rule-actions");
assert.ok(!overlaps(mainRect, countRect), "the main row and the COUNT sub-editor must not overlap");
assert.ok(!overlaps(mainRect, actionsRect), "the main row and the remove button must not overlap");
ok("no bounding-box overlap between .cond-rule-main, .count-editor, and .cond-rule-actions");

assert.ok(
  Math.abs(mainRect.top - actionsRect.top) < 4,
  `the remove button must stay on the SAME row as .cond-rule-main, not get pushed to row 2 — main.top=${mainRect.top}, actions.top=${actionsRect.top}`,
);
ok(".cond-rule-actions (the × button) stays on .cond-rule-main's row even with a sub-editor present");

assert.ok(countRect.top > mainRect.bottom - 2, "the COUNT sub-editor must render BELOW the main row, on its own full-width row");
ok(".count-editor renders on its own row below .cond-rule-main");

/* =========================================================== expr() case */

/*
 * An `expr`-kind source (SUM/COUNT/AVG/… as the condition's own source, not
 * a value) is only offered in the source dropdown once a rule already has
 * one — it is reached by typing a function call in Expression mode and
 * switching back to Visual, not by picking it from a plain select. Loading
 * a fixture where the rule already has `source.kind === "expr"` exercises
 * the exact same JSX/CSS path (ConditionBuilder.tsx line ~449) without
 * needing to reproduce that authoring flow here.
 */
const EXPR_FIXTURE = structuredClone(FIXTURE);
EXPR_FIXTURE.questions[2].displayLogic = {
  type: "rule",
  source: { kind: "expr", ref: "SUM(Q1)" },
  operator: "gte",
  value: 3,
};
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(EXPR_FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards2 = await page.$$(".qcard");
await cards2[cards2.length - 1].click(); // Q2 again
await ensureSectionOpen("display-logic");
await page.waitForSelector(".expr-editor, [data-testid='expr-editor-readonly']");
await page.waitForTimeout(300);

const mainW2 = parseFloat(await width(".cond-rule-main"));
assert.ok(mainW2 > 50, `.cond-rule-main must have real width with an expr sub-editor present: got ${mainW2}px`);
const mainRect2 = await rect(".cond-rule-main");
const exprRect = await page.evaluate(
  () => (document.querySelector(".expr-editor") ?? document.querySelector("[data-testid='expr-editor-readonly']"))
    .getBoundingClientRect().toJSON(),
);
assert.ok(!overlaps(mainRect2, exprRect), "the main row and the expr sub-editor must not overlap");
assert.ok(exprRect.top > mainRect2.bottom - 2, "the expr sub-editor must render below the main row");
ok(".cond-rule-main and the expr sub-editor (.expr-editor / expr-editor-readonly) don't overlap, and expr renders on its own row");

/* ==================================================== no horizontal overflow */

const overflow = await page.$eval(".cond-rule", (el) => el.scrollWidth <= el.clientWidth + 1);
assert.ok(overflow, ".cond-rule must not overflow horizontally");
ok("no horizontal overflow on .cond-rule");

/* --------------------------------------------------------------- errors */
assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL COND-RULE GRID CHECKS PASSED (${passed})`);
