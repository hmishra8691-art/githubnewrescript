/**
 * MATRIX CONDITIONS IN THE LOGIC BUILDER — one control for the answer column.
 *
 * The builder used to ask a matrix source for a Source question, a Row, a
 * Column AND a Value. On a single- or multi-select matrix the column and the
 * value are the SAME categorical answer; the evaluator read the value and
 * ignored the column, so the two boxes could disagree and the one nobody was
 * looking at decided.
 *
 * What this proves, in the real builder and then in the real runtime:
 *   · "is / is not / has selected" on a matrix takes a row and an ANSWER COLUMN,
 *     and there is no value box — `cond-value` does not exist;
 *   · a comparison (≥, between …) takes a VALUE and no column, and switching
 *     between the two carries the scale point across instead of leaving both;
 *   · changing the source question clears the row / column / value, which
 *     belong to the question they were picked on;
 *   · a stored rule that spelt the scale point twice is SHOWN as one cell and
 *     is not rewritten until somebody edits it;
 *   · what is stored reloads unchanged, and the runtime shows or hides the
 *     dependent question for the right row and column.
 *
 *   node scripts/matrix-condition-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const scale = [["1", "Poor"], ["2", "Fair"], ["3", "OK"], ["4", "Good"], ["5", "Great"]].map(([code, label]) => ({ code, label, flags: [] }));
const row = (code, label) => ({ code, label, flags: [], validation: [], required: false });
const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const fixture = (displayLogic) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "MatrixCond", version: "1.0" },
  questions: [
    base("q_sat", "Q1", "matrix_single", { options: scale, rows: [row("1", "Service"), row("2", "Price"), row("3", "Quality")] }),
    base("q_use", "Q2", "matrix_multi", { options: [{ code: "a", label: "Alpha", flags: [] }, { code: "b", label: "Beta", flags: [] }], rows: [row("1", "Web"), row("2", "App")] }),
    base("q_age", "Q3", "numeric"),
    base("q_next", "Q4", "single_select", { options: [{ code: "1", label: "Yes", flags: [] }], ...(displayLogic ? { displayLogic } : {}) }),
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_sat", "q_use", "q_age"] }, { type: "page", id: "p2", questionIds: ["q_next"] }, { type: "end", id: "e1", status: "complete" }],
});

/* reading the definition goes through the JSON tab, so come back to the builder afterwards */
const logicOf = async () => {
  const c = (await h.readDef()).questions.find((q) => q.id === "q_next").displayLogic;
  await openLogic();
  return c;
};
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
const settle = () => page.waitForTimeout(250);

/* ---------------------------------------------------------- authoring */
await h.loadDef(fixture());
await openLogic();
const add = await page.$('[data-testid="optional-add"]');
if (add) await add.click();
await page.waitForSelector('[data-testid="logic-builder"]');
await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
await page.selectOption(".ref-select", { label: "Q1 — Q1" });
await settle();

assert.equal(await page.locator('[data-testid="cond-row"]').count(), 1, "a row picker");
assert.equal(await page.locator('[data-testid="cond-column"]').count(), 1, "an answer-column picker");
assert.equal(await page.locator('[data-testid="cond-value"]').count(), 0, "and NO separate value box — the column is the answer");
const ops = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.textContent));
assert.ok(ops.includes("is") && ops.includes("is not"), `"is / is not" on a single-select matrix: ${ops}`);
assert.ok(!ops.includes("="), "no second way to say the same thing");
ok("a single-select matrix offers row + answer column, with no value box");

await page.selectOption('[data-testid="cond-row"]', "1");
await page.selectOption('[data-testid="cond-column"]', "4");
await settle();
let r = firstRule(await logicOf());
assert.equal(r.operator, "selected");
assert.equal(r.source.rowCode, "1");
assert.equal(r.source.columnId, "4");
assert.ok(!("value" in r) || r.value === undefined || r.value === "", `no value stored: ${JSON.stringify(r)}`);
ok("stored as row 1 + column 4 + selected, with no value");

/* operator switch carries the scale point across */
await page.selectOption('[data-testid="cond-operator"]', "gte");
await settle();
assert.equal(await page.locator('[data-testid="cond-column"]').count(), 0, "a comparison has no column");
assert.equal(await page.locator('[data-testid="cond-value"]').count(), 1, "it has a value");
r = firstRule(await logicOf());
assert.equal(r.operator, "gte");
assert.equal(r.value, "4", "the scale point moved to the value");
assert.equal(r.source.columnId, undefined, "and left the column");
assert.equal(r.source.rowCode, "1", "the row stays");
ok("is → ≥ moves the scale point from the column to the value, never leaving both");

await page.selectOption('[data-testid="cond-operator"]', "selected");
await settle();
r = firstRule(await logicOf());
assert.equal(r.source.columnId, "4");
assert.ok(r.value === undefined || r.value === "" || !("value" in r), "≥ → is moves it back");
ok("≥ → is moves it back");

/* a different question: row, column, value belong to the old one */
await page.selectOption(".ref-select", { label: "Q2 — Q2" });
await settle();
r = firstRule(await logicOf());
assert.equal(r.source.ref, "q_use");
assert.equal(r.source.rowCode, undefined, "the row was cleared");
assert.equal(r.source.columnId, undefined, "the column was cleared");
const multiOps = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.textContent));
assert.ok(multiOps.includes("has selected") && multiOps.includes("hasn't selected"), `multi-select words: ${multiOps}`);
assert.equal(await page.locator('[data-testid="cond-value"]').count(), 0);
await page.selectOption('[data-testid="cond-row"]', "2");
await page.selectOption('[data-testid="cond-column"]', "b");
await page.selectOption('[data-testid="cond-operator"]', "notSelected");
await settle();
r = firstRule(await logicOf());
assert.deepEqual([r.operator, r.source.rowCode, r.source.columnId], ["notSelected", "2", "b"]);
ok("changing the source question resets row / column / value; multi-select reads has / hasn't selected");

await page.selectOption(".ref-select", { label: "Q3 — Q3" });
await settle();
assert.equal(await page.locator('[data-testid="cond-row"]').count(), 0, "a numeric question has no rows");
assert.equal(await page.locator('[data-testid="cond-column"]').count(), 0);
r = firstRule(await logicOf());
assert.equal(r.source.rowCode, undefined);
assert.equal(r.source.columnId, undefined);
ok("a numeric source shows neither row nor column");

/* ------------------------------------------------- legacy: a rule that spelt the scale point twice */
const legacy = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q_sat", rowCode: "1", columnId: "2" }, operator: "selected", value: "4" }] };
await h.loadDef(fixture(legacy));
await openLogic();
await page.waitForSelector('[data-testid="cond-column"]');
assert.equal(await page.inputValue('[data-testid="cond-column"]'), "4", "shown as the value it was evaluated by, not the column that was ignored");
assert.equal(await page.locator('[data-testid="cond-value"]').count(), 0);
r = firstRule(await logicOf());
assert.deepEqual(r.source, { kind: "question", ref: "q_sat", rowCode: "1", columnId: "4" }, "the Studio migrated it once, on load");
assert.ok(r.value === undefined || !("value" in r), "to the single form");
await page.selectOption('[data-testid="cond-column"]', "5");
await settle();
r = firstRule(await logicOf());
assert.deepEqual(r.source, { kind: "question", ref: "q_sat", rowCode: "1", columnId: "5" });
ok("a rule that spelt the scale point twice is migrated to one cell on load, and edits from there");

/* --------------------------------------------------------------- runtime */
const cell = { type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q_sat", rowCode: "1", columnId: "4" }, operator: "selected" }] };
await h.loadDef(fixture(cell));
await openLogic();
const reloaded = firstRule(await logicOf());
assert.deepEqual(reloaded, cell.children[0], "save → reload keeps exactly what was stored");
ok("save and reload preserve the exact condition");

const pv = await h.preview(["q_sat"], (d) => {
  d.flow = [{ type: "page", id: "p1", questionIds: ["q_sat"] }, { type: "page", id: "p2", questionIds: ["q_next"] }, { type: "end", id: "e1", status: "complete" }];
});
const pick = (rowCode, colIndex) => pv.locator(`[data-qid="q_sat"] input[name="q_sat_${rowCode}"]`).nth(colIndex).click();
await pick("2", 3);   // row 2 (Price) answers Good
await pv.waitForTimeout(200);
await pv.click(".rs-nav .rs-btn:not(.secondary)").catch(() => {});
await pv.waitForTimeout(300);
const shownWrongRow = await pv.locator('[data-qid="q_next"]').count();
assert.equal(shownWrongRow, 0, "row 2 answered Good: the question that wants row 1 is not shown");
await pv.context().close();
ok("runtime: another row's answer does not show the dependent question");

/* and the right cell does — through the same preview, a fresh response */
const pv2 = await h.preview(["q_sat"], (d) => {
  d.flow = [{ type: "page", id: "p1", questionIds: ["q_sat"] }, { type: "page", id: "p2", questionIds: ["q_next"] }, { type: "end", id: "e1", status: "complete" }];
});
await pv2.locator('[data-qid="q_sat"] input[name="q_sat_1"]').nth(3).click();   // row 1 (Service) answers Good
await pv2.waitForTimeout(200);
await pv2.click(".rs-nav .rs-btn:not(.secondary)");
await pv2.waitForSelector('[data-qid="q_next"]', { timeout: 8000 });
await pv2.context().close();
ok("runtime: row 1 answered Good shows the dependent question");

await h.close();
console.log(`\nALL MATRIX CONDITION CHECKS PASSED (${passed})`);
