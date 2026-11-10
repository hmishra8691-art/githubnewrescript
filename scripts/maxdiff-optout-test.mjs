/**
 * MAXDIFF TASK OPT-OUTS (2026-11-10) — what a respondent sees and what is stored. Runtime on :3001 (/preview).
 *
 *   1  a design without opt-outs shows none (nothing changes for existing studies)
 *   2  a design with them shows one control under each set, apart from the items — never among them
 *   3  an opt-out answers the set: a required question moves on; it clears the set's best / worst, and a best or
 *      worst clears it; it can be undone
 *   4  what is stored, flattened and exported: the kind, with no best / worst for that set
 *   5  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { maxdiffPlugin } from "../packages/designs/dist/index.js";
import { flattenVariables, createResponseState } from "../packages/engine/dist/index.js";
import { maxdiffChoiceRows } from "../packages/exporters/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const ITEMS = ["Battery life", "Camera quality", "Screen size", "Price", "Weight", "Storage", "Water resistance", "Charging speed"];

function surveyWith(id, config, seed) {
  const design = maxdiffPlugin.generate(config, seed);
  assert.deepEqual(maxdiffPlugin.validateConfig(config), []);
  const def = {
    meta: { id, code: "MDO", title: "Phone features", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", variant: "maxdiff.best_worst", required: true, text: "Which feature matters most, and which least?", settings: { designRef: "d1" } },
      { id: "q_after", code: "Q2", variableName: "AFTER", type: "text", variant: "text.single_line", required: false, text: "Anything else?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_md"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
    designs: [{ id: "d1", kind: "maxdiff", name: "Features", version: 1, seed, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
    logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  };
  return { def, parsed: SurveyDefinition.parse(def) };
}
const BASE = { items: ITEMS, itemsPerTask: 4, tasks: 3, versions: 2, balance: "optimized" };
const PLAIN = surveyWith("md_plain", BASE, 20261110);
const OPT = surveyWith("md_opt", { ...BASE, optOutNone: true, optOutCannotChoose: true, optOutNoneLabel: "None of the above" }, 20261110);

const browser = await chromium.launch();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on("pageerror", (e) => errors.push(String(e)));
const stateOf = () => page.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));
const radio = (t, item, side) => `[data-qid="q_md"] tr[data-testid="md-item"][data-task="${t}"][data-item="${item}"] input[name$="_${side}"]`;
const itemsOf = (t) => page.$$eval(`[data-qid="q_md"] tr[data-testid="md-item"][data-task="${t}"]`, (rows) => rows.map((r) => ({ item: r.getAttribute("data-item"), label: r.querySelector("td.rowlabel").textContent.trim() })));

console.log("\n1 — a design without opt-outs shows none");
await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(page, { definition: PLAIN.def }, { selector: '[data-qid="q_md"] [data-testid="md-task-1"]' });
assert.equal(await page.$$eval('[data-testid^="md-optout"]', (e) => e.length), 0);
ok("no opt-out control on a standard MaxDiff");

console.log("\n2 — one control under each set, apart from the items");
await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(page, { definition: OPT.def }, { selector: '[data-qid="q_md"] [data-testid="md-optouts-1"]' });
for (const t of ["1", "2", "3"]) {
  assert.deepEqual(await page.$$eval(`[data-testid="md-optouts-${t}"] label`, (l) => l.map((x) => x.textContent.trim())), ["None of the above", "I cannot choose"]);
  const rows = await itemsOf(t);
  assert.equal(rows.length, 4, "the set still has its four items");
  assert.ok(!rows.some((r) => /none of the above|cannot choose/i.test(r.label)), "an opt-out is never listed among the items");
  const below = await page.evaluate((task) => { const table = document.querySelector(`[data-qid="q_md"] tr[data-task="${task}"]`).closest("table").getBoundingClientRect(); const o = document.querySelector(`[data-testid="md-optouts-${task}"]`).getBoundingClientRect(); return o.top >= table.bottom - 1; }, t);
  assert.ok(below, "the control sits under the set's table");
}
ok("each of the 3 sets shows “None of the above” and “I cannot choose” under its 4 items");

console.log("\n3 — an opt-out answers the set, replaces a choice, is replaced by one, and can be undone");
const s1 = await itemsOf("1");
await page.click(radio("1", s1[0].item, "best"));
await page.click(radio("1", s1[1].item, "worst"));
await page.click('[data-testid="md-optout-1-none"]');
assert.deepEqual((await stateOf()).answers.q_md["1"], { optOut: "none" }, "the opt-out replaces the set's best and worst");
assert.equal(await page.isChecked(radio("1", s1[0].item, "best")), false);
await page.click(radio("1", s1[2].item, "best"));
assert.deepEqual((await stateOf()).answers.q_md["1"], { best: s1[2].item }, "a best replaces the opt-out");
assert.equal(await page.isChecked('[data-testid="md-optout-1-none"]'), false);
await page.click('[data-testid="md-optout-1-none"]');
await page.click('[data-testid="md-optout-1-none"]');
assert.equal((await stateOf()).answers.q_md["1"], undefined, "unticking it leaves the set unanswered");
ok("choice → opt-out → choice → opt-out → undone: one answer per set at every step");

await page.click('[data-testid="md-optout-1-none"]');
await page.click('[data-testid="md-optout-2-cannot_choose"]');
await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(300);
assert.ok(await page.$('[data-qid="q_md"]'), "set 3 is still unanswered, so the required question holds");
assert.match(await page.evaluate(() => document.body.innerText), /Please choose a best and a worst for task 3/);
const s3 = await itemsOf("3");
await page.click(radio("3", s3[0].item, "best"));
await page.click(radio("3", s3[3].item, "worst"));
await page.click('[data-testid="rs-next"]');
await page.waitForSelector('[data-qid="q_after"]');
ok("two sets opted out + one chosen completes the required question; a missing set is still asked for");

console.log("\n4 — stored, flattened and exported");
const st = await stateOf();
assert.deepEqual(st.answers.q_md, { "1": { optOut: "none" }, "2": { optOut: "cannot_choose" }, "3": { best: s3[0].item, worst: s3[3].item } });
const state = createResponseState(OPT.parsed, { seed: st.seed, sessionId: "s1" });
state.answers = st.answers;
const flat = flattenVariables(OPT.parsed, state);
assert.equal(flat.MD_T1_OPTOUT, "none"); assert.equal(flat.MD_T2_OPTOUT, "cannot_choose"); assert.equal(flat.MD_T3_OPTOUT, undefined);
assert.equal(flat.MD_T1_BEST, undefined); assert.equal(flat.MD_T3_BEST, Number(s3[0].item)); assert.equal(flat.MD_T3_WORST, Number(s3[3].item));
const long = maxdiffChoiceRows(OPT.parsed, [state]).rows;
assert.equal(long.length, 12, "all three sets are in the choice file: 3 × 4 items");
assert.ok(long.filter((r) => String(r.TASK) === "1").every((r) => r.OPT_OUT === "none" && r.BEST === "" && r.WORST === ""));
assert.ok(long.filter((r) => String(r.TASK) === "2").every((r) => r.OPT_OUT === "cannot_choose"));
assert.equal(long.filter((r) => String(r.TASK) === "3" && r.BEST === 1).length, 1);
ok("answers, MD_T<n>_OPTOUT and the long choice file agree: the kind, and no best / worst for an opted-out set");

assert.deepEqual(errors, [], "no page errors");
ok("no page errors");
console.log(`\n${passed} passed`);
await browser.close();
