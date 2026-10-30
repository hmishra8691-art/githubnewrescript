/**
 * Browser suite — S1b: SCRIPTS-PANEL LOGIC SCRIPTS AND CUSTOM COMPONENTS RUN IN THE SANDBOX
 * (docs/S1-ONE-SCRIPT-ENGINE-2026-10-30.md part B). Runtime only (preview + a sandbox test link; fake provider, no DB).
 *
 * The survey carries the production Scripts-panel scripts verbatim (master demo b/c/e/f/h, beverage/mask demo
 * a-style i, j, k, l, m, n; the master demo's own suite covers a/d/g on the master demo itself):
 *
 *   A  preview   survey on_load (l) — BUILD_TAG piped on page 1 before it is shown; on_change (a, i) — derived calcs
 *                after the change, piped on page 2; on_submit (c, m) — the hidden list source h_lf_source set by a
 *                page script; loop helpers (j, f) — position, reference column; on_submit error() (n, h) blocks Next
 *                with the message on the question; flags (e); on_complete (k) — NPS mean over the loop's iterations;
 *                a custom component sets its own answer from a click in its sandboxed mirror; and NO main-thread
 *                execution of any of this code (a spy on the page's Function constructor counts calls of functions
 *                built from the scripts' text in the top window — must stay 0)
 *   B  saved     a sandbox TEST LINK: the on_complete values and the component's answer are in the saved row
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/logic-scripts-sandbox-test.mjs     SECTIONS=A,B
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allErrors = [];

const BRANDS = [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" }];
const Q = (id, type, text, extra = {}) => ({ id, code: id, variableName: id, type, text, settings: {}, ...extra });
const S = (id, scope, ref, event, code) => ({ id, name: id, scope, ...(ref ? { ref } : {}), event, code, enabled: true });

/* verbatim production scripts */
const P = {
  a: `const s = Number(get('q_monthly_spend'));\nsetCalc('SPEND_BAND_TEXT', !Number.isFinite(s) ? '' : s < 50 ? 'a light' : s < 200 ? 'a moderate' : 'a heavy');`,
  b: `setCalc('BUILD_TAG', 'MASTER_DEMO_2026_v1');\nlog('panel', getEmbedded('PANEL_ID'), 'source', getEmbedded('SOURCE'));`,
  c: `const used = (get('q_used') || []).map(String);\nconst trusted = (get('q_trusted') || []).map(String);\nconst both = used.filter((c) => trusted.includes(c)).map(Number);\nset('h_lf_source', both);\nsetCalc('N_USED_AND_TRUSTED', both.length);\nlog('hidden list source', both);`,
  e: `const score = Number(getCalc('ENGAGEMENT_SCORE'));\nif (score >= 70) flag('digital_native');\nif (get('q_recontact') === 1) flag('recontact_ok');`,
  f: `const item = getCurrentLoopItem();\nif (item) {\n  log('LOOP_001 iteration', getCurrentLoopIndex(), 'of', getLoopCount(), item.code, item.label, item.references);\n  setCalc('LAST_CLIENT_CODE', getCurrentLoopReference('Client_Code'));\n  setCalc('LOOP_001_VISITED_' + item.code, 1);\n}`,
  h: `const bought = get('q_last_purchase'); const ends = get('q_warranty_end');\nif (bought && ends && String(ends) < String(bought)) error('The warranty cannot end before the purchase date (' + bought + ').', 'q_warranty_end');`,
  i: `const f = Number(get('q_frequency'));\nsetCalc('FREQ_BAND', !Number.isFinite(f) ? '' : f <= 2 ? 'a frequent' : f <= 4 ? 'an occasional' : 'a rare');`,
  j: `const item = getCurrentLoopItem('brand');\nconst idx = getCurrentLoopIndex('brand');\nconst n = getLoopCount('brand');\nsetCalc('LAST_RATED_BRAND', item ? String(item.label || item.code) : '');\nsetCalc('LOOP_PROGRESS', idx + ' of ' + n);\nlog('rated', item && item.code, 'at position', idx, 'of', n);`,
  k: `const nps = [];\nconst items = getLoopItems('brand') || [];\nfor (const it of items) {\n  const v = getLoopAnswer('q_b_nps', it.code, 'brand');\n  if (v != null && v !== '') nps.push(Number(v));\n}\nif (nps.length) setCalc('NPS_MEAN', Math.round((nps.reduce((a, b) => a + b, 0) / nps.length) * 10) / 10);\nsetCalc('BRANDS_EVALUATED', items.length);\nlog('finished', getEmbedded('PANEL_ID'), 'brands', items.length);`,
  l: `setCalc('BUILD_TAG', 'BEV_MASK_DEMO_2026_v1');\nconst src = String(getEmbedded('SOURCE') || 'direct').toLowerCase();\nsetEmbedded('SOURCE', src);\nsetCalc('IS_PANEL', src !== 'direct' ? 1 : 0);\nlog('opened', getEmbedded('PANEL_ID'), 'wave', getEmbedded('WAVE'));`,
  m: `const used = (get('q_used') || []).map(String).filter((c) => c !== '97');\nconst ranked = (get('q_rank') || []).map(String);\nconst ordered = ranked.filter((c) => used.includes(c)).concat(used.filter((c) => !ranked.includes(c)));\nset('h_lf_source', ordered.map(Number));\nsetCalc('N_USED_ORDERED', ordered.length);\nsetCalc('TOP_BRAND_CODE', ordered.length ? Number(ordered[0]) : null);\nif (ordered.length === 0) set('q_seg', 'light');\nlog('list fill source punched', ordered);`,
  n: `const total = Number(get('q_spend_total'));\nconst out = Number(get('q_spend_out'));\nif (Number.isFinite(total) && Number.isFinite(out) && out > total) {\n  error('Spending while out (' + out + ') cannot be more than your total (' + total + ').', 'q_spend_out');\n}\nif (Number.isFinite(total) && total === 0 && Number(get('q_frequency')) <= 2) {\n  error('You told us you drink these most days — please check your monthly spend.', 'q_spend_total');\n}`,
};
const COMPONENT_JS = "el.setAttribute('data-cc', 'ran'); el.querySelector('.cc-btn').addEventListener('click', function () { api.setValue(7); });";

const def = (id) => ({
  meta: { id, code: id.toUpperCase(), title: "Logic scripts in the sandbox", version: "1" },
  embeddedData: [
    { name: "PANEL_ID", source: "url", defaultValue: "P1" }, { name: "SOURCE", source: "url", defaultValue: "Panel" }, { name: "WAVE", source: "static", defaultValue: "W1" },
  ],
  questions: [
    Q("q_used", "multi_select", "Build {{calc.BUILD_TAG}} — which brands do you use?", { options: BRANDS }),
    Q("q_trusted", "multi_select", "Which do you trust?", { options: BRANDS }),
    Q("q_monthly_spend", "numeric", "Monthly spend?"),
    Q("q_frequency", "numeric", "How often (1–5)?"),
    Q("h_lf_source", "hidden", "List source", { options: BRANDS }),
    Q("q_seg", "hidden", "Segment"),
    Q("q_band", "open_text", "You are {{calc.SPEND_BAND_TEXT}} spender and {{calc.FREQ_BAND}} drinker; top brand {{calc.TOP_BRAND_CODE}}. Anything to add?", { required: false }),
    Q("q_b_nps", "numeric", "How likely to recommend {{loop.label}}?"),
    Q("q_spend_total", "numeric", "Total monthly spend?"),
    Q("q_spend_out", "numeric", "Of which while out?"),
    Q("q_last_purchase", "open_text", "Last purchase (YYYY-MM-DD)"),
    Q("q_warranty_end", "open_text", "Warranty ends (YYYY-MM-DD)"),
    Q("q_recontact", "single_select", "May we recontact you?", { options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }),
    Q("c1", "custom_component", "Your pick", { customHtml: '<div class="cc"><button type="button" class="cc-btn">Choose seven</button></div>', customJs: COMPONENT_JS, required: false }),
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_used", "q_trusted", "q_monthly_spend", "q_frequency"] },
    { type: "page", id: "p2", questionIds: ["q_band"] },
    { type: "loop", id: "loop_b", loopVar: "brand", source: { kind: "question", questionId: "q_used", filter: "selected" },
      references: { columns: [{ name: "Client_Code", dataType: "text" }], values: { "1": { Client_Code: "C001" }, "2": { Client_Code: "C002" }, "3": { Client_Code: "C003" } } },
      children: [{ type: "page", id: "p_b", questionIds: ["q_b_nps"] }] },
    { type: "page", id: "p9", questionIds: ["q_spend_total", "q_spend_out", "q_last_purchase", "q_warranty_end", "q_recontact", "c1"] },
    { type: "end", id: "e", status: "complete" },
  ],
  scripts: [
    S("l", "survey", null, "on_load", P.l),
    S("a", "question", "q_monthly_spend", "on_change", P.a),
    S("i", "question", "q_frequency", "on_change", P.i),
    S("c", "page", "p1", "on_submit", P.c),
    S("m", "page", "p1", "on_submit", P.m),
    S("j", "page", "p_b", "on_submit", P.j),
    S("f", "page", "p_b", "on_submit", P.f),
    S("n", "page", "p9", "on_submit", P.n),
    S("h", "page", "p9", "on_submit", P.h),
    S("e", "page", "p9", "on_submit", P.e),
    // k reads the loop (getLoopItems / getLoopAnswer), so it needs a loop context: the loop page's on_submit (on_complete has none — as before S1b)
    S("k", "page", "p_b", "on_submit", P.k),
    S("b", "survey", null, "on_complete", P.b),
  ],
});

/* counts calls, in the TOP window only, of functions the page's Function constructor built from these scripts' text */
const SPY = () => {
  if (window !== window.top) return;
  const Real = window.Function;
  const marks = /SPEND_BAND_TEXT|BEV_MASK_DEMO|list fill source punched|api\.setValue|NPS_MEAN|Spending while out/;
  const Spy = function (...args) {
    const f = Real.apply(this, args);
    if (!marks.test(String(args[args.length - 1] ?? ""))) return f;
    window.__rsMainBuilt = (window.__rsMainBuilt || 0) + 1;
    return function (...x) { window.__rsMainRuns = (window.__rsMainRuns || 0) + 1; return f.apply(this, x); };
  };
  Spy.prototype = Real.prototype;
  window.Function = Spy;
};

const browser = await chromium.launch();
async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const watch = (pv, tag) => {
  pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${tag}: ${e.message}`); });
  pv.lines = [];
  pv.on("console", (m) => pv.lines.push(m.text()));
};
const onPage = (pv, qid) => pv.waitForSelector(`[data-qid="${qid}"]`, { timeout: 30000 });
const pick = (pv, qid, label) => pv.click(`[data-qid="${qid}"] label:has-text("${label}")`);
const fill = (pv, qid, v) => pv.fill(`[data-qid="${qid}"] input:not([type=checkbox]):not([type=radio]), [data-qid="${qid}"] textarea`, String(v));
const next = (pv) => pv.click('[data-testid="rs-next"]');
const st = (pv) => pv.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState)));
const until = async (pv, fn, what, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { const s = await st(pv); if (fn(s)) return s; await sleep(100); } throw new Error(`timed out waiting for ${what}: ${JSON.stringify((await st(pv)).calculated)}`); };

/** the whole interview; `check` asserts along the way (preview only) */
async function walk(pv, check) {
  await onPage(pv, "q_used");
  const head = await pv.textContent('[data-qid="q_used"]');
  if (check) {
    assert.ok(head.includes("Build BEV_MASK_DEMO_2026_v1"), head);
    const s = await st(pv);
    // no URL parameter in a preview: getEmbedded('SOURCE') is empty, so the script stores 'direct' (as the main-thread runner did)
    assert.equal(s.embedded.SOURCE, "direct");
    assert.equal(s.calculated.IS_PANEL, 0);
    ok("survey on_load ran in the frame before page 1 was shown: BUILD_TAG piped into the first question, SOURCE = \"direct\" written (setEmbedded), IS_PANEL = 0");
  }
  for (const b of ["Apple", "Samsung", "Google"]) await pick(pv, "q_used", b);
  for (const b of ["Samsung", "Google"]) await pick(pv, "q_trusted", b);
  await fill(pv, "q_monthly_spend", 120);
  await fill(pv, "q_frequency", 2);
  if (check) {
    const s = await until(pv, (x) => x.calculated.SPEND_BAND_TEXT === "a moderate" && x.calculated.FREQ_BAND === "a frequent", "on_change calcs");
    assert.equal(s.calculated.SPEND_BAND_TEXT, "a moderate");
    ok("on_change (debounced, in the frame): SPEND_BAND_TEXT = \"a moderate\", FREQ_BAND = \"a frequent\" after the respondent's change");
  }
  await next(pv);
  await onPage(pv, "q_band");
  if (check) {
    const s = await st(pv);
    assert.deepEqual(s.answers.h_lf_source, [1, 2, 3], JSON.stringify(s.answers));
    assert.equal(s.calculated.N_USED_AND_TRUSTED, 2);
    assert.equal(s.calculated.TOP_BRAND_CODE, 1);
    const t = await pv.textContent('[data-qid="q_band"]');
    assert.ok(t.includes("You are a moderate spender and a frequent drinker; top brand 1"), t);
    ok("on_submit (c, m) wrote the hidden list source h_lf_source = [1,2,3] (page script, hidden target) and the calcs; piped on page 2: \"a moderate … a frequent … top brand 1\"");
  }
  await next(pv);
  for (const [i, v] of [[0, 9], [1, 6], [2, 10]]) {
    await onPage(pv, "q_b_nps");
    await sleep(200);
    if (check && i === 1) {
      const s = await st(pv);
      assert.equal(s.calculated.LAST_RATED_BRAND, "Apple");
      assert.equal(s.calculated.LOOP_PROGRESS, "1 of 3");
      assert.equal(s.calculated.LAST_CLIENT_CODE, "C001");
      assert.equal(s.calculated.LOOP_001_VISITED_1, 1);
      ok("loop helpers in the frame (j, f): after iteration 1 LAST_RATED_BRAND = Apple, LOOP_PROGRESS = \"1 of 3\", reference Client_Code = C001");
    }
    await fill(pv, "q_b_nps", v);
    await sleep(150);
    await next(pv);
    await sleep(400);
  }
  await onPage(pv, "q_spend_total");
  await sleep(600);
  await fill(pv, "q_spend_total", 0);
  await fill(pv, "q_spend_out", 5);
  await fill(pv, "q_last_purchase", "2026-05-01");
  await fill(pv, "q_warranty_end", "2026-01-01");
  await pick(pv, "q_recontact", "Yes");
  await pv.waitForSelector('[data-rs-component="c1"][data-cc="ran"]', { timeout: 15000 });
  await sleep(500); // the frame has said which events it listens for
  for (let i = 0; ; i++) {
    await pv.click('[data-rs-component="c1"] .cc-btn');
    try { await until(pv, (x) => x.answers.c1 === 7, "the component's answer", 4000); break; }
    catch (e) { if (i >= 2) { console.log(pv.lines.filter((l) => /c1|component|setAnswer|rescript:script/.test(l)).join("\n")); throw e; } }
  }
  if (check) ok("custom component: its code ran in the sandbox (data-cc applied to its element via the mirror) and a click set its own answer c1 = 7 through rs.setAnswer");
  await next(pv);
  await pv.waitForSelector('[data-qid="q_spend_out"] .rs-error-msg:has-text("Spending while out (5) cannot be more than your total (0).")', { timeout: 15000 });
  await pv.waitForSelector('[data-qid="q_spend_total"] .rs-error-msg:has-text("You told us you drink these most days")', { timeout: 15000 });
  await pv.waitForSelector('[data-qid="q_warranty_end"] .rs-error-msg:has-text("The warranty cannot end before the purchase date (2026-05-01).")', { timeout: 15000 });
  if (check) ok("on_submit error() (n, h) blocked Next with each message on its question, like built-in validation");
  await fill(pv, "q_spend_total", 50);
  await fill(pv, "q_warranty_end", "2027-01-01");
  await sleep(300);
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 });
}

if (SECTIONS.has("A")) {
  console.log("\nA preview");
  const pv = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await pv.addInitScript(SPY);
  watch(pv, "preview");
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def("lsp") });
  await walk(pv, true);
  const s = await until(pv, (x) => x.calculated.BUILD_TAG === "MASTER_DEMO_2026_v1", "on_complete");
  assert.equal(s.calculated.NPS_MEAN, 8.3);
  assert.equal(s.calculated.BRANDS_EVALUATED, 3);
  assert.ok(s.flags.includes("recontact_ok"), JSON.stringify(s.flags));
  ok("on_complete (b) ran before the final save (BUILD_TAG rewritten); k on the last loop page: NPS_MEAN = 8.3 over three iterations (getLoopItems / getLoopAnswer), BRANDS_EVALUATED = 3; flag recontact_ok (e)");
  const kinds = new Set((s.scriptWrites ?? []).map((w) => `${w.script}:${w.kind}`));
  assert.ok(kinds.has("m:answer") && kinds.has("k:calculated") && kinds.has("l:embedded") && kinds.has("e:flag"), [...kinds].join(","));
  ok(`paradata: logic scripts' writes recorded through the channel (${[...kinds].sort().join(", ")})`);
  const spy = await pv.evaluate(() => ({ built: window.__rsMainBuilt || 0, runs: window.__rsMainRuns || 0 }));
  assert.equal(spy.runs, 0, JSON.stringify(spy));
  const frames = await pv.evaluate(() => document.querySelectorAll("iframe[data-rs-logic-sandbox]").length);
  ok(`no main-thread execution: 0 calls of a function built from the scripts' text in the top window (built for the code gate's parse check: ${spy.built}); logic frames on the end page: ${frames}`);
  await pv.close();
}

if (SECTIONS.has("B")) {
  console.log("\nB the saved row");
  const launch = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def("lsl") }) });
  const { url } = await launch.json();
  assert.ok(url, "the sandbox test link was launched");
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const a = await ctx.newPage();
  watch(a, "test link");
  await goto(a, `${RUNTIME}${url}`);
  await walk(a, false);
  const sessionId = await a.evaluate(() => window.__rescriptState.sessionId);
  let row = null;
  for (let i = 0; i < 80; i++) {
    row = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId }) })).json();
    if (row?.scriptValues?.BUILD_TAG === "MASTER_DEMO_2026_v1") break;
    await sleep(250);
  }
  assert.equal(row.scriptValues?.BUILD_TAG, "MASTER_DEMO_2026_v1", JSON.stringify(row));
  assert.equal(row.scriptValues?.NPS_MEAN, 8.3, JSON.stringify(row));
  assert.equal(row.scriptValues?.c1, 7, JSON.stringify(row.scriptValues));
  assert.deepEqual(row.scriptValues?.h_lf_source, [1, 2, 3]);
  ok(`the saved row holds the on_complete value BUILD_TAG = MASTER_DEMO_2026_v1, NPS_MEAN = 8.3, the component's answer c1 = 7 and h_lf_source, with ${row.scriptWrites.length} paradata records`);
  await ctx.close();
}

await browser.close();
if (allErrors.length) { console.log("\npage errors:\n" + allErrors.join("\n")); process.exitCode = 1; }
console.log(`\n${passed} checks passed${allErrors.length ? `, ${allErrors.length} page errors` : ""}`);
