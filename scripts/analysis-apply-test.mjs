/**
 * THE APPLY AUDIT (2026-10-17) — browser checks that every analysis configuration
 * exposes and enables Apply exactly when it can be applied, and says what is
 * missing when it cannot.
 *
 *   §1 the builder: one readiness rule (`analysisReadiness`) drives Run — a
 *      correlation of one variable is disabled and names the second variable;
 *      adding it enables Run, which runs and renders; a test of one variable
 *      says how to get a one-sample test; weighting by rim targets alone and a
 *      crosstab with rows and columns are enabled
 *   §2 results refresh after a change without a reload; a failed run shows its
 *      error and Run retries
 *   §3 the plan editor refuses exactly what the apply would skip, naming the role
 *   §4 Apply analysis plan: runs once (a double click is one apply), the outcome
 *      and the lists refresh
 *   §5 a CUSTOM member with Data Analytics: Edit sees the workspace and Apply;
 *      with View only, no Apply; with None, the reason
 *
 * The analytics API is the REAL plan service (`apps/studio/lib/analysisPlanCore.ts`)
 * over the in-memory store, as in analysis-plan-test.mjs; the run branch applies the
 * same readiness rule as the route (422 with what is missing).
 *
 *   node --experimental-strip-types --no-warnings scripts/analysis-apply-test.mjs   (studio on 3000)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { buildDataset, runPlan, compactRun, runAnalysis, recommendCharts, variableMetadata, plannedAnalyses, analysisReadiness } from "../packages/analytics/dist/index.js";
import { def as baseDef, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { customCapabilities, capabilitiesOf } from "../packages/access/dist/index.js";
import { FakeDb, uuid, stamp } from "./lib/fakeSupabase.mjs";
import { applyPlan, editPlan, planPayload } from "../apps/studio/lib/analysisPlanCore.ts";
import { axTab } from "./lib/axNav.mjs";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "33333333-3333-4333-8333-333333333333";

function planned() {
  const d = structuredClone(baseDef);
  d.research = {
    objective: "What drives satisfaction", hypotheses: ["Region affects satisfaction"], population: "adults",
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Region", role: "independent", questionIds: ["q_region"] }],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: { source: "engine", updatedAt: "2026-10-10T08:00:00Z",
      crosstabs: [{ id: "xt_1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by profile" }],
      tests: [{ id: "t_1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"], reason: "satisfaction across regions" }],
      derived: [], segments: [] },
  };
  return SurveyDefinition.parse(d);
}

const db = new FakeDb();
db.tables.surveys.push({ id: SURVEY, title: "Apply Study", revision: 1, draft_definition: JSON.parse(JSON.stringify(planned())), current_version_id: null });
const rows = synthRows(300);
for (const r of rows) db.tables.responses.push({ id: r.id ?? uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null });
const ctxOf = () => { const s = db.tables.surveys[0]; return { def: SurveyDefinition.parse(s.draft_definition), version: "1.0", revision: Number(s.revision), customerId: null, versionId: null, source: "draft", draftUpdatedAt: null }; };
const deps = {
  latestRun: async () => null,
  runPlanFor: async (_db, surveyId, ctx, o) => {
    const spec = { environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all" };
    const ds = buildDataset(ctx.def, rows, { spec });
    const run = runPlan(ctx.def, ds, { items: plannedAnalyses(ctx.def, spec).filter((p) => !o.exclude?.has(String(p.definition.options?.planned))), trigger: o.trigger ?? "manual" });
    const compact = compactRun(run);
    const row = { id: uuid(), survey_id: surveyId, trigger: run.trigger, environment: run.environment, n: run.n, dataset: spec, computed_at: run.computedAt, items: compact.items, findings: compact.findings, verdicts: compact.verdicts, warnings: compact.warnings };
    db.tables.analytics_runs.push(row);
    return { run, stored: { ...compact, id: row.id, surveyVersion: "1.0", dataset: spec } };
  },
  reportFacts: async () => ({}),
};

/* what the access route answers, switched per section */
let member = { role: "owner", capabilities: capabilitiesOf("owner") };
let failNextRun = false;
let applyCalls = 0;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const COLL = { analyses: "analytics_analyses", charts: "analytics_charts", segments: "analytics_segments", themes: "analytics_themes", reports: "analytics_reports", shares: "analytics_shares" };

async function fakeApi(route) {
  const req = route.request(); const url = new URL(req.url()); const m = req.method();
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const [head, itemId, action] = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  const ctx = ctxOf();
  try {
    if (head === "access") return json(route, member);
    if (head === "plan" && !itemId && m === "GET") return json(route, await planPayload(db, SURVEY, ctx, { environment: url.searchParams.get("environment") ?? "LIVE", dataset: "all" }, deps));
    if (head === "plan" && !itemId && m === "PUT") { const r = await editPlan(db, SURVEY, ctx, { actions: body.actions, baseRevision: body.baseRevision ?? null, userId: "u1" }); return json(route, r.ok ? r : { error: r.error, results: r.results ?? [] }, r.ok ? 200 : r.status); }
    if (head === "plan" && itemId === "apply" && m === "POST") {
      if (!member.capabilities.includes("analytics.edit")) return json(route, { error: "forbidden" }, 403);
      applyCalls++;
      const r = await applyPlan(db, SURVEY, ctx, { dataset: { environment: "LIVE", dataset: "all" }, userId: "u1", replaceReport: false }, deps);
      return json(route, r.ok ? r : { error: r.error, warnings: r.warnings ?? [] }, r.ok ? 200 : r.status);
    }
    if (head === "variables") return json(route, { variables: variableMetadata(ctx.def).filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: ctx.revision });
    if (head === "home") { const t = (k) => db.tables[k].filter((r) => r.survey_id === SURVEY && !r.deleted_at); return json(route, { analyses: t("analytics_analyses"), charts: t("analytics_charts"), reports: t("analytics_reports"), shares: [] }); }
    if (head === "run") {
      /* the route's rule, verbatim: an incomplete definition is refused with what is missing */
      const d = body.definition;
      const ready = analysisReadiness({ ...d, variables: Array.isArray(d.variables) ? d.variables : [] });
      if (!ready.ready) return json(route, { error: ready.missing.join(" "), code: "incomplete_definition", missing: ready.missing }, 422);
      if (failNextRun) { failNextRun = false; return json(route, { error: "The analysis could not be computed (ref test01)." }, 500); }
      const ds = buildDataset(ctx.def, rows, { spec: d.dataset ?? { environment: "LIVE", dataset: "all" } });
      const result = runAnalysis({ ...d, name: d.name || d.kind }, ds);
      return json(route, { result: { ...result, recommendations: recommendCharts(result) } });
    }
    if (head === "report-templates") return json(route, { templates: [], available: true });
    if (head in COLL) {
      const table = db.tables[COLL[head]];
      if (!itemId && m === "GET") return json(route, { items: table.filter((r) => r.survey_id === SURVEY && !r.deleted_at) });
      if (!itemId && m === "POST") { const row = { id: uuid(), survey_id: SURVEY, created_at: stamp(), updated_at: stamp(), version: 1, name: body.name ?? body.definition?.name, kind: body.definition?.kind, definition: body.definition, ...body }; table.push(row); return json(route, { item: row }, 201); }
      const row = table.find((r) => r.id === itemId);
      if (!row) return json(route, { error: "Unknown item." }, 404);
      if (action === "versions") return json(route, { versions: [] });
      if (m === "GET") return json(route, { item: row });
      if (m === "PUT") { Object.assign(row, body, { version: (row.version ?? 1) + 1, updated_at: stamp() }); return json(route, { item: row }); }
      if (m === "DELETE") { row.deleted_at = stamp(); return json(route, { ok: true }); }
    }
    return json(route, { error: `fake backend: unhandled ${m} ${url.pathname}` }, 404);
  } catch (e) { console.error("FAKE API ERROR", m, url.pathname, e); return json(route, { error: e.message }, 500); }
}

const browser = await chromium.launch();
const ctxB = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctxB.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctxB.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept());
let myRole = "owner";
await page.route("**/api/auth/me", (r) => json(r, { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/notifications**", (r) => json(r, { items: [], unread: 0 }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "APP", title: "Apply Study", status: "live", myRole, roleSource: "member", updated_at: stamp(), version: "1.0" }] }));
await page.route("**/api/surveys/*/analytics/**", fakeApi);
await page.route("**/api/surveys/*/analytics?*", fakeApi);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const open = async (tab = "analysis") => { await page.goto(`${STUDIO}/analytics?survey=${SURVEY}&tab=${tab}`, { waitUntil: "networkidle" }); };
const newAnalysis = async (kind) => {
  await axTab(page, "analysis");
  await page.click('[data-testid="ax-rail-new"]');
  await page.waitForSelector('[data-testid="ax-builder"]');
  await page.click(`[data-testid="ax-kind-${kind}"]`);
  await page.click('[data-testid="ax-step-1"]');
};
const tick = (meta) => page.click(`.ax-var:has-text("${meta}") input`);
const runState = () => page.getAttribute('[data-testid="ax-run"]', "data-ready");

console.log("\n§1 THE BUILDER — one rule enables Run, and says what is missing");
await open();
await page.waitForSelector('[data-testid="ax-workspace"]', { timeout: 60000 });
await newAnalysis("correlation");
await tick("SAT · Scale");
assert.equal(await runState(), "0");
assert.equal(await page.$eval('[data-testid="ax-run"]', (e) => e.disabled), true);
assert.match(await text('[data-testid="ax-run-missing"]'), /Correlation needs at least two numeric or scale variables — add a second variable/);
ok("a correlation of one variable: Run disabled, and the footer names the missing second variable");
await tick("AGE · Numeric");
assert.equal(await runState(), "1");
assert.equal(await page.$('[data-testid="ax-run-missing"]'), null);
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-result"]');
ok("adding AGE enables Run; it runs and the result renders");

await newAnalysis("test");
await tick("SAT · Scale");
assert.equal(await runState(), "0");
assert.match(await text('[data-testid="ax-run-missing"]'), /one variable is not enough.*one-sample test in Options/);
ok("a significance test of one variable says to add the grouping, or choose a one-sample test");

await newAnalysis("weighting");
assert.equal(await runState(), "0");
assert.match(await text('[data-testid="ax-run-missing"]'), /Weighting needs rim targets or a weight variable/);
await page.click('[data-testid="ax-step-3"]');
await page.selectOption('[data-testid="ax-weighting"] select >> nth=1', "GENDER");
assert.equal(await runState(), "1", "rim targets alone are a complete weighting analysis (the old rule wanted variables)");
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-result"]');
ok("weighting by rim targets alone: Run enabled (it was disabled before), runs, renders");

await newAnalysis("crosstab");
await tick("SAT · Scale");
assert.equal(await runState(), "0");
assert.match(await text('[data-testid="ax-run-missing"]'), /row variable and one column variable/);
await tick("GENDER · Categorical");
assert.equal(await runState(), "1");
ok("a crosstab: rows only is disabled with the reason; rows and columns enable Run");

console.log("\n§2 REFRESH AND RETRY — results follow the definition without a reload; a failure can be retried");
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-result"]');
await page.click('[data-testid="ax-stage-builder"]');
await page.click('[data-testid="ax-step-1"]');
await page.click('[data-testid="ax-xt-target-columns"]');
await tick("REGION · Categorical");
await page.click('[data-testid="ax-step-5"]');
await page.waitForSelector('[data-testid="ax-stale"]');
failNextRun = true;
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-error"]');
assert.match(await text('[data-testid="ax-error"]'), /could not be computed \(ref test01\)/);
assert.equal(await page.$eval('[data-testid="ax-run"]', (e) => e.disabled), false, "Run is not stuck after a failure");
await page.click('[data-testid="ax-run"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="ax-stale"]') && !document.querySelector('[data-testid="ax-error"]'));
assert.match(await text('[data-testid="ax-result"]'), /Region|REGION/);
ok("a changed definition marks the result out of date; a failed run shows its error, Run stays enabled, the retry lands and the result refreshes in place");

console.log("\n§3 THE PLAN EDITOR — refuses exactly what the apply would skip");
await axTab(page, "plan");
await page.waitForSelector('[data-testid="ap-workspace"]');
await page.click('[data-testid="ap-section-tests"]');
await page.click('[data-testid="ap-add-test"]');
await page.waitForSelector('[data-testid="ap-editor"]');
await page.selectOption('[data-testid="ap-ed-method"]', "anova");
await page.selectOption('[data-testid="ap-ed-outcome"]', "SAT");
assert.equal(await page.getAttribute('[data-testid="ap-ed-save"]', "data-ready"), "0");
const before = ctxOf().def.research.analysisPlan.tests.length;
await page.click('[data-testid="ap-ed-save"]');
await page.waitForSelector('[data-testid="ap-ed-error"]');
assert.match(await text('[data-testid="ap-ed-error"]'), /An ANOVA compares groups — choose the grouping variable/);
assert.equal(ctxOf().def.research.analysisPlan.tests.length, before, "nothing saved");
await page.selectOption('[data-testid="ap-ed-groupby"]', "COUNTRY");
assert.equal(await page.getAttribute('[data-testid="ap-ed-save"]', "data-ready"), "1");
await page.click('[data-testid="ap-ed-save"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="ap-editor"]'));
assert.equal(ctxOf().def.research.analysisPlan.tests.length, before + 1);
ok("an ANOVA without a grouping is refused in the editor with the role it needs; with it, it is saved to the plan");

console.log("\n§4 APPLY THE PLAN — once, with its outcome, and the lists refresh");
applyCalls = 0;
await page.evaluate(() => { const b = document.querySelector('[data-testid="ap-apply"]'); b.click(); b.click(); });
await page.waitForSelector('[data-testid="ap-outcome"]', { timeout: 60000 });
assert.equal(applyCalls, 1, `a double click applied ${applyCalls} times`);
assert.ok(db.tables.analytics_analyses.filter((a) => a.survey_id === SURVEY && a.definition?.options?.planned).length >= 2, "the planned analyses exist");
assert.doesNotMatch(await text('[data-testid="ap-outcome"]'), /skipped \(invalid\)/, "nothing the editor accepted is skipped as invalid");
assert.equal(await page.$eval('[data-testid="ap-apply"]', (e) => e.disabled), false, "Apply is enabled again afterwards");
ok("Apply analysis plan runs once for a double click, reports its outcome, skips nothing the editor accepted, and is enabled again");

console.log("\n§5 CUSTOM ACCESS — the membership's capabilities, not the bare role");
myRole = "custom";
member = { role: "custom", capabilities: [...customCapabilities({ v: 1, modules: { analytics: "edit", programming: "view" } })] };
await open("plan");
await page.waitForSelector('[data-testid="ap-workspace"]');
assert.ok(await page.$('[data-testid="ap-apply"]'), "Apply is shown to a custom member with Data Analytics: Edit");
assert.ok(await page.$('[data-testid="ap-readonly"]'), "and the plan says it cannot be edited (Programming: View)");
ok("a custom member with Data Analytics: Edit sees the workspace and Apply (the page used to answer from the role's floor: no access)");
member = { role: "custom", capabilities: [...customCapabilities({ v: 1, modules: { analytics: "view", programming: "view" } })] };
await open("plan");
await page.waitForSelector('[data-testid="ap-workspace"]');
assert.equal(await page.$('[data-testid="ap-apply"]'), null);
member = { role: "custom", capabilities: [...customCapabilities({ v: 1, modules: { analytics: "none", programming: "view" } })] };
await open("plan");
await page.waitForSelector('[data-testid="ax-no-access"]');
assert.match(await text('[data-testid="ax-no-access"]'), /does not include analytics access/);
ok("Data Analytics: View reads without Apply; None is told why");

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
