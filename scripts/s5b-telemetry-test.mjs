/**
 * Browser suite — S5b "TELEMETRY AND INTEGRATIONS" (2026-11-01, docs/S5-EXTENDED-FEATURES-2026-11-01.md part B).
 *
 * The runtime preview and sandbox test links (the real Runner, engine and renderer; no database).
 *
 *   A  visibility + scroll depth (TE-04): a long page — the first card is seen at once, the last only after a
 *      scroll; scroll depth grows to 100 %; an answer clicked by DOM script without scrolling is "answered unseen";
 *      the sandbox row keeps the sanitised telemetry (visibleMs, scrollDepth, measured); visibility off → none
 *      recorded and "visibility" listed in disabled
 *   B  answer history (TE-02): a single choice switched 1→2→1→2→1 keeps the five values with rising times; a grid
 *      keeps its cells; typed text keeps { len } only (the text is nowhere in the telemetry, client or stored);
 *      the stored row keeps the history; answerHistory off → none
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s5b-telemetry-test.mjs
 *   SECTIONS=A (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const watch = (pg, tag) => pg.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${tag}: ${e.message}`); });
async function open(def, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1100, height: 800 } });
  const pv = await ctx.newPage();
  watch(pv, def.meta.id);
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def });
  return pv;
}
async function launch(def) {
  const r = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
  const j = await r.json(); assert.ok(j.url, JSON.stringify(j)); return j.url;
}
async function openLink(url, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1100, height: 800 } });
  const pg = await ctx.newPage();
  watch(pg, url);
  await goto(pg, `${RUNTIME}${url}`);
  await pg.waitForSelector("[data-qid]", { timeout: 120000 });
  return pg;
}
async function row(sessionId, pick, until) {
  let j = null;
  for (let i = 0; i < 80; i++) {
    j = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId, pick }) })).json();
    if (!until || until(j)) break;
    await sleep(250);
  }
  return j;
}
const scale = [1, 2, 3, 4, 5].map((n) => ({ code: String(n), label: `Point ${n}` }));
const sq = (id, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: `Question ${id} — ${"a long line of text to make the card tall. ".repeat(6)}`, options: scale, required: false, settings: {}, ...extra });
const survey = (id, questions, pages, extra = {}) => ({ meta: { id, code: id.toUpperCase(), title: id, version: "1" }, questions, flow: [...pages, { type: "end", id: "e1", status: "complete" }], ...extra });
const tel = (pg) => pg.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptTelemetry)));
const next = async (pg) => { await pg.click('[data-testid="rs-next"]'); await sleep(500); };
/** select an option by a DOM click — no scrolling, unlike a Playwright click */
const domPick = (pg, qid, code) => pg.evaluate(([q, c]) => {
  const card = document.querySelector(`[data-qid="${q}"]`);
  const input = [...card.querySelectorAll("input")].find((i) => i.value === c) ?? card.querySelectorAll("input")[Number(c) - 1];
  input.click();
}, [qid, code]);

/* ============================================================== A. visibility + scroll depth */
if (SECTIONS.has("A")) {
  console.log("\nA  visibility + scroll depth (TE-04)");
  const ids = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"];
  const def = survey("s5b-a1", ids.map((id) => sq(id)), [{ type: "page", id: "p1", questionIds: ids }, { type: "page", id: "p2", questionIds: [] }], { quality: { enabled: true } });
  def.questions.push({ id: "z", code: "Z", variableName: "Z", type: "single_select", text: "Last", options: scale, required: false, settings: {} });
  def.flow[1].questionIds = ["z"];
  {
    const pv = await open(def, { viewport: { width: 1000, height: 600 } });
    await pv.waitForSelector('[data-qid="q8"]');
    await sleep(900);
    let t = await tel(pv);
    assert.ok(t.measured.includes("visibility"), "the collector reports what it measured");
    assert.ok(t.questions.q1?.firstSeenAt > 0, "the first card is seen at once");
    assert.equal(t.questions.q8?.firstSeenAt, undefined, "the last card is below the fold");
    const d0 = t.pages[0].scrollDepth;
    assert.ok(d0 > 0 && d0 < 60, `initial scroll depth ${d0}`);
    ok(`first card seen on arrival, last card not yet; initial scroll depth ${d0} %`);

    // an answer made by a DOM click on an off-screen card (no scroll) — the "answered unseen" signal
    await domPick(pv, "q8", "3");
    await sleep(300);
    t = await tel(pv);
    assert.equal(t.questions.q8.changes, 1);
    assert.equal(t.questions.q8.firstSeenAt, undefined);
    ok("a DOM-click answer on an off-screen card counts a change with no first-seen time");

    await pv.click('[data-qid="q1"] label >> nth=1');
    await pv.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(900);
    t = await tel(pv);
    assert.ok(t.questions.q8.firstSeenAt > t.questions.q1.firstSeenAt, "q8 seen after the scroll");
    assert.equal(t.pages[0].scrollDepth, 100);
    await next(pv);
    await pv.waitForSelector('[data-qid="z"]');
    await sleep(400);
    t = await tel(pv);
    assert.ok(t.questions.q1.visibleMs > 0, `q1 visible ${t.questions.q1.visibleMs} ms`);
    assert.ok(t.questions.q8.visibleMs > 0);
    assert.ok(t.questions.q1.visibleMs >= 500, "q1 was on screen for most of the first page");
    assert.equal(t.pages[1].pageId, "p2");
    ok(`scroll to the end: depth 100 %, q8 seen later than q1; on leaving, visible time closed (q1 ${t.questions.q1.visibleMs} ms, q8 ${t.questions.q8.visibleMs} ms)`);
    await pv.context().close();
  }
  {
    // sandbox link: the stored (server-sanitised) telemetry keeps the visibility fields
    const url = await launch(def);
    const pg = await openLink(url, { viewport: { width: 1000, height: 600 } });
    await sleep(600);
    await pg.click('[data-qid="q1"] label >> nth=2');
    await next(pg);
    await pg.waitForSelector('[data-qid="z"]');
    const sessionId = await pg.evaluate(() => window.__rescriptState.sessionId);
    const r = await row(sessionId, { telemetry: true }, (j) => j?.picked?.telemetry?.pages?.length >= 1);
    const st = r.picked.telemetry;
    assert.ok(st.measured.includes("visibility"));
    assert.ok(st.questions.q1.visibleMs > 0 && st.questions.q1.firstSeenAt > 0, JSON.stringify(st.questions.q1));
    assert.ok(typeof st.pages[0].scrollDepth === "number" && st.pages[0].scrollDepth <= 100);
    ok("sandbox row: the stored telemetry keeps visibleMs / firstSeenAt / scrollDepth and measured = [visibility]");
    await pg.context().close();

    const offDef = JSON.parse(JSON.stringify(def));
    offDef.meta.id = "s5b-a2"; offDef.quality = { enabled: true, telemetry: { visibility: false } };
    const url2 = await launch(offDef);
    const pg2 = await openLink(url2, { viewport: { width: 1000, height: 600 } });
    await sleep(600);
    let t = await tel(pg2);
    assert.ok(t.disabled.includes("visibility"));
    assert.ok(!t.measured.includes("visibility"));
    await pg2.click('[data-qid="q1"] label >> nth=2');
    await next(pg2);
    await pg2.waitForSelector('[data-qid="z"]');
    t = await tel(pg2);
    assert.equal(t.questions.q1.visibleMs, undefined);
    assert.equal(t.pages[0].scrollDepth, undefined);
    const sid2 = await pg2.evaluate(() => window.__rescriptState.sessionId);
    const r2 = await row(sid2, { telemetry: true }, (j) => j?.picked?.telemetry?.pages?.length >= 1);
    assert.ok(r2.picked.telemetry.disabled.includes("visibility"));
    assert.equal(r2.picked.telemetry.questions.q1.visibleMs, undefined);
    ok("visibility off: nothing collected, 'visibility' in disabled (client and stored row)");
    await pg2.context().close();
  }
}

/* ============================================================== B. answer history */
if (SECTIONS.has("B")) {
  console.log("\nB  answer-value history (TE-02)");
  const def = survey("s5b-b1", [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick", options: scale, required: false, settings: {} },
    { id: "g1", code: "G1", variableName: "G1", type: "matrix_single", text: "Grid", rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }], options: scale.slice(0, 3), required: false, settings: {} },
    { id: "oe", code: "OE", variableName: "OE", type: "open_text", text: "Say something", required: false, settings: {} },
  ], [{ type: "page", id: "p1", questionIds: ["q1", "g1", "oe"] }, { type: "page", id: "p2", questionIds: ["z"] }], { quality: { enabled: true } });
  def.questions.push({ id: "z", code: "Z", variableName: "Z", type: "single_select", text: "Last", options: scale, required: false, settings: {} });
  const url = await launch(def);
  const pg = await openLink(url);
  for (const n of [0, 1, 0, 1, 0]) { await pg.click(`[data-qid="q1"] label >> nth=${n}`); await sleep(120); }
  await pg.click('[data-qid="g1"] tr:has-text("Row 1") input >> nth=0');
  await pg.click('[data-qid="g1"] tr:has-text("Row 2") input >> nth=2');
  await pg.fill('[data-qid="oe"] input, [data-qid="oe"] textarea', "PRIVATE-WORDS here");
  await sleep(300);
  let t = await tel(pg);
  assert.ok(t.measured.includes("answerHistory"));
  const h = t.questions.q1.history;
  assert.deepEqual(h.map((e) => e[1]), ["1", "2", "1", "2", "1"]);
  assert.ok(h.every((e, i) => i === 0 || e[0] >= h[i - 1][0]), "times rise");
  assert.ok(h[0][0] >= 0 && h[0][0] < 600000, "relative to the start");
  ok(`single choice 1→2→1→2→1: five values with rising relative times (${h.map((e) => e[0]).join(", ")} ms)`);
  const gh = t.questions.g1.history;
  assert.deepEqual(gh[gh.length - 1][1], { r1: "1", r2: "3" });
  ok("grid: each change keeps the whole set of cells");
  const oh = t.questions.oe.history;
  assert.ok(oh.length >= 1 && oh.every((e) => Object.keys(e[1]).join() === "len"), JSON.stringify(oh));
  assert.equal(oh[oh.length - 1][1].len, "PRIVATE-WORDS here".length);
  assert.ok(!JSON.stringify(t).includes("PRIVATE"), "the typed text is nowhere in the telemetry");
  ok("typed text: { len } only — the text is nowhere in the collected telemetry");
  await next(pg);
  await pg.waitForSelector('[data-qid="z"]');
  const sessionId = await pg.evaluate(() => window.__rescriptState.sessionId);
  const r = await row(sessionId, { telemetry: true }, (j) => j?.picked?.telemetry?.questions?.q1?.history);
  const st = r.picked.telemetry;
  assert.deepEqual(st.questions.q1.history.map((e) => e[1]), ["1", "2", "1", "2", "1"]);
  assert.ok(!JSON.stringify(st).includes("PRIVATE"));
  assert.ok(st.measured.includes("answerHistory"));
  ok("sandbox row: the stored telemetry keeps the history, never the text");
  await pg.context().close();

  const offDef = JSON.parse(JSON.stringify(def)); offDef.meta.id = "s5b-b2"; offDef.quality = { enabled: true, telemetry: { answerHistory: false } };
  const pv = await open(offDef);
  await pv.waitForSelector('[data-qid="q1"]');
  await pv.click('[data-qid="q1"] label >> nth=0'); await pv.click('[data-qid="q1"] label >> nth=1');
  await sleep(200);
  t = await tel(pv);
  assert.equal(t.questions.q1.history, undefined);
  assert.equal(t.questions.q1.changes, 2);
  assert.ok(t.disabled.includes("answerHistory") && !t.measured.includes("answerHistory"));
  ok("answerHistory off: change counts only, 'answerHistory' in disabled");
  await pv.context().close();
}

await browser.close();
if (allErrors.length) { console.error("page errors:\n  " + allErrors.join("\n  ")); process.exit(1); }
console.log(`\n${passed} passed`);
