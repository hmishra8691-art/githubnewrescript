/**
 * QUOTA DASHBOARD — browser checks on the Studio sandbox.
 *
 * Loads the Master Demo (four quotas: gender %, age %, gender × age counts,
 * a soft region quota) and mocks the counts endpoint so the dashboard shows
 * real numbers against real configuration. Proves: summary, per-cell numbers
 * and statuses, search / filter / sort, expand, inline edit with validation,
 * over-cap warning + confirmation, save feedback, cancel restores, delete with
 * reference warning + reference clean-up, Edit Logic round-trip, table view.
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/quota-dashboard-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const def = buildMasterDemoSurvey("sandbox");
const h = await openHarness();
const page = h.page;

// counts the "database" holds: gender 50 % of 300 = 150 each → female NEAR FULL; age 18–24 = 20 % of 300 = 60 → FULL
const COUNTS = {
  quota_gender: { qg_male: 123, qg_female: 141 },
  quota_age: { qa_18_24: 60, qa_25_34: 40, qa_35_44: 12, qa_45: 9 },
  quota_gender_age: { qga_f_2534: 31 },
};
await page.route("**/api/surveys/sandbox/quotas?environment=*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ counts: COUNTS, updatedAt: { quota_gender: new Date().toISOString() }, environment: "TEST", perEnvironment: true, fetchedAt: new Date().toISOString() }) }));

await page.$eval("textarea.code", () => {});
await h.goTab("JSON");
await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
}, JSON.stringify(def));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(600);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const cardOf = (id) => `[data-testid="quota-card"][data-quota-id="${id}"]`;

/* ------------------------------------------------------------ dashboard */

console.log("\nDASHBOARD");
await h.goTab("Quotas");
await page.waitForSelector('[data-testid="quota-dashboard"]');
await page.waitForSelector(`${cardOf("quota_gender")} [data-testid="quota-cell-count"]:has-text("123")`, { timeout: 15000 });
assert.equal(await text('[data-testid="quota-total"]'), "4");
ok("opening Quotas shows the dashboard with all 4 quotas counted");

const states = await page.$$eval('[data-testid="quota-card"]', (cs) => cs.map((c) => [c.dataset.quotaId, c.dataset.state]));
assert.deepEqual(Object.fromEntries(states), { quota_gender: "NEAR_FULL", quota_age: "NEAR_FULL", quota_gender_age: "ACTIVE", quota_soft_region: "INACTIVE" });
assert.deepEqual(states.map((s) => s[0]).slice(0, 2).sort(), ["quota_age", "quota_gender"], "default sort: needs-attention first");
ok("statuses come from real counts + configuration: NEAR FULL, NEAR FULL, ACTIVE, INACTIVE (soft, enforced nowhere)");

const gender = cardOf("quota_gender");
assert.match(await text(`${gender} [data-testid="quota-source"]`), /Q\d+ – How do you describe your gender\? · GENDER · Single select/);
const cells = await page.$$eval(`${gender} [data-testid="quota-cell"]`, (cs) => cs.map((c) => ({
  label: c.querySelector('[data-testid="quota-cell-label"]').textContent, count: c.querySelector('[data-testid="quota-cell-count"]').textContent,
  max: c.querySelector('[data-testid="quota-cell-max"]').textContent, rem: c.querySelector('[data-testid="quota-cell-remaining"]').textContent, state: c.dataset.state,
})));
assert.deepEqual(cells, [
  { label: "Male 50%", count: "123 / 150", max: "150 (50%)", rem: "27", state: "ACTIVE" },
  { label: "Female 50%", count: "141 / 150", max: "150 (50%)", rem: "9", state: "NEAR_FULL" },
]);
ok("each cell shows source question, current / maximum (percent resolved), remaining and its own status");
assert.match(await text(`${gender} [data-testid="quota-total-line"]`), /264 \/ 300.*88%.*Remaining: 36/);
assert.match(await text('[data-testid="quota-utilization"]'), /%/);
assert.match(await text('[data-testid="quota-remaining-capacity"]'), /^\d+$/);
ok("quota totals, overall utilization and remaining capacity are shown with real numbers");

const cross = cardOf("quota_gender_age");
assert.ok(await page.$(`${cross} [data-testid="quota-expand"]`), "8-cell quota is collapsed");
assert.equal((await page.$$(`${cross} [data-testid="quota-cell"]`)).length, 3);
await page.click(`${cross} [data-testid="quota-expand"]`);
assert.equal((await page.$$(`${cross} [data-testid="quota-cell"]`)).length, 8);
assert.match(await text(`${cross} [data-testid="quota-cell"]:nth-of-type(1)`), /AND/);
ok("a multi-dimensional quota expands to all 8 cells, each condition written out (Gender AND Age)");

/* ------------------------------------------------------------ search / filter / sort / table */

console.log("\nSEARCH · FILTER · SORT · TABLE");
await page.fill('[data-testid="quota-search"]', "gender");
await page.waitForTimeout(150);
assert.deepEqual((await page.$$eval('[data-testid="quota-card"]', (cs) => cs.map((c) => c.dataset.quotaId))).sort(), ["quota_gender", "quota_gender_age"]);
await page.fill('[data-testid="quota-search"]', "AGE_GROUP");
await page.waitForTimeout(150);
assert.deepEqual((await page.$$eval('[data-testid="quota-card"]', (cs) => cs.map((c) => c.dataset.quotaId))).sort(), ["quota_age", "quota_gender_age"]);
await page.fill('[data-testid="quota-search"]', "");
ok("search matches by question text and by variable name");
await page.selectOption('[data-testid="quota-filter"]', "inactive");
await page.waitForTimeout(100);
assert.deepEqual(await page.$$eval('[data-testid="quota-card"]', (cs) => cs.map((c) => c.dataset.quotaId)), ["quota_soft_region"]);
await page.selectOption('[data-testid="quota-filter"]', "all");
await page.selectOption('[data-testid="quota-sort"]', "name");
await page.waitForTimeout(100);
const names = await page.$$eval('[data-testid="quota-name"]', (es) => es.map((e) => e.textContent));
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
await page.selectOption('[data-testid="quota-sort"]', "status");
ok("filter (inactive) and sort (name) work against the real configuration");
await page.click('[data-testid="quota-view-table"]');
await page.waitForSelector('[data-testid="quota-table"]');
assert.equal((await page.$$('[data-testid="quota-table-row"]')).length, 4);
assert.ok((await page.$$('[data-testid="quota-table-cell"]')).length >= 8);
await page.click('[data-testid="quota-view-cards"]');
ok("compact table view lists every quota with its cells");

/* ------------------------------------------------------------ inline edit */

console.log("\nINLINE EDIT");
await page.click(`${gender} [data-testid="quota-edit"]`);
await page.waitForSelector(`${gender} [data-testid="quota-save"]`);
const maleLimit = `${gender} [data-testid="quota-cell"][data-cell-id="qg_male"] [data-testid="quota-cell-limit"]`;
const maleTarget = `${gender} [data-testid="quota-cell"][data-cell-id="qg_male"] [data-testid="quota-cell-target"]`;
// invalid: percent above 100
await page.fill(maleLimit, "120");
await page.click(`${gender} [data-testid="quota-save"]`);
await page.waitForSelector(`${gender} [data-testid="quota-issues"]`);
assert.match(await text(`${gender} [data-testid="quota-issues"]`), /cannot exceed 100%/);
// invalid: maximum below target
await page.fill(maleLimit, "40"); await page.fill(maleTarget, "45");
await page.click(`${gender} [data-testid="quota-save"]`);
assert.match(await text(`${gender} [data-testid="quota-issues"]`), /Maximum \(40%\) must be greater than or equal to Target \(45%\)/);
ok("invalid values cannot be saved: percent > 100, and Maximum below Target are reported");
// over-cap: 40 % of 300 = 120 < 123 collected
await page.fill(maleTarget, "");
await page.click(`${gender} [data-testid="quota-save"]`);
await page.waitForSelector(`${gender} [data-testid="quota-overcap-warning"]`);
assert.match(await text(`${gender} [data-testid="quota-overcap-warning"]`), /current response count \(123\) already exceeds the new maximum \(120\)/);
assert.equal(await page.$('[data-testid="quota-note"]'), null, "nothing saved before confirmation");
// leaving the tab with an open edit asks first — decline, and the edit is still there
page.removeAllListeners("dialog");
page.once("dialog", (d) => d.dismiss());
await page.click(".leftnav >> text=Questions");
await page.waitForTimeout(200);
page.on("dialog", (d) => d.accept());
assert.ok(await page.$(`${gender} [data-testid="quota-save"]`), "still editing after declining to leave");
ok("switching panels with unsaved quota changes asks for confirmation");
await page.waitForSelector(`${gender} [data-testid="quota-overcap-accept"] input`);
await page.click(`${gender} [data-testid="quota-overcap-accept"] input`);
await page.click(`${gender} [data-testid="quota-save"]`);
await page.waitForSelector('[data-testid="quota-note"]:has-text("Quota updated successfully.")');
ok("reducing a maximum below the collected count warns, blocks until confirmed, then saves with clear feedback");
const saved = await h.readDef();
const g = saved.quotas.find((q) => q.id === "quota_gender");
assert.equal(g.cells[0].limit, 40); assert.equal(g.cells[0].target, undefined);
assert.deepEqual(g.cells[0].when, def.quotas[0].cells[0].when, "the cell's condition is untouched");
assert.equal(g.cells[1].limit, 50, "the other cell is untouched");
ok("the change persisted through the ordinary definition path; logic and other cells unchanged");
await h.goTab("Quotas");
await page.waitForSelector(`${gender} [data-testid="quota-cell"][data-cell-id="qg_male"][data-state="FULL"]`);
ok("the dashboard now shows Male as FULL (123 ≥ 120) — the same rule the engine enforces");

// cancel restores
await page.click(`${gender} [data-testid="quota-edit"]`);
await page.fill(`${gender} [data-testid="quota-edit-name"]`, "Renamed");
await page.click(`${gender} [data-testid="quota-cancel"]`);
assert.equal(await text(`${gender} [data-testid="quota-name"]`), "Gender 50/50");
assert.equal((await h.readDef()).quotas.find((q) => q.id === "quota_gender").name, "Gender 50/50");
ok("Cancel restores the values that existed before editing");

/* ------------------------------------------------------------ edit logic */

console.log("\nEDIT LOGIC");
await h.goTab("Quotas");
await page.click(`${cardOf("quota_age")} [data-testid="quota-edit-logic"]`);
await page.waitForSelector('[data-testid="quota-logic-mode"] [data-quota-logic-id="quota_age"]');
assert.ok(await page.$('[data-quota-logic-id="quota_age"].qd-focus'));
await page.click('[data-testid="quota-back-to-dashboard"]');
await page.waitForSelector('[data-testid="quota-dashboard"]');
ok("Edit Logic opens the existing Quota Logic Builder focused on that quota, and returns to the dashboard");

/* ------------------------------------------------------------ delete */

console.log("\nDELETE");
await page.click(`${cardOf("quota_age")} [data-testid="quota-delete"]`);
await page.waitForSelector('[data-testid="quota-delete-confirm"]');
assert.match(await text('[data-testid="quota-delete-refs"]'), /quota check qc_demographics/);
await page.click('[data-testid="quota-delete-run"]');
await page.waitForSelector('[data-testid="quota-note"]:has-text("deleted")');
const afterDelete = await h.readDef();
assert.equal(afterDelete.quotas.length, 3);
assert.ok(!afterDelete.quotas.some((q) => q.id === "quota_age"));
const qc = (function find(nodes) { for (const n of nodes) { if (n.type === "quota_check") return n; const k = [...(n.children ?? [])]; const r = find(k); if (r) return r; } })(afterDelete.flow);
assert.deepEqual(qc.quotaIds, ["quota_gender", "quota_gender_age"], "the reference was cleaned up");
assert.equal(afterDelete.questions.length, def.questions.length, "no question removed");
ok("delete asks for confirmation, warns about the quota check that references it, removes only the rule and cleans the reference");

await h.close();
console.log(`\n${passed} checks passed`);
