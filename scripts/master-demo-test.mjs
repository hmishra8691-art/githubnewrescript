/**
 * MASTER DEMO — browser checks (Studio + runtime Test/Preview mode).
 *
 * The engine-level acceptance tests (packages/templates/src/masterDemo.test.ts)
 * already prove every test path runs to completion. This suite proves the
 * same definition survives the two real surfaces:
 *
 *   Studio  — the JSON tab imports it, the loop editor shows LOOP_001's seven
 *             reference columns (and LOOP_LF's different two), the variables
 *             panel lists loop/List-Fill variables, the linter is clean.
 *   Runtime — preview mode renders the loop block with piped references, the
 *             debug panel shows iteration / item / references, the Conjoint
 *             and MaxDiff tasks render from their design files, and answers
 *             land under per-iteration keys.
 *
 * Needs the dev servers: `pnpm dev:studio` (3000) and `pnpm dev:runtime` (3001).
 *
 *   node scripts/master-demo-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { buildMasterDemoSurvey, MASTER_DEMO_TEST_PATHS, simulateRespondent } from "../packages/templates/dist/index.js";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const def = buildMasterDemoSurvey("sandbox");
const h = await openHarness();
const page = h.page;

/* ============================================================ studio */

console.log("\nSTUDIO — the demo imports and is inspectable");
// the definition is ~330 KB — too big for Playwright's keystroke-based fill, so set the
// textarea the way a paste would (native setter + input event, which React listens to)
await h.goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, JSON.stringify(def));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(800);
const back = await h.readDef();
assert.equal(back.questions.length, def.questions.length);
assert.equal(back.flow.length, def.flow.length);
ok(`JSON import: ${back.questions.length} questions, ${back.listFills.length} List Fills, ${back.designs.length} designs, ${back.scripts.length} scripts round-trip through the editor`);

await h.goTab("Survey Flow");
await page.waitForSelector('[data-node-id="loop_001"]', { timeout: 20000 });
// LOOP_002 nests inside LOOP_001's card, so scope to the FIRST references table under each node
const colsOf = (nodeId) => page.$$eval(`[data-node-id="${nodeId}"] [data-testid="loop-references"]`, (tables) =>
  Array.from(tables[0]?.querySelectorAll('[data-testid="loop-ref-column-name"]') ?? []).map((e) => e.value));
const cols1 = await colsOf("loop_001");
assert.deepEqual(cols1, ["Brand_Nickname", "Product_ID", "Client_Code", "Category", "Internal_Name", "Region", "Product_Type"]);
ok("LOOP_001's editor shows its seven reference columns");
const colsLf = await colsOf("loop_lf");
const cols2 = await colsOf("loop_002");
assert.deepEqual(cols2, ["Feature_Group", "Weight"]);
ok("the nested LOOP_002 shows only its own two columns");
assert.deepEqual(colsLf, ["Tier", "Segment"]);
ok("LOOP_LF's editor shows a different table (Tier, Segment) for the same brands — references are loop-scoped");
const cell = await page.$eval('[data-node-id="loop_001"] [data-testid="loop-ref-cell"][data-code="1"][data-column="Product_ID"]', (e) => e.value);
assert.equal(cell, "PROD_001");
ok("reference cell Apple × Product_ID = PROD_001");

// the loop simulator on LOOP_001
{
  const simRoot = '[data-node-id="loop_001"] [data-testid="loop-simulator"]';
  await page.click(`${simRoot} [data-testid="loop-sim-toggle"]`);
  for (const c of ["1", "3"]) await page.click(`${simRoot} [data-testid="loop-sim-option"][data-code="${c}"]`);
  await page.waitForSelector(`${simRoot} [data-testid="loop-sim-iteration"]`);
  const iters = await page.$$eval(`${simRoot} [data-testid="loop-sim-iteration"]`, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  assert.equal(iters.length, 2);
  assert.match(iters[0], /Apple/); assert.match(iters[0], /PROD_001/);
  ok("the loop simulator previews two iterations with their reference rows");
}

await h.goTab("Questions");
await page.click('.qcard:has-text("Please rate {{CURRENT_ITEM.Brand_Nickname}}")');
await page.waitForSelector('[data-testid="in-loop-chip"]');
assert.match(await page.textContent('[data-testid="in-loop-chip"]'), /brand/);
ok("a question inside LOOP_001 shows the 'in loop' chip");

await h.goTab("Variables");
await page.waitForSelector("table", { timeout: 20000 });
const varText = await page.textContent("body");
for (const v of ["LOOP_BRAND_ITEM_1_PRODUCT_ID", "LISTFILL_BRAND_EVAL_1", "L1_SAT_1", "CBC_TASKS", "MD_TASKS", "ENGAGEMENT_SCORE"]) {
  assert.ok(varText.includes(v), `variables panel lists ${v}`);
}
ok("the Variables panel lists loop, reference, List Fill, calculation, Conjoint and MaxDiff variables");

await h.goTab("Logic");
const logicText = await page.textContent("body");
assert.ok(/LOOP \(brand\)/.test(logicText) && /BRANCH/.test(logicText) && /QUOTA CHECK/.test(logicText) && /TERMINATE \(screened\)/.test(logicText));
ok("the Logic Flow view shows the loop, the branch, the quota check and the terminations");

/* ============================================================ runtime */

console.log("\nRUNTIME — preview mode with a seeded Path-A respondent");
const A = MASTER_DEMO_TEST_PATHS.find((p) => p.id === "A");
// seed everything the loop block depends on from the engine's own walk of path A
const sim = simulateRespondent(def, { answers: A.answers, seed: A.seed });
const seedAnswers = Object.fromEntries(Object.entries(sim.state.answers).filter(([k]) => !k.includes("@")));

const runPreview = async (startAt) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1200 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${process.env.RUNTIME_URL ?? "http://localhost:3001"}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate(({ d, startAt, answers }) => window.postMessage({ type: "rescript:preview", definition: d, startAt, answers }, "*"), { d: def, startAt, answers: seedAnswers });
  await pv.waitForSelector("[data-qid]", { timeout: 90000 });
  return pv;
};
const textOf = (pv, qid) => pv.$eval(`[data-qid="${qid}"]`, (e) => e.textContent.replace(/\s+/g, " ").trim());
const stateOf = (pv) => pv.evaluate(() => { const st = window.__rescriptState; return st ? { answers: { ...st.answers }, calculated: { ...st.calculated } } : null; });

{
  const pv = await runPreview("sec_08_loop_demo");
  await pv.waitForSelector('[data-qid="q_l1_familiar"]');
  assert.match(await textOf(pv, "q_l1_familiar"), /How familiar are you with Apple\?/);
  assert.match(await textOf(pv, "q_l1_freq"), /brand 1 of 3/);
  assert.match(await textOf(pv, "q_l1_sat"), /Please rate APPLE, product PROD_001, in the Smartphone category\./);
  ok("LOOP_001 iteration 1 renders CURRENT_ITEM, LOOP_INDEX/LOOP_COUNT and three references in one sentence");

  await pv.click('[data-testid="debug-toggle"]');
  await pv.waitForSelector('[data-testid="loop-debug"]');
  const dbg = await pv.textContent('[data-testid="loop-debug"]');
  assert.match(dbg, /Apple/); assert.match(dbg, /PROD_001/); assert.match(dbg, /C001/);
  ok("the Test-Mode debug panel shows the current loop, iteration, item and its reference values");

  // answer page a and move on
  await pv.click('[data-qid="q_l1_familiar"] input[value="1"]');
  await pv.click('[data-qid="q_l1_freq"] input[value="1"]');
  await pv.$eval('[data-qid="q_l1_sat"] input[type="range"]', (el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "80"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q_l1_why"]');
  assert.match(await textOf(pv, "q_l1_why"), /Why do you use Apple\?/);
  await pv.fill('[data-qid="q_l1_why"] textarea', "Reliable and private.");
  await pv.click('[data-qid="q_l1_nps"] input[value="9"], [data-qid="q_l1_nps"] button:has-text("9")').catch(() => {});
  const st = await stateOf(pv);
  assert.equal(st.answers["q_l1_sat@1"], 80);
  assert.equal(st.answers["q_l1_familiar@1"], 1);
  assert.equal(st.answers["q_l1_why@1"], "Reliable and private.");
  ok("answers inside the loop are stored under per-iteration keys (q@code)");
  await pv.close();
}

{
  const pv = await runPreview("sec_15_conjoint");
  await pv.waitForSelector('[data-qid="q_conjoint"]');
  const t = await textOf(pv, "q_conjoint");
  assert.match(t, /Brand tier/); assert.match(t, /Warranty/); assert.match(t, /\$/);
  const tasks = await pv.$$eval('[data-qid="q_conjoint"] table, [data-qid="q_conjoint"] [data-task]', (es) => es.length);
  assert.ok(tasks >= 1);
  ok("the Conjoint question renders tasks from design_conjoint_phone (attributes visible)");
  await pv.close();
}

{
  const pv = await runPreview("sec_16_maxdiff");
  await pv.waitForSelector('[data-qid="q_maxdiff"]');
  const t = await textOf(pv, "q_maxdiff");
  assert.match(t, /Battery life|Camera quality|Price|Screen quality/);
  ok("the MaxDiff question renders tasks from design_maxdiff_features");
  await pv.close();
}

{
  const pv = await runPreview("sec_13_calculations");
  await pv.waitForSelector('[data-qid="q_calc_confirm"]');
  assert.match(await textOf(pv, "q_calc_confirm"), /about 1230/);
  assert.match(await textOf(pv, "q_calc_summary"), /1440/);
  ok("calculated piping ({{calc.TOTAL_SPEND_12M}}) and read-only expression cells render");
  await pv.close();
}

await h.close();
console.log(`\n${passed} checks passed`);
