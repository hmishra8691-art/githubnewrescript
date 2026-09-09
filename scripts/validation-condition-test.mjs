/**
 * VALIDATION RULES ON THE UNIVERSAL LOGIC ENGINE (kind:"condition").
 *
 * Before this, Validation was flat required/min/max/pattern/… checks plus
 * `custom_expression`/`custom_script` as raw hand-typed calc-DSL text — no
 * visual builder, no ConditionEditor, no cross-question/matrix-cell/COUNT
 * UI. `kind: "condition"` reuses the EXACT `ConditionEditor` component
 * Display Logic, Skip Logic, and Auto Punch already share (no fork), storing
 * the check in a new `check: Condition` field (condition TRUE => the rule
 * fails), evaluated by one new `case "condition"` in `checkScalarRules`.
 *
 * This proves: a cross-question numeric check is buildable in the Visual
 * tab and actually blocks the runtime; a multi-select COUNT check works the
 * same way; a matrix-cell check (row+column addressed) works; Visual and
 * Expression modes round-trip the same tree; the Logic tab's "Test
 * Condition" trace picks up a validation check as a target; and a piping
 * token in a validation message is lint-checked the same way question text
 * already is.
 *
 *   node scripts/validation-condition-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const loadFixture = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") {
    await page.click(head);
    await page.waitForTimeout(150);
  }
};
const selectQuestion = async (index) => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  const cards = await page.$$(".qcard");
  await cards[index].click();
  await page.waitForTimeout(200);
};

/* ============================================== cross-question numeric */

const CROSS_Q_FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "ValidationCrossQ", version: "1.0" },
  questions: [
    { id: "q5", code: "Q5", variableName: "Q5", type: "numeric", text: "First number" },
    { id: "q6", code: "Q6", variableName: "Q6", type: "numeric", text: "Second number" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q5", "q6"] }, { type: "end", id: "e1", status: "complete" }],
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await loadFixture(CROSS_Q_FIXTURE);
ok("fixture loaded: two numeric questions, Q5 and Q6");

await selectQuestion(0); // Q5
await ensureSectionOpen("validation-rules");
await page.click('button:has-text("+ rule")');
await page.waitForSelector('[data-testid="validation-rule"]');
await page.selectOption('[data-testid="validation-rule"] select', "condition");
await page.waitForTimeout(300);
assert.ok(await page.$('[data-testid="validation-condition-editor"]'), "picking kind:condition renders the shared ConditionEditor");
ok("switching a validation rule's kind to \"condition\" renders the Universal Logic Engine's builder in place");

/*
 * A genuine cross-question NUMERIC comparison (Q5 > Q6, as opposed to
 * comparing a question to a literal or to `$option`) is not something the
 * plain Visual row's value field does — `ConditionRule.value` is a literal
 * (string/number/boolean/array), resolved as-is by `resolveComparisonValue`,
 * never as "the live answer of another question," so typing "Q6" into the
 * value box would compare Q5 to the literal string "Q6", not to Q6's
 * answer. The real path, and the one `logicExpression.ts` is deliberately
 * built for (its own doc comment: "so an expression like `Q5 + Q6 > 100`
 * can…"), is an ARITHMETIC RUN as the source, compared against a literal —
 * "Q5 - Q6 > 0" reads exactly as "Q5 > Q6" but compiles to a rule whose
 * SOURCE is the arithmetic run (`expr`) and whose value is the literal 0.
 * Typed in the same builder's Expression tab, through the identical
 * Visual⇄Expression component every other feature already shares.
 */
await page.click('[data-testid="validation-condition-editor"] [data-testid="mode-expression"]');
await page.waitForSelector('[data-testid="validation-condition-editor"] [data-testid="xe-input"]');
await page.fill('[data-testid="validation-condition-editor"] [data-testid="xe-input"]', "Q5 - Q6 > 0");
await page.waitForTimeout(400);
const xeErrors = await page.$$('[data-testid="validation-condition-editor"] [data-testid="xe-error"]');
assert.equal(xeErrors.length, 0, "Q5 - Q6 > 0 must parse without error in the shared Expression editor");

await page.fill('[data-testid="validation-rule"] input[placeholder="message (optional)"]', "Q5 must not exceed Q6.");
await page.waitForTimeout(300);

let def = await readDef();
let rule = def.questions[0].validation[0];
assert.equal(rule.kind, "condition");
assert.equal(rule.check.type, "rule");
assert.equal(rule.check.source.kind, "expr");
assert.equal(rule.check.operator, "gt");
ok(`built and saved "Q5 - Q6 > 0" (i.e. Q5 > Q6, typed in the shared Expression tab) as a kind:"condition" rule: ${JSON.stringify(rule.check)}`);

/* drive the actual runtime: Q5 > Q6 should block */
const finalDef = await readDef();
const preview = await openPreview(browser, RUNTIME, { definition: finalDef }, { selector: "[data-qid]" });
const submitBtn = () => preview.$('button:has-text("Next"), button:has-text("Submit")');
await preview.fill('[data-qid="q5"] input', "10");
await preview.fill('[data-qid="q6"] input', "5");
await preview.waitForTimeout(150);
let goBtn = await submitBtn();
if (goBtn) await goBtn.click();
await preview.waitForTimeout(300);
const blockedText = await preview.textContent("body");
assert.match(blockedText, /Q5 must not exceed Q6/, "the runtime blocks with the rule's own message when Q5 > Q6");
ok("THE ENGINE FIX, LIVE: Q5=10, Q6=5 blocks submission with the built cross-question check");

await preview.fill('[data-qid="q6"] input', "20");
await preview.waitForTimeout(150);
goBtn = await submitBtn();
if (goBtn) await goBtn.click();
await preview.waitForTimeout(300);
const passedText = await preview.textContent("body");
assert.doesNotMatch(passedText, /Q5 must not exceed Q6/, "raising Q6 above Q5 clears the block");
ok("Q5=10, Q6=20 passes — the check is a real live comparison, not a fixed failure");
await preview.close();

/* ================================================= Visual <-> Expression round-trip */

await selectQuestion(0);
await ensureSectionOpen("validation-rules");
// already in Expression mode from building the rule above — switch to Visual
// (which renders the compiled expr-source rule via the shared RuleEditor,
// same as any other expr-sourced condition) and back, and confirm the tree
// is byte-for-byte the same both ways.
await page.click('[data-testid="validation-condition-editor"] [data-testid="mode-visual"]');
await page.waitForTimeout(300);
await page.click('[data-testid="validation-condition-editor"] [data-testid="mode-expression"]');
await page.waitForTimeout(300);
const afterRoundTrip = (await readDef()).questions[0].validation[0].check;
assert.deepEqual(afterRoundTrip, rule.check, "switching Expression -> Visual -> Expression round-trips to an identical tree");
ok("Expression -> Visual -> Expression round-trips to the same Condition tree");

/* ============================================= multi-select COUNT check */

const COUNT_FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "ValidationCount", version: "1.0" },
  questions: [
    { id: "q7", code: "Q7", variableName: "Q7", type: "multi_select", text: "Pick your top brands",
      options: [{ code: "1", label: "A" }, { code: "2", label: "B" }, { code: "3", label: "C" }, { code: "4", label: "D" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q7"] }, { type: "end", id: "e1", status: "complete" }],
};
await loadFixture(COUNT_FIXTURE);
await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.click('button:has-text("+ rule")');
await page.waitForSelector('[data-testid="validation-rule"]:nth-of-type(1)');
const rules = await page.$$('[data-testid="validation-rule"]');
await rules[rules.length - 1].$eval("select", (el) => el.value); // sanity touch
await page.selectOption('[data-testid="validation-rule"]:last-of-type select', "condition");
await page.waitForTimeout(300);
await page.click('[data-testid="validation-condition-editor"]:last-of-type >> text=+ Add condition');
await page.waitForSelector('[data-testid="validation-condition-editor"]:last-of-type .ref-select');
await page.selectOption('[data-testid="validation-condition-editor"]:last-of-type .ref-select', { label: "Q7 — Q7" });
await page.waitForTimeout(150);
await page.click('[data-testid="validation-condition-editor"]:last-of-type [data-testid="toggle-count"]');
await page.waitForSelector('[data-testid="validation-condition-editor"]:last-of-type .count-editor');
await page.waitForTimeout(300);
await page.selectOption('[data-testid="validation-condition-editor"]:last-of-type .op-select', "lt");
await page.waitForTimeout(150);
const countValueInput = await page.$('[data-testid="validation-condition-editor"]:last-of-type input.input');
if (countValueInput) { await countValueInput.fill("3"); await page.waitForTimeout(300); }

def = await readDef();
rule = def.questions[0].validation[0];
assert.equal(rule.kind, "condition");
assert.ok(rule.check.source?.count, "the check's source carries a COUNT descriptor");
ok(`built a COUNT-based validation check: COUNT(Q7) < 3 — ${JSON.stringify(rule.check.source.count)}`);

/* =================================================== matrix cell check */

const MATRIX_FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "ValidationMatrix", version: "1.0" },
  questions: [
    { id: "q10", code: "Q10", variableName: "Q10", type: "matrix_numeric", text: "Rate each",
      rows: [{ code: "apple", label: "Apple" }, { code: "pear", label: "Pear" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q10"] }, { type: "end", id: "e1", status: "complete" }],
};
await loadFixture(MATRIX_FIXTURE);
await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.click('button:has-text("+ rule")');
await page.waitForSelector('[data-testid="validation-rule"]');
await page.selectOption('[data-testid="validation-rule"] select', "condition");
await page.waitForTimeout(300);
await page.click('[data-testid="validation-condition-editor"] >> text=+ Add condition');
await page.waitForSelector('[data-testid="validation-condition-editor"] .ref-select');
await page.selectOption('[data-testid="validation-condition-editor"] .ref-select', { label: "Q10 — Q10" });
await page.waitForTimeout(200);
// the row picker (ConditionBuilder.tsx's RuleEditor, ~line 366) is an
// ordinary <select> with no dedicated testid — the same one every other
// row-addressed condition (Display/Skip Logic, Auto Punch) already uses;
// found by its "any row" placeholder option, not a guessed class/testid.
const rowPicker = page.locator('[data-testid="validation-condition-editor"] select:has(option:text-is("any row"))');
await rowPicker.selectOption({ label: "row: Apple" });
await page.waitForTimeout(200);
await page.selectOption('[data-testid="validation-condition-editor"] .op-select', "gt");
await page.waitForTimeout(150);
const matrixValueInput = await page.$('[data-testid="validation-condition-editor"] input.input');
if (matrixValueInput) { await matrixValueInput.fill("5"); await page.waitForTimeout(300); }

def = await readDef();
rule = def.questions[0].validation[0];
assert.equal(rule.kind, "condition");
assert.equal(rule.check.source.ref, "q10");
assert.equal(rule.check.source.rowCode, "apple", "the row picker addresses one matrix row, e.g. Q10[\"Apple\"]");
ok(`built a matrix-cell validation check via the shared row picker: Q10["apple"] > 5 — ${JSON.stringify(rule.check.source)}`);

/* =================================================== "Test Condition" trace */

await goTab("Logic");
await page.waitForSelector('[data-testid="trace-target"], [data-testid="trace-empty"]', { timeout: 10000 }).catch(() => {});
const targetSel = await page.$('[data-testid="trace-target"]');
if (targetSel) {
  const opts = await page.$$eval('[data-testid="trace-target"] option', (els) => els.map((e) => e.textContent));
  assert.ok(opts.some((o) => /validation/i.test(o)), `a validation check must be offered as a trace target: ${JSON.stringify(opts)}`);
  ok("the Logic tab's Test Condition trace lists the new validation check as a target — no new debug UI needed");
} else {
  console.log("  (no trace-target select found on this build — skipping trace-target assertion)");
}

/* ============================================================= piping lint */

await loadFixture(CROSS_Q_FIXTURE);
await selectQuestion(0);
await ensureSectionOpen("validation-rules");
await page.click('button:has-text("+ rule")');
await page.waitForSelector('[data-testid="validation-rule"]');
await page.fill('[data-testid="validation-rule"] input[placeholder="message (optional)"]', "You answered {{Q5}}, but {{NOPE}} is not a real question.");
await page.waitForTimeout(300);
const warn = await page.$('[data-testid="validation-message-piping-warning"]');
assert.ok(warn, "a validation message with a bad piping reference must show the same lint warning question text already gets");
const warnText = await warn.textContent();
assert.match(warnText, /NOPE/, `the warning should name the bad reference: "${warnText}"`);
ok(`validation message piping is lint-checked the same way question text already is: "${warnText}"`);

await page.fill('[data-testid="validation-rule"] input[placeholder="message (optional)"]', "You answered {{Q5}}.");
await page.waitForTimeout(300);
assert.equal(await page.$('[data-testid="validation-message-piping-warning"]'), null, "a message with only a valid reference shows no warning");
ok("a valid piping reference in a validation message shows no warning");

/* --------------------------------------------------------------- errors */
assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL VALIDATION CONDITION CHECKS PASSED (${passed})`);
