/**
 * THE CONJOINT SUITE, END TO END (F4, 2026-10-22).
 *
 *   STUDIO (Intelligent Mode, the stand-in model through the route's test seam)
 *     1  "Make a rating-based conjoint with 4 attributes" (none named) → a question back, nothing proposed
 *     2  the attributes given → create_conjoint cva: the proposal states the measured D-efficiency; Apply → a CVA design
 *     3  a CBC, then "add a none option as dual response" → update_conjoint dualResponse: the None rows go, the
 *        follow-up is configured, nothing else changes
 *     4  a menu with a one-of support section; "run the menu simulator with the premium bundle at ₹499" →
 *        simulate_conjoint: the scenario is checked against the menu and saved; the tasks are unchanged
 *   RUNTIME (the preview of the applied survey)
 *     5  the CVA tasks of this respondent's version, each profile with a 0–10 scale; ratings recorded
 *     6  the dual-response CBC: the follow-up appears only after a choice; yes / no recorded beside the choice
 *     7  the menu's section behaves as one-of (picking the second support level drops the first); completes
 *     8  the recorded answers flatten to the documented columns (CVA_T<n>, _T<n>_BUY, the menu's 0/1)
 *   ESTIMATION AND SIMULATOR (in-process, the real analytics over synthetic respondents with known utilities
 *   answering the applied designs — the Data Analytics routes need the database, which this suite does not)
 *     9  CVA: per-respondent OLS recovers the planted part-worths; the CBC's dual coding recovers its None;
 *        the menu model runs the Intelligent-Mode scenario (the ₹499 bundle) from the design; Excel / PowerPoint
 *        of the simulator are valid files
 *
 *   node scripts/conjoint-suite-test.mjs     (Studio :3000 with AI_API_URL=fake:, runtime :3001; packages built)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { designVersionFor, designRowsFor, flattenVariables, createResponseState, cvaTasksFor } from "../packages/engine/dist/index.js";
import { buildDataset, runAnalysis } from "../packages/analytics/dist/index.js";
import { buildSimulatorXlsx, buildSimulatorPptx, checkOfficeFile } from "../packages/analytics/dist/export/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const CVA_ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["5 in", "6 in"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["₹14,999", "₹19,999", "₹24,999"] }];
const CBC_ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["₹14,999", "₹19,999", "₹24,999"] }];
const MENU = [{ name: "Data pack", prices: ["₹99", "₹149", "₹199"] }, { name: "Insurance", prices: ["₹149", "₹199", "₹249"] }, { name: "Streaming", prices: ["₹199", "₹299"] }, { name: "Cloud", prices: ["₹49", "₹99"] }, { name: "Basic support", prices: ["₹49", "₹79"] }, { name: "Priority support", prices: ["₹99", "₹149"] }];

const SURVEY = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "PH", title: "Phones", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{ id: "q_own", code: "Q1", variableName: "OWN", type: "single_select", variant: "single_select.radio", required: true, text: "Do you own a smartphone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q_own"] }, { type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});

const browser = await chromium.launch();

/* ============================================================ STUDIO */
console.log("\nSTUDIO — the conjoint suite from sentences");
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  return JSON.parse(json);
};
const TURNS = '[data-testid="cp-turn"]';
const ask = async (text, reply) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), [reply]);
  const k = (await page.$$(TURNS)).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 90000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 60000 });
  return { body, card: (await page.$$(TURNS)).at(-1) };
};
const result = (body, op) => (body.validation?.results ?? []).find((r) => r.op === op);
const apply = async () => {
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(800);
  return readDef();
};
const designOf = (def, q) => def.designs.find((d) => d.id === q.settings?.designRef);
const byVar = (def, v) => def.questions.find((q) => q.variableName === v);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* 1 */
{
  const { body, card } = await ask("make a rating-based conjoint with 4 attributes", { kind: "clarify", reply: "To build the rating-based conjoint I need the attributes.", questions: ["What are the four attributes and their levels?"] });
  assert.equal(body.reply?.kind, "clarify");
  assert.equal(body.context?.methods, true, "the methods guide went with the request");
  assert.equal(body.validation, null);
  assert.ok(await card.$('[data-testid="cp-clarify"]'));
  ok("a rating-based conjoint with no attributes named → a question back (methods guide sent), nothing proposed");
}

/* 2 */
let def;
{
  const { body } = await ask("Brand (Alpha, Beta, Gamma), screen (5 in, 6 in), battery (1 day, 2 days, 3 days), price (₹14,999, ₹19,999, ₹24,999)", { kind: "proposal", reply: "Added a rating-based conjoint (CVA).", actions: [{ op: "create_conjoint", ref: "CVA", method: "cva", attributes: CVA_ATTRS }] });
  const r = result(body, "create_conjoint");
  assert.ok(r?.ok, JSON.stringify(body.validation).slice(0, 600));
  assert.match(r.description, /rating-based conjoint \(CVA\).*profiles rated 0–10 per version.*D-optimal \(exchange\): D-efficiency \d+(\.\d)?% per version/);
  def = await apply();
  const q = byVar(def, "CVA");
  assert.equal(q.variant, "conjoint.cva");
  assert.equal(designOf(def, q).kind, "cva");
  ok(`create_conjoint cva → measured design applied (${r.description.match(/D-efficiency [^;]+/)[0]})`);
}

/* 3 */
{
  const { body } = await ask("Add a choice-based conjoint with brand (Alpha, Beta, Gamma), storage (64 GB, 128 GB, 256 GB) and price (₹14,999, ₹19,999, ₹24,999), with a None option", { kind: "proposal", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "CBC", method: "cbc", attributes: CBC_ATTRS, none: true, tasks: 8, versions: 4 }] });
  assert.ok(result(body, "create_conjoint")?.ok);
  const before = await apply();
  assert.ok(designOf(before, byVar(before, "CBC")).file.rows.some((r) => Number(r.none_option) === 1));
  const { body: b2 } = await ask("add a none option as dual response", { kind: "proposal", reply: "The CBC now asks “would you actually buy it?” after each choice.", actions: [{ op: "update_conjoint", target: "CBC", dualResponse: true }] });
  const r = result(b2, "update_conjoint");
  assert.ok(r?.ok, JSON.stringify(b2.validation).slice(0, 600));
  assert.match(r.description, /the None alternative is replaced by the dual-response question/);
  def = await apply();
  const d = designOf(def, byVar(def, "CBC"));
  assert.equal(d.config.dualResponseNone, true);
  assert.ok(!d.file.rows.some((x) => Number(x.none_option) === 1));
  assert.deepEqual(byVar(def, "CVA"), byVar(before, "CVA"), "the CVA is untouched");
  ok("“add a none option as dual response” → update_conjoint dualResponse: None rows removed, follow-up configured, nothing else changed");
}

/* 4 */
{
  const { body } = await ask("Add a menu-based conjoint: data pack, insurance, streaming, cloud, and one support level (basic or priority)", { kind: "proposal", reply: "Added the menu.", actions: [{ op: "create_conjoint", ref: "PLAN", method: "menu", items: MENU, tasks: 6, versions: 3, exclusiveGroups: [{ name: "Support", items: ["Basic support", "Priority support"] }] }] });
  assert.ok(result(body, "create_conjoint")?.ok, JSON.stringify(body.validation).slice(0, 600));
  const before = await apply();
  const { body: b2 } = await ask("run the menu simulator with the premium bundle at ₹499", { kind: "proposal", reply: "Saved the scenario.", actions: [{ op: "simulate_conjoint", target: "PLAN", scenario: { name: "Premium bundle at ₹499", prices: { Insurance: "₹249", Streaming: "₹299", Cloud: "₹99" }, bundles: [{ name: "Premium", items: ["Insurance", "Streaming", "Cloud"], price: "₹499" }] } }] });
  assert.equal(b2.context?.methods, true);
  const r = result(b2, "simulate_conjoint");
  assert.ok(r?.ok, JSON.stringify(b2.validation).slice(0, 600));
  assert.match(r.description, /Simulator scenario “Premium bundle at ₹499” saved on .*prices Insurance 249, Streaming 299, Cloud 99; bundle “Premium” \(Insurance \+ Streaming \+ Cloud\) at 499.*The tasks are unchanged/);
  def = await apply();
  const d = designOf(def, byVar(def, "PLAN"));
  assert.deepEqual(d.file.rows, designOf(before, byVar(before, "PLAN")).file.rows);
  assert.equal(d.config.simulations[0].bundles[0].price, 499);
  ok("“run the menu simulator with the premium bundle at ₹499” → simulate_conjoint: checked against the menu, saved; tasks unchanged");
}
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — the applied survey in the preview");
const rt = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const rtErrors = [];
rt.on("pageerror", (e) => rtErrors.push(String(e)));
await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(rt, { definition: { ...def, meta: { ...def.meta, id: "conjoint_suite" } } }, { selector: '[data-qid="q_own"]' });
const next = async () => { await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(600); };
const stateOf = () => rt.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));
await rt.click('[data-qid="q_own"] input[value="1"]');
await next();

const parsed = SurveyDefinition.parse(def);
const cvaQ = byVar(def, "CVA"), cbcQ = byVar(def, "CBC"), menuQ = byVar(def, "PLAN");
/* 5 — CVA */
await rt.waitForSelector(`[data-qid="${cvaQ.id}"] [data-testid="rs-cva-tasks"]`);
const seed = (await stateOf()).seed;
const tasks = cvaTasksFor(parsed, parsed.questions.find((q) => q.id === cvaQ.id), seed);
const shown = await rt.$$eval(`[data-qid="${cvaQ.id}"] [data-testid^="cva-task-"]`, (els) => els.map((e) => ({ task: e.getAttribute("data-task"), cells: [...e.querySelectorAll("td[data-label]")].map((td) => [td.getAttribute("data-label"), td.textContent.trim()]), points: e.querySelectorAll('input[type="radio"]').length })));
assert.equal(shown.length, tasks.length);
shown.forEach((s, i) => { assert.equal(s.task, tasks[i].task); assert.deepEqual(Object.fromEntries(s.cells), tasks[i].profiles[0].levels); assert.equal(s.points, 11); });
for (const [i, t] of tasks.entries()) await rt.click(`[data-testid="cva-rate-${t.task}-${i % 11}"]`);
const cvaAns = (await stateOf()).answers[cvaQ.id];
assert.deepEqual(Object.values(cvaAns).map(Number), tasks.map((_, i) => i % 11));
ok(`CVA: ${tasks.length} profiles of version ${designVersionFor(cvaQ, designOf(def, cvaQ).file.rows, seed)}, each with its levels and a 0–10 scale; ratings recorded`);
await next();

/* 6 — dual-response CBC */
await rt.waitForSelector(`[data-qid="${cbcQ.id}"] [data-testid="cbc-task-1"]`);
const cbcRows = designRowsFor(cbcQ, designOf(def, cbcQ).file.rows, seed);
const nTasks = new Set(cbcRows.map((r) => r.task)).size;
assert.equal(await rt.$('[data-testid="cbc-dual-1"]'), null, "no follow-up before a choice");
for (let t = 1; t <= nTasks; t++) {
  const alt = cbcRows.find((r) => Number(r.task) === t).alt;
  await rt.click(`[data-testid="cbc-choose-${t}-${alt}"]`);
  await rt.waitForSelector(`[data-testid="cbc-dual-${t}"]`);
  await rt.click(`[data-testid="cbc-buy-${t}-${t % 2 ? "yes" : "no"}"]`);
}
assert.match(await rt.textContent('[data-testid="cbc-dual-1"]'), /Would you actually buy the option you chose\?/);
const cbcAns = (await stateOf()).answers[cbcQ.id];
assert.equal(cbcAns["1_buy"], "yes"); assert.equal(cbcAns["2_buy"], "no");
ok(`dual-response CBC: ${nTasks} forced choices, the follow-up appears after each choice; yes / no stored as <task>_buy`);
await next();

/* 7 — menu with a one-of section */
await rt.waitForSelector(`[data-qid="${menuQ.id}"] [data-testid="rs-menu-tasks"]`);
const item = (t, label) => `[data-qid="${menuQ.id}"] [data-testid="rs-menu-task"][data-task="${t}"] [data-testid="rs-menu-item"][data-item="${MENU.findIndex((m) => m.name === label) + 1}"] input`;
const menuTasks = await rt.$$eval(`[data-qid="${menuQ.id}"] [data-testid="rs-menu-task"]`, (els) => els.map((e) => e.getAttribute("data-task")));
for (const t of menuTasks) { await rt.click(item(t, "Data pack")); await rt.click(item(t, "Basic support")); await rt.click(item(t, "Priority support")); }
const menuAns = (await stateOf()).answers[menuQ.id];
assert.deepEqual(menuAns[menuTasks[0]], ["1", "6"], "Priority support replaced Basic support (one-of section)");
ok(`menu: ${menuTasks.length} menus; the support section is one-of (picking Priority dropped Basic)`);
await next();
await rt.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });

/* 8 — exports */
const state = createResponseState(parsed, { seed });
state.answers = (await stateOf()).answers;
const flat = flattenVariables(parsed, state);
assert.equal(flat[`CVA_T${tasks[1].task}`], 1);
assert.equal(flat.CBC_T1_BUY, 1); assert.equal(flat.CBC_T2_BUY, 0);
assert.equal(flat[`PLAN_T${menuTasks[0]}_6`], 1); assert.equal(flat[`PLAN_T${menuTasks[0]}_5`], 0);
ok("the answers flatten to CVA_T<n> ratings, CBC_T<n>_BUY 0/1 and the menu's item columns; the survey completes");
assert.deepEqual(rtErrors, [], rtErrors.join("\n"));

/* ============================================================ ESTIMATION AND SIMULATOR */
console.log("\nESTIMATION — synthetic respondents with known utilities answering the applied designs");
let s = 99; const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const normal = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const gumbel = () => -Math.log(-Math.log(rnd() + 1e-12));
const TRUE_CVA = { Brand: [0.8, 0, -0.8], Screen: [-0.4, 0.4], Battery: [-1, 0.2, 0.8], Price: [1, 0, -1] };
const TRUE_CBC = { Brand: [0.5, 0, -0.5], Storage: [-0.5, 0.1, 0.4], Price: [0.9, 0, -0.9] };
const rows = [];
for (let i = 0; i < 300; i++) {
  const seed = Math.floor(rnd() * 2 ** 31);
  const answers = { q_own: 1 };
  const cv = {}; for (const t of cvaTasksFor(parsed, parsed.questions.find((q) => q.id === cvaQ.id), seed)) { const u = CVA_ATTRS.reduce((a, at) => a + TRUE_CVA[at.name][at.levels.indexOf(t.profiles[0].levels[at.name])], 0); cv[t.task] = Math.max(0, Math.min(10, Math.round(5 + u + 0.7 * normal()))); }
  answers[cvaQ.id] = cv;
  const cr = designRowsFor(cbcQ, designOf(def, cbcQ).file.rows, seed), cb = {};
  for (const t of new Set(cr.map((r) => r.task))) {
    const alts = cr.filter((r) => r.task === t); const det = alts.map((a) => CBC_ATTRS.reduce((x, at) => x + TRUE_CBC[at.name][at.levels.indexOf(a[at.name])], 0)); const u = det.map((d) => d + gumbel()); const k = u.indexOf(Math.max(...u));
    cb[t] = String(alts[k].alt); cb[`${t}_buy`] = det[k] + gumbel() > -0.3 + gumbel() ? "yes" : "no";
  }
  answers[cbcQ.id] = cb;
  const mr = designRowsFor(menuQ, designOf(def, menuQ).file.rows, seed), mn = {};
  for (const t of new Set(mr.map((r) => r.task))) { const its = mr.filter((r) => r.task === t); mn[t] = its.filter((r) => !r.group && 1 - Number(r.price_value) / 120 + normal() > 0).map((r) => String(r.item)); if (rnd() < 0.5) { const lab = rnd() < 0.5 ? "Basic support" : "Priority support"; mn[t].push(String(its.find((r) => r.item_label === lab).item)); } }
  answers[menuQ.id] = mn;
  rows.push({ id: `r${i}`, session_id: `s${i}`, respondent_code: `R${i}`, seed, status: "complete", is_test: false, started_at: "2026-10-22T10:00:00Z", answers, calculated: {}, embedded: {}, flags: [] });
}
const ds = buildDataset(parsed, rows, { spec: { environment: "LIVE", dataset: "all" } });
const A = (v, options = {}, kind = "conjoint") => runAnalysis({ name: v, kind, dataset: { environment: "LIVE", dataset: "all" }, variables: [v], options }, ds);
{
  const r = A("CVA", { simulator: { products: [{ name: "Ours", levels: { Brand: "Alpha", Screen: "6 in", Battery: "2 days", Price: "₹19,999" } }, { name: "Rival", levels: { Brand: "Beta", Screen: "6 in", Battery: "3 days", Price: "₹19,999" } }], rule: "first_choice", demand: true } });
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const pw = r.tables.find((t) => t.id === "partworths");
  let e = 0; for (const a of CVA_ATTRS) a.levels.forEach((l, k) => { e = Math.max(e, Math.abs(pw.rows.find((x) => x.attribute === a.name && x.level === l).mean - TRUE_CVA[a.name][k])); });
  assert.ok(e < 0.2, `CVA max error ${e}`);
  assert.ok(r.tables.some((t) => t.id === "sim_demand"));
  const xlsx = await buildSimulatorXlsx(r), pptx = await buildSimulatorPptx(r);
  assert.ok(xlsx.length > 2000 && checkOfficeFile(pptx, "pptx").ok);
  ok(`CVA: per-respondent OLS recovers the planted part-worths (max error ${e.toFixed(3)}); simulator + demand curve; Excel and PowerPoint valid`);
}
{
  const r = A("CBC");
  const none = r.tables.find((t) => t.id === "simulation").rows.find((x) => x.profile === "None");
  assert.ok(none && Math.abs(none.utility - -0.3) < 0.2, `None ${none?.utility}`);
  assert.match(String(r.tables.find((t) => t.id === "fit").rows.find((x) => x.m === "Model").v), /dual-response None/);
  ok(`dual-response CBC: the dual coding recovers the None constant (${none.utility} vs −0.3)`);
}
{
  const r = A("PLAN");
  const sim = r.tables.find((t) => t.id === "menu_sim");
  assert.match(sim.title, /Premium bundle at ₹499/, "the Intelligent-Mode scenario is the menu's simulation");
  const bundle = r.tables.find((t) => t.id === "menu_sim_bundles");
  assert.equal(bundle.rows[0].price, 499);
  assert.equal(bundle.rows[0].list, 647, "à la carte: ₹249 + ₹299 + ₹99");
  assert.ok(bundle.rows[0].take > 0);
  ok(`menu: the item model and the saved scenario — the ₹499 premium bundle is taken by ${bundle.rows[0].take}% (list ${bundle.rows[0].list})`);
}

await browser.close();
console.log(`\n${passed} passed`);
