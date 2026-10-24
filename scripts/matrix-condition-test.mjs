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
  /* edited in the centred logic workspace; h.readDef (→ openTab) saves it first */
  await openSectionWorkspace(page, "display-logic");
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

/* ------------------------------------------------ P2 batch (2026-10-16) */
{ /* OR-06 / OR-04 / OR-05 — the source picker, the value picker, the operator list for a composite column */
  const rate = ["1", "2", "3", "4", "5"].map((c) => ({ code: c, label: c, flags: [] }));
  const col = (id, label, responseType, options = []) => ({ id, label, responseType, variableStem: label.toUpperCase(), options, validation: [], readOnly: false });
  const def2 = fixture();
  def2.questions.splice(3, 0,
    base("q_rate", "Q5", "matrix_single", { options: rate, rows: [row("1", "Speed")] }),
    base("q_comp", "Q6", "composite", { rows: [row("1", "Item")], columns: [col("c_n", "Spend", "numeric"), col("c_t", "Note", "text")] }),
  );
  def2.flow[0].questionIds.push("q_rate", "q_comp");
  await h.loadDef(def2);
  await openLogic();
  const add2 = await page.$('[data-testid="optional-add"]');
  if (add2) await add2.click();
  await page.waitForSelector('[data-testid="logic-builder"]');
  await page.click('[data-testid="lb-add-condition"]');
  await page.waitForSelector('[data-testid="lb-row"]');

  /* OR-06: the quality scores are one group, and the LAST one */
  const groups = await page.$$eval(".ref-select optgroup", (g) => g.map((x) => [x.label, x.querySelectorAll("option").length]));
  const q = groups.find(([l]) => /^Quality scores/.test(l));
  assert.ok(q && q[1] > 20, `a "Quality scores" group with the SYSTEM_* variables: ${JSON.stringify(groups)}`);
  assert.equal(groups[groups.length - 1][0], q[0], "…at the end of the list");
  assert.ok(!groups.some(([l]) => /Quality metrics/.test(l)), "the old inline group is gone");
  ok("OR-06: the SYSTEM_* quality variables sit in one 'Quality scores' group at the end of the source picker");

  /* OR-04: code == label prints once */
  await page.selectOption(".ref-select", { label: "Q5 — Q5" });
  await settle();
  await page.selectOption('[data-testid="cond-operator"]', "gte");
  await settle();
  const vals = await page.$$eval('[data-testid="cond-value"] option', (o) => o.map((x) => x.textContent));
  assert.deepEqual(vals, ["— value —", "1", "2", "3", "4", "5"], `no "1: 1": ${vals}`);
  ok("OR-04: a scale whose codes and labels are the same reads 1 · 2 · 3, not 1: 1 · 2: 2 · 3: 3");

  /* OR-05: a composite column offers its own type's operators */
  await page.selectOption(".ref-select", { label: "Q6 — Q6" });
  await settle();
  const allOps = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.value));
  await page.selectOption('[data-testid="cond-column"]', "c_n");
  await settle();
  const numOps = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.value));
  assert.ok(numOps.includes("gt") && numOps.includes("between"), `numeric column compares: ${numOps}`);
  assert.ok(!numOps.includes("matches") && !numOps.includes("rankedFirst") && !numOps.includes("dateBefore"), `…without regex, rank or date: ${numOps}`);
  /* 2026-10-24: a number also offers "is in list" / "is not in list" (client item A48) — 12 of the 22, still its own short list */
  assert.ok(numOps.length <= 12 && numOps.length < allOps.length * 0.6, `${numOps.length} operators instead of ${allOps.length}`);
  await page.selectOption('[data-testid="cond-column"]', "c_t");
  await settle();
  const txtOps = await page.$$eval('[data-testid="cond-operator"] option', (o) => o.map((x) => x.value));
  assert.ok(txtOps.includes("contains") && txtOps.includes("matches") && !txtOps.includes("gt"), `text column: ${txtOps}`);
  ok("OR-05: a composite column's operator list follows the column's own type (numeric, text)");
}

{ /* OR-02 — a matrix at 390 px: stacked when <= 7 scale points, a visible hint when wider */
  const wide = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((c) => ({ code: c, label: `Pt ${c}`, flags: [] }));
  const pv390 = await h.preview(["q_sat", "q_wide"], (d) => {
    d.questions.push(base("q_wide", "Q9", "matrix_single", { options: wide, rows: [row("1", "Service quality overall")] }));
  });
  await pv390.setViewportSize({ width: 390, height: 800 });
  await pv390.waitForTimeout(400);
  const stacked = await pv390.$eval('[data-qid="q_sat"] table', (t) => t.dataset.stack);
  assert.equal(stacked, "true", "the 5-point matrix stacks");
  const reach = await pv390.$$eval('[data-qid="q_sat"] tbody tr:first-child input[type="radio"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  assert.equal(reach.length, 5);
  assert.ok(reach.every((r) => r <= 390), `every one of the 5 scale points is on screen without scrolling sideways: ${reach}`);
  const caps = await pv390.$$eval('[data-qid="q_sat"] tbody tr:first-child .rs-mcap', (els) => els.map((e) => e.textContent));
  assert.deepEqual(caps, ["Poor", "Fair", "OK", "Good", "Great"], "each control carries its own caption");
  await pv390.locator('[data-qid="q_sat"] tbody tr:first-child label.rs-mcell').nth(4).click();   // tap the caption row, not just the dot
  assert.equal(await pv390.locator('[data-qid="q_sat"] input[name="q_sat_1"]').nth(4).isChecked(), true, "tapping the label answers");
  assert.equal(await pv390.$eval('[data-qid="q_wide"] table', (t) => t.dataset.stack ?? null), null, "a 9-point matrix keeps its columns…");
  assert.equal(await pv390.locator('[data-qid="q_wide"] [data-testid="matrix-scroll-hint"]').isVisible(), true, "…and says there is more to the right");
  await pv390.context().close();
  ok("OR-02: at 390 px a 5-point matrix is STACKED (every scale point reachable, labelled); a 9-point one shows a 'scroll sideways' hint");
}

/* ------------------------------------------------ P3 batch (2026-10-16) */
{ /* OR-07 — the reference chip does not repeat the row and column the two selects already show */
  await h.loadDef(fixture());
  await openLogic();
  const add3 = await page.$('[data-testid="optional-add"]');
  if (add3) await add3.click();
  await page.waitForSelector('[data-testid="logic-builder"]');
  await page.click('[data-testid="lb-add-condition"]');
  await page.waitForSelector('[data-testid="lb-row"]');
  await page.selectOption(".ref-select", { label: "Q1 — Q1" });
  await settle();
  await page.selectOption('[data-testid="cond-row"]', "1");
  await page.selectOption('[data-testid="cond-column"]', "4");
  await settle();
  const chip = page.locator('[data-testid="cond-reference"]');
  assert.equal((await chip.textContent()).trim(), "Q1", "row + column selects both shown: the chip is just the question");
  assert.equal(await chip.getAttribute("data-collapsed"), "true");
  assert.match(await chip.getAttribute("title"), /Q1\[Service\]\.Good/, "the full reference is still on hover");
  /* a comparison hides the column select — the chip names the row again */
  await page.selectOption('[data-testid="cond-operator"]', "gte");
  await settle();
  assert.equal(await page.locator('[data-testid="cond-column"]').count(), 0);
  assert.equal((await chip.textContent()).trim(), "Q1[Service]", "only the row select is shown: the chip spells the row");
  assert.equal(await chip.getAttribute("data-collapsed"), null);
  ok("OR-07: the reference chip collapses to the question when the row AND column selects are both on screen");
}

{ /* LOGIC-15 — a per-row grid's scale is offered as scale points (columns) in the Display Rules target picker */
  await h.goTab("Logic");
  await page.click('button:has-text("+ display rule")');
  await page.waitForSelector('[data-testid="dr-kind-0"]');
  await page.selectOption('[data-testid="dr-kind-0"]', "option");
  await page.waitForTimeout(150);
  const refs = await page.$$eval('[data-testid="dr-ref-0"] option', (els) => els.map((e) => ({ value: e.value, text: e.textContent.trim() })));
  const sat = refs.find((o) => o.value === "q_sat");
  assert.ok(sat && /scale point \(column\)/.test(sat.text), `the grid says what its options are: ${JSON.stringify(sat)}`);
  const plain = refs.find((o) => o.value === "q_next");
  assert.ok(plain && !/scale point/.test(plain.text), "an ordinary question's options stay options");
  await page.selectOption('[data-testid="dr-ref-0"]', "q_sat");
  await page.waitForTimeout(150);
  const subs = await page.$$eval('[data-testid="dr-sub-0"] option', (els) => els.map((e) => e.textContent.trim()));
  assert.equal(subs[1], "scale point 1 — Poor", `items read as scale points: ${subs}`);
  ok("LOGIC-15: a per-row grid's 'option' targets are labelled scale point (column), as in the Logic Builder");
}

await h.close();
console.log(`\nALL MATRIX CONDITION CHECKS PASSED (${passed})`);
