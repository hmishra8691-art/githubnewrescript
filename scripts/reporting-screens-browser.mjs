/**
 * THE NEW ANALYTICS SCREENS IN A BROWSER (Level 5 screens 2026-11-22): "why this number" on a table cell, the tab
 * book, and the three simulators — against a fake backend computed with the real engine over 400 synthetic
 * respondents (the same fixture as analytics-audit-test). Needs the Studio running (STUDIO_URL, default
 * http://localhost:3000). Exit code 1 on any failure.
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { adviseChart, autoTabPlan, buildDataset, runAnalysis, runTabPlan, turfPortfolio } from "../packages/analytics/dist/index.js";
import { def, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";
import { axTab } from "./lib/axNav.mjs";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";
const SHOTS = process.env.SHOTS ?? null;
const rows = synthRows(400);
const ds = buildDataset(def, rows, { spec: { environment: "LIVE", dataset: "all" } });
const now = () => new Date().toISOString();
const analyses = [
  { id: "a-xt", name: "Satisfaction by region", kind: "crosstab", definition: { kind: "crosstab", name: "Satisfaction by region", variables: [], rows: ["SAT"], columns: ["REGION"], dataset: { environment: "LIVE", dataset: "all" }, options: {} } },
  { id: "a-md", name: "Feature MaxDiff", kind: "maxdiff", definition: { kind: "maxdiff", name: "Feature MaxDiff", variables: ["MD"], dataset: { environment: "LIVE", dataset: "all" }, options: {} } },
  { id: "a-pr", name: "Price sensitivity", kind: "pricing", definition: { kind: "pricing", name: "Price sensitivity", variables: ["P_CHEAP", "P_BARGAIN", "P_EXP", "P_TOOEXP"], dataset: { environment: "LIVE", dataset: "all" }, options: {} } },
].map((a) => ({ ...a, survey_id: SURVEY, created_at: now(), updated_at: now(), version: 1 }));
const compute = (d) => { const r = runAnalysis(d, buildDataset(def, rows, { spec: d.dataset ?? { environment: "LIVE", dataset: "all" } })); const advice = adviseChart(d, r, variableMetadata(def)); return { ...r, recommendations: advice.alternatives, advice }; };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const calls = { tabPlan: 0, turf: 0 };

async function fakeApi(route) {
  const req = route.request(); const url = new URL(req.url());
  const body = req.method() === "POST" || req.method() === "PUT" ? JSON.parse(req.postData() || "{}") : {};
  const [head, itemId] = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  if (head === "variables") return json(route, { variables: variableMetadata(def).filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: 3 });
  if (head === "home") return json(route, { analyses, charts: [], reports: [], shares: [] });
  if (head === "run") return json(route, { result: compute(body.definition) });
  if (head === "analyses" && itemId) return json(route, { item: analyses.find((a) => a.id === itemId) });
  if (head === "analyses") return json(route, { items: analyses });
  if (head === "report-templates") return json(route, { templates: [], available: true });
  if (["charts", "segments", "themes", "reports", "shares", "plan", "runs", "overview", "catalogue", "findings"].includes(head ?? "")) return json(route, { items: [], analyses: [], runs: [] });
  return json(route, { items: [] });
}
async function fakeTools(route) {
  const body = JSON.parse(route.request().postData() || "{}");
  if (body.tool === "tab_plan") {
    calls.tabPlan++;
    const plan = autoTabPlan(ds, { columns: body.banner.columns }, { name: "Synthetic — tables" });
    const run = runTabPlan(plan, ds);
    if (body.format === "xlsx") return route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers: { "content-disposition": 'attachment; filename="tab_book.xlsx"' }, body: Buffer.from("PK fake") });
    return json(route, { plan, problems: run.problems, respondents: ds.cases.length, tables: run.tables.map((t) => ({ id: t.id, number: t.number, title: t.title, kind: t.kind, base: t.base, warnings: t.warnings, table: t.table })) });
  }
  calls.turf++;
  const r = turfPortfolio(ds, body.battery, body.portfolio);
  return "error" in r ? json(route, { error: r.error }, 400) : json(route, r);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/auth/me", (r) => json(r, { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route(`**/api/surveys/${SURVEY}/analytics-tools`, fakeTools);
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, fakeApi);
await page.route(`**/api/surveys/${SURVEY}/analytics`, fakeApi);

try {
  await page.goto(`${STUDIO}/analytics?survey=${SURVEY}&tab=tables`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="ax-workspace"]', { timeout: 60_000 });

  /* 1 — why this number */
  await axTab(page, "tables");
  await page.locator('[data-testid="ax-table-card-open"]').first().click();
  const cell = page.locator('[data-testid="ax-builder-table"] [data-testid="ax-why-cell"]').nth(5);
  await cell.click();
  const why = page.locator('[data-testid="ax-why"]');
  await why.waitFor({ timeout: 15_000 });
  const whyText = await why.innerText();
  assert.match(whyText, /Why/);
  assert.match(whyText, /Base:/);
  assert.match(whyText, /Computed by engine/);
  const sentence = whyText.split("\n").find((l) => /respondents in/.test(l)) ?? "";
  assert.match(sentence, /^\d+ of the \d+ respondents in “/, sentence);
  ok(`why this number opens under the table: “${sentence.slice(0, 110)}”`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/why.png`, fullPage: false });
  await page.getByRole("button", { name: "Close the explanation" }).click();
  assert.equal(await why.count(), 0);
  ok("the explanation closes");

  /* 2 — tab book */
  await axTab(page, "tabbook");
  await page.locator('[data-testid="ax-tabbook-banner"] button', { hasText: /region/i }).first().click();
  await page.click('[data-testid="ax-tabbook-run"]');
  await page.locator('[data-testid="ax-tabbook-table"]').waitFor({ timeout: 30_000 });
  const listed = await page.locator(".ax-tabbook-list li").count();
  assert.ok(listed >= 5, `tables listed: ${listed}`);
  assert.equal(calls.tabPlan, 1);
  await page.locator(".ax-tabbook-list li button").nth(2).click();
  assert.ok((await page.locator('[data-testid="ax-tabbook-table"] table').count()) >= 1);
  ok(`the tab book runs: ${listed} tables listed, a table opens beside the list`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tabbook.png`, fullPage: false });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-tabbook-xlsx"]')]);
  assert.match(dl.suggestedFilename(), /tab_book\.xlsx$/);
  ok("the tab book downloads as a workbook");

  /* 3 — simulators */
  await axTab(page, "simulators");
  const md = page.locator('[data-testid="ax-sim-maxdiff"]');
  await md.locator("table").waitFor({ timeout: 30_000 });
  const shares = await md.locator("tbody tr td.num").allInnerTexts();
  const total = shares.reduce((s, x) => s + Number(x.replace("%", "")), 0);
  assert.ok(shares.length >= 2 && Math.abs(total - 100) < 0.6, `MaxDiff shares ${shares.join(", ")} sum ${total}`);
  ok(`MaxDiff shares for the chosen set sum to 100% (${shares.join(", ")})`);
  const turf = page.locator('[data-testid="ax-sim-turf"]');
  await turf.locator(".ax-chip").first().click();
  await turf.locator(".ax-chip").nth(1).click();
  await turf.getByText(/reached \(at least one item chosen\)/).waitFor({ timeout: 15_000 });
  assert.equal(calls.turf, 2);
  ok(`TURF: ${(await turf.getByText(/reached/).innerText()).slice(0, 90)}`);
  const price = page.locator('[data-testid="ax-sim-price"]');
  await price.locator('input[aria-label="Price"]').fill("15");
  await price.getByText(/too cheap|would buy/).first().waitFor({ timeout: 15_000 });
  ok(`price what-if: ${(await price.getByText(/too cheap|would buy/).first().innerText()).slice(0, 110)}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/simulators.png`, fullPage: true });

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  ok("no page errors");
  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("FAIL", e.message);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true });
  process.exitCode = 1;
} finally { await browser.close(); }
