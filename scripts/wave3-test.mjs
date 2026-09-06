/**
 * WAVE 3 — the starter library, editable variables, and reading a workbook.
 *
 *   §59  New survey offers studies people recognise, not only a capability demo
 *   §29  a variable's label and value labels can be restated for export
 *   §58  an .xlsx is accepted by the response importer
 *
 *   node scripts/wave3-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { SURVEY_TEMPLATES, buildNpsSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/auth/me", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ userId: "u1", userCode: "USR-1", name: "Ana", email: "a@b.c", platformRole: "user", isPlatformAdmin: true, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }),
}));

/* ------------------------------------------------------------------ §59 */

console.log("\nTHE STARTER LIBRARY (§59)");

assert.ok(SURVEY_TEMPLATES.length >= 6, "the library should offer more than the demo");
assert.equal(SURVEY_TEMPLATES[SURVEY_TEMPLATES.length - 1].key, "master_demo_2026");
ok(`${SURVEY_TEMPLATES.length} templates, with the capability demo last`);

for (const t of SURVEY_TEMPLATES) {
  const def = t.build("x");
  assert.ok(def.questions.length > 0, `${t.key} has no questions`);
  assert.ok(def.deployment.clientSlug && def.deployment.studySlug, `${t.key} has no deployment slug`);
}
ok("every template builds a complete, deployable definition");

/* ------------------------------------------------------------------ §29 */

console.log("\nVARIABLES A PROGRAMMER CAN RESTATE (§29)");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
const def = buildNpsSurvey("sandbox");
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.$eval("textarea.code", (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
}, JSON.stringify(def));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(900);

await page.click(".leftnav >> text=Variables");
await page.waitForSelector('[data-testid="variable-row"]');
const rowCount = await page.$$eval('[data-testid="variable-row"]', (es) => es.length);
assert.ok(rowCount > 0, "the dictionary is empty");

const first = page.locator('[data-testid="variable-row"]').first();
const varName = await first.locator("td strong").textContent();
await first.locator('[data-testid="edit-variable"]').click();
await page.waitForSelector('[data-testid="variable-editor"]');
await page.fill('[data-testid="var-label"]', "Recommendation score (0–10)");
await page.waitForTimeout(500);

assert.ok(await page.$('[data-testid="var-edited"]'), "an edited row should say so");
const label = await page.locator(`[data-variable="${varName}"] td`).nth(6).textContent();
assert.equal(label.trim(), "Recommendation score (0–10)",
  "the dictionary should show the label the programmer gave it");
ok("a variable's label can be restated, and the dictionary shows it (§29)");

// and it is in the definition the exports read, not just on screen
await page.click(".leftnav >> text=JSON");
await page.waitForSelector("textarea.code");
const saved = await page.$eval("textarea.code", (el) => el.value);
assert.match(saved, /Recommendation score/, "the override must live in the survey definition");
ok("the override is written into the definition, so exports and analysis see it");

await page.click(".leftnav >> text=Variables");
await page.waitForSelector('[data-testid="variable-row"]');
await page.locator('[data-testid="variable-row"]').first().locator('[data-testid="edit-variable"]').click();
await page.click('[data-testid="reset-variable"]');
await page.waitForTimeout(500);
assert.equal(await page.$('[data-testid="var-edited"]'), null, "Reset should remove the override entirely");
ok("Reset puts the derived label back and leaves nothing behind");

/*
 * §58 (reading a workbook) is proved in `packages/exporters` instead: the
 * import route is gated by `requireProject`, and /sandbox is a fixture with
 * no project row, so driving it from here would test the auth guard rather
 * than the parser. The unit tests cover the whole path the route takes,
 * base64 included.
 */

assert.deepEqual(errors, [], `uncaught errors: ${errors.join("\n")}`);
ok("no uncaught errors anywhere in the session");

await browser.close();
console.log(`\nALL ${passed} WAVE 3 CHECKS PASSED\n`);
