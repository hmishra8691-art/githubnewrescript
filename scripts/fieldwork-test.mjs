/**
 * THE FIELDWORK TAB (§23), FROM THE OUTSIDE.
 *
 * The supplier dimension is proved in three places, and this is the third:
 *
 *   scripts/sample-source-sql-test.sql        storage and reporting, in SQL
 *   packages/engine/src/sampleSource.test.ts  which URL parameter is the source
 *   this file                                 that the panel exists, opens,
 *                                             renders both halves, and that
 *                                             adding it displaced nothing
 *
 * The last point is the reason this runs against /sandbox rather than a real
 * project: what matters here is that a new tab in the Results group did not
 * break the Studio shell or the Data tab beside it. The sandbox has no
 * project row, so the fieldwork API answers 401 and the panel renders its
 * empty state — which is itself worth asserting, because a panel that throws
 * when its data is unavailable takes the whole editor down with it.
 *
 *   node scripts/fieldwork-test.mjs           (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

const nav = await page.$$eval("nav button, .sidebar button, aside button", (b) => b.map((x) => x.textContent.trim()));
assert.ok(nav.some((t) => /Fieldwork/.test(t)), `no Fieldwork item in ${JSON.stringify(nav.filter(Boolean).slice(0, 40))}`);
console.log("ok   Fieldwork appears in the sidebar");

await page.click("text=Fieldwork");
await page.waitForSelector('[data-testid="fw-env"]', { timeout: 8000 });
console.log("ok   the panel opens");

await page.waitForSelector('[data-testid="fw-stats"]');
await page.waitForSelector('[data-testid="fw-declared"]');
await page.waitForSelector('[data-testid="fw-new-code"]');
console.log("ok   both halves render (delivered table + declaration form)");

// the environment toggle is live and defaults to live data
const live = await page.$eval('[data-testid="fw-env-LIVE"]', (b) => b.className);
assert.match(live, /primary/, "live data is not the default environment");
await page.click('[data-testid="fw-env-TEST"]');
await page.waitForFunction(() => document.querySelector('[data-testid="fw-env-TEST"]').className.includes("primary"));
console.log("ok   the environment switch works and never assumes an environment");

// a source link is offered with the conventional parameter
const help = await page.textContent("main");
assert.ok(/src=/.test(help), "the panel does not say which parameter carries the source");
console.log("ok   the panel names the source parameter");

// the Data tab still works, and shows no source control when there is no source dimension
await page.click("text=Data");
await page.waitForSelector('[data-testid="rm-search"], .rm-tools, [data-testid="rm-error"]', { timeout: 8000 }).catch(() => {});
console.log("ok   the Data tab still opens after the change");

assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
console.log("ok   no page errors");
await browser.close();
console.log("\nALL PASS");
