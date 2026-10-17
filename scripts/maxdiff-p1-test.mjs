/**
 * MAXDIFF IN THE RUNTIME — MaxDiff audit 2026-10-17 (MD-P1).
 *
 * A three-version MaxDiff design from the optimized generator, fielded in the runtime preview:
 *
 *   DESKTOP  every task shows exactly THIS respondent's version's items, in the order rolled from
 *            their seed; "Task n of N"; required → a message naming what is missing; picking the
 *            same item as best and worst is prevented with a visible message and the other side is
 *            cleared; a selection can be changed; Next/Back keeps every answer; a reload keeps the
 *            seed, version, order and answers; completion; the stored answer flattens to the
 *            version, per-task best / worst / shown order, and the long choice file has one row per
 *            item shown with its position and best / worst flags
 *   MOBILE   390×844: no horizontal scroll of the page or of any task table, tap targets ≥ 36px,
 *            answer every task and complete
 *   METHOD   best-only with custom labels, instructions and a practice task: no worst column,
 *            the labels and instructions shown, "Practice task (not counted)" first, completes
 *
 *   node scripts/maxdiff-p1-test.mjs      (runtime on :3001; set RUNTIME_URL to override)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { maxdiffPlugin } from "../packages/designs/dist/index.js";
import { designVersionFor, shuffleAlternatives, flattenVariables, createResponseState } from "../packages/engine/dist/index.js";
import { maxdiffChoiceRows } from "../packages/exporters/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const ITEMS = ["Battery life", "Camera quality", "Screen size", "Price", "Weight", "Storage", "Water resistance", "Charging speed"];

function surveyWith(id, config, seed) {
  const design = maxdiffPlugin.generate(config, seed);
  assert.deepEqual(maxdiffPlugin.validateConfig(config), [], "the configuration is valid");
  const def = {
    meta: { id, code: "MDP1", title: "Phone features", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", variant: "maxdiff.best_worst", required: true,
        text: "Which feature matters most, and which least?", settings: { designRef: "d1" } },
      { id: "q_after", code: "Q2", variableName: "AFTER", type: "text", variant: "text.single_line", required: false, text: "Anything else?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
    designs: [{ id: "d1", kind: "maxdiff", name: "Features", version: 1, seed, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
    logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  };
  return { def, design, parsed: SurveyDefinition.parse(def) };
}

const STD = surveyWith("md_p1", { items: ITEMS, itemsPerTask: 4, tasks: 4, versions: 3, balance: "optimized" }, 20261017);
const Q = STD.parsed.questions[0];
const TASKS = ["1", "2", "3", "4"];

const browser = await chromium.launch();
const pageErrors = [];

/** what the screen shows, per task: item index, label, position, which radios are checked */
const readTasks = (page) => page.evaluate(() => {
  const out = {};
  for (const tr of document.querySelectorAll('[data-qid="q_md"] [data-testid="md-item"]')) {
    const t = tr.getAttribute("data-task");
    (out[t] ??= []).push({
      item: tr.getAttribute("data-item"), position: tr.getAttribute("data-position"),
      label: tr.querySelector("td.rowlabel").textContent.trim(),
      best: tr.querySelector('input[name$="_best"]')?.checked ?? false,
      worst: tr.querySelector('input[name$="_worst"]')?.checked ?? null,
    });
  }
  return out;
});
const stateOf = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));
const next = async (page) => { await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(300); };
const back = async (page) => { await page.click('[data-testid="rs-back"]'); await page.waitForTimeout(300); };
const radio = (t, item, side) => `[data-qid="q_md"] tr[data-testid="md-item"][data-task="${t}"][data-item="${item}"] input[name$="_${side}"]`;

/** the screen must be exactly this respondent's version, in their order */
function checkScreen(design, shown, seed, where, tasks = TASKS) {
  const version = designVersionFor(Q, design.rows, seed);
  for (const t of tasks) {
    const expected = shuffleAlternatives(design.rows.filter((r) => String(r.version) === version && String(r.task) === t), seed, `q_md:${t}`);
    assert.deepEqual(shown[t].map((r) => r.item), expected.map((r) => String(r.item_index)), `${where}: task ${t} items and order`);
    shown[t].forEach((r, i) => {
      assert.equal(r.position, String(i + 1));
      assert.equal(r.label, expected[i].item_label, `${where}: task ${t} label`);
    });
  }
  return version;
}

/* ============================================================ DESKTOP */
console.log("\nDESKTOP — the respondent's version and order; best ≠ worst; change; Back; reload; complete; export");
const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
desk.on("pageerror", (e) => pageErrors.push(String(e)));
await desk.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(desk, { definition: STD.def }, { selector: '[data-qid="q_md"] [data-testid="md-task-1"]' });
let st = await stateOf(desk);
const seed = st.seed;
let shown = await readTasks(desk);
const version = checkScreen(STD.design, shown, seed, "first render");
assert.equal((await desk.textContent('[data-testid="md-task-1"]')).trim(), "Task 1 of 4");
assert.equal(await desk.$$eval('[data-qid="q_md"] [data-testid="md-item"]', (e) => e.length), 4 * 4, "4 tasks × 4 items");
ok(`version ${version} of 3 from seed ${seed}: each task shows that version's 4 items in the rolled order; "Task 1 of 4"`);

await next(desk);
assert.ok(await desk.$('[data-qid="q_md"]'), "still on the task page");
assert.match(await desk.evaluate(() => document.body.innerText), /required/i);
ok("Next with nothing chosen is refused (required)");

/* best = worst: pick item A best, then item A worst → A becomes worst, best is cleared, and the task says why */
const [a, b] = [shown["1"][0], shown["1"][1]];
await desk.click(radio("1", a.item, "best"));
await desk.click(radio("1", a.item, "worst"));
const notice = await desk.textContent('[data-testid="md-conflict-1"]');
assert.match(notice, /can't be both Most and Least/);
assert.match(notice, new RegExp(a.label));
st = await stateOf(desk);
assert.deepEqual(st.answers.q_md["1"], { worst: a.item }, "the new pick wins, the other side is cleared");
ok(`best = worst prevented: “${notice.trim()}”`);

/* change the selection: best on B; the notice goes */
await desk.click(radio("1", b.item, "best"));
st = await stateOf(desk);
assert.deepEqual(st.answers.q_md["1"], { worst: a.item, best: b.item });
assert.equal(await desk.$('[data-testid="md-conflict-1"]'), null, "the message clears once the conflict is resolved");
await desk.click(radio("1", shown["1"][2].item, "best"));
st = await stateOf(desk);
assert.equal(st.answers.q_md["1"].best, shown["1"][2].item, "best moved to another item");
ok("a selection can be changed; one best and one worst per task");

/* partial: tasks 2–4 untouched */
await next(desk);
assert.match(await desk.evaluate(() => document.body.innerText), /Please choose a best and a worst for every task/);
ok("a partial answer names what is missing");

/* answer every task: best = first on screen, worst = last */
for (const t of ["2", "3", "4"]) {
  await desk.click(radio(t, shown[t][0].item, "best"));
  await desk.click(radio(t, shown[t][3].item, "worst"));
}
st = await stateOf(desk);
const answers = st.answers.q_md;
for (const t of TASKS) assert.notEqual(answers[t].best, answers[t].worst);

await next(desk);
await desk.waitForSelector('[data-qid="q_after"]');
await back(desk);
await desk.waitForSelector('[data-qid="q_md"] [data-testid="md-task-1"]');
const afterBack = await readTasks(desk);
checkScreen(STD.design, afterBack, seed, "after Back");
for (const t of TASKS) {
  assert.deepEqual(afterBack[t].filter((r) => r.best).map((r) => r.item), [answers[t].best], `task ${t} best kept`);
  assert.deepEqual(afterBack[t].filter((r) => r.worst).map((r) => r.item), [answers[t].worst], `task ${t} worst kept`);
}
ok("Back: same items, same order, every best and worst still selected");

/* reload: the preview keeps its answers AND its seed in sessionStorage */
await next(desk);
await desk.waitForSelector('[data-qid="q_after"]');
await desk.reload({ waitUntil: "networkidle" });
await sendPreview(desk, { definition: STD.def }, { selector: "[data-qid]" });
const reloaded = await stateOf(desk);
assert.equal(reloaded.seed, seed, "the reload kept the seed (and with it the version and every order)");
assert.deepEqual(reloaded.answers.q_md, answers, "the reload kept the answers");
if (!(await desk.$('[data-qid="q_md"]'))) { await back(desk); await desk.waitForSelector('[data-qid="q_md"] [data-testid="md-task-1"]'); }
const afterReload = await readTasks(desk);
checkScreen(STD.design, afterReload, seed, "after reload");
for (const t of TASKS) assert.deepEqual(afterReload[t].filter((r) => r.best).map((r) => r.item), [answers[t].best]);
ok("reload: same seed, version, order and answers");

/* the stored answer, flattened and as the long choice file */
const state = createResponseState(STD.parsed, { sessionId: "S1", seed });
state.respondentId = "R1";
state.answers = reloaded.answers;
const flat = flattenVariables(STD.parsed, state);
assert.equal(flat.MD_VERSION, version);
for (const t of TASKS) {
  assert.equal(String(flat[`MD_T${t}_BEST`]), answers[t].best);
  assert.equal(String(flat[`MD_T${t}_WORST`]), answers[t].worst);
  assert.equal(flat[`MD_T${t}_ORDER`], shown[t].map((r) => r.item).join("|"), `task ${t}: the exported order is the one on screen`);
}
const long = maxdiffChoiceRows(STD.parsed, [state]);
assert.deepEqual(long.skipped, []);
assert.equal(long.rows.length, 4 * 4);
for (const t of TASKS) {
  const rows = long.rows.filter((r) => r.TASK === t);
  assert.deepEqual(rows.map((r) => String(r.ITEM_INDEX)), shown[t].map((r) => r.item), "shown items with their positions");
  assert.deepEqual(rows.map((r) => r.POSITION), [1, 2, 3, 4]);
  assert.ok(rows.every((r) => r.VERSION === version && r.QUESTION === "MD" && r.RESP_ID === "R1"));
  assert.equal(String(rows.find((r) => r.BEST === 1).ITEM_INDEX), answers[t].best);
  assert.equal(String(rows.find((r) => r.WORST === 1).ITEM_INDEX), answers[t].worst);
}
ok("export: MD_VERSION, per-task BEST / WORST / ORDER, and the long file (version, task, position, item, best, worst) match the screen");

if (await desk.$('[data-qid="q_md"]')) await next(desk);
await desk.waitForSelector('[data-qid="q_after"]');
await next(desk);
await desk.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });
ok("completes");

/* ============================================================ MOBILE */
console.log("\nMOBILE 390×844 — no horizontal scroll, tap targets, complete");
const mob = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
mob.on("pageerror", (e) => pageErrors.push(String(e)));
await mob.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(mob, { definition: { ...STD.def, meta: { ...STD.def.meta, id: "md_p1_mobile" } } }, { selector: '[data-qid="q_md"] [data-testid="md-task-1"]' });
const mSeed = (await stateOf(mob)).seed;
const mShown = await readTasks(mob);
checkScreen(STD.design, mShown, mSeed, "mobile");
const layout = await mob.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const wraps = [...document.querySelectorAll('[data-qid="q_md"] .rs-table-wrap')];
  return {
    vw, scrollW: document.documentElement.scrollWidth,
    tablesFit: wraps.every((w) => w.scrollWidth <= w.clientWidth + 1),
    inside: [...document.querySelectorAll('[data-qid="q_md"] [data-testid="md-item"]')].every((r) => { const b = r.getBoundingClientRect(); return b.left >= -1 && b.right <= vw + 1; }),
    tap: Math.min(...[...document.querySelectorAll('[data-qid="q_md"] .rs-md-pick')].map((l) => Math.min(l.getBoundingClientRect().height, l.getBoundingClientRect().width))),
  };
});
assert.ok(layout.scrollW <= layout.vw + 1, `page scrolls horizontally: ${layout.scrollW} > ${layout.vw}`);
assert.ok(layout.tablesFit, "a task table scrolls horizontally");
assert.ok(layout.inside, "an item row is clipped off-screen");
assert.ok(layout.tap >= 36, `tap target ${layout.tap}px`);
ok(`no horizontal scroll (${layout.scrollW}px in ${layout.vw}px, every task table fits); tap targets ${Math.round(layout.tap)}px`);
for (const t of TASKS) {
  await mob.tap(radio(t, mShown[t][1].item, "best"));
  await mob.tap(radio(t, mShown[t][2].item, "worst"));
}
const mAns = (await stateOf(mob)).answers.q_md;
for (const t of TASKS) assert.deepEqual(mAns[t], { best: mShown[t][1].item, worst: mShown[t][2].item });
await next(mob);
await mob.waitForSelector('[data-qid="q_after"]');
await next(mob);
await mob.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });
ok("tapping records best and worst per task; the survey completes on a phone");

/* ============================================================ METHOD OPTIONS */
console.log("\nBEST-ONLY + LABELS + INSTRUCTIONS + PRACTICE TASK");
const BO = surveyWith("md_p1_bo", {
  items: ITEMS, itemsPerTask: 4, tasks: 3, versions: 2, balance: "optimized",
  responseMode: "best_only", bestLabel: "Top pick", worstLabel: "Bottom", instructions: "Choose the one feature you value most in each set.",
  practiceTask: true,
}, 777);
const opt = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
opt.on("pageerror", (e) => pageErrors.push(String(e)));
await opt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(opt, { definition: BO.def }, { selector: '[data-qid="q_md"] [data-testid="md-task-0"]' });
const oSeed = (await stateOf(opt)).seed;
const oShown = await readTasks(opt);
checkScreen(BO.design, oShown, oSeed, "best-only", ["0", "1", "2", "3"]);
assert.equal(await opt.$$eval('[data-qid="q_md"] input[name$="_worst"]', (e) => e.length), 0, "no worst column");
assert.match(await opt.textContent('[data-qid="q_md"] [data-testid="md-table-1"] thead'), /Top pick/);
assert.doesNotMatch(await opt.textContent('[data-qid="q_md"] [data-testid="md-table-1"] thead'), /Bottom/);
assert.equal((await opt.textContent('[data-testid="md-instructions"]')).trim(), "Choose the one feature you value most in each set.");
assert.equal((await opt.textContent('[data-testid="md-task-0"]')).trim(), "Practice task (not counted)");
assert.equal((await opt.textContent('[data-testid="md-task-1"]')).trim(), "Task 1 of 3");
ok("best-only renders one column labelled “Top pick”, the instructions, and the practice task first");
for (const t of ["0", "1", "2"]) await opt.click(radio(t, oShown[t][0].item, "best"));
await next(opt);
assert.match(await opt.evaluate(() => document.body.innerText), /Please choose a best for task 3/);
await opt.click(radio("3", oShown["3"][0].item, "best"));
await next(opt);
await opt.waitForSelector('[data-qid="q_after"]');
const oState = createResponseState(BO.parsed, { sessionId: "S2", seed: oSeed });
oState.answers = (await stateOf(opt)).answers;
const oFlat = flattenVariables(BO.parsed, oState);
assert.ok("MD_T0_BEST" in oFlat && "MD_T3_BEST" in oFlat && !Object.keys(oFlat).some((k) => k.endsWith("_WORST")));
ok("best-only needs a best per task (named when missing), exports no worst, practice exported as T0");

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
await browser.close();
console.log(`\nMAXDIFF P1: ${passed} checks passed`);
