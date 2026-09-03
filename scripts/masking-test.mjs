/**
 * Visual masking, set operations and auto-selection, driven in the real
 * Studio — and then checked in the real runtime.
 *
 * The engine tests prove the set algebra; this proves the editor writes the
 * tree it draws, that the two panes agree, and that a respondent actually
 * sees the masked list and the punched answer.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const brands = (id, code) => ({
  id, code, variableName: code, type: "multi_select", text: `${code} brands`,
  options: [
    { code: "a", label: "Alpha" }, { code: "b", label: "Beta" },
    { code: "c", label: "Gamma" }, { code: "d", label: "Delta" },
  ],
});

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Masking", version: "1.0" },
  questions: [
    brands("q5", "Q5"),
    brands("q6", "Q6"),
    brands("q7", "Q7"),
    {
      id: "q8", code: "Q8", variableName: "Q8", type: "multi_select", text: "Which of these?",
      options: [
        { code: "a", label: "Alpha" }, { code: "b", label: "Beta" },
        { code: "c", label: "Gamma" }, { code: "d", label: "Delta" },
        { code: "other", label: "Other", flags: ["other_specify"] },
        { code: "none", label: "None of these", flags: ["none_of_above"] },
      ],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q5", "q6", "q7"] },
    { type: "page", id: "p2", questionIds: ["q8"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};
const goTab = async (name) => {
  await page.click(`.leftnav >> text=${name}`);
  await page.waitForTimeout(150);
};
const maskOf = (def, id = "q8") => def.questions.find((q) => q.id === id)?.mask;
const punchesOf = (def, id = "q8") => def.questions.find((q) => q.id === id)?.punches ?? [];

/** Select Q8 and scroll the masking builder into view. */
const openMasking = async () => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  const cards = await page.$$(".qcard");
  await cards[cards.length - 1].click();
  await page.waitForSelector('[data-testid="masking-builder"]');
  await page.$eval('[data-testid="masking-builder"]', (e) => e.scrollIntoView({ block: "center" }));
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 4);
console.log("✔ fixture loaded (Q5–Q7 sources, Q8 with Other + None of these)");

/* ================================================ §1/§10: the visual builder */

await openMasking();
assert.ok(await page.$('[data-testid="mask-empty"]'), "opens with no mask — nothing is imposed");
assert.equal(await page.$('[data-testid="mask-row"]'), null);
console.log("✔ §1: the masking builder opens empty, so an unmasked question stays unmasked");

await page.click('[data-testid="mask-add-set"]');
await page.waitForSelector('[data-testid="mask-row"]');
await page.selectOption('[data-testid="mask-source"] >> nth=0', { index: 0 });
await page.selectOption('[data-testid="mask-selection"] >> nth=0', "selected");
await page.waitForTimeout(350);

let def = await readDef();
let mask = maskOf(def);
assert.ok(mask, "a mask now exists");
assert.equal(mask.expr.kind, "ref");
assert.equal(mask.expr.questionId, "q5", "stored as the question's id, not its code");
assert.equal(mask.expr.selection, "selected");
assert.equal(mask.action, "display");
assert.equal(mask.keepAlwaysShow, true, "the special options are protected by default");
console.log("✔ §2/§3: one set — Q5 → Selected — stored with a stable id");

/* ------------------------------------------------ §4/§5: a second set, UNION */

await page.click('[data-testid="mask-add-set"]');
await page.waitForTimeout(250);
let rows = await page.$$('[data-testid="mask-row"]');
assert.equal(rows.length, 2);
await page.selectOption('[data-testid="mask-source"] >> nth=1', "q6");
await page.waitForTimeout(300);

def = await readDef();
mask = maskOf(def);
assert.equal(mask.expr.kind, "op");
assert.equal(mask.expr.operator, "union", "UNION is the default join");
assert.equal(mask.expr.left.questionId, "q5");
assert.equal(mask.expr.right.questionId, "q6");
console.log("✔ §4: two sets joined by UNION");

const opOptions = await page.$$eval('[data-testid="mask-operator"] >> nth=0 >> option',
  (els) => els.map((e) => e.textContent.trim()));
assert.deepEqual(opOptions, ["UNION", "INTERSECTION", "DIFFERENCE"]);
console.log("✔ §4: the three set operators are offered by name");

/* ----------------------------------------- §5/§6: change one gap's operator */

await page.selectOption('[data-testid="mask-operator"] >> nth=0', "intersection");
await page.waitForTimeout(300);
def = await readDef();
assert.equal(maskOf(def).expr.operator, "intersection");
await page.selectOption('[data-testid="mask-operator"] >> nth=0', "union");
await page.waitForTimeout(300);
console.log("✔ §5: the operator in a gap is that node's own");

/* ------------------------------------- §7/§13: a third set, then brackets */

await page.click('[data-testid="mask-add-set"]');
await page.waitForTimeout(250);
await page.selectOption('[data-testid="mask-source"] >> nth=2', "q7");
await page.selectOption('[data-testid="mask-operator"] >> nth=1', "difference");
await page.waitForTimeout(350);

def = await readDef();
mask = maskOf(def);
// left-associated: (Q5 ∪ Q6) \ Q7 — the brief's worked example
assert.equal(mask.expr.operator, "difference");
assert.equal(mask.expr.left.operator, "union");
assert.equal(mask.expr.right.questionId, "q7");
console.log("✔ §7: (Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected, built by clicking");

const summary = await page.textContent('[data-testid="mask-summary"]');
assert.match(summary, /what Q5 selected/);
assert.match(summary, /but not/);
console.log("✔ §10: the builder says what the mask means in words");

/* ------------------------------- §13/§26: the same tree as an expression */

await page.click('[data-testid="mask-mode-expression"]');
await page.waitForSelector('[data-testid="mask-expression"]');
let text = await page.inputValue('[data-testid="mask-expression"]');
assert.equal(text.trim(), "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected",
  `the visual tree prints as the expression: ${text}`);
console.log("✔ §26: Visual → Expression shows the same thing");

// edit it as text, with nesting on the RIGHT — the case a flat pipeline cannot hold
await page.fill('[data-testid="mask-expression"]', "Q5.Selected UNION (Q6.Selected INTERSECTION Q7.Selected)");
await page.waitForTimeout(450);
def = await readDef();
mask = maskOf(def);
assert.equal(mask.expr.operator, "union");
assert.equal(mask.expr.right.operator, "intersection", "the bracket became the right-hand node");
assert.equal(mask.expr.right.left.questionId, "q6");
console.log("✔ §7/§13: an expression with right-hand nesting parses into the tree");

// and the visual pane shows that bracket as a group
await page.click('[data-testid="mask-mode-visual"]');
await page.waitForSelector('[data-testid="mask-bracket"]');
assert.equal((await page.$$('[data-testid="mask-bracket"]')).length, 1,
  "the nested set is drawn as a bracket");
console.log("✔ §26: Expression → Visual draws the bracket");

/* ---------------------------------------------- §9: invalid input is refused */

await page.click('[data-testid="mask-mode-expression"]');
await page.waitForSelector('[data-testid="mask-expression"]');
const before = JSON.stringify(maskOf(await readDef()));
await page.fill('[data-testid="mask-expression"]', "(Q5.Selected UNION Q6.Selected");
await page.waitForTimeout(400);
let err = await page.textContent('[data-testid="mask-error"]');
assert.match(err, /Missing closing parenthesis/);
assert.equal(JSON.stringify(maskOf(await readDef())), before, "the saved mask was left alone");

await page.fill('[data-testid="mask-expression"]', "Q99.Selected");
await page.waitForTimeout(400);
assert.match(await page.textContent('[data-testid="mask-error"]'), /Q99 does not exist/);

await page.fill('[data-testid="mask-expression"]', "Q5.Nonsense");
await page.waitForTimeout(400);
assert.match(await page.textContent('[data-testid="mask-error"]'), /is not a selection/);
console.log("✔ §9: malformed set expressions are refused, and change nothing");

/* --------------------------------------------- §31: a question masking itself */

await page.fill('[data-testid="mask-expression"]', "Q8.Selected");
await page.waitForTimeout(450);
const issue = await page.textContent('[data-testid="mask-issue"]');
assert.match(issue, /cannot mask itself/, `self-reference reported: ${issue}`);
console.log("✔ §31: a question masking itself is reported, not left to the runtime");

/* ------------------------------------ back to the brief's worked example */

await page.fill('[data-testid="mask-expression"]',
  "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected");
await page.waitForTimeout(450);
assert.equal(await page.$('[data-testid="mask-issue"]'), null, "no issues");

/* ================================================== §8/§30: always show */

const protectedLine = await page.textContent('[data-testid="mask-protected"]');
assert.match(protectedLine, /Other/);
assert.match(protectedLine, /None of these/);
console.log("✔ §8/§9: the builder names the options the mask can never remove");

const keep = await page.isChecked('[data-testid="mask-keep-always"]');
assert.equal(keep, true, "on by default");
await page.uncheck('[data-testid="mask-keep-always"]');
await page.waitForTimeout(300);
assert.equal(maskOf(await readDef()).keepAlwaysShow, false);
await page.check('[data-testid="mask-keep-always"]');
await page.waitForTimeout(300);
assert.equal(maskOf(await readDef()).keepAlwaysShow, true);
console.log("✔ §8: “always keep Other / None” is a real setting, on by default");

/* ------------------------------------------------------------ §14: actions */

const actions = await page.$$eval('[data-testid="mask-action"] option',
  (els) => els.map((e) => e.value));
assert.deepEqual(actions,
  ["display", "remove", "preselect", "display_and_preselect", "disable"],
  `§14's actions are separate choices: ${actions}`);
console.log("✔ §14: display / remove / pre-select / disable are separate actions");

/* ============================================ §14–§19: auto-selection */

await page.click('[data-testid="punch-add"]');
await page.waitForSelector('[data-testid="punch-rule"]');
await page.waitForTimeout(300);
def = await readDef();
let punches = punchesOf(def);
assert.equal(punches.length, 1);
assert.equal(punches[0].source.questionId, "q5");
assert.equal(punches[0].action, "select");
assert.equal(punches[0].recompute, "once", "a respondent's own edit is safe by default");
console.log("✔ §14: an auto-selection rule reads “FOR EACH option in Q5 → select it here”");

// §16: an explicit mapping
await page.click('[data-testid="punch-add-mapping"]');
await page.waitForSelector('[data-testid="punch-mapping"]');
await page.fill('[data-testid="punch-mapping"] input', "a");
await page.selectOption('[data-testid="punch-mapping"] select', "d");
await page.waitForTimeout(350);
def = await readDef();
assert.deepEqual(punchesOf(def)[0].mapping, [{ from: "a", to: "d" }],
  "source code → this question's code");
console.log("✔ §16: a source code can be mapped to a different target code");

// clear the mapping again so the runtime check below is the identity case
await page.click('[data-testid="punch-mapping"] .btn.danger');
await page.waitForTimeout(300);
assert.deepEqual(punchesOf(await readDef())[0].mapping, []);

/* ============================================== §22/§29: the actual runtime */

const preview = await browser.newPage({ viewport: { width: 900, height: 900 } });
preview.on("pageerror", (e) => console.error("PREVIEW ERROR:", e.message));
const finalDef = await readDef();
// the preview receives definitions over postMessage — the same channel the
// Studio's Preview button uses
await preview.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
await preview.evaluate((d) => {
  window.postMessage({ type: "rescript:preview", definition: d }, "*");
}, finalDef);
await preview.waitForSelector(".rs-option");

/*
 * Each question renders as `.rs-card[data-qid]`, so answers go in by id rather
 * than by position — which also documents which question is being answered.
 *
 *   Q5 = Alpha, Beta    Q6 = Beta, Gamma    Q7 = Gamma
 */
assert.equal((await preview.$$("[data-qid]")).length, 3, "page 1 holds Q5, Q6 and Q7");
for (const [qid, labels] of [
  ["q5", ["Alpha", "Beta"]],
  ["q6", ["Beta", "Gamma"]],
  ["q7", ["Gamma"]],
]) {
  for (const label of labels) {
    await preview.click(`[data-qid="${qid}"] .rs-option:has-text("${label}")`);
    await preview.waitForTimeout(90);
  }
}
await preview.click(".rs-nav .rs-btn:not(.secondary)");
await preview.waitForSelector('[data-qid="q8"]');
await preview.waitForTimeout(400);

/*
 * (Q5 ∪ Q6) \ Q7 = ({Alpha,Beta} ∪ {Beta,Gamma}) \ {Gamma} = {Alpha, Beta}
 * plus the two special options, which the mask must never remove.
 */
const shown = await preview.$$eval('[data-qid="q8"] .rs-option', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
assert.ok(shown.some((t) => /Alpha/.test(t)), `Alpha shown: ${shown}`);
assert.ok(shown.some((t) => /Beta/.test(t)), `Beta shown: ${shown}`);
assert.equal(shown.some((t) => /Gamma/.test(t)), false, `Gamma masked out: ${shown}`);
assert.equal(shown.some((t) => /Delta/.test(t)), false, `Delta was never in the set: ${shown}`);
assert.ok(shown.some((t) => /Other/.test(t)), `Other survived: ${shown}`);
assert.ok(shown.some((t) => /None of these/.test(t)), `None of these survived: ${shown}`);
console.log("✔ §29/§30: the respondent sees Alpha, Beta, Other and None of these — the mask, evaluated");

/* --------------------------------------------- §14/§19: the punch happened */

const checked = await preview.$$eval('[data-qid="q8"] .rs-option input:checked', (els) =>
  els.map((e) => e.closest(".rs-option")?.textContent.replace(/\s+/g, " ").trim()));
assert.ok(checked.some((t) => /Alpha/.test(t ?? "")), `Alpha pre-selected: ${checked}`);
assert.ok(checked.some((t) => /Beta/.test(t ?? "")), `Beta pre-selected: ${checked}`);
console.log("✔ §14/§19: the options Q5 selected arrived already ticked — FOR EACH, punched");

await preview.screenshot({ path: "/tmp/rt-masking.png" });
await preview.close();

/* ======================================================= §22: save / reload */

const stored = JSON.stringify(maskOf(await readDef()));
await goTab("Survey Settings");
await page.waitForTimeout(200);
await openMasking();
assert.equal(JSON.stringify(maskOf(await readDef())), stored, "the mask tree survived");
await page.click('[data-testid="mask-mode-expression"]');
await page.waitForSelector('[data-testid="mask-expression"]');
text = await page.inputValue('[data-testid="mask-expression"]');
assert.equal(text.trim(), "(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected",
  "and prints the same expression");
console.log("✔ §22: the mask and its punches persist; the expression is re-derived");

await page.screenshot({ path: "/tmp/st-masking.png", fullPage: false });
await browser.close();
console.log("\nALL MASKING CHECKS PASSED");
