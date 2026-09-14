/**
 * WHAT THE DASHBOARD SAYS WHEN THE LOAD FAILS.
 *
 *   node scripts/dashboard-outage-test.mjs        (Studio on :3000)
 *
 * This exists because of a real incident. On 14 September Supabase's API
 * gateway returned 500/502/504 for a fraction of requests for about ten
 * minutes. The database was healthy and logged nothing; the deployment was
 * correct. The Studio told every user to go and check SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY in Vercel and redeploy — because it appended that
 * sentence to every failure it had ever seen, regardless of what the failure
 * was.
 *
 * So these checks are about one thing: does the banner tell the truth?
 *
 *   · a transient failure is called transient, retried by itself, and does
 *     NOT open with advice to edit production environment variables;
 *   · a genuinely missing key still says exactly that, immediately;
 *   · a 403 about a role says nothing about Vercel at all;
 *   · and every failure offers a button, because a blip should cost a click.
 *
 * `/api/surveys` is intercepted, so no Supabase is needed.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = "http://localhost:3000";
const VERCEL_ADVICE = /Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: "rescript_session", value: "outage-test-session-00000000", url: STUDIO }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

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
await page.route("**/api/billing/**", (route) => route.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify({ ok: false }),
}));

/** How `/api/surveys` will answer, and how many times it was asked. */
let plan = [];
let asked = 0;
const OK_BODY = JSON.stringify({ surveys: [], stats: {}, contributors: {}, warnings: [] });

await page.route("**/api/surveys", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const answer = plan[Math.min(asked, plan.length - 1)];
  asked++;
  await route.fulfill({
    status: answer.status,
    contentType: answer.html ? "text/html" : "application/json",
    body: answer.html ?? answer.body ?? OK_BODY,
  });
});

const banner = async () => {
  await page.waitForSelector('[data-testid="dash-error"]', { timeout: 20000 });
  return (await page.$eval('[data-testid="dash-error"]', (el) => el.innerText)).replace(/\s+/g, " ");
};

/**
 * Wait until the page has stopped asking. A cold dev server compiles the
 * route on the first visit, so simply waiting a fixed moment measures zero
 * requests and makes every count below meaningless.
 */
async function settled() {
  let last = -1;
  for (let i = 0; i < 60 && (asked === 0 || asked !== last); i++) {
    last = asked;
    await page.waitForTimeout(500);
  }
}

/** Load the dashboard afresh with a given plan of answers. */
async function visit(answers) {
  plan = answers;
  asked = 0;
  await page.goto(`${STUDIO}/`, { waitUntil: "domcontentloaded" });
}

/*
 * In development React mounts twice, so a single page load issues more than
 * one request. The checks below care whether a failure was RETRIED, not how
 * many times the page mounted — so the count of a clean load is measured
 * first and used as the baseline.
 */
let MOUNT_REQUESTS = 1;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ---------------------------------------------------- the transient case */

check("a one-off 502 recovers by itself, with no banner left behind", async () => {
  await visit([{ status: 502, body: JSON.stringify({ error: "Bad gateway" }) }, { status: 200 }]);
  await page.waitForSelector('[data-testid="dash-new-survey"], .survey-card, [data-testid="dash-empty"]', { timeout: 20000 })
    .catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[data-testid="dash-error"]'), null, { timeout: 20000 });
  assert.ok(asked >= 2, `it asked again rather than giving up: ${asked} requests`);
});

check("the 503 the session gate actually sends is called temporary, not a misconfiguration", async () => {
  await visit([{
    status: 503,
    body: JSON.stringify({ error: "Cannot verify your session right now. Please try again.", code: "session_unavailable" }),
  }]);
  const text = await banner();
  assert.match(text, /usually brief/i, `says it is temporary: ${text}`);
  assert.ok(
    !/^Cannot verify your session right now\. Please try again\. Check SUPABASE_URL/.test(text),
    "the Vercel advice is no longer the first thing said",
  );
  assert.match(text, /Try again/, "offers a button");
});

check("it keeps trying, and only mentions the environment once it has kept failing", async () => {
  await visit([{ status: 503, body: JSON.stringify({ code: "session_unavailable", error: "Cannot verify your session right now." }) }]);
  await page.waitForFunction(
    () => /If it keeps happening/.test(document.querySelector('[data-testid="dash-error"]')?.innerText ?? ""),
    null, { timeout: 20000 },
  );
  const text = await banner();
  assert.match(text, VERCEL_ADVICE, "the escape hatch is still there at the end");
  assert.match(text, /If it keeps happening/, `and it is framed as a last resort: ${text}`);
  assert.ok(asked >= 3, `it made several attempts first: ${asked}`);
});

check("the Try again button reloads rather than requiring a redeploy", async () => {
  await visit([{ status: 503, body: JSON.stringify({ code: "session_unavailable", error: "Cannot verify your session right now." }) }]);
  await banner();
  await page.waitForFunction(
    () => /If it keeps happening/.test(document.querySelector('[data-testid="dash-error"]')?.innerText ?? ""),
    null, { timeout: 20000 },
  );
  const before = asked;
  plan = [{ status: 200 }];
  await page.click('[data-testid="dash-retry"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="dash-error"]'), null, { timeout: 20000 });
  assert.ok(asked > before, "the button issued a fresh request");
});

/* ------------------------------------------------- the misconfigured case */

check("a genuinely missing key says so at once, and names the variables", async () => {
  await visit([{ status: 503, body: JSON.stringify({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured" }) }]);
  const text = await banner();
  assert.match(text, VERCEL_ADVICE, `the advice belongs here: ${text}`);
  assert.ok(!/If it keeps happening/.test(text), "and it is stated outright, not deferred");
  await settled();
  assert.equal(asked, MOUNT_REQUESTS, "a configuration error is not worth retrying");
});

check("an HTML error page still points at the environment", async () => {
  await visit([{ status: 500, html: "<html><body>Internal Server Error</body></html>" }]);
  const text = await banner();
  assert.match(text, /not JSON/, text);
  assert.match(text, VERCEL_ADVICE, text);
});

/* ------------------------------------------------------- everything else */

check("a refusal about permissions says nothing about Vercel", async () => {
  await visit([{ status: 403, body: JSON.stringify({ error: "Your role does not permit this.", code: "forbidden" }) }]);
  const text = await banner();
  assert.match(text, /Your role does not permit this/, text);
  assert.ok(!VERCEL_ADVICE.test(text), `no environment advice on a permissions refusal: ${text}`);
  await settled();
  assert.equal(asked, MOUNT_REQUESTS, "a refusal is an answer, not a blip");
});

/* ------------------------------------------------------------------ run */

console.log("DASHBOARD — WHAT IT SAYS WHEN THE LOAD FAILS\n");

await visit([{ status: 200 }]);
await settled();
MOUNT_REQUESTS = asked;
console.log(`  (a clean load issues ${MOUNT_REQUESTS} request${MOUNT_REQUESTS === 1 ? "" : "s"})\n`);
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} checks passed`);

await browser.close();
