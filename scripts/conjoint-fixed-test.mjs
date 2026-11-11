/**
 * FIXED ALTERNATIVES IN A CBC (2026-11-10) — what a respondent sees and what is stored. Runtime on :3001 (/preview).
 *
 *   1  every task: the designed concepts (Option A, B, C), then the fixed alternatives under their own labels, then None
 *   2  a fixed alternative's unspecified attributes show "—"; its specified levels show
 *   3  choosing the "specify" alternative opens a text box; the task is not answered until it is filled; choosing
 *      something else removes the text
 *   4  stored and flattened: the alternative number and the typed text as its own variable
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { conjointPlugin } from "../packages/designs/dist/index.js";
import { flattenVariables, createResponseState } from "../packages/engine/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const config = { attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["$199", "$299", "$399"] }], tasks: 3, alternativesPerTask: 3, versions: 2, noneOption: true, method: "efficient", fixedAlternatives: ["My current phone", "Beta today | Brand: Beta; Price: $299", "Another phone [specify]"] };
assert.deepEqual(conjointPlugin.validateConfig(config), []);
const design = conjointPlugin.generate(config, 20261110);
const def = {
  meta: { id: "cbc_fixed", code: "CF", title: "Phones", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q_cbc", code: "Q1", variableName: "CBC", type: "conjoint_task", variant: "conjoint.cbc", required: true, text: "Which would you choose?", settings: { designRef: "d1" } },
    { id: "q_after", code: "Q2", variableName: "AFTER", type: "text", variant: "text.single_line", required: false, text: "Anything else?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_cbc"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
  designs: [{ id: "d1", kind: "conjoint", name: "Phones", version: 1, seed: 20261110, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};
const parsed = SurveyDefinition.parse(def);

const browser = await chromium.launch();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on("pageerror", (e) => errors.push(String(e)));
const stateOf = () => page.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));
const rowsOf = (t) => page.$$eval(`[data-qid="q_cbc"] tr[data-testid="cbc-alt"][data-task="${t}"]`, (rows) => rows.map((r) => ({ alt: r.getAttribute("data-alt"), fixed: r.getAttribute("data-fixed"), none: r.getAttribute("data-none"), label: r.querySelector("td.rowlabel").textContent.trim(), cells: [...r.querySelectorAll("td[data-label]")].map((c) => `${c.getAttribute("data-label")}=${c.textContent.trim()}`) })));

await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(page, { definition: def }, { selector: '[data-qid="q_cbc"] [data-testid="cbc-alt"]' });

console.log("\n1 — designed concepts, then the fixed alternatives, then None");
for (const t of ["1", "2", "3"]) {
  const rows = await rowsOf(t);
  assert.deepEqual(rows.map((r) => r.label), ["Option A", "Option B", "Option C", "My current phone", "Beta today", "Another phone", "None of these"], `task ${t}`);
  assert.deepEqual(rows.map((r) => r.fixed ?? (r.none ? "none" : "")), ["", "", "", "1", "2", "3", "none"]);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.alt).sort(), ["1", "2", "3"], "the designed concepts are the shuffled ones");
  assert.deepEqual(rows.slice(3).map((r) => r.alt), ["4", "5", "6", "7"]);
}
ok("every task: Option A–C, “My current phone”, “Beta today”, “Another phone”, None — fixed ones never shuffled in");

console.log("\n2 — what a fixed alternative shows");
{
  const rows = await rowsOf("1");
  assert.deepEqual(rows[3].cells, ["Brand=—", "Storage=—", "Price=—"]);
  assert.deepEqual(rows[4].cells, ["Brand=Beta", "Storage=—", "Price=$299"]);
  ok("no levels → dashes; “Beta today” shows Brand Beta and $299, and a dash for what it does not specify");
}

console.log("\n3 — the “specify” alternative");
await page.click('[data-testid="cbc-choose-1-4"]');
assert.equal(await page.$('[data-testid="cbc-other-1"]'), null, "no text box for an alternative that does not ask");
await page.click('[data-testid="cbc-choose-2-6"]');
await page.waitForSelector('[data-testid="cbc-other-2"]');
await page.click('[data-testid="cbc-choose-3-7"]');
await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(300);
assert.ok(await page.$('[data-qid="q_cbc"]'), "still on the page");
assert.match(await page.evaluate(() => document.body.innerText), /Task 2: please say what “Another phone” is/);
await page.fill('[data-testid="cbc-other-2"]', "A refurbished Delta");
assert.deepEqual((await stateOf()).answers.q_cbc, { "1": "4", "2": "6", "2_other": "A refurbished Delta", "3": "7" });
/* choosing something else in that task removes the text; choosing it again starts empty */
await page.click('[data-testid="cbc-choose-2-5"]');
assert.equal((await stateOf()).answers.q_cbc["2_other"], undefined);
assert.equal(await page.$('[data-testid="cbc-other-2"]'), null);
await page.click('[data-testid="cbc-choose-2-6"]');
assert.equal(await page.inputValue('[data-testid="cbc-other-2"]'), "");
await page.fill('[data-testid="cbc-other-2"]', "A refurbished Delta");
await page.click('[data-testid="rs-next"]');
await page.waitForSelector('[data-qid="q_after"]');
ok("the text box appears only for that alternative, is required once it is chosen, and goes when the choice changes");

console.log("\n4 — stored and flattened");
const st = await stateOf();
const state = createResponseState(parsed, { seed: st.seed, sessionId: "s1" });
state.answers = st.answers;
const flat = flattenVariables(parsed, state);
assert.deepEqual([flat.CBC_T1, flat.CBC_T2, flat.CBC_T3, flat.CBC_T2_OTHER], [4, 6, 7, "A refurbished Delta"]);
assert.match(String(flat.CBC_T1_ORDER), /^[123]\|[123]\|[123]\|4\|5\|6\|7$/);
ok("CBC_T<n> holds the alternative; CBC_T2_OTHER the typed words; the shown order ends 4|5|6|7");

assert.deepEqual(errors, [], "no page errors");
ok("no page errors");
console.log(`\n${passed} passed`);
await browser.close();
