/**
 * THE ANALYSIS PLAN IN DATA ANALYTICS — browser checks, end to end.
 *
 * The Studio dev server has no database here, so the analytics API is
 * served by the REAL service (`apps/studio/lib/analysisPlanCore.ts`: the
 * payload, the editor, the apply) running INSIDE this test process over the
 * in-memory supabase (`scripts/lib/fakeSupabase.mjs`) and the real engine
 * (`@rescript/analytics`: dataset → runPlan → findings) on the synthetic
 * fixture. The generic collection endpoints (analyses, charts, reports…)
 * are served over the same store, so what the plan writes is what the
 * Reports and Charts tabs then show. What this proves: the workspace drives
 * the service correctly, and the service drives the engine; what it cannot
 * prove is the SQL — the migration is exercised against the live database.
 *
 * Needs `pnpm dev:studio` (3000).
 *   node --experimental-strip-types --no-warnings scripts/analysis-plan-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { buildDataset, runPlan, compactRun, runAnalysis, recommendCharts, variableMetadata, plannedAnalyses } from "../packages/analytics/dist/index.js";
import { def as baseDef, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { FakeDb, uuid, stamp } from "./lib/fakeSupabase.mjs";
import { applyPlan, editPlan, planPayload } from "../apps/studio/lib/analysisPlanCore.ts";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";
const EMPTY = "22222222-2222-4222-8222-222222222222";
const now = () => new Date().toISOString();

/* ------------------------------------------------------------ the survey, with a plan the engine would write */
function planned() {
  const d = structuredClone(baseDef);
  d.research = {
    objective: "What drives satisfaction", hypotheses: ["Region affects satisfaction", "Awareness of Alpha raises consideration"], population: "adults",
    constructs: [
      { name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Region", role: "independent", questionIds: ["q_region"] },
      { name: "Awareness of Alpha", role: "independent", questionIds: ["q_brands"] }, { name: "Consideration", role: "dependent", questionIds: ["q_consider"] },
    ],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      source: "engine", updatedAt: "2026-10-10T08:00:00Z",
      crosstabs: [
        { id: "xt_1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by profile" },
        { id: "xt_2", rows: ["CONSIDER"], columns: ["AWARE"], priority: 2, hypotheses: ["H2"] },
        { id: "xt_3", rows: ["SAT"], columns: ["GONE_VAR"], priority: 3, hypotheses: [], reason: "an item whose variable was deleted" },
      ],
      tests: [
        { id: "t_1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"], reason: "satisfaction across regions" },
        { id: "t_2", method: "chi_square", outcome: "CONSIDER", variables: ["AWARE"], priority: 1, hypotheses: ["H2"] },
        { id: "t_3", method: "nps", variables: ["NPS"], priority: 2, hypotheses: [] },
      ],
      derived: [{ name: "SAT_TOP", kind: "top_box", from: ["SAT"] }], segments: [],
    },
  };
  return SurveyDefinition.parse(d);
}

/* ------------------------------------------------------------ the store, the real service over it */
const db = new FakeDb();
db.tables.surveys.push({ id: SURVEY, title: "Synthetic Study 2026", revision: 3, draft_definition: JSON.parse(JSON.stringify(planned())), current_version_id: null, fieldwork_from: "2026-09-01", fieldwork_to: "2026-10-31", client_name: "Acme" });
db.tables.surveys.push({ id: EMPTY, title: "Unplanned Study", revision: 1, draft_definition: JSON.parse(JSON.stringify({ ...baseDef, research: undefined })), current_version_id: null });
const rows = synthRows(400);
for (const r of rows) db.tables.responses.push({ id: r.id ?? uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null });
const ctxOf = (surveyId) => { const s = db.tables.surveys.find((x) => x.id === surveyId); return { def: SurveyDefinition.parse(s.draft_definition), version: "1.0", revision: Number(s.revision), customerId: null, versionId: null, source: "draft", draftUpdatedAt: null }; };
const compute = (definition, ds) => { const result = runAnalysis(definition, ds ?? buildDataset(ctxOf(SURVEY).def, rows, { spec: definition.dataset ?? { environment: "LIVE", dataset: "all" } })); return { ...result, recommendations: recommendCharts(result) }; };

/* the real runner shape over the store: a dataset from the synthetic rows, the real runPlan, the compact run stored */
const deps = {
  latestRun: async (_db, surveyId, environment) => {
    const list = db.tables.analytics_runs.filter((r) => r.survey_id === surveyId && (!environment || r.environment === environment)).sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
    const r = list[0]; if (!r) return null;
    return { id: r.id, computedAt: r.computed_at, trigger: r.trigger, environment: r.environment, n: r.n, items: r.items, findings: r.findings, verdicts: r.verdicts, warnings: r.warnings, discoveries: r.discoveries, kpis: r.kpis, surveyVersion: null, dataset: r.dataset };
  },
  runPlanFor: async (_db, surveyId, ctx, o) => {
    const spec = { environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all" };
    const mine = spec.environment === "TEST" ? [] : rows;
    const ds = buildDataset(ctx.def, mine, { spec });
    const planned = plannedAnalyses(ctx.def, spec).filter((p) => !o.exclude?.has(String(p.definition.options?.planned)));
    const saved = db.tables.analytics_analyses.filter((a) => a.survey_id === surveyId && !a.deleted_at);
    const items = planned.map((p) => { const s = saved.find((a) => a.definition?.options?.planned === p.definition.options?.planned); return s ? { ...p, definition: { ...s.definition, id: s.id, dataset: spec } } : p; });
    const run = runPlan(ctx.def, ds, { items, trigger: o.trigger ?? "manual" });
    if (o.skipEmpty && run.n === 0) return { run, stored: null };
    const compact = compactRun(run);
    const row = { id: uuid(), survey_id: surveyId, trigger: run.trigger, environment: run.environment, n: run.n, dataset: spec, computed_at: run.computedAt, items: compact.items, findings: compact.findings, verdicts: compact.verdicts, warnings: compact.warnings, discoveries: compact.discoveries ?? null, kpis: compact.kpis ?? null };
    db.tables.analytics_runs.push(row);
    return { run, stored: { ...compact, id: row.id, surveyVersion: "1.0", dataset: spec } };
  },
  reportFacts: async () => ({ client: "Acme", fieldwork: { from: "2026-09-01", to: "2026-10-31" } }),
};

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const COLL = { analyses: "analytics_analyses", charts: "analytics_charts", segments: "analytics_segments", themes: "analytics_themes", reports: "analytics_reports", shares: "analytics_shares" };

async function fakeApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = req.method();
  const surveyId = url.pathname.match(/\/api\/surveys\/([^/]+)\/analytics/)[1];
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const path = url.pathname.replace(`/api/surveys/${surveyId}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  const [head, itemId, action] = path;
  const ctx = ctxOf(surveyId);
  try {
    /* THE PLAN — the real service */
    if (head === "plan" && !itemId && m === "GET") {
      const dataset = { environment: url.searchParams.get("environment") ?? "LIVE", dataset: url.searchParams.get("dataset") === "clean" ? "clean" : "all" };
      return json(route, await planPayload(db, surveyId, ctx, dataset, deps));
    }
    if (head === "plan" && !itemId && m === "PUT") {
      const r = await editPlan(db, surveyId, ctx, { actions: body.actions, baseRevision: typeof body.baseRevision === "number" ? body.baseRevision : null, userId: "u1" });
      if (!r.ok) return json(route, { error: r.error, results: r.results ?? [], ...(r.conflict ? { conflict: true, revision: r.revision } : {}) }, r.status);
      return json(route, r);
    }
    if (head === "plan" && itemId === "apply" && m === "POST") {
      const r = await applyPlan(db, surveyId, ctx, { dataset: { environment: body.environment ?? "LIVE", dataset: body.dataset === "clean" ? "clean" : "all" }, userId: "u1", replaceReport: body.replaceReport === true }, deps);
      if (!r.ok) return json(route, { error: r.error, warnings: r.warnings ?? [] }, r.status);
      return json(route, r);
    }
    /* the rest of the workspace over the same store */
    const live = db.tables.responses.filter((r) => r.survey_id === surveyId).length;
    if (head === "variables") return json(route, { variables: variableMetadata(ctx.def).filter((v) => !v.hidden), counts: { LIVE: live, TEST: 0 }, surveyVersion: "1.0", revision: ctx.revision });
    if (head === "home") { const t = (k) => db.tables[k].filter((r) => r.survey_id === surveyId && !r.deleted_at); return json(route, { analyses: t("analytics_analyses"), charts: t("analytics_charts"), reports: t("analytics_reports"), shares: [] }); }
    if (head === "run") { try { const d = body.definition; const ds = buildDataset(ctx.def, d.dataset?.environment === "TEST" ? [] : rows, { spec: d.dataset ?? { environment: "LIVE", dataset: "all" } }); return json(route, { result: compute({ ...d, name: d.name || d.kind }, ds) }); } catch (e) { return json(route, { error: e.message }, 500); } }
    if (head === "reports" && itemId && action === "results") {
      const r = db.tables.analytics_reports.find((x) => x.id === itemId);
      const ids = new Set(); for (const b of r.definition.blocks ?? []) { if (b.analysisId) ids.add(b.analysisId); for (const id of b.analysisIds ?? []) ids.add(id); } for (const w of r.definition.widgets ?? []) if (w.analysisId) ids.add(w.analysisId);
      const results = {}; for (const id of ids) { const a = db.tables.analytics_analyses.find((x) => x.id === id && !x.deleted_at); if (a) results[id] = compute({ ...a.definition, id, name: a.name }); }
      return json(route, { mode: "live", definition: r.definition, theme: null, results, computedAt: now() });
    }
    if (head === "report-templates") return json(route, { templates: [], available: true });
    if (head in COLL) {
      const table = db.tables[COLL[head]];
      if (!itemId && m === "GET") return json(route, { items: table.filter((r) => r.survey_id === surveyId && !r.deleted_at).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) });
      if (!itemId && m === "POST") {
        const row = { id: uuid(), survey_id: surveyId, created_at: stamp(), updated_at: stamp(), version: 1, ...(head === "analyses" ? { name: body.name ?? body.definition?.name, kind: body.definition?.kind, definition: { ...body.definition, name: body.name ?? body.definition?.name }, folder: body.folder ?? null, tags: body.tags ?? [] } : head === "charts" ? { analysis_id: body.analysisId, name: body.name ?? "Chart", spec: body.spec, theme_id: body.themeId ?? null, style_version: 1 } : head === "reports" ? { kind: body.kind === "dashboard" ? "dashboard" : "report", name: body.name, definition: body.definition ?? { title: body.name, mode: "live", blocks: [] }, mode: "live", theme_id: null } : { ...body }) };
        table.push(row); return json(route, { item: row }, 201);
      }
      const row = table.find((r) => r.id === itemId && !r.deleted_at);
      if (!row) return json(route, { error: "Unknown item." }, 404);
      if (action === "versions") return json(route, { versions: db.tables.analytics_analysis_versions.filter((v) => v.analysis_id === itemId).sort((a, b) => b.version - a.version) });
      if (m === "GET") return json(route, { item: row });
      if (m === "PUT") { if (head === "analyses" && body.definition) { row.definition = { ...body.definition, name: body.name ?? row.name }; row.version = (row.version ?? 1) + 1; } if (body.name) row.name = body.name; if (head === "reports" && body.definition) row.definition = body.definition; if (head === "charts" && body.spec) { row.spec = body.spec; row.style_version = (row.style_version ?? 1) + 1; } row.updated_at = stamp(); return json(route, { item: row }); }
      if (m === "DELETE") { row.deleted_at = stamp(); return json(route, { ok: true }); }
    }
    return json(route, { error: `fake backend: unhandled ${m} ${url.pathname}` }, 404);
  } catch (e) {
    console.error("FAKE API ERROR", m, url.pathname, e);
    return json(route, { error: e.message }, 500);
  }
}

/* ------------------------------------------------------------ browser */
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
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }, { id: EMPTY, code: "EMP", title: "Unplanned Study", status: "draft", myRole: "owner", roleSource: "owner", updated_at: now(), version: null }] }));
await page.route("**/api/surveys/*/analytics/**", fakeApi);
await page.route("**/api/surveys/*/analytics", fakeApi);
await page.route("**/api/surveys/*/analytics?*", fakeApi);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const count = (sel) => page.$$eval(sel, (es) => es.length);
const shot = async (name) => { if (process.env.AP_SHOTS) await page.screenshot({ path: `${process.env.AP_SHOTS}/${name}.png`, fullPage: true }); };
const waitNotice = async (re) => { await page.waitForFunction((src) => { const n = document.querySelector('[data-testid="ap-notice"]'); return n && new RegExp(src).test(n.textContent); }, re.source, { timeout: 30000 }); return text('[data-testid="ap-notice"]'); };
const waitOutcome = async (re) => { await page.waitForFunction((src) => { const n = document.querySelector('[data-testid="ap-outcome"]'); return n && new RegExp(src).test(n.textContent); }, re.source, { timeout: 30000 }); return text('[data-testid="ap-outcome"]'); };
const openPlan = async (survey = SURVEY) => { await page.goto(`${STUDIO}/analytics?survey=${survey}&tab=plan`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ap-workspace"], [data-testid="ap-none"]'); };
const plan = () => ctxOf(SURVEY).def.research.analysisPlan;
const analyses = () => db.tables.analytics_analyses.filter((a) => a.survey_id === SURVEY && !a.deleted_at);
const charts = () => db.tables.analytics_charts.filter((a) => a.survey_id === SURVEY && !a.deleted_at);
const reports = () => db.tables.analytics_reports.filter((a) => a.survey_id === SURVEY && !a.deleted_at);

console.log("\n§1 THE PLAN LOADS IN DATA ANALYTICS, AND MATCHES WHAT INTELLIGENT MODE HOLDS");
await openPlan();
assert.equal(await count('[data-testid="ap-workspace"]'), 1);
assert.match(await text('[data-testid="ap-name"]'), /What drives satisfaction — analysis plan/);
assert.match(await text('[data-testid="ap-status"]'), /not applied/i);
assert.match(await text('[data-testid="ap-meta"]'), /3 crosstabs, 3 tests, 1 derived variable/);
ok("the Analysis plan tab shows the survey's plan by name, with its status (saved, not applied) and its make-up");
assert.equal(await text('[data-testid="ap-kpi-items"] .metric-v'), "6");
assert.equal(await text('[data-testid="ap-kpi-hypotheses"] .metric-v'), "2");
assert.equal(await text('[data-testid="ap-kpi-attention"] .metric-v'), "1");
assert.match(await text('[data-testid="ap-attention"]'), /GONE_VAR/);
ok("overview counts come from the plan (6 planned, 2 hypotheses) and the item reading a deleted variable needs attention");
await page.click('[data-testid="ap-section-crosstabs"]');
assert.equal(await count('[data-testid="ap-crosstab"]'), plan().crosstabs.length);
assert.deepEqual(await page.$$eval('[data-testid="ap-crosstab"]', (es) => es.map((e) => e.dataset.id)), plan().crosstabs.map((x) => x.id));
assert.equal(await page.$eval('[data-testid="ap-crosstab"][data-id="xt_3"]', (e) => e.dataset.state), "invalid");
await page.click('[data-testid="ap-section-tests"]');
assert.equal(await count('[data-testid="ap-test"]'), plan().tests.length);
ok("every planned crosstab and test is listed, in the plan's order, with the same ids Intelligent mode holds");
await page.click('[data-testid="ap-section-hypotheses"]');
assert.equal(await count('[data-testid="ap-hyp"]'), 2);
assert.match(await text('[data-testid="ap-hyp"]'), /H1.*Region affects satisfaction.*Testable/);
assert.equal(await count('[data-testid="ap-hyp-verdict"]'), 0, "no verdict before a run");
ok("hypotheses are listed with their coverage and the items that serve them — and no verdict is invented before a run");
await page.click('[data-testid="ap-section-variables"]');
assert.ok((await count('[data-testid="ap-variable"]')) >= 6);
assert.equal(await page.$eval('[data-testid="ap-variable"]:first-child', (e) => e.dataset.kind), "missing");
assert.match(await text('[data-testid="ap-var-warning"]'), /Not in this survey's data/);
assert.equal(await count('[data-testid="ap-var-resolve"]'), 1);
ok("variables show their source question, type, categories and uses; the missing one leads with a warning and a Resolve action");
await shot("01-plan-overview");

console.log("\n§2 EDIT A CROSSTAB AND SAVE — the id survives, the survey draft holds it");
await page.click('[data-testid="ap-section-crosstabs"]');
await page.click('[data-testid="ap-crosstab"][data-id="xt_1"] [data-testid="ap-item-edit"]');
await page.waitForSelector('[data-testid="ap-editor"]');
await page.selectOption('[data-testid="ap-ed-columns-add"]', "COUNTRY");
await page.selectOption('[data-testid="ap-ed-measure"]', "mean");
await page.click('[data-testid="ap-ed-save"]');
assert.match(await waitNotice(/saved to the survey \(revision 4\)/), /Changed satisfaction by profile/);
const x1 = plan().crosstabs.find((x) => x.id === "xt_1");
assert.deepEqual(x1.columns, ["GENDER", "REGION", "COUNTRY"]); assert.equal(x1.measure, "mean");
assert.equal(db.tables.surveys[0].revision, 4);
ok("the edit is an engine action saved to the draft definition through the revision guard: xt_1 keeps its id, gains a column and a measure, revision 3 → 4");
assert.match(await text('[data-testid="ap-crosstab"][data-id="xt_1"]'), /GENDER, REGION, COUNTRY · Means/);
ok("the list shows the saved edit, from the server's plan");
/* a refused edit: the same variable on both sides */
await page.click('[data-testid="ap-crosstab"][data-id="xt_2"] [data-testid="ap-item-edit"]');
await page.waitForSelector('[data-testid="ap-editor"]');
await page.selectOption('[data-testid="ap-ed-rows-add"]', "AWARE");
await page.click('[data-testid="ap-ed-save"]');
await page.waitForSelector('[data-testid="ap-ed-error"]');
assert.match(await text('[data-testid="ap-ed-error"]'), /cannot be both a row and a column/);
await page.click('[data-testid="ap-ed-cancel"]');
ok("validation in the editor refuses a crosstab of a variable against itself; Cancel leaves the plan as it was");

console.log("\n§3 APPLY THE PLAN — analyses, run, charts, dashboard, report; the invalid item is skipped and named");
assert.equal(analyses().length, 0);
await page.click('[data-testid="ap-apply"]');
const n1 = await waitOutcome(/planned analyses/);
assert.match(n1, /6 planned analyses — 5 created, 1 skipped \(invalid\)\. 5 run on 400 completes, 5 charts/);
assert.equal(analyses().length, 5); assert.equal(charts().length, 5);
assert.equal(reports().filter((r) => r.kind === "dashboard").length, 1); assert.equal(reports().filter((r) => r.kind === "report").length, 1);
assert.equal(db.tables.analytics_runs.length, 1); assert.equal(db.tables.analytics_plan_applies.length, 1); assert.equal(db.tables.analytics_plan_applies[0].status, "partial");
ok("apply created 5 analyses (one per valid planned item), 5 charts, the dashboard and the findings report, ran on 400 completes, and recorded itself");
await page.waitForFunction(() => /Applied/.test(document.querySelector('[data-testid="ap-status"]')?.textContent ?? ""));
assert.match(await text('[data-testid="ap-status"]'), /Applied · some analyses failed/);
assert.match(await text('[data-testid="ap-outcome"]'), /Skipped.*an item whose variable was deleted/);
ok("the status says applied with one analysis skipped, and the outcome names it with a way to fix it");
await page.click('[data-testid="ap-section-crosstabs"]');
assert.equal(await page.$eval('[data-testid="ap-crosstab"][data-id="xt_1"] [data-testid="ap-item-state"]', (e) => e.textContent), "Configured");
await page.click('[data-testid="ap-crosstab"][data-id="xt_1"] .ap-item-row');
await page.waitForSelector('[data-testid="ap-item-detail"]');
assert.match(await text('[data-testid="ap-item-detail"]'), /Saved analysis.*satisfaction by profile · v1/);
await page.click('[data-testid="ap-item-preview"]');
await page.waitForSelector('[data-testid="ap-item-table"]');
assert.ok((await count('[data-testid="ap-item-table"] table tr')) > 2);
ok("a configured crosstab opens to its saved analysis and previews the real table from the responses");
await shot("02-applied");

console.log("\n§4 CHARTS, INSIGHTS, REPORTS AND DASHBOARDS COME FROM THE APPLIED PLAN");
await page.click('[data-testid="ap-section-charts"]');
await page.waitForSelector('[data-testid="ap-chart-card"] svg', { timeout: 30000 });
assert.equal(await count('[data-testid="ap-chart-card"]'), 5);
ok("the Charts section draws the five planned analyses on real data");
await page.click('[data-testid="ap-section-insights"]');
await page.waitForSelector('[data-testid="ap-insights"]');
assert.equal(await count('[data-testid="ap-verdict"]'), 2);
assert.ok((await count('[data-testid="ap-finding"]')) >= 1);
assert.match(await text('[data-testid="ap-insights-note"]'), /computed by the engine.*Nothing here is written by a language model/);
ok("Themes & insights shows the run's hypothesis verdicts and findings, each traced to its planned analysis, and says plainly that none of it is model-written");
await page.click('[data-testid="ap-section-reports"]');
await page.waitForSelector('[data-testid="ap-report"]');
assert.ok((await count('[data-testid="ap-report-components"] tbody tr')) > 5);
assert.ok((await count('[data-testid="ap-report-components"] tbody tr[data-planned="xt_1"]')) >= 1);
ok("the findings report exists, linked to its analyses, and the Reports section says which planned item each block came from");
await page.click('[data-testid="ap-section-dashboards"]');
await page.waitForSelector('[data-testid="ap-dashboard"]');
assert.deepEqual(await page.$$eval('[data-testid="ap-dashboard-components"] tbody tr', (es) => es.map((e) => e.dataset.planned)), ["", "xt_1", "t_1", "t_2", "xt_2", "t_3"]);
ok("the dashboard has a summary widget and one chart widget per applied analysis, hypothesis-linked first");
await page.click('[data-testid="ax-tab-reports"]');
await page.waitForSelector('[data-testid="ax-reports"], .ax-panel');
assert.ok((await page.content()).includes("What drives satisfaction — findings"), "the plan's report is in the Reports tab");
ok("the Reports tab of the workspace lists the plan's findings report");
await page.click('[data-testid="ax-tab-charts"]');
await page.waitForSelector('[data-testid="ax-charts"]');
assert.equal(await count('[data-testid="ax-chart-card"]'), 5);
ok("the Charts tab lists the five saved charts the apply made");

console.log("\n§5 REOPEN — the plan, the edits and the apply persist; applying again creates nothing");
await openPlan();
assert.match(await text('[data-testid="ap-status"]'), /Applied/);
await page.click('[data-testid="ap-section-crosstabs"]');
assert.match(await text('[data-testid="ap-crosstab"][data-id="xt_1"]'), /GENDER, REGION, COUNTRY · Means.*Configured/);
ok("after a reload the edited crosstab and the applied state are still there — read from the stores, not the browser");
await page.click('[data-testid="ap-apply"]');
assert.match(await waitOutcome(/planned analyses/), /6 planned analyses — 1 skipped \(invalid\)\. 5 run on 400 completes, 5 charts/);
assert.equal(analyses().length, 5); assert.equal(charts().length, 5); assert.equal(reports().length, 2);
assert.equal(db.tables.analytics_analysis_versions.length, 5, "no new analysis version when nothing changed");
ok("applying the unchanged plan again creates no analysis, chart, report or dashboard — the planned id is the identity");

console.log("\n§6 A CHANGE MADE ELSEWHERE (Intelligent mode) REACHES DATA ANALYTICS AFTER REFRESH, AND APPLY UPDATES IN PLACE");
{
  const s = db.tables.surveys[0];
  const d = structuredClone(s.draft_definition);
  d.research.analysisPlan.tests.find((t) => t.id === "t_1").method = "kruskal_wallis";
  d.research.analysisPlan.updatedAt = stamp();
  s.draft_definition = d; s.revision += 1;
}
await page.click('[data-testid="ap-refresh"]');
await page.waitForFunction(() => /Changed since applied/.test(document.querySelector('[data-testid="ap-status"]')?.textContent ?? ""));
await page.click('[data-testid="ap-section-tests"]');
assert.equal(await page.$eval('[data-testid="ap-test"][data-id="t_1"]', (e) => e.dataset.state), "stale");
assert.match(await text('[data-testid="ap-test"][data-id="t_1"]'), /kruskal wallis.*Changed — apply to update/);
ok("a test re-planned in Intelligent mode shows as changed here after Refresh, and the plan as changed since it was applied");
const before = analyses().find((a) => a.definition.options.planned === "t_1");
await page.click('[data-testid="ap-apply"]');
assert.match(await waitOutcome(/planned analyses/), /1 updated from the plan/);
const after = analyses().find((a) => a.definition.options.planned === "t_1");
assert.equal(after.id, before.id); assert.equal(after.version, 2); assert.equal(after.definition.options.test, "kruskal_wallis");
assert.equal(analyses().length, 5);
ok("apply updated that analysis in place — same id, version 2, the new method — and created nothing");

console.log("\n§7 ADD AND REMOVE ITEMS — downstream outputs follow");
await page.click('[data-testid="ap-add-test"]');
await page.waitForSelector('[data-testid="ap-editor"][data-kind="test"]');
await page.selectOption('[data-testid="ap-ed-method"]', "t_test");
await page.selectOption('[data-testid="ap-ed-outcome"]', "SAT");
await page.selectOption('[data-testid="ap-ed-groupby"]', "GENDER");
await page.click('[data-testid="ap-ed-hypotheses"] label:first-child');
await page.fill('[data-testid="ap-ed-reason"]', "satisfaction by gender");
await page.click('[data-testid="ap-ed-save"]');
await waitNotice(/Planned t test — saved/);
assert.equal(plan().tests.length, 4);
const added = plan().tests.find((t) => t.reason === "satisfaction by gender");
assert.equal(added.method, "t_test"); assert.equal(added.groupBy, "GENDER"); assert.deepEqual(added.hypotheses, ["H1"]);
ok("a test added here is in the survey's plan with the method, outcome, grouping and hypothesis chosen");
await page.click('[data-testid="ap-test"][data-id="t_3"] [data-testid="ap-item-remove"]');
await waitNotice(/Removed/);
assert.ok(!plan().tests.some((t) => t.id === "t_3"));
ok("removing a test (confirmed) takes it out of the plan");
await page.click('[data-testid="ap-apply"]');
assert.match(await waitOutcome(/planned analyses/), /1 created/);
const dash = reports().find((r) => r.kind === "dashboard").definition;
assert.ok(dash.widgets.some((w) => w.id === `plan:${added.id}`), "the new item has a widget");
assert.ok(!dash.widgets.some((w) => w.id === "plan:t_3"), "the removed item's widget is gone");
assert.equal(analyses().length, 6, "the removed item's saved analysis stays in the rail");
ok("after apply the dashboard gained a widget for the new test and lost the removed one; the removed item's analysis is kept");
/* reorder: the move is saved as the plan's order */
await page.click('[data-testid="ap-test"]:nth-child(2) [data-testid="ap-item-up"]');
await waitNotice(/Reordered/);
assert.equal(plan().tests[0].id, "t_2");
ok("moving an item up saves the plan's order");

console.log("\n§8 PARTIAL FAILURE AND RETRY — fix the invalid variable here, apply again");
await page.click('[data-testid="ap-section-variables"]');
await page.click('[data-testid="ap-var-resolve"]');
await page.waitForSelector('[data-testid="ap-editor"]');
await page.click('[data-testid="ap-ed-columns"] .ax-pill button');
await page.selectOption('[data-testid="ap-ed-columns-add"]', "REGION");
await page.click('[data-testid="ap-ed-save"]');
await waitNotice(/Changed an item whose variable was deleted/);
assert.deepEqual(plan().crosstabs.find((x) => x.id === "xt_3").columns, ["REGION"]);
assert.equal(await page.$eval('[data-testid="ap-crosstab"][data-id="xt_3"]', (e) => e.dataset.state), "planned");
ok("Resolve opens the item that reads the missing variable; replacing the column makes it valid again");
await page.click('[data-testid="ap-apply"]');
assert.match(await waitOutcome(/planned analyses/), /1 created.*6 run on 400 completes/);
await page.waitForFunction(() => /^Applied$/.test(document.querySelector('[data-testid="ap-status"]')?.textContent?.trim() ?? ""));
await page.click('[data-testid="ap-section-overview"]');
assert.equal(await text('[data-testid="ap-kpi-attention"] .metric-v'), "0");
ok("the retried apply runs every item — status Applied, nothing needing attention");

console.log("\n§9 NO DATA — outputs are configured, nothing is computed, nothing is faked");
await page.selectOption('[data-testid="ax-dataset"]', "TEST");
await page.waitForFunction(() => /Waiting for data|no data|not applied/i.test(document.querySelector('[data-testid="ap-workspace"]')?.textContent ?? ""));
await page.click('[data-testid="ap-section-charts"]');
await page.waitForSelector('[data-testid="ap-charts-pending"]');
assert.match(await text('[data-testid="ap-charts-pending"]'), /Waiting for data.*no complete responses/);
ok("with no test responses the Charts section shows a pending state instead of charts");
await page.click('[data-testid="ap-apply"]');
assert.match(await waitOutcome(/No complete test responses yet/), /outputs are configured/);
assert.equal(db.tables.analytics_runs.filter((r) => r.environment === "TEST").length, 0, "no run on zero completes");
ok("applying on an empty dataset configures the outputs and computes nothing — no run, no findings");
await page.selectOption('[data-testid="ax-dataset"]', "LIVE");
await page.waitForSelector('[data-testid="ap-workspace"]');

console.log("\n§10 A PROJECT WITHOUT A PLAN — Create analysis stays, the plan is offered");
await openPlan(EMPTY);
assert.equal(await count('[data-testid="ap-none"]'), 1);
assert.equal(await count('[data-testid="ap-open-intelligent"]'), 1);
assert.equal(await count('[data-testid="ap-create-analysis"]'), 1);
ok("a survey with no plan gets the empty state: plan it in Intelligent mode, add a first item, or create an analysis by hand");
await page.click('[data-testid="ax-tab-home"]');
await page.waitForSelector('[data-testid="ax-plan-card"][data-state="none"]');
assert.equal(await count('[data-testid="ax-quick-analysis"]'), 1);
await page.click('[data-testid="ax-quick-analysis"]');
await page.waitForSelector('[data-testid="ax-analysis-layout"]');
ok("Home says there is no plan, and “Create analysis” still opens the builder");
await page.goto(`${STUDIO}/analytics?survey=${SURVEY}`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="ax-plan-card"][data-state="applied"]');
assert.match(await text('[data-testid="ax-plan-state"]'), /Applied/);
await page.click('[data-testid="ax-plan-open"]');
await page.waitForSelector('[data-testid="ap-workspace"]');
ok("Home for the planned survey leads with the plan card (Applied) and opens the plan workspace");

console.log("\n§11 A FIRST ITEM ADDED BY HAND where there is no plan");
await openPlan(EMPTY);
await page.click('[data-testid="ap-add-first-crosstab"]');
await page.waitForSelector('[data-testid="ap-editor"]');
await page.selectOption('[data-testid="ap-ed-rows-add"]', "SAT");
await page.selectOption('[data-testid="ap-ed-columns-add"]', "GENDER");
await page.click('[data-testid="ap-ed-save"]');
await page.waitForSelector('[data-testid="ap-workspace"]');
assert.equal(ctxOf(EMPTY).def.research.analysisPlan.crosstabs.length, 1);
ok("adding a crosstab to a survey without a plan creates the plan in the survey, and the workspace opens on it");

console.log("\n§12 NARROW SCREENS — the plan workspace never scrolls sideways");
for (const width of [768, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await openPlan();
  for (const sec of ["overview", "crosstabs", "variables", "insights", "dashboards"]) {
    await page.click(`[data-testid="ap-section-${sec}"]`);
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => { const ws = document.querySelector('[data-testid="ap-workspace"]'); return { page: document.documentElement.scrollWidth - window.innerWidth, ws: ws.scrollWidth - ws.clientWidth }; });
    assert.ok(over.ws <= 1, `${sec} at ${width}px overflows the workspace by ${over.ws}px`);
  }
  if (process.env.AP_SHOTS) await page.screenshot({ path: `${process.env.AP_SHOTS}/w${width}.png`, fullPage: true });
}
ok("at 768px and 390px every section fits the workspace's width (wide tables scroll inside their own box)");

assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\n${passed} checks passed.`);
await browser.close();
