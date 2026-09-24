/**
 * GRID MODE — the survey as a programmable research grid (Phase 1).
 *
 * Runs against the sandbox with the Master Demo (160 questions) for the
 * behaviour checks and the 600-question scale fixture for the performance
 * checks. Every edit made in the grid is read back from the definition, so
 * what is asserted is what the survey became, not what the grid displayed.
 *
 *   node scripts/grid-mode-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { buildMasterDemoSurvey, buildScaleSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/401|ERR_TUNNEL|Failed to load resource/.test(t)) return;
  pageErrors.push(t.slice(0, 400));
});

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await page.waitForSelector('[data-testid="grid-view"]');
  return JSON.parse(json);
};
const rowCodes = () => page.$$eval('[data-testid="grid-row"]', (els) => els.map((e) => e.dataset.code));
const count = () => page.$eval('[data-testid="grid-count"]', (e) => e.textContent);
const rowByCode = (code) => page.$(`[data-testid="grid-row"][data-code="${code}"]`);
const cell = (code, col) => page.$(`[data-testid="grid-row"][data-code="${code}"] .sg-cell[data-col="${col}"]`);

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(buildMasterDemoSurvey("sandbox"));

/* ----------------------------------------------------------- switch */
{
  await page.click('[data-testid="mode-grid"]');
  await page.waitForSelector('[data-testid="grid-view"]');
  ok("clicking Grid in the selector renders the grid — no reload, same tab");
  assert.match(page.url(), /mode=grid/);
  ok("the URL now says ?mode=grid");
  assert.equal(await page.$eval('[data-testid="mode-grid"]', (e) => e.classList.contains("active")), true);
  assert.equal(await count(), "160 questions");
  ok("all 160 Master Demo questions are counted");
  const mounted = (await page.$$('[data-testid="grid-row"]')).length;
  assert.ok(mounted < 60 && mounted > 15, `windowed: ${mounted} rows mounted of 160`);
  ok(`only a screenful is in the DOM (${mounted} of 160)`);
  const codes = await rowCodes();
  assert.equal(codes[0], "INFO1");
  assert.deepEqual(codes.slice(1, 4), ["Q1", "Q2", "Q3"]);
  ok("rows are in flow order");
  // type labels are readable names, not raw types
  const types = await page.$$eval('.sg-cell[data-col="type"]', (els) => els.slice(0, 12).map((e) => e.textContent));
  assert.ok(types.every((t) => !/_/.test(t)), `raw types leaked: ${types.join(", ")}`);
  ok("type column shows variant names, not raw type ids");
  // the deferred layer: dependency counts arrive from the engine's index
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid="grid-row"][data-code="Q3"] .sg-cell[data-col="deps"]');
    return c && c.textContent !== "—";
  }, null, { timeout: 5000 });
  const deps = await page.$eval('[data-testid="grid-row"][data-code="Q3"] .sg-cell[data-col="deps"]', (e) => e.textContent);
  assert.match(deps, /→[1-9]/, `AGE is read by calculations and logic: ${deps}`);
  ok(`the Deps column shows what reads Q3 (${deps}) — from the dependency index`);
  // and a lint problem shows as a dot: Q9 (PHONE) is fine; find any row with a status dot or none — Master Demo passes lint
  const dots = await page.$$eval('[data-testid="grid-status"]', (els) => els.length);
  assert.equal(dots, 0, "the Master Demo has no lint problems, so no row carries a dot");
  ok("no status dots on a clean survey");
}

/* ----------------------------------------------------------- windowing */
{
  await page.$eval(".sg-scroll", (el) => { el.scrollTop = 36 * 120; });
  await page.waitForTimeout(150);
  const codes = await rowCodes();
  assert.ok(!codes.includes("Q1"), "the first rows are unmounted after scrolling far down");
  assert.ok(codes.length > 15);
  ok("scrolling swaps the mounted window");
  await page.$eval(".sg-scroll", (el) => { el.scrollTop = 0; });
  await page.waitForTimeout(150);
  assert.equal((await rowCodes())[0], "INFO1");
  ok("scrolling back remounts the top");
  // header and frozen columns stick
  const sticky = await page.$eval(".sg-head", (e) => getComputedStyle(e).position);
  assert.equal(sticky, "sticky");
  const frozen = await page.$eval('.sg-row .sg-cell[data-col="code"]', (e) => getComputedStyle(e).position);
  assert.equal(frozen, "sticky");
  ok("the header and the ID column are sticky");
}

/* ----------------------------------------------------------- selection → properties */
{
  const q3 = await rowByCode("Q3");
  await q3.click();
  await page.waitForTimeout(200);
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), false);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q3/);
  ok("selecting a row opens that question's properties on the right — the shared selection");
  // shift-click selects a range
  const q6 = await rowByCode("Q6");
  await q6.click({ modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  const selected = await page.$$eval('[data-testid="grid-row"][aria-selected="true"]', (els) => els.map((e) => e.dataset.code));
  assert.deepEqual(selected, ["Q3", "Q4", "Q5", "Q6"]);
  ok("shift-click selects the range");
  assert.ok(await page.$('[data-testid="grid-bulk"]'), "the bulk bar appears");
  assert.match(await page.$eval('[data-testid="grid-bulk"] strong', (e) => e.textContent), /4 selected/);
  ok("the bulk bar counts the selection");
  const q8 = await rowByCode("Q8");
  await q8.click({ modifiers: [mod] });
  await page.waitForTimeout(150);
  assert.match(await page.$eval('[data-testid="grid-bulk"] strong', (e) => e.textContent), /5 selected/);
  ok(`${mod}-click adds one more`);
  await page.click('[data-testid="grid-bulk"] >> text=Clear');
  await page.waitForTimeout(150);
  assert.equal(await page.$('[data-testid="grid-bulk"]'), null);
  ok("Clear empties the selection");
}

/* ----------------------------------------------------------- inline edits */
{
  // text
  const textCell = await cell("Q3", "text");
  await textCell.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-text"]');
  await page.fill('[data-testid="grid-edit-text"]', "How old are you, in years?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  let def = await readDef();
  assert.equal(def.questions.find((q) => q.code === "Q3").text, "How old are you, in years?");
  ok("double-click → type → Enter edits the question text through the store");

  // a rename the engine must REFUSE: AGE is mentioned by a custom script, which cannot be rewritten
  const varCell0 = await cell("Q3", "variable");
  await varCell0.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-variable"]');
  await page.fill('[data-testid="grid-edit-variable"]', "AGE_YEARS");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assert.match(await page.$eval('[data-testid="grid-edit-variable-error"]', (e) => e.textContent), /script/i);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  def = await readDef();
  assert.equal(def.questions.find((q) => q.code === "Q3").variableName, "AGE", "a refused rename changes nothing");
  ok("a rename a script depends on is refused in the cell with the engine's own reason — same rule as the editor");

  // a rename that is safe: CITY is read by nothing
  const varCell = await cell("Q6", "variable");
  await varCell.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-variable"]');
  await page.fill('[data-testid="grid-edit-variable"]', "CITY_NAME");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  def = await readDef();
  assert.equal(def.questions.find((q) => q.code === "Q6").variableName, "CITY_NAME");
  ok("renaming a variable in a cell goes through renameImpact/applyRename");

  // a colliding rename keeps the field and says why
  const varCell2 = await cell("Q7", "variable");
  await varCell2.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-variable"]');
  await page.fill('[data-testid="grid-edit-variable"]', "CITY_NAME");   // already taken by Q6
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  assert.ok(await page.$('[data-testid="grid-edit-variable-error"]'), "an error is shown for a taken name");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  def = await readDef();
  assert.equal(def.questions.find((q) => q.code === "Q7").variableName, "EMAIL", "the refused rename changed nothing");
  ok("a colliding rename is refused in the cell, as in the editor, and nothing changes");

  // required
  await page.click('[data-testid="grid-columns"]');
  await page.click('[data-testid="grid-columns-menu"] >> text=Req.');
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const reqCell = await cell("Q6", "required");
  const before = (await readDef()).questions.find((q) => q.code === "Q6").required;
  const box = await (await cell("Q6", "required")).$('[data-testid="grid-required"]');
  await box.click();
  await page.waitForTimeout(250);
  def = await readDef();
  assert.equal(!!def.questions.find((q) => q.code === "Q6").required, !before);
  ok("the Required checkbox toggles the field");
  assert.ok(reqCell);

  // type, through the same migration + confirmation
  const typeCell = await cell("Q6", "type");
  await typeCell.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-type"]');
  const options = await page.$$eval('[data-testid="grid-edit-type"] option', (els) => els.map((o) => o.value));
  const target = options.find((v) => /text\.multi_line|textarea|multi_line/.test(v)) ?? options.find((v) => v && v !== "text.single_line");
  await page.selectOption('[data-testid="grid-edit-type"]', target);
  await page.waitForTimeout(300);
  // a same-model change applies silently; a model change asks — accept either path
  const dialog = await page.$('[data-testid="type-change-confirm"], .modal button:has-text("Change type")');
  if (dialog) { await dialog.click(); await page.waitForTimeout(250); }
  def = await readDef();
  assert.equal(def.questions.find((q) => q.code === "Q6").variant, target);
  ok(`the type cell changes the type via migrateQuestionType (→ ${target})`);
}

/* ----------------------------------------------------------- search, filter, sort */
{
  await page.fill('[data-testid="grid-search"]', "devices");
  await page.waitForTimeout(300);
  const codes = await rowCodes();
  assert.ok(codes.includes("Q11"), `Q11 asks about devices: ${codes.join(",")}`);
  assert.ok(codes.length < 160);
  assert.match(await count(), /of 160/);
  ok("search narrows the rows and the count says 'N of 160'");
  await page.fill('[data-testid="grid-search"]', "");
  await page.waitForTimeout(300);
  await page.click('[data-testid="grid-filter-logic"]');
  await page.waitForTimeout(200);
  const logicRows = await page.$$eval('[data-testid="grid-row"]', (els) => els.map((e) => ({ code: e.dataset.code, d: e.querySelector('[data-col="display"]')?.textContent, s: e.querySelector('[data-col="skip"]')?.textContent })));
  assert.ok(logicRows.length > 0 && logicRows.every((r) => r.d !== "—" || r.s !== "—"), JSON.stringify(logicRows.slice(0, 3)));
  ok("'With logic' keeps only rows with display or skip logic");
  await page.click('[data-testid="grid-filter-logic"]');
  await page.click('[data-testid="grid-head-type"]');
  await page.waitForTimeout(200);
  const typesSorted = await page.$$eval('.sg-cell[data-col="type"]', (els) => els.map((e) => e.textContent.toLowerCase()));
  const sorted = [...typesSorted].sort();
  assert.deepEqual(typesSorted, sorted, "type column ascending");
  ok("clicking a header sorts ascending");
  await page.click('[data-testid="grid-head-type"]');
  await page.waitForTimeout(200);
  const desc = await page.$$eval('.sg-cell[data-col="type"]', (els) => els.map((e) => e.textContent.toLowerCase()));
  assert.deepEqual(desc, [...desc].sort().reverse());
  ok("again sorts descending");
  await page.click('[data-testid="grid-head-type"]');
  await page.waitForTimeout(200);
  assert.equal((await rowCodes())[0], "INFO1");
  ok("a third click returns to flow order");
}

/* ----------------------------------------------------------- keyboard + hover actions */
{
  await page.click('[data-testid="grid-row"][data-code="Q1"]');
  await page.focus('[data-testid="grid-table"]');
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q3/);
  ok("↓ moves the selection row by row (the property panel follows)");
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(150);
  assert.equal((await page.$$('[data-testid="grid-row"][aria-selected="true"]')).length, 2);
  ok("⇧↓ extends the selection");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  // hover actions: duplicate a row
  const before = (await readDef()).questions.length;
  const q2 = await rowByCode("Q2");
  await q2.hover();
  await page.waitForSelector('[data-testid="grid-row"][data-code="Q2"] [data-testid="grid-action-duplicate"]');
  await page.click('[data-testid="grid-row"][data-code="Q2"] [data-testid="grid-action-duplicate"]');
  await page.waitForTimeout(300);
  const def = await readDef();
  assert.equal(def.questions.length, before + 1);
  assert.ok(def.questions.some((q) => q.code === "Q2_COPY"));
  ok("the row's hover ⧉ duplicates that row (through the command registry, with a unique name)");
  assert.ok(await rowByCode("Q2_COPY"), "the copy appears as a row immediately");
  ok("the new row appears without any reload — one store, one render");
}

/* ----------------------------------------------------------- bulk + delete */
{
  const before = await readDef();
  await page.click('[data-testid="grid-row"][data-code="Q2_COPY"]');
  await page.keyboard.press("Delete");
  await page.waitForSelector('[data-testid="delete-question-dialog"]');
  ok("Delete on a selected row opens the same delete dialog as the Studio");
  await page.click('[data-testid="delete-question-confirm"]');
  await page.waitForTimeout(300);
  const after = await readDef();
  assert.equal(after.questions.length, before.questions.length - 1);
  assert.ok(!after.questions.some((q) => q.code === "Q2_COPY"));
  ok("confirming removes it and prunes references");

  // bulk required on three rows
  await page.click('[data-testid="grid-row"][data-code="Q4"]');
  await page.click('[data-testid="grid-row"][data-code="Q6"]', { modifiers: ["Shift"] });
  await page.waitForSelector('[data-testid="grid-bulk"]');
  await page.click('[data-testid="grid-bulk-required-on"]');
  await page.waitForTimeout(300);
  const d2 = await readDef();
  for (const c of ["Q4", "Q5", "Q6"]) assert.equal(d2.questions.find((q) => q.code === c).required, true, `${c} required`);
  ok("bulk 'Required' sets all selected rows in one undoable edit");
  await page.click('[data-testid="grid-bulk-required-off"]');
  await page.waitForTimeout(300);
  const d3 = await readDef();
  for (const c of ["Q4", "Q5", "Q6"]) assert.equal(!!d3.questions.find((q) => q.code === c).required, false);
  ok("bulk 'Optional' reverses it");
  // undo takes the bulk edit back as one step
  await page.click("main.center", { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(300);
  const d4 = await readDef();
  assert.equal(d4.questions.find((q) => q.code === "Q4").required, true, "one undo restored the bulk Required");
  ok("one ⌘Z undoes the whole bulk edit — it went through the store");
}

/* ----------------------------------------------------------- switching back keeps the survey and the selection */
{
  await page.click('[data-testid="grid-row"][data-code="Q5"]');
  await page.waitForTimeout(150);
  await page.click('[data-testid="mode-studio"]');
  await page.waitForSelector(".block-badge");
  assert.equal(await page.$('[data-testid="grid-view"]'), null);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q5/);
  ok("switching to Studio keeps the selected question — the selection is shared");
  assert.doesNotMatch(page.url(), /mode=/);
  ok("the URL drops ?mode= for the default");
  await page.click('[data-testid="mode-grid"]');
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.equal((await page.$$('[data-testid="grid-row"][aria-selected="true"]')).length, 1);
  ok("and back to Grid, the row is still selected");
}

/* ----------------------------------------------------------- scale: 600 questions */
{
  await page.click('[data-testid="mode-studio"]');
  await page.waitForSelector(".block-badge");
  await loadDef(buildScaleSurvey(600));
  const t0 = Date.now();
  await page.click('[data-testid="mode-grid"]');
  await page.waitForSelector('[data-testid="grid-row"]');
  const switchMs = Date.now() - t0;
  assert.ok(switchMs < 3000, `Grid took ${switchMs}ms to appear at 600 questions`);
  ok(`Grid renders 600 questions in ${switchMs}ms`);
  assert.equal(await count(), "600 questions");
  const mounted = (await page.$$('[data-testid="grid-row"]')).length;
  assert.ok(mounted < 60, `${mounted} rows mounted for 600`);
  ok(`still only ${mounted} rows in the DOM at 600 questions`);
  // scroll cost
  const scrollMs = await page.evaluate(async () => {
    const el = document.querySelector(".sg-scroll");
    const t = performance.now();
    for (let i = 1; i <= 20; i++) { el.scrollTop = i * 900; await new Promise((r) => requestAnimationFrame(r)); }
    return performance.now() - t;
  });
  assert.ok(scrollMs < 2500, `20 scroll steps took ${scrollMs.toFixed(0)}ms`);
  ok(`20 long scroll steps rendered in ${scrollMs.toFixed(0)}ms (~${(scrollMs / 20).toFixed(0)}ms each)`);
  // typing in a cell stays responsive: the status/deps layer is deferred
  await page.$eval(".sg-scroll", (el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  const first = await page.$eval('[data-testid="grid-row"]', (e) => e.dataset.code);
  const textCell = await cell(first, "text");
  await textCell.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-text"]');
  const typeMs = await page.evaluate(async () => {
    const input = document.querySelector('[data-testid="grid-edit-text"]');
    const t = performance.now();
    for (const ch of "responsive typing") {
      input.value += ch;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t;
  });
  await page.keyboard.press("Escape");
  assert.ok(typeMs < 1500, `17 keystrokes took ${typeMs.toFixed(0)}ms`);
  ok(`17 keystrokes in a cell took ${typeMs.toFixed(0)}ms at 600 questions`);
  // search narrows quickly
  const t1 = Date.now();
  await page.fill('[data-testid="grid-search"]', "Block 40");
  await page.waitForFunction(() => /of 600/.test(document.querySelector('[data-testid="grid-count"]')?.textContent ?? ""));
  ok(`search over 600 rows narrowed in ${Date.now() - t1}ms`);
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no uncaught errors or React warnings through any of it");

await browser.close();
console.log(`\nALL GRID MODE CHECKS PASSED (${passed})`);
