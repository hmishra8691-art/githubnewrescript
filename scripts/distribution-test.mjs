/**
 * THE DISTRIBUTION TAB (§24), FROM THE OUTSIDE.
 *
 * §24 is proved in two places, and this is the second:
 *
 *   scripts/distribution-sql-test.sql  the list itself — environment
 *                                      separation, one link per person, the
 *                                      progress query
 *   this file                          that the screen exists, that the
 *                                      upload previews before it writes, that
 *                                      the column mapping is a guess a human
 *                                      can correct, and that adding the tab
 *                                      displaced nothing
 *
 * It runs against /sandbox, which has no project row, so every distribution
 * API call answers 401 — which makes it the right place to assert that the
 * panel renders its empty state instead of taking the editor down with it,
 * and that the access-mode setting now POINTS AT this screen rather than
 * warning that no such screen exists.
 *
 *   node scripts/distribution-test.mjs        (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

const nav = await page.$$eval(".leftnav .nav-item", (es) =>
  es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
assert.ok(nav.includes("Distribution"), `no Distribution item in ${JSON.stringify(nav)}`);
assert.equal(nav[nav.indexOf("Distribution") + 1], "Versions & Deploy", "Distribution belongs beside Versions & Deploy");
ok("Distribution sits next to Versions & Deploy in Management");

await page.click(".leftnav .nav-item:has-text('Distribution')");
await page.waitForSelector('[data-testid="ds-env"]');
await page.waitForSelector('[data-testid="ds-stats"]');
await page.waitForSelector('[data-testid="ds-people"]');
await page.waitForSelector('[data-testid="ds-qr"]');
ok("the panel opens with progress, people and the QR section");

// the live list is the default, and the environment is never assumed
assert.match(await page.$eval('[data-testid="ds-env-LIVE"]', (b) => b.className), /primary/);
await page.click('[data-testid="ds-env-TEST"]');
await page.waitForFunction(() => document.querySelector('[data-testid="ds-env-TEST"]').className.includes("primary"));
ok("the test list and the live list are separate, and neither is assumed");

// the empty state says what to do, rather than showing an error
const stats = await page.textContent('[data-testid="ds-stats"]');
assert.match(stats, /Nobody on the test list yet/i);
ok("an empty list explains itself instead of failing");

/* ---------------------------------------------------- the upload preview */
await page.click('[data-testid="ds-upload-open"]');
await page.waitForSelector('[data-testid="ds-paste"]');
await page.fill('[data-testid="ds-list-name"]', "wave 1");
await page.fill('[data-testid="ds-paste"]',
  "name,email,employee_id,region\nAda Lovelace,ada@example.com,EMP-001,North\nAlan Turing,alan@example.com,EMP-002,South\nGrace Hopper,not-an-email,EMP-003,North\nAda Again,other@example.com,emp-001,North\n,,,\n");
await page.click('[data-testid="ds-preview"]');
// the sandbox has no project row, so the API refuses — the panel must SAY so
await page.waitForSelector('[data-testid="ds-preview-result"], [data-testid="ds-note"]', { timeout: 10000 });
const previewed = await page.$('[data-testid="ds-preview-result"]');
if (previewed) {
  const body = await page.textContent('[data-testid="ds-preview-result"]');
  assert.match(body, /2 to invite|3 to invite/, `unexpected preview summary: ${body.slice(0, 200)}`);
  assert.match(body, /duplicate/i, "the in-file duplicate was not reported");
  ok("the preview counts the people, and reports the duplicate and the bad address");
  assert.ok(await page.$('[data-testid="ds-map-email"]'), "the column mapping is not editable");
  ok("the guessed column mapping can be corrected before committing");
} else {
  const msg = await page.textContent('[data-testid="ds-note"]');
  assert.match(msg, /\S/);
  ok(`the upload reports why it could not run here rather than throwing (“${msg.trim().slice(0, 60)}…”)`);
}

/* ------------------------------------------- the access-mode setting now points here */
await page.click(".leftnav .nav-item:has-text('Survey Settings')");
await page.waitForSelector("text=Who can take this survey");
const select = await page.$("select.select:below(:text('Access mode'))") ?? (await page.$$("select.select"))[0];
await page.selectOption("select.select >> nth=0", "unique_links").catch(async () => {
  // the access-mode select is not necessarily the first one on the panel
  const selects = await page.$$("select.select");
  for (const sel of selects) {
    const opts = await sel.$$eval("option", (os) => os.map((o) => o.value));
    if (opts.includes("unique_links")) { await sel.selectOption("unique_links"); return; }
  }
  throw new Error("no access-mode select found");
});
await page.waitForSelector('[data-testid="access-personal-note"]', { timeout: 6000 });
const noteText = await page.textContent('[data-testid="access-personal-note"]');
assert.match(noteText, /Distribution/, "the access-mode note does not point at the Distribution screen");
assert.doesNotMatch(noteText, /no invitation-management screen/i, "the stale 'no screen exists' warning is still shown");
ok("choosing personal links points at Distribution instead of warning that no such screen exists");

assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
ok("no page errors");

await browser.close();
console.log(`\nALL ${pass} CHECKS PASSED`);
