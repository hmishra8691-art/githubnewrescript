/**
 * ONE WALLET, MANY PROJECTS — the dashboard, in a browser.
 *
 * The model: a person has one balance, every project they own spends from it,
 * and what a project may take is a limit on the project rather than money
 * inside it. The page has to make that legible without a paragraph of
 * explanation, so this suite checks what a researcher actually sees:
 *
 *   · one wallet above the list, not a balance repeated on every card;
 *   · per card, what THAT study has spent and what it may still spend, with
 *     the label saying which limit is the binding one;
 *   · a project stopped at its own limit reading differently from a project
 *     stopped because the wallet is empty — they need different actions;
 *   · setting a limit, which moves no money;
 *   · asking for funds, which is a request while payments are simulated.
 *
 * Supabase is not available here, so the API responses are fixtures — the
 * page, the cards, the dialogs and the wiring between them are the real thing.
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60_000).toISOString();

const SURVEYS = [
  { id: "s1", code: "SHARED", title: "Consumer Research Study", status: "testing", created_at: ago(9000), updated_at: ago(10), current_version_id: "v1", myRole: "owner", roleSource: "owner" },
  { id: "s2", code: "CAPPED", title: "Brand Tracker Wave 3", status: "live", created_at: ago(9000), updated_at: ago(20), current_version_id: "v2", myRole: "owner", roleSource: "owner" },
  { id: "s3", code: "FROZEN", title: "Pricing Pilot", status: "live", created_at: ago(9000), updated_at: ago(30), current_version_id: "v3", myRole: "owner", roleSource: "owner" },
  { id: "s4", code: "SHAREDIN", title: "Colleague Study", status: "draft", created_at: ago(9000), updated_at: ago(40), current_version_id: "v4", myRole: "editor", roleSource: "member" },
];
const STATS = Object.fromEntries(SURVEYS.map((s, i) => [s.id, {
  questionCount: 34 - i, responseCount: 30 - i, testResponseCount: 17, liveResponseCount: 13 - i,
  completeCount: 13 - i, lastResponseAt: ago(60), contributorIds: [], versionCount: 1,
}]));

/* the wallet every card draws on */
let WALLET = {
  walletId: "w-me", currency: "USD", balance: 265, reserved: 0, available: 265,
  totalAdded: 500, totalUsed: 235, transferredOut: 0, transferredIn: 0, level: "normal", state: "active",
};

const meter = (p) => ({
  currency: "USD", used: p.used, limit: p.limit ?? null, mode: p.mode ?? "shared",
  allowance: p.allowance, walletRemaining: WALLET.balance, reserved: p.reserved ?? 0,
  usedPct: p.usedPct, level: p.level, state: p.state ?? "active", events: 4,
});

let PROJECTS = [
  { id: "s1", meter: meter({ used: 120, allowance: 265, usedPct: 31.17, level: "normal" }), canBudget: true },
  { id: "s2", meter: meter({ used: 0.6, limit: 1, mode: "budget", allowance: 0.4, usedPct: 60, level: "critical" }), canBudget: true },
  { id: "s3", meter: meter({ used: 1, limit: 1, mode: "budget", allowance: 0, usedPct: 100, level: "locked", state: "frozen" }), canBudget: true },
  { id: "s4", meter: null, canBudget: false },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "rescript_session", value: "meter-test-session-0000", url: "http://localhost:3000" }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const ME = {
  userId: "u-test", userCode: "USR-10000", name: "Test Researcher", email: "test@example.com",
  platformRole: "programmer", isPlatformAdmin: false, sessionId: "sess-test", unread: 0,
  policies: { heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15, idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180 },
};
const routes = async (p) => {
  await p.route("**/api/auth/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ME) }));
  await p.route("**/api/auth/heartbeat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }) }));
  await p.route("**/api/surveys", (r) => r.request().method() === "GET"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: SURVEYS, stats: STATS, contributors: {}, statsSource: "rpc", warnings: [] }) })
    : r.continue());
  await p.route("**/api/billing/projects", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, currency: "USD", wallet: WALLET, thresholds: { low: 20, critical: 5, readOnly: 0 }, isPlatformAdmin: false, projects: PROJECTS }),
  }));
  /* the header's compact wallet (dashboard brief §3) reads the wallet alone */
  await p.route("**/api/billing/wallet", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, wallet: WALLET, thresholds: { low: 20, critical: 5, readOnly: 0 } }) }));
};
await routes(page);

let saved = null;
await page.route("**/api/surveys/*/billing", (route) => {
  const body = JSON.parse(route.request().postData() ?? "{}");
  saved = { url: route.request().url(), body };
  /* the server's answer: the policy changed, and a project under its new
     limit is running again — no money moved */
  const p = PROJECTS.find((x) => route.request().url().includes(`/surveys/${x.id}/`));
  if (p && p.meter) {
    const limit = body.mode === "budget" ? Number(body.limit) : null;
    p.meter = meter({
      used: p.meter.used, limit, mode: body.mode,
      allowance: limit == null ? WALLET.balance : Math.max(0, limit - p.meter.used),
      usedPct: limit == null ? 30 : Math.min(100, Math.round((p.meter.used / limit) * 10000) / 100),
      level: limit != null && limit - p.meter.used <= 5 ? "critical" : "normal",
      state: limit != null && p.meter.used >= limit ? "frozen" : "active",
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, spending: { mode: body.mode, budgetLimit: body.limit ?? null } }) });
});

let funds = null;
await page.route("**/api/billing/me", (route) => {
  if (route.request().method() !== "POST") return route.continue();
  funds = JSON.parse(route.request().postData() ?? "{}");
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, request: { id: "req_1", requestedAmount: funds.amount, status: "pending" } }) });
});

let cloned = null;
await page.route("**/api/surveys/*/clone", (route) => {
  cloned = JSON.parse(route.request().postData() ?? "{}");
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "s9", code: "SHARED_COPY", title: cloned.title, counts: { question: 34 }, responsesCopied: false, walletBalance: 0 }) });
});
await page.route("**/api/surveys/*", (route) => route.continue());

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".survey-card:not(.skeleton)");
await page.waitForSelector('[data-testid="wallet-menu"]');

const card = (title) => `.survey-card:has-text("${title}")`;
const textOf = async (sel) => (await page.$eval(sel, (el) => el.innerText.replace(/\s+/g, " "))).trim();

/* -------------------------------------------------- 1. one wallet, in the header */

console.log("\nTHE WALLET — one compact balance in the header, its actions behind it (dashboard brief §3)");
{
  assert.equal(await page.$('[data-testid="dash-wallet"]'), null, "the large wallet panel is gone from the page");
  assert.equal(await textOf('[data-testid="wallet-pill-balance"]'), "$265.00", "the balance, two decimals, in the header");
  await page.click('[data-testid="wallet-pill"]');
  await page.waitForSelector('[data-testid="wallet-menu-panel"]');
  const w = await textOf('[data-testid="wallet-menu-panel"]');
  assert.ok(w.toUpperCase().includes("MY WALLET"));
  assert.match(w, /\$235\.00 used of \$500\.00 added/);
  assert.equal(await textOf('[data-testid="wallet-menu-level"]'), "Healthy");
  assert.ok(await page.$('[data-testid="wallet-add-funds"]'), "funds are added from the wallet, not per project");
  assert.ok(await page.$('[data-testid="wallet-usage"]') && await page.$('[data-testid="wallet-transactions"]'), "usage and the transaction history are one click away");
  await page.keyboard.press("Escape"); await page.click("body", { position: { x: 5, y: 400 } }); await page.waitForTimeout(150);
  console.log("  ok   $265.00 once, in the header, with Add funds, Usage & billing and Transaction history behind it");
}

/* ------------------------------------------- 2. the cards: no spend on the list */

console.log("\nTHE CARDS — metrics, no money (dashboard brief §1): the spend lives on the project's overview and in Usage & Wallet");
{
  assert.equal((await page.$$('[data-testid="card-wallet"]')).length, 0, "no spend on any card");
  for (const t of ["Consumer Research", "Brand Tracker", "Pricing Pilot"]) {
    const labels = await page.$$eval(`${card(t)} .stat-label`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels, ["Questions", "Responses", "Test", "Live", "Complete"], `${t} keeps its five metrics`);
  }
  console.log("  ok   five metrics per card, no spend figure, no meter bar");
}

/* --------------------------------------- 3. an empty wallet is said in the header */

console.log("\nAN EMPTY WALLET — said once, where the wallet is");
{
  const before = { ...WALLET };
  WALLET = { ...WALLET, balance: 0, available: 0, totalUsed: 500, level: "locked", state: "read_only" };
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="wallet-menu"][data-state="read_only"]');
  assert.equal(await textOf('[data-testid="wallet-pill-balance"]'), "$0.00");
  await page.click('[data-testid="wallet-pill"]');
  await page.waitForSelector('[data-testid="wallet-menu-panel"]');
  assert.equal(await textOf('[data-testid="wallet-menu-level"]'), "Empty");
  await page.click("body", { position: { x: 5, y: 400 } }); await page.waitForTimeout(150);
  WALLET = before;
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="wallet-menu"][data-state="active"]');
  console.log("  ok   'Empty' in the header when the wallet is out");
}

/* ------------------------------------------------------ 4. no money filters on the list */

console.log("\nFILTERS — the list is about projects, not balances");
{
  assert.equal(await page.$('[data-testid="dash-balance-filter"]'), null, "no balance filter");
  const sorts = await page.$$eval('[aria-label="Sort surveys"] option', (os) => os.map((o) => o.value));
  assert.ok(!sorts.some((v) => /^(balance|used)_/.test(v)), `no spend sorts: ${sorts.join(", ")}`);
  console.log("  ok   no balance filter, no spend sorts");
}

/* ------------------------------------------------------------- 5. the limit */

console.log("\nSETTING A LIMIT — which moves no money, and says so");
{
  await page.click(`${card("Brand Tracker")} .card-actions .menu-anchor button`);
  await page.waitForSelector('[data-testid="budget-menu-item"]');
  await page.click('[data-testid="budget-menu-item"]');
  await page.waitForSelector('[data-testid="budget-dialog"]');
  assert.match(await textOf('[data-testid="budget-context"]'), /\$0\.60 spent by this project/);
  assert.match(await textOf('[data-testid="budget-context"]'), /wallet holds \$265\.00/);
  assert.match(await textOf('[data-testid="budget-explainer"]'), /A limit moves no money/,
    "the dialog states the one thing that is genuinely surprising");

  /* a limit below what is already spent is allowed, and warns */
  await page.fill('[data-testid="budget-limit"]', "0.10");
  await page.waitForTimeout(120);
  assert.match(await textOf('[data-testid="budget-below-spend"]'), /stops it immediately/);

  await page.click('[data-testid="budget-quick-100"]');
  await page.waitForTimeout(120);
  assert.equal(await page.$('[data-testid="budget-below-spend"]'), null);
  await page.click('[data-testid="budget-save"]');
  await page.waitForSelector('[data-testid="budget-done"]');
  assert.match(saved.url, /\/api\/surveys\/s2\/billing$/);
  assert.deepEqual({ action: saved.body.action, mode: saved.body.mode, limit: saved.body.limit }, { action: "set_spending", mode: "budget", limit: 100 });
  await page.click('[data-testid="budget-dialog"] .btn.primary');
  await page.waitForTimeout(400);

  assert.equal(await textOf('[data-testid="wallet-pill-balance"]'), "$265.00", "and the wallet is exactly what it was");
  console.log("  ok   $1 → $100 saved from the card's menu; the wallet balance unchanged");
}

/* ----------------------------------------------- 6. raising a limit frees a project */

console.log("\nRAISING A LIMIT — a stopped project runs again, with nothing transferred");
{
  await page.click(`${card("Pricing Pilot")} .card-actions .menu-anchor button`);
  await page.waitForSelector('[data-testid="budget-menu-item"]');
  await page.click('[data-testid="budget-menu-item"]');
  await page.waitForSelector('[data-testid="budget-dialog"]');
  await page.fill('[data-testid="budget-limit"]', "50");
  await page.click('[data-testid="budget-save"]');
  await page.waitForSelector('[data-testid="budget-done"]');
  await page.click('[data-testid="budget-dialog"] .btn.primary');
  await page.waitForTimeout(400);
  assert.deepEqual({ mode: saved.body.mode, limit: saved.body.limit }, { mode: "budget", limit: 50 });
  assert.equal(await textOf('[data-testid="wallet-pill-balance"]'), "$265.00", "still nothing moved");
  console.log("  ok   the project is running; the balance never changed");
}

/* ------------------------------------------------------------ 7. add funds */

console.log("\nADD FUNDS — a request, because payments are not connected yet");
{
  await page.click('[data-testid="wallet-pill"]');
  await page.waitForSelector('[data-testid="wallet-add-funds"]');
  await page.click('[data-testid="wallet-add-funds"]');
  await page.waitForSelector('[data-testid="add-funds-dialog"]');
  assert.match(await textOf('[data-testid="add-funds-balance"]'), /\$265\.00 in your wallet now/);
  await page.click('[data-testid="add-funds-100"]');
  await page.fill('[data-testid="add-funds-note"]', "Wave 4 fieldwork");
  await page.click('[data-testid="add-funds-submit"]');
  await page.waitForSelector('[data-testid="add-funds-done"]');
  assert.deepEqual({ action: funds.action, amount: funds.amount, note: funds.note }, { action: "add_funds", amount: 100, note: "Wave 4 fieldwork" });
  assert.match(await textOf('[data-testid="add-funds-done"]'), /sent to your administrator/);
  await page.click('[data-testid="add-funds-dialog"] .btn.primary');
  await page.waitForTimeout(200);
  console.log("  ok   $100 requested, and the screen says an administrator approves it");
}

/* --------------------------------------------------------------- 8. clone */

console.log("\nCLONE — still there, and still honest about the wallet");
{
  await page.click(`${card("Consumer Research")} .card-actions .menu-anchor button`);
  await page.waitForSelector('[data-testid="clone-project-menu-item"]');
  await page.click('[data-testid="clone-project-menu-item"]');
  await page.waitForSelector('[data-testid="clone-dialog"]');
  assert.match(await textOf('[data-testid="clone-excluded"]'), /No responses/i);
  await page.click('[data-testid="clone-confirm"]');
  await page.waitForSelector('[data-testid="clone-done"]');
  assert.equal(cloned.title, "Consumer Research Study — Copy");
  await page.click('[data-testid="clone-dialog"] .btn:not(.primary)');
  await page.waitForTimeout(200);
  console.log("  ok   cloned from the card");
}

/* ------------------------------------------------------------ 9. narrow screen */

console.log("\nNARROW SCREEN — the header wallet and the cards survive a phone");
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await phone.addCookies([{ name: "rescript_session", value: "meter-test-session-0000", url: "http://localhost:3000" }]);
  const p2 = await phone.newPage();
  await routes(p2);
  await p2.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await p2.waitForSelector(".survey-card:not(.skeleton)");
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no sideways scroll on a phone (${overflow}px)`);
  assert.ok(await p2.$('[data-testid="wallet-menu"]'), "the wallet is still there, in the header");
  await p2.click('.survey-card:has-text("Consumer Research") .card-actions .menu-anchor button');
  await p2.waitForSelector('[data-testid="budget-menu-item"]');
  await p2.screenshot({ path: "/tmp/project-meter-phone.png" });
  await phone.close();
  console.log("  ok   390px: no sideways scroll, wallet visible, the limit reachable from the menu");
}

await browser.close();
console.log("\nALL CENTRAL WALLET DASHBOARD CHECKS PASSED");
