/**
 * AUTO PUNCH RULE HEADER, AT NARROW PANEL WIDTH (Logic Builder UI fix, part
 * A bug 2).
 *
 * A live repro against a running dev server (throwaway, not part of this
 * corpus) reproduced the reported "SimplExpression" overlap: the header
 * used the generic `.row` utility (no `flex-wrap`), so an unbounded-length
 * `ap-rule-text` mono span next to three `white-space:nowrap` buttons
 * caused flex-shrink to squeeze the buttons below their own text's natural
 * width once the row was narrower than its content — and shrunk button
 * text, unable to reflow, overflowed and visually overlapped the next
 * button. The header now uses a dedicated `.ap-rule-head`/`.ap-rule-actions`
 * pair that wraps instead of shrinking. This is the browser-level
 * regression test: it measures actual bounding boxes at the Properties
 * panel's real width, the same way the live repro that found the bug did.
 *
 *   node scripts/autopunch-header-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

/* a long question text on both sides pushes formatPunchExpression's output
   well past what the ~440px right panel can show without wrapping */
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "AutoPunchHeader", version: "1.0" },
  questions: [
    {
      id: "a3", code: "A3", variableName: "A3", type: "multi_select",
      text: "Which of the following brands have you personally purchased in the last twelve months?",
      options: [{ code: "1", label: "Brand One Incorporated" }, { code: "2", label: "Brand Two Holdings" }],
    },
    {
      id: "q33", code: "Q33_COPY", variableName: "Q33_COPY", type: "multi_select",
      text: "Unaided brand awareness follow-up", options: [{ code: "1", label: "asa" }, { code: "2", label: "bsb" }],
      punches: [{
        id: "pr1", label: "seed", mode: "if", action: "select", ignoreUnmatched: true, recompute: "once",
        mapping: [], source: { kind: "codes", codes: ["1"] },
        when: { type: "rule", source: { kind: "question", ref: "a3" }, operator: "selected", value: "1" },
      }],
    },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["a3", "q33"] }, { type: "end", id: "e1", status: "complete" }],
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
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 2);
ok("fixture loaded: a long-text trigger question feeding a punch rule with a long formatted expression");

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards = await page.$$(".qcard");
await cards[cards.length - 1].click(); // Q33_COPY
await ensureSectionOpen("auto-punch");
await page.waitForSelector('[data-testid="ap-rule"]');
await page.waitForTimeout(300);

/* -------------------------------------------------------- no overlap at all */

const selectors = [
  '[data-testid="ap-chain-mode"]',
  '[data-testid="ap-rule-text"]',
  '[data-testid="ap-mode-simple"]',
  '[data-testid="ap-mode-expression"]',
  '[data-testid="ap-remove"]',
];
const rects = {};
for (const sel of selectors) rects[sel] = await rect(sel);

for (let i = 0; i < selectors.length; i++) {
  for (let j = i + 1; j < selectors.length; j++) {
    assert.ok(
      !overlaps(rects[selectors[i]], rects[selectors[j]]),
      `${selectors[i]} and ${selectors[j]} must not overlap — got ${JSON.stringify(rects[selectors[i]])} / ${JSON.stringify(rects[selectors[j]])}`,
    );
  }
}
ok("chain-mode select, rule text, Simple, Expression, and × never overlap each other at the default panel width");

/* -------- the button GROUP travels together: none of the three buttons split
   across rows independently of the others */
const simpleTop = rects['[data-testid="ap-mode-simple"]'].top;
const exprTop = rects['[data-testid="ap-mode-expression"]'].top;
const removeTop = rects['[data-testid="ap-remove"]'].top;
assert.ok(Math.abs(simpleTop - exprTop) < 4 && Math.abs(exprTop - removeTop) < 4,
  "Simple / Expression / × must stay on the same line as each other, wrapping together rather than splitting mid-group");
ok("the mode/remove button group wraps as one unit, never splitting across lines independently");

/* --------------------------------------- the full text survives, via title */
const title = await page.getAttribute('[data-testid="ap-rule-text"]', "title");
const shownText = await page.textContent('[data-testid="ap-rule-text"]');
assert.ok(title && title.length > 0, "ap-rule-text must carry the full expression in its title attribute");
assert.equal(title, shownText, "the title attribute matches the (possibly visually truncated) rendered text exactly");
ok(`ap-rule-text's title carries the full expression: "${title.slice(0, 60)}${title.length > 60 ? "…" : ""}"`);

/* --------------------------------------------- also check a narrowed viewport */
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(200);
const narrowRects = {};
for (const sel of selectors) narrowRects[sel] = await rect(sel);
for (let i = 0; i < selectors.length; i++) {
  for (let j = i + 1; j < selectors.length; j++) {
    assert.ok(
      !overlaps(narrowRects[selectors[i]], narrowRects[selectors[j]]),
      `at a narrower viewport, ${selectors[i]} and ${selectors[j]} must still not overlap`,
    );
  }
}
ok("still no overlap at a narrower viewport (1400px)");

/* --------------------------------------------------------------- errors */
assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL AUTO PUNCH HEADER CHECKS PASSED (${passed})`);
