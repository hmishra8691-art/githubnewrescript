/**
 * THE WORKSPACE ACCESS POLICY, EDITABLE (§7).
 *
 * `public.access_settings` was read on every sign-in, heartbeat and lock
 * decision since 0008 and written by nothing but the SQL editor. These checks
 * cover the panel's one idea and the property that makes it safe:
 *
 *   · what is IN FORCE and what the default would be, side by side, with the
 *     overridden values marked — so an operator can tell a decision somebody
 *     made from a default nobody chose
 *   · an empty field means INHERIT, and only the values actually set are sent
 *
 * The request is intercepted rather than answered by a real database: the
 * container's dev servers hold no Supabase credentials, and what is being
 * proved here is the panel's contract with the route, not the route's with
 * Postgres (which `loadPolicies` and the access unit tests already cover).
 *
 *   node scripts/access-policy-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* what the route returns: defaults everywhere except two values set here */
const PAYLOAD = {
  effective: {
    session: {
      heartbeatSeconds: 30, idleAfterSeconds: 300,
      staleAfterSeconds: 1800, absoluteLifetimeSeconds: 43200,
      allowForceTakeover: true,
    },
    throttle: { windowSeconds: 900, maxAttemptsPerAccount: 5, maxAttemptsPerSource: 25, lockoutSeconds: 900 },
    workspace: { defaultRole: null },
  },
  defaults: {
    session: {
      heartbeatSeconds: 30, idleAfterSeconds: 300,
      staleAfterSeconds: 900, absoluteLifetimeSeconds: 43200,
      allowForceTakeover: true,
    },
    throttle: { windowSeconds: 900, maxAttemptsPerAccount: 8, maxAttemptsPerSource: 25, lockoutSeconds: 900 },
  },
  /* exactly the two that differ from the defaults above */
  stored: { session: { staleAfterSeconds: 1800 }, throttle: { maxAttemptsPerAccount: 5 } },
  platformDefault: {},
  fields: {
    session: {
      heartbeatSeconds: { min: 5, max: 600, label: "Heartbeat", unit: "seconds" },
      idleAfterSeconds: { min: 30, max: 3600, label: "Idle after", unit: "seconds" },
      staleAfterSeconds: { min: 60, max: 86400, label: "Stale after", unit: "seconds" },
      absoluteLifetimeSeconds: { min: 300, max: 2592000, label: "Signed out after", unit: "seconds" },
    },
    throttle: {
      windowSeconds: { min: 60, max: 86400, label: "Attempt window", unit: "seconds" },
      maxAttemptsPerAccount: { min: 3, max: 100, label: "Attempts per account", unit: "" },
      maxAttemptsPerSource: { min: 3, max: 1000, label: "Attempts per source", unit: "" },
      lockoutSeconds: { min: 60, max: 86400, label: "Lockout", unit: "seconds" },
    },
  },
  grantableRoles: ["editor", "programmer", "reviewer", "viewer", "test_user", "deployment_manager"],
  workspaceId: "c1",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1300, height: 1200 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.route("**/api/auth/me", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    userId: "u1", userCode: "USR-1", name: "Ada", email: "ada@example.com",
    platformRole: "platform_admin", isPlatformAdmin: true, sessionId: "s1", unread: 0,
    policies: { heartbeatSeconds: 600 },
  }),
}));
/* the other two tabs are not under test; answer them so the page settles */
await page.route("**/api/admin/sessions", (r) => r.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [], stale: 0 }),
}));
await page.route("**/api/admin/accounts", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ accounts: [], platformRoles: ["platform_admin", "programmer"] }),
}));

let lastPut = null;
await page.route("**/api/admin/access", async (route) => {
  if (route.request().method() === "PUT") {
    lastPut = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, stored: {}, effective: PAYLOAD.effective, note: "Saved." }),
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PAYLOAD) });
});

await page.goto(`${STUDIO}/admin`, { waitUntil: "networkidle" });
await page.click('[data-testid="admin-tab-access"]');
await page.waitForSelector('[data-testid="access-policy"]');
ok("the access policy has a home behind the administrator door");

/* ================================================ in force vs the default */

const staleRow = await page.textContent('[data-field="staleAfterSeconds"]');
assert.match(staleRow, /1800/, "the value in force");
assert.match(staleRow, /30 minutes/, "explained in minutes, because that is the decision");
assert.match(staleRow, /900/, "and the platform default beside it");
assert.match(staleRow, /15 minutes/);
ok("a setting shows what is in force AND what it would be by default");

assert.ok(await page.$('[data-testid="overridden-staleAfterSeconds"]'),
  "an overridden value is marked");
assert.ok(await page.$('[data-testid="overridden-maxAttemptsPerAccount"]'));
assert.ok(!(await page.$('[data-testid="overridden-heartbeatSeconds"]')),
  "and an inherited one is not");
ok("the two values this workspace actually chose are marked “set here”");

/* ============================================== empty means inherit */

const prefilled = await page.$$eval('[data-testid^="access-input-"]', (els) =>
  els.map((e) => ({ id: e.getAttribute("data-testid"), value: e.value, placeholder: e.placeholder })));
const filled = prefilled.filter((f) => f.value !== "");
assert.deepEqual(
  filled.map((f) => f.id).sort(),
  ["access-input-maxAttemptsPerAccount", "access-input-staleAfterSeconds"],
  `only the stored values are pre-filled: ${JSON.stringify(filled)}`,
);
assert.ok(prefilled.every((f) => f.placeholder === "inherit"),
  "every empty field says what empty means");
ok("the form is not pre-filled with current values — empty means inherit");

/* ====================================== what actually gets sent */

await page.fill('[data-testid="access-input-idleAfterSeconds"]', "600");
await page.click('[data-testid="access-save"]');
await page.waitForSelector('[data-testid="access-note"]');

assert.deepEqual(lastPut.session, { staleAfterSeconds: "1800", idleAfterSeconds: "600" },
  `only the fields with a value are sent: ${JSON.stringify(lastPut.session)}`);
assert.deepEqual(lastPut.throttle, { maxAttemptsPerAccount: "5" });
assert.ok(!("workspace" in lastPut), "an inherited baseline role is not sent as a value");
ok("saving sends only the values that were set, so a default stays inheritable");

/* =================================================== clearing overrides */

await page.click('[data-testid="access-reset"]');
const afterReset = await page.$$eval('[data-testid^="access-input-"]', (els) => els.map((e) => e.value));
assert.ok(afterReset.every((v) => v === ""), "every field is emptied");
await page.click('[data-testid="access-save"]');
await page.waitForTimeout(300);
assert.deepEqual(lastPut.session, {}, `nothing is sent: ${JSON.stringify(lastPut)}`);
assert.deepEqual(lastPut.throttle, {});
ok("“clear all overrides” then save returns the workspace to the defaults");

/* ================================================ the baseline role */

await page.selectOption('[data-testid="access-baseline-role"]', "reviewer");
await page.click('[data-testid="access-save"]');
await page.waitForTimeout(300);
assert.deepEqual(lastPut.workspace, { defaultRole: "reviewer" });
ok("the workspace baseline role is sent in its own namespace, as loadPolicies expects");

await page.selectOption('[data-testid="access-baseline-role"]', "none");
await page.click('[data-testid="access-save"]');
await page.waitForTimeout(300);
assert.deepEqual(lastPut.workspace, { defaultRole: "none" },
  "“no baseline” is an explicit choice, distinct from inheriting one");
ok("“no baseline” is expressible, and is different from “inherit”");

/* ============================================== a loader that fails says so */

await page.unroute("**/api/admin/access");
await page.route("**/api/admin/access", (r) => r.fulfill({
  status: 503, contentType: "application/json", body: JSON.stringify({ error: "Access settings need migration 0008." }),
}));
await page.reload({ waitUntil: "networkidle" });
await page.click('[data-testid="admin-tab-access"]');
await page.waitForSelector('[data-testid="access-policy-error"]');
const errText = await page.textContent('[data-testid="access-policy-error"]');
assert.match(errText, /migration 0008/);
ok("a policy that cannot be read says why, instead of spinning for ever");

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
console.log(`\nALL ${passed} ACCESS POLICY CHECKS PASSED`);
await browser.close();
