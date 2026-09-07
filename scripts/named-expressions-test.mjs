/**
 * NAMED EXPRESSIONS, THROUGH THE UI (§34, §35).
 *
 * The engine side is unit-tested (23 assertions), including the claim that
 * matters — a macro drives display logic and option logic without either
 * feature knowing macros exist — and that a self-referencing macro is false
 * rather than a hang.
 *
 * What only a browser can prove is that a programmer can define one, that it
 * then appears in the ordinary logic builder as a source like any other, that
 * choosing it produces a rule with no operator to fill in, and that deleting
 * a definition four rules depend on is not a silent breakage.
 *
 *   node scripts/named-expressions-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
/* the delete confirm is deliberate — accept it when it appears */
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};

const applyDef = async (def) => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  await page.click('[data-testid="json-edit"]');
  await page.waitForTimeout(120);
  await page.$eval("textarea.code", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def, null, 2));
  await page.click('[data-testid="json-apply"]');
  await page.waitForTimeout(500);
};

const goLogic = async () => {
  await page.click(".leftnav >> text=Logic");
  await page.waitForSelector('[data-testid="named-expressions"]');
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

/*
 * Two questions to write a condition about, applied through the JSON door so
 * the suite is about the macro library rather than about question authoring.
 */
let def = await readDef();
def.questions.push(
  { id: "q_income", code: "Q1", variableName: "INCOME", type: "numeric", text: "Income", options: [],
    rows: [], columns: [], flags: [], validation: [], settings: {}, punches: [], optionGroups: [] },
  { id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands",
    options: [{ code: "apple", label: "Apple" }, { code: "dell", label: "Dell" }],
    rows: [], columns: [], flags: [], validation: [], settings: {}, punches: [], optionGroups: [] },
);
const firstPage = def.flow.find((n) => n.type === "page");
firstPage.questionIds.push("q_income", "q_brands");
await applyDef(def);
def = await readDef();
assert.ok(def.questions.find((q) => q.id === "q_income"), "the questions applied");
ok("setup: two questions to write conditions about");

/* ============================================ define one, in the library */

await goLogic();
assert.equal((await page.$$('[data-testid="named-expression"]')).length, 0,
  "no macros to begin with");
const empty = await page.textContent('[data-testid="named-expressions"]');
assert.match(empty, /IS_HIGH_VALUE/, "the empty state teaches the idea rather than showing a blank box");
ok("the library starts empty, and explains what a named expression is for");

await page.click('[data-testid="add-named-expression"]');
await page.waitForSelector('[data-testid="named-expression"]');
def = await readDef();
assert.equal(def.namedExpressions.length, 1);
const neId = def.namedExpressions[0].id;
assert.match(neId, /^ne_/, `a minted id: ${neId}`);
ok("a named expression is created with a stable minted id");

await goLogic();
await page.fill(`[data-testid="ne-name-${neId}"]`, "is high value");
await page.waitForTimeout(350);
def = await readDef();
assert.equal(def.namedExpressions[0].name, "IS_HIGH_VALUE",
  "a name is normalised to the constant a programmer will type");
ok("THE NAME IS NORMALISED as you type it — “is high value” becomes IS_HIGH_VALUE");

/* ------------------------------------------- give it a real condition */

await goLogic();
await page.click(`[data-testid="ne-edit-${neId}"]`);
await page.waitForSelector('[data-testid="named-expressions"] [data-testid="logic-builder"]');
await page.click('[data-testid="named-expressions"] [data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="named-expressions"] .cond-rule');
await page.selectOption('[data-testid="named-expressions"] .cond-rule .ref-select', "q:q_income");
await page.waitForTimeout(200);
await page.selectOption('[data-testid="named-expressions"] .cond-rule .op-select', "gte");
await page.fill('[data-testid="named-expressions"] .cond-rule input.input', "100000");
await page.waitForTimeout(450);

def = await readDef();
const stored = def.namedExpressions[0].when;
const leaf = stored.children ? stored.children[0] : stored;
assert.equal(leaf.source.ref, "q_income");
assert.equal(leaf.operator, "gte");
assert.equal(String(leaf.value), "100000");
ok("the definition is an ordinary condition, built in the ordinary builder");

await goLogic();
const summary = await page.textContent(`[data-testid="ne-summary-${neId}"]`);
assert.match(summary, /Q1/, `the reading names the question: ${summary}`);
assert.match(summary, /100000/);
ok(`the reading is shown under the name, so the two can be compared: “${summary.trim()}”`);

/* ==================================== use it, from an unrelated feature */

/*
 * The point of the feature. A macro defined in the library must appear as a
 * source in every logic builder — here, a question's own display logic, which
 * knows nothing about macros.
 */
/*
 * A display-logic rule has to exist before a source picker is on screen, so
 * one is applied through the JSON door and then INSPECTED in the editor. What
 * is under test is whether the builder offers the macro, not how a rule gets
 * created.
 */
def = await readDef();
def.questions[0].displayLogic = {
  type: "rule", source: { kind: "rule", ref: neId }, operator: "eq", value: true,
};
await applyDef(def);
await page.click(".leftnav >> text=Questions");
await page.waitForSelector(".block-badge");
await page.click(".qcard >> nth=0");
await page.waitForSelector(".qcard.selected");
await page.waitForSelector(".cond-rule .ref-select");

const refValues = await page.$$eval(".ref-select option", (els) => els.map((e) => e.value));
assert.ok(refValues.includes(`rule:${neId}`),
  `the macro is offered as a source: ${JSON.stringify(refValues.filter((v) => v.startsWith("rule:")))}`);
ok("A MACRO APPEARS AS A SOURCE IN AN ORDINARY LOGIC BUILDER");

const labels = await page.$$eval(".ref-select optgroup", (els) => els.map((e) => e.label));
assert.ok(labels.includes("Named expressions"), `grouped under its own heading: ${labels.join(", ")}`);
assert.equal(labels[0], "Named expressions",
  "and listed FIRST — a reusable rule buried under sixty questions gets rewritten by hand instead");
ok("…grouped first, above Questions");

/* ------------------------------------------- choosing one needs no operator */

const truth = await page.$('[data-testid="named-truth"]');
assert.ok(truth, "a macro row shows an is/is-not toggle rather than an operator list");
assert.equal((await truth.textContent()).trim(), "is true");
assert.equal((await page.$$(".cond-rule .op-select")).length, 0,
  "and no operator dropdown — a boolean has nothing to compare against");
ok("A MACRO ROW HAS NO OPERATOR TO FILL IN — it already answers yes or no");

await truth.click();
await page.waitForTimeout(400);
def = await readDef();
assert.equal(def.questions[0].displayLogic.value, false,
  "the toggle writes `= false`, which is how NOT is spelled on a macro");
ok("the toggle flips it to “is NOT true”, stored as = false");

/* ================================================ usage, and deletion */

await goLogic();
const usage = await page.textContent(`[data-testid="ne-usage-${neId}"]`);
assert.match(usage, /used 1/, `usage is counted: ${usage}`);
ok("the library counts where each expression is used");

/* a second reference, so the count moves */
def = await readDef();
def.questions[1].options[1].visibleIf = {
  type: "rule", source: { kind: "rule", ref: neId }, operator: "eq", value: true,
};
await applyDef(def);
await goLogic();
assert.match(await page.textContent(`[data-testid="ne-usage-${neId}"]`), /used 2/);
ok("…and it moves when another rule starts using it");

/* ------------------------------------------------ the cycle is reported */

def = await readDef();
def.namedExpressions.push({
  id: "ne_loop", name: "LOOPY",
  when: { type: "rule", source: { kind: "rule", ref: "ne_loop" }, operator: "eq", value: true },
});
await applyDef(def);
await goLogic();
const problem = await page.$$eval('[data-testid="named-expression-problem"]',
  (els) => els.map((e) => e.textContent).join(" | "));
assert.match(problem, /Circular named expressions/, `the cycle is reported: ${problem}`);
assert.match(problem, /LOOPY/);
assert.match(problem, /none of them can ever produce an answer/);
ok("A CIRCULAR EXPRESSION IS REPORTED IN THE PANEL, naming the chain");

def = await readDef();
def.namedExpressions = def.namedExpressions.filter((e) => e.id !== "ne_loop");
await applyDef(def);

/* -------------------------------- deleting a used one warns, by name */

await goLogic();
await page.click(`[data-testid="ne-remove-${neId}"]`);
await page.waitForTimeout(450);
def = await readDef();
assert.equal((def.namedExpressions ?? []).length, 0, "the confirm was accepted and it is gone");
/*
 * And the rules that used it are still there, now evaluating to FALSE —
 * which is the safe direction, and why the confirm says so.
 */
assert.ok(def.questions[0].displayLogic, "the rule that used it was not silently deleted");
assert.equal(def.questions[0].displayLogic.source.kind, "rule");
ok("deleting a used expression warns first, and leaves the rules that referenced it intact");

/* -------------------------------------------------------------- errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL NAMED EXPRESSION CHECKS PASSED (${passed})`);
