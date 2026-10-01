/**
 * NESTED LOGIC AUDIT (2026-10-01) — the Studio and the runtime, end to end.
 *
 * The engine suite (`packages/engine/src/nestedLogicAudit.test.ts`) proves
 * the evaluator, parser and printer; this proves the screens a programmer and
 * a respondent use agree with them:
 *
 *   Studio
 *   - Auto punch: a NUMERIC source is offered (Prince 66) with a value test;
 *     "+ add condition" opens the nested builder; an ELSE IF keeps its mode.
 *   - An unfinished skip rule says it skips everyone.
 *   - "Logic applied" markers stay off for an empty condition (Oweas #4).
 *   - Carry forward from a grid offers ROW choices and a column filter
 *     (29-09 #5, #6, Oweas 1–3, 6).
 *   - A validation rule can be gated ("Check this rule only when").
 *   - Constant sum per-option logic round-trips through the Expression tab
 *     (Prince 44).
 *   Runtime
 *   - A numeric grid row with ANY column shows a later question (Oweas #7).
 *   - A punch cascade through two hidden questions on ONE page drives live
 *     display logic (Prince 66).
 *
 *   node scripts/nested-logic-audit-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const opts = (n, label = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${label} ${i + 1}` }));
const EMPTY = { type: "group", op: "and", children: [] };
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "NestedLogicAudit", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Region?", options: opts(3) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands?", options: opts(4) },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many?" },
    { id: "q5", code: "Q5", variableName: "Q5", type: "allocation", text: "Split 10 points", options: opts(3, "Brand") },
    { id: "q6", code: "Q6", variableName: "Q6", type: "matrix_single", text: "Status",
      rows: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }],
      options: [{ code: 1, label: "Aware" }, { code: 2, label: "Used" }, { code: 3, label: "Never heard" }] },
    { id: "q8", code: "Q8", variableName: "Q8", type: "hidden", text: "Band", options: [{ code: 1, label: "Low" }, { code: 2, label: "Medium" }, { code: 3, label: "High" }] },
    { id: "q10", code: "Q10", variableName: "Q10", type: "single_select", text: "Follow-up", options: opts(3), displayLogic: EMPTY },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
    { type: "page", id: "p2", questionIds: ["q5", "q6", "q8", "q10"] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|401|404/.test(m.text())) errors.push(m.text()); });
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await openTabKey(page, activeTab).catch(() => {});
  return JSON.parse(json);
};
const loadFixture = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
};
const selectQuestion = async (code) => {
  await openTab(page, "Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) {
    if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(250); return; }
  }
  throw new Error(`no card for ${code}`);
};
const q = (def, id) => def.questions.find((x) => x.id === id);

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadFixture(FIXTURE);
assert.equal((await readDef()).questions.length, FIXTURE.questions.length);
ok("fixture loaded");

/* ------------------------------------------------ Oweas #4: no false "logic applied" */
await selectQuestion("Q10");
const dlDot = await page.$('[data-testid="psec-active-display-logic"]');
assert.equal(dlDot, null, "an EMPTY display-logic group is not configured logic");
ok("Oweas #4 — an empty display condition shows no “configured” dot");

/* ------------------------------------------------ an unfinished skip rule says so */
await selectQuestion("Q1");
await ensureSectionOpen("skip-logic");
await page.click('button:has-text("+ skip rule")');
await page.waitForSelector('[data-testid="skip-always-0"]');
assert.match(await page.textContent('[data-testid="skip-always-0"]'), /skips every respondent/);
ok("a new skip rule with no condition yet warns that it skips every respondent");
/* remove it again so the rest of the run is not routed to the end */
await page.click('button[title="Remove this skip rule"]');
await page.waitForTimeout(200);
assert.equal(q(await readDef(), "q1").skipLogic.length, 0);

/* ------------------------------------------------ Prince 66: numeric source for a punch */
await selectQuestion("Q8");
await ensureSectionOpen("auto-punch");
await page.click('[data-testid="ap-add-simple"]');
await page.waitForSelector('[data-testid="ap-source-q"]');
const groups = await page.$$eval('[data-testid="ap-source-q"] optgroup', (gs) => gs.map((g) => ({ label: g.label, items: [...g.querySelectorAll("option")].map((o) => o.value) })));
const numeric = groups.find((g) => /Numeric/.test(g.label));
assert.ok(numeric && numeric.items.includes("q3"), `the numeric open end is offered: ${JSON.stringify(groups)}`);
ok("“If question” lists numeric / text questions, in their own group");
await page.selectOption('[data-testid="ap-source-q"]', "q3");
await page.waitForSelector('[data-testid="ap-value-test"]');
await page.selectOption('[data-testid="ap-value-test"]', "between");
await page.waitForSelector('[data-testid="ap-value2"]');
await page.fill('[data-testid="ap-value"]', "4");
await page.fill('[data-testid="ap-value2"]', "7");
await page.waitForTimeout(300);
let rule = q(await readDef(), "q8").punches[0];
assert.deepEqual({ op: rule.when.operator, ref: rule.when.source.ref, v: rule.when.value, v2: rule.when.value2 }, { op: "between", ref: "q3", v: 4, v2: 7 });
ok("a numeric range is stored as Q3 between 4 and 7");

/* the chain position survives a simple-mode edit */
await page.selectOption('[data-testid="ap-chain-mode"]', "else_if");
await page.waitForTimeout(200);
await page.fill('[data-testid="ap-value2"]', "8");
await page.waitForTimeout(300);
rule = q(await readDef(), "q8").punches[0];
assert.equal(rule.mode, "else_if", "before: a Simple-mode edit turned ELSE IF back into IF");
assert.equal(rule.when.value2, 8);
assert.match(await page.textContent('[data-testid="ap-rule-text"]'), /^ELSE IF /);
ok("Oweas #5 — an ELSE IF rule stays ELSE IF through an edit, and prints as ELSE IF");

/* "+ add condition" opens the nested builder */
await page.click('[data-testid="ap-add-condition"]');
await page.waitForSelector('[data-testid="ap-builder"]');
assert.ok(await page.$('[data-testid="ap-builder"] .lb-root-head, [data-testid="ap-builder"] [data-testid="lb-root-op"], [data-testid="ap-builder"] .lb-group, [data-testid="ap-builder"] .cond-group'), "the condition builder is shown");
ok("29-09 #3 — “+ add condition” opens the AND / OR / NOT builder for the punch");

/* ------------------------------------------------ Prince 44: constant sum per option */
await selectQuestion("Q10");
await ensureSectionOpen("display-logic");
const tab = await page.$('[data-testid="psec-body-display-logic"] button:has-text("Expression")');
if (tab) await tab.click();
const box = '[data-testid="psec-body-display-logic"] textarea';
await page.waitForSelector(box);
await page.fill(box, "Q5.1 < 6 OR Q5.2 > 6");
await page.$eval(box, (e) => e.blur());
await page.waitForTimeout(400);
const dl = q(await readDef(), "q10").displayLogic;
assert.equal(dl.op, "or");
assert.deepEqual(dl.children.map((c) => c.source.rowCode), ["1", "2"], JSON.stringify(dl));
ok("Prince 44 — “Q5.1 < 6 OR Q5.2 > 6” keeps each option's amount");
assert.ok(await page.$('[data-testid="psec-active-display-logic"]'), "and now the section IS marked configured");
ok("…and the display-logic section is marked configured once it is");

/* ------------------------------------------------ carry forward from a grid */
await ensureSectionOpen("carry-forward");
await page.click('button:has-text("+ carry forward from another question")');
await page.waitForSelector('[data-testid="cf-source"]');
await page.selectOption('[data-testid="cf-source"]', "q6");
await page.waitForTimeout(200);
const filterChoices = await page.$$eval('[data-testid="cf-filter"] option', (os) => os.map((o) => o.textContent));
assert.ok(filterChoices.includes("displayed rows") && !filterChoices.some((t) => /options/.test(t)), filterChoices.join(", "));
ok(`a grid source offers row choices only: ${filterChoices.join(", ")}`);
await page.selectOption('[data-testid="cf-filter"]', "displayed");
await page.waitForSelector('[data-testid="cf-hint"]');
assert.match(await page.textContent('[data-testid="cf-hint"]'), /actually showed/);
await page.check('[data-testid="cf-col-2"]');
await page.waitForTimeout(300);
const cf = q(await readDef(), "q10").carryForward;
assert.deepEqual({ s: cf.sourceQuestionId, f: cf.filter, c: cf.columns }, { s: "q6", f: "displayed", c: [2] });
ok("29-09 #5 / #6 — displayed rows of Q6, only where “Used” was chosen");
await page.selectOption('[data-testid="cf-source"]', "q2");
await page.waitForTimeout(200);
const flat = await page.$$eval('[data-testid="cf-filter"] option', (os) => os.map((o) => o.textContent));
assert.ok(flat.includes("selected options") && !flat.some((t) => /rows/.test(t)), flat.join(", "));
assert.equal(await page.$('[data-testid="cf-columns"]'), null);
ok(`a multi-select source offers option choices only: ${flat.join(", ")}`);
await page.click('[data-testid="carry-forward-editor"] button:has-text("remove")');

/* ------------------------------------------------ conditional validation */
await selectQuestion("Q3");
await ensureSectionOpen("validation-rules");
await page.click('[data-testid="psec-body-validation-rules"] button:has-text("+ rule")');
await page.waitForSelector('[data-testid="validation-when"]');
await page.click('[data-testid="validation-when"] [data-testid="optional-add"]');
await page.waitForTimeout(300);
assert.ok(q(await readDef(), "q3").validation[0].when, "the gate is stored");
ok("a validation rule can be gated — “Check this rule only when”");

assert.deepEqual(errors, [], `no console errors in the Studio: ${errors.join(" | ")}`);
ok("no console errors in the Studio");

/* ================================================ runtime */

/* Oweas #7: the numeric grid row, any column */
const gridDef = {
  meta: { id: "rt1", code: "RT1", title: "grid", version: "1.0" },
  questions: [
    { id: "q4", code: "Q4", variableName: "Q4", type: "composite", variant: "matrix.numeric", text: "Amounts",
      rows: [{ code: "R1", label: "Item 1" }, { code: "R2", label: "Item 2" }],
      columns: [{ id: "c1", label: "Now", responseType: "numeric", variableStem: "Q4A" }, { id: "c2", label: "Later", responseType: "numeric", variableStem: "Q4B" }] },
    { id: "q10", code: "Q10", variableName: "Q10", type: "single_select", text: "Why so many?", options: opts(2),
      displayLogic: { type: "rule", source: { kind: "question", ref: "q4", rowCode: "R1" }, operator: "gt", value: 23 } },
    { id: "q11", code: "Q11", variableName: "Q11", type: "open_text", text: "Thanks" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q4"] }, { type: "page", id: "p2", questionIds: ["q10", "q11"] }, { type: "end", id: "e", status: "complete" }],
};
const runGrid = async (r1c2) => {
  const pv = await openPreview(browser, RUNTIME, { definition: gridDef }, { viewport: { width: 1200, height: 900 } });
  const inputs = await pv.$$('[data-rs-el="question"][data-rs-id="q4"] input');
  assert.ok(inputs.length >= 4, `a 2×2 numeric grid renders 4 inputs (${inputs.length})`);
  await inputs[0].fill("5"); await inputs[1].fill(String(r1c2)); await inputs[2].fill("1"); await inputs[3].fill("1");
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q11"]');
  const shown = !!(await pv.$('[data-rs-el="question"][data-rs-id="q10"]'));
  await pv.close();
  return shown;
};
assert.equal(await runGrid(30), true, "Item 1 · Later = 30 > 23");
assert.equal(await runGrid(20), false);
ok("Oweas #7 — runtime: “Item 1, any column, > 23” shows the follow-up only when a cell of Item 1 is above 23");

/* Prince 66: same-page cascade, numeric → hidden → hidden → live display logic */
const mkRule = (src, op, v, v2) => ({ type: "rule", source: { kind: "question", ref: src }, operator: op, value: v, ...(v2 !== undefined ? { value2: v2 } : {}) });
const punch = (id, when, codes, mode) => ({ id, source: { kind: "codes", codes }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always", when, ...(mode ? { mode } : {}) });
const cascadeDef = {
  meta: { id: "rt2", code: "RT2", title: "cascade", version: "1.0" },
  questions: [
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many?" },
    { id: "q8", code: "Q8", variableName: "Q8", type: "hidden", text: "Band", options: [{ code: 1, label: "Low" }, { code: 2, label: "Medium" }, { code: 3, label: "High" }],
      punches: [punch("a", mkRule("q3", "between", 0, 3), [1]), punch("b", mkRule("q3", "between", 4, 7), [2], "else_if"), punch("c", mkRule("q3", "gt", 7), [3], "else_if")] },
    { id: "q9", code: "Q9", variableName: "Q9", type: "hidden", text: "High band", options: [{ code: 1, label: "no" }, { code: 2, label: "yes" }],
      punches: [punch("d", mkRule("q8", "selected", 3), [2])] },
    { id: "q12", code: "Q12", variableName: "Q12", type: "open_text", text: "Tell us about the high volume",
      displayLogic: { type: "group", op: "and", children: [mkRule("q9", "selected", 2), { type: "group", op: "not", children: [mkRule("q3", "gt", 100)] }] } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q3", "q8", "q9", "q12"] }, { type: "end", id: "e", status: "complete" }],
};
const pv = await openPreview(browser, RUNTIME, { definition: cascadeDef }, { viewport: { width: 1200, height: 900 } });
const numBox = '[data-rs-el="question"][data-rs-id="q3"] input';
assert.equal(await pv.$('[data-rs-el="question"][data-rs-id="q12"]'), null);
await pv.fill(numBox, "9");
await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q12"]', { timeout: 5000 });
ok("Prince 66 — runtime: typing 9 punches Q8 = High, which punches Q9, which shows Q12 on the same page");
await pv.fill(numBox, "5");
await pv.waitForTimeout(500);
assert.equal(await pv.$('[data-rs-el="question"][data-rs-id="q12"]'), null, "5 is Medium: the cascade un-punches and Q12 goes");
await pv.fill(numBox, "500");
await pv.waitForTimeout(500);
assert.equal(await pv.$('[data-rs-el="question"][data-rs-id="q12"]'), null, "the nested NOT (Q3 > 100) hides it again");
ok("…and changing the answer re-runs the chain both ways, through a nested NOT");
await pv.close();

await browser.close();
console.log(`\n${passed} checks passed`);
