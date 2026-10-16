/**
 * MATRIX ACCESSIBILITY (RUNTIME-09) + BACK SURVIVES A RELOAD (RUNTIME-06).
 *
 *   node scripts/matrix-a11y-test.mjs     (runtime :3001)
 *
 * RUNTIME-09: every grid control has an accessible name "<row>: <column>",
 * column headers carry scope="col", row labels are row headers, and the
 * role="radio" grids (Likert, Rating, Star) are radio groups for the keyboard:
 * one Tab stop per row, arrows move AND select within the row (wrapping),
 * Home/End jump, and nothing leaks into the next row.
 *
 * RUNTIME-06 (preview half — preview resume shares the Runner's checkpoint):
 * answer three pages, press Back, reload: the survey comes back on the page
 * the respondent went back to, not the furthest one reached.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const rows = [{ code: "r1", label: "Price" }, { code: "r2", label: "Quality" }];
const scale = [{ code: 1, label: "Poor" }, { code: 2, label: "Fair" }, { code: 3, label: "Good" }, { code: 4, label: "Great" }];
const base = (questions, flow) => ({
  meta: { id: `a11y-${Math.random().toString(36).slice(2, 8)}`, code: "A11Y", title: "Matrix a11y", version: "1.0", schemaVersion: 1, status: "draft" },
  questions,
  flow: flow ?? [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const grid = (id, type, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: `Rate ${id}`, rows, options: scale, ...extra });

const browser = await chromium.launch();
const open = async (def, selector = "[data-qid]") => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector });
  return { page, errs };
};

console.log("\nRUNTIME-09 — default matrix");
{
  const { page, errs } = await open(base([grid("m1", "matrix_single"), grid("m2", "matrix_multi"),
    { ...grid("m3", "matrix_numeric"), columns: [{ id: "c1", label: "Amount", responseType: "numeric", variableStem: "M3" }] }]), '[data-qid="m1"]');
  const names = await page.$$eval('[data-qid="m1"] input[type=radio]', (els) => els.map((e) => e.getAttribute("aria-label")));
  assert.deepEqual(names.slice(0, 4), ["Price: Poor", "Price: Fair", "Price: Good", "Price: Great"]);
  assert.equal(names[4], "Quality: Poor");
  ok("matrix_single radios are named \"<row>: <column>\"");
  const multi = await page.$$eval('[data-qid="m2"] input[type=checkbox]', (els) => els.map((e) => e.getAttribute("aria-label")));
  assert.equal(multi[0], "Price: Poor");
  ok("matrix_multi checkboxes are named");
  const scopes = await page.$$eval('[data-qid="m1"] thead th:not(.rowlabel)', (els) => els.map((e) => e.getAttribute("scope")));
  assert.ok(scopes.length === 4 && scopes.every((s) => s === "col"), JSON.stringify(scopes));
  const rh = await page.$$eval('[data-qid="m1"] tbody tr:not(.rs-header-repeat) > .rowlabel', (els) => els.map((e) => e.getAttribute("role") ?? (e.tagName === "TH" ? e.getAttribute("scope") : null)));
  assert.ok(rh.length === 2 && rh.every((r) => r === "rowheader" || r === "row"), JSON.stringify(rh));
  ok("column headers scope=col, row labels are row headers");
  const num = await page.$$eval('[data-qid="m3"] input', (els) => els.map((e) => e.getAttribute("aria-label")));
  assert.equal(num[0], "Price: Amount");
  ok("numeric matrix inputs are named \"<row>: <column>\"");
  // a native radio group: the browser's own arrow keys move within the row
  await page.focus('[data-qid="m1"] input[aria-label="Price: Poor"]');
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.$eval('[data-qid="m1"] input[aria-label="Price: Fair"]', (e) => e.checked), true);
  assert.equal(await page.$eval('[data-qid="m1"] input[aria-label="Quality: Poor"]', (e) => e.checked), false);
  ok("arrow keys move within a native matrix row only");
  assert.deepEqual(errs, []);
  await page.close();
}

for (const variant of ["matrix.likert", "matrix.rating"]) {
  console.log(`\nRUNTIME-09 — ${variant} (role=radio)`);
  const { page, errs } = await open(base([grid("q1", "matrix_single", { variant })]), '[data-qid="q1"] [role="radio"]');
  const sel = (row, col) => `[data-qid="q1"] [role="radio"][aria-label="${row}: ${col}"]`;
  const checked = (row, col) => page.$eval(sel(row, col), (e) => e.getAttribute("aria-checked"));
  const tabStops = await page.$$eval('[data-qid="q1"] [role="radio"]', (els) => els.filter((e) => e.tabIndex === 0).length);
  assert.equal(tabStops, 2, "one Tab stop per row");
  ok("one Tab stop per row (roving tabindex)");
  const scopes = await page.$$eval('[data-qid="q1"] thead th:not(.rowlabel)', (els) => els.map((e) => e.getAttribute("scope")));
  assert.ok(scopes.every((s) => s === "col"));
  ok("headers scope=col");
  await page.focus(sel("Price", "Poor"));
  await page.keyboard.press("ArrowRight");
  assert.equal(await checked("Price", "Fair"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Price: Fair");
  ok("ArrowRight moves focus and selects");
  await page.keyboard.press("End");
  assert.equal(await checked("Price", "Great"), "true");
  await page.keyboard.press("ArrowRight");
  assert.equal(await checked("Price", "Poor"), "true", "wraps to the first");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await checked("Price", "Great"), "true", "wraps to the last");
  await page.keyboard.press("Home");
  assert.equal(await checked("Price", "Poor"), "true");
  ok("End / Home / wrapping");
  for (const c of scale) assert.equal(await checked("Quality", c.label), "false");
  ok("the next row is untouched");
  const stopNow = await page.$eval(sel("Price", "Poor"), (e) => e.tabIndex);
  assert.equal(stopNow, 0, "the checked radio is the row's Tab stop");
  ok("the checked radio carries the Tab stop");
  assert.deepEqual(errs, []);
  await page.close();
}

console.log("\nRUNTIME-09 — starmatrix");
{
  const { page, errs } = await open(base([{ id: "q1", code: "Q1", variableName: "Q1", type: "matrix_numeric", variant: "matrix.star_matrix", text: "Stars", rows, settings: { minValue: 1, maxValue: 5 } }]), '[data-qid="q1"] [role="radio"]');
  await page.focus('[data-qid="q1"] [aria-label="Price: 1 of 5"]');
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.$eval('[data-qid="q1"] [aria-label="Price: 2 of 5"]', (e) => e.getAttribute("aria-checked")), "true");
  ok("arrow keys rate within a star row");
  assert.deepEqual(errs, []);
  await page.close();
}

console.log("\nRUNTIME-06 — Back then reload resumes on the page gone back to (preview)");
{
  const one = (id, label) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: label, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] });
  const def = base([one("q1", "One"), one("q2", "Two"), one("q3", "Three")], [
    { type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] }, { type: "end", id: "e1", status: "complete" },
  ]);
  const { page, errs } = await open(def, '[data-qid="q1"]');
  for (const q of ["q1", "q2"]) {
    await page.click(`[data-qid="${q}"] label:has-text("Yes")`);
    await page.click('[data-testid="rs-next"]');
  }
  await page.waitForSelector('[data-qid="q3"]');
  await page.click('[data-testid="rs-back"]');
  await page.waitForSelector('[data-qid="q2"]');
  await page.reload({ waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: "[data-qid]" });
  assert.ok(await page.$('[data-qid="q2"]'), `expected page 2 after reload, got ${await page.$$eval("[data-qid]", (e) => e.map((x) => x.getAttribute("data-qid")))}`);
  ok("reload after Back lands on page 2, not page 3");
  assert.deepEqual(errs, []);
  await page.close();
}

await browser.close();
console.log(`\n${passed} passed`);
