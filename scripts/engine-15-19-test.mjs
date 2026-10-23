/**
 * Browser suite — ENGINE ITEMS 15–19 (2026-10-22, docs/ENGINE-15-19-2026-10-22.md).
 *
 *   #15 EXACT EVEN PRESENTATION   200 claims fired in parallel at the runtime's /api/session/balance (sandbox
 *                                 store, same rules as migration 0073) → the four arms end at 50/50/50/50; a
 *                                 released (screened-out) respondent's arm is the next one handed out; a nested
 *                                 randomizer is exact at both levels; the preview Runner, restarted 8 times,
 *                                 shows each of 4 arms exactly twice and stores RANDOMIZER_R1; a design question
 *                                 with exact version balance hands out 3 versions 2/2/2; a survey without the
 *                                 setting is untouched; the Studio's randomizer card turns exact balance on
 *   #16 RESPONDENT VOICE          Chromium with a fake microphone and NO Web Speech (forced): the mic records,
 *                                 asks consent once, shows "Transcribing…", appends the server transcript and
 *                                 gives focus back; matrix_text and custom-table text cells dictate per cell
 *                                 (the mic appears on focus, the column keeps its width), numeric cells get
 *                                 none; a Web Speech "network" failure falls back to the server; the survey's
 *                                 language travels to the server; `deployment.speechServer: false` → no mic
 *   #17 LONG RECORDINGS + CLIPS   in the Studio sandbox, an M4A and a WebM made in the page by MediaRecorder,
 *                                 plus FLAC / OGG made by ffmpeg when present, are decoded in the browser to
 *                                 16 kHz WAV parts (part size shrunk by the test seam, so several parts with
 *                                 overlap), transcribed with word timings and merged; an excerpt's clip plays
 *                                 exactly its words (Coding and Highlights); a correction re-aligns them
 *   #18 REPORTS                   the live theme preview redraws on switching and editing (no document request),
 *                                 contrast warnings appear and clear as you type; a section order set by
 *                                 keyboard and drag-and-drop is saved and applied in the research plan Word file
 *                                 and in BOTH the qualitative Word report and the qualitative PowerPoint deck
 *   #19 LAYOUT                    Intelligent Mode with three panes open at 1024 / 1280 / 1366 / 1440 / 768 / 390:
 *                                 the conversation ≥ 600 px where it can be, rails and drawers below, no sideways
 *                                 scroll; splitters by keyboard, widths remembered; RTL mirrored
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/engine-15-19-test.mjs
 *   SECTIONS=15,16,17,18,19 (default all)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { unzipEntries, checkDocx } from "../packages/analytics/dist/export/docxCheck.js";
import { checkPptx } from "../packages/analytics/dist/export/officeCheck.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "15,16,17,18,19").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });

/** a fetch that survives a supervised dev-server restart (network errors and 502/503 retried; nothing else) */
async function post(url, body, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if ((r.status === 502 || r.status === 503 || r.status === 504) && i < tries) { await sleep(3000); continue; }
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) { if (i >= tries) throw e; await sleep(4000); }
  }
}
/** navigation that survives a restart */
async function goto(page, url, ready) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); if (ready) await page.waitForSelector(ready, { timeout: 60000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
const pageErrors = (page, label) => { const errs = []; page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) errs.push(`${label}: ${e.message}`); }); return errs; };
const allErrors = [];

/* ================================================================================================ #15 */
const qn = (id) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", text: `Question ${id}`, settings: {} });
const page_ = (id, q) => ({ type: "page", id, questionIds: [q] });
const EXACT = (balance) => ({
  meta: { id: "e1519", code: "E1519", title: "Exact balance", version: "1" },
  questions: ["q0", "a", "b", "c", "d", "z"].map(qn),
  flow: [page_("p0", "q0"), { type: "randomizer", id: "r1", show: 1, evenPresentation: true, ...(balance ? { balance } : {}), children: [page_("pa", "a"), page_("pb", "b"), page_("pc", "c"), page_("pd", "d")] }, page_("pz", "z"), { type: "end", id: "e", status: "complete" }],
});

if (SECTIONS.has("15")) {
  console.log("\n#15 EXACT EVEN PRESENTATION — the runtime's claim route (sandbox store = 0073's rules)");
  const SCOPE = `e1519-${Date.now()}`;
  const def = EXACT({ exact: true });
  const claim = (sid, keys = ["randomizer:r1"], d = def, scope = SCOPE) => post(`${RUNTIME}/api/session/balance`, { sessionId: sid, keys, definition: d, scope, seed: (sid.length * 7919) % 100000 });
  const counts = async (keys, d = def, scope = SCOPE) => (await post(`${RUNTIME}/api/session/balance`, { op: "counts", sessionId: "counts-session-0001", keys, definition: d, scope })).body.counts;
  const counted = (c, key) => Object.fromEntries(Object.entries(c[key] ?? {}).map(([a, x]) => [a, x.active + x.completed]));
  {
    const t0 = Date.now();
    const out = await Promise.all(Array.from({ length: 200 }, (_, i) => claim(`burst-session-${String(i).padStart(4, "0")}`)));
    assert.ok(out.every((r) => r.status === 200 && r.body.assignments?.[0]?.source === "claim"), JSON.stringify(out.find((r) => r.status !== 200)?.body ?? {}));
    const c = counted(await counts(["randomizer:r1"]), "randomizer:r1");
    assert.deepEqual(Object.values(c).sort(), [50, 50, 50, 50], JSON.stringify(c));
    ok(`200 claims fired in parallel (${Date.now() - t0} ms): 50/50/50/50 — exact, no herding (a snapshot decision herds: spread 17 in bursts of 25)`);
    // the same session again: the same arm, no new claim
    const again = await claim("burst-session-0007");
    const first = out[7].body.assignments[0].arms;
    assert.deepEqual(again.body.assignments[0].arms, first);
    assert.equal(Object.values(counted(await counts(["randomizer:r1"]), "randomizer:r1")).reduce((a, b) => a + b, 0), 200);
    ok("a repeated claim (Back, reload) returns the same arm and counts once");
    // release 10 respondents of arm X (screened out): the next 10 claims all take X
    const ofArm = out.map((r, i) => ({ i, arm: r.body.assignments[0].arms[0] })).filter((x) => x.arm === "pc").slice(0, 10);
    for (const x of ofArm) await post(`${RUNTIME}/api/session/balance`, { op: "release", sessionId: `burst-session-${String(x.i).padStart(4, "0")}`, scope: SCOPE });
    const refill = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`refill-session-${String(i).padStart(4, "0")}`)));
    assert.deepEqual([...new Set(refill.map((r) => r.body.assignments[0].arms[0]))], ["pc"], "every refill took the released arm");
    assert.deepEqual(Object.values(counted(await counts(["randomizer:r1"]), "randomizer:r1")).sort(), [50, 50, 50, 50]);
    ok("10 screened-out respondents give arm pc back; the next 10 claims (in parallel) all take pc → 50/50/50/50 again");
    // a client cannot award itself an arm
    const forged = await post(`${RUNTIME}/api/session/balance`, { sessionId: "forged-session-0001", keys: ["randomizer:r1"], definition: def, scope: SCOPE, calculated: { RANDOMIZER_R1: "pa" }, seed: 3 });
    assert.equal(forged.body.assignments[0].source, "claim");
    ok(`a forged RANDOMIZER_R1 in the request is ignored: the store decides (${forged.body.assignments[0].arms[0]})`);
  }
  {
    const nested = {
      ...EXACT(), meta: { id: "e1519n", code: "N", title: "Nested", version: "1" },
      questions: ["q0", "a", "b", "n1", "n2", "z"].map(qn),
      flow: [page_("p0", "q0"), { type: "randomizer", id: "outer", show: 1, balance: { exact: true }, children: [page_("pa", "a"), { type: "block", id: "blk", children: [page_("pb", "b"), { type: "randomizer", id: "inner", show: 1, balance: { exact: true }, children: [page_("pn1", "n1"), page_("pn2", "n2")] }] }] }, { type: "end", id: "e", status: "complete" }],
    };
    const S2 = `${SCOPE}-nested`;
    const outs = await Promise.all(Array.from({ length: 80 }, (_, i) => post(`${RUNTIME}/api/session/balance`, { sessionId: `nested-session-${String(i).padStart(4, "0")}`, keys: ["randomizer:outer"], definition: nested, scope: S2, seed: i })));
    const intoBlock = outs.map((r, i) => ({ r, i })).filter(({ r }) => r.body.assignments[0].arms[0] === "blk");
    assert.equal(intoBlock.length, 40);
    await Promise.all(intoBlock.map(({ r, i }) => post(`${RUNTIME}/api/session/balance`, { sessionId: `nested-session-${String(i).padStart(4, "0")}`, keys: ["randomizer:inner"], definition: nested, scope: S2, calculated: { RANDOMIZER_OUTER: "blk" }, seed: i })));
    const c = await counts(["randomizer:outer", "randomizer:inner"], nested, S2);
    assert.deepEqual(Object.values(counted(c, "randomizer:outer")).sort(), [40, 40]);
    assert.deepEqual(Object.values(counted(c, "randomizer:inner")).sort(), [20, 20]);
    ok("nested randomizers: 80 parallel respondents → outer 40/40, inner (only those who reached it) 20/20");
  }

  console.log("\n#15 the preview Runner (the tab's in-memory store)");
  {
    const pv = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    allErrors.push(...pageErrors(pv, "preview"));
    await goto(pv, `${RUNTIME}/preview`);
    await sendPreview(pv, { definition: def });
    const seen = {};
    for (let run = 0; run < 8; run++) {
      await pv.waitForSelector('[data-qid="q0"]', { timeout: 30000 });
      await pv.click('[data-testid="rs-next"]');
      const shown = await pv.waitForSelector('[data-qid="a"], [data-qid="b"], [data-qid="c"], [data-qid="d"]', { timeout: 30000 });
      const qid = await shown.getAttribute("data-qid");
      const stored = await pv.evaluate(() => window.__rescriptState.calculated.RANDOMIZER_R1);
      assert.equal(stored, `p${qid}`, "the claimed child is stored as RANDOMIZER_R1 and is what is shown");
      seen[qid] = (seen[qid] ?? 0) + 1;
      await pv.click('[data-testid="rs-next"]');
      await pv.waitForSelector('[data-qid="z"]');
      await pv.click('[data-testid="rs-next"]');
      await pv.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 });
      await pv.click('button:has-text("Restart test session")');
    }
    assert.deepEqual(Object.values(seen).sort(), [2, 2, 2, 2], JSON.stringify(seen));
    ok(`8 preview runs, show 1 of 4 → each arm exactly twice (${JSON.stringify(seen)}); the shown child = RANDOMIZER_R1`);

    await pv.close();
    // a survey WITHOUT the setting: no claim, no variable, no loading card
    const pv2 = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    allErrors.push(...pageErrors(pv2, "preview-plain"));
    let claims = 0;
    pv2.on("request", (r) => { if (/\/api\/session\/balance/.test(r.url())) claims++; });
    await goto(pv2, `${RUNTIME}/preview`);
    await sendPreview(pv2, { definition: { ...EXACT(), meta: { ...EXACT().meta, id: "e1519plain" } } });
    await pv2.waitForSelector('[data-qid="q0"]');
    await pv2.click('[data-testid="rs-next"]');
    await pv2.waitForSelector('[data-qid="a"], [data-qid="b"], [data-qid="c"], [data-qid="d"]');
    assert.equal(await pv2.evaluate(() => window.__rescriptState.calculated.RANDOMIZER_R1 ?? null), null);
    assert.equal(claims, 0);
    await pv2.close();
    ok("a survey without exact balance: seed-derived as before — no claim, no RANDOMIZER_ variable");

    // design versions: 3 versions, exact → 6 runs give 2/2/2
    const rows = []; for (let v = 1; v <= 3; v++) for (let t = 1; t <= 1; t++) for (let a = 1; a <= 2; a++) rows.push({ version: v, task: t, alt: a, is_holdout: 0, Price: `$${a * 10}`, none_option: 0 });
    const ddef = {
      meta: { id: "e1519d", code: "D", title: "Design", version: "1" },
      questions: [qn("q0"), { id: "cj", code: "CJ", variableName: "CJ", type: "conjoint_task", text: "Choose", required: false, settings: { designRef: "d1", versionBalance: { exact: true } } }],
      flow: [page_("p0", "q0"), page_("p1", "cj"), { type: "end", id: "e", status: "complete" }],
      designs: [{ id: "d1", kind: "conjoint", name: "p", version: 1, seed: 1, config: {}, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Price", "none_option"], rows } }],
    };
    const pv3 = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    allErrors.push(...pageErrors(pv3, "preview-design"));
    await goto(pv3, `${RUNTIME}/preview`);
    await sendPreview(pv3, { definition: ddef });
    const versions = {};
    for (let run = 0; run < 6; run++) {
      await pv3.waitForSelector('[data-qid="q0"]', { timeout: 30000 });
      await pv3.click('[data-testid="rs-next"]');
      await pv3.waitForSelector('[data-qid="cj"]', { timeout: 30000 });
      const v = await pv3.evaluate(() => window.__rescriptState.calculated.CJ_VERSION);
      versions[v] = (versions[v] ?? 0) + 1;
      await pv3.click('[data-testid="rs-next"]');
      await pv3.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 });
      await pv3.click('button:has-text("Restart test session")');
    }
    assert.deepEqual(Object.values(versions).sort(), [2, 2, 2], JSON.stringify(versions));
    ok(`a CBC question with exact version balance: 6 runs over 3 versions → 2/2/2 (${JSON.stringify(versions)}), stored as CJ_VERSION`);
    await pv3.close();
  }

  console.log("\n#15 the Studio: the randomizer card");
  {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    allErrors.push(...pageErrors(page, "studio-15"));
    await page.addInitScript((d) => { window.__rescriptSandboxSeed = d; }, { ...EXACT(), meta: { ...EXACT().meta, id: "sandbox" } });
    await goto(page, `${STUDIO}/sandbox?mode=studio`, ".menubar");
    await openTab(page, "Survey Flow");
    await page.waitForSelector('[data-testid="flow-counts"]');
    const card = ".flow-card:has(.fn-type.randomizer)";
    await page.waitForSelector(card);
    if (!(await page.$('[data-testid="randomizer-even"]'))) await page.$eval(`${card} .block-toggle`, (b) => b.click());
    await page.waitForSelector('[data-testid="randomizer-even"]');
    // ticking "even presentation" turns exact balance on (new behaviour); the settings appear
    if (await page.isChecked('[data-testid="randomizer-even"]')) { await page.click('[data-testid="randomizer-even"]'); await page.waitForTimeout(200); }
    await page.click('[data-testid="randomizer-even"]');
    await page.waitForSelector('[data-testid="randomizer-balance"][data-exact="1"]');
    await page.selectOption('[data-testid="randomizer-balance-basis"]', "started");
    await page.waitForTimeout(400);
    await openTab(page, "JSON");
    await page.waitForSelector("textarea.code");
    const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
    const r = d.flow.find((n) => n.type === "randomizer");
    assert.deepEqual(r.balance, { exact: true, basis: "started" });
    ok("the randomizer card: ticking “even presentation” stores balance.exact; the basis select stores basis");
    await page.close();
  }
}

/* ================================================================================================ #16 */
if (SECTIONS.has("16")) {
  console.log("\n#16 RESPONDENT VOICE — no Web Speech (forced), fake microphone, server transcription");
  const NO_WEB_SPEECH = () => { window.__rescriptNoWebSpeech = true; delete window.SpeechRecognition; delete window.webkitSpeechRecognition; };
  const FAILING_WEB_SPEECH = () => {
    class Failing { constructor() { this.onerror = null; this.onend = null; this.onresult = null; } start() { setTimeout(() => { this.onerror?.({ error: "network" }); this.onend?.(); }, 50); } stop() {} abort() {} }
    delete window.SpeechRecognition; window.webkitSpeechRecognition = Failing;
  };
  const VDEF = (deployment = {}) => ({
    meta: { id: "e1519v", code: "V", title: "Voice", version: "1" },
    deployment: { languages: ["hi"], ...deployment },
    questions: [
      { id: "q_text", code: "Q1", variableName: "OPEN", type: "open_text", text: "What did you think?", settings: {} },
      { id: "q_mx", code: "Q2", variableName: "MX", type: "matrix_text", text: "Describe each", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Taste" }], columns: [{ id: "c1", label: "Your words", variableStem: "W", responseType: "text", options: [], validation: [] }], settings: {} },
      { id: "q_tab", code: "Q3", variableName: "TAB", type: "custom_table", text: "Brands", rows: [{ code: "b1", label: "Brand A" }], columns: [{ id: "why", label: "Why", variableStem: "WHY", responseType: "text", options: [], validation: [] }, { id: "n", label: "How many", variableStem: "N", responseType: "numeric", options: [], validation: [] }], settings: {} },
    ],
    flow: [page_("p1", "q_text"), { type: "page", id: "p2", questionIds: ["q_mx", "q_tab"] }, { type: "end", id: "e", status: "complete" }],
  });
  const open = async (init, def) => {
    const pv = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    allErrors.push(...pageErrors(pv, "voice"));
    await pv.addInitScript(init);
    await goto(pv, `${RUNTIME}/preview`);
    await sendPreview(pv, { definition: def });
    return pv;
  };
  const dictateServer = async (pv, scope, expectConsent) => {
    const btn = `${scope} [data-testid="speech-toggle"]`;
    await pv.click(btn);
    if (expectConsent) {
      await pv.waitForSelector(`${scope} [data-testid="speech-consent"]`);
      await pv.click(`${scope} [data-testid="speech-consent-allow"]`);
    }
    await pv.waitForSelector(`${btn}[aria-pressed="true"]`, { timeout: 10000 });
    await sleep(1300);
    await pv.click(btn);
    await pv.waitForSelector(`${scope} [data-testid="speech-transcribing"]`, { timeout: 5000 }).catch(() => null);
    await pv.waitForFunction((s) => !document.querySelector(`${s} [data-testid="speech-transcribing"]`) && document.querySelector(`${s} [data-testid="speech-toggle"]`)?.getAttribute("aria-pressed") === "false", scope, { timeout: 30000 });
  };
  {
    const pv = await open(NO_WEB_SPEECH, VDEF());
    const headers = [];
    pv.on("request", (r) => { if (/\/api\/session\/dictate$/.test(r.url()) && r.method() === "POST") headers.push(r.headers()); });
    const q1 = '[data-qid="q_text"]';
    await pv.waitForSelector(`${q1} [data-speech-mode="server"] [data-testid="speech-toggle"]`, { timeout: 45000 });
    ok("no Web Speech: the microphone is offered in server mode (Firefox's case)");
    await pv.fill(`${q1} input.rs-input`, "I liked it.");
    await dictateServer(pv, q1, true);
    const v = await pv.inputValue(`${q1} input.rs-input`);
    assert.match(v, /^I liked it\. \[transcript \w+\] This is a simulated transcript/, v);
    assert.equal(await pv.evaluate(() => document.activeElement?.matches('[data-qid="q_text"] input.rs-input')), true, "focus is back on the field");
    assert.equal(headers.length, 1);
    assert.equal(headers[0]["x-session-id"], "preview");
    assert.equal(headers[0]["x-language"], "hi", "the survey's language goes with the audio");
    assert.equal(headers[0]["x-question-id"], "q_text");
    assert.match(headers[0]["content-type"], /^audio\//);
    ok("consent asked once → recording → “Transcribing…” → the server's words APPENDED to what was typed; focus back on the field; language hi, question id and audio type sent");

    await pv.click('[data-testid="rs-next"]');
    await pv.waitForSelector('[data-qid="q_mx"]');
    const cell = '[data-qid="q_mx"] tr:nth-child(1) [data-testid="speech-cell"]';
    const widthBefore = await pv.$eval('[data-qid="q_mx"] table', (t) => t.getBoundingClientRect().width);
    const hiddenBefore = await pv.$eval(`${cell} .rs-speech`, (e) => getComputedStyle(e).opacity);
    assert.equal(hiddenBefore, "0", "a cell's mic is hidden until the cell has focus");
    await pv.focus(`${cell} input`);
    await pv.waitForFunction((c) => getComputedStyle(document.querySelector(`${c} .rs-speech`)).opacity === "1", cell);
    const widthAfter = await pv.$eval('[data-qid="q_mx"] table', (t) => t.getBoundingClientRect().width);
    assert.ok(Math.abs(widthAfter - widthBefore) < 1, `the column keeps its width (${widthBefore} → ${widthAfter})`);
    await dictateServer(pv, cell, false);
    const mx = await pv.evaluate(() => window.__rescriptState.answers.q_mx);
    assert.match(mx.r1, /\[transcript \w+\]/);
    assert.ok(!mx.r2, "the other cell is untouched");
    assert.equal(await pv.evaluate((c) => document.activeElement?.matches(`${c} input`), cell), true, "focus back in the cell");
    ok("matrix_text: the mic appears in the focused cell only (width unchanged), dictates into THAT cell (q_mx.r1), focus returns");
    const tcell = '[data-qid="q_tab"] [data-testid="speech-cell"]';
    assert.equal((await pv.$$(tcell)).length, 1, "the table's text column has a mic, its numeric column none");
    await pv.focus(`${tcell} input`);
    await dictateServer(pv, tcell, false);
    const tab = await pv.evaluate(() => window.__rescriptState.answers.q_tab);
    assert.match(tab.b1.why, /\[transcript \w+\]/);
    ok("custom table: the text column's cell dictates into q_tab.b1.why; the numeric column has no mic");
    await pv.close();
  }
  {
    const pv = await open(FAILING_WEB_SPEECH, VDEF());
    const q1 = '[data-qid="q_text"]';
    await pv.waitForSelector(`${q1} [data-speech-mode="web"]`);
    await pv.click(`${q1} [data-testid="speech-toggle"]`);
    await pv.waitForSelector(`${q1} [data-speech-mode="server"] [data-testid="speech-consent"]`, { timeout: 10000 });
    await pv.click(`${q1} [data-testid="speech-consent-allow"]`);
    await pv.waitForSelector(`${q1} [data-testid="speech-toggle"][aria-pressed="true"]`);
    await sleep(1000);
    await pv.click(`${q1} [data-testid="speech-toggle"]`);
    await pv.waitForFunction(() => /\[transcript/.test(document.querySelector('[data-qid="q_text"] input.rs-input')?.value ?? ""), null, { timeout: 30000 });
    ok("Web Speech present but failing (“network”): the same press falls back to recording + the server");
    await pv.close();
  }
  {
    const pv = await open(NO_WEB_SPEECH, VDEF({ speechServer: false }));
    await pv.waitForSelector('[data-qid="q_text"] input.rs-input');
    await sleep(800);
    assert.equal((await pv.$$('[data-testid="speech-toggle"]')).length, 0);
    ok("deployment.speechServer = false and no Web Speech: no microphone at all (no audio leaves the device)");
    await pv.close();
  }
}

/* ================================================================================================ #17 */
const studioPage = async (seed, label, viewport = { width: 1600, height: 1100 }) => {
  /* a renderer crash (memory pressure on a shared machine while a dev server compiles) is retried in a fresh context */
  for (let i = 0; ; i++) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    page.on("dialog", (d) => d.accept());
    if (seed) await page.addInitScript((d) => { window.__rescriptSandboxSeed = d; }, seed);
    try {
      await goto(page, `${STUDIO}/sandbox?mode=studio`, ".menubar");
      allErrors.push(...pageErrors(page, label));
      return page;
    } catch (e) {
      await context.close().catch(() => null);
      if (i >= 3 || !/crash|Target closed|has been closed/i.test(String(e))) throw e;
      await sleep(15000);
    }
  }
};

if (SECTIONS.has("17")) {
  console.log("\n#17 LONG RECORDINGS IN ANY FORMAT + CLIPS OF EXACTLY THE QUOTE (Studio sandbox)");
  const seed = { meta: { id: "sandbox", code: "Q17", title: "Recordings", version: "1" }, questions: [qn("q0")], flow: [page_("p1", "q0"), { type: "end", id: "e", status: "complete" }], qualStudy: { kind: "interview", title: "Recordings", objectives: ["Why people switch"] } };
  const page = await studioPage(seed, "qual-17");
  /* the test seam: parts of ~4.4 s (140 kB of 16 kHz WAV) with ~1.1 s of overlap, so a 10-second recording is sent in 3 parts */
  await page.addInitScript(() => { window.__rescriptChunkBytes = 140000; });
  await page.evaluate(() => { window.__rescriptChunkBytes = 140000; });
  await openTab(page, "Qualitative");
  await page.waitForSelector('[data-testid="qual-panel"]');
  await page.click('[data-testid="qual-tab-transcripts"]');
  await page.waitForSelector('[data-testid="qual-browser-stt-file"]', { state: "attached" });
  /** a recording made in the page itself by MediaRecorder from an oscillator */
  const record = (type, seconds) => page.evaluate(async ([type, seconds]) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const osc = ctx.createOscillator(); osc.frequency.value = 330;
    const dest = ctx.createMediaStreamDestination(); osc.connect(dest); osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: type });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(250); await new Promise((r) => setTimeout(r, seconds * 1000)); rec.stop(); await done; osc.stop(); await ctx.close();
    return { type: rec.mimeType, bytes: [...new Uint8Array(await new Blob(chunks).arrayBuffer())] };
  }, [type, seconds]);
  const transcribeFile = async (name, mimeType, buffer) => {
    const before = (await page.$$('[data-testid="qual-transcript"]')).length;
    await page.setInputFiles('[data-testid="qual-browser-stt-file"]', { name, mimeType, buffer });
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="qual-transcript"]').length > n || !!document.querySelector('[data-testid="qual-error"]'), before, { timeout: 120000 });
    const err = await page.$('[data-testid="qual-error"]');
    if (err) throw new Error(`transcription failed: ${await err.textContent()}`);
    return (await page.$$('[data-testid="qual-transcript"]')).length > before;
  };
  const parts = [];
  page.on("request", (r) => { if (/\/qual\/recordings\/chunk$/.test(r.url())) parts.push(r.headers()); });
  const m4a = await record("audio/mp4", 10.5);
  assert.match(m4a.type, /^audio\/mp4/);
  assert.ok(await transcribeFile("interview-1.m4a", "audio/mp4", Buffer.from(m4a.bytes)), "the M4A was transcribed");
  /* a part retried after a dropped connection (the dev server compiling the route) is counted once */
  const m4aParts = [...new Map(parts.splice(0).map((h) => [h["x-part-index"], h])).values()];
  assert.ok(m4aParts.length >= 3, `several parts (${m4aParts.length})`);
  assert.ok(m4aParts.every((h) => h["content-type"] === "audio/wav"), "each part is a WAV");
  assert.ok(m4aParts.slice(1).every((h) => Number(h["x-overlap-before"]) > 0), `parts overlap: ${JSON.stringify(m4aParts.map((h) => [h["x-part-index"], h["x-offset"], h["x-duration"], h["x-overlap-before"]]))}`);
  assert.ok(Number(m4aParts[1]["x-offset"]) > 0 && Number(m4aParts[1]["x-offset"]) < Number(m4aParts[0]["x-duration"]), "the second part starts inside the first (overlap)");
  const card = page.locator('[data-testid="qual-transcript"][data-title*="interview-1.m4a"]');
  assert.match(await card.innerText(), /transcribed in \d+ parts with [\d.]+ s of overlap/i);
  ok(`an M4A made by MediaRecorder: decoded in the browser to 16 kHz WAV parts (${m4aParts.length}, overlapping), transcribed with word timings, merged into one transcript`);
  const webm = await record("audio/webm;codecs=opus", 3);
  assert.ok(await transcribeFile("interview-2.webm", "audio/webm", Buffer.from(webm.bytes)));
  parts.splice(0);
  ok("a WebM/Opus made by MediaRecorder: the same path");
  let ffmpeg = false;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); ffmpeg = true; } catch { /* none */ }
  if (ffmpeg) {
    const dir = mkdtempSync(join(tmpdir(), "e1519-"));
    for (const [ext, codec, mime] of [["flac", "flac", "audio/flac"], ["ogg", "libopus", "audio/ogg"]]) {
      const f = join(dir, `tone.${ext}`);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", codec, "-y", f]);
      assert.ok(await transcribeFile(`tone.${ext}`, mime, readFileSync(f)), `${ext} transcribed`);
    }
    parts.splice(0);
    // AAC in M4A: Playwright's Chromium has no AAC decoder — the page must SAY so, never fake a transcript
    const aac = join(dir, "aac.m4a");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", "-y", aac]);
    const decoded = await page.evaluate(async (bytes) => { try { await new OfflineAudioContext(1, 1, 16000).decodeAudioData(new Uint8Array(bytes).buffer); return true; } catch { return false; } }, [...readFileSync(aac)]);
    const before = (await page.$$('[data-testid="qual-transcript"]')).length;
    await page.setInputFiles('[data-testid="qual-browser-stt-file"]', { name: "aac.m4a", mimeType: "audio/mp4", buffer: readFileSync(aac) });
    if (decoded) { await page.waitForFunction((n) => document.querySelectorAll('[data-testid="qual-transcript"]').length > n, before, { timeout: 60000 }); ok("AAC M4A (ffmpeg): decoded by this browser and transcribed"); }
    else {
      await page.waitForFunction(() => /could not decode the recording/.test(document.querySelector('[data-testid="qual-error"]')?.textContent ?? ""), null, { timeout: 30000 });
      assert.equal((await page.$$('[data-testid="qual-transcript"]')).length, before);
      ok("FLAC and OGG (ffmpeg) transcribed; AAC M4A in a Chromium without AAC: refused in words (open it in Chrome / convert), no transcript invented");
    }
  } else ok("ffmpeg absent: FLAC / OGG not generated (M4A and WebM above came from MediaRecorder)");

  // CLIPS: code three words of a segment of the M4A transcript, play the clip
  await page.click('[data-testid="qual-tab-coding"]');
  await page.waitForSelector('[data-testid="qual-code-new"]');
  await page.fill('[data-testid="qual-code-new"]', "Price");
  await page.click('[data-testid="qual-code-form"] button:has-text("Add code")');
  await page.waitForSelector('[data-testid="qual-code"][data-name="Price"]');
  await page.click('[data-testid="qual-code"][data-name="Price"] [data-testid="qual-code-open"]');
  await page.waitForSelector('[data-testid="qual-manual-segment"]');
  const seg = await page.$$eval('[data-testid="qual-manual-segment"] option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })).find((o) => /interview-1\.m4a/.test(o.t) && /\ba simulated\b/.test(o.t)) ?? null);
  assert.ok(seg, "a segment of the M4A transcript");
  await page.selectOption('[data-testid="qual-manual-segment"]', seg.v);
  await page.fill('[data-testid="qual-manual-quote"]', "a simulated");
  await page.click('[data-testid="qual-manual-add"]');
  await page.waitForSelector('[data-testid="qual-excerpt"] [data-testid="qual-excerpt-play"]', { timeout: 20000 });
  await page.click('[data-testid="qual-excerpt-play"]');
  const player = await page.waitForSelector('[data-testid="qual-clip-player"]');
  const start = Number(await player.getAttribute("data-clip-start")), end = Number(await player.getAttribute("data-clip-end"));
  assert.equal(await player.getAttribute("data-by-words"), "1", "played by its words");
  assert.ok(end > start && end - start < 2.5, `the clip is the two words (${start}–${end} s), not the whole turn`);
  await page.waitForSelector('[data-testid="qual-clip-player"][data-state="ended"]', { timeout: 20000 });
  const at = await page.$eval('[data-testid="qual-clip-player-media"]', (v) => v.currentTime);
  assert.ok(at >= start && at <= end + 0.25, `stopped at the end of the quote (${at} vs ${start}–${end})`);
  ok(`Coding: “a simulated” plays ${start.toFixed(2)}–${end.toFixed(2)} s — exactly its words, not the turn — and stops there (at ${at.toFixed(2)} s)`);

  // the correction re-aligns: change a word inside the quote; the clip is still by words, now approximate
  await page.click('[data-testid="qual-tab-transcripts"]');
  const tcard = page.locator('[data-testid="qual-transcript"][data-title*="interview-1.m4a"]');
  await tcard.locator('[data-testid="qual-transcript-open"]').click();
  const segEl = tcard.locator('[data-testid="qual-segment-text"]', { hasText: "a simulated" }).first();
  await segEl.locator('[data-testid="qual-segment-edit"]').click();
  const box = tcard.locator('[data-testid="qual-segment-input"]').first();
  const cur = await box.inputValue();
  await box.fill(cur.replace("a simulated", "a simulated, edited"));
  await tcard.locator('[data-testid="qual-segment-save"]').first().click();
  await tcard.locator('[data-testid="qual-segment-text"]', { hasText: "a simulated, edited" }).first().waitFor({ timeout: 20000 });
  assert.equal(await page.$('[data-testid="qual-error"]'), null, "the correction saved without an error");
  await page.click('[data-testid="qual-tab-coding"]');
  await page.waitForSelector('[data-testid="qual-code"][data-name="Price"]');
  if (!(await page.$('[data-testid="qual-excerpt-play"]'))) await page.click('[data-testid="qual-code"][data-name="Price"] [data-testid="qual-code-open"]');
  await page.waitForSelector('[data-testid="qual-excerpt-play"]');
  await page.click('[data-testid="qual-excerpt-play"]');
  const p2 = await page.waitForSelector('[data-testid="qual-clip-player"]');
  assert.equal(await p2.getAttribute("data-by-words"), "1");
  assert.match(await p2.innerText(), /approximate/);
  ok("a correction inside the quote (“a simulated” → “a simulated, edited”): the excerpt is re-anchored and its clip still plays by words, marked approximate");

  // Highlights: the reel item's clip
  await page.click('[data-testid="qual-tab-highlights"]');
  await page.waitForSelector('[data-testid="hl-form"] [data-testid="hl-option"]', { timeout: 20000 });
  await page.locator('[data-testid="hl-option"] input[type="checkbox"]').first().check();
  await page.fill('[data-testid="hl-name"]', "Price clips");
  await page.click('[data-testid="hl-create"]');
  await page.waitForSelector('[data-testid="hl-play"]', { timeout: 20000 });
  await page.click('[data-testid="hl-play"]');
  const hp = await page.waitForSelector('[data-testid="hl-player"]');
  assert.equal(await hp.getAttribute("data-by-words"), "1");
  ok("Highlights: the reel's clip plays by the quote's words too");
  await page.context().close();
}

/* ================================================================================================ #18 */
if (SECTIONS.has("18")) {
  console.log("\n#18 REPORTS — live theme preview, section order in every export");
  const seed = {
    meta: { id: "sandbox", code: "R18", title: "Report order", version: "1.0" },
    research: { objective: "What drives trust", hypotheses: ["Trust drives purchase"], analysis: [], assumptions: [], sources: [] },
    qualStudy: { kind: "interview", title: "Trust interviews", objectives: ["Why people trust"] },
    questions: [{ id: "trust", code: "Q1", variableName: "TRUST", type: "single_select", text: "Trust", options: [{ code: 1, label: "Low" }, { code: 2, label: "High" }] }],
    flow: [page_("p1", "trust"), { type: "end", id: "e", status: "complete" }],
  };
  const page = await studioPage(seed, "reports-18");
  const DOCS = '[data-testid="research-documents"]';
  const THEME = `${DOCS} [data-testid="report-theme"]`;
  await openTab(page, "Survey Settings");
  await page.waitForSelector(`${THEME} [data-testid="theme-live-page"]`);
  let outputs = 0;
  page.on("request", (r) => { if (/\/api\/copilot\/output$/.test(r.url())) outputs++; });
  const live = () => page.$eval(`${THEME} [data-testid="theme-live-page"]`, (e) => ({ heading: e.getAttribute("data-heading"), font: e.getAttribute("data-heading-font"), table: e.getAttribute("data-table") }));
  const before = await live();
  const t0 = Date.now();
  await page.selectOption(`${THEME} [data-testid="report-theme-pick"]`, { label: "Healthcare Analytics" });
  await page.waitForFunction(([sel, h]) => document.querySelector(sel)?.getAttribute("data-heading") !== h, [`${THEME} [data-testid="theme-live-page"]`, before.heading], { timeout: 2000 });
  const switched = Date.now() - t0;
  assert.notEqual((await live()).heading, before.heading);
  assert.equal(outputs, 0, "no document was made");
  ok(`switching theme redraws the live preview in ${switched} ms — no document request`);
  await page.fill(`${THEME} [data-testid="theme-live-color-heading"]`, "#f2f2f2");
  await page.waitForSelector(`${THEME} [data-testid="theme-live-contrast-warning"][data-token="heading"]`, { timeout: 2000 });
  assert.equal((await live()).heading, "#F2F2F2");
  await page.fill(`${THEME} [data-testid="theme-live-color-heading"]`, "#102040");
  await page.waitForSelector(`${THEME} [data-testid="theme-live-contrast-ok"]`, { timeout: 2000 });
  await page.selectOption(`${THEME} [data-testid="theme-live-table"]`, "striped");
  assert.equal((await live()).table, "striped");
  assert.equal(outputs, 0);
  ok("editing: a pale heading colour raises a live contrast warning (with the ratio and the fix); a dark one clears it; table style redraws — still no document made");
  await page.click(`${THEME} [data-testid="theme-live-apply"]`);
  await page.waitForSelector(`${THEME} [data-testid="report-theme-applied"]`, { timeout: 15000 });
  ok("“Apply these edits” applies the edited theme to the project");

  // section order: research plan — keyboard + drag
  const SO = `${DOCS} [data-testid="section-order"]`;
  await page.selectOption(`${SO} [data-testid="section-order-family"]`, "research_plan");
  await page.waitForSelector(`${SO}[data-family="research_plan"]`);
  const items = () => page.$$eval(`${SO} [data-testid="section-order-list-item"]`, (els) => els.map((e) => e.getAttribute("data-id")));
  await page.focus(`${SO} [data-testid="section-order-list-item"][data-id="ethics-consent-and-data-protection"]`);
  await page.keyboard.press("Alt+Home");
  await page.waitForTimeout(150);
  assert.equal((await items())[0], "ethics-consent-and-data-protection");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-id")), "ethics-consent-and-data-protection", "focus follows the moved row");
  assert.match(await page.textContent(`${SO} [data-testid="section-order-list-said"]`), /moved to position 1/);
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(150);
  assert.equal((await items())[1], "ethics-consent-and-data-protection");
  await page.keyboard.press("Alt+ArrowUp");
  await page.dragAndDrop(`${SO} [data-testid="section-order-list-item"][data-id="deliverables"]`, `${SO} [data-testid="section-order-list-item"]:nth-child(2)`);
  await page.waitForTimeout(200);
  const order = await items();
  assert.deepEqual(order.slice(0, 2), ["ethics-consent-and-data-protection", "deliverables"], order.join(","));
  await page.click(`${SO} [data-testid="section-order-save"]`);
  await page.waitForSelector(`${SO} [data-testid="section-order-saved"]`);
  ok("research plan: “Ethics” moved to the top with Alt+Home (focus kept, move announced), “Deliverables” dragged to second; saved");

  /* a download, or the error the page said instead (so a failure names its cause) */
  const download = async (click) => {
    for (let i = 0; ; i++) {
      const dlp = page.waitForEvent("download", { timeout: 120000 });
      await click();
      /* the page clears its old error when the action starts; look for a new one only after that */
      await sleep(400);
      const failed = page.waitForSelector('.toast.err, [data-testid="qual-error"]', { timeout: 120000 }).then(async (t) => { throw new Error(`the page said: ${await t.textContent()}`); }, () => new Promise(() => {}));
      try { return readFileSync(await (await Promise.race([dlp, failed])).path()); }
      catch (e) {
        dlp.catch(() => null);
        /* a supervised dev server restarting mid-request ("Failed to fetch" / 502–504): wait for it, then do the action again */
        if (i >= 3 || !/Failed to fetch|network|HTTP 50[234]/i.test(String(e))) throw e;
        console.log(`  …    the Studio server dropped the request (${String(e).slice(0, 80)}) — waiting for it, then retrying (${i + 1}/3)`);
        await sleep(10000);
        for (let w = 0; w < 45; w++) { try { if ((await fetch(`${STUDIO}/sandbox`)).ok) break; } catch { /* still down */ } await sleep(4000); }
        await sleep(5000);
      }
    }
  };
  const headings = (buf) => [...unzipEntries(buf).get("word/document.xml").toString("utf8").matchAll(/<w:p>(?:(?!<\/w:p>).)*?<w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*?<\/w:p>/gs)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(""));
  const plan = await download(() => page.click(`${DOCS} [data-testid="doc-research_plan_docx"]`));
  assert.deepEqual(checkDocx(plan).problems, []);
  const h = headings(plan);
  assert.deepEqual(h.slice(0, 2), ["1. Ethics, consent and data protection", "2. Deliverables"], h.join(" | "));
  h.forEach((x, i) => assert.ok(x.startsWith(`${i + 1}. `), x));
  ok(`the research plan (.docx): its Heading 1 order is the saved order, renumbered (${h.slice(0, 3).join(" · ")} …)`);

  // the qualitative report and deck share the `qual` order
  await page.selectOption(`${SO} [data-testid="section-order-family"]`, "qual");
  await page.waitForSelector(`${SO}[data-family="qual"]`);
  await page.focus(`${SO} [data-testid="section-order-list-item"][data-id="method-and-coding"]`);
  await page.keyboard.press("Alt+Home");
  await page.click(`${SO} [data-testid="section-order-save"]`);
  await page.waitForSelector(`${SO} [data-testid="section-order-saved"]`);
  await openTab(page, "Qualitative");
  await page.waitForSelector('[data-testid="qual-panel"]');
  await page.click('[data-testid="qual-tab-transcripts"]');
  await page.fill('[data-testid="qual-import-text"]', "Moderator: Why do you trust them?\nP1: The price never jumps without warning.\nP2: They answer when something goes wrong.");
  await page.click('[data-testid="qual-import-submit"]');
  await page.waitForSelector('[data-testid="qual-transcript"]');
  await page.click('[data-testid="qual-tab-report"]');
  const report = await download(() => page.click('[data-testid="qual-export-report"]'));
  const rh = headings(report);
  assert.equal(rh[0], "1. Method and coding", rh.join(" | "));
  const deck = await download(() => page.click('[data-testid="qual-export-deck"]'));
  assert.deepEqual(checkPptx(deck).problems, []);
  const parts = unzipEntries(deck);
  const pres = parts.get("ppt/presentation.xml").toString("utf8"), rels = parts.get("ppt/_rels/presentation.xml.rels").toString("utf8");
  const slides = [...pres.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map((m) => { const t = new RegExp(`Id="${m[1]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]; return [...(parts.get(`ppt/${t}`)?.toString("utf8") ?? "").matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join(" "); });
  assert.match(slides[0], /Qualitative findings/, "the title slide first");
  assert.match(slides[1], /Method and limitations/, `the deck's first section is Method too: ${slides.map((s) => s.slice(0, 25)).join(" | ")}`);
  ok("the qualitative report (.docx) and deck (.pptx): both open with the Method section — one saved order, applied identically (heading order / slide order read from the XML)");
  await page.context().close();
}

/* ================================================================================================ #19 */
if (SECTIONS.has("19")) {
  console.log("\n#19 LAYOUT — three panes, every viewport");
  const measure = (page) => page.evaluate(() => {
    const v = document.querySelector('[data-testid="intelligent-view"]');
    const main = document.querySelector('[data-testid="iq-main"]').getBoundingClientRect();
    const insp = document.querySelector('[data-testid="iq-inspector"]');
    return { iw: innerWidth, sw: document.documentElement.scrollWidth, root: v.getBoundingClientRect().width, main: Math.round(main.width), mainLeft: main.left, structure: v.getAttribute("data-structure"), inspector: v.getAttribute("data-inspector"), inspW: insp ? Math.round(insp.getBoundingClientRect().width) : 0, logSw: document.querySelector('[data-testid="iq-log"]').scrollWidth, logCw: document.querySelector('[data-testid="iq-log"]').clientWidth };
  });
  const open = async (w, h, rtl = false) => {
    const page = await studioPage(null, `layout-${w}`, { width: w, height: h });
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl"; });
    await switchMode(page, "intelligent");
    await page.waitForSelector('[data-testid="intelligent-view"]');
    await page.waitForTimeout(400);
    return page;
  };
  for (const [w, h] of [[1440, 900], [1366, 768], [1280, 800], [1024, 768]]) {
    const page = await open(w, h);
    const m = await measure(page);
    assert.ok(m.sw <= m.iw, `${w}: no sideways scroll (${m.sw} > ${m.iw})`);
    assert.ok(m.logSw <= m.logCw + 1, `${w}: the conversation does not scroll sideways`);
    assert.ok(m.main >= 600 || m.root < 680, `${w}: the conversation is ${m.main} px`);
    if (w >= 1280) assert.deepEqual([m.structure, m.inspector], ["docked", "docked"], `${w}: both panes docked`);
    if (w === 1024) {
      assert.equal(m.inspector, "docked");
      assert.equal(m.structure, "rail", "1024: the structure pane gives way to a rail");
      await page.click('[data-testid="iq-rail-structure"]');
      await page.waitForSelector('[data-testid="iq-drawer-structure"]');
      const after = await measure(page);
      assert.equal(after.main, m.main, "the drawer takes no width from the conversation");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="iq-drawer-structure"]', { state: "detached" });
    }
    ok(`${w}×${h}: conversation ${m.main} px (structure ${m.structure}, inspector ${m.inspector} ${m.inspW} px), no sideways scroll${w === 1024 ? " — was 418 px; the structure rail opens a drawer over it, Escape closes" : ""}`);
    if (w === 1280) {
      // the inspector's splitter by keyboard; the width is remembered across a reload
      await page.focus('[data-testid="iq-splitter-inspector"]');
      const w0 = Number(await page.getAttribute('[data-testid="iq-splitter-inspector"]', "aria-valuenow"));
      await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(150);
      const w1 = Number(await page.getAttribute('[data-testid="iq-splitter-inspector"]', "aria-valuenow"));
      assert.ok(w1 > w0, `ArrowLeft widens the inspector (${w0} → ${w1})`);
      const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("rescript.intelligent") ?? "{}"); } catch { return {}; } });
      assert.ok(stored.inspector === w1 || Math.abs(stored.inspector - w1) <= 32, `remembered (${stored.inspector})`);
      await page.focus('[data-testid="iq-splitter-structure"]');
      await page.keyboard.press("Home");
      await page.waitForTimeout(150);
      assert.equal(Number(await page.getAttribute('[data-testid="iq-splitter-structure"]', "aria-valuenow")), 180);
      for (let i = 0; i < 3; i++) { try { await page.reload({ waitUntil: "networkidle", timeout: 120000 }); await page.waitForSelector(".menubar", { timeout: 60000 }); break; } catch (e) { if (i === 2) throw e; await sleep(6000); } }
      await switchMode(page, "intelligent");
      await page.waitForSelector('[data-testid="iq-splitter-inspector"]');
      const w2 = Number(await page.getAttribute('[data-testid="iq-splitter-inspector"]', "aria-valuenow"));
      assert.ok(Math.abs(w2 - w1) <= 32, `after a reload the inspector is ${w2} (was ${w1})`);
      ok(`1280: splitters by keyboard (inspector ${w0} → ${w1} px, structure to its minimum with Home), widths remembered across a reload`);
    }
    await page.context().close();
  }
  for (const [w, h] of [[768, 1024], [390, 844]]) {
    const page = await open(w, h);
    const m = await measure(page);
    assert.ok(m.sw <= m.iw, `${w}: no sideways scroll (${m.sw} > ${m.iw})`);
    if (w === 768) assert.deepEqual([m.structure, m.inspector], ["rail", "rail"]);
    else assert.deepEqual([m.structure, m.inspector], ["hidden", "hidden"]);
    await page.click('[data-testid="iq-toggle-inspector"]');
    await page.waitForSelector('[data-testid="iq-inspector"][data-drawer="1"]');
    assert.ok((await measure(page)).sw <= w, `${w}: the drawer does not widen the page`);
    ok(`${w}×${h} (tablet / phone): ${w === 768 ? "both panes as rails" : "no rails"}, conversation ${m.main} px, the Panel button opens the inspector as a drawer, no sideways scroll`);
    await page.context().close();
  }
  {
    const page = await open(1024, 768, true);
    const m = await measure(page);
    assert.ok(m.sw <= m.iw);
    const rail = await page.$eval('[data-testid="iq-rail-structure"]', (e) => e.getBoundingClientRect().left);
    const main = await page.$eval('[data-testid="iq-main"]', (e) => e.getBoundingClientRect().left);
    assert.ok(rail > main, "RTL: the structure rail is on the right of the conversation");
    ok("RTL at 1024: mirrored (the structure rail on the right), conversation ≥ 600 px, no sideways scroll");
    await page.context().close();
  }
}

await browser.close();
assert.deepEqual(allErrors, [], "no page errors");
console.log(`\nALL ENGINE 15–19 CHECKS PASSED (${passed})`);
