/**
 * DASHBOARD, PROJECT OVERVIEW AND THE COMPACT WALLET (dashboard brief §1–§3).
 *
 *   1. the dashboard: the summary band is two numbers (projects, live); the
 *      cards keep their five metrics and carry no spend; no balance filter or
 *      spend sort; the large wallet panel is gone
 *   2. the wallet: a compact `$125.50` pill in the header beside the account
 *      controls, its menu with Add funds (the page's dialog), Usage & billing,
 *      Transaction history; the precise balance in the title
 *   3. the project overview: the facts, the configuration states from the
 *      fixture (never inferred), the spend distinct from the wallet, the
 *      modules' links, recent activity, the way back
 *   4. the Studio: the Overview link in the top bar; `?tab=` deep links still open the tool
 *
 *   node scripts/dashboard-overview-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const SURVEYS = [
  { id: "11111111-1111-4111-8111-111111111111", code: "ACME-01", title: "Acme brand tracker", status: "live", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-10-09T10:00:00Z", current_version_id: null, created_by: "u1", myRole: "owner", roleSource: "owner", owner: { userId: "u1", name: "Test Researcher", userCode: "USR-10000", isMe: true }, collaborators: 1, version: "3.0", editing: null },
  { id: "22222222-2222-4222-8222-222222222222", code: "DRAFT-02", title: "Pricing study", status: "draft", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-08T10:00:00Z", current_version_id: null, created_by: "u1", myRole: "owner", roleSource: "owner", owner: { userId: "u1", name: "Test Researcher", userCode: "USR-10000", isMe: true }, collaborators: 0, version: "1.0", editing: null },
];
const STATS = {
  [SURVEYS[0].id]: { questionCount: 24, responseCount: 310, testResponseCount: 12, liveResponseCount: 298, completeCount: 240, lastResponseAt: "2026-10-09T09:00:00Z", contributorIds: ["u1"], versionCount: 3 },
  [SURVEYS[1].id]: { questionCount: 8, responseCount: 0, testResponseCount: 0, liveResponseCount: 0, completeCount: 0, lastResponseAt: null, contributorIds: ["u1"], versionCount: 1 },
};
const WALLET = { walletId: "w1", currency: "USD", balance: 125.5, reserved: 0, available: 125.5, totalAdded: 500, totalUsed: 374.5, transferredOut: 0, transferredIn: 0, level: "normal", state: "active" };
const OVERVIEW = {
  ok: true,
  project: { id: SURVEYS[0].id, code: "ACME-01", title: "Acme brand tracker", status: "live", version: "3.0", revision: 41, draftSavedAt: "2026-10-09T10:00:00Z", updatedAt: "2026-10-09T10:00:00Z", createdAt: "2026-09-01T10:00:00Z", locked: false, role: "owner", clientName: "Acme Foods", projectManager: "Ann Lee", fieldworkFrom: "2026-10-01", fieldworkTo: "2026-10-31", dueDate: "2026-11-15", languages: 1, sourceLanguage: "en" },
  counts: { questions: 24, pages: 9, responses: 310, live: 298, test: 12, complete: 240, lastResponseAt: "2026-10-09T09:00:00Z" },
  modules: [
    { key: "programming", label: "Questionnaire", state: "configured", detail: "24 questions · 6 questions with logic", tab: "questions", count: 24 },
    { key: "quotas", label: "Quotas", state: "incomplete", detail: "2 quotas, 4 cells · 120 of 400 live completes · no quota check in the flow yet", tab: "quotas", count: 2 },
    { key: "collection", label: "Response collection", state: "configured", detail: "Live link active · test link active", tab: "versions" },
    { key: "quality", label: "Data quality", state: "not_configured", detail: "Quality checks off — responses are not scored.", tab: "data" },
    { key: "research", label: "Research design", state: "needs_attention", detail: "Objective recorded · 2 hypotheses · 1 construct unmeasured", tab: "settings", count: 2 },
    { key: "analysis", label: "Analysis plan", state: "configured", detail: "3 crosstabs, 2 tests · last run 2026-10-08 on 240 completes", tab: "questions", count: 5 },
    { key: "reporting", label: "Dashboards & reports", state: "configured", detail: "1 dashboard, 1 report", tab: "data", count: 2 },
    { key: "languages", label: "Languages", state: "incomplete", detail: "1 language beside en · 1 not ready", tab: "localization", count: 1 },
    { key: "fieldwork", label: "Fieldwork", state: "configured", detail: "2026-10-01 → 2026-10-31 · 1 sample source", tab: "fieldwork" },
    { key: "project", label: "Project details", state: "configured", detail: "Acme Foods · Ann Lee · due 2026-11-15", tab: "project" },
  ],
  summary: { configured: 6, total: 10, attention: [{ key: "research", label: "Research design", state: "needs_attention", detail: "", tab: "settings" }] },
  spend: { currency: "USD", used: 42.3123, limit: null, allowance: 125.5, mode: "shared", level: "normal", state: "active", events: 57, walletRemaining: 125.5 },
  activity: [
    { id: "a1", text: "Ann Lee changed the status from testing to live", category: "survey", at: "2026-10-09T08:00:00Z", actorName: "Ann Lee" },
    { id: "a2", text: "Test Researcher created quota “Gender”", category: "survey", at: "2026-10-08T08:00:00Z", actorName: "Test Researcher" },
  ],
  warnings: [],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "dashboard-overview-test-0000", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401|400)/.test(m.text())) errors.push(m.text()); });

await page.route("**/api/auth/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ userId: "u1", userCode: "USR-10000", name: "Test Researcher", email: "t@example.com", platformRole: "programmer", isPlatformAdmin: false, sessionId: "sess", unread: 0, policies: { heartbeatSeconds: 300, lockHeartbeatSeconds: 20, presenceHeartbeatSeconds: 15, idleAfterSeconds: 300, staleAfterSeconds: 900, lockStaleAfterSeconds: 180 } }) }));
await page.route("**/api/auth/heartbeat", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "active", alive: true }) }));
await page.route("**/api/surveys", (r) => r.request().method() === "GET" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ surveys: SURVEYS, stats: STATS, contributors: { u1: { id: "u1", name: "Test Researcher", initials: "TR" } }, warnings: [] }) }) : r.continue());
await page.route("**/api/billing/projects", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, currency: "USD", wallet: WALLET, thresholds: { low: 20, critical: 5, readOnly: 0 }, isPlatformAdmin: false, projects: SURVEYS.map((s) => ({ id: s.id, meter: { surveyId: s.id, currency: "USD", used: 42.31, limit: null, mode: "shared", allowance: 125.5, walletRemaining: 125.5, reserved: 0, usedPct: 25, level: "normal", state: "active", events: 57 }, canBudget: true })) }) }));
let walletReads = 0;
/* the wallet the next read returns — switched to a sub-cent balance after a request, so the re-read is visible */
let walletNow = WALLET;
await page.route("**/api/billing/wallet", (r) => { walletReads++; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, wallet: walletNow, thresholds: { low: 20, critical: 5, readOnly: 0 } }) }); });
await page.route("**/api/billing/me", (r) => r.request().method() === "POST" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, request: { id: "cr1", amount: 50, status: "pending" } }) }) : r.continue());
await page.route("**/api/surveys/sandbox/overview", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OVERVIEW) }));

/* ------------------------------------------------ 1. the dashboard */
await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".survey-card");
{
  const metrics = await page.$$eval('[data-testid="dash-metrics"] .metric', (es) => es.map((e) => [e.querySelector(".metric-l").textContent, e.querySelector(".metric-v").textContent]));
  assert.deepEqual(metrics, [["Projects", "2"], ["Live", "1"]], JSON.stringify(metrics));
  assert.equal(await page.$('[data-testid="dash-wallet"]'), null, "the large wallet panel is gone");
  assert.equal((await page.$$('[data-testid="card-wallet"]')).length, 0, "no spend on the cards");
  const labels = await page.$$eval(".survey-card >> nth=0 >> .stat-label", (es) => es.map((e) => e.textContent));
  assert.deepEqual(labels, ["Questions", "Responses", "Test", "Live", "Complete"]);
  assert.equal(await page.$('[data-testid="dash-balance-filter"]'), null, "no balance filter");
  const sorts = await page.$$eval('[aria-label="Sort surveys"] option', (os) => os.map((o) => o.textContent));
  assert.ok(!sorts.some((s) => /spent|spend/i.test(s)), sorts.join(", "));
  assert.match(await page.textContent(".dash-summary"), /^2 projects · 1 live$/);
  const w = await page.$eval("body", (b) => b.scrollWidth <= b.clientWidth + 1);
  assert.ok(w, "no horizontal overflow at 1440");
  ok("the dashboard: two summary numbers, cards with their five metrics and no spend, no balance filter or spend sorts, no wallet panel");
}

/* ------------------------------------------------ 2. the compact wallet in the header */
{
  await page.waitForSelector('[data-testid="wallet-menu"]');
  assert.equal(await page.textContent('[data-testid="wallet-pill-balance"]'), "$125.50", "two decimals on the pill");
  assert.match(await page.getAttribute('[data-testid="wallet-pill"]', "title"), /\$125\.50 available/);
  // beside the account controls: inside the account area, before Profile
  const order = await page.$$eval('[data-testid="dash-account"] > *', (es) => es.map((e) => e.getAttribute("data-testid") || e.textContent.trim().slice(0, 12)));
  assert.equal(order[0], "wallet-menu", order.join(" | "));
  assert.ok(order.includes("Profile") && order.includes("Security"), order.join(" | "));
  await page.click('[data-testid="wallet-pill"]');
  await page.waitForSelector('[data-testid="wallet-menu-panel"]');
  assert.equal(await page.textContent('[data-testid="wallet-menu-balance"]'), "$125.50");
  assert.match(await page.textContent('[data-testid="wallet-menu-panel"]'), /\$374\.50 used of \$500\.00 added/);
  assert.equal(await page.getAttribute('[data-testid="wallet-usage"]', "href"), "/billing");
  assert.equal(await page.getAttribute('[data-testid="wallet-transactions"]', "href"), "/billing#transactions");
  // Add funds opens the dashboard's own dialog; a request re-reads the wallet
  const reads = walletReads;
  walletNow = { ...WALLET, balance: 0.0042, available: 0.0042, level: "critical" };
  await page.click('[data-testid="wallet-add-funds"]');
  await page.waitForSelector('[data-testid="add-funds-dialog"]');
  await page.click('[data-testid="add-funds-submit"]');
  await page.waitForSelector('[data-testid="add-funds-done"]');
  await page.waitForFunction((k) => true, reads);
  await page.waitForTimeout(300);
  assert.ok(walletReads > reads, "the header re-read the wallet after the request");
  // the pill stays concise (two decimals) while the precise balance lives in the title
  await page.waitForFunction(() => document.querySelector('[data-testid="wallet-pill-balance"]')?.textContent === "$0.00");
  assert.match(await page.getAttribute('[data-testid="wallet-pill"]', "title"), /\$0\.0042 available/);
  walletNow = WALLET;
  ok("the wallet: a compact two-decimal pill beside the account controls, the precise balance in its title, a menu with Add funds (the page's dialog), Usage & billing and Transaction history, re-read after a request");
}

/* ------------------------------------------------ 3. the project overview */
{
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="project-overview"][data-loaded="true"]');
  assert.equal(await page.textContent('[data-testid="po-crumb"]'), "Acme brand tracker");
  assert.equal(await page.textContent('[data-testid="po-status"]'), "Live");
  assert.match(await page.textContent('[data-testid="po-meta"]'), /v3\.0 · rev 41 · draft saved .* · Acme Foods · Ann Lee · due 2026-11-15 · you are owner/);
  assert.equal(await page.textContent('[data-testid="po-questions"]'), "24 on 9 pages");
  assert.equal(await page.textContent('[data-testid="po-live"]'), "298");
  assert.equal(await page.textContent('[data-testid="po-test"]'), "12");
  assert.equal(await page.textContent('[data-testid="po-complete"]'), "240");
  // configuration states, exactly as the server said them
  const mods = await page.$$eval('[data-testid="po-module"]', (es) => es.map((e) => [e.getAttribute("data-key"), e.getAttribute("data-state"), e.querySelector(".po-state").textContent]));
  assert.deepEqual(mods.map((m) => m[1]), OVERVIEW.modules.map((m) => m.state));
  assert.deepEqual(mods.find((m) => m[0] === "research").slice(1), ["needs_attention", "Needs attention"]);
  assert.deepEqual(mods.find((m) => m[0] === "quality").slice(1), ["not_configured", "Not set up"]);
  assert.equal(await page.textContent('[data-testid="po-config-summary"]'), "· 6 of 10 configured");
  assert.match(await page.textContent('[data-testid="po-attention"]'), /Needs attention: Research design/);
  assert.equal(await page.getAttribute('[data-testid="po-module"][data-key="quotas"] a', "href"), "/studio/sandbox?tab=quotas");
  // spend: the project's figure, distinct from the wallet
  assert.equal(await page.textContent('[data-testid="po-spend-used"]'), "$42.31");
  assert.match(await page.textContent('[data-testid="po-spend-sub"]'), /No project limit — it spends from the owner's wallet \(\$125\.50 left there\)/);
  assert.equal(await page.textContent('[data-testid="wallet-pill-balance"]'), "$125.50", "the header's wallet is the wallet, not the spend");
  // modules and activity, and the way back
  assert.equal(await page.getAttribute('[data-testid="po-nav-programming"]', "href"), "/studio/sandbox?tab=questions");
  assert.equal(await page.getAttribute('[data-testid="po-nav-analytics"]', "href"), "/analytics?survey=sandbox");
  assert.equal(await page.getAttribute('[data-testid="po-open-programming"]', "href"), "/studio/sandbox?tab=questions");
  assert.equal(await page.getAttribute('[data-testid="po-back"]', "href"), "/");
  const acts = await page.$$eval('[data-testid="po-activity-row"]', (es) => es.map((e) => e.textContent));
  assert.equal(acts.length, 2); assert.match(acts[0], /changed the status from testing to live/);
  assert.equal(await page.getAttribute('[data-testid="po-activity-all"]', "href"), "/studio/sandbox?tab=activity");
  const w = await page.$eval("body", (b) => b.scrollWidth <= b.clientWidth + 1);
  assert.ok(w, "no horizontal overflow at 1440");
  ok("the project overview: the facts, every configuration state as the server read it, the spend distinct from the wallet, the modules' links, the activity, the way back");
}

/* ------------------------------------------------ 4. the Studio keeps its deep links; the dashboard's card opens the bare project URL */
{
  await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".survey-card");
  // the Open button sets window.location to the project's bare URL; the server page is not reachable here (no database), so the destination is read before it loads
  await page.route(`**/studio/${SURVEYS[0].id}`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><body data-testid='stub-overview'>overview</body></html>" }));
  await page.click(".survey-card >> nth=0 >> .card-actions >> text=Open");
  await page.waitForSelector("[data-testid='stub-overview']");
  assert.ok(page.url().endsWith(`/studio/${SURVEYS[0].id}`), `a card opens the project's bare URL (the overview): ${page.url()}`);
  ok("opening a project goes to its bare URL — the overview; `?tab=` deep links keep opening the tool (covered by the Studio suites)");
}

/* ------------------------------------------------ 5. the Studio: the Overview link in the top bar, the project's spend beside Mode */
{
  const studio = await ctx.newPage();
  await studio.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await studio.waitForSelector(".menubar");
  assert.equal(await studio.getAttribute('[data-testid="project-overview-link"]', "href"), "/sandbox/overview", "the top bar leads back to the overview");
  await studio.waitForSelector('[data-testid="project-spend"]', { timeout: 15000 });
  const chip = await studio.textContent('[data-testid="project-spend"]');
  assert.match(chip, /Project spend\s*\$[\d.,]+/, chip);
  // the chip sits after the Mode cluster, inside the menubar; the sandbox's wallet badge is the wallet, a different figure
  const after = await studio.$eval('[data-testid="mode-cluster"]', (e) => e.nextElementSibling?.getAttribute("data-testid"));
  assert.equal(after, "project-spend");
  const bar = await studio.$eval(".menubar", (e) => e.getBoundingClientRect().height);
  assert.ok(bar <= 40, `the menubar stays one line: ${bar}px`);
  await studio.close();
  ok("the Studio: the Overview link in the top bar, and `Project spend: $…` beside Mode on one line");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);
