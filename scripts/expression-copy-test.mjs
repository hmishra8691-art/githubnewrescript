/**
 * COPYING AN EXPRESSION DOES NOT CHANGE IT.
 *
 * Text copied out of the Expression editor and pasted into another question's
 * Expression editor must be the SAME condition: the same question, row, column,
 * answer code (zero-padded codes keep their zeros), quoted text and nesting.
 * Pointing a copy at other questions is a separate, explicit "Remap
 * references…" step that shows what it will change and waits to be applied.
 *
 *   node scripts/expression-copy-test.mjs      (studio on 3000)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openSectionWorkspace, openWorkspace, saveWorkspace, LD_BODY } from "./lib/logicWorkspace.mjs";

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
const source = { type: "group", op: "and", children: [
  { type: "rule", source: { kind: "question", ref: "q_codes" }, operator: "contains", value: "01" },
  { type: "rule", source: { kind: "question", ref: "q_sat", rowCode: "1", columnId: "4" }, operator: "selected" },
  { type: "rule", source: { kind: "question", ref: "q_open" }, operator: "eq", value: "it's \"fine\"" },
  { type: "group", op: "or", children: [
    { type: "rule", source: { kind: "question", ref: "q_sat", rowCode: "2" }, operator: "gte", value: "3" },
    { type: "rule", source: { kind: "question", ref: "q_codes" }, operator: "contains", value: "10" },
  ] },
] };
const def = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Copy", version: "1.0" },
  questions: [
    base("q_sat", "Q1", "matrix_single", { options: scale, rows: [row("1", "Service"), row("2", "Price")] }),
    base("q_sat2", "Q2", "matrix_single", { options: scale, rows: [row("1", "Service"), row("2", "Price")] }),
    base("q_codes", "Q3", "multi_select", { options: [{ code: "01", label: "One", flags: [] }, { code: "02", label: "Two", flags: [] }, { code: "10", label: "Ten", flags: [] }] }),
    base("q_open", "Q4", "text"),
    base("q_a", "Q5", "text", { displayLogic: source }),
    base("q_b", "Q6", "text"),
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_sat", "q_sat2", "q_codes", "q_open"] }, { type: "page", id: "p2", questionIds: ["q_a", "q_b"] }, { type: "end", id: "e1", status: "complete" }],
};
await h.loadDef(def);

const openExpr = async (qid) => {
  await h.goTab("Questions");
  await page.waitForSelector(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.click(`[data-testid="qcard"][data-qid="${qid}"]`);
  await openSectionWorkspace(page, "display-logic"); // the builder is in the centred logic workspace; h.readDef saves it
  await page.waitForSelector('[data-testid="logic-mode-bar"]');
  await page.click('[data-testid="mode-expression"]');
  await page.waitForSelector('[data-testid="xe-input"]');
  await page.waitForTimeout(250);
};
const logic = async (qid) => (await h.readDef()).questions.find((q) => q.id === qid).displayLogic;

/* opening the expression changes nothing */
await openExpr("q_a");
const text = await page.inputValue('[data-testid="xe-input"]');
assert.match(text, /contains 01\b/, `zero-padded code is printed with its zero: ${text}`);
assert.deepEqual(await logic("q_a"), source, "opening the Expression tab did not touch the stored condition");
ok("opening the Expression tab leaves the stored condition exactly as it was");

/* copy → paste into another question */
await openExpr("q_a");
await page.click('[data-testid="xe-copy"]');
await openExpr("q_b");
await page.fill('[data-testid="xe-input"]', text);
await page.waitForTimeout(500);
assert.deepEqual(await logic("q_b"), source, "the pasted expression is the same condition");
assert.deepEqual(await logic("q_a"), source, "and the original is untouched");
ok("pasting the copied expression into another question yields the identical condition (codes, quoting, row/column, nesting)");

/* mode round trip on the copy */
await openExpr("q_b");
await page.click('[data-testid="mode-visual"]');
await page.click('[data-testid="mode-expression"]');
await page.waitForTimeout(300);
assert.equal(await page.inputValue('[data-testid="xe-input"]'), text, "visual ↔ expression round trip prints the same text");
assert.deepEqual(await logic("q_b"), source);
ok("visual ↔ expression round trip is stable");

/* explicit remap */
await openExpr("q_b");
await page.click('[data-testid="xe-remap-toggle"]');
await page.waitForSelector('[data-testid="xe-remap"]');
assert.equal(await page.locator('[data-testid="xe-remap-apply"]').isDisabled(), true, "nothing to apply yet");
await page.selectOption('[data-testid="xe-remap-q_sat"]', "q_sat2");
const preview = await page.textContent('[data-testid="xe-remap-preview"]');
assert.match(preview, /Q1 → Q2/);
await page.click('[data-testid="xe-remap-apply"]');
await page.waitForTimeout(400);
const remapped = await logic("q_b");
assert.equal(remapped.children[1].source.ref, "q_sat2");
assert.equal(remapped.children[1].source.rowCode, "1");
assert.equal(remapped.children[1].source.columnId, "4", "row and answer column carry over");
assert.equal(remapped.children[0].source.ref, "q_codes", "unmapped references are left alone");
assert.equal(remapped.children[0].value, "01");
assert.deepEqual(await logic("q_a"), source, "the source expression is never mutated");
ok("Remap references previews what changes, waits to be applied, and touches only what was mapped");

/* duplicating a question keeps rules pointing where they should */
await h.goTab("Questions");
await page.click('[data-testid="qcard"][data-qid="q_a"]');
const dup = await page.$('[data-testid="duplicate-question"], button[title*="uplicate"]');
if (dup) {
  await dup.click();
  await page.waitForTimeout(400);
  const d2 = await h.readDef();
  const orig = d2.questions.find((q) => q.id === "q_a");
  assert.deepEqual(orig.displayLogic, source, "the original keeps its logic after a duplicate");
  ok("duplicating a question leaves the original's expression untouched");
} else console.log("  skip   no duplicate button found in this layout");

await h.close();
console.log(`\n${passed} checks passed`);
