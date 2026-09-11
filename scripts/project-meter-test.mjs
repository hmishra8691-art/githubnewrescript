/**
 * THE PROJECTS DASHBOARD'S WALLET METER, REFILL AND CLONE — browser suite.
 *
 * The point of putting a meter on the card is that a researcher should know
 * which project is about to stop WITHOUT opening any of them. So this suite
 * checks what a person actually sees on the list: four projects in four
 * different states, each reading the right money, the right percentage and
 * the right word; the filters and sorts that answer "which one is in
 * trouble"; and the two actions, refilled and cloned from the card itself.
 *
 * Supabase is not available here, so the API responses are fixtures — the
 * page, the card, the meter, the dialogs and the wiring between them are all
 * the real thing.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60_000).toISOString();

const SURVEYS = [
  { id: "s1", code: "HEALTHY", title: "Consumer Research Study", status: "testing", created_at: ago(9000), updated_at: ago(10), current_version_id: "v1", myRole: "owner", roleSource: "owner" },
  { id: "s2", code: "LOWBAL", title: "Brand Tracker Wave 3", status: "live", created_at: ago(9000), updated_at: ago(20), current_version_id: "v2", myRole: "owner", roleSource: "owner" },
  { id: "s3", code: "EMPTY", title: "Pricing Pilot", status: "live", created_at: ago(9000), updated_at: ago(30), current_version_id: "v3", myRole: "owner", roleSource: "owner" },
  { id: "s4", code: "NOWALLET", title: "Unfunded Study", status: "draft", created_at: ago(9000), updated_at: ago(40), current_version_id: "v4", myRole: "editor", roleSource: "member" },
];
const STATS = Object.fromEntries(SURVEYS.map((s, i) => [s.id, {
  questionCount: 34 - i, responseCount: 30 - i, testResponseCount: 17, liveResponseCount: 13 - i,
  completeCount: 13 - i, lastResponseAt: ago(60), contributorIds: [], versionCount: 1,
}]));

/* the four states the brief names, as the API sends them */
const meter = (surveyId, allocated, used, opts = {}) => ({
  surveyId, currency: "USD", allocated, used,
  remaining: Math.round((allocated - used) * 1e6) / 1e6,
  reserved: opts.reserved ?? 0,
  available: Math.round((allocated - used - (opts.reserved ?? 0)) * 1e6) / 1e6,
  usedPct: allocated > 0 ? Math.round((used / allocated) * 10000) / 100 : 0,
  level: opts.level, state: opts.state ?? "active", events: 4,
});

let PROJECTS = [
  { id: "s1", meter: meter("s1", 100, 43.25, { level: "normal" }), canRefill: true },
  { id: "s2", meter: meter("s2", 100, 88, { level: "low" }), canRefill: true },
  { id: "s3", meter: meter("s3", 50, 50, { level: "locked", state: "read_only" }), canRefill: true },
  { id: "s4", meter: null, canRefill: false },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "rescript_session", value: "meter-test-session-0000", url: "http://localhost:3000" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.route("**/api/auth/me", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    userId: "u-test", userCode: "USR-10000", name: "Test Researcher", email: "test@example.com",
    platformRole: "programmer", isPlatformAdmin: false, sessionId: "sess-test", unread: 0,
    policies: { heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15, idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180 },
  }),
}));
await page.route("**/api/auth/heartbeat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }) }));
await page.route("**/api/surveys", (route) => route.request().method() === "GET"
  ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: SURVEYS, stats: STATS, contributors: {}, statsSource: "rpc", warnings: [] }) })
  : route.continue());
await page.route("**/api/billing/projects", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ ok: true, currency: "USD", thresholds: { low: 20, critical: 5, readOnly: 0 }, isPlatformAdmin: false, projects: PROJECTS }),
}));

let transferred = null;
await page.route("**/api/billing/transfer", (route) => {
  if (route.request().method() === "GET") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, wallet: { id: "w-me", balance: 120, reserved: 20, available: 100, currency: "USD", totalAdded: 200 }, transfers: [], projects: [] }) });
  }
  const body = JSON.parse(route.request().postData() ?? "{}");
  transferred = body;
  /* the server's answer to a refill: the project's wallet now holds it, and
     a project that had stopped is active again */
  const p = PROJECTS.find((x) => x.id === body.toProjectId);
  if (p) {
    const m = p.meter ?? meter(body.toProjectId, 0, 0, { level: "locked", state: "read_only" });
    p.meter = meter(body.toProjectId, m.allocated + body.amount, m.used, { level: "normal", state: "active" });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, transfer: { code: "TRX-10007", amount: body.amount } }) });
});

let cloned = null;
await page.route("**/api/surveys/*/clone", (route) => {
  cloned = { url: route.request().url(), body: JSON.parse(route.request().postData() ?? "{}") };
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, id: "s9", code: "HEALTHY_COPY", title: cloned.body.title, counts: { question: 34 }, responsesCopied: false, walletBalance: 0 }),
  });
});
await page.route("**/api/surveys/*", (route) => route.continue());

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".survey-card:not(.skeleton)");
await page.waitForSelector('[data-testid="card-wallet"]');

const card = (title) => `.survey-card:has-text("${title}")`;
const textOf = async (sel) => (await page.$eval(sel, (el) => el.innerText.replace(/\s+/g, " "))).trim();

/* ------------------------------------------------- 1. the meter on the card */

console.log("\nTHE METER — four numbers, a bar and a word, without opening anything");
{
  const wallet = await textOf(`${card("Consumer Research")} [data-testid="card-wallet"]`);
  /* the labels are upper-cased by the stylesheet, so they are compared as words */
  for (const bit of ["$100.00", "$43.25", "$56.75", "43.25%", "Wallet", "Used", "Remaining", "Meter used"]) {
    assert.ok(wallet.toUpperCase().includes(bit.toUpperCase()), `the card shows ${bit}: ${wallet}`);
  }
  assert.equal(await page.getAttribute(`${card("Consumer Research")} [data-testid="card-wallet-bar"]`, "data-pct"), "43");
  assert.equal(await textOf(`${card("Consumer Research")} [data-testid="card-wallet-level"]`), "Healthy");

  /* and the existing information is still there — nothing was traded away for it */
  const whole = await textOf(card("Consumer Research"));
  for (const bit of ["34", "17", "Questions", "Test", "Complete", "TESTING"]) {
    assert.ok(whole.toUpperCase().includes(bit.toUpperCase()), `the card still shows ${bit}`);
  }
  console.log("  ok   $100 wallet · $43.25 used · $56.75 remaining · 43.25% · Healthy — beside the question and response counts");
}

/* -------------------------------------------------------- 2. the four states */

console.log("\nTHE STATES — a researcher can see which project is in trouble from the list");
{
  assert.equal(await textOf(`${card("Brand Tracker")} [data-testid="card-wallet-level"]`), "Low balance");
  assert.equal(await textOf(`${card("Pricing Pilot")} [data-testid="card-wallet-level"]`), "Read-only");
  assert.ok(await page.$(`${card("Pricing Pilot")} [data-testid="card-wallet-readonly"]`), "and it says why it has stopped");
  assert.equal(await page.getAttribute(`${card("Pricing Pilot")} [data-testid="card-wallet-bar"]`, "data-pct"), "100");
  assert.equal(await textOf(`${card("Pricing Pilot")} [data-testid="cw-remaining"]`), "$0.00");
  assert.equal(await page.$(`${card("Unfunded Study")} [data-testid="card-wallet"]`), null,
    "a project with no wallet shows no meter rather than a misleading zero");
  console.log("  ok   Healthy · Low balance · Read-only (100% used, $0.00) · no wallet at all");
}

/* --------------------------------------------------------- 3. filter and sort */

console.log("\nFINDING THE ONE THAT MATTERS — balance filter and wallet sorts");
{
  await page.selectOption('[data-testid="dash-balance-filter"]', "exhausted");
  await page.waitForTimeout(150);
  let titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
  assert.deepEqual(titles, ["Pricing Pilot"], `exhausted only: ${titles}`);

  await page.selectOption('[data-testid="dash-balance-filter"]', "low");
  await page.waitForTimeout(150);
  titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
  assert.deepEqual(titles, ["Brand Tracker Wave 3"]);

  await page.selectOption('[data-testid="dash-balance-filter"]', "all");
  await page.selectOption('[aria-label="Sort surveys"]', "balance_asc");
  await page.waitForTimeout(150);
  titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
  assert.deepEqual(titles.slice(0, 3), ["Pricing Pilot", "Brand Tracker Wave 3", "Consumer Research Study"],
    `lowest balance first: ${titles}`);
  assert.equal(titles[3], "Unfunded Study", "a project with no wallet sorts last, never first");

  await page.selectOption('[aria-label="Sort surveys"]', "used_desc");
  await page.waitForTimeout(150);
  titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
  assert.equal(titles[0], "Brand Tracker Wave 3", `most used first: ${titles}`);

  await page.selectOption('[aria-label="Sort surveys"]', "updated");
  await page.waitForTimeout(150);
  console.log("  ok   exhausted / low filters, lowest-balance and most-used sorts — the existing sorts untouched");
}

/* ------------------------------------------------------------- 4. the refill */

console.log("\nREFILL — from the card, moving credits that already exist");
{
  await page.click(`${card("Pricing Pilot")} [data-testid="card-refill"]`);
  await page.waitForSelector('[data-testid="refill-dialog"]');
  const avail = await textOf('[data-testid="refill-available"]');
  assert.ok(avail.includes("$100.00"), `it offers what is actually available — balance 120 less 20 reserved: ${avail}`);

  /* over-spending is refused before it is sent */
  await page.fill('[data-testid="refill-amount"]', "500");
  await page.waitForTimeout(120);
  assert.ok(await page.$('[data-testid="refill-over"]'), "more than available is refused on the screen");
  assert.equal(await page.getAttribute('[data-testid="refill-confirm"]', "disabled"), "", "and the button is not pressable");

  await page.click('[data-testid="refill-quick-50"]');
  await page.waitForTimeout(120);
  assert.equal(await page.inputValue('[data-testid="refill-amount"]'), "50");
  assert.equal(await page.$('[data-testid="refill-over"]'), null);
  await page.click('[data-testid="refill-confirm"]');
  await page.waitForSelector('[data-testid="refill-done"]');

  assert.deepEqual({ to: transferred.toProjectId, amount: transferred.amount }, { to: "s3", amount: 50 },
    "the refill is a transfer into that project, not a credit conjured for it");
  await page.click('[data-testid="refill-dialog"] .btn.primary');
  await page.waitForTimeout(400);

  /* and the project is alive again, with no one touching its status */
  assert.equal(await textOf(`${card("Pricing Pilot")} [data-testid="card-wallet-level"]`), "Healthy");
  assert.equal(await textOf(`${card("Pricing Pilot")} [data-testid="cw-remaining"]`), "$50.00");
  assert.equal(await page.$(`${card("Pricing Pilot")} [data-testid="card-wallet-readonly"]`), null);
  console.log("  ok   $50 moved from the person's own credits; the read-only project is active again");
}

/* -------------------------------------------------------------- 5. the clone */

console.log("\nCLONE — from the card, and honest about what it does not copy");
{
  await page.click(`${card("Consumer Research")} .card-actions .menu-anchor button`);
  await page.waitForSelector('[data-testid="clone-project-menu-item"]');
  await page.click('[data-testid="clone-project-menu-item"]');
  await page.waitForSelector('[data-testid="clone-dialog"]');

  assert.equal(await page.inputValue('[data-testid="clone-title"]'), "Consumer Research Study — Copy");
  const copied = await textOf('[data-testid="clone-copied"]');
  for (const bit of ["Questions", "logic", "Quotas", "Translations", "carry-forward"]) {
    assert.ok(copied.toLowerCase().includes(bit.toLowerCase()), `the list names ${bit}: ${copied}`);
  }
  const excluded = await textOf('[data-testid="clone-excluded"]');
  assert.match(excluded, /No responses/i, "it says responses are not copied");
  assert.match(excluded, /\$0\.00/, "and that the wallet starts empty");

  await page.click('[data-testid="clone-confirm"]');
  await page.waitForSelector('[data-testid="clone-done"]');
  assert.match(cloned.url, /\/api\/surveys\/s1\/clone$/);
  assert.equal(cloned.body.title, "Consumer Research Study — Copy");
  assert.ok(await page.$('[data-testid="clone-open"]'), "and it offers to open the copy");
  await page.click('[data-testid="clone-dialog"] .btn:not(.primary)');
  await page.waitForTimeout(200);
  console.log("  ok   cloned from the card; the dialog states what travels and what does not");
}

/* ------------------------------------------------------------- 6. narrow screen */

console.log("\nNARROW SCREEN — the meter and the actions survive a phone");
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await phone.addCookies([{ name: "rescript_session", value: "meter-test-session-0000", url: "http://localhost:3000" }]);
  const p2 = await phone.newPage();
  for (const [pattern, handler] of [
    ["**/api/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u-test", userCode: "USR-10000", name: "T", email: "t@e.com", platformRole: "programmer", isPlatformAdmin: false, sessionId: "s", unread: 0, policies: { heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15, idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180 } }) })],
    ["**/api/auth/heartbeat", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }) })],
    ["**/api/surveys", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: SURVEYS, stats: STATS, contributors: {}, statsSource: "rpc", warnings: [] }) })],
    ["**/api/billing/projects", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, currency: "USD", thresholds: { low: 20, critical: 5, readOnly: 0 }, isPlatformAdmin: false, projects: PROJECTS }) })],
  ]) await p2.route(pattern, handler);

  await p2.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await p2.waitForSelector('[data-testid="card-wallet"]');
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page does not scroll sideways on a phone (${overflow}px)`);
  const bar = await p2.$('[data-testid="card-wallet-bar"]');
  assert.ok(bar, "the meter is still drawn");
  const box = await bar.boundingBox();
  assert.ok(box.width > 100, `and still readable (${Math.round(box.width)}px wide)`);
  /* every action is reachable: the menu carries refill and clone on a narrow card */
  await p2.click('.survey-card:has-text("Consumer Research") .card-actions .menu-anchor button');
  await p2.waitForSelector('[data-testid="clone-project-menu-item"]');
  assert.ok(await p2.$('[data-testid="refill-menu-item"]'), "refill is in the overflow menu too");
  await p2.screenshot({ path: "/tmp/project-meter-phone.png", fullPage: false });
  await phone.close();
  console.log("  ok   390px: no sideways scroll, meter readable, refill and clone in the menu");
}

await browser.close();
console.log("\nALL PROJECT METER / REFILL / CLONE CHECKS PASSED");
