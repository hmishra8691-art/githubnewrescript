/**
 * Browser suite — S1a: THE ENGINE-CHECKED SCRIPT WRITE CHANNEL AND THE validate / submit LIFECYCLE
 * (docs/S1-ONE-SCRIPT-ENGINE-2026-10-30.md). Runtime only (preview + a sandbox test link; fake provider, no DB).
 *
 *   A  writes      a question script on Q1 punches the hidden H_SEG on a change (accepted, in the state, and the
 *                  inspector says "written"); writes to Q2 — on screen, not its own — and to Q1 with a code Q1 does
 *                  not have are refused, with the reason in the console; rs.setEmbedded / rs.setCalc are visible to
 *                  the next page's display logic (Q3 shown by SOURCE = panel, Q4 by MY_SCORE = 7); the paradata
 *                  (state.scriptWrites) names script and target, never a value
 *   B  validate    a "validate" handler on Q3 stops Next with its message on Q3 (Back is not stopped); with the
 *                  answer it wants, Next goes on; a "submit" handler's write lands before the page is left
 *   C  slow        a "validate" handler that never settles: Next goes on after the bound (~1.5 s), logged
 *   D  loops       rs.getAnswer is loop-aware: in iteration g, getAnswer("QL") is g's (empty), getAnswer("QL","a") a's
 *   E  saved row   a sandbox TEST LINK: the hidden value a script wrote is in the saved row, and so is the paradata
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/script-writes-test.mjs     SECTIONS=A,B,C,D,E (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D,E").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allErrors = [];

const opts = (...labels) => labels.map((label, i) => ({ code: String(i + 1), label }));
const Q = (id, type, text, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text, settings: {}, ...extra });
const beh = (id, target, script) => ({ id, label: id, target, effects: [], script });

const WRITER = `rs.listen("change", "self", function (e) {
  rs.setAnswer("H_SEG", String(e.value) === "1" ? "Y" : "N").then(function (r) { rs.showMessage("self", "seg:" + r.ok); });
  rs.setAnswer("Q2", "typed by code");
  rs.setAnswer("Q1", 9);
  rs.setEmbedded("SOURCE", "panel");
  rs.setCalc("MY_SCORE", 7);
});`;
const VALIDATOR = `rs.listen("validate", function () { if (String(rs.getAnswer("Q3")) !== "2") rs.error("Pick Blue to continue", "Q3"); });
rs.listen("submit", function () { return rs.setCalc("LEFT_P2", 1); });`;
const SLOW = `rs.listen("validate", function () { return new Promise(function () {}); });`;
const LOOPER = `rs.listen("page", "self", function () { rs.showMessage("self", "a=" + rs.getAnswer("QL", "a") + " here=" + rs.getAnswer("QL")); });`;

const def = (id) => ({
  meta: { id, code: id.toUpperCase(), title: "Script writes", version: "1" },
  questions: [
    Q("q1", "single_select", "Pick one", { options: opts("Alpha", "Beta", "Gamma") }),
    Q("q2", "open_text", "Anything to add?"),
    Q("h_seg", "hidden", "Segment", { options: [{ code: "Y", label: "Yes" }, { code: "N", label: "No" }] }),
    Q("q3", "single_select", "Colour (shown for the panel)", { options: opts("Red", "Blue"), displayLogic: { type: "rule", source: { kind: "embedded", ref: "SOURCE" }, operator: "eq", value: "panel" } }),
    Q("q4", "numeric", "Score check (shown when MY_SCORE = 7)", { displayLogic: { type: "rule", source: { kind: "calculation", ref: "MY_SCORE" }, operator: "eq", value: 7 } }),
    Q("q5", "numeric", "Slow page"),
    Q("ql", "numeric", "How many for {{loop.label}}?"),
  ],
  flow: [
    { type: "embedded_data", id: "ed1", fields: [{ name: "SOURCE", source: "static", value: "web", dataType: "string" }] },
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"] },
    { type: "page", id: "p3", questionIds: ["q5"] },
    { type: "loop", id: "lp", loopVar: "brand", source: { kind: "static", items: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }] },
      children: [{ type: "page", id: "pl", questionIds: ["ql"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
  ux: { styles: [], animations: [], behaviors: [
    beh("b_writer", { kind: "question", questionId: "q1" }, WRITER),
    beh("b_validate", { kind: "question", questionId: "q3" }, VALIDATOR),
    beh("b_slow", { kind: "question", questionId: "q5" }, SLOW),
    beh("b_loop", { kind: "question", questionId: "ql" }, LOOPER),
  ] },
});

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
const next = (pv) => pv.click('[data-testid="rs-next"]');
const st = (pv) => pv.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState)));
const waitLine = async (pv, re, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { const l = pv.lines.find((x) => re.test(x)); if (l) return l; await sleep(100); } return null; };
const qids = (pv) => pv.evaluate(() => [...document.querySelectorAll("#rs-questions [data-qid]")].map((e) => e.getAttribute("data-qid")).filter((v, i, a) => a.indexOf(v) === i));

/* ================================================================================================ A–D (preview) */
if (["A", "B", "C", "D"].some((s) => SECTIONS.has(s))) {
  const pv = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  watch(pv, "preview");
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def("swp") });
  await onPage(pv, "q1");
  await sleep(800); // the frames start

  console.log("\nA writes");
  await pick(pv, "q1", "Alpha");
  await pv.waitForSelector('[data-qid="q1"] .rs-ux-message:has-text("seg:true")', { timeout: 15000 });
  let s = await st(pv);
  assert.equal(s.answers.h_seg, "Y", JSON.stringify(s.answers));
  ok(`a question script punched the hidden H_SEG on a change (state h_seg = "Y"; the promise resolved { ok: true })`);
  const refusedQ2 = await waitLine(pv, /rs\.setAnswer\("Q2"\) refused: Q2 is on screen/);
  assert.ok(refusedQ2, pv.lines.join("\n"));
  assert.equal(s.answers.q2, undefined, "Q2 untouched");
  const refusedQ1 = await waitLine(pv, /rs\.setAnswer\("Q1"\) refused: "9" is not an option code of Q1/);
  assert.ok(refusedQ1, pv.lines.join("\n"));
  assert.equal(String(s.answers.q1), "1", "Q1 keeps the respondent's answer");
  ok(`refused with the reason in the console: Q2 (on screen, not the script's) — "${refusedQ2.replace(/^.*refused: /, "").slice(0, 70)}…"; Q1 = 9 (no such option)`);
  assert.equal(s.embedded.SOURCE, "panel");
  assert.equal(s.calculated.MY_SCORE, 7);
  const kinds = (s.scriptWrites ?? []).map((w) => `${w.script}:${w.kind}:${w.target}`);
  assert.ok(kinds.includes("b_writer:answer:h_seg") && kinds.includes("b_writer:embedded:SOURCE") && kinds.includes("b_writer:calculated:MY_SCORE"), JSON.stringify(s.scriptWrites));
  assert.ok(!JSON.stringify(s.scriptWrites).includes("typed by code") && (s.scriptWrites ?? []).every((w) => !("value" in w)), "no values in the paradata");
  ok(`paradata: ${kinds.length} accepted writes recorded (${[...new Set(kinds)].join(", ")}) — script, kind, target, time; no values`);
  await next(pv);
  await onPage(pv, "q3");
  assert.deepEqual(await qids(pv), ["q3", "q4"]);
  ok("rs.setEmbedded / rs.setCalc are read by the next page's display logic: Q3 (SOURCE = panel) and Q4 (MY_SCORE = 7) are shown");

  if (SECTIONS.has("B")) {
    console.log("\nB validate / submit");
    await pick(pv, "q3", "Red");
    await sleep(300);
    await pv.click('[data-testid="rs-back"]');
    await onPage(pv, "q1");
    ok("Back does not run validate (Red on Q3, Back went to page 1)");
    await next(pv); await onPage(pv, "q3");
    await sleep(800);
    await next(pv);
    await pv.waitForSelector('[data-qid="q3"] .rs-error-msg:has-text("Pick Blue to continue")', { timeout: 15000 });
    assert.deepEqual(await qids(pv), ["q3", "q4"], "still on page 2");
    ok("a validate handler stopped Next with its message on Q3, shown like a built-in validation message");
    await pick(pv, "q3", "Blue");
    await sleep(300);
    await next(pv);
    await onPage(pv, "q5");
    s = await st(pv);
    assert.equal(s.calculated.LEFT_P2, 1, "the submit handler's write landed");
    ok("with Blue, Next goes on; the submit handler's rs.setCalc(\"LEFT_P2\", 1) landed before the page was left");
  } else { await pick(pv, "q3", "Blue"); await sleep(300); await next(pv); await onPage(pv, "q5"); }

  if (SECTIONS.has("C") || SECTIONS.has("D")) {
    console.log("\nC slow validate");
    await pv.fill('[data-qid="q5"] input', "3");
    await sleep(800);
    const t0 = Date.now();
    await next(pv);
    await onPage(pv, "ql");
    const took = Date.now() - t0;
    assert.ok(took >= 1300 && took < 12000, `Next waited for the bound, then went on (${took} ms)`);
    const late = await waitLine(pv, /validate: no answer within 1500 ms — treated as no error/);
    assert.ok(late, pv.lines.join("\n"));
    ok(`a validate handler that never settles did not trap the respondent: Next went on after ${took} ms, logged "${late.replace(/^.*\] /, "")}"`);

    console.log("\nD loop-aware getAnswer");
    await pv.waitForSelector('[data-qid="ql"] .rs-ux-message:has-text("a=undefined here=undefined")', { timeout: 15000 });
    await pv.fill('[data-qid="ql"] input', "11");
    await sleep(300);
    await next(pv);
    await pv.waitForSelector('[data-qid="ql"] .rs-ux-message:has-text("a=11 here=undefined")', { timeout: 15000 });
    ok('in iteration Google: rs.getAnswer("QL") is Google\'s own (empty) and rs.getAnswer("QL", "a") is Apple\'s 11');
  }
  await pv.close();
}

/* ================================================================================================ E (test link, saved row) */
if (SECTIONS.has("E")) {
  console.log("\nE the saved row");
  const launch = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def("swl") }) });
  const { url } = await launch.json();
  assert.ok(url, "the sandbox test link was launched");
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const a = await ctx.newPage();
  watch(a, "test link");
  await goto(a, `${RUNTIME}${url}`);
  await onPage(a, "q1");
  await sleep(800);
  await pick(a, "q1", "Beta");
  await a.waitForSelector('[data-qid="q1"] .rs-ux-message:has-text("seg:true")', { timeout: 15000 });
  await next(a);
  await onPage(a, "q3");
  const sessionId = await a.evaluate(() => window.__rescriptState.sessionId);
  let row = null;
  for (let i = 0; i < 60; i++) {
    row = await (await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "row", sessionId }) })).json();
    if (row?.scriptValues?.h_seg) break;
    await sleep(250);
  }
  assert.equal(row.scriptValues?.h_seg, "N", JSON.stringify(row));
  assert.equal(row.scriptValues?.SOURCE, "panel");
  assert.ok(row.scriptWrites.some((w) => w.script === "b_writer" && w.kind === "answer" && w.target === "h_seg" && w.at), JSON.stringify(row.scriptWrites));
  ok(`after Next the saved row holds h_seg = "N" (script-made) and SOURCE = panel, with the paradata (${row.scriptWrites.length} writes)`);
  await ctx.close();
}

await browser.close();
assert.deepEqual(allErrors, [], allErrors.join("\n"));
console.log(`\nscript-writes-test: ${passed} passed`);
