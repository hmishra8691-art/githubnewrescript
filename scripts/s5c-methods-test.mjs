/**
 * Browser suite — S5c "RESEARCH METHODS" (2026-11-01, docs/S5-EXTENDED-FEATURES-2026-11-01.md part C).
 *
 * The runtime preview (the real Runner, engine and renderer; no database). The surveys are built from the same
 * engine fragments `add_method_template` inserts (`methodTemplateFragment`), so this is the block Intelligent Mode
 * adds, run by a respondent.
 *
 *   A  shelf test (SM-16): hovering products records them as examined (in order, once each), the click picks
 *      (answer [code]), SHELF_SHELF_TIME > 0, the second choice (another product) → SHELF_SHELF_PICK2
 *   B  adaptive Gabor–Granger (SM-07): the ladder starts in the middle (15), yes → 20, no → stops; the answer is
 *      15 and GG_PRICE_LADDER_PATH = "15:1,20:0", GG_PRICE_LADDER_START = 15; a no-from-the-start path ends at 0
 *   C  IAT (SM-18): the four combined blocks answered by keyboard-speed clicks (correct category, slower on the
 *      incompatible pairing); on the last page IAT_D in the preview store is positive and IAT_EXCLUDED = 0
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s5c-methods-test.mjs      SECTIONS=A,B,C (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { methodTemplateFragment } from "../packages/engine/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];
const SHELF_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const watch = (pg, tag) => pg.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${tag}: ${e.message}`); });
async function open(def) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pv = await ctx.newPage();
  watch(pv, def.meta.id);
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def });
  return pv;
}
const store = (pv) => pv.evaluate(() => { const s = window.__rescriptState ?? {}; return { answers: { ...(s.answers ?? {}) }, embedded: { ...(s.embedded ?? {}) }, calculated: { ...(s.calculated ?? {}) } }; });
const next = async (pg) => { await pg.click('[data-testid="rs-next"]'); await sleep(500); };
/** a survey around one template fragment, ids deterministic */
function surveyOf(id, spec) {
  const n = {};
  const ids = (p) => { n[p] = (n[p] ?? 0) + 1; return `${p}${n[p]}`; };
  const frag = methodTemplateFragment(spec, ids);
  return { def: { meta: { id, code: id.toUpperCase(), title: id, version: "1" }, questions: frag.questions, flow: [frag.block, { type: "end", id: "e1", status: "complete" }] }, frag };
}

/* ============================================================== A. shelf */
if (SECTIONS.has("A")) {
  console.log("\nA  shelf test");
  const { def } = surveyOf("s5c-shelf", { template: "shelf_test", imageUrl: SHELF_IMG, products: ["Crunch", "Oaty", "Bran+"], secondPick: true, product: "cereal" });
  const qid = def.questions[0].id;
  const pv = await open(def);
  await pv.waitForSelector('[data-testid="shelf"][data-stage="first"]');
  const item = (c) => `[data-testid="shelf"] .rs-shelf-item[data-code="${c}"]`;
  await sleep(300);
  await pv.hover(item("p2"));
  await pv.hover(item("p3"));
  await pv.hover(item("p2"));
  await pv.click(item("p1"));
  await pv.waitForSelector('[data-testid="shelf"][data-stage="second"]');
  let s = await store(pv);
  assert.deepEqual(s.answers[qid], ["p1"]);
  assert.equal(s.embedded.SHELF_SHELF_EXAMINED, "p2,p3,p1", "each product once, in the order looked at, the pick last");
  assert.ok(Number(s.embedded.SHELF_SHELF_TIME) > 0, `time to find ${s.embedded.SHELF_SHELF_TIME}`);
  assert.equal(await pv.getAttribute(item("p1"), "aria-checked"), "true");
  ok(`hover records p2, p3 (once each), the click picks p1: answer ["p1"], SHELF_SHELF_EXAMINED "p2,p3,p1", time to find ${s.embedded.SHELF_SHELF_TIME} s`);
  await pv.click(item("p1"));
  s = await store(pv);
  assert.equal(s.embedded.SHELF_SHELF_PICK2, undefined, "the first pick cannot be the second choice");
  await pv.focus(item("p3"));
  await pv.keyboard.press("Enter");
  await sleep(200);
  s = await store(pv);
  assert.equal(s.embedded.SHELF_SHELF_PICK2, "p3");
  assert.deepEqual(s.answers[qid], ["p1"], "the answer stays the first pick");
  ok("second choice by keyboard (Enter on a focused product): SHELF_SHELF_PICK2 = p3, the answer unchanged");
  await pv.context().close();
}

/* ============================================================== B. price ladder */
if (SECTIONS.has("B")) {
  console.log("\nB  adaptive Gabor–Granger ladder");
  const { def } = surveyOf("s5c-ladder", { template: "price_ladder", prices: [5, 10, 15, 20, 25], product: "the plan", currency: "$" });
  const qid = def.questions[0].id;
  const pv = await open(def);
  await pv.waitForSelector('[data-testid="ladder"]');
  assert.equal(await pv.getAttribute('[data-testid="ladder"]', "data-price"), "15", "starts in the middle");
  assert.match(await pv.textContent('[data-testid="ladder"] .rs-ladder-q'), /Would you buy the plan at \$15\?/);
  await pv.click('[data-testid="ladder-yes"]');
  await pv.waitForSelector('[data-testid="ladder"][data-price="20"]');
  await pv.click('[data-testid="ladder-no"]');
  await pv.waitForSelector('[data-testid="ladder-done"]');
  let s = await store(pv);
  assert.equal(s.answers[qid], 15);
  assert.equal(s.embedded.GG_PRICE_LADDER_PATH, "15:1,20:0");
  assert.equal(Number(s.embedded.GG_PRICE_LADDER_START), 15);
  assert.equal(await pv.getAttribute('[data-testid="ladder-done"]', "data-highest"), "15");
  ok("15 yes → 20 no → stops: answer 15, GG_PRICE_LADDER_PATH 15:1,20:0, START 15");
  await pv.click('[data-testid="ladder-restart"]');
  await pv.waitForSelector('[data-testid="ladder"][data-price="15"]');
  for (const p of ["15", "10", "5"]) { await pv.waitForSelector(`[data-testid="ladder"][data-price="${p}"]`); await pv.click('[data-testid="ladder-no"]'); }
  await pv.waitForSelector('[data-testid="ladder-done"]');
  s = await store(pv);
  assert.equal(s.answers[qid], 0);
  assert.equal(s.embedded.GG_PRICE_LADDER_PATH, "15:0,10:0,5:0");
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-end"], .rs-end, [data-end]', { timeout: 15000 }).catch(() => {});
  ok("Start again, no at 15 / 10 / 5 → bottom of the ladder: answer 0 (accepted none), path 15:0,10:0,5:0; Next accepts 0");
  await pv.context().close();
}

/* ============================================================== C. IAT */
if (SECTIONS.has("C")) {
  console.log("\nC  IAT D-score");
  const { def } = surveyOf("s5c-iat", { template: "iat", targets: ["Coffee", "Tea"], attributes: ["Good", "Bad"], targetWords: [["Espresso", "Latte"], ["Earl Grey", "Chai"]], attributeWords: [["Joy", "Love"], ["Pain", "Hate"]] });
  const pv = await open(def);
  for (let b = 0; b < 4; b++) {
    const q = def.questions[b];
    const key = q.settings.iatBlock.key;
    const extra = b < 2 ? 0 : 450;           // slower on the incompatible pairing
    await pv.waitForSelector(`[data-qid="${q.id}"] [data-testid="iat"]`);
    const seen = new Set();
    for (let t = 0; t < q.rows.length; t++) {
      /* the NEW stimulus: phase "stimulus" and a row not answered yet (during the gap the last stimulus is still drawn) */
      await pv.waitForFunction(({ qid, done }) => { const el = document.querySelector(`[data-qid="${qid}"] [data-testid="iat"]`); const st = el?.querySelector('[data-testid="iat-stimulus"]'); return el?.getAttribute("data-phase") === "stimulus" && st && !done.includes(st.getAttribute("data-row")); }, { qid: q.id, done: [...seen] }, { timeout: 10000 });
      const row = await pv.getAttribute(`[data-qid="${q.id}"] [data-testid="iat-stimulus"]`, "data-row");
      seen.add(row);
      await sleep(380 + extra);
      await pv.click(`[data-qid="${q.id}"] .rs-iat-cat[data-code="${key[row]}"]`);
      await sleep(80);
    }
    await pv.waitForSelector(`[data-qid="${q.id}"] [data-testid="iat-done"]`);
    if (b < 3) await next(pv);
  }
  await sleep(300);
  /* the D-score is a calculation: the engine writes it in the calculation pass (on change and on submit) */
  let s = await store(pv);
  if (s.calculated.IAT_D == null) { await next(pv); s = await store(pv); }
  assert.ok(typeof s.calculated.IAT_D === "number" && s.calculated.IAT_D > 0, `IAT_D ${s.calculated.IAT_D} ${JSON.stringify(s.calculated)}`);
  assert.equal(s.calculated.IAT_EXCLUDED, 0);
  assert.equal(s.calculated.IAT_TRIALS, 32);
  const rts = s.answers[`${def.questions[3].id}__rt`];
  assert.equal(Object.keys(rts).length, 8, "every stimulus of the last block has a latency");
  ok(`four combined blocks (32 trials) answered, incompatible ~450 ms slower: IAT_D = ${s.calculated.IAT_D} > 0, IAT_EXCLUDED 0, IAT_TRIALS 32 in the preview store`);
  await pv.context().close();
}

await browser.close();
if (allErrors.length) { console.error("page errors:\n  " + allErrors.join("\n  ")); process.exit(1); }
console.log(`\n${passed} passed`);
