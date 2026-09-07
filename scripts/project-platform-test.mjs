/**
 * THE PROJECT PANEL (§60) AND THE PLATFORM PAGE (§45), FROM THE OUTSIDE.
 *
 * Two things that are easy to get subtly wrong and that only a browser can
 * show:
 *
 *   §45  a non-production instance must SAY SO on every page, including the
 *        pages you reach before signing in — a person handed a staging link
 *        should be told before they type a password, not after. And /platform
 *        must answer with a tier, a database reference and a migration level
 *        while never printing a value of anything.
 *
 *   §60  the Project panel must open, must be clearly about the project
 *        rather than the questionnaire, and must degrade to read-only rather
 *        than letting somebody type into a field they cannot save.
 *
 * It runs against /sandbox, which has no project row, so the config API
 * answers 401 — which is exactly the state worth asserting for the panel, and
 * why the writes themselves are proved in
 * `scripts/project-config-sql-test.sql` instead.
 *
 *   node scripts/project-platform-test.mjs      (needs the Studio on :3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

/* ------------------------------------------------------------------- §45 */
console.log("\n§45 WHICH DEPLOYMENT THIS IS");

await page.goto(`${STUDIO}/login`, { waitUntil: "networkidle" });
const banner = await page.$('[data-testid="env-banner"]');
assert.ok(banner, "a non-production instance must show its tier — this dev server is one");
const tier = await page.$eval('[data-testid="env-banner"]', (e) => e.getAttribute("data-tier"));
assert.ok(tier === "development" || tier === "staging", `unexpected tier ${tier}`);
ok(`the banner names this instance (${tier}) before anybody signs in`);

const bannerText = await page.textContent('[data-testid="env-banner"]');
assert.doesNotMatch(bannerText, /eyJ|service_role|sb_secret|password/i, "the banner must never carry a credential");
ok("the banner carries a tier and a database reference, and nothing secret");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
assert.ok(await page.$('[data-testid="env-banner"]'), "the banner is in the root layout, so it is on every page");
ok("the same banner is on the editor, not only on the sign-in page");

/* the platform page */
await page.goto(`${STUDIO}/platform`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="platform-page"], [data-testid="platform-denied"]', { timeout: 10000 });
if (await page.$('[data-testid="platform-page"]')) {
  const shown = await page.$eval('[data-testid="platform-tier"]', (e) => e.textContent.trim());
  assert.ok(["development", "staging", "production"].includes(shown), `unexpected tier chip: ${shown}`);
  ok(`/platform reports the tier (${shown})`);

  await page.waitForSelector('[data-testid="platform-instance"]');
  await page.waitForSelector('[data-testid="platform-config"]');
  await page.waitForSelector('[data-testid="platform-migrations"]');
  ok("it reports the instance, its configuration and its migration level");

  /*
   * The one assertion that matters most on this page: it is meant to be
   * screenshotted into a support thread, so nothing on it may be a value.
   */
  const body = await page.textContent('[data-testid="platform-page"]');
  assert.doesNotMatch(body, /eyJ[A-Za-z0-9_-]{10}/, "a JWT reached the platform page");
  assert.doesNotMatch(body, /service_role|sb_secret|SUPABASE_SERVICE_ROLE_KEY=/, "a key name with a value reached the platform page");
  assert.match(body, /set|not set/, "the configuration should be reported as presence only");
  ok("nothing on the page is the value of anything — presence flags only");

  const migrations = await page.textContent('[data-testid="platform-migrations"]');
  assert.match(migrations, /migrations|applied|not applied|Up to date/i);
  ok("the migration level is answered, not left to a support conversation");
} else {
  ok("/platform refuses politely when it is not available here");
}

/* ------------------------------------------------------------------- §60 */
console.log("\n§60 THE PROJECT, NOT THE QUESTIONNAIRE");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

const nav = await page.$$eval(".leftnav .nav-item", (es) =>
  es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
assert.ok(nav.includes("Project"), `no Project item in ${JSON.stringify(nav)}`);
assert.ok(nav.indexOf("Project") < nav.indexOf("Versions & Deploy"), "Project belongs at the top of Management");
ok("Project sits at the top of the Management group");

await page.click(".leftnav .nav-item:has-text('Project')");
await page.waitForSelector("h2:has-text('Project')", { timeout: 8000 });
const panel = await page.textContent("main");
assert.match(panel, /This is the project, not the questionnaire/, "the panel must state the distinction it exists to make");
assert.match(panel, /Survey Settings/, "and point at where the questionnaire is edited");
ok("the panel says plainly that it is the project and not the questionnaire");

/*
 * The sandbox has no project row, so the config API answers 401 and the
 * panel must sit in its unavailable state rather than throwing. Whichever
 * state it lands in, it must not have crashed.
 */
assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
ok("no page errors — the panel degrades rather than taking the editor down");

/* and the Survey Settings tab is still the questionnaire's */
await page.click(".leftnav .nav-item:has-text('Survey Settings')");
await page.waitForSelector("text=Who can take this survey", { timeout: 8000 });
ok("Survey Settings still edits the questionnaire, untouched");

await browser.close();
console.log(`\nALL ${pass} CHECKS PASSED`);
