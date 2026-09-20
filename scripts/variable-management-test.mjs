/**
 * Browser suite — Variable Management (§44, phase 2).
 *
 * The engine tests in `packages/engine` already prove the rename rewrites
 * correctly and refuses when it cannot. This proves the panel is wired to
 * that engine rather than to a second, more optimistic copy of the rules:
 *
 *   1. The delivery settings — export name, missing values, measure — persist
 *      into the definition. They are the fields most likely to be silently
 *      dropped, because an override that "says nothing" is discarded.
 *   2. Renaming shows a real impact report before it happens.
 *   3. A rename the engine refuses cannot be applied from the UI either.
 *   4. A rename that goes ahead actually rewrites the rules in the saved
 *      definition — not just the variable's own name.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/variable-management-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

await h.loadDef({
  meta: { id: "sandbox", code: "SANDBOX", title: "Variables", version: "1.0" },
  questions: [
    {
      id: "q_gender", code: "Q1", variableName: "GENDER", type: "single_select",
      text: "Gender?",
      options: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }, { code: "99", label: "Prefer not to say" }],
      settings: {},
    },
    {
      id: "q_why", code: "Q2", variableName: "WHY", type: "text",
      text: "You picked {{GENDER}} — why?",
      displayLogic: {
        type: "group", op: "and",
        children: [{ type: "rule", source: { kind: "question", ref: "GENDER" }, operator: "eq", value: "1" }],
      },
      settings: {},
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_gender", "q_why"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

const openRow = async (name) => {
  await h.goTab("Variables");
  await page.waitForSelector('[data-testid="variable-row"]');
  const row = page.locator(`[data-variable="${name}"]`);
  await row.locator('[data-testid="edit-variable"]').click();
  await page.waitForSelector('[data-testid="variable-editor"]');
};

/* ------------------------------------ 1. the delivery settings actually save */

await openRow("GENDER");
await page.fill('[data-testid="var-export-name"]', "S1_GENDER");
await page.fill('[data-testid="var-missing"]', "99");
await page.selectOption('[data-testid="var-measure"]', "nominal");
await page.waitForTimeout(400);

let def = await h.readDef();
let override = (def.variables ?? []).find((v) => v.name === "GENDER");
assert.ok(override, "an override row must have been created");
assert.equal(override.exportName, "S1_GENDER", "the export name is stored");
assert.deepEqual(override.missingValues, [99], "99 is stored as a NUMBER, so SPSS can declare it");
assert.equal(override.measure, "nominal");
console.log("✔ export name, missing values and measure persist into the definition");

/*
 * The specific trap: an override that "says nothing" is deliberately dropped
 * so the definition does not fill with empty rows. If the emptiness check
 * does not know about these three fields, the row is discarded on the way out
 * and the settings vanish between edits.
 */
await h.goTab("Questions");
await h.goTab("Variables");
def = await h.readDef();
override = (def.variables ?? []).find((v) => v.name === "GENDER");
assert.equal(override?.exportName, "S1_GENDER", "and survive leaving the panel and coming back");
console.log("✔ they are not discarded as an empty override");

/* -------------------------------------------- 2 & 3. the rename is guarded */

await openRow("GENDER");
await page.fill('[data-testid="var-rename-input"]', "WHY");
await page.waitForSelector('[data-testid="var-rename-blocker"]');
const blocker = await page.textContent('[data-testid="var-rename-blocker"]');
assert.match(blocker, /already a variable/, `expected a collision blocker, got: ${blocker}`);
assert.equal(
  await page.isDisabled('[data-testid="var-rename-apply"]'), true,
  "a rename the engine refuses must not be clickable",
);
console.log("✔ a colliding rename is blocked in the UI, not just in the engine");

await page.fill('[data-testid="var-rename-input"]', "2BAD");
await page.waitForTimeout(250);
assert.equal(await page.isDisabled('[data-testid="var-rename-apply"]'), true, "an unusable name is refused too");

await page.fill('[data-testid="var-rename-input"]', "SEX");
await page.waitForSelector('[data-testid="var-rename-summary"]');
const summary = await page.textContent('[data-testid="var-rename-summary"]');
assert.match(summary, /reference/, `the impact must be summarised, got: ${summary}`);
const usages = await page.$$eval('[data-testid="var-usage"]', (els) => els.map((e) => e.textContent));
assert.ok(usages.length >= 2, `the usages must be listed, got ${JSON.stringify(usages)}`);
assert.ok(usages.some((u) => /Q2/.test(u)), `Q2 refers to GENDER twice and must appear: ${JSON.stringify(usages)}`);
assert.equal(await page.isDisabled('[data-testid="var-rename-apply"]'), false, "a valid rename is offered");
console.log("✔ a valid rename previews what it will change, listing the references by name");

/* --------------------------------- 4. and the rename rewrites the rules too */

await page.click('[data-testid="var-rename-apply"]');
await page.waitForTimeout(500);

def = await h.readDef();
const gender = def.questions.find((q) => q.id === "q_gender");
assert.equal(gender.variableName, "SEX", "the variable is renamed");

const why = def.questions.find((q) => q.id === "q_why");
assert.match(why.text, /\{\{SEX\}\}/, `the pipe follows the rename: ${why.text}`);
assert.doesNotMatch(why.text, /GENDER/, "and nothing is left pointing at the old name");
assert.equal(
  why.displayLogic.children[0].source.ref, "SEX",
  "the display rule follows too — this is the one that silently breaks if it does not",
);
console.log("✔ renaming rewrote the piped text and the display rule, not just the variable");

/* the override moved with it, so the export settings are not orphaned */
const moved = (def.variables ?? []).find((v) => v.name === "SEX");
assert.ok(moved, "the override must be re-keyed to the new name");
assert.equal(moved.exportName, "S1_GENDER", "so the delivery settings survive the rename");
assert.equal((def.variables ?? []).some((v) => v.name === "GENDER"), false, "and nothing is left under the old name");
console.log("✔ the variable's export settings moved with it instead of being orphaned");

await h.close();
console.log("\nALL VARIABLE MANAGEMENT CHECKS PASSED");
