/**
 * PHASE 5 IN THE STUDIO (audit 2026-11-17, P2-10 and P2-09), in the sandbox:
 *
 *   SCALE      Insert from a library → Validated scale → PSS-10: a 10-row required grid with the published items,
 *              the citation in its notes, and the score as a calculation (PSS10_SCORE) whose expression reverses
 *              items 4, 5, 7 and 8. A second insert does not collide (PSS10_2).
 *   BACK-CHECK Translation → a Spanish column → Back-translation check: the check runs through
 *              /api/ai/back-translate (the fake provider here, so the score itself means nothing) and is stored in
 *              the survey's localization with its score and its flags; "Keep" needs a reason and is recorded.
 *
 *   AI_API_URL=fake: next dev -p 3000 (apps/studio), then   node scripts/phase5-library-backcheck-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const page = h.page;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

console.log("\nVALIDATED SCALE");
await h.goTab("Questions");
await page.waitForSelector('[data-testid="library-open"]', { timeout: 60000 });
const insertScale = async () => {
  await page.locator('[data-testid="library-open"]').first().click();
  await page.waitForSelector('[data-testid="library-dialog"]');
  await page.click('[data-testid="library-mode-scale"]');
  await page.click('[data-testid="library-scale-pss10"]');
  await page.waitForSelector('[data-testid="library-preview"]');
  assert.match(await page.innerText('[data-testid="library-scales"]'), /Cohen, S\., & Williamson, G\. \(1988\)/);
  await page.click('[data-testid="library-insert"]');
  await page.waitForTimeout(400);
};
await insertScale();
let def = await h.readDef();
const pss = def.questions.find((q) => q.code === "PSS10");
assert.ok(pss, def.questions.map((q) => q.code).join(","));
assert.equal(pss.type, "matrix_single");
assert.equal(pss.rows.length, 10);
assert.equal(pss.required, true);
assert.match(pss.rows[3].label, /confident about your ability to handle your personal problems/);
assert.match(pss.notes ?? "", /Cohen/);
const calc = def.calculations.find((c) => c.targetVariable === "PSS10_SCORE");
assert.ok(calc, JSON.stringify(def.calculations));
for (const r of ["4", "5", "7", "8"]) assert.match(calc.expression, new RegExp(`\\(4 - PSS10_${r}\\)`), `item ${r} reversed`);
assert.doesNotMatch(calc.expression, /\(4 - PSS10_1\)/);
ok("PSS-10 inserted: a 10-item required grid, the citation in its notes, the score with items 4, 5, 7 and 8 reversed");
await h.goTab("Questions");
await insertScale();
def = await h.readDef();
assert.ok(def.questions.some((q) => q.code === "PSS10_2") && def.calculations.some((c) => c.targetVariable === "PSS10_2_SCORE"));
ok("a second copy gets its own stem (PSS10_2) and score");

console.log("\nBACK-TRANSLATION CHECK");
def.localization = { sourceLanguage: "en", languages: [{ code: "es" }], translations: { es: {} } };
await h.loadDef(def);
await h.goTab("Translation");
await page.waitForSelector('[data-testid="localization-panel"]');
await page.click('[data-testid="loc-view-translate"]');
await page.waitForSelector('[data-testid="loc-table"]');
if (!(await page.isChecked('[data-testid="loc-col-es"]'))) await page.click('[data-testid="loc-col-es"]');
await page.click('[data-testid="loc-translate-all"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="loc-translate-all"]')?.textContent?.includes("Translating"), null, { timeout: 60000 });
await page.click('[data-testid="loc-backcheck-toggle"]');
await page.waitForSelector('[data-testid="loc-backcheck"]');
await page.click('[data-testid="loc-backcheck-run-es"]');
await page.waitForSelector('[data-testid="loc-backcheck-score-es"]', { timeout: 60000 });
const scoreText = await page.innerText('[data-testid="loc-backcheck-score-es"]');
assert.match(scoreText, /QA \d+ · \d+ ok · \d+ to review · \d+ meaning changed/);
ok(`the check ran and shows the language's score: “${scoreText}”`);
const firstRow = page.locator('[data-testid^="loc-backcheck-row-"]').first();
if (await firstRow.count()) {
  const key = (await firstRow.getAttribute("data-testid")).replace("loc-backcheck-row-", "");
  const keep = page.locator(`[data-testid="loc-backcheck-keep-${key}"]`);
  assert.equal(await keep.isDisabled(), true, "Keep needs a reason");
  await firstRow.locator("input.input").fill("Checked by a Spanish speaker: the wording is right");
  await keep.click();
  ok("a flag is kept only with a reason");
}
def = await h.readDef();
const check = def.localization?.backChecks?.es;
assert.ok(check && typeof check.score === "number" && check.counts, JSON.stringify(def.localization?.backChecks));
if (check.flagged.length) assert.ok(check.record.some((r) => r.action === "keep" && /Spanish speaker/.test(r.reason)), "the decision is recorded");
ok(`stored in the survey: score ${check.score}, ${check.flagged.length} flagged, ${check.record.length} reconciled`);

assert.deepEqual(errors, []);
await h.browser.close();
console.log(`\nPHASE 5 LIBRARY + BACK-CHECK: ${passed} checks passed`);
