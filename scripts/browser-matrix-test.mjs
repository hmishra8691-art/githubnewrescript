/**
 * THE RESPONDENT PATH ON EVERY BROWSER (audit 2026-11-17, P1-04).
 *
 * One representative interview, walked the way a respondent walks it, on each engine and on phone-sized screens:
 *   required single choice refused when empty · numeric out of range refused · multi choice · grid · Back keeps
 *   every answer · open text · the end screen.
 *
 *   node scripts/browser-matrix-test.mjs                         chromium, desktop + two phones (emulated)
 *   BROWSERS=chromium,firefox,webkit node scripts/browser-matrix-test.mjs   (CI: .github/workflows/browser-matrix.yml)
 *   RUNTIME_URL=http://localhost:3001 (default)
 *
 * A browser whose build is not installed is reported and skipped locally; with REQUIRE_ALL_BROWSERS=1 (CI) it fails.
 */
import assert from "node:assert/strict";
import * as pw from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const BROWSERS = (process.env.BROWSERS ?? "chromium").split(",").map((s) => s.trim()).filter(Boolean);
const REQUIRE_ALL = process.env.REQUIRE_ALL_BROWSERS === "1";

const def = {
  meta: { id: "bm", code: "BM", title: "Browser matrix", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How often do you shop online?", required: true, options: [{ code: 1, label: "Weekly" }, { code: 2, label: "Monthly" }, { code: 3, label: "Rarely" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "How many orders last month?", required: true, validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 50 }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Which devices do you use?", required: true, options: [{ code: 1, label: "Phone" }, { code: 2, label: "Laptop" }, { code: 3, label: "Tablet" }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "matrix_single", text: "Rate each", required: true, rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Delivery" }], options: [{ code: 1, label: "Poor" }, { code: 2, label: "Good" }] },
    { id: "q5", code: "Q5", variableName: "Q5", type: "open_text", text: "Anything else?", required: false },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"] },
    { type: "page", id: "p3", questionIds: ["q5"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const SCREENS = [
  { name: "desktop", context: { viewport: { width: 1280, height: 900 } } },
  { name: "phone (iPhone 13)", device: "iPhone 13" },
  { name: "phone (Pixel 5)", device: "Pixel 5" },
];

let passed = 0, skipped = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

async function walk(page, label) {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: '[data-qid="q1"]' });
  const next = page.locator('[data-testid="rs-next"]');
  /* 1. nothing answered: Next is refused with a message, and we stay on page 1 */
  await next.click();
  await page.waitForSelector('[role="alert"], .rs-error-msg, [data-testid="rs-error-banner"]', { timeout: 8000 });
  assert.ok(await page.locator('[data-qid="q1"]').isVisible(), `${label}: still on page 1`);
  /* 2. numeric out of range refused */
  await page.locator('[data-qid="q1"] label', { hasText: "Monthly" }).click();
  const num = page.locator('[data-qid="q2"] input').first();
  await num.fill("99");
  await next.click();
  await page.waitForTimeout(400);
  assert.ok(await page.locator('[data-qid="q2"]').isVisible(), `${label}: 99 is above the maximum, so page 1 stays`);
  await num.fill("7");
  await next.click();
  await page.waitForSelector('[data-qid="q3"]', { timeout: 10000 });
  /* 3. multi choice and a grid */
  await page.locator('[data-qid="q3"] label', { hasText: "Phone" }).click();
  await page.locator('[data-qid="q3"] label', { hasText: "Tablet" }).click();
  for (const row of ["r1", "r2"]) {
    const radio = page.locator(`[data-qid="q4"] input[type="radio"][name*="${row}"]`).last();
    if (await radio.count()) await radio.check({ force: true });
  }
  if (await page.locator('[data-qid="q4"] input[type="radio"]:checked').count() < 2) {
    /* a layout without row-named inputs (cards on a phone): pick the last choice in each row group */
    const groups = page.locator('[data-qid="q4"] [role="radiogroup"]');
    for (let i = 0; i < await groups.count(); i++) await groups.nth(i).locator('[role="radio"], label').last().click();
  }
  /* 4. Back keeps page 1's answers */
  await page.locator('[data-testid="rs-back"]').click();
  await page.waitForSelector('[data-qid="q1"]', { timeout: 10000 });
  assert.equal(await page.locator('[data-qid="q2"] input').first().inputValue(), "7", `${label}: the number survives Back`);
  assert.ok(await page.locator('[data-qid="q1"] input[type="radio"]:checked').count() === 1, `${label}: the choice survives Back`);
  await next.click();
  await page.waitForSelector('[data-qid="q3"]', { timeout: 10000 });
  assert.equal(await page.locator('[data-qid="q3"] input[type="checkbox"]:checked').count(), 2, `${label}: page 2's answers survive Back and Next`);
  await next.click();
  await page.waitForSelector('[data-qid="q5"]', { timeout: 10000 });
  /* 5. open text, then the end */
  await page.locator('[data-qid="q5"] textarea, [data-qid="q5"] input').first().fill("Faster delivery, please — and “quotes” & accents: café");
  await next.click();
  await page.waitForSelector('[data-testid="rs-ended"]', { timeout: 10000 });
}

for (const name of BROWSERS) {
  const type = pw[name];
  if (!type) { console.log(`  skip ${name}: not a Playwright browser`); skipped++; continue; }
  let browser;
  try { browser = await type.launch(); }
  catch (e) {
    const msg = String(e.message ?? e).split("\n")[0];
    if (REQUIRE_ALL) throw new Error(`${name} could not launch: ${msg}`);
    console.log(`  skip ${name}: not installed here (${msg.slice(0, 120)})`); skipped++; continue;
  }
  console.log(`\n${name.toUpperCase()}`);
  for (const s of SCREENS) {
    /* phone descriptors carry isMobile / hasTouch, which Firefox does not support: there it gets the viewport only */
    const d = s.device ? pw.devices?.[s.device] : null;
    const opts = s.context ?? (d ? (name === "firefox" ? { viewport: d.viewport, userAgent: d.userAgent } : d) : { viewport: { width: 390, height: 844 } });
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await walk(page, `${name} ${s.name}`);
    assert.deepEqual(errs, [], `${name} ${s.name}: no uncaught page errors`);
    ok(`${name} · ${s.name}: required refused, range refused, multi + grid, Back keeps answers, open text, end screen`);
    await ctx.close();
  }
  await browser.close();
}
console.log(`\nBROWSER MATRIX: ${passed} checks passed${skipped ? `, ${skipped} browser(s) skipped` : ""}`);
if (!passed) process.exit(1);
