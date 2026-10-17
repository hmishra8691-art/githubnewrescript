/**
 * CONJOINT (CBC) IN THE RUNTIME — conjoint audit 2026-10-17.
 *
 * An efficient, multi-version CBC design with a prohibition, a price attribute and a labelled None
 * option, fielded in the runtime preview:
 *
 *   DESKTOP  each task shows THIS respondent's version, in the order rolled from their seed, every
 *            cell the level of that design alternative; no prohibited concept on screen; options are
 *            labelled by position (Option A, B, C) while the stored answer names the DESIGN
 *            alternative; required → "Please answer"; the None option records alt = m + 1; Back keeps
 *            every choice and the order; a reload restores the same seed, version, order and choices;
 *            the stacked export (built from the stored state) puts each choice on the concept whose
 *            levels the respondent saw — by profile, not by position
 *   MOBILE   390×844: no horizontal scroll, every alternative a card whose levels are captioned with
 *            their attribute, tap targets usable; answer every task; complete
 *
 *   node scripts/conjoint-p2-test.mjs      (runtime on :3001; set RUNTIME_URL to override)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { conjointPlugin } from "../packages/designs/dist/index.js";
import { designVersionFor, shuffleAlternatives, stackedChoiceData, flattenVariables, createResponseState } from "../packages/engine/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const config = {
  method: "efficient",
  attributes: [
    { name: "Brand", levels: ["Apex", "Nova", "Zen"] },
    { name: "Screen", levels: ["6.1 in", "6.5 in", "6.9 in"] },
    { name: "Battery life", levels: ["1 day", "2 days", "3 days"] },
    { name: "Price", levels: ["$499", "$699", "$899"] },
  ],
  prohibitions: [{ a: { attribute: "Brand", level: "Zen" }, b: { attribute: "Price", level: "$899" } }],
  tasks: 3, alternativesPerTask: 3, noneOption: true, noneLabel: "I would not buy any of these", versions: 3,
};
const design = conjointPlugin.generate(config, 20261017);
assert.equal(design.rows.filter((r) => r.Brand === "Zen" && r.Price === "$899").length, 0, "the design itself has no prohibited concept");
const ATTRS = config.attributes.map((a) => a.name);

const def = {
  meta: { id: "cbc_p2", code: "CBC", title: "Phones", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q_cj", code: "Q1", variableName: "CJ", type: "conjoint_task", variant: "conjoint.cbc", required: true, text: "Which phone would you buy?", settings: { designRef: "d1" } },
    { id: "q_after", code: "Q2", variableName: "AFTER", type: "text", variant: "text.single_line", required: false, text: "Anything else?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cj"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
  designs: [{ id: "d1", kind: "conjoint", name: "Phones", version: 1, seed: 20261017, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};
const parsed = SurveyDefinition.parse(def);
const Q = parsed.questions[0];

const browser = await chromium.launch();
const pageErrors = [];

/** what the screen shows for every task: order of design alternatives, labels, cell texts */
const readTasks = (page) => page.evaluate(() => {
  const out = {};
  for (const tr of document.querySelectorAll('[data-qid="q_cj"] [data-testid="cbc-alt"]')) {
    const t = tr.getAttribute("data-task");
    (out[t] ??= []).push({
      alt: tr.getAttribute("data-alt"), position: tr.getAttribute("data-position"), none: tr.getAttribute("data-none") === "1",
      label: tr.querySelector("td.rowlabel").textContent.trim(),
      cells: Object.fromEntries([...tr.querySelectorAll("td[data-label]")].map((td) => [td.getAttribute("data-label"), td.textContent.trim()])),
      checked: tr.querySelector('input[type="radio"]').checked,
    });
  }
  return out;
});
const stateOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));
const next = async (page) => { await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(300); };
const back = async (page) => { await page.click('[data-testid="rs-back"]'); await page.waitForTimeout(300); };

/** the screen must be exactly this respondent's version, in their order, with the design's levels */
function checkScreen(shown, seed, where) {
  const version = designVersionFor(Q, design.rows, seed);
  for (const t of ["1", "2", "3"]) {
    const expected = shuffleAlternatives(design.rows.filter((r) => String(r.version) === version && String(r.task) === t), seed, `q_cj:${t}`);
    assert.deepEqual(shown[t].map((r) => r.alt), expected.map((r) => String(r.alt)), `${where}: task ${t} order`);
    shown[t].forEach((r, i) => {
      const d = expected[i];
      assert.equal(r.position, String(i + 1));
      if (Number(d.none_option) === 1) {
        assert.ok(r.none && r.label === config.noneLabel, `${where}: the None option is labelled from the design (${r.label})`);
        return;
      }
      assert.equal(r.label, `Option ${String.fromCharCode(65 + i)}`, "labelled by position, not by design number");
      for (const a of ATTRS) assert.equal(r.cells[a], String(d[a]), `${where}: task ${t} alt ${r.alt} ${a}`);
      assert.ok(!(r.cells.Brand === "Zen" && r.cells.Price === "$899"), "a prohibited concept reached the screen");
    });
  }
  return version;
}

/* ============================================================ DESKTOP */
console.log("\nDESKTOP — the respondent's version, order and levels; choose; None; Back; reload; export");
const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
desk.on("pageerror", (e) => pageErrors.push(String(e)));
await desk.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(desk, { definition: def }, { selector: '[data-qid="q_cj"] [data-testid="cbc-task-1"]' });
let st = await stateOf(desk);
const seed = st.seed;
let shown = await readTasks(desk);
const version = checkScreen(shown, seed, "first render");
ok(`version ${version} of 3 from seed ${seed}; every task in the rolled order with that alternative's levels; Option A/B/C; None labelled; no prohibited concept`);

await next(desk);
assert.match(await desk.evaluate(() => document.body.innerText), /This question is required\.|Please answer/, "required tasks must be answered");
assert.ok(await desk.$('[data-qid="q_cj"]'), "still on the task page");
ok("Next with nothing chosen is refused (required)");

/* choose: task 1 the SECOND option on screen, task 2 None, task 3 the FIRST — remembering the levels shown */
const pick = async (t, idx) => {
  const row = shown[t][idx];
  await desk.click(`[data-testid="cbc-choose-${t}-${row.alt}"]`);
  return row;
};
const picked = { "1": await pick("1", 1), "2": await pick("2", 3), "3": await pick("3", 0) };
st = await stateOf(desk);
assert.deepEqual(st.answers.q_cj, { "1": picked["1"].alt, "2": "4", "3": picked["3"].alt }, "stored answers name design alternatives");
assert.ok(picked["2"].none);
const distinct = ["1", "3"].some((t) => picked[t].alt !== picked[t].position);
console.log(`  note position ≠ design alternative for at least one pick: ${distinct}`);
ok(`stored answer = design alternative (task 1 shown at position 2 → alt ${picked["1"].alt}); None → alt 4`);

await next(desk);
await desk.waitForSelector('[data-qid="q_after"]');
await back(desk);
await desk.waitForSelector('[data-qid="q_cj"] [data-testid="cbc-task-1"]');
const afterBack = await readTasks(desk);
checkScreen(afterBack, seed, "after Back");
for (const t of ["1", "2", "3"]) {
  const checked = afterBack[t].filter((r) => r.checked).map((r) => r.alt);
  assert.deepEqual(checked, [String(st.answers.q_cj[t])], `task ${t} choice kept after Back`);
}
assert.equal(await desk.$$eval('[data-qid="q_cj"] tr.rs-cbc-chosen', (e) => e.length), 3, "chosen rows highlighted");
ok("Back: same order, same levels, every choice still selected");

/* reload: the preview keeps its answers AND its seed in sessionStorage */
await next(desk);
await desk.waitForSelector('[data-qid="q_after"]');
await desk.reload({ waitUntil: "networkidle" });
await sendPreview(desk, { definition: def }, { selector: "[data-qid]" });
const reloaded = await stateOf(desk);
assert.equal(reloaded.seed, seed, "the reload kept the seed (and with it the version and every order)");
assert.deepEqual(reloaded.answers.q_cj, st.answers.q_cj, "the reload kept the choices");
if (!(await desk.$('[data-qid="q_cj"]'))) { await back(desk); await desk.waitForSelector('[data-qid="q_cj"] [data-testid="cbc-task-1"]'); }
const afterReload = await readTasks(desk);
checkScreen(afterReload, seed, "after reload");
for (const t of ["1", "2", "3"]) assert.deepEqual(afterReload[t].filter((r) => r.checked).map((r) => r.alt), [String(st.answers.q_cj[t])]);
ok("reload: same seed, version, order and choices");

/* export, from the stored state: the choice belongs to the concept the respondent saw */
const state = createResponseState(parsed, { sessionId: "S1", seed });
state.answers = st.answers;
const stacked = stackedChoiceData(parsed, [{ sessionId: "S1", respondentId: "R1", seed, answers: st.answers }]);
assert.equal(stacked.rows.length, 3 * 4);
for (const t of ["1", "2", "3"]) {
  const chosen = stacked.rows.filter((r) => String(r.task) === t && r.chosen === 1);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].position, Number(picked[t].position), "the position it was shown at");
  if (picked[t].none) { assert.equal(chosen[0].none, 1); continue; }
  for (const a of ATTRS) assert.equal(chosen[0][a], picked[t].cells[a], `task ${t}: the exported concept is the one on screen (${a})`);
}
const flat = flattenVariables(parsed, state);
assert.equal(flat.CJ_VERSION, version);
assert.equal(flat.CJ_T1, Number(picked["1"].alt));
assert.equal(flat.CJ_T1_ORDER, shown["1"].map((r) => r.alt).join("|"));
ok("stacked export: each chosen row carries exactly the levels the respondent clicked on, its position and version; wide export has the order");

await desk.click('[data-testid="rs-next"]').catch(() => {});
await desk.waitForTimeout(300);
if (await desk.$('[data-qid="q_after"]')) await next(desk);
await desk.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });
ok("completes");

/* ============================================================ MOBILE */
console.log("\nMOBILE 390×844 — readable cards, no horizontal scroll, complete");
const mob = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
mob.on("pageerror", (e) => pageErrors.push(String(e)));
await mob.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(mob, { definition: { ...def, meta: { ...def.meta, id: "cbc_p2_mobile" } } }, { selector: '[data-qid="q_cj"] [data-testid="cbc-task-1"]' });
const mSeed = (await stateOf(mob)).seed;
const mShown = await readTasks(mob);
checkScreen(mShown, mSeed, "mobile");
const layout = await mob.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const rows = [...document.querySelectorAll('[data-qid="q_cj"] [data-testid="cbc-alt"]')];
  const cells = [...document.querySelectorAll('[data-qid="q_cj"] [data-testid="cbc-alt"]:not([data-none]) td[data-label]')];
  return {
    vw, scrollW: document.documentElement.scrollWidth,
    rowsInside: rows.every((r) => { const b = r.getBoundingClientRect(); return b.left >= -1 && b.right <= vw + 1; }),
    cellsInside: cells.every((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && b.left >= -1 && b.right <= vw + 1; }),
    captions: cells.every((c) => getComputedStyle(c, "::before").content.includes(c.getAttribute("data-label"))),
    headerHidden: [...document.querySelectorAll('[data-qid="q_cj"] table.rs-cbc thead')].every((h) => getComputedStyle(h).display === "none"),
    tap: Math.min(...[...document.querySelectorAll('[data-qid="q_cj"] .rs-cbc-pick')].map((l) => l.getBoundingClientRect().height)),
  };
});
assert.ok(layout.scrollW <= layout.vw + 1, `horizontal scroll: ${layout.scrollW} > ${layout.vw}`);
assert.ok(layout.rowsInside && layout.cellsInside, "an alternative or a level is clipped off-screen");
assert.ok(layout.captions, "each level is captioned with its attribute on a phone");
assert.ok(layout.headerHidden, "the stacked layout replaces the header row");
assert.ok(layout.tap >= 30, `tap target ${layout.tap}px`);
ok(`no horizontal scroll (${layout.scrollW}px in ${layout.vw}px); every level visible and captioned; tap targets ${Math.round(layout.tap)}px`);
for (const t of ["1", "2", "3"]) {
  const row = mShown[t][t === "2" ? 3 : 0];
  await mob.click(`[data-qid="q_cj"] tr[data-task="${t}"][data-alt="${row.alt}"] .rs-cbc-pick`);
}
const mAns = (await stateOf(mob)).answers.q_cj;
assert.deepEqual(mAns, { "1": mShown["1"][0].alt, "2": "4", "3": mShown["3"][0].alt });
await next(mob);
await mob.waitForSelector('[data-qid="q_after"]');
await next(mob);
await mob.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });
ok("tapping a card's Choose records that design alternative; the survey completes on a phone");

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
await browser.close();
console.log(`\nCONJOINT P2: ${passed} checks passed`);
