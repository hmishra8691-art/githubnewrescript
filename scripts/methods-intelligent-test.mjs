/**
 * PRIORITY 5 (2026-10-17) — INTELLIGENT MODE BUILDS MAXDIFF, CONJOINT AND LEAST FILL AS RESEARCH DESIGNS.
 *
 * The brief's three requests, answered the way the methods guide / List Fill guide teach (the model is
 * the fake provider's stand-in, `window.__rescriptCopilotFake`), through the real route, the real engine
 * gate and the real design generators, then the applied survey in the runtime preview:
 *
 *   STUDIO   1  "Create a MaxDiff study … product features" with no list anywhere → a question back, nothing proposed
 *            2  the features given → create_maxdiff: the proposal shows the configuration and the MEASURED
 *               diagnostics ("each respondent sees every item 3 times …"), Apply → the question + its design,
 *               the design identical to what the generator makes from (config, seed) — the replay is the preview
 *            3  "Make it 5 items per task" → update_maxdiff: only items per task changes (text, display logic,
 *               other settings untouched), the design regenerated in place (v2)
 *            4  "Create a choice-based conjoint with four attributes and three levels" → a question back (no
 *               invented attributes); 5 the attributes given → create_conjoint (D-efficiency said), Apply
 *            6  "Add a None option to the conjoint" → update_conjoint none → None rows, nothing else changed
 *            7  an infeasible MaxDiff (20 items, 3 tasks of 5) → refused with the generator's reason, nothing applied
 *            8  a ranking-based conjoint → refused at the gate with the reason (no silent CBC)
 *            9  "Configure a LEAST List Fill …" → update_list_fill least_fill counted on completes → least_filled,
 *               the list's items, caps and destination untouched
 *   RUNTIME  the applied survey: least fill gives the brand with the fewest completes; the MaxDiff shows this
 *            respondent's version (5 per task, 9 tasks, in the seeded order) and records best/worst; the CBC
 *            shows the version's concepts with their levels and None last and records the design alternatives;
 *            the flattened data carries the documented columns
 *
 *   node scripts/methods-intelligent-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions, designVersionFor, shuffleAlternatives, flattenVariables, createResponseState } from "../packages/engine/dist/index.js";
import { maxdiffPlugin, conjointPlugin, measureMaxDiffDesign } from "../packages/designs/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const BRIEF = [
  "Create a MaxDiff study to identify the most and least important product features.",
  "Create a choice-based conjoint with four attributes and three levels per attribute.",
  "Configure a LEAST List Fill setup based on the existing eligible-item counts and allocation rules.",
];
const FEATURES = ["Battery life", "Camera quality", "Price", "Screen size", "Storage", "Brand reputation", "Durability", "Weight", "Charging speed", "Design", "Software updates", "Warranty"];
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Screen", levels: ["5 in", "6 in", "7 in"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];
const BRANDS = ["Apple", "Samsung", "Google", "OnePlus"];

/* the survey before Intelligent Mode: a screener, the brands used, a deep-dive fed by a random List Fill with a cap on Apple */
const SURVEY = (() => {
  const base = SurveyDefinition.parse({
    meta: { id: "sandbox", code: "PH", title: "Smartphones", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      { id: "q_own", code: "Q1", variableName: "OWN", type: "single_select", variant: "single_select.radio", required: true, text: "Do you own a smartphone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", variant: "multi_select.checkbox", required: true, text: "Which brands have you used?", options: BRANDS.map((label, i) => ({ code: i + 1, label })) },
      { id: "q_deep", code: "Q3", variableName: "DEEP", type: "single_select", variant: "single_select.radio", required: false, text: "Which of these would you buy next?", options: BRANDS.map((label, i) => ({ code: i + 1, label })) },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_own", "q_brands"] }, { type: "page", id: "p2", questionIds: ["q_deep"] }, { type: "end", id: "e1", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  });
  const out = applySurveyActions(base, coerceSurveyActions([{ op: "create_list_fill", name: "DEEPDIVE", source: "BRANDS", count: 1, method: "random", maximum: { Apple: 100 }, destinations: ["DEEP"] }]).actions);
  assert.deepEqual(out.errors, [], "the starting List Fill");
  return out.def;
})();

const browser = await chromium.launch();

/* ============================================================ STUDIO */
console.log("\nSTUDIO — the brief's requests, answered as the guides teach");
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
/** one request with the stand-in model's reply: the route's body and the settled card */
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
const openChanges = async () => { await page.click('[data-testid="cp-tab-changes"]'); await page.waitForSelector('[data-testid="cp-changes"]'); };
const apply = async () => {
  await openChanges();
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(800);
  return readDef();
};
const designOf = (def, q) => def.designs.find((d) => d.id === q.settings?.designRef);
const byVar = (def, v) => def.questions.find((q) => q.variableName === v);
const text = async (sel) => ((await page.textContent(sel).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* 1 — MaxDiff with no items anywhere: a question back */
{
  const { body, card } = await ask(BRIEF[0], { kind: "clarify", reply: "A MaxDiff needs the list of features to compare, and this survey does not have one yet.", questions: ["Which product features should the MaxDiff compare? I'll set the items per task and the number of tasks from how many there are."] });
  assert.equal(body.reply?.kind, "clarify");
  assert.equal(body.context?.methods, true, "the methods guide went with the request");
  assert.deepEqual(body.reply.actions, []);
  assert.equal(body.validation, null, "nothing proposed");
  assert.ok(await card.$('[data-testid="cp-clarify"]'), "the question is on the card");
  assert.equal(await card.$('[data-testid="cp-apply"]'), null, "no Apply");
  ok("MaxDiff with no item list anywhere → a clarifying question (methods guide sent), nothing invented, nothing proposed");
}

/* 2 — the features given: create_maxdiff, the measured diagnostics in the proposal, Apply */
let afterMd;
{
  const { body } = await ask(`The features: ${FEATURES.join(", ")}. Only people who own a smartphone.`, {
    kind: "proposal",
    reply: "I'll add a MaxDiff of the 12 features in its own block, shown to smartphone owners. The Studio sized the tasks; see the measured balance.",
    assumptions: ["4 items per task, 9 tasks, 10 versions (sized from 12 items)"],
    actions: [
      { op: "create_block", title: "Feature importance" },
      { op: "create_maxdiff", ref: "FEAT_MD", block: "Feature importance", items: FEATURES, text: "Of these features, which is the MOST important to you when choosing a smartphone, and which is the LEAST important?" },
      { op: "set_display_logic", target: "FEAT_MD", expression: "OWN = 1" },
    ],
  });
  const r = result(body, "create_maxdiff");
  assert.ok(r?.ok, JSON.stringify(body.validation ?? body).slice(0, 600));
  assert.match(r.description, /12 items, 4 per task, 9 tasks, 10 versions; each respondent sees every item 3 times; within a version every pair shares a task/);
  assert.match(r.description, /Assumed \(not stated\): 4 items per task, 9 tasks/);
  await openChanges();
  assert.match(await text('[data-testid="cp-designs"]'), /each respondent sees every item 3 times/, "the proposal shows the measured diagnostics");
  assert.match(await text('[data-testid="cp-summary"]'), /Add design “Q4 MaxDiff design” \(MaxDiff, 360 rows\)/);
  afterMd = await apply();
  const q = byVar(afterMd, "FEAT_MD");
  assert.equal(q.type, "maxdiff_task");
  assert.ok(q.displayLogic, "display logic set");
  const d = designOf(afterMd, q);
  assert.deepEqual(d.config, { balance: "optimized", items: FEATURES, itemsPerTask: 4, tasks: 9, versions: 10 });
  assert.deepEqual(d.file.rows, maxdiffPlugin.generate(d.config, d.seed).rows, "the applied design is the generator's (config, seed) design — the replay equals the preview");
  assert.equal(measureMaxDiffDesign(d.file.rows, FEATURES).perVersion.itemSpreadMax, 0);
  ok(`create_maxdiff → proposal with measured diagnostics → Apply: ${q.code} + design (seed ${d.seed}, 360 rows), identical to the generator's`);
}

/* 3 — "Make it 5 items per task": only that changes */
let afterFive;
{
  const { body } = await ask("Make it 5 items per task", { kind: "proposal", reply: "Five items per task; everything else stays.", actions: [{ op: "update_maxdiff", target: "FEAT_MD", perTask: 5 }] });
  const r = result(body, "update_maxdiff");
  assert.ok(r?.ok, JSON.stringify(body.validation).slice(0, 600));
  assert.match(r.description, /items per task 4 → 5 — design regenerated \(v2\)/);
  afterFive = await apply();
  const before = byVar(afterMd, "FEAT_MD"), after = byVar(afterFive, "FEAT_MD");
  assert.deepEqual({ ...after, settings: undefined }, { ...before, settings: undefined }, "the question, its text and display logic are untouched");
  const d0 = designOf(afterMd, before), d1 = designOf(afterFive, after);
  assert.equal(d1.id, d0.id);
  assert.equal(d1.version, 2);
  assert.deepEqual(d1.config, { ...d0.config, itemsPerTask: 5 });
  assert.deepEqual(afterFive.listFills, afterMd.listFills, "the List Fill untouched");
  ok("“Make it 5 items per task” → update_maxdiff: items per task 4 → 5, design v2 in place; text, logic and the rest unchanged");
}

/* 4 — CBC with attributes counted but not named: a question back */
{
  const { body, card } = await ask(BRIEF[1], { kind: "clarify", reply: "I can build the CBC once I know the attributes and their levels.", questions: ["What are the four attributes, and the three levels of each?"] });
  assert.equal(body.reply.kind, "clarify");
  assert.deepEqual(body.reply.actions, []);
  assert.ok(await card.$('[data-testid="cp-clarify"]'));
  assert.equal((await readDef()).designs.length, 1, "no conjoint design invented");
  ok("CBC with “four attributes and three levels” but no names → the attributes are asked for, none invented");
}

/* 5 — the attributes given: create_conjoint */
let afterCbc;
{
  const { body } = await ask(`${ATTRS.map((a) => `${a.name}: ${a.levels.join(", ")}`).join("; ")}`, {
    kind: "proposal", reply: "A CBC of four attributes, efficient design.",
    actions: [{ op: "create_block", title: "Choice tasks" }, { op: "create_conjoint", ref: "PHONE_CBC", block: "Choice tasks", method: "cbc", attributes: ATTRS, text: "If these were the only phones available, which would you choose?" }],
  });
  const r = result(body, "create_conjoint");
  assert.ok(r?.ok, JSON.stringify(body.validation).slice(0, 600));
  assert.match(r.description, /4 attributes \(Brand 3, Screen 3, Battery 3, Price 3 levels\); 3 alternatives per task, 12 tasks, 10 versions, efficient .* D-efficiency \d+(\.\d)?% per version/);
  await openChanges();
  assert.match(await text('[data-testid="cp-designs"]'), /D-efficiency/);
  afterCbc = await apply();
  const q = byVar(afterCbc, "PHONE_CBC");
  assert.equal(q.variant, "conjoint.cbc");
  const d = designOf(afterCbc, q);
  assert.deepEqual(d.file.rows, conjointPlugin.generate(d.config, d.seed).rows);
  ok(`create_conjoint → D-efficiency in the proposal → Apply: ${q.code} + CBC design (${d.file.rows.length} rows)`);
}

/* 6 — "Add a None option": only that */
let afterNone;
{
  const { body } = await ask("Add a None option to the conjoint", { kind: "proposal", reply: "A None option on every task.", actions: [{ op: "update_conjoint", target: "PHONE_CBC", none: true }] });
  assert.ok(result(body, "update_conjoint")?.ok, JSON.stringify(body.validation).slice(0, 600));
  afterNone = await apply();
  const d0 = designOf(afterCbc, byVar(afterCbc, "PHONE_CBC")), d1 = designOf(afterNone, byVar(afterNone, "PHONE_CBC"));
  assert.deepEqual(d1.config, { ...d0.config, noneOption: true });
  assert.equal(d1.file.rows.filter((r) => Number(r.none_option) === 1).length, 12 * 10);
  assert.deepEqual(designOf(afterNone, byVar(afterNone, "FEAT_MD")), designOf(afterFive, byVar(afterFive, "FEAT_MD")), "the MaxDiff untouched");
  ok("“Add a None option” → update_conjoint: None on every task, nothing else changed (the MaxDiff untouched)");
}

/* 7 — an infeasible MaxDiff: refused with the reason */
{
  const twenty = Array.from({ length: 20 }, (_, i) => `Claim ${i + 1}`);
  const { body } = await ask("Add a second MaxDiff of 20 claims, 5 per task and only 3 tasks", { kind: "proposal", reply: "A second MaxDiff.", actions: [{ op: "create_maxdiff", ref: "CLAIMS_MD", items: twenty, perTask: 5, tasks: 3, versions: 1 }] });
  const r = result(body, "create_maxdiff");
  assert.equal(r?.ok, false);
  assert.match(r.error, /not feasible — 3 tasks of 5 items cannot show all 20 items even once\. Use at least 4 tasks per version/);
  await openChanges();
  assert.match(await text('[data-testid="cp-refused"]'), /cannot show all 20 items even once/);
  assert.equal(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled), true, "nothing to apply");
  await page.click('[data-testid="cp-panel-cancel"]');
  assert.equal((await readDef()).designs.length, 2);
  ok("infeasible MaxDiff (20 items, 3 tasks × 5) → refused with the generator's reason and the fix; nothing applied");
}

/* 8 — a RANKING-based conjoint: refused at the gate, not turned into a CBC (F4 2026-10-22: rating-based (CVA) is implemented now — scripts/conjoint-suite-test.mjs covers it) */
{
  const { body, card } = await ask("Make it a ranking-based conjoint instead", { kind: "proposal", reply: "A ranking conjoint.", actions: [{ op: "create_conjoint", method: "ranking", attributes: ATTRS }] });
  assert.match(JSON.stringify(body.reply.rejected), /ranking-based conjoint is not implemented/);
  assert.match((await card.$$eval('[data-testid="cp-rejected-reason"]', (e) => e.map((x) => x.textContent).join(" "))), /ranking-based .* not implemented.*choice-based \(cbc/);
  assert.equal((await readDef()).designs.length, 2, "no substitute design");
  ok("ranking-based conjoint → refused at the gate with the reason and the supported methods; no CBC substituted");
}

/* 9 — LEAST List Fill: least_filled counted on completes, the rest of the list untouched */
let applied;
{
  const { body } = await ask(BRIEF[2], { kind: "proposal", reply: "DEEPDIVE now gives each respondent the brand the fewest completed interviews have had.", actions: [{ op: "update_list_fill", listFill: "DEEPDIVE", method: "least_fill", basis: "completed" }] });
  const r = result(body, "update_list_fill");
  assert.ok(r?.ok, JSON.stringify(body.validation).slice(0, 600));
  assert.match(r.description, /least-filled first \(fewest completed interviews\)/);
  applied = await apply();
  const before = afterNone.listFills[0], after = applied.listFills[0];
  assert.equal(after.selection.method, "least_filled");
  assert.deepEqual(after.selection.leastFilled, { basis: "completed", tieBreak: "random" });
  assert.deepEqual(after.options, before.options, "items and the Apple cap untouched");
  assert.deepEqual(after.destinations, before.destinations);
  ok("“Configure a LEAST List Fill …” → least_filled (basis completed); items, cap and destination untouched");
}
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — the applied survey in the runtime preview");
const rt = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const rtErrors = [];
rt.on("pageerror", (e) => rtErrors.push(String(e)));
const lfId = applied.listFills[0].id;
await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(rt, { definition: { ...applied, meta: { ...applied.meta, id: "methods_p5" } }, listFillCounts: { [lfId]: { "1": 9, "2": 0, "3": 4, "4": 7 } } }, { selector: '[data-qid="q_own"]' });
const next = async () => { await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(600); };
const stateOf = () => rt.evaluate(() => JSON.parse(JSON.stringify({ seed: window.__rescriptState.seed, answers: window.__rescriptState.answers })));

await rt.click('[data-qid="q_own"] input[value="1"]');
for (const c of ["1", "2", "3"]) await rt.click(`[data-qid="q_brands"] input[value="${c}"]`);
await next();
await rt.waitForSelector('[data-qid="q_deep"]');
const deep = await rt.$$eval('[data-qid="q_deep"] input', (els) => els.map((e) => e.value));
assert.deepEqual(deep, ["2"], `least fill gives Samsung (0 completes) of Apple 9 / Samsung 0 / Google 4: ${deep}`);
ok("least fill: of the brands used (Apple 9, Samsung 0, Google 4 completes) the deep-dive asks about Samsung");
await rt.click('[data-qid="q_deep"] input[value="2"]');
await next();

const mdQ = byVar(applied, "FEAT_MD"), cbcQ = byVar(applied, "PHONE_CBC");
const mdRows = designOf(applied, mdQ).file.rows, cbcRows = designOf(applied, cbcQ).file.rows;
await rt.waitForSelector(`[data-qid="${mdQ.id}"] [data-testid="md-task-1"]`);
const seed = (await stateOf()).seed;
const mdVersion = designVersionFor(mdQ, mdRows, seed);
const shownMd = await rt.evaluate((qid) => {
  const out = {};
  for (const tr of document.querySelectorAll(`[data-qid="${qid}"] [data-testid="md-item"]`)) (out[tr.getAttribute("data-task")] ??= []).push(tr.getAttribute("data-item"));
  return out;
}, mdQ.id);
assert.equal(Object.keys(shownMd).length, 9, "9 tasks");
for (let t = 1; t <= 9; t++) {
  const expected = shuffleAlternatives(mdRows.filter((r) => String(r.version) === mdVersion && Number(r.task) === t), seed, `${mdQ.id}:${t}`).map((r) => String(r.item_index));
  assert.deepEqual(shownMd[String(t)], expected, `MaxDiff task ${t}: this respondent's version, in the seeded order`);
  assert.equal(expected.length, 5, "5 items per task");
}
assert.equal(await rt.textContent('[data-testid="md-task-1"]').then((s) => s.trim()), "Task 1 of 9");
const radio = (t, item, side) => `[data-qid="${mdQ.id}"] tr[data-testid="md-item"][data-task="${t}"][data-item="${item}"] input[name$="_${side}"]`;
for (let t = 1; t <= 9; t++) {
  await rt.click(radio(String(t), shownMd[String(t)][0], "best"));
  await rt.click(radio(String(t), shownMd[String(t)][4], "worst"));
}
ok(`MaxDiff: version ${mdVersion} of 10, 9 tasks × 5 items in the seeded order; best and worst chosen`);
await next();

await rt.waitForSelector(`[data-qid="${cbcQ.id}"] [data-testid="cbc-task-1"]`);
const cbcVersion = designVersionFor(cbcQ, cbcRows, seed);
const shownCbc = await rt.evaluate((qid) => {
  const out = {};
  for (const tr of document.querySelectorAll(`[data-qid="${qid}"] [data-testid="cbc-alt"]`)) {
    (out[tr.getAttribute("data-task")] ??= []).push({ alt: tr.getAttribute("data-alt"), none: tr.getAttribute("data-none") === "1", cells: Object.fromEntries([...tr.querySelectorAll("td[data-label]")].map((td) => [td.getAttribute("data-label"), td.textContent.trim()])) });
  }
  return out;
}, cbcQ.id);
assert.equal(Object.keys(shownCbc).length, 12, "12 tasks");
for (let t = 1; t <= 12; t++) {
  const rows = shownCbc[String(t)];
  assert.equal(rows.length, 4, "3 concepts + None");
  assert.equal(rows[3].none, true, "None last");
  for (const r of rows.slice(0, 3)) {
    const design = cbcRows.find((x) => String(x.version) === cbcVersion && Number(x.task) === t && String(x.alt) === r.alt);
    for (const a of ATTRS) assert.equal(r.cells[a.name], String(design[a.name]), `task ${t} alt ${r.alt} ${a.name}`);
  }
  await rt.click(`[data-testid="cbc-choose-${t}-${rows[1].alt}"]`);
}
ok(`CBC: version ${cbcVersion} of 10, 12 tasks × 3 concepts with the design's levels, None last; a concept chosen in each`);
const st = await stateOf();
await next();
await rt.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });

const parsed = SurveyDefinition.parse(applied);
const state = createResponseState(parsed, { seed });
state.answers = st.answers;
const flat = flattenVariables(parsed, state);
assert.equal(flat.FEAT_MD_VERSION, mdVersion);
assert.equal(String(flat.FEAT_MD_T1_BEST), shownMd["1"][0]);
assert.equal(String(flat.FEAT_MD_T9_WORST), shownMd["9"][4]);
assert.equal(flat.PHONE_CBC_VERSION, cbcVersion);
assert.equal(String(flat.PHONE_CBC_T12), shownCbc["12"][1].alt, "the stored CBC answer is the design alternative clicked");
assert.equal(String(st.answers.q_deep), "2");
ok("the answers are recorded and flatten to FEAT_MD_VERSION / _T<n>_BEST / _WORST and PHONE_CBC_VERSION / _T<n>; the survey completes");

assert.deepEqual(rtErrors, [], rtErrors.join("\n"));
ok("no page errors in the Studio or the runtime");
await browser.close();
console.log(`\n${passed} passed`);
