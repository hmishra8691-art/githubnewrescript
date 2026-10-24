/**
 * A DEFAULT / PIPED VALUE ON EVERY OPEN-ENDED FIELD (2026-10-24, client item
 * A63) — in the real Studio builder, the real runtime preview and the export.
 *
 *   · the builder shows a Default / piped value box under a Text Matrix row
 *     and a Constant Sum row (and on the question's State section), with the
 *     shared Insert piped text picker and a warning for a token that does not
 *     resolve;
 *   · {{Q1}} on a grid text cell and {{QAGE}} on a constant-sum row are stored
 *     on those fields;
 *   · the preview fills them with the RESOLVED values — no `{{…}}` anywhere on
 *     the page, no configuration box;
 *   · the respondent's edits replace them and survive Back / Next; the
 *     constant-sum total is computed from what is in the boxes;
 *   · the CSV export of the final response holds the final values;
 *   · a pipe that resolves to nothing leaves the field empty, with a test
 *     note in preview.
 *
 *   node scripts/open-end-default-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";
import { responsesToCSV } from "../packages/exporters/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const { page, ...rest } = await (async () => {
  for (let i = 1; ; i++) {
    try { return await openHarness(); } catch (e) {
      if (i >= 4) throw e;
      console.log(`  (retrying opening the Studio after: ${String(e.message ?? e).split("\n")[0]})`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
})();
const h = { page, ...rest };
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const settle = () => page.waitForTimeout(300);

const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Open-end defaults", version: "1.0" },
  questions: [
    base("q1", "Q1", "open_text", { text: "YOUR NAME" }),
    base("q_age", "QAGE", "numeric", { text: "YOUR AGE" }),
    base("q2", "Q2", "matrix_text", { text: "WHY", rows: [{ code: "r1", label: "Brand", flags: [], validation: [], required: false }, { code: "r2", label: "Price", flags: [], validation: [], required: false }], columns: [{ id: "c1", label: "Answer", responseType: "text", variableStem: "Q2", options: [], validation: [], readOnly: false }] }),
    base("q3", "Q3", "allocation", { text: "SPLIT 100", options: [{ code: "1", label: "Rent", flags: [] }, { code: "2", label: "Food", flags: [] }, { code: "3", label: "Fun", flags: [] }], settings: { readOnly: false, hidden: false, sumTarget: 100 } }),
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q_age"] },
    { type: "page", id: "p2", questionIds: ["q2", "q3"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

/** retry an action through a server restart (the supervisor brings it back within ~60 s) */
async function retry(what, fn, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      console.log(`  (retrying ${what} after: ${String(e.message ?? e).split("\n")[0]})`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

const openQuestion = async (qid, probe) => {
  await h.goTab("Questions");
  await page.waitForSelector(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.click(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.waitForSelector(probe, { timeout: 10000 });
};

/* ------------------------------------------------------------- 1. the builder */
await h.loadDef(FIXTURE);
await openQuestion("q2", '[data-testid="default-defaultValue-r1"]');
assert.equal(await page.inputValue('[data-testid="default-defaultValue-r1"]'), "", "empty by default");
assert.equal(await page.inputValue('[data-testid="default-defaultValue-r2"]'), "");
await page.fill('[data-testid="default-defaultValue-r1"]', "{{Q1}}");
await settle();
/* an unresolvable token is flagged as it is typed */
await page.fill('[data-testid="default-defaultValue-r2"]', "{{NOPE_NOT_HERE}}");
await settle();
await page.waitForSelector('[data-testid="default-defaultValue-r2-warning"]');
assert.match(await page.textContent('[data-testid="default-defaultValue-r2-warning"]'), /NOPE_NOT_HERE/);
assert.equal(await page.locator('[data-testid="default-defaultValue-r1-warning"]').count(), 0, "a token that resolves is not flagged");
await page.fill('[data-testid="default-defaultValue-r2"]', "");
await settle();
ok("Text Matrix: a Default / piped value box per row — empty by default, {{Q1}} accepted, an unknown token warned about");

/* constant sum: the piped-text picker inserts the token */
await openQuestion("q3", '[data-testid="default-defaultValue-1"]');
await page.click('[data-testid="default-defaultValue-1-pipe"]');
await page.waitForSelector('[data-testid="pipe-menu"]');
await page.fill('[data-testid="pipe-search"]', "QAGE");
await page.waitForSelector('[data-testid="pipe-item"][data-token^="{{QAGE"]');
await page.click('[data-testid="pipe-item"][data-token^="{{QAGE"] >> nth=0');
await settle();
const ageToken = await page.inputValue('[data-testid="default-defaultValue-1"]');
assert.match(ageToken, /^\{\{QAGE[^}]*\}\}$/, `the picker inserted the token: ${ageToken}`);
ok(`Constant Sum: a Default amount box per row; Insert piped text put ${ageToken} in it`);

/* the question's own State box is the same component */
const head = '[data-testid="psec-head-state"]';
if (await page.$(head)) {
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") await page.click(head);
  await page.waitForSelector('[data-testid="question-default-value"]');
  assert.ok(await page.$('[data-testid="question-default-value-pipe"]'), "the question-level box has the picker too");
  ok("Properties → State → Default / piped value is the same box, with the Insert piped text picker");
}

const def = await h.readDef();
const q = (id) => def.questions.find((x) => x.id === id);
assert.equal(q("q2").rows[0].defaultValue, "{{Q1}}");
assert.equal(q("q2").rows[1].defaultValue, undefined, "a cleared box stores nothing");
assert.equal(q("q3").options[0].defaultValue, ageToken);
assert.equal(q("q3").options[1].defaultValue, undefined);
ok("stored on the fields themselves: Q2 row r1 = {{Q1}}, Q3 row 1 = the QAGE token; everything else untouched");

/* ------------------------------------------------------------- 2. the preview */
const cell = (pv, row) => pv.locator(`[data-qid="q2"] tr[data-rs-el="row"][data-rs-id="${row}"] input`);
const amount = (pv, code) => pv.locator(`[data-qid="q3"] .rs-alloc-row[data-rs-id="${code}"] input`);
const toPage2 = async (pv, name, age) => {
  await pv.fill('[data-rs-el="question"][data-rs-id="q1"] input, [data-rs-el="question"][data-rs-id="q1"] textarea', name);
  if (age !== null) await pv.fill('[data-rs-el="question"][data-rs-id="q_age"] input', String(age));
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-qid="q2"]', { timeout: 15000 });
  await pv.waitForTimeout(400);
};

let pv = await retry("opening the preview", () => openPreview(h.browser, RUNTIME, { definition: def }));
await toPage2(pv, "Ann", 40);
assert.equal(await cell(pv, "r1").inputValue(), "Ann", "the grid text cell shows the resolved {{Q1}}");
assert.equal(await cell(pv, "r2").inputValue(), "", "a row with no default stays empty");
assert.equal(await amount(pv, "1").inputValue(), "40", "the constant-sum row shows the resolved age");
assert.equal(await amount(pv, "2").inputValue(), "");
const text = await pv.evaluate(() => document.body.innerText);
assert.ok(!text.includes("{{"), "no piping syntax anywhere on the respondent's page");
assert.equal(await pv.locator('[data-testid^="default-"]').count(), 0, "no configuration box in the runtime");
assert.match(await pv.textContent('[data-qid="q3"] .rs-alloc-total'), /Total: 40 \/ 100/, "the total counts the pre-filled amount");
assert.deepEqual(await h.answerOf(pv, "q2"), { r1: "Ann" });
assert.deepEqual(await h.answerOf(pv, "q3"), { 1: 40 });
ok("preview: the grid cell starts as “Ann” and the constant-sum row as 40 — resolved, no {{…}}, no box; the total counts it");

/* the respondent overwrites and adds; Back / Next keeps their values */
await cell(pv, "r1").fill("Annie's brand");
await amount(pv, "1").fill("30");
await amount(pv, "2").fill("70");
await amount(pv, "2").blur();
await pv.waitForTimeout(300);
assert.match(await pv.textContent('[data-qid="q3"] .rs-alloc-total'), /Total: 100 \/ 100/);
await pv.click('[data-testid="rs-back"]');
await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q1"]');
await pv.click('[data-testid="rs-next"]');
await pv.waitForSelector('[data-qid="q2"]');
await pv.waitForTimeout(400);
assert.equal(await cell(pv, "r1").inputValue(), "Annie's brand", "the respondent's edit stands");
assert.equal(await amount(pv, "1").inputValue(), "30");
assert.equal(await amount(pv, "2").inputValue(), "70");
ok("the respondent edits the pre-filled values; Back and Next keep their edits (the default is never written again)");

/* submit; the export holds the final values */
await pv.click('[data-testid="rs-next"]');
await pv.waitForFunction(() => { const s = window.__rescriptState; return !!s && (s.status === "complete" || s.completed || /thank/i.test(document.body.innerText)); }, null, { timeout: 15000 }).catch(() => {});
const state = await pv.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState)));
assert.deepEqual(state.answers.q2, { r1: "Annie's brand" });
assert.deepEqual(state.answers.q3, { 1: 30, 2: 70 });
const csv = responsesToCSV(SurveyDefinition.parse(def), [state]);
const [header, row] = csv.trim().split("\n");
const cols = header.split(",");
const val = (name) => row.split(",")[cols.indexOf(name)];
const q2r1 = cols.find((c) => /^Q2.*r1/i.test(c));
const q3c1 = cols.find((c) => /^Q3.*1$/i.test(c));
const q3c2 = cols.find((c) => /^Q3.*2$/i.test(c));
assert.ok(q2r1 && q3c1 && q3c2, `export columns: ${header}`);
assert.equal(val(q2r1), "Annie's brand");
assert.equal(val(q3c1), "30");
assert.equal(val(q3c2), "70");
assert.ok(!csv.includes("{{"), "no piping syntax in the export");
await pv.close();
ok(`the CSV export holds the final values (${q2r1}=Annie's brand, ${q3c1}=30, ${q3c2}=70) — never the {{…}} configuration`);

/* ------------------------------------------------------------- 3. unresolved */
pv = await retry("opening the preview", () => openPreview(h.browser, RUNTIME, { definition: def }));
await toPage2(pv, "", null);
assert.equal(await cell(pv, "r1").inputValue(), "", "{{Q1}} with Q1 unanswered: the cell starts empty");
assert.equal(await amount(pv, "1").inputValue(), "");
await pv.waitForSelector('[data-testid="rs-default-unresolved"]');
const outsideNote = await pv.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('[data-testid="rs-default-unresolved"]').forEach((n) => n.remove()); return c.innerText; });
assert.ok(!outsideNote.includes("{{"), "the syntax appears only inside the preview's test note, never in a field");
assert.match(await pv.textContent('[data-qid="q2"] [data-testid="rs-default-unresolved"]'), /Brand.*\{\{Q1\}\}/);
assert.equal(await h.answerOf(pv, "q2"), undefined, "nothing was written");
await pv.close();
ok("an unresolved pipe leaves the field empty; preview lists it in a test note (the live link draws no note — programmerView is absent there)");

/* ------------------------------------------------------------- 4. no default = no change */
pv = await retry("opening the preview", () => openPreview(h.browser, RUNTIME, { definition: FIXTURE }));
await toPage2(pv, "Ann", 40);
assert.equal(await cell(pv, "r1").inputValue(), "");
assert.equal(await amount(pv, "1").inputValue(), "");
assert.equal(await h.answerOf(pv, "q2"), undefined);
assert.equal(await h.answerOf(pv, "q3"), undefined);
assert.equal(await pv.locator('[data-testid="rs-default-unresolved"]').count(), 0);
await pv.close();
ok("without a default nothing changes: empty fields, no answer written, no note");

console.log(`\n${passed} checks passed`);
await h.close();
