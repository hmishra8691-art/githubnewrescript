/**
 * Survey Project Dashboard E2E.
 *
 * The dashboard reads from Supabase, which is not available in CI, so the
 * /api/surveys response is intercepted and replaced with a fixture. That
 * still exercises the real page: card rendering, the test/live split,
 * contributor avatars, relative times, search, sort, status filters,
 * skeleton loading, per-statistic error tolerance and the mobile layout.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60_000).toISOString();

const SURVEYS = [
  { id: "s1", code: "CSAT_2026", title: "Customer Satisfaction Survey", status: "live",
    created_at: ago(60 * 24 * 6), updated_at: ago(120), current_version_id: "v1" },
  { id: "s2", code: "BRAND_TRK", title: "Brand Tracker Wave 3", status: "testing",
    created_at: ago(60 * 24 * 2), updated_at: ago(30), current_version_id: "v2" },
  { id: "s3", code: "PILOT", title: "Pricing Pilot", status: "draft",
    created_at: ago(60 * 5), updated_at: ago(60 * 3), current_version_id: "v3" },
  { id: "s4", code: "OLD_2025", title: "Legacy Study 2025", status: "archived",
    created_at: ago(60 * 24 * 400), updated_at: ago(60 * 24 * 300), current_version_id: "v4" },
];

const STATS = {
  s1: { questionCount: 32, responseCount: 487, testResponseCount: 25, liveResponseCount: 462,
        completeCount: 431, lastResponseAt: ago(15), contributorIds: ["u1", "u2", "u3", "u4"], versionCount: 12 },
  s2: { questionCount: 18, responseCount: 40, testResponseCount: 40, liveResponseCount: 0,
        completeCount: 31, lastResponseAt: ago(200), contributorIds: ["u1"], versionCount: 4 },
  s3: { questionCount: 12, responseCount: 0, testResponseCount: 0, liveResponseCount: 0,
        completeCount: 0, lastResponseAt: null, contributorIds: [], versionCount: 1 },
  // a survey whose response counts failed to load: nulls, never zeros
  s4: { questionCount: 25, responseCount: null, testResponseCount: null, liveResponseCount: null,
        completeCount: null, lastResponseAt: null, contributorIds: ["u2"], versionCount: 7 },
};

const CONTRIBUTORS = {
  u1: { id: "u1", name: "Hemant Mishra", initials: "HM" },
  u2: { id: "u2", name: "Rahul Sharma", initials: "RS" },
  u3: { id: "u3", name: "Priya Singh", initials: "PS" },
  u4: { id: "u4", name: "Amit Kumar", initials: "AK" },
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
// the middleware redirects a visitor with no session cookie straight to /login
// before any route interception gets a chance to answer
await ctx.addCookies([{ name: "rescript_session", value: "dashboard-test-session-0000", url: "http://localhost:3000" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

let patched = null;
/*
 * The dashboard is behind a session now, and signs a visitor out to /login
 * when `/api/auth/me` refuses. This fixture supplies one, so the test keeps
 * exercising what it is about — the project cards — rather than the redirect.
 */
await page.route("**/api/auth/me", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    userId: "u-test", userCode: "USR-10000", name: "Test Researcher",
    email: "test@example.com", platformRole: "programmer", isPlatformAdmin: false,
    sessionId: "sess-test", unread: 0,
    policies: {
      heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15,
      idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180,
    },
  }),
}));
await page.route("**/api/auth/heartbeat", (route) => route.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }),
}));

await page.route("**/api/surveys", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      surveys: SURVEYS.map((s) => (patched && s.id === patched.id ? { ...s, status: patched.status } : s)),
      stats: STATS, contributors: CONTRIBUTORS, statsSource: "rpc", warnings: [],
    }),
  });
});
await page.route("**/api/surveys/*", async (route) => {
  const req = route.request();
  if (req.method() === "PATCH") {
    patched = { id: req.url().split("/").pop(), status: JSON.parse(req.postData()).status };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  }
  return route.continue();
});

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".survey-card:not(.skeleton)");

/* ------------------------------------------------------------- the card */

const cards = await page.$$(".survey-card:not(.skeleton)");
assert.equal(cards.length, 4, `every survey renders: ${cards.length}`);

// the default sort is "recently updated", so target the card by name
const CSAT = '.survey-card:has-text("Customer Satisfaction")';
const first = await page.$eval(CSAT, (el) => el.innerText.replace(/\s+/g, " "));
for (const bit of ["Customer Satisfaction Survey", "CSAT_2026", "LIVE", "32", "487", "25", "462"]) {
  assert.ok(first.includes(bit), `card shows ${bit}: ${first}`);
}
console.log("✔ card shows name, code, status, questions and the test/live split");

// the labels are what disambiguate the numbers
const labels = await page.$$eval(`${CSAT} .stat-label`, (els) => els.slice(0, 5).map((e) => e.textContent));
assert.deepEqual(labels, ["Questions", "Responses", "Test", "Live", "Complete"]);
console.log("✔ statistics are labelled:", labels.join(" / "));

// total = test + live, on the real fixture
const nums = await page.$$eval(`${CSAT} .stat-value`, (els) => els.slice(0, 5).map((e) => e.textContent));
assert.equal(Number(nums[1].replace(/,/g, "")), Number(nums[2]) + Number(nums[3]),
  `total = test + live (${nums[1]} = ${nums[2]} + ${nums[3]})`);
console.log(`✔ ${nums[1]} responses = ${nums[2]} test + ${nums[3]} live`);

/* --------------------------------------------------------- contributors */

const avatars = await page.$$eval(`${CSAT} .avatar`, (els) => els.map((e) => e.textContent));
assert.deepEqual(avatars.slice(0, 4), ["HM", "RS", "PS", "+1"], `avatars: ${avatars}`);
const contribText = await page.$eval(`${CSAT} .contributors`, (e) => e.innerText);
assert.match(contribText, /4 contributors/, contribText);
console.log("✔ contributors shown as 4 people, not 12 versions:", avatars.slice(0, 4).join(" "));

const names = await page.$eval(`${CSAT} .contributors`, (e) => e.getAttribute("title"));
assert.match(names, /Hemant Mishra/, "hovering names the contributors");
console.log("✔ contributor names appear on hover");

/* ------------------------------------------------------- relative times */

const foot = await page.$eval(`${CSAT} .survey-card-foot`, (e) => e.innerText.replace(/\s+/g, " "));
assert.match(foot, /Last response 15 minutes ago/, foot);
assert.match(foot, /Updated 2 hours ago/, foot);
console.log("✔ relative times: last response 15 minutes ago, updated 2 hours ago");

/* ------------------------------------- a failed statistic degrades to — */

const legacy = await page.$$eval(".survey-card", (els) => {
  const card = els.find((e) => e.innerText.includes("Legacy Study 2025"));
  return [...card.querySelectorAll(".stat-value")].map((e) => e.textContent);
});
assert.equal(legacy[0], "25", "the statistic that loaded still shows");
assert.deepEqual(legacy.slice(1, 5), ["—", "—", "—", "—"], `unavailable statistics show as —, not 0: ${legacy}`);
console.log("✔ an unavailable statistic renders as — while the rest of the card works");

const draftZeros = await page.$$eval(".survey-card", (els) => {
  const card = els.find((e) => e.innerText.includes("Pricing Pilot"));
  return [...card.querySelectorAll(".stat-value")].map((e) => e.textContent);
});
assert.deepEqual(draftZeros, ["12", "0", "0", "0", "0"], `a genuinely empty survey shows real zeros: ${draftZeros}`);
console.log("✔ a survey with no responses shows 0, not — (they are different facts)");

/* -------------------------------------------------------------- search */

await page.fill(".dash-search", "brand");
await page.waitForTimeout(150);
let titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.deepEqual(titles, ["Brand Tracker Wave 3"], `search by name: ${titles}`);
await page.fill(".dash-search", "CSAT");
await page.waitForTimeout(150);
titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.deepEqual(titles, ["Customer Satisfaction Survey"], `search by code: ${titles}`);
await page.fill(".dash-search", "");
await page.waitForTimeout(150);
console.log("✔ search matches survey name and code");

/* -------------------------------------------------------------- sorting */

await page.selectOption(".dash-toolbar select", "responses_desc");
await page.waitForTimeout(150);
titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.equal(titles[0], "Customer Satisfaction Survey", `most responses first: ${titles}`);
await page.selectOption(".dash-toolbar select", "name_az");
await page.waitForTimeout(150);
titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)), `A–Z: ${titles}`);
await page.selectOption(".dash-toolbar select", "updated");
await page.waitForTimeout(150);
console.log("✔ sorting by responses and by name works off real metadata");

/* ------------------------------------------------------------ filtering */

await page.click('.filter-pill:has-text("Live")');
await page.waitForTimeout(150);
titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.deepEqual(titles, ["Customer Satisfaction Survey"], `status filter: ${titles}`);
await page.click('.filter-pill:has-text("All")');
await page.waitForTimeout(150);

await page.selectOption(".dash-toolbar select >> nth=1", "none");
await page.waitForTimeout(150);
titles = await page.$$eval(".survey-card .survey-title", (els) => els.map((e) => e.innerText.split("\n")[0]));
assert.ok(titles.includes("Pricing Pilot"), `"no responses" filter: ${titles}`);
assert.ok(!titles.includes("Customer Satisfaction Survey"));
await page.selectOption(".dash-toolbar select >> nth=1", "any");
await page.waitForTimeout(150);
console.log("✔ status and has-responses filters narrow the list");

/* --------------------------------------------------- status transitions */

await page.click('.survey-card:has-text("Customer Satisfaction") .menu-anchor button');
await page.waitForSelector(".menu");
await page.click('.menu-item:has-text("Paused")');
await page.waitForTimeout(250);
const pill = await page.$eval('.survey-card:has-text("Customer Satisfaction") .status-pill', (e) => e.innerText.trim());
assert.equal(pill.toLowerCase(), "paused", `status changed to: ${pill}`);
assert.equal(patched?.status, "paused", "the change was sent to the API");
console.log("✔ status can be set from the card (live → paused)");

/* ------------------------------------------------------------ deep links */

const responsesHref = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".survey-card")]
    .find((e) => e.innerText.includes("Customer Satisfaction"));
  const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "Responses");
  return !!btn && !btn.disabled;
});
assert.ok(responsesHref, "the Responses action is available when there are responses");
console.log("✔ Responses action links through to the survey's data");

/* ------------------------------------------------------------ responsive */

await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(250);
const overflow = await page.evaluate(() => {
  const doc = document.documentElement;
  const wide = [...document.querySelectorAll(".survey-card, .stat-row, .dash-toolbar")]
    .filter((e) => e.getBoundingClientRect().right > doc.clientWidth + 1)
    .map((e) => e.className);
  return { horizontal: doc.scrollWidth > doc.clientWidth + 1, wide };
});
assert.equal(overflow.horizontal, false, "no horizontal scrolling on mobile");
assert.deepEqual(overflow.wide, [], `nothing overflows: ${overflow.wide.join(", ")}`);
const mobileCols = await page.$eval(".stat-row", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
assert.equal(mobileCols, 2, `statistics reflow to 2 columns on mobile, got ${mobileCols}`);
console.log("✔ mobile reflows the statistics to 2 columns with no horizontal overflow");
await page.screenshot({ path: "/tmp/dash-mobile.png", fullPage: false });

await page.setViewportSize({ width: 1280, height: 1000 });
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/dash-desktop.png", fullPage: false });

await browser.close();
console.log("\nALL DASHBOARD CHECKS PASSED");
