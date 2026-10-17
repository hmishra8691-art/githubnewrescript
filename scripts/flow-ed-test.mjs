/**
 * Browser suite — Survey Flow: Embedded Data, Insert Piped Text, Test Value,
 * the Add Element grid and automatic data types (document 15/10/2026).
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/flow-ed-test.mjs
 *
 * STUDIO   /sandbox?mode=studio → Survey Flow
 *   F  the Add Element popover is a 3-per-row grid of labelled icon buttons
 *      with tooltips; each element type is added at the chosen position and
 *      the grid closes; keyboard: arrows move, Escape closes
 *   B  the value field is compact, grows with its text, and a ZIP list of
 *      hundreds of codes wraps inside the card — no horizontal page growth;
 *      the "stored as" preview is shortened with a "show all" control
 *   G  Auto type shows "Auto (detected: List of N items)"; a list under
 *      Integer says it is a list
 *   C  Insert Piped Text inserts at the cursor: an Embedded Data field, a
 *      question, a date with a format, a random integer; search; a loop
 *      source is disabled outside a loop
 *   E  Test Value resolves with sample data and warns for a missing field
 * RUNTIME  the preview (:3001) stores resolved values: TOTAL_CALORIES = 10,
 *      "Customer: Rahul", "Asha Rao", a ZIP list stays text
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const FIXTURE = () => ({
  meta: { id: "sandbox", code: "FLOWED", title: "Flow embedded data", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "NAME", type: "open_text", text: "Hello {{ed.GREETING}} — your name?" },
    { id: "q2", code: "Q2", variableName: "AGE", type: "numeric", text: "How old are you?" },
  ],
  flow: [
    { type: "embedded_data", id: "ed1", fields: [
      { name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" },
      { name: "CustomerName", source: "static", value: "Rahul", dataType: "auto" },
      { name: "TOTAL", source: "static", value: "", dataType: "auto" },
    ] },
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
});

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());
const goTab = async (n) => { await openTab(page, n); await page.waitForTimeout(200); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const readDef = async () => { await goTab("JSON"); await page.waitForSelector("textarea.code"); return JSON.parse(await page.$eval("textarea.code", (e) => e.value)); };
const toFlow = async () => { await goTab("Survey Flow"); await page.waitForSelector('[data-testid="flow-counts"]'); };
const ED_CARD = ".flow-card.element-card:has(.fn-type.embedded_data)";
const openEd = async () => {
  await page.waitForSelector(ED_CARD);
  if (!(await page.$('[data-testid="ed-field"]'))) await page.$eval(`${ED_CARD} .block-toggle`, (b) => b.click());
  await page.waitForSelector('[data-testid="ed-field"]');
};
const field = (i) => page.locator('[data-testid="ed-field"]').nth(i);
const edValue = (i) => field(i).locator('[data-testid="ed-value"]');

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");

/* ================================================== F. the Add Element grid */
{
  await loadDef(FIXTURE());
  await toFlow();
  await page.click('[data-testid="flow-insert"] >> nth=1'); // between ed1 and the block
  await page.waitForSelector('[data-testid="flow-insert-menu"]');
  assert.equal(await page.$('[data-testid="flow-insert-search"]'), null, "no search needed: every element is in view");
  const btns = page.locator('[data-testid="flow-insert-menu"] .add-el-btn');
  const n = await btns.count();
  assert.equal(n, 9, "Embedded data, Branch, Randomizer, Loop, Quota check, Redirect, End, Block, Group — none dropped");
  const boxes = await btns.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), icon: !!e.querySelector("svg.ico"), label: e.textContent.trim(), title: e.getAttribute("title") }; }));
  assert.equal(new Set(boxes.slice(0, 3).map((b) => b.top)).size, 1, "three on the first row");
  assert.ok(boxes[3].top > boxes[0].top, "the fourth starts the second row");
  assert.equal(new Set(boxes.map((b) => `${b.w}x${b.h}`)).size, 1, `consistent size: ${boxes.map((b) => `${b.w}x${b.h}`)}`);
  assert.ok(boxes.every((b) => b.icon && b.label && / — /.test(b.title)), "icon, label and a tooltip with the purpose");
  // keyboard: the first button has focus, arrows move, Escape closes
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "insert-branch");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "insert-quota_check");
  assert.match(await page.textContent('[data-testid="flow-insert-hint"]'), /Quota check — stop or flag/, "the focused element's purpose");
  // hovering shows the purpose under the grid too
  await btns.nth(2).hover();
  assert.match(await page.textContent('[data-testid="flow-insert-hint"]'), /Randomizer — shuffle what comes next/);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached" });
  ok("F: a 3-per-row grid of icon buttons, same size, tooltips with the purpose, keyboard and Escape");

  const expected = { embedded_data: "embedded_data", branch: "branch", randomizer: "randomizer", loop: "loop", quota_check: "quota_check", redirect: "redirect", end: "end", page: "page", section: "section" };
  for (const [type, nodeType] of Object.entries(expected)) {
    await loadDef(FIXTURE());
    await toFlow();
    await page.click('[data-testid="flow-insert"] >> nth=1');
    await page.waitForSelector('[data-testid="flow-insert-menu"]');
    await page.click(`[data-testid="insert-${type}"]`);
    await page.waitForSelector('[data-testid="flow-insert-menu"]', { state: "detached", timeout: 3000 });
    await page.waitForTimeout(300);
    const def = await readDef();
    assert.deepEqual([def.flow[0].id, def.flow[1].type, def.flow[2].id], ["ed1", nodeType, "p1"], `${type} is added between ed1 and the block`);
  }
  // the last one added was a Group; an Embedded Data element added the same way starts as Auto
  await loadDef(FIXTURE());
  await toFlow();
  await page.click('[data-testid="flow-insert"] >> nth=0');
  await page.click('[data-testid="insert-embedded_data"]');
  await page.waitForTimeout(300);
  assert.equal((await readDef()).flow[0].fields[0].dataType, "auto", "a new field defaults to Auto");
  ok("F: every element type is added at the chosen position and the grid closes");
}

/* ============================================ B + G. the compact value field */
{
  await loadDef(FIXTURE());
  await toFlow();
  await openEd();
  const w0 = (await edValue(0).boundingBox()).width;
  assert.ok(w0 < 220, `a short value (10) gets a compact field: ${w0}px`);
  await edValue(2).fill("Customer: {{ed.CustomerName}} and a longer sentence after it");
  await page.waitForTimeout(150);
  const w1 = (await edValue(2).boundingBox()).width;
  assert.ok(w1 > w0 + 150, `the field grows with its text: ${w0} → ${w1}`);

  const zips = Array.from({ length: 400 }, (_, i) => String(2000 + i)).join(", ");
  await edValue(1).fill(zips);
  await page.waitForTimeout(300);
  const lay = await page.evaluate(() => {
    const ta = document.querySelectorAll('[data-testid="ed-value"]')[1];
    const card = ta.closest('[data-testid="ed-field"]');
    const chip = card.querySelector('[data-testid="ed-preview"]');
    const r = ta.getBoundingClientRect(), c = card.getBoundingClientRect(), p = chip.getBoundingClientRect();
    return { taRight: r.right, taH: r.height, cardRight: c.right, chipRight: p.right, chipH: p.height,
      pageW: document.documentElement.scrollWidth, viewW: window.innerWidth, chip: chip.textContent };
  });
  assert.ok(lay.taRight <= lay.cardRight + 1, "the long list stays inside the card");
  assert.ok(lay.taH > 50 && lay.taH <= 190, `it wraps and grows downwards, then scrolls: ${lay.taH}px`);
  assert.ok(lay.chipRight <= lay.cardRight + 1 && lay.chipH < 120, `the preview does not stretch the layout (${lay.chipH}px)`);
  assert.ok(lay.pageW <= lay.viewW, `no horizontal page growth: ${lay.pageW} > ${lay.viewW}`);
  assert.match(lay.chip, /stored as list: "2000, 2001,.*…/, "shortened");
  await field(1).locator('[data-testid="ed-preview-expand"]').click();
  assert.ok((await field(1).locator('[data-testid="ed-preview"]').textContent()).includes("2399"), "show all reveals the full value");
  ok("B: compact by default, grows with content, a 400-code list wraps inside the card; preview shortened with show all");

  const selected = await field(1).locator('[data-testid="ed-type"] option:checked').textContent();
  assert.equal(selected, "Auto (detected: List of 400 items)");
  await edValue(1).fill("02108");
  await page.waitForTimeout(200);
  assert.equal(await field(1).locator('[data-testid="ed-type"] option:checked').textContent(), "Auto (detected: Text — leading zero kept)");
  assert.equal(await field(1).locator('[data-testid="ed-preview"]').textContent(), 'stored as string: "02108"', "02108 stays 02108");
  await edValue(1).fill("2000, 2001, 2002");
  await field(1).locator('[data-testid="ed-type"]').selectOption("integer");
  await page.waitForTimeout(200);
  assert.match(await field(1).locator('[data-testid="ed-preview"]').textContent(), /is a list of 3 items, not a single number — choose the Auto or List type/);
  ok("G: Auto shows what it detected (List of N), 02108 stays text, a list under Integer says so");
}

/* ======================================================= C. Insert Piped Text */
{
  await loadDef(FIXTURE());
  await toFlow();
  await openEd();
  const v = edValue(2);
  const openMenu = async () => {
    await field(2).locator('[data-testid="ed-insert-pipe"]').click();
    await page.waitForSelector('[data-testid="pipe-menu"]');
  };
  const pick = async (token) => { await page.click(`[data-testid="pipe-menu"] [data-testid="pipe-item"][data-token="${token}"]`); await page.waitForSelector('[data-testid="pipe-menu"]', { state: "detached" }); };

  // an Embedded Data field, at the end of what is typed
  await v.fill("Total: ");
  await v.press("End");
  await openMenu();
  assert.ok(await page.isDisabled('[data-testid="pipe-cat-loop"]'), "Loop & Merge is unavailable outside a loop");
  assert.match(await page.getAttribute('[data-testid="pipe-cat-loop"]', "title"), /not inside a loop/);
  await page.click('[data-testid="pipe-cat-embedded"]');
  await pick("{{ed.LOWCAL_1}}");
  assert.equal(await v.inputValue(), "Total: {{ed.LOWCAL_1}}");

  // a question, in the MIDDLE of the text: at the cursor
  await v.fill("AB");
  await v.evaluate((el) => { el.focus(); el.setSelectionRange(1, 1); });
  await openMenu();
  await page.click('[data-testid="pipe-cat-question"]');
  await page.click('[data-testid="pipe-menu"] [data-testid="pipe-item"] >> text=Q1');
  await page.waitForSelector('[data-testid="pipe-back"]');
  await pick("{{Q1}}");
  assert.equal(await v.inputValue(), "A{{Q1}}B", "inserted at the cursor, not appended");

  // back arrow and search
  await openMenu();
  await page.click('[data-testid="pipe-cat-datetime"]');
  await page.click('[data-testid="pipe-back"]');
  await page.waitForSelector('[data-testid="pipe-cat-datetime"]');
  await page.fill('[data-testid="pipe-search"]', "lowcal");
  await page.waitForSelector('[data-testid="pipe-item"][data-token="{{ed.LOWCAL_1}}"]');
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="pipe-menu"]', { state: "detached" });

  // a date with a format
  await v.fill("");
  await openMenu();
  await page.click('[data-testid="pipe-cat-datetime"]');
  await page.click('[data-testid="pipe-menu"] [data-testid="pipe-item"] >> text=Current date');
  await pick("{{date.today|fmt:DD/MM/YYYY}}");
  assert.equal(await v.inputValue(), "{{date.today|fmt:DD/MM/YYYY}}");

  // a random integer with its settings
  await v.fill("");
  await openMenu();
  await page.click('[data-testid="pipe-cat-random"]');
  await page.click('[data-testid="pipe-menu"] [data-testid="pipe-item"] >> text=Random whole number');
  await page.fill('[data-testid="pipe-random-min"]', "5");
  await page.fill('[data-testid="pipe-random-max"]', "9");
  assert.equal(await page.textContent('[data-testid="pipe-random-token"]'), "{{random.int(5,9)}}");
  await page.click('[data-testid="pipe-random-insert"]');
  await page.waitForSelector('[data-testid="pipe-menu"]', { state: "detached" });
  assert.equal(await v.inputValue(), "{{random.int(5,9)}}");
  await page.waitForTimeout(300);
  const def = await readDef();
  assert.equal(def.flow[0].fields[2].value, "{{random.int(5,9)}}", "saved in the definition");
  ok("C: Insert Piped Text inserts at the cursor — ED field, question, date with format, random integer; search, back, Escape");
}

/* ============================================================ E. Test Value */
{
  const d = FIXTURE();
  d.flow[0].fields[2] = { name: "GREETING", source: "static", value: "Customer: {{ed.CustomerName}} {{ed.FirstName}}", dataType: "auto" };
  await loadDef(d);
  await toFlow();
  await openEd();
  assert.match(await field(2).locator('[data-testid="ed-pipe-issue"]').first().textContent(), /Embedded Data field "FirstName" was not found\./, "the builder warns before testing");
  await field(2).locator('[data-testid="ed-test-value"]').click();
  const panel = field(2).locator('[data-testid="ed-test-panel"]');
  await panel.waitFor();
  assert.equal(await panel.locator('[data-testid="ed-test-sample-badge"]').textContent(), "sample test data");
  assert.equal(await panel.locator('[data-testid="ed-test-expression"]').textContent(), "Customer: {{ed.CustomerName}} {{ed.FirstName}}");
  assert.equal(await panel.locator('[data-testid="ed-test-resolved"]').textContent(), "Customer: Rahul ", "starts from CustomerName's own fixed value");
  await panel.locator('[data-testid="ed-test-input"][data-ref="CustomerName"]').fill("Asha");
  await page.waitForTimeout(150);
  assert.equal(await panel.locator('[data-testid="ed-test-resolved"]').textContent(), "Customer: Asha ");
  assert.match(await panel.locator('[data-testid="ed-test-stored"]').textContent(), /auto → string: "Customer: Asha "/);
  assert.match(await panel.locator('[data-testid="ed-test-warning"]').first().textContent(), /Embedded Data field "FirstName" was not found\./);
  ok("E: Test Value shows the expression and the resolved value from labelled sample data, and warns for a missing field");
}

/* ===================================================== RUNTIME (preview :3001) */
{
  const d = FIXTURE();
  d.flow[0].fields = [
    { name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" },
    { name: "TOTAL_CALORIES", source: "static", value: "{{ed.LOWCAL_1}}", dataType: "integer" },
    { name: "CustomerName", source: "static", value: "Rahul", dataType: "auto" },
    { name: "GREETING", source: "static", value: "Customer: {{ed.CustomerName}}", dataType: "auto" },
    { name: "FirstName", source: "static", value: "Asha", dataType: "auto" },
    { name: "LastName", source: "static", value: "Rao", dataType: "auto" },
    { name: "FULL_NAME", source: "static", value: "{{ed.FirstName}} {{ed.LastName}}", dataType: "auto" },
    { name: "ZIPS", source: "static", value: "02108, 10001, 90210", dataType: "auto" },
    { name: "DEVICE", source: "static", value: "{{device.type}}", dataType: "auto" },
    { name: "PICK", source: "static", value: "{{random.int(5,9)}}", dataType: "auto" },
  ];
  await loadDef(d);
  const def = await readDef(); // what the Studio saved
  const pv = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1100, height: 900 } });
  await pv.waitForFunction(() => window.__rescriptState?.embedded?.FULL_NAME !== undefined, null, { timeout: 15000 });
  const ed = await pv.evaluate(() => window.__rescriptState.embedded);
  assert.equal(ed.TOTAL_CALORIES, 10, "TOTAL_CALORIES takes LOWCAL_1's value, as an integer");
  assert.equal(ed.GREETING, "Customer: Rahul");
  assert.equal(ed.FULL_NAME, "Asha Rao", "chained values combine");
  assert.equal(ed.ZIPS, "02108, 10001, 90210", "a ZIP list stays text, leading zero kept");
  assert.equal(ed.DEVICE, "desktop", "the device as the browser reports it");
  assert.ok(ed.PICK >= 5 && ed.PICK <= 9, `random integer in range: ${ed.PICK}`);
  assert.match(await pv.textContent('[data-rs-el="question"][data-rs-id="q1"]'), /Hello Customer: Rahul — your name\?/, "and it pipes onward into question text");
  await pv.close();
  ok("RUNTIME: resolved values are stored — 10, Customer: Rahul, Asha Rao; a ZIP list stays text");
}

assert.deepEqual(pageErrors.filter((e) => !/401|402|422|501|Failed to load resource/.test(e)), [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
