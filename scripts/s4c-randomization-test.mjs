/**
 * Browser suite — S4c "RANDOMIZATION AND LISTS" (2026-11-01, docs/S4-NATIVE-FEATURES-2026-10-31.md part C).
 *
 *   A  the runtime sandbox claim (/api/session/balance, the process store with 0073/0079 semantics): a WEIGHTED exact
 *      randomizer, 200 parallel claims at 3:1 → exactly 150 / 50; a Williams randomizer's ROW claimed (latin:<id>)
 *   B  the preview Runner: an exact Williams randomizer over 3 blocks, 6 runs → each of the 6 design rows once, the
 *      pages shown in the row's order, ORDER_R1 = what was shown, RANDOMIZER_R1_ROW stored; a question with
 *      recordOrder stores Q0_ORDER = the option order in the DOM
 *   C  the preview Runner: an A/B experiment with exact arm balance, 4 runs → 2 / 2; the arm shown = the answer = EXP_ARM
 *   D  the preview Runner + the logic sandbox: a List Fill with method custom — the named logic script's setCalc list
 *      decides (LISTFILL_BRANDS_CODES = its order); a script that writes nothing → priority + quota and
 *      LISTFILL_BRANDS_CUSTOM_FALLBACK = 1
 *   E  the Studio (needs :3000): the randomizer card (order Williams, weights, record order) and the List Fill panel's
 *      custom script picker
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s4c-randomization-test.mjs     SECTIONS=A,B,C,D,E (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D,E").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];

async function post(url, body, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if ((r.status === 502 || r.status === 503 || r.status === 504) && i < tries) { await sleep(3000); continue; }
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) { if (i >= tries) throw e; await sleep(4000); }
  }
}
async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
async function open(def) {
  const pv = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${def.meta.id}: ${e.message}`); });
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def });
  return pv;
}
const calc = (pv) => pv.evaluate(() => ({ ...(window.__rescriptState?.calculated ?? {}) }));
const answers = (pv) => pv.evaluate(() => ({ ...(window.__rescriptState?.answers ?? {}) }));
const qn = (id) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: `Question ${id}`, settings: {} });
const pg = (id, q) => ({ type: "page", id, questionIds: [q] });
const next = (pv) => pv.click('[data-testid="rs-next"]');
const restart = async (pv) => { await pv.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 }); await pv.click('button:has-text("Restart test session")'); };
/* the Williams design of 3 (engine williamsDesign(3)): 012 120 201 + mirrors */
const W3 = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]];

/* ============================================================== A. sandbox claim */
if (SECTIONS.has("A")) {
  console.log("\nA  the runtime's balance claim (sandbox store)");
  const def = {
    meta: { id: "s4c-a", code: "S4CA", title: "Weighted", version: "1" },
    questions: ["q0", "a", "b"].map(qn),
    flow: [pg("p0", "q0"), { type: "randomizer", id: "rw", show: 1, weights: { pa: 3, pb: 1 }, balance: { exact: true }, children: [pg("pa", "a"), pg("pb", "b")] }, { type: "end", id: "e", status: "complete" }],
  };
  const SCOPE = `s4c-${Date.now()}`;
  const outs = await Promise.all(Array.from({ length: 200 }, (_, i) => post(`${RUNTIME}/api/session/balance`, { sessionId: `s4c-weighted-${String(i).padStart(5, "0")}`, keys: ["randomizer:rw"], definition: def, scope: SCOPE, seed: i * 31 })));
  assert.ok(outs.every((o) => o.status === 200 && o.body.assignments?.[0]?.source === "claim"), JSON.stringify(outs.find((o) => o.status !== 200)?.body ?? {}));
  const c = (await post(`${RUNTIME}/api/session/balance`, { op: "counts", sessionId: "s4c-counts-000001", keys: ["randomizer:rw"], definition: def, scope: SCOPE })).body.counts["randomizer:rw"];
  assert.deepEqual([c.pa.active, c.pb.active], [150, 50], JSON.stringify(c));
  ok("weighted exact randomizer (3:1), 200 parallel claims → exactly 150 / 50");

  const w = { ...def, meta: { ...def.meta, id: "s4c-a2" }, questions: ["q0", "a", "b", "c", "d"].map(qn), flow: [pg("p0", "q0"), { type: "randomizer", id: "wl", order: "williams", balance: { exact: true }, children: [pg("pa", "a"), pg("pb", "b"), pg("pc", "c"), pg("pd", "d")] }, { type: "end", id: "e", status: "complete" }] };
  const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => post(`${RUNTIME}/api/session/balance`, { sessionId: `s4c-williams-${String(i).padStart(5, "0")}`, keys: ["latin:wl"], definition: w, scope: SCOPE, seed: i })));
  const per = {};
  for (const r of rows) { const a = r.body.assignments?.[0]; assert.equal(a?.variable, "RANDOMIZER_WL_ROW"); per[a.arms[0]] = (per[a.arms[0]] ?? 0) + 1; }
  assert.deepEqual(Object.values(per), [3, 3, 3, 3], JSON.stringify(per));
  ok("an exact Williams randomizer claims its ROW (latin:wl → RANDOMIZER_WL_ROW): 12 respondents over 4 rows → 3 each");
}

/* ============================================================== B. Williams in the preview + stored order */
if (SECTIONS.has("B")) {
  console.log("\nB  the preview Runner: Williams rows, ORDER_<ID>, <VAR>_ORDER");
  const def = {
    meta: { id: `s4c-b-${Date.now()}`, code: "S4CB", title: "Williams", version: "1" },
    questions: [
      { id: "q0", code: "Q0", variableName: "Q0", type: "single_select", text: "Pick one", options: ["1", "2", "3", "4", "5"].map((c) => ({ code: c, label: `Option ${c}` })), randomization: { enabled: true }, settings: { recordOrder: true } },
      qn("a"), qn("b"), qn("c"), qn("z"),
    ],
    flow: [pg("p0", "q0"), { type: "randomizer", id: "r1", order: "williams", balance: { exact: true }, children: [pg("pa", "a"), pg("pb", "b"), pg("pc", "c")] }, pg("pz", "z"), { type: "end", id: "e", status: "complete" }],
  };
  const pv = await open(def);
  const seenRows = {};
  for (let run = 0; run < 6; run++) {
    await pv.waitForSelector('[data-qid="q0"]', { timeout: 30000 });
    if (run === 0) {
      const dom = await pv.$$eval('[data-qid="q0"] input[type="radio"]', (els) => els.map((e) => e.value));
      const c0 = await calc(pv);
      assert.equal(c0.Q0_ORDER, dom.join(","), "Q0_ORDER = the option order in the DOM");
      ok(`a question with recordOrder stores Q0_ORDER = the displayed option order (${c0.Q0_ORDER})`);
    }
    await pv.click('[data-qid="q0"] input[type="radio"] >> nth=0');
    await next(pv);
    const shown = [];
    for (let k = 0; k < 3; k++) {
      const el = await pv.waitForSelector('[data-qid="a"], [data-qid="b"], [data-qid="c"]', { timeout: 30000 });
      const qid = await el.getAttribute("data-qid");
      if (shown[shown.length - 1] === qid) { k--; await sleep(150); continue; }
      shown.push(qid);
      await next(pv);
      if (k < 2) await pv.waitForFunction((q) => !document.querySelector(`[data-qid="${q}"]`), qid, { timeout: 30000 });
    }
    await pv.waitForSelector('[data-qid="z"]', { timeout: 30000 });
    const c = await calc(pv);
    const row = Number(c.RANDOMIZER_R1_ROW);
    assert.ok(row >= 1 && row <= 6, `row ${c.RANDOMIZER_R1_ROW}`);
    assert.deepEqual(shown, W3[row - 1].map((i) => "abc"[i]), `row ${row}`);
    assert.equal(c.ORDER_R1, shown.map((q) => `p${q}`).join(","));
    seenRows[row] = (seenRows[row] ?? 0) + 1;
    await next(pv);
    await restart(pv);
  }
  assert.deepEqual(Object.keys(seenRows).sort(), ["1", "2", "3", "4", "5", "6"], JSON.stringify(seenRows));
  ok(`exact Williams (3 blocks): 6 preview runs → each of the 6 design rows once (${JSON.stringify(seenRows)}); pages in the row's order; ORDER_R1 = what was shown`);
  await pv.close();
}

/* ============================================================== C. experiment arms */
if (SECTIONS.has("C")) {
  console.log("\nC  the preview Runner: an A/B experiment with exact arm balance");
  const def = {
    meta: { id: `s4c-c-${Date.now()}`, code: "S4CC", title: "AB", version: "1" },
    questions: [qn("q0"), { id: "qx", code: "Q1", variableName: "EXP", type: "experiment", variant: "experimental.ab", text: "Experiment", settings: { arms: [{ code: "A", label: "Control", weight: 1, html: "<p>Control</p>" }, { code: "B", label: "Treatment", weight: 1, html: "<p>Treatment</p>" }], armBalance: { exact: true } } }, qn("z")],
    flow: [pg("p0", "q0"), pg("p1", "qx"), pg("pz", "z"), { type: "end", id: "e", status: "complete" }],
  };
  const pv = await open(def);
  const n = {};
  for (let run = 0; run < 4; run++) {
    await pv.waitForSelector('[data-qid="q0"]', { timeout: 30000 });
    await next(pv);
    const el = await pv.waitForSelector('[data-testid="experiment"][data-arm]', { timeout: 30000 });
    const arm = await el.getAttribute("data-arm");
    await pv.waitForFunction(() => window.__rescriptState?.answers?.qx != null, null, { timeout: 15000 });
    const [c, a] = [await calc(pv), await answers(pv)];
    assert.equal(c.EXP_ARM, arm, "the arm shown is the claimed one");
    assert.equal(String(a.qx), arm, "the answer is the arm");
    n[arm] = (n[arm] ?? 0) + 1;
    await next(pv);
    await pv.waitForSelector('[data-qid="z"]', { timeout: 30000 });
    await next(pv);
    await restart(pv);
  }
  assert.deepEqual(Object.values(n).sort(), [2, 2], JSON.stringify(n));
  ok(`exact arm balance: 4 preview runs → ${JSON.stringify(n)}; shown arm = answer = EXP_ARM (claimed at page entry)`);
  await pv.close();
}

/* ============================================================== D. List Fill custom */
if (SECTIONS.has("D")) {
  console.log("\nD  List Fill method custom through the logic sandbox");
  const mk = (code, id) => ({
    meta: { id, code: "S4CD", title: "Custom list fill", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName: "BRANDS_Q", type: "multi_select", text: "Which brands?", options: ["A", "B", "C", "D"].map((c) => ({ code: c, label: `Brand ${c}` })), settings: {} },
      qn("z"),
    ],
    scripts: [{ id: "scr1", name: "Pick brands", scope: "survey", event: "on_complete", enabled: true, code }],
    listFills: [{
      id: "lf1", name: "BRANDS", enabled: true, source: { kind: "question", questionId: "q1", take: "selected" },
      selection: { count: { kind: "fixed", n: 2 }, method: "custom", scriptId: "scr1" }, tracking: { sampleLevel: false },
      options: ["A", "B", "C", "D"].map((c, i) => ({ code: c, priority: i + 1 })), destinations: [],
    }],
    flow: [pg("p1", "q1"), pg("pz", "z"), { type: "end", id: "e", status: "complete" }],
  });
  const run = async (def) => {
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"]', { timeout: 30000 });
    for (const c of ["A", "B", "C", "D"]) await pv.click(`[data-qid="q1"] input[value="${c}"]`);
    await next(pv);
    await pv.waitForSelector('[data-qid="z"]', { timeout: 30000 });
    const c = await calc(pv);
    await pv.close();
    return c;
  };
  const c1 = await run(mk("setCalc('LISTFILL_BRANDS_CUSTOM', ['D', 'Z', 'B']);", `s4c-d1-${Date.now()}`));
  assert.equal(c1.LISTFILL_BRANDS_CODES, "D,B", JSON.stringify(c1));
  assert.equal(c1.LISTFILL_BRANDS_CUSTOM_FALLBACK, 0);
  ok("the logic script's list decides (D, B in its order); the foreign Z is dropped; LISTFILL_BRANDS_CUSTOM_FALLBACK = 0");
  const c2 = await run(mk("log('nothing to pick');", `s4c-d2-${Date.now()}`));
  assert.equal(c2.LISTFILL_BRANDS_CODES, "A,B", JSON.stringify(c2));
  assert.equal(c2.LISTFILL_BRANDS_CUSTOM_FALLBACK, 1);
  ok("a script that writes nothing → priority + quota (A, B) and LISTFILL_BRANDS_CUSTOM_FALLBACK = 1");
}

/* ============================================================== E. Studio */
if (SECTIONS.has("E")) {
  console.log("\nE  Studio: the randomizer card and the List Fill custom picker");
  const { openHarness } = await import("./lib/variantHarness.mjs");
  const h = await openHarness();
  try {
    await h.loadDef({
      meta: { id: "sandbox", code: "S4C", title: "S4c", version: "1.0" },
      questions: ["q0", "a", "b", "c"].map(qn).concat([{ id: "q9", code: "Q9", variableName: "Q9", type: "multi_select", text: "Brands", options: [{ code: "A", label: "A" }, { code: "B", label: "B" }], settings: {} }]),
      scripts: [{ id: "scr1", name: "Pick brands", scope: "survey", event: "on_complete", enabled: true, code: "setCalc('LISTFILL_L1_CUSTOM', ['A']);" }],
      listFills: [{ id: "lf1", name: "L1", enabled: true, source: { kind: "question", questionId: "q9", take: "selected" }, selection: { count: { kind: "fixed", n: 1 }, method: "highest_priority" }, tracking: { sampleLevel: false }, options: [{ code: "A" }, { code: "B" }], destinations: [] }],
      flow: [pg("p0", "q0"), { type: "randomizer", id: "r1", children: [{ type: "block", id: "ba", title: "Concept A", children: [pg("pa", "a")] }, { type: "block", id: "bb", title: "Concept B", children: [pg("pb", "b")] }, { type: "block", id: "bc", title: "Concept C", children: [pg("pc", "c")] }] }, pg("p9", "q9"), { type: "end", id: "e1", status: "complete" }],
    });
    await h.goTab("Survey Flow");
    const card = ".flow-card:has(.fn-type.randomizer)";
    await h.page.waitForSelector(card, { timeout: 15000 });
    if (!(await h.page.$('[data-testid="randomizer-order"]'))) await h.page.$eval(`${card} .block-toggle`, (b) => b.click());
    await h.page.waitForSelector('[data-testid="randomizer-order"]', { timeout: 15000 });
    await h.page.fill('[data-testid="randomizer-weight-ba"]', "2");
    await h.page.waitForTimeout(250);
    await h.page.click('[data-testid="randomizer-record-order"]');
    await h.page.waitForTimeout(250);
    let def = await h.readDef();
    let r = def.flow.find((n) => n.type === "randomizer");
    assert.deepEqual(r.weights, { ba: 2 });
    assert.equal(r.recordOrder, false);
    await h.goTab("Survey Flow");
    await h.page.waitForSelector(card, { timeout: 15000 });
    if (!(await h.page.$('[data-testid="randomizer-order"]'))) await h.page.$eval(`${card} .block-toggle`, (b) => b.click());
    await h.page.waitForSelector('[data-testid="randomizer-order"]', { timeout: 15000 });
    await h.page.selectOption('[data-testid="randomizer-order"]', "williams");
    await h.page.waitForSelector('[data-testid="randomizer-order-note"]', { timeout: 5000 });
    const noteText = await h.page.textContent('[data-testid="randomizer-order-note"]');
    assert.match(noteText, /6 design rows/);
    assert.ok(await h.page.$('[data-testid="randomizer-balance"]'), "exact balance offered for the design rows");
    await h.page.waitForTimeout(250);
    def = await h.readDef();
    r = def.flow.find((n) => n.type === "randomizer");
    assert.equal(r.order, "williams");
    ok("randomizer card: a weight (Concept A = 2), “store the order shown” off, order Williams (6 design rows for 3 blocks; exact balance offered)");

    await h.goTab("List Fill");
    await h.page.waitForSelector('[data-testid="lf-lf1"]', { timeout: 15000 });
    await h.page.click('[data-testid="lf-open-lf1"]');
    await h.page.waitForSelector('[data-testid="lf-method-lf1"]');
    await h.page.selectOption('[data-testid="lf-method-lf1"]', "custom");
    await h.page.waitForSelector('[data-testid="lf-custom-script-lf1"]', { timeout: 5000 });
    await h.page.selectOption('[data-testid="lf-custom-script-lf1"]', "scr1");
    await h.page.waitForTimeout(250);
    def = await h.readDef();
    assert.equal(def.listFills[0].selection.method, "custom");
    assert.equal(def.listFills[0].selection.scriptId, "scr1");
    ok("List Fill panel: method Custom script → pick the logic script (selection.scriptId)");
  } finally { await h.close?.(); }
}

await browser.close();
if (allErrors.length) { console.error(allErrors.join("\n")); process.exit(1); }
console.log(`\n${passed} passed`);
process.exit(0);
