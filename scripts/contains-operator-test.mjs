/**
 * THE CONTAINS OPERATOR AND OPEN-ENDED ANSWERS (2026-10-24, client Excel
 * 19/10 items A46 + A48) — in the real Studio builder and the real runtime.
 *
 *   · a text open end offers "is between (numbers)" with two number inputs,
 *     "is in list" with a value list, and "contains text" — and says how a
 *     comma-separated answer is read;
 *   · a Single Select offers no Contains at all; a Numeric offers "is in
 *     list" (chips) and no Contains;
 *   · Q1 "enter numbers 1–100, separated by commas" → Q2 display logic
 *     Between 1–100 → runtime preview: 25 shows Q2, 150 hides it,
 *     "25,26" shows it; the branch-logic twin routes the same way;
 *   · the Test condition panel agrees (same evaluator);
 *   · a stored `contains` on a Single Select is marked NEEDS UPDATE with a
 *     one-click "use equals" that keeps the value; the quality check does
 *     not refuse to deploy over it (it is a warning).
 *
 *   node scripts/contains-operator-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";
import { openSectionWorkspace, openWorkspace, saveWorkspace, LD_BODY } from "./lib/logicWorkspace.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
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
const h = await retry("opening the Studio", () => openHarness());
const { page } = h;
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const settle = () => page.waitForTimeout(250);

const o = (code, label) => ({ code, label, flags: [] });
const base = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: `${code} text`, options: [], rows: [], columns: [],
  validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const between = (ref, lo, hi) => ({ type: "rule", source: { kind: "question", ref }, operator: "between", value: lo, value2: hi });
const fixture = (displayLogic) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Contains", version: "1.0" },
  questions: [
    base("q1", "Q1", "open_text", { text: "Enter a number between 1 and 100, separated by commas" }),
    base("q_single", "Q3", "single_select", { options: [o("1", "Tea"), o("2", "Coffee")] }),
    base("q_num", "Q4", "numeric"),
    base("q_disp", "Q2", "open_text", { text: "WHY DID YOU SELECT THIS NUMBER", ...(displayLogic ? { displayLogic } : {}) }),
    base("q_always", "Q5", "open_text", { text: "ALWAYS SHOWN" }),
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q_single", "q_num"] },
    { type: "page", id: "p2", questionIds: ["q_disp", "q_always"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});
const firstRule = (c) => (c?.type === "group" ? firstRule(c.children[0]) : c);
const openLogic = async () => {
  await h.goTab("Questions");
  await page.waitForSelector('[data-testid="qcard"][data-qid="q_disp"]');
  await page.click('[data-testid="qcard"][data-qid="q_disp"]');
  /* (H1, 24 Oct) display logic is edited in the centred logic workspace; h.readDef (→ openTab) saves it */
  await openSectionWorkspace(page, "display-logic");
  await page.waitForTimeout(200);
};
const logicOf = async () => {
  const c = (await h.readDef()).questions.find((q) => q.id === "q_disp").displayLogic;
  await openLogic();
  return c;
};
const opOptions = () => page.$$eval('[data-testid="cond-operator"] option', (os) => os.map((x) => x.value));
const opLabels = () => page.$$eval('[data-testid="cond-operator"] option', (os) => os.map((x) => x.textContent.trim()));
const startRule = async () => {
  await openLogic();
  const add = await page.$('[data-testid="optional-add"]');
  if (add) await add.click();
  await page.waitForSelector('[data-testid="logic-builder"]');
  await page.click('[data-testid="lb-add-condition"]');
  await page.waitForSelector('[data-testid="lb-row"]');
};

/* ------------------------------------------------- 1. the text open end's operators */
await h.loadDef(fixture());
await startRule();
await page.selectOption(".ref-select", "q:q1");
await settle();
let ops = await opOptions();
let labels = await opLabels();
assert.ok(ops.includes("contains") && labels.includes("contains text"), `a text open end offers contains text: ${labels}`);
assert.ok(ops.includes("between") && labels.includes("is between (numbers)"), `…and is between (numbers): ${labels}`);
assert.ok(ops.includes("in") && labels.includes("is in list"), `…and is in list: ${labels}`);
await page.selectOption('[data-testid="cond-operator"]', "between");
await settle();
assert.equal(await page.getAttribute('[data-testid="cond-value-input"]', "type"), "number", "a range: two number inputs");
assert.equal(await page.getAttribute('[data-testid="cond-value2"]', "type"), "number");
await page.fill('[data-testid="cond-value-input"]', "1");
await page.fill('[data-testid="cond-value2"]', "100");
await settle();
let r = firstRule(await logicOf());
assert.deepEqual([r.source.ref, r.operator, String(r.value), String(r.value2)], ["q1", "between", "1", "100"], JSON.stringify(r));
const hint = await page.textContent('[data-testid="cond-op-hint"]');
assert.match(hint, /separated by commas/, `the hint says how a comma-separated answer is read: ${hint}`);
ok("Q1 (text) → Q2 display logic: “is between (numbers)” 1–100 with two number inputs; the hint explains comma-separated answers");

/* the Test condition panel runs the real evaluator on the client's inputs */
await page.click('[data-testid="cond-test-toggle"]');
await page.waitForSelector('[data-testid="cond-test-input"][data-key="q:q1"]');
for (const [typed, want] of [["25", "TRUE"], ["150", "FALSE"], ["25,26,27,45,39,50", "TRUE"], ["99.100,101", "FALSE"], ["100", "TRUE"]]) {
  await page.fill('[data-testid="cond-test-input"][data-key="q:q1"]', typed);
  await settle();
  assert.equal(await page.textContent('[data-testid="cond-test-result"]'), want, `test condition "${typed}" → ${want}`);
}
await page.click('[data-testid="cond-test-toggle"]');
ok("Test condition: 25 → TRUE, 150 → FALSE, 25,26,27,45,39,50 → TRUE, 99.100,101 → FALSE, 100 → TRUE");

/* ------------------------------------------------- 2. single select: no Contains; numeric: is in list */
await page.selectOption(".ref-select", "q:q_single");
await settle();
ops = await opOptions();
assert.ok(!ops.includes("contains") && !ops.includes("notContains"), `a Single Select has no Contains: ${ops}`);
assert.deepEqual(ops, ["eq", "ne", "in", "notIn", "displayed", "notDisplayed", "answered", "unanswered"]);
ok("a Single Select's operator menu has no Contains");

await page.selectOption(".ref-select", "q:q_num");
await settle();
ops = await opOptions();
labels = await opLabels();
assert.ok(!ops.includes("contains"), `a Numeric has no Contains: ${ops}`);
assert.ok(labels.includes("is in list") && labels.includes("is not in list"), `a Numeric offers is in list: ${labels}`);
await page.selectOption('[data-testid="cond-operator"]', "in");
await settle();
await page.fill('[data-testid="cond-value-input"]', "1, 5, 10, 25");
await settle();
await page.waitForSelector('[data-testid="cond-value-chip"]');
assert.equal(await page.locator('[data-testid="cond-value-chip"]').count(), 4, "one chip per value");
r = firstRule(await logicOf());
assert.deepEqual([r.operator, r.value], ["in", ["1", "5", "10", "25"]]);
await page.click('[data-testid="cond-value-chip"][data-value="10"] button');
await settle();
r = firstRule(await logicOf());
assert.deepEqual(r.value, ["1", "5", "25"], "a chip's × removes that value");
assert.equal(await page.locator('[data-testid="cond-value-chip"]').count(), 3);
ok("a Numeric offers “is in list” — typed with commas, shown as removable chips, stored as a list");

/* ------------------------------------------------- 3. runtime: display logic and branch logic */
const displayDef = fixture(between("q1", 1, 100));
for (const [typed, want] of [["25", true], ["150", false], ["25,26", true], ["99.100,101", false], ["100", true]]) {
  const pv = await retry("opening the preview", () => openPreview(h.browser, RUNTIME, { definition: displayDef }));
  await pv.fill('[data-rs-el="question"][data-rs-id="q1"] input, [data-rs-el="question"][data-rs-id="q1"] textarea', typed);
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q_always"]', { timeout: 15000 });
  await pv.waitForTimeout(200);
  const shown = (await pv.locator('[data-rs-el="question"][data-rs-id="q_disp"]').count()) > 0;
  assert.equal(shown, want, `display logic: "${typed}" → Q2 ${want ? "shown" : "hidden"}`);
  await pv.close();
}
ok("runtime preview, display logic Between 1–100: 25 shows Q2, 150 hides it, “25,26” shows, “99.100,101” hides, 100 shows");

const branchDef = {
  meta: { id: "branch", code: "BR", title: "Branch", version: "1.0" },
  questions: [
    base("q1", "Q1", "open_text", { text: "Enter a number" }),
    base("q_hit", "QHIT", "open_text", { text: "IN RANGE BRANCH" }),
    base("q_miss", "QMISS", "open_text", { text: "OUT OF RANGE BRANCH" }),
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "branch", id: "br", branches: [{ id: "b1", when: between("q1", 1, 100), children: [{ type: "page", id: "p_hit", questionIds: ["q_hit"] }] }],
      otherwise: [{ type: "page", id: "p_miss", questionIds: ["q_miss"] }] },
    { type: "end", id: "e1", status: "complete" },
  ],
};
for (const [typed, want] of [["25", "IN RANGE BRANCH"], ["150", "OUT OF RANGE BRANCH"], ["25,26", "IN RANGE BRANCH"], ["99.100,101", "OUT OF RANGE BRANCH"]]) {
  const pv = await retry("opening the preview", () => openPreview(h.browser, RUNTIME, { definition: branchDef }));
  await pv.fill('[data-rs-el="question"][data-rs-id="q1"] input, [data-rs-el="question"][data-rs-id="q1"] textarea', typed);
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector(`text=${want}`, { timeout: 15000 });
  const other = want === "IN RANGE BRANCH" ? "OUT OF RANGE BRANCH" : "IN RANGE BRANCH";
  assert.equal(await pv.locator(`text=${other}`).count(), 0, `branch "${typed}": only one path`);
  await pv.close();
}
ok("runtime preview, branch logic Between 1–100 routes the same way: 25 and “25,26” in, 150 and “99.100,101” out");

/* ------------------------------------------------- 4. a stored contains on a Single Select: needs update */
{
  const def = fixture({ type: "group", op: "and", children: [{ type: "rule", source: { kind: "question", ref: "q_single" }, operator: "contains", value: "2" }] });
  await h.loadDef(def);
  await openLogic();
  await page.waitForSelector('[data-testid="cond-needs-update"]', { timeout: 8000 });
  assert.equal(await page.$eval(".op-select", (e) => e.value), "contains", "the stored operator stays selected");
  const fix = await page.$('[data-testid="fix-operator"]');
  assert.ok(fix, "a one-click replacement is offered");
  assert.equal(await fix.getAttribute("data-replacement"), "eq");
  assert.match(await fix.textContent(), /use “equals”/);
  /* the quality check: a warning, not a blocker */
  await h.goTab("Logic");
  await page.click('[data-testid="run-quality-check"]');
  await page.waitForSelector('[data-testid="qc-verdict"]');
  const verdict = await page.textContent('[data-testid="qc-verdict"]');
  /* an area's issues are listed when it is opened: open each area that has any */
  let body = "";
  for (const area of await page.$$('[data-testid="qc-area"]')) {
    if (!/warning|problem/.test(await area.textContent())) continue;
    await (await area.$(".row")).click();
    await page.waitForTimeout(150);
    body += await area.textContent();
    await (await area.$(".row")).click();
  }
  assert.ok(/needs updating/.test(body) && /use “equals”/.test(body), `the check lists the contains warning with its replacement: ${body.slice(0, 400)}`);
  assert.notEqual(verdict, "Not ready to deploy", `a text operator on a choice question is a warning, not a deploy blocker: ${verdict}`);
  await openLogic();
  await page.click('[data-testid="fix-operator"]');
  await settle();
  r = firstRule(await logicOf());
  assert.deepEqual([r.operator, r.value], ["eq", "2"], `use equals keeps the value: ${JSON.stringify(r)}`);
  assert.equal(await page.$('[data-testid="cond-needs-update"]'), null, "and the rule is fine");
  ok("a stored “contains” on a Single Select: NEEDS UPDATE, “use equals” keeps the value; the quality check warns and does not refuse to deploy");
}

console.log(`\n${passed} checks passed`);
await h.close();
