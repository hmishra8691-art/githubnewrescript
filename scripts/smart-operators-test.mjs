/**
 * SMART OPERATORS — the logic builder offers each source its own operators
 * (documents 15/10 and 16/10, October 2026).
 *
 * What this proves, in the real Studio builder and then in the real runtime:
 *   · a Single Select offers only its operators (=, ≠, any of, none of,
 *     shown, answered) with Equals as the default — no >, <, between, contains;
 *   · a Multi Select shows its GROUPS (operators · count · shown · response
 *     status) and starts on "has selected";
 *   · a numeric "between" shows TWO number inputs;
 *   · a grid shows a row selector;
 *   · the operator dropdown can be searched;
 *   · a sentence under each condition says what it means, and the display
 *     logic reads "Display Q4 if …";
 *   · "Test condition" evaluates a typed response with the real evaluator;
 *   · a source whose type changes marks the rule NEEDS UPDATE, keeps the
 *     stored operator, and the quality check refuses to deploy;
 *   · an Embedded Data ZIP list starts on "contains item", and a branch on it
 *     routes the runtime preview (:3001) for 10003 and not for 10009.
 *
 *   node scripts/smart-operators-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const h = await openHarness();
const { page } = h;
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const settle = () => page.waitForTimeout(250);

const o = (code, label) => ({ code, label, flags: [] });
const row = (code, label) => ({ code, label, flags: [], validation: [], required: false });
const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const ZIPS = "10001, 10002, 10003, 10004, 10005";
const fixture = (displayLogic) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "SmartOps", version: "1.0" },
  questions: [
    base("q_drink", "Q1", "single_select", { options: [o("1", "Tea"), o("2", "Coffee"), o("3", "Water")] }),
    base("q_fruit", "Q2", "multi_select", { options: [o("a", "Apple"), o("b", "Banana")] }),
    base("q_age", "Q3", "numeric"),
    base("q_next", "Q4", "open_text", displayLogic ? { displayLogic } : {}),
    base("q_grid", "Q5", "matrix_single", { options: [o("1", "Poor"), o("2", "OK"), o("3", "Good")], rows: [row("r1", "Service"), row("r2", "Price")] }),
  ],
  flow: [
    { type: "embedded_data", id: "ed", fields: [{ name: "ZIP_Code_DMA", source: "static", value: ZIPS, dataType: "string" }] },
    { type: "page", id: "p1", questionIds: ["q_drink", "q_fruit", "q_age", "q_grid"] },
    { type: "page", id: "p2", questionIds: ["q_next"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

const firstRule = (c) => (c?.type === "group" ? firstRule(c.children[0]) : c);
const openLogic = async () => {
  await h.goTab("Questions");
  await page.waitForSelector('[data-testid="qcard"][data-qid="q_next"]');
  await page.click('[data-testid="qcard"][data-qid="q_next"]');
  const head = '[data-testid="psec-head-display-logic"]';
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") await page.click(head);
  await page.waitForTimeout(200);
};
const logicOf = async () => {
  const c = (await h.readDef()).questions.find((q) => q.id === "q_next").displayLogic;
  await openLogic();
  return c;
};
const opOptions = () => page.$$eval('[data-testid="cond-operator"] option', (os) => os.map((x) => x.value));
const opGroups = () => page.$$eval('[data-testid="cond-operator"] optgroup', (gs) => gs.map((g) => g.label));

/* ---------------------------------------------------------- single select */
await h.loadDef(fixture());
await openLogic();
const add = await page.$('[data-testid="optional-add"]');
if (add) await add.click();
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
await page.selectOption(".ref-select", { label: "Q1 — Q1" });
await settle();
let ops = await opOptions();
assert.deepEqual(ops, ["eq", "ne", "in", "notIn", "displayed", "notDisplayed", "answered", "unanswered"], `single select offers only its own operators: ${ops}`);
assert.equal(await page.$eval('[data-testid="cond-operator"]', (e) => e.value), "eq", "Equals is the default");
assert.deepEqual(await opGroups(), ["Operators", "Shown to the respondent", "Response status"]);
ok("a Single Select shows =, ≠, any of, none of, shown, answered — Equals by default, nothing numeric");

/* the value is an option, and the sentence under the rule says so */
await page.selectOption('[data-testid="cond-operator"]', "in");
await settle();
await page.waitForSelector('[data-testid="cond-options"]');
await page.click('[data-testid="cond-option"][data-code="1"]');
await settle();
await page.click('[data-testid="cond-option"][data-code="2"]');
await settle();
let r = firstRule(await logicOf());
assert.equal(r.operator, "in");
assert.deepEqual(r.value, ["1", "2"]);
const sentence = await page.textContent('[data-testid="cond-rule-summary"]');
assert.match(sentence, /selects “Tea” or “Coffee” at Q1/, `the rule in words: ${sentence}`);
const purpose = await page.textContent('[data-testid="cond-purpose-summary"]');
assert.match(purpose, /^Display Q4 if the respondent selects “Tea” or “Coffee” at Q1\.$/, `the display logic in words: ${purpose}`);
ok("“is any of” takes several options; the summary reads “Display Q4 if the respondent selects Tea or Coffee”");

/* test condition: the real evaluator */
await page.click('[data-testid="cond-test-toggle"]');
await page.waitForSelector('[data-testid="cond-test-input"]');
await page.fill('[data-testid="cond-test-input"][data-key="q:q_drink"]', "2");
await settle();
assert.equal(await page.textContent('[data-testid="cond-test-result"]'), "TRUE");
await page.fill('[data-testid="cond-test-input"][data-key="q:q_drink"]', "3");
await settle();
assert.equal(await page.textContent('[data-testid="cond-test-result"]'), "FALSE");
await page.click('[data-testid="cond-test-toggle"]');
ok("Test condition: Coffee → TRUE, Water → FALSE");

/* search inside the operator dropdown */
await page.selectOption(".ref-select", { label: "Q2 — Q2" });
await settle();
await page.fill('[data-testid="cond-op-search"]', "none");
await settle();
const found = await opOptions();
assert.ok(found.includes("containsNone") && !found.includes("containsAll"), `search narrows the list: ${found}`);
await page.fill('[data-testid="cond-op-search"]', "");
await settle();
ok("the operator dropdown can be searched — only this source's operators are found");

/* ---------------------------------------------------------- multi select */
ops = await opOptions();
assert.equal(await page.$eval('[data-testid="cond-operator"]', (e) => e.value), "selected", "Has selected is the default");
assert.deepEqual(await opGroups(), ["Operators", "Count", "Shown to the respondent", "Response status"]);
for (const want of ["selected", "notSelected", "containsAny", "containsAll", "containsNone", "containsExactly", "count:gte", "answered"]) {
  assert.ok(ops.includes(want), `multi select offers ${want}: ${ops}`);
}
assert.ok(!ops.includes("eq"), "Equals is not a multi-select operator");
await page.selectOption('[data-testid="cond-operator"]', "count:gte");
await settle();
r = firstRule(await logicOf());
assert.deepEqual([r.operator, r.source.count?.of, r.value], ["gte", "selected", 1], `a count rule: ${JSON.stringify(r)}`);
await page.click('[data-testid="toggle-count"]'); // back to the answer itself
await settle();
ok("a Multi Select groups its operators, starts on “has selected”, and “number selected ≥” is a count");

/* ---------------------------------------------------------- numeric between */
await page.selectOption(".ref-select", { label: "Q3 — Q3" });
await settle();
assert.equal(await page.$eval('[data-testid="cond-operator"]', (e) => e.value), "eq");
await page.selectOption('[data-testid="cond-operator"]', "between");
await settle();
assert.equal(await page.getAttribute('[data-testid="cond-value-input"]', "type"), "number");
assert.equal(await page.getAttribute('[data-testid="cond-value2"]', "type"), "number");
await page.fill('[data-testid="cond-value-input"]', "18");
await page.fill('[data-testid="cond-value2"]', "34");
await settle();
r = firstRule(await logicOf());
assert.deepEqual([r.operator, String(r.value), String(r.value2)], ["between", "18", "34"]);
ok("numeric “between” shows two number inputs");

/* ---------------------------------------------------------- grid row selector */
await page.selectOption(".ref-select", { label: "Q5 — Q5" });
await settle();
assert.equal(await page.locator('[data-testid="cond-row"]').count(), 1, "a row selector");
assert.equal(await page.$eval('[data-testid="cond-operator"]', (e) => e.value), "selected", "Row is (equals) is the default");
await page.selectOption('[data-testid="cond-row"]', "r1");
await page.selectOption('[data-testid="cond-column"]', "3");
await settle();
r = firstRule(await logicOf());
assert.deepEqual([r.operator, r.source.rowCode, r.source.columnId], ["selected", "r1", "3"]);
ok("a single-select grid: row selector, “is” an answer by default");

/* ---------------------------------------------------------- type change → needs update */
{
  const def = await h.readDef();
  def.questions.find((q) => q.id === "q_next").displayLogic = { type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: "q_fruit" }, operator: "containsAny", value: ["a"] },
  ] };
  await h.loadDef(def);
  await h.goTab("Questions");
  await page.waitForSelector('[data-qid="q_fruit"]');
  if (!(await page.$('[data-qid="q_fruit"].selected'))) await page.click('[data-qid="q_fruit"] .qlist-item');
  await page.waitForTimeout(250);
  await page.selectOption('[data-testid="family-switcher"]', "numeric");
  await page.waitForSelector('[data-testid="type-change-dialog"]');
  await page.click('[data-testid="type-change-confirm"]');
  await page.waitForTimeout(400);
  await openLogic();
  await page.waitForSelector('[data-testid="cond-needs-update"]', { timeout: 8000 });
  assert.equal(await page.$eval('.op-select', (e) => e.value), "containsAny", "the stored operator stays selected");
  const stale = await page.$eval('.op-select', (e) => e.selectedOptions[0].textContent);
  assert.match(stale, /needs update/);
  const offered = await opOptions();
  assert.ok(offered.includes("between") && offered.includes("gt"), `the numeric operators are offered to choose from: ${offered}`);
  r = firstRule(await logicOf());
  assert.equal(r.operator, "containsAny", "nothing was replaced silently");
  await h.goTab("Logic");
  await page.click('[data-testid="run-quality-check"]');
  await page.waitForSelector('[data-testid="qc-verdict"]');
  assert.equal(await page.textContent('[data-testid="qc-verdict"]'), "Not ready to deploy", "the deploy gate refuses it");
  ok("a source retyped to numeric: the rule says NEEDS UPDATE, keeps its operator, and blocks deployment");
}

/* ---------------------------------------------------------- ZIP list: builder + runtime */
await h.loadDef(fixture());
await openLogic();
const add2 = await page.$('[data-testid="optional-add"]');
if (add2) await add2.click();
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
await page.selectOption(".ref-select", "embedded:ZIP_Code_DMA");
await settle();
assert.equal(await page.$eval('[data-testid="cond-operator"]', (e) => e.value), "containsItem", "a list starts on contains item");
assert.equal(await page.textContent('[data-testid="cond-operand-type"]'), "Embedded data — list");
await page.fill('[data-testid="cond-value-input"]', "10003");
await settle();
assert.match(await page.textContent('[data-testid="cond-op-hint"]'), /10001 never matches 110001/);
r = firstRule(await logicOf());
assert.deepEqual([r.source.kind, r.operator, r.value], ["embedded", "containsItem", "10003"]);
ok("an Embedded Data list starts on “contains item”, and says how it differs from “contains text”");

/* the comparison value can be piped (FLOW's shared Insert piped text picker) */
await page.fill('[data-testid="cond-value-input"]', "");
await settle();
await page.click('[data-testid="cond-insert-pipe"]');
await page.waitForSelector('[data-testid="pipe-menu"]');
await page.fill('[data-testid="pipe-search"]', "Q3");
await page.waitForSelector('[data-testid="pipe-item"][data-token^="{{Q3"]');
await page.click('[data-testid="pipe-item"][data-token^="{{Q3"] >> nth=0');
await settle();
r = firstRule(await logicOf());
assert.ok(r.value && typeof r.value.$pipe === "string" && r.value.$pipe.startsWith("{{Q3"), `stored as a piped reference: ${JSON.stringify(r.value)}`);
assert.ok(await page.$('[data-testid="cond-value-pipe"]'), "and shown as piped text");
await page.click('[data-testid="cond-pipe-clear"]');
await settle();
ok("the value field inserts piped text, stored as { $pipe } — not as literal braces");

const zipSurvey = (needle) => ({
  meta: { id: "zip", code: "ZIP", title: "ZIP", version: "1.0" },
  questions: [base("q_in", "QIN", "open_text", { text: "IN THE DMA" }), base("q_out", "QOUT", "open_text", { text: "OUTSIDE THE DMA" })],
  flow: [
    { type: "embedded_data", id: "ed", fields: [{ name: "ZIP_Code_DMA", source: "static", value: ZIPS, dataType: "string" }] },
    { type: "branch", id: "br", branches: [{ id: "b1", when: { type: "rule", source: { kind: "embedded", ref: "ZIP_Code_DMA" }, operator: "containsItem", value: needle }, children: [{ type: "page", id: "p_in", questionIds: ["q_in"] }] }],
      otherwise: [{ type: "page", id: "p_out", questionIds: ["q_out"] }] },
    { type: "end", id: "e1", status: "complete" },
  ],
});
for (const [needle, want] of [["10003", "IN THE DMA"], ["10009", "OUTSIDE THE DMA"], ["10001, 10003", "IN THE DMA"]]) {
  const pv = await openPreview(h.browser, process.env.RUNTIME_URL ?? "http://localhost:3001", { definition: zipSurvey(needle) });
  await pv.waitForSelector(`text=${want}`, { timeout: 15000 });
  const other = want === "IN THE DMA" ? "OUTSIDE THE DMA" : "IN THE DMA";
  assert.equal(await pv.locator(`text=${other}`).count(), 0, `${needle}: only one path`);
  await pv.close();
}
ok("the ZIP branch routes in the runtime preview: 10003 → in the DMA, 10009 → outside, a list needle → in");

console.log(`\n${passed} checks passed`);
await h.close();
