/**
 * /platform — "AI COST AND CACHE — MEASURED FROM BILLING" AND "INTELLIGENT MODE EVALUATION", in a real browser.
 *
 *   node --experimental-strip-types --no-warnings scripts/ai-eval-platform-test.mjs      (Studio on :3000)
 *
 * The REAL page and panels. The Studio in this container has no database to sign a platform administrator in
 * against, so only the HTTP/auth shell is stood in for, in this process:
 *   · /api/platform          the real answer, with viewer.isPlatformAdmin turned on (the panels are admin-only)
 *   · /api/admin/ai-cache    the REAL report builder (apps/studio/lib/aiCacheReport.ts → @rescript/billing
 *                            cacheReport) over the shape of production's nine split events of 2026-10-17
 *   · /api/admin/ai-eval     the REAL harness: the real /api/copilot/turn handler loaded in this process on the
 *                            FAKE provider (scripts/eval/hooks.mjs), the real runner, the real cap bookkeeping
 * and, unintercepted, the real admin APIs must refuse a visitor without a session.
 *
 * Proves: both panels render for an administrator and not for anyone else; the cache panel shows the measured
 * totals, the saving and the small-sample warning; the eval panel lists ≤10 cases with an estimate, refuses a cap
 * below the estimate, runs the cases one request each with progress, and shows the report (pass rate, cost,
 * latency); the real admin endpoints answer 401 without a session.
 */
import { register } from "node:module";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const ROOT = new URL("..", import.meta.url).pathname;

/* the harness's process: fake provider, no database, the test user only — set BEFORE the route is imported */
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AI_API_KEY"]) delete process.env[k];
Object.assign(process.env, { AI_API_URL: "fake:", EVAL_GUARD_SHIM: "1", EVAL_HARNESS_TOKEN: randomBytes(16).toString("hex"), BILLING_SANDBOX_CREDITS: "100000" });
register(pathToFileURL(`${ROOT}scripts/eval/hooks.mjs`));
const imp = (rel) => import(pathToFileURL(`${ROOT}apps/studio/${rel}`).href);
const { chromium } = await import("./lib/playwright.mjs");
const { POST: turnPOST } = await imp("app/api/copilot/turn/route.ts");
const { NextRequest } = await import(pathToFileURL((await import("node:module")).createRequire(`${ROOT}apps/studio/package.json`).resolve("next/server.js")).href);
const { adminCases } = await imp("lib/eval/cases.ts");
const { inProcessDeps } = await imp("lib/eval/harness.ts");
const { runCase } = await imp("lib/eval/runner.ts");
const { summarize, reportMarkdown } = await imp("lib/eval/report.ts");
const { adminRunStore, estimateCase, mayRunCase, keptResult } = await imp("lib/eval/adminRun.ts");
const { buildCacheReport } = await imp("lib/aiCacheReport.ts");
const { getSandboxMeter } = await imp("lib/metering.ts");

/* ---- the cache report over production-shaped rows (2026-10-17, claude-sonnet-4-6; recorded costs) */
const P = [["09:57:17", "copilot_ux", 12378, 3760, 0, 8633, 0.100009], ["09:57:27", "copilot_ux_repair", 15355, 554, 8633, 0, 0.031066], ["10:02:33", "copilot_ux", 9002, 7005, 8633, 0, 0.108772], ["10:02:43", "copilot_ux_repair", 12649, 447, 8633, 0, 0.021343], ["10:08:52", "copilot_question", 7614, 3467, 0, 4171, 0.077975], ["10:10:17", "copilot_question", 8422, 408, 4171, 0, 0.020124], ["10:11:09", "copilot_question", 8744, 344, 4171, 0, 0.02013], ["10:12:52", "copilot_question", 8428, 583, 4171, 0, 0.022767], ["10:16:10", "copilot_question", 8410, 9041, 4171, 0, 0.149583]];
const rows = P.map(([t, op, i, o, r, w, cost]) => ({ created_at: `2026-10-17T${t}Z`, event_type: "AI_REQUEST", category: "ai", environment: "LIVE", provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", input_units: i, output_units: o, provider_cost: cost, customer_charge: cost * 2.3, metadata: { operation: op, tokens: { input: i, output: o, cachedInput: r, cacheWrite: w, uncachedInput: i - r - w } } }));

/* ---- the eval admin API, served by the real harness */
const store = adminRunStore(null);
const price = (i, o) => (i * 3 + o * 15) / 1e6;
const cases = adminCases();
const token = process.env.EVAL_HARNESS_TOKEN;
async function evalApi(method, body) {
  if (method === "GET") return { ok: true, provider: { configured: true, fake: true, model: "fake", host: null }, pricedModel: "claude-sonnet-4-6", cases: cases.map((c) => ({ id: c.id, title: c.title, category: c.category, turns: c.turns.length, estimateUsd: estimateCase(c, price) })), estimateUsd: cases.reduce((n, c) => n + estimateCase(c, price), 0), capCeilingUsd: 2, durable: false, recent: [] };
  if (body.action === "start") {
    const chosen = cases.filter((c) => body.caseIds.includes(c.id));
    const estimateUsd = chosen.reduce((n, c) => n + estimateCase(c, price), 0);
    if (estimateUsd > body.capUsd) return [409, { error: "The estimate is above the cap." }];
    const run = await store.create({ createdBy: "admin", provider: "fake", model: "fake", caseIds: chosen.map((c) => c.id), capUsd: body.capUsd, estimateUsd });
    return { ok: true, run: { id: run.id, caseIds: run.caseIds, capUsd: run.capUsd, estimateUsd } };
  }
  const run = await store.get(body.runId);
  if (body.action === "case") {
    const c = cases.find((x) => x.id === body.caseId);
    const allowed = mayRunCase(run, c.id, estimateCase(c, price));
    if (!allowed.ok) return [409, { error: allowed.reason, capped: !!allowed.capped }];
    const deps = inProcessDeps({ call: (b, headers) => turnPOST(new NextRequest("http://eval.local/api/copilot/turn", { method: "POST", headers: { ...headers, "x-rescript-eval": token }, body: JSON.stringify({ ...b, surveyId: "sandbox" }) })), store: () => getSandboxMeter().store, fake: true });
    const result = await runCase(c, deps);
    const next = await store.save({ ...run, spentUsd: run.spentUsd + result.costUsd, results: [...run.results, keptResult(result)] });
    return { ok: true, result: keptResult(result), spentUsd: next.spentUsd, capUsd: next.capUsd, status: next.status };
  }
  const report = { meta: { startedAt: run.createdAt, finishedAt: new Date().toISOString(), mode: "fake", provider: "fake", model: "fake", key: "fake:fake", cases: run.results.length }, summary: summarize(run.results), cases: run.results };
  return { ok: true, report, markdown: reportMarkdown(report) };
}

const browser = await chromium.launch();
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const errors = [];
async function pageAs(admin) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/platform", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const j = await res.json().catch(() => ({}));
    if (!res.ok()) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tier: "development", tierDeclared: false, database: null, runtimeUrl: "", studioUrl: null, release: null, node: "", configured: {}, migrations: { applied: [], missing: [], level: null, complete: false, probed: false }, warnings: [], viewer: { isPlatformAdmin: admin, signedIn: admin } }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...j, viewer: { ...(j.viewer ?? {}), isPlatformAdmin: admin, signedIn: admin } }) });
  });
  await page.route("**/api/admin/ai-cache**", async (route) => {
    const report = await buildCacheReport(async (o, l) => rows.slice(o, o + l), { since: "2026-10-17", until: "2026-10-18" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, report }) });
  });
  await page.route("**/api/admin/ai-eval", async (route) => {
    const r = route.request();
    const out = await evalApi(r.method(), r.method() === "POST" ? JSON.parse(r.postData() ?? "{}") : null);
    const [status, body] = Array.isArray(out) ? out : [200, out];
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return page;
}

console.log("\nTHE ADMIN APIS REFUSE A VISITOR WITHOUT A SESSION (real routes)");
{
  const ctx = await browser.newContext();
  for (const path of ["/api/admin/ai-cache?days=7", "/api/admin/ai-eval"]) {
    const r = await ctx.request.get(`${STUDIO}${path}`);
    assert.ok([401, 403].includes(r.status()), `${path} answered ${r.status()}`);
  }
  const p = await ctx.request.post(`${STUDIO}/api/admin/ai-eval`, { data: { action: "start", caseIds: ["edit-required"], capUsd: 1 } });
  assert.ok([401, 403].includes(p.status()), `POST answered ${p.status()}`);
  await ctx.close();
  ok("GET /api/admin/ai-cache, GET and POST /api/admin/ai-eval answer 401/403 without a session");
}

console.log("\nNOT AN ADMINISTRATOR: NO PANELS");
{
  const page = await pageAs(false);
  await page.goto(`${STUDIO}/platform`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="platform-page"]');
  assert.equal(await page.$('[data-testid="platform-ai-cache"]'), null);
  assert.equal(await page.$('[data-testid="platform-ai-eval"]'), null);
  ok("the cache and evaluation panels are not on the page for a non-administrator");
  await page.close();
}

console.log("\nAI COST AND CACHE — MEASURED FROM BILLING");
const page = await pageAs(true);
await page.goto(`${STUDIO}/platform`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="ai-cache-totals"]', { timeout: 20000 });
const cacheText = await page.textContent('[data-testid="platform-ai-cache"]');
assert.match(cacheText, /9 chat calls in the window, 9 with the token split/);
assert.match(await page.textContent('[data-testid="ai-cache-saving"]'), /\$0\.1054 \(16\.0 %\)/);
assert.match(cacheText, /91,002/); assert.match(cacheText, /42,583/);
ok("the totals: 9 calls, 91,002 input tokens, 42,583 read from the cache, $0.1054 (16.0 %) saved");
assert.equal(await page.$$eval('[data-testid="ai-cache-groups"] tbody tr', (r) => r.length), 3);
assert.match(await page.textContent('[data-testid="ai-cache-warnings"]'), /small sample/i);
ok("one row per day × operation × model, and the small-sample warning");

console.log("\nINTELLIGENT MODE EVALUATION");
await page.waitForSelector('[data-testid="ai-eval-run"]');
const rowsShown = await page.$$('[data-testid^="ai-eval-case-"]');
assert.ok(rowsShown.length > 0 && rowsShown.length <= 10, `${rowsShown.length} cases`);
assert.match(await page.textContent('[data-testid="ai-eval-provider"]'), /fake/);
assert.match(await page.textContent('[data-testid="ai-eval-estimate"]'), /Estimate ≤ \$0\.\d{4}/);
ok(`${rowsShown.length} cases (≤10), each with an estimate; the fake provider is named as such`);
await page.fill('[data-testid="ai-eval-cap"]', "0.01");
assert.equal(await page.$eval('[data-testid="ai-eval-run"]', (b) => b.disabled), true);
ok("a cap below the estimate cannot be run");
await page.fill('[data-testid="ai-eval-cap"]', "2");
await page.click('[data-testid="ai-eval-run"]');
await page.waitForSelector('[data-testid="ai-eval-report"]', { timeout: 120000 });
const reportText = await page.textContent('[data-testid="ai-eval-report"]');
assert.match(reportText, /Pass rate 100\.0 %/, reportText.slice(0, 300));
assert.match(await page.textContent('[data-testid="ai-eval-progress"]'), new RegExp(`${rowsShown.length}/${rowsShown.length} done`));
const chips = await page.$$eval('[data-testid^="ai-eval-case-"] .chip', (c) => c.map((x) => x.textContent));
assert.equal(chips.filter((c) => /pass/.test(c)).length, rowsShown.length);
ok("the run goes case by case, every case passes on the fake provider, and the report shows pass rate, cost and latency");
assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
ok("no page error");

await browser.close();
console.log(`\n${pass} checks passed`);
process.exit(0);
