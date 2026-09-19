/**
 * Browser suite — Advanced data export (§44), phase 1.
 *
 * The file CONTENTS are verified elsewhere, and deliberately so: the unit
 * suite in packages/exporters reads the .sav and .xpt back with independent
 * decoders, and `scripts/verify-statistical-exports.mjs` checks them against
 * pyreadstat. Neither of those can tell whether the Studio actually asks for
 * the right file, which is what this covers:
 *
 *   1. The statistical formats are offered at all, behind "More formats".
 *   2. Codes / Labels / Codes + labels changes the CSV and Excel links.
 *   3. It does NOT change the SPSS or SAS links — in those formats the code
 *      is the value and the label is metadata, so offering the choice there
 *      would promise something the format does not do.
 *   4. Every export link carries the dataset filter, so the download matches
 *      the table the researcher is looking at.
 *
 *   STUDIO_URL=http://localhost:3000 node scripts/data-export-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;

await h.loadDef({
  meta: { id: "sandbox", code: "SANDBOX", title: "Export", version: "1.0" },
  questions: [
    { id: "gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender?", options: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }], settings: {} },
    { id: "age", code: "Q2", variableName: "AGE", type: "numeric", text: "Age?", settings: {} },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["gender", "age"] }, { type: "end", id: "e", status: "complete" }],
});

/* The Data tab loads from the API; the sandbox has no database behind it. */
await page.route("**/api/surveys/*/responses*", (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.get("format") === "summary") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      live: { in_progress: 0, complete: 2, screened: 0, quota_full: 0, terminated: 0, total: 2 },
      test: { in_progress: 0, complete: 0, screened: 0, quota_full: 0, terminated: 0, total: 0 },
    }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    version: "1.0",
    columns: ["GENDER", "AGE"],
    rows: [
      { sessionId: "s1", status: "complete", isTest: false, startedAt: "2026-09-03T10:00:00Z", completedAt: "2026-09-03T10:05:00Z", durationSec: 300, flags: [], vars: { GENDER: "1", AGE: 42 }, quality: null, review: null },
      { sessionId: "s2", status: "complete", isTest: false, startedAt: "2026-09-03T10:10:00Z", completedAt: "2026-09-03T10:14:00Z", durationSec: 240, flags: [], vars: { GENDER: "2", AGE: 51 }, quality: null, review: null },
    ],
    dataset: "all", total: 2, included: 2,
  }) });
});

await h.goTab("Data");
await page.waitForSelector('[data-testid="export-csv"]');

/* ------------------------------------------- 1. the formats are reachable */

assert.ok(!(await page.$('[data-testid="export-panel"]')), "the extra formats start collapsed — the common case is still one click");
await page.click('[data-testid="export-more"]');
await page.waitForSelector('[data-testid="export-panel"]');
assert.ok(await page.$('[data-testid="export-sav"]'), "SPSS is offered");
assert.ok(await page.$('[data-testid="export-sas"]'), "SAS is offered");

const href = (id) => page.getAttribute(`[data-testid="${id}"]`, "href");
assert.match(await href("export-sav"), /format=sav/);
assert.match(await href("export-sas"), /format=sas/);
console.log("✔ SPSS (.sav) and SAS (.xpt + syntax) are offered from the Data tab");

/* ------------------------------ 2. the code/label choice reaches the files */

// the default is codes, and a default must not put anything in the URL
assert.ok(!/values=/.test(await href("export-csv")), "codes only is the default and sends no parameter");
assert.ok(!/values=/.test(await href("export-xlsx")), "...for Excel too");

await page.click('[data-testid="export-values-label"]');
await page.waitForFunction(() => /values=label/.test(document.querySelector('[data-testid="export-csv"]')?.href ?? ""));
assert.match(await href("export-csv"), /values=label/, "CSV asks for labels");
assert.match(await href("export-xlsx"), /values=label/, "Excel asks for labels");

await page.click('[data-testid="export-values-code_label"]');
await page.waitForFunction(() => /values=code_label/.test(document.querySelector('[data-testid="export-csv"]')?.href ?? ""));
assert.match(await href("export-csv"), /values=code_label/);
console.log("✔ Codes / Labels / Codes + labels is carried into the CSV and Excel downloads");

/* ------------------- 3. and is NOT offered where the format does it better */

assert.ok(!/values=/.test(await href("export-sav")),
  "SPSS must not take the value mode: the .sav holds codes with labels attached as metadata, which is the reason to ask for it");
assert.ok(!/values=/.test(await href("export-sas")), "...nor SAS, for the same reason");
console.log("✔ the statistical formats ignore the choice — codes stay codes, labels travel as metadata");

/* ------------------------------------- 4. every link follows the dataset */

await page.selectOption('[data-testid="dataset-select"]', "clean");
await page.waitForFunction(() => /dataset=clean/.test(document.querySelector('[data-testid="export-sav"]')?.href ?? ""));
for (const id of ["export-csv", "export-xlsx", "export-sav", "export-sas"]) {
  assert.match(await href(id), /dataset=clean/, `${id} must export the dataset on screen, not a different one`);
}
console.log("✔ every export link — including the new ones — carries the dataset filter");

await h.close();
console.log("\nALL DATA EXPORT CHECKS PASSED");
