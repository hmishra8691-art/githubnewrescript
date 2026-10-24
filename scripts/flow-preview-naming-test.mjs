/**
 * Browser suite — client reviews of 19/10 and 23/10/2026, group 3 / H3:
 *
 *   A32  Survey Flow → "+ Add element" opens ONE long row of nine icon
 *        buttons across the flow's width (not a 3 × 3 popup): equal sizes,
 *        tooltips, hover purpose line, insert + close, reopen, horizontal
 *        scroll on a narrow viewport, the same row at every insert position.
 *   A44  "Preview block" shows ONLY that block: no Back out of its first
 *        page, Next never reaches the next block, the completion card says
 *        "Thank you for completing this block." with "↻ Restart Block", which
 *        restarts that block alone; the full preview is unchanged.
 *   B20  the variable name keeps the case typed (Q6a stays Q6a); a name that
 *        differs only by case from another is refused.
 *   B47–B55  carry-forward destinations follow the target's type: a choice
 *        question has one fixed destination ("the answer list (rows)"), a
 *        grid offers rows and columns only, "options" is never offered, a
 *        saved value the type no longer offers is flagged and fixed in one
 *        click; the source list offers only questions with something to carry.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 \
 *     node --experimental-strip-types --no-warnings scripts/flow-preview-naming-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const opts = (n) => Array.from({ length: n }, (_, i) => ({ code: String(i + 1), label: `Option ${i + 1}` }));
const FIXTURE = () => ({
  meta: { id: "sandbox", code: "H3", title: "Flow preview naming", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Block one, question one" },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Block one, pick one", options: opts(3) },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Block two, first page", options: opts(3) },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Block two, second page — you picked {{Q3}}" },
    { id: "q5", code: "Q5", variableName: "Q5", type: "matrix_single", text: "Block three grid",
      rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }], options: opts(3) },
    { id: "q6", code: "Q6", variableName: "Q6", type: "open_text", text: "Block three, open end" },
  ],
  flow: [
    { type: "embedded_data", id: "ed0", fields: [{ name: "REGION", source: "static", value: "north", dataType: "string" }] },
    { type: "page", id: "blk1", title: "Block one", questionIds: ["q1", "q2"] },
    { type: "block", id: "blk2", title: "Block two", children: [
      { type: "page", id: "blk2_p1", questionIds: ["q3"] },
      { type: "page", id: "blk2_p2", questionIds: ["q4"] },
    ] },
    { type: "page", id: "blk3", title: "Block three", questionIds: ["q5", "q6"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());

/* resilient to a dev-server restart: retry the whole action, never skip the check */
const retry = async (fn, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await page.waitForTimeout(3000 * (i + 1)); }
  }
  throw last;
};
const goTab = async (n) => { await openTab(page, n); await page.waitForTimeout(200); };
const loadDef = (def) => retry(async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
});
/* reads the JSON tab, then goes back to the tab it came from — a hidden tab still answers textContent, so a suite that forgot would be asserting on a screen nobody sees */
const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) { await openTabKey(page, activeTab).catch(() => {}); await page.waitForTimeout(200); }
  return JSON.parse(json);
};
const toFlow = async () => { await goTab("Survey Flow"); await page.waitForSelector('[data-testid="flow-counts"]'); };
const selectQuestion = async (code) => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) {
    if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(250); return; }
  }
  throw new Error(`no card for ${code}`);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
};
const answerOf = (pv, qid) => pv.evaluate((id) => window.__rescriptState?.answers?.[id], qid);
const next = async (pv) => { await pv.click('[data-testid="rs-next"]'); await pv.waitForTimeout(250); };

await retry(async () => {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
});

/* ============================================================ A32: Add Element row */
{
  await loadDef(FIXTURE());
  await toFlow();
  const insertBtn = '[data-testid="flow-insert"] >> nth=1';
  await page.click(insertBtn);
  await page.waitForSelector('[data-testid="flow-insert-menu"][data-state="open"]');
  const btns = page.locator('[data-testid="flow-insert-menu"] .add-el-btn');
  assert.equal(await btns.count(), 9, "nine elements");
  const boxes = await btns.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), icon: !!e.querySelector("svg.ico"), label: e.textContent.trim(), title: e.getAttribute("title") }; }));
  assert.equal(new Set(boxes.map((b) => b.top)).size, 1, `all nine on ONE row: ${boxes.map((b) => b.top)}`);
  assert.ok(boxes.every((b, i) => i === 0 || b.left > boxes[i - 1].left), "left to right, in order");
  assert.equal(new Set(boxes.map((b) => `${b.w}x${b.h}`)).size, 1, `equal sizes: ${boxes.map((b) => `${b.w}x${b.h}`)}`);
  assert.deepEqual(boxes.map((b) => b.label), ["Embedded data", "Branch / condition", "Randomizer", "Loop", "Quota check", "Redirect", "End of survey", "Block", "Group"]);
  assert.ok(boxes.every((b) => b.icon && / — /.test(b.title)), "icon on top, a tooltip with a short description");
  // icon above the label
  const iconAbove = await btns.first().evaluate((e) => e.querySelector("svg.ico").getBoundingClientRect().bottom <= e.querySelector(".add-el-label").getBoundingClientRect().top + 1);
  assert.ok(iconAbove, "icon above the label");
  // the container spans the flow row it sits in (directly below the + Add element position)
  const span = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="flow-insert-menu"]');
    const row = panel.closest(".flow-insert");
    const btn = row.querySelector('[data-testid="flow-insert"]');
    const p = panel.getBoundingClientRect(), r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
    const cs = getComputedStyle(panel);
    return { pw: Math.round(p.width), rw: Math.round(r.width), below: p.top >= b.bottom - 1, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth };
  });
  assert.ok(span.pw >= span.rw - 2, `the panel spans the row's width (${span.pw} of ${span.rw})`);
  assert.ok(span.below, "it expands directly below the + Add element position");
  assert.ok(parseFloat(span.radius) >= 8 && parseFloat(span.border) >= 1, "rounded corners and a subtle border");
  // hover: blue border + light background, and the purpose line
  await btns.nth(2).hover();
  await page.waitForTimeout(200);
  const hov = await btns.nth(2).evaluate((e) => { const cs = getComputedStyle(e); return { border: cs.borderColor, bg: cs.backgroundColor }; });
  const rest = await btns.nth(5).evaluate((e) => { const cs = getComputedStyle(e); return { border: cs.borderColor, bg: cs.backgroundColor }; });
  assert.notEqual(hov.border, rest.border, "hover changes the border colour");
  assert.notEqual(hov.bg, rest.bg, "hover changes the background");
  assert.match(await page.textContent('[data-testid="flow-insert-hint"]'), /Randomizer — shuffle what comes next/);
  ok("A32: one long row of nine equal icon+label buttons across the flow width, tooltips, hover highlight");

  // insert closes the row and puts the element at that position
  await page.click('[data-testid="insert-branch"]');
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached", timeout: 3000 });
  await page.waitForTimeout(300);
  let def = await readDef();
  assert.deepEqual(def.flow.slice(0, 3).map((n) => n.type), ["embedded_data", "branch", "page"], "the branch is inserted at the chosen position");
  // reopen from the same position; Escape closes again
  await toFlow();
  await page.click(insertBtn);
  await page.waitForSelector('[data-testid="flow-insert-menu"][data-state="open"]');
  assert.equal(await page.locator('[data-testid="flow-insert-menu"] .add-el-btn').count(), 9, "reopens with all nine");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "insert-section", "keyboard: End jumps to the last");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached" });
  // the same row at EVERY "+ Add element": the last position, and inside the new branch's empty path
  const n = await page.locator('[data-testid="flow-insert"]').count();
  await page.click(`[data-testid="flow-insert"] >> nth=${n - 1}`);
  await page.waitForSelector('[data-testid="flow-insert-menu"][data-state="open"]');
  assert.equal(await page.locator('[data-testid="flow-insert-menu"] .add-el-btn').count(), 9);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached" });
  const emptyInserts = await page.locator('[data-testid="flow-insert-empty"]').count();
  assert.ok(emptyInserts >= 1, "an empty container offers + Add element too");
  await page.click('[data-testid="flow-insert-empty"] >> nth=0');
  await page.waitForSelector('[data-testid="flow-insert-menu"][data-state="open"]');
  const inner = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="flow-insert-menu"]');
    const row = panel.closest(".flow-insert");
    return { pw: Math.round(panel.getBoundingClientRect().width), rw: Math.round(row.getBoundingClientRect().width), tops: new Set([...panel.querySelectorAll(".add-el-btn")].map((b) => Math.round(b.getBoundingClientRect().top))).size };
  });
  assert.ok(inner.pw >= inner.rw - 2 && inner.tops === 1, `inside a container the row spans the container (${inner.pw}/${inner.rw}) on one line`);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached" });
  ok("A32: insert closes and inserts at the position; reopenable; the same row at every + Add element, containers included");

  // narrow viewport: the row scrolls sideways, nothing is cut off or wrapped
  await page.setViewportSize({ width: 640, height: 900 });
  await page.waitForTimeout(300);
  await page.click(insertBtn);
  await page.waitForSelector('[data-testid="flow-insert-menu"][data-state="open"]');
  const narrow = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="add-el-row"]');
    const btns = [...row.querySelectorAll(".add-el-btn")];
    const tops = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)));
    return { scrollW: row.scrollWidth, clientW: row.clientWidth, overflowX: getComputedStyle(row).overflowX, rows: tops.size, count: btns.length, minW: Math.min(...btns.map((b) => b.getBoundingClientRect().width)) };
  });
  assert.equal(narrow.count, 9);
  assert.equal(narrow.rows, 1, "still one row");
  assert.ok(narrow.scrollW > narrow.clientW && /auto|scroll/.test(narrow.overflowX), `scrolls horizontally (${narrow.scrollW} > ${narrow.clientW})`);
  assert.ok(narrow.minW >= 100, `no button is squeezed (${narrow.minW}px)`);
  // the last button can be scrolled into view and clicked
  await page.locator('[data-testid="insert-section"]').scrollIntoViewIfNeeded();
  const lastVisible = await page.evaluate(() => { const b = document.querySelector('[data-testid="insert-section"]').getBoundingClientRect(); const r = document.querySelector('[data-testid="add-el-row"]').getBoundingClientRect(); return b.right <= r.right + 1 && b.left >= r.left - 1; });
  assert.ok(lastVisible, "the last element is reachable by scrolling");
  await page.click('[data-testid="insert-section"]');
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached", timeout: 3000 });
  await page.waitForTimeout(300);
  def = await readDef();
  assert.equal(def.flow[1].type, "section", "a Group was added from the scrolled row");
  await page.setViewportSize({ width: 1500, height: 1000 });
  ok("A32: on a narrow width the row scrolls sideways — nine buttons, none cut off");
}

/* ============================================================ A44: block preview isolation */
{
  await loadDef(FIXTURE());
  await goTab("Questions");
  await page.waitForSelector('[data-testid="block-preview"]');
  const buttons = await page.$$('[data-testid="block-preview"]');
  assert.equal(buttons.length, 3, "every block has Preview block");
  // block two depends on nothing earlier → opens directly
  const [pv] = await Promise.all([context.waitForEvent("page"), buttons[1].click()]);
  await pv.waitForSelector('[data-qid="q3"]', { timeout: 45_000 });
  assert.equal(await pv.textContent('[data-testid="preview-block"]'), "Block two");
  assert.equal(await pv.$('[data-qid="q1"]'), null, "block one is not shown");
  assert.equal(await pv.$('[data-qid="q5"]'), null, "block three is not shown");
  assert.equal(await pv.$('[data-testid="rs-back"]'), null, "no Back on the block's first page — there is nothing before it");
  assert.equal(await pv.evaluate(() => window.__rescriptState?.embedded?.REGION), "north", "embedded data on the way to the block is still set");
  await pv.click('[data-qid="q3"] input[value="2"]');
  await next(pv);
  await pv.waitForSelector('[data-qid="q4"]');
  assert.match(await pv.textContent('[data-qid="q4"]'), /Option 2/, "piping within the block works");
  assert.ok(await pv.$('[data-testid="rs-back"]'), "Back exists on the block's second page");
  await pv.click('[data-testid="rs-back"]');
  await pv.waitForSelector('[data-qid="q3"]');
  assert.equal(await pv.$('[data-qid="q1"]'), null, "Back from the first page never shows block one");
  assert.equal(await pv.$('[data-testid="rs-back"]'), null, "…and Back is gone again on the first page");
  await next(pv);
  await pv.waitForSelector('[data-qid="q4"]');
  await pv.fill('[data-qid="q4"] input, [data-qid="q4"] textarea', "done");
  assert.equal(await pv.getAttribute('[data-testid="rs-next"]', "data-rs-button"), "submit", "the block's last page submits");
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-ended"]');
  assert.equal(await pv.getAttribute('[data-testid="rs-ended"]', "data-preview-scope"), "block");
  assert.match(await pv.textContent('[data-testid="rs-ended"] h2'), /Thank you for completing this block\./);
  assert.match(await pv.textContent('[data-testid="rs-restart"]'), /Restart Block/);
  assert.equal(await pv.$('[data-qid="q5"]'), null, "block three never appeared after the block");
  ok("A44: only block two's questions; no Back out of it; Next ends at the block; completion says block / Restart Block");

  await pv.click('[data-testid="rs-restart"]');
  await pv.waitForSelector('[data-qid="q3"]');
  assert.equal(await answerOf(pv, "q3"), undefined, "Restart Block clears the block's test answers");
  assert.equal(await answerOf(pv, "q4"), undefined);
  assert.equal(await pv.textContent('[data-testid="preview-block"]'), "Block two", "it is still block two");
  assert.equal(await pv.$('[data-qid="q1"]'), null);
  await pv.close();
  ok("A44: Restart Block restarts block two from its first question with fresh answers");

  // block three (depends on Q3 through nothing → direct) shows its grid and open end only
  await goTab("Questions");
  const [pv3] = await Promise.all([context.waitForEvent("page"), (await page.$$('[data-testid="block-preview"]'))[2].click()]);
  await pv3.waitForSelector('[data-qid="q5"]', { timeout: 45_000 });
  assert.equal(await pv3.$('[data-qid="q3"]'), null);
  assert.equal(await pv3.$('[data-testid="rs-back"]'), null);
  await pv3.close();

  // the full preview is unchanged: every block, Back across blocks, the survey's own completion words
  const full = await openPreview(browser, RUNTIME, { definition: FIXTURE() });
  await full.waitForSelector('[data-qid="q1"]');
  await full.click('[data-qid="q2"] input[value="1"]');
  await next(full);
  await full.waitForSelector('[data-qid="q3"]');
  assert.ok(await full.$('[data-testid="rs-back"]'), "full preview: Back on block two's first page leads to block one");
  await full.click('[data-testid="rs-back"]');
  await full.waitForSelector('[data-qid="q1"]');
  await next(full);
  await full.waitForSelector('[data-qid="q3"]');
  await full.click('[data-qid="q3"] input[value="1"]');
  await next(full);
  await full.waitForSelector('[data-qid="q4"]');
  await next(full);
  await full.waitForSelector('[data-qid="q5"]');
  await next(full);
  await full.waitForSelector('[data-testid="rs-ended"]');
  assert.equal(await full.getAttribute('[data-testid="rs-ended"]', "data-preview-scope"), "survey");
  assert.match(await full.textContent('[data-testid="rs-ended"] h2'), /Thank you for completing this survey/);
  assert.match(await full.textContent('[data-testid="rs-restart"]'), /Restart test session/);
  await full.close();
  ok("A44: the full preview still walks every block, Back crosses blocks, and says survey / Restart test session");
}

/* ============================================================ B20: variable-name case */
{
  await loadDef(FIXTURE());
  await selectQuestion("Q1");
  const field = '[data-testid="question-variable-name"]';
  await page.waitForSelector(field);
  await page.fill(field, "Q6a");
  assert.equal(await page.inputValue(field), "Q6a", "the field keeps the case while typing");
  await page.press(field, "Enter");
  await page.waitForTimeout(400);
  let def = await readDef();
  assert.equal(def.questions.find((q) => q.id === "q1").variableName, "Q6a", "saved as typed");
  // invalid characters are still replaced
  await selectQuestion("Q1");
  await page.fill(field, "brand aware-ness");
  assert.equal(await page.inputValue(field), "brand_aware_ness");
  await page.press(field, "Escape");
  await page.waitForTimeout(400);
  assert.equal((await readDef()).questions.find((q) => q.id === "q1").variableName, "Q6a", "Escape abandons the edit — it never commits");
  // a name differing only by case from an existing one is refused
  await selectQuestion("Q2");
  await page.fill(field, "q6A");
  await page.press(field, "Enter");
  await page.waitForSelector('[data-testid="question-variable-name-error"]');
  assert.match(await page.textContent('[data-testid="question-variable-name-error"]'), /already/i);
  def = await readDef();
  assert.equal(def.questions.find((q) => q.id === "q2").variableName, "Q2", "the clash was refused, nothing changed");
  // the mixed-case name resolves in a preview pipe
  const d2 = await readDef();
  d2.questions.find((q) => q.id === "q2").text = "Hello {{Q6a}}";
  const pv = await openPreview(browser, RUNTIME, { definition: d2 });
  await pv.waitForSelector('[data-qid="q1"]');
  await pv.fill('[data-qid="q1"] input, [data-qid="q1"] textarea', "Asha");
  await pv.waitForTimeout(200);
  assert.match(await pv.textContent('[data-qid="q2"]'), /Hello Asha/, "{{Q6a}} resolves to the mixed-case variable");
  await pv.close();
  ok("B20: variable names keep their case (Q6a), invalid characters are replaced, a case-only duplicate is refused, piping resolves");
}

/* ============================================================ B47–B55: carry-forward destinations */
{
  await loadDef(FIXTURE());
  // a single-select target: ONE fixed destination, the answer list (rows); no "options" anywhere
  await selectQuestion("Q3");
  await ensureSectionOpen("carry-forward");
  await page.click('button:has-text("+ carry forward from another question")');
  await page.waitForSelector('[data-testid="cf-into"]');
  assert.equal(await page.$eval('[data-testid="cf-into"]', (e) => e.tagName), "SPAN", "no dropdown for a choice question");
  assert.match(await page.textContent('[data-testid="cf-into"]'), /answer list \(rows\)/);
  assert.equal(await page.getAttribute('[data-testid="cf-into"]', "data-into"), "options", "stored as options, as before");
  let def = await readDef();
  let cf = def.questions.find((q) => q.id === "q3").carryForward;
  assert.equal(cf.into, "options");
  assert.ok(!/into options/.test(await page.textContent('[data-testid="carry-forward-editor"]')), "“into options” is not shown");
  // the source list offers only questions with something to carry: Q2 (choice) and Q5 (grid), never Q1 / Q6 (open ends)
  const sources = await page.$$eval('[data-testid="cf-source"] option', (os) => os.map((o) => o.textContent));
  assert.ok(sources.includes("Q2") && sources.includes("Q5") && !sources.includes("Q1") && !sources.includes("Q6"), sources.join(","));
  await page.selectOption('[data-testid="cf-source"]', "q2");
  await page.waitForTimeout(300);
  ok("B51/B55: single-select → the answer list (rows) is chosen automatically; no Options choice; sources with a list only");

  // a grid target: rows and columns only
  await selectQuestion("Q5");
  await ensureSectionOpen("carry-forward");
  await page.click('button:has-text("+ carry forward from another question")');
  await page.waitForSelector('[data-testid="cf-into"]');
  assert.equal(await page.$eval('[data-testid="cf-into"]', (e) => e.tagName), "SELECT", "a grid chooses between rows and columns");
  const dests = await page.$$eval('[data-testid="cf-into"] option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(dests, ["→ into rows", "→ into columns"], dests.join(","));
  def = await readDef();
  cf = def.questions.find((q) => q.id === "q5").carryForward;
  assert.equal(cf.into, "rows", "a new grid carry-forward starts in rows");
  await page.selectOption('[data-testid="cf-into"]', { label: "→ into columns" });
  await page.waitForTimeout(300);
  def = await readDef();
  /* a per-row grid's columns ARE its scale: stored as options, the list the engine fills (as in the brand-tracker template) */
  assert.equal(def.questions.find((q) => q.id === "q5").carryForward.into, "options");
  assert.equal(await page.$eval('[data-testid="cf-into"]', (e) => e.selectedOptions[0].textContent), "→ into columns");
  ok("B53: grid → rows and columns only; columns are saved as the grid's column choices");

  // an older survey that stored the inert "columns" on a grid: flagged, kept until fixed, fixed in one click; a single-select storing "rows" too
  const old = FIXTURE();
  old.questions.find((q) => q.id === "q5").carryForward = { sourceQuestionId: "q2", filter: "selected", into: "columns", keepOwn: false };
  old.questions.find((q) => q.id === "q3").carryForward = { sourceQuestionId: "q2", filter: "selected", into: "rows", keepOwn: false };
  await loadDef(old);
  await selectQuestion("Q5");
  await ensureSectionOpen("carry-forward");
  await page.waitForSelector('[data-testid="cf-into-stale"]');
  assert.match(await page.textContent('[data-testid="cf-into-stale"]'), /never applied/);
  assert.equal(await page.getAttribute('[data-testid="cf-into"]', "data-into"), "columns", "the saved value is shown, not silently rewritten");
  assert.equal((await readDef()).questions.find((q) => q.id === "q5").carryForward.into, "columns", "nothing is written by merely opening the panel");
  await page.click('[data-testid="cf-into-fix"]');
  await page.waitForTimeout(300);
  assert.equal((await readDef()).questions.find((q) => q.id === "q5").carryForward.into, "options", "one click saves the grid's real column destination");
  await page.waitForSelector('[data-testid="cf-into-stale"]', { state: "detached" });
  await selectQuestion("Q3");
  await ensureSectionOpen("carry-forward");
  await page.waitForSelector('[data-testid="cf-into-stale"]');
  await page.click('[data-testid="cf-into-fix"]');
  await page.waitForTimeout(300);
  assert.equal((await readDef()).questions.find((q) => q.id === "q3").carryForward.into, "options", "a single-select saved as rows is fixed to its answer list");
  ok("B47–B55: a saved destination the type no longer offers is flagged, never rewritten silently, and fixed in one click");
}

assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join("\n")}`);
await browser.close();
console.log(`\nflow-preview-naming: ${passed} checks passed`);
