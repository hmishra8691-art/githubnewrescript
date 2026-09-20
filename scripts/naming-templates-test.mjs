/**
 * Browser suite — variable naming templates (§44, phase 3).
 *
 * The engine suite already proves the plan is ordered safely and that
 * applying it rewrites every reference. This proves the Studio is wired to
 * that engine, and — the part that matters most — that the two rename fields
 * people actually use now go through the safe path instead of around it.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/naming-templates-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

const survey = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Naming", version: "1.0" },
  questions: [
    { id: "q1", code: "S1", variableName: "SCREENER", type: "single_select", text: "Do you drink coffee?",
      options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }], settings: {} },
    { id: "q2", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands?",
      options: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }], settings: {} },
    { id: "q3", code: "Q2", variableName: "WHY", type: "text",
      text: "You picked {{BRANDS}} — why?",
      displayLogic: { type: "group", op: "and", children: [
        { type: "rule", source: { kind: "question", ref: "SCREENER" }, operator: "eq", value: "1" },
      ] },
      settings: {} },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2", "q3"] },
    { type: "end", id: "e", status: "complete" },
  ],
};
await h.loadDef(survey);

const openNaming = async () => {
  await h.goTab("Variables");
  await page.waitForSelector('[data-testid="view-naming"]');
  await page.click('[data-testid="view-naming"]');
  await page.waitForSelector('[data-testid="naming-panel"]');
};

/* ------------------------------------------------ 1. the plan is previewed */

await openNaming();
await page.fill('[data-testid="naming-pattern"]', "SEC{section}_Q{n_in_section:2}");
await page.waitForTimeout(350);

let becomes = await page.$$eval('[data-testid="naming-step-to"]', (els) => els.map((e) => e.textContent));
assert.deepEqual(becomes, ["SEC1_Q01", "SEC2_Q01", "SEC2_Q02"],
  `the plan must show the new names before anything happens, got ${JSON.stringify(becomes)}`);
console.log("✔ the rename plan is shown before applying, numbered by section");

/* ------------------------------------------ 2. a bad pattern cannot be run */

await page.fill('[data-testid="naming-pattern"]', "SAME");
await page.waitForSelector('[data-testid="naming-blocker"]');
const blocker = await page.textContent('[data-testid="naming-blocker"]');
assert.match(blocker, /would belong to/, `expected a duplicate-name blocker, got: ${blocker}`);
assert.equal(await page.isDisabled('[data-testid="naming-apply"]'), true,
  "a template that would give two questions one name must not be applicable");
console.log("✔ a template that collapses names is blocked");

/* --------------------------------------------- 3. a question can be skipped */

await page.fill('[data-testid="naming-pattern"]', "V{number}");
await page.waitForTimeout(350);
const boxes = page.locator('[data-testid="naming-step-include"]');
await boxes.nth(0).uncheck();
await page.waitForTimeout(350);
let applyLabel = await page.textContent('[data-testid="naming-apply"]');
assert.match(applyLabel, /2 variables/, `skipping must narrow the plan, button said: ${applyLabel}`);
await boxes.nth(0).check();
await page.waitForTimeout(300);

/* --------------------------------- 4. applying rewrites the whole survey */

await page.fill('[data-testid="naming-pattern"]', "V{number}");
await page.waitForTimeout(350);
await page.click('[data-testid="naming-apply"]');
await page.waitForTimeout(600);

let def = await h.readDef();
assert.deepEqual(def.questions.map((q) => q.variableName), ["V1", "V2", "V3"], "every variable renamed");
const q3 = def.questions.find((q) => q.id === "q3");
assert.equal(q3.displayLogic.children[0].source.ref, "V1", "the display rule followed the rename");
assert.match(q3.text, /\{\{V2\}\}/, `the pipe followed too: ${q3.text}`);
console.log("✔ applying the template renamed every variable and rewrote the rules and piping");

/* ------------------------------ 5. saved templates: save, use, duplicate */

await openNaming();
await page.fill('[data-testid="naming-pattern"]', "Q{number:2}");
await page.click('[data-testid="naming-save"]');
await page.waitForSelector('[data-testid="saved-template"]');
def = await h.readDef();
assert.equal((def.namingTemplates ?? []).length, 1, "the template is stored on the survey");
assert.equal(def.namingTemplates[0].pattern, "Q{number:2}");

// readDef leaves us on the JSON tab; come back before clicking the panel again
await openNaming();
await page.click('[data-testid="template-duplicate"]');
await page.waitForTimeout(350);
def = await h.readDef();
assert.equal(def.namingTemplates.length, 2, "duplicating gives a second template");
assert.match(def.namingTemplates[1].name, /copy/);

await openNaming();
await page.locator('[data-testid="template-delete"]').nth(1).click();
await page.waitForTimeout(350);
def = await h.readDef();
assert.equal(def.namingTemplates.length, 1, "and it can be deleted again");
console.log("✔ templates save, duplicate and delete, and travel with the survey");

/* ------------- 6. THE REGRESSION: the everyday rename fields are now safe */

await h.goTab("Questions");
// the editor pane only exists for the selected question
await page.waitForSelector(".qcard");
await page.locator(".qcard").first().click();
await page.waitForSelector('[data-testid="question-variable-name"]');
/*
 * Before this phase these two inputs wrote straight into the definition, so
 * renaming here left every rule and pipe pointing at the old name — and
 * mostly still resolving, through the question code, which is what made it
 * so hard to notice.
 */
const nameBox = page.locator('[data-testid="question-variable-name"]').first();
await nameBox.fill("SCREENED_IN");
await nameBox.blur();
await page.waitForTimeout(600);

def = await h.readDef();
const renamed = def.questions.find((q) => q.id === "q1");
assert.equal(renamed.variableName, "SCREENED_IN", "the question editor renamed the variable");
const dependent = def.questions.find((q) => q.id === "q3");
assert.equal(dependent.displayLogic.children[0].source.ref, "SCREENED_IN",
  "and the rule that reads it followed — this is the bug this phase fixes");
console.log("✔ renaming from the question editor rewrites the rules that depend on it");

/*
 * A refused rename says so rather than silently doing nothing.
 *
 * V2 belongs to a MULTI-SELECT, whose base name never appears in the derived
 * dictionary — so this is also the regression test for a collision check that
 * looked only at the dictionary and let the rename through, leaving two
 * questions called V2.
 */
await h.goTab("Questions");
await page.locator(".qcard").first().click();
await page.waitForSelector('[data-testid="question-variable-name"]');
await nameBox.fill("V2");
await nameBox.blur();
await page.waitForSelector('[data-testid="question-variable-name-error"]');
const err = await page.textContent('[data-testid="question-variable-name-error"]');
assert.match(err, /already a variable/, `expected a collision message, got: ${err}`);
def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === "q1").variableName, "SCREENED_IN",
  "and the definition is untouched by the refused rename");
console.log("✔ a colliding rename is refused in place, with a reason");

/* ------------------- 7. the derived-suffix scheme, and why it locks */

await openNaming();
await page.waitForSelector('[data-testid="suffix-scheme"]');

/*
 * The sandbox reports no responses, so the scheme is editable. On a live
 * study it is locked: changing it renames hundreds of columns and, unlike
 * renaming one variable, nothing can rewrite the references — saved analyses
 * name dictionary columns directly.
 */
assert.equal(await page.isDisabled('[data-testid="suffix-option"]'), false,
  "a survey with no responses can still choose its scheme");

const before = await page.inputValue('[data-testid="suffix-cell"]');
assert.equal(before, "{base}_{row}_{column}", `the default scheme is shown, got ${before}`);

await page.fill('[data-testid="suffix-option"]', "{base}");
await page.waitForSelector('[data-testid="suffix-problem"]');
const problem = await page.textContent('[data-testid="suffix-problem"]');
assert.match(problem, /\{code\}/, `a pattern that collapses columns must be refused: ${problem}`);
console.log("✔ a suffix pattern that would give every option one column is rejected");

await page.click('[data-testid="suffix-preset"] >> text=Compact');
await page.waitForTimeout(500);
def = await h.readDef();
assert.equal(def.variableNaming?.cell, "{base}r{row}c{column}", "the scheme is stored on the survey");
console.log("✔ a suffix preset is applied and stored on the survey");

await openNaming();
await page.click('[data-testid="suffix-preset"] >> text=Underscores');
await page.waitForTimeout(500);
def = await h.readDef();
assert.equal(def.variableNaming, undefined,
  "returning to the default stores nothing, so an untouched survey stays byte-identical");
console.log("✔ returning to the default clears the setting rather than storing it");

await h.close();
console.log("\nALL NAMING TEMPLATE CHECKS PASSED");
