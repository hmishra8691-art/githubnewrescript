/**
 * THE FIVE PLACES AND THE ASK PANEL (Data Analytics audit, Phase 5) — through
 * the real workspace against an in-process fake backend. The fake runs the REAL
 * reading engine for Ask (`proposeFromText`, including the "this" focus the
 * route passes on) and serves a plan run with findings, so what is checked is
 * what the screens do with them.
 *
 *  1. five places in the order a researcher works; Overview first; the active
 *     one is marked for assistive technology
 *  2. every earlier tab is still reachable, now as a view inside its place
 *  3. every earlier link works: ?tab=reports, ?tab=analysis, ?tab=ask, a place
 *     name, and nonsense (which opens Overview)
 *  4. a place remembers the view you were on
 *  5. Ask opens from every place, keeps what you typed while you move, closes
 *     with Escape and its Close button
 *  6. with an analysis open in Explore, "this" means it — and the proposal says
 *     so; with none open (or in another place) "this" is refused, not guessed
 *  7. Findings: the plan run's findings strongest first, hypothesis verdicts, an
 *     analysis opened from a finding, Themes one click away
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/analytics-navigation-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { buildDataset, runAnalysis, adviseChart, proposeFromText, surveyKnownNames } from "../packages/analytics/dist/index.js";
import { def, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";
import { axTab } from "./lib/axNav.mjs";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";
const rows = synthRows(400);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const vars = variableMetadata(def);
const store = { analyses: [], proposeBodies: [] };
const compute = (definition) => { const result = runAnalysis(definition, buildDataset(def, rows, { spec: definition.dataset ?? { environment: "LIVE", dataset: "all" } })); const advice = adviseChart(definition, result, vars); return { ...result, recommendations: advice.alternatives, advice }; };
const mk = (name, kind, variables, extra = {}) => { const id = uid(); const definition = { name, kind, dataset: { environment: "LIVE", dataset: "all" }, variables, ...extra }; const row = { id, survey_id: SURVEY, created_at: now(), updated_at: now(), name, kind, definition, version: 1, position: null }; store.analyses.push(row); return row; };
const sat = mk("Satisfaction overall", "descriptive", ["SAT"]);
const nps = mk("Likelihood to recommend", "descriptive", ["NPS"]);

const finding = (id, strength, headline, a, hyp = []) => ({ id, kind: "difference", strength, significant: strength !== "weak", headline, detail: `${headline} (detail)`, evidence: { n: 400 }, variables: [], hypotheses: hyp, analysis: { name: a.name, kind: a.kind, hash: "h", id: a.id } });
const run = {
  id: uid(), computedAt: now(), trigger: "manual", environment: "LIVE", n: 400, items: 2, warnings: [], discoveries: null, kpis: null, since: null,
  findings: [finding("f1", "weak", "A weak pattern in recommendation", nps), finding("f2", "strong", "Satisfaction differs strongly by region", sat, ["H1"]), finding("f3", "moderate", "Women rate satisfaction a little higher", sat, ["H2"])],
  verdicts: [{ label: "H1", text: "Satisfaction differs by region", verdict: "supported", reason: "One strong significant difference.", findings: [], analyses: 1 }, { label: "H2", text: "Women are more satisfied", verdict: "mixed", reason: "Moderate effect, small base.", findings: [], analyses: 1 }],
};

async function fakeApi(route) {
  const req = route.request(); const url = new URL(req.url()); const m = req.method();
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const [head, itemId, action] = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  if (head === "intelligent" && itemId === "propose") {
    store.proposeBodies.push(body);
    const analyses = store.analyses.map((a) => ({ id: a.id, name: a.name, definition: { ...a.definition, id: a.id, name: a.name } }));
    /* the route: a focus is used only when it is one of this survey's analyses */
    const focus = body.focus?.analysisId && analyses.some((a) => a.id === body.focus.analysisId) ? { analysisId: body.focus.analysisId } : undefined;
    return json(route, { ...proposeFromText(String(body.request ?? ""), { variables: vars, known: surveyKnownNames(def, vars), analyses, reports: [], results: {}, dataset: { environment: "LIVE", dataset: "all" }, ...(focus ? { focus } : {}) }), model: { status: "not_asked", detail: "" } });
  }
  if (head === "variables") return json(route, { variables: vars.filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: 3 });
  if (head === "home") return json(route, { analyses: store.analyses, charts: [], reports: [], shares: [] });
  if (head === "plan") return json(route, { plan: null, planHash: null, planUpdatedAt: null, planSource: null, definition: { source: "draft", revision: 3, version: "1.0", draftUpdatedAt: null }, survey: { objective: null, hypotheses: [] }, dataset: { environment: "LIVE", dataset: "all" }, counts: { LIVE: 400, TEST: 0 }, items: [], variables: [], overview: { hypotheses: 0, invalid: 0, stale: 0, configured: 0, charts: 0 }, hypotheses: [], trace: null, run, apply: null, applyAvailable: true, dataChangedSinceApply: false, report: null, dashboard: null });
  if (head === "run") return json(route, { result: compute(body.definition) });
  if (head === "report-templates") return json(route, { templates: [], available: true });
  if (action === "versions") return json(route, { versions: [] });
  if (m === "GET" && !itemId) return json(route, { items: head === "analyses" ? store.analyses : [] });
  if (m === "GET") return json(route, { item: head === "analyses" ? store.analyses.find((a) => a.id === itemId) : null });
  return json(route, { error: `fake backend: unhandled ${m} ${url.pathname}` }, 404);
}

const browser = await chromium.launch();
const ctxB = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctxB.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctxB.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); console.error("PAGE ERROR:", e.message); });
page.on("dialog", (d) => d.accept());
const user = { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } };
await page.route("**/api/auth/me", (r) => json(r, user));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/notifications**", (r) => json(r, { items: [], unread: 0 }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, fakeApi);
await page.route(`**/api/surveys/${SURVEY}/analytics`, fakeApi);

const count = (sel) => page.$$eval(sel, (es) => es.length);
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const open = async (query = "") => { await page.goto(`${STUDIO}/analytics${query}`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ax-workspace"]'); };
const placeOn = () => page.$eval('[data-testid^="ax-place-"][aria-current="page"]', (e) => e.getAttribute("data-testid").replace("ax-place-", ""));
const viewOn = () => page.$eval('.ax-ws-tabs [role="tab"][aria-selected="true"]', (e) => e.getAttribute("data-testid").replace("ax-tab-", "")).catch(() => null);

console.log("\n§1 FIVE PLACES");
await open();
assert.deepEqual(await page.$$eval('[data-testid^="ax-place-"]', (es) => es.map((e) => e.getAttribute("data-testid").replace("ax-place-", ""))), ["overview", "plan", "explore", "findings", "deliver"]);
assert.equal(await placeOn(), "overview");
assert.equal(await count('[data-testid^="ax-place-"][aria-current="page"]'), 1);
assert.equal(await count('.ax-ws-tabs [role="tab"]'), 0, "Overview is one view, so there is no second row of tabs");
assert.deepEqual(await page.$$eval('[data-testid^="ax-place-"]', (es) => es.map((e) => e.title.endsWith("?"))), [true, true, true, true, true]);
ok("Overview, Plan, Explore, Findings, Deliver — in that order, Overview first, each with the question it answers, the current one marked");

console.log("\n§2 EVERY EARLIER TAB, NOW A VIEW IN ITS PLACE");
const views = { explore: ["analysis", "tables", "charts", "segments", "filters"], findings: ["findings", "themes"], deliver: ["reports", "exports", "sharing"] };
for (const [pl, vs] of Object.entries(views)) {
  await page.click(`[data-testid="ax-place-${pl}"]`);
  assert.equal(await placeOn(), pl);
  assert.deepEqual(await page.$$eval('.ax-ws-tabs [role="tab"]', (es) => es.map((e) => e.getAttribute("data-testid").replace("ax-tab-", ""))), vs);
  for (const v of vs) { await page.click(`[data-testid="ax-tab-${v}"]`); assert.equal(await viewOn(), v); assert.equal(await placeOn(), pl); }
}
await axTab(page, "plan"); assert.equal(await placeOn(), "plan"); await page.waitForSelector('[data-testid="ap-root"], [data-testid="ap-no-plan"], .ax-panel, .ax-empty').catch(() => {});
await axTab(page, "home"); assert.equal(await placeOn(), "overview"); await page.waitForSelector('[data-testid="ax-home"]');
ok("Analysis, Tables, Charts, Segments, Filters under Explore; Findings and Themes under Findings; Reports, Exports, Sharing under Deliver; Home is Overview, the analysis plan is Plan — ten views and Ask, none lost");

console.log("\n§3 EVERY EARLIER LINK");
const cases = [["?tab=reports", "deliver", "reports"], ["?tab=analysis", "explore", "analysis"], ["?tab=sharing", "deliver", "sharing"], ["?tab=themes", "findings", "themes"], ["?tab=plan", "plan", null], ["?tab=home", "overview", null], ["?tab=deliver", "deliver", "reports"], ["?tab=explore", "explore", "analysis"], ["?tab=garbage", "overview", null]];
for (const [q, pl, v] of cases) { await open(q); assert.equal(await placeOn(), pl, q); assert.equal(await viewOn(), v, q); }
await open("?tab=ask");
assert.equal(await placeOn(), "overview");
assert.ok(await page.isVisible('[data-testid="ax-ask-drawer"]'), "?tab=ask opens the Ask panel");
ok("?tab=reports/analysis/sharing/themes/plan/home still land on their view; a place name opens its first view; ?tab=ask opens the panel; nonsense opens Overview");

console.log("\n§4 A PLACE REMEMBERS ITS VIEW");
await open();
await axTab(page, "sharing"); await axTab(page, "home"); await page.click('[data-testid="ax-place-deliver"]');
assert.equal(await viewOn(), "sharing");
await axTab(page, "charts"); await page.click('[data-testid="ax-place-findings"]'); await page.click('[data-testid="ax-place-explore"]');
assert.equal(await viewOn(), "charts");
ok("going back to Deliver lands on Sharing, back to Explore on Charts — where you were");

console.log("\n§5 ASK, FROM EVERY PLACE");
await open();
assert.equal(await page.isVisible('[data-testid="ax-ask-drawer"]'), false);
assert.equal(await page.$eval('[data-testid="ax-ask-open"]', (e) => e.getAttribute("aria-expanded")), "false");
for (const pl of ["overview", "plan", "explore", "findings", "deliver"]) {
  await page.click(`[data-testid="ax-place-${pl}"]`);
  if (!(await page.isVisible('[data-testid="ax-ask-drawer"]'))) await page.click('[data-testid="ax-ask-open"]');
  await page.waitForSelector('[data-testid="ax-ask-input"]');
  assert.match(await text('[data-testid="ax-ask-drawer"] .ax-ask-drawer-head'), new RegExp(`on ${pl[0].toUpperCase()}${pl.slice(1)}`), pl);
}
ok("the Ask button opens the panel on all five places, and the panel says which place it is on");
await page.fill('[data-testid="ax-ask-input"]', "Create cross-tabs of satisfaction by gender");
await page.click('[data-testid="ax-place-overview"]');
assert.equal(await page.inputValue('[data-testid="ax-ask-input"]'), "Create cross-tabs of satisfaction by gender");
await page.click('[data-testid="ax-ask-propose"]');
await page.waitForSelector('[data-testid="ax-ask-review"]');
await page.click('[data-testid="ax-place-plan"]');
assert.ok(await page.isVisible('[data-testid="ax-ask-review"]'), "the proposal is still on screen after moving");
ok("what you typed and the proposal you are reviewing stay put while you move between places");
await page.focus('[data-testid="ax-ask-input"]');
await page.keyboard.press("Escape");
assert.equal(await page.isVisible('[data-testid="ax-ask-drawer"]'), false);
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "ax-ask-open", "the keyboard goes back to the Ask button");
await page.click('[data-testid="ax-ask-open"]'); assert.ok(await page.isVisible('[data-testid="ax-ask-review"]'), "reopened, the proposal is still there");
await page.click('[data-testid="ax-ask-close"]'); assert.equal(await page.isVisible('[data-testid="ax-ask-drawer"]'), false);
ok("Escape and Close put it away; opening it again finds the proposal where it was left");

console.log("\n§6 'THIS' IS THE ANALYSIS THAT IS OPEN");
await open();
await page.click('[data-testid="ax-ask-open"]');
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "ax-ask-input", "opening the panel puts the cursor in the question box");
assert.equal(await page.getAttribute('[data-testid="ax-ask-focus"]', "data-open"), "0");
await page.fill('[data-testid="ax-ask-input"]', "Cross-tab this by gender"); await page.click('[data-testid="ax-ask-propose"]'); await page.waitForSelector('[data-testid="ax-ask-review"]');
assert.equal(await count('[data-testid="ax-ask-item"]'), 0);
assert.match(await text('[data-testid="ax-ask-unread"]'), /none is open/);
assert.equal(store.proposeBodies.at(-1).focus, undefined, "nothing is sent as the focus when nothing is open");
ok("with nothing open, “this” is refused with what to do — nothing is guessed");
await page.click('[data-testid="ax-ask-close"]');
await axTab(page, "analysis");
await page.click(`[data-testid="ax-rail-item"][data-id="${sat.id}"]`);
await page.waitForSelector('[data-testid="ax-builder"]');
await page.click('[data-testid="ax-ask-open"]');
assert.equal(await page.getAttribute('[data-testid="ax-ask-focus"]', "data-open"), "1");
assert.match(await text('[data-testid="ax-ask-focus"]'), /Looking at Satisfaction overall/);
await page.fill('[data-testid="ax-ask-input"]', "Cross-tab this by gender"); await page.click('[data-testid="ax-ask-propose"]');
await page.waitForSelector('[data-testid="ax-ask-item"]');
assert.equal(store.proposeBodies.at(-1).focus.analysisId, sat.id);
assert.match(await text('[data-testid="ax-ask-item"] b'), /SAT|satisf/i);
assert.equal(await page.getAttribute('[data-testid="ax-ask-item"]', "data-op"), "add_crosstab");
assert.match(await text('[data-testid="ax-ask-review"]'), /“this” was read as “Satisfaction overall” \(SAT\), the analysis open in Explore/);
assert.equal(await page.getAttribute('[data-testid="ax-ask-status"]', "data-x").catch(() => null), null);
assert.match(await text('[data-testid="ax-ask-status"]'), /Proposed — not applied/);
ok("with Satisfaction open, “Cross-tab this by gender” proposes that cross-tab, says how “this” was read, and applies nothing");
await page.click('[data-testid="ax-place-deliver"]');
assert.equal(await page.getAttribute('[data-testid="ax-ask-focus"]', "data-open"), "0", "in Deliver there is no open analysis to mean");
await page.fill('[data-testid="ax-ask-input"]', "Test whether this differs by region"); await page.click('[data-testid="ax-ask-propose"]');
await page.waitForSelector('[data-testid="ax-ask-unread"]');
assert.equal(store.proposeBodies.at(-1).focus, undefined);
ok("move to Deliver and “this” has nothing to mean again — the selection belongs to Explore");
await page.click('[data-testid="ax-ask-close"]');

console.log("\n§7 FINDINGS");
await open();
await page.click('[data-testid="ax-place-findings"]');
await page.waitForSelector('[data-testid="ax-finding"]');
assert.deepEqual(await page.$$eval('[data-testid="ax-finding"]', (es) => es.map((e) => e.getAttribute("data-strength"))), ["strong", "moderate", "weak"]);
assert.match(await text('[data-testid="ax-findings-basis"]'), /400 responses · 2 analyses/);
assert.deepEqual(await page.$$eval('[data-testid="ax-verdict-word"]', (es) => es.map((e) => e.textContent)), ["Supported", "Mixed"]);
ok("the run's findings come strongest first with their base, and each hypothesis shows the verdict it reached");
await page.click('[data-testid="ax-finding"]:first-child [data-testid="ax-finding-open"]');
await page.waitForSelector('[data-testid="ax-builder"]');
assert.equal(await placeOn(), "explore");
assert.match(await text('[data-testid="ax-rail-item"].on'), /Satisfaction overall/);
ok("“Open analysis” on a finding takes you to the analysis it came from, in Explore");
await axTab(page, "findings"); await page.click('[data-testid="ax-findings-themes"]');
assert.equal(await viewOn(), "themes");
ok("open-text themes are one click from the findings");

assert.deepEqual(pageErrors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} checks passed`);
