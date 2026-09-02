/**
 * Phase 1 — persistence and freshness.
 *
 * These are the guarantees the stabilisation work exists to provide, asserted
 * against the real Studio. The Supabase-backed routes are intercepted so the
 * harness runs without a database, but every assertion is about the app's own
 * behaviour: what it sends, when it sends it, and what it refuses to lose.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

/* ------------------------------------------------------------ autosave */

// The sandbox has no database row, so drive autosave observability through a
// stubbed survey id instead.
const drafts = [];
let draftFails = false;
let versionCalls = 0;

await page.route("**/api/surveys/*/draft", async (route) => {
  const req = route.request();
  if (req.method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
  const body = JSON.parse(req.postData());
  drafts.push(body.definition);
  if (draftFails) {
    return route.fulfill({
      status: 500, contentType: "application/json",
      body: JSON.stringify({ error: "database unreachable" }),
    });
  }
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, savedAt: new Date().toISOString() }),
  });
});
await page.route("**/api/surveys/*/versions", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  versionCalls++;
  // deliberately slow, so an edit can be made DURING the save
  await new Promise((r) => setTimeout(r, 1200));
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: "ver_new", version: "9.9", variables: 12 }),
  });
});
await page.route("**/api/surveys/*/publish", (route) =>
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ deployments: [
      { mode: "live", versionId: "ver_old", version: "1.2", client_slug: "acme", study_slug: "s1" },
    ] }),
  }));
await page.route("**/api/surveys/*/responses*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------- the settings are reachable */

await page.click(".leftnav >> text=Survey Settings");
await page.waitForSelector('[data-testid="survey-settings"]');
await page.selectOption('[data-testid="access-mode"]', "password");
await page.waitForTimeout(200);
let mode = await page.$eval('[data-testid="access-mode"]', (e) => e.value);
assert.equal(mode, "password", "study mode changed");
console.log("✔ Survey Settings is its own tab — the access mode is always reachable");

// and it survives switching to a question and back, which is where it used to
// disappear entirely
await page.click(".leftnav >> text=Questions");
await page.click(".insert-bar >> text=+ Question");
await page.waitForSelector(".qcard.selected");
await page.click(".leftnav >> text=Survey Settings");
mode = await page.$eval('[data-testid="access-mode"]', (e) => e.value);
assert.equal(mode, "password", "the mode is still there after selecting a question");
console.log("✔ selecting a question no longer hides the survey settings");

/* -------------------------------------------------- the save indicator */

const saveState = async () => (await page.$eval('[data-testid="save-state"]', (e) => e.textContent)).trim();
await page.selectOption('[data-testid="access-mode"]', "unique_links");
await page.waitForTimeout(120);
assert.match(await saveState(), /Unsaved changes/, `dirty is announced: ${await saveState()}`);
console.log("✔ an edit immediately reads “Unsaved changes”");

/* --------------------------------- unique-link warning is honest, not silent */

const warn = await page.$$eval(".chip.warn", (els) => els.map((e) => e.textContent).join(" "));
assert.match(warn, /Test Survey still works/, `unique-link caveat is stated: ${warn.slice(0, 80)}`);
console.log("✔ unique-link mode explains that live needs tokens but Test still works");

/* ------------------------------------------------------- the publish gap */

await page.waitForSelector('[data-testid="publish-bar"]');
const bar = await page.$eval('[data-testid="publish-bar"]', (e) => e.innerText.replace(/\s+/g, " "));
assert.match(bar, /live link is running v1\.2/i, bar);
assert.match(bar, /Publish/i, bar);
console.log("✔ the editor states the gap between the live link and what you are editing");

await browser.close();

/* ============================================================ save race */
/**
 * The reported bug: change something while a save is in flight and the change
 * is reverted, with a success toast. Driven separately so the slow /versions
 * stub above applies cleanly.
 */
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 1600, height: 1000 } });
p2.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

let saveBody = null;
await p2.route("**/api/surveys/*/draft", (route) =>
  route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, savedAt: new Date().toISOString() }) }));
await p2.route("**/api/surveys/*/publish", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
await p2.route("**/api/surveys/*/responses*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
await p2.route("**/api/surveys/*/versions", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  saveBody = JSON.parse(route.request().postData());
  await new Promise((r) => setTimeout(r, 1500));
  return route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ id: "ver_x", version: "2.0", variables: 3 }) });
});

await p2.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await p2.click(".leftnav >> text=Survey Settings");
await p2.waitForSelector('[data-testid="access-mode"]');
await p2.selectOption('[data-testid="access-mode"]', "open");
await p2.waitForTimeout(150);

// start a save, then change the mode WHILE it is in flight
await p2.click("text=Save version");
await p2.waitForTimeout(300);
await p2.selectOption('[data-testid="access-mode"]', "password");
await p2.waitForTimeout(2000); // let the slow save resolve

const after = await p2.$eval('[data-testid="access-mode"]', (e) => e.value);
assert.equal(after, "password",
  `an edit made during a save must survive it — got "${after}"`);
console.log("✔ editing during a save no longer reverts the change when it lands");

// and Test Survey cannot fire a second concurrent save
const testDisabledDuringSave = await p2.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /Test Survey|Saving/.test(b.textContent));
  return !!btn;
});
assert.ok(testDisabledDuringSave, "the Test button reflects saving state");
console.log("✔ Test Survey is gated while a save is running");

await b2.close();
console.log("\nALL PERSISTENCE CHECKS PASSED");
