/**
 * Browser suite — export presets and the data dictionary (§44, phase 4).
 *
 * The thing most worth proving here is the degraded path. Migration 0042 has
 * not been applied to the user's database yet, so the panel must be useful
 * anyway: the built-in presets work, saving is offered but disabled, and the
 * reason is on screen rather than in a failed request nobody sees.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/export-presets-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

await h.loadDef({
  meta: { id: "sandbox", code: "SANDBOX", title: "Presets", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender?",
      options: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }], settings: {} },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});

/* The Data tab reads counts and rows from the API; the sandbox has no database. */
await page.route("**/api/surveys/*/responses*", (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.get("format") === "summary") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      live: { in_progress: 0, complete: 1, screened: 0, quota_full: 0, terminated: 0, total: 1 },
      test: { in_progress: 0, complete: 0, screened: 0, quota_full: 0, terminated: 0, total: 0 },
    }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    version: "1.0", columns: ["GENDER"],
    rows: [{ sessionId: "s1", status: "complete", isTest: false, startedAt: "2026-09-03T10:00:00Z",
      completedAt: "2026-09-03T10:05:00Z", durationSec: 300, flags: [], vars: { GENDER: "1" },
      quality: null, review: null }],
    dataset: "all", total: 1, included: 1,
  }) });
});

/*
 * THE DEGRADED PATH. This is what the user's database actually looks like
 * until they run 0042, so it is what the panel has to handle well.
 */
await page.route("**/api/surveys/*/export-presets*", (route) => {
  if (route.request().method() !== "GET") {
    return route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "Saving export presets needs migration 0042." }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    presets: [
      { id: "builtin_spss_research", name: "SPSS Research Export", format: "sav", values: "code", headers: "name", dataset: "clean", quality: false, includeDictionary: true },
      { id: "builtin_client_data", name: "Client Data Export", format: "xlsx", values: "label", headers: "name_label", dataset: "clean", quality: false, includeDictionary: false },
      { id: "builtin_raw_data", name: "Raw Data Export", format: "csv", values: "code", headers: "name", dataset: "all", quality: true, includeDictionary: false },
    ],
    saveable: false,
    note: "Saving your own export presets needs migration 0042. The built-in ones work now.",
  }) });
});

await h.goTab("Data");
await page.waitForSelector('[data-testid="export-more"]');
await page.click('[data-testid="export-more"]');
await page.waitForSelector('[data-testid="export-presets"]');

/* --------------------------------- 1. useful before the migration is run */

const presetNames = await page.$$eval('[data-testid="export-preset"]', (els) => els.map((e) => e.textContent));
assert.deepEqual(presetNames, ["SPSS Research Export", "Client Data Export", "Raw Data Export"],
  `the built-in presets must be offered, got ${JSON.stringify(presetNames)}`);
/*
 * Assert on the NAME BOX, not the save button. The button is disabled
 * whenever the box is empty, so checking it proves only that the box is
 * empty — the first version of this check passed with the `saveable` guard
 * deleted. The box being disabled is the guard, and it cannot be satisfied
 * by accident.
 */
assert.equal(await page.isDisabled('[data-testid="export-preset-name"]'), true,
  "the name box must be disabled until the table exists");
const note = await page.textContent('[data-testid="export-preset-note"]');
assert.match(note, /0042/, `the reason must be on screen, got: ${note}`);
console.log("✔ the built-in presets work before migration 0042, and saving says why it cannot");

/* ------------------------ 2. choosing a preset sets the download it means */

await page.click('[data-testid="export-preset"] >> text=SPSS Research Export');
await page.waitForTimeout(400);
let href = await page.getAttribute('[data-testid="export-preset-download"]', "href");
assert.match(href, /format=sav/, `the SPSS preset must select the .sav download: ${href}`);
assert.match(href, /dataset=clean/, "and its dataset");
assert.match(href, /dictionary=1/, "and ask for the dictionary, which is what that preset is for");
assert.equal(await page.isChecked('[data-testid="export-with-dictionary"]'), true,
  "the control must reflect what the preset chose, not just the URL");
console.log("✔ selecting the SPSS preset sets the format, the dataset and the dictionary");

await page.click('[data-testid="export-preset"] >> text=Client Data Export');
await page.waitForTimeout(400);
href = await page.getAttribute('[data-testid="export-preset-download"]', "href");
assert.match(href, /format=xlsx/, `the client preset delivers Excel: ${href}`);
assert.match(href, /values=label/, "with labels, so it reads without the questionnaire");
assert.ok(!/dictionary=1/.test(href), "and without the dictionary");
console.log("✔ the client preset switches to labelled Excel");

await page.click('[data-testid="export-preset"] >> text=Raw Data Export');
await page.waitForTimeout(400);
href = await page.getAttribute('[data-testid="export-preset-download"]', "href");
assert.match(href, /format=csv/, href);
assert.match(href, /dataset=all/, "raw means everything, including responses under review");
assert.ok(!/values=/.test(href), "codes are the default and send no parameter");
console.log("✔ the raw preset returns to codes and the full dataset");

/* ------------------------------- 3. the dictionary toggle stands alone too */

await page.uncheck('[data-testid="export-with-dictionary"]');
await page.waitForTimeout(300);
assert.ok(!/dictionary=1/.test(await page.getAttribute('[data-testid="export-sav"]', "href")),
  "unchecking it must drop the parameter");
await page.check('[data-testid="export-with-dictionary"]');
await page.waitForTimeout(300);
for (const id of ["export-sav", "export-sas"]) {
  assert.match(await page.getAttribute(`[data-testid="${id}"]`, "href"), /dictionary=1/,
    `${id} must carry the dictionary flag`);
}
console.log("✔ the dictionary can be asked for independently, on both statistical formats");

await h.close();
console.log("\nALL EXPORT PRESET CHECKS PASSED");
