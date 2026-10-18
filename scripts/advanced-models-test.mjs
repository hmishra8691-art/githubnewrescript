/**
 * ADVANCED MODELS — browser checks on Data Analytics for latent class analysis,
 * SEM / CFA and hierarchical Bayes (2026-10-18).
 *
 * Like analytics-test.mjs, the analytics API is an IN-PROCESS FAKE BACKEND that
 * runs the REAL engine (`@rescript/analytics`: dataset → runAnalysis, the one
 * readiness rule, the chunked HB job step `modelJobStep`) over a seeded fixture
 * with known structure (`dist/models/fixture.js`: 300 respondents, a 10-version
 * efficient CBC, a 3-class latent structure over six categorical indicators,
 * nine numeric items from a 3-factor mediation model). The job endpoints mirror
 * `lib/modelJobs.ts` (start runs the first chunk, continue advances the saved
 * chain state, cancel stops it). What this proves: the builder drives the models
 * end to end — options, readiness, progress, results, export; the SQL of
 * migration 0066 and the lease are covered by apps/studio/lib/modelJobs.test.ts.
 *
 * Needs `pnpm dev:studio` (3000) and built packages (analytics, designs).
 *   node scripts/advanced-models-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { buildDataset, runAnalysis, recommendCharts, analysisReadiness, modelJobStep, DEFAULT_THEME } from "../packages/analytics/dist/index.js";
import { buildXlsx } from "../packages/analytics/dist/export/index.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";
import { advancedFixture } from "../packages/analytics/dist/models/fixture.js";
import { axTab } from "./lib/axNav.mjs";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "22222222-2222-4222-8222-222222222222";
/* the server advances HB ≤ 40 s per request; here a short chunk so progress is visible and several requests happen */
const CHUNK_MS = Number(process.env.ADV_CHUNK_MS ?? 600);

/* ------------------------------------------------------------ fake backend */
const { def, rows } = advancedFixture({ n: 300 });
const dsCache = new Map();
const dataset = (spec) => { const k = JSON.stringify(spec ?? {}); if (!dsCache.has(k)) dsCache.set(k, buildDataset(def, rows, { spec: spec ?? { environment: "LIVE", dataset: "all" } })); return dsCache.get(k); };
const store = { analyses: [], jobs: [], modelCalls: [], runs: [], lastExport: null };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const withRecs = (r) => ({ ...r, recommendations: r.advice?.alternatives ?? recommendCharts(r) });
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const view = (j) => ({ id: j.id, kind: j.kind, status: j.status, progress: { ...j.progress, pct: j.progress.total ? Math.round((j.progress.done / j.progress.total) * 1000) / 10 : 0 }, result: j.status === "done" || j.status === "refused" ? j.result : null, error: j.error ?? null, seed: j.seed, dataFingerprint: j.fp, engineVersion: "test", createdAt: j.created_at, updatedAt: now(), finishedAt: null });
const advance = (j) => {
  const step = modelJobStep(j.definition, dataset(j.definition.dataset), j.state, CHUNK_MS);
  j.status = step.status; j.progress = { ...step.progress, projectedMs: step.projectedMs }; j.state = step.state; j.seed = step.seed; j.fp = step.dataFingerprint;
  if (step.result) j.result = withRecs(step.result);
  if (step.status === "refused") j.error = step.result?.error?.message ?? "refused";
};

async function fakeApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = req.method();
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const [head, itemId, action] = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  if (head === "variables") return json(route, { variables: variableMetadata(def).filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: 1 });
  if (head === "home") return json(route, { analyses: store.analyses, charts: [], reports: [], shares: [] });
  if (head === "run") {
    const d = body.definition;
    const ready = analysisReadiness({ ...d, variables: Array.isArray(d.variables) ? d.variables : [] });
    if (!ready.ready) return json(route, { error: ready.missing.join(" "), code: "incomplete_definition", missing: ready.missing }, 422);
    store.runs.push(d.kind);
    return json(route, { result: withRecs(runAnalysis(d, dataset(d.dataset))) });
  }
  if (head === "models") {
    store.modelCalls.push(`${m} ${itemId ?? ""} ${action ?? ""}`.trim());
    if (m === "POST" && !itemId) {
      const d = body.definition;
      const ready = analysisReadiness({ ...d, variables: Array.isArray(d.variables) ? d.variables : [] });
      if (!ready.ready) return json(route, { error: ready.missing.join(" "), code: "incomplete_definition" }, 422);
      const j = { id: uid(), kind: d.kind, status: "running", definition: d, progress: { done: 0, total: 0, unit: "iterations" }, state: null, created_at: now() };
      store.jobs.push(j); advance(j);
      return json(route, { job: view(j) });
    }
    const j = store.jobs.find((x) => x.id === itemId);
    if (!j) return json(route, { error: "Unknown model job." }, 404);
    if (m === "POST" && action === "continue") { if (j.status === "running") advance(j); return json(route, { job: view(j) }); }
    if (m === "POST" && action === "cancel") { if (j.status === "running") { j.status = "cancelled"; j.state = null; } return json(route, { job: view(j) }); }
    return json(route, { job: view(j) });
  }
  if (head === "export") {
    const a = body.analysisId ? store.analyses.find((x) => x.id === body.analysisId) : { id: "adhoc", name: body.definition.name, definition: body.definition };
    const res = runAnalysis({ ...a.definition, name: a.name, options: { ...a.definition.options, timeBudgetMs: 120_000 } }, dataset(a.definition.dataset));
    const report = { title: a.name, mode: "live", blocks: res.tables.map((t, i) => ({ id: `t${i}`, type: "table", analysisId: a.id, tableId: t.id })) };
    const buf = await buildXlsx({ report, results: { [a.id]: res }, theme: DEFAULT_THEME });
    store.lastExport = { kind: a.definition.kind, bytes: buf.length, tables: res.tables.map((t) => t.id) };
    return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "content-disposition": `attachment; filename="x.xlsx"` }, body: buf });
  }
  if (head === "analyses" && m === "POST") { const row = { id: uid(), survey_id: SURVEY, created_at: now(), updated_at: now(), name: body.name, kind: body.definition.kind, definition: body.definition, version: 1 }; store.analyses.push(row); return json(route, { item: row }, 201); }
  if (head === "analyses" && m === "PUT") { const row = store.analyses.find((x) => x.id === itemId); Object.assign(row, { name: body.name ?? row.name, definition: body.definition ?? row.definition, updated_at: now() }); return json(route, { item: row }); }
  if (head === "report-templates") return json(route, { templates: [], available: true });
  if (m === "GET" && ["analyses", "charts", "segments", "themes", "reports", "shares"].includes(head)) return json(route, itemId ? { item: null } : { items: head === "analyses" ? store.analyses : [] });
  return json(route, { error: "Unknown analytics endpoint." }, 404);
}

/* ------------------------------------------------------------ browser */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());
const user = { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } };
await page.route("**/api/auth/me", (r) => json(r, user));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "ADV", title: "Advanced models study", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, fakeApi);
await page.route(`**/api/surveys/${SURVEY}/analytics`, fakeApi);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const tableTitles = () => page.$$eval(".ax-table-card .card-title", (es) => es.map((e) => e.textContent.trim()));
const tableRows = (title) => page.$$eval(".ax-table-card", (cards, t) => { const c = cards.find((x) => x.querySelector(".card-title")?.textContent.trim().startsWith(t)); return c ? [...c.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())) : null; }, title);
const shot = async (name) => { if (process.env.AX_SHOTS) await page.screenshot({ path: `${process.env.AX_SHOTS}/adv-${name}.png` }); };
async function newAnalysis(kind, name) {
  await axTab(page, "home"); await page.click('[data-testid="ax-quick-analysis"]');
  await page.waitForSelector('[data-testid="ax-builder"]');
  await page.click(`[data-testid="ax-kind-${kind}"]`);
  await page.fill('[data-testid="ax-name"]', name);
}
const showTables = async () => { await page.click('.ax-tab:has-text("Tables")'); await page.waitForSelector(".ax-table-card"); };

console.log("\n§1 THE ADVANCED MODELS ARE IN THE BUILDER");
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="ax-workspace"]');
await axTab(page, "home"); await page.click('[data-testid="ax-quick-analysis"]');
await page.waitForSelector('[data-testid="ax-builder"]');
for (const k of ["hb", "lca", "sem"]) assert.ok(await page.$(`[data-testid="ax-kind-${k}"]`), k);
assert.match(await page.$eval('[data-testid="ax-kind-hb"]', (e) => e.closest(".ax-kind-group").textContent), /Advanced models/);
ok("Hierarchical Bayes, Latent class and SEM / CFA are listed under Advanced models");

console.log("\n§2 LATENT CLASS — K = 1..4, BIC table, profiles, membership, export");
await newAnalysis("lca", "Usage segments (LCA)");
await page.click('[data-testid="ax-step-1"]'); await page.waitForSelector('[data-testid="ax-variables"]');
/* U1–U4 are yes/no (Categorical); U5–U6 have ordered labels (Never / Sometimes / Often), which the dictionary reads as Scale — LCA accepts both */
  for (const v of ["U1", "U2", "U3", "U4", "U5", "U6"]) await page.click(`.ax-var:has(.ax-var-meta:text-matches("^${v} · (Categorical|Scale)$")) input`);
await page.click('[data-testid="ax-step-4"]');
await page.fill('.ax-field:has-text("Most classes") input', "4");
await page.fill('.ax-field:has-text("Random starts") input', "15");
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]', { timeout: 60_000 });
await showTables();
const titles = await tableTitles();
for (const t of ["Latent class models compared", "Class sizes — 3-class model", "Item-response probabilities — 3-class model", "Classification uncertainty", "Posterior class membership"]) assert.ok(titles.some((x) => x.startsWith(t)), `${t} in ${titles}`);
const cmp = await tableRows("Latent class models compared");
assert.deepEqual(cmp.map((r) => r[0]), ["1", "2", "3", "4"]);
assert.ok(cmp.find((r) => r[0] === "3").some((c) => c.includes("lowest BIC")), JSON.stringify(cmp));
assert.match(await text('[data-testid="ax-result"]'), /BIC is lowest at 3 classes/);
const prof = await tableRows("Item-response probabilities");
assert.equal(prof[0].length, 2 + 3, "indicator, category and one column per class");
ok("LCA fits K = 1..4, recommends 3 by BIC (with AIC / SABIC / entropy shown), and shows sizes, item probabilities, uncertainty and membership");
await shot("lca");
await page.click('[data-testid="ax-save"]'); await page.waitForSelector('[data-testid="ax-msg"]:has-text("Analysis saved")');
await page.click('[data-testid="ax-export-xlsx"] >> nth=0');
await page.waitForFunction(() => true); for (let i = 0; i < 50 && !store.lastExport; i++) await page.waitForTimeout(200);
assert.equal(store.lastExport?.kind, "lca"); assert.ok(store.lastExport.bytes > 2000 && store.lastExport.tables.includes("lca_fit"));
ok("the LCA result exports to Excel through the analysis export path");

console.log("\n§3 SEM / CFA — fit indices, a path diagram, a non-identified model refused");
await newAnalysis("sem", "Attitude model (CFA)");
await page.click('[data-testid="ax-step-4"]');
await page.fill('[data-testid="ax-sem-syntax"]', "F1 =~ X1 + X2");
await page.waitForSelector('[data-testid="ax-run"][data-ready="0"]');
assert.match(await text('[data-testid="ax-run-missing"]'), /only two indicators/);
ok("a non-identified model (an isolated two-indicator factor) is refused before running, with the reason");
await page.fill('[data-testid="ax-sem-syntax"]', "X =~ X1 + X2 + X3\nM =~ M1 + M2 + M3\nY =~ Y1 + Y2 + Y3\nM ~ a*X\nY ~ c*X + b*M\nind := a*b");
await page.waitForSelector('[data-testid="ax-run"][data-ready="1"]');
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
assert.ok(await page.$('[data-testid="ax-result"] svg'), "a chart (path diagram) is drawn");
await showTables();
const fitRows = await tableRows("Model fit — structural equation model");
const fit = Object.fromEntries(fitRows.map((r) => [r[0], r[1]]));
for (const k of ["χ²", "df", "CFI", "TLI", "SRMR"]) assert.ok(fit[k] != null, k);
assert.equal(fit.df, "24");
assert.ok(Number(fit.CFI) > 0.95, `CFI ${fit.CFI}`);
assert.match(fit["RMSEA [90% CI]"], /^0\.\d+ \[/);
const st = await tableTitles();
for (const t of ["Measurement model — factor loadings", "Structural model — regression paths", "Indirect and defined effects"]) assert.ok(st.some((x) => x.startsWith(t)), t);
const ind = (await tableRows("Indirect and defined effects")).find((r) => r[0] === "ind");
assert.ok(ind && Number(ind[2]) > 0.1, JSON.stringify(ind));
ok("SEM shows χ²(24), CFI, TLI, RMSEA with its 90% CI, SRMR, loadings, paths and the indirect effect a·b with a delta-method SE");
await shot("sem");

console.log("\n§4 HIERARCHICAL BAYES — runs as a chunked job with progress, then diagnostics and utilities");
await newAnalysis("hb", "Phone CBC (HB)");
await page.click('[data-testid="ax-step-1"]'); await page.waitForSelector('[data-testid="ax-variables"]');
await page.click('.ax-var:has-text("CBC_TASKS · Question") input');
await page.click('[data-testid="ax-step-4"]');
await page.waitForSelector('[data-testid="ax-hb-options"]');
await page.fill('.ax-field:has-text("Burn-in iterations") input', "3000");
await page.fill('.ax-field:has-text("Iterations kept from") input', "3000");
const callsBefore = store.modelCalls.length;
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-job-progress"]', { timeout: 30_000 });
const pct = Number(await page.getAttribute('[data-testid="ax-job-progress"]', "data-pct"));
assert.ok(pct > 0 && pct < 100, `progress ${pct}%`);
assert.match(await text('[data-testid="ax-job-progress"]'), /Hierarchical Bayes: [\d,]+ of 6,000 iterations per chain/);
ok(`HB runs as a background job: progress shown (${pct}%) while the chains advance chunk by chunk`);
await page.waitForSelector('[data-testid="ax-result"]', { timeout: 180_000 });
const chunks = store.modelCalls.slice(callsBefore).filter((c) => c.endsWith("continue")).length;
assert.ok(chunks >= 2, `${chunks} continuation requests`);
assert.equal(store.runs.filter((k) => k === "hb").length, 0, "HB never went through the synchronous run route");
await showTables();
const ht = await tableTitles();
assert.ok(ht.some((t) => t.startsWith("Convergence diagnostics — hierarchical Bayes")) && ht.some((t) => t.startsWith("Trace summary")), JSON.stringify(ht));
const diag = Object.fromEntries((await tableRows("Convergence diagnostics")).map((r) => [r[0], r[1]]));
assert.match(diag.Model, /Hierarchical Bayes multinomial logit/);
assert.ok(diag["Largest R̂ (population means)"] && diag["Chain 1: acceptance after burn-in / jump size"], JSON.stringify(diag));
if (/^Converged/.test(diag.Verdict)) {
  for (const t of ["Population mean part-worths — hierarchical Bayes", "Attribute importance — mean of individual importances", "Share-of-preference simulation on individual utilities", "Individual utilities — posterior means", "HB population means vs the aggregate logit"]) assert.ok(ht.some((x) => x.startsWith(t)), t);
  ok(`HB converged (R̂ ${diag["Largest R̂ (population means)"]}) in ${chunks + 1} requests: diagnostics, trace, population means with credible intervals, importances, simulation, individual utilities and the aggregate comparison`);
} else {
  assert.ok(!ht.some((x) => x.startsWith("Population mean part-worths")), "estimates withheld when not converged");
  assert.match(await text('[data-testid="ax-warnings"]'), /not converged/);
  ok(`HB did not converge at these settings and showed diagnostics only (R̂ ${diag["Largest R̂ (population means)"]}) — never a silent fallback`);
}
await shot("hb");

console.log("\n§5 HB — cancel a running job");
await newAnalysis("hb", "Phone CBC (HB, long)");
await page.click('[data-testid="ax-step-1"]'); await page.waitForSelector('[data-testid="ax-variables"]');
await page.click('.ax-var:has-text("CBC_TASKS · Question") input');
await page.click('[data-testid="ax-step-4"]');
await page.fill('.ax-field:has-text("Burn-in iterations") input', "40000");
await page.fill('.ax-field:has-text("Iterations kept from") input', "40000");
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-job-progress"]', { timeout: 30_000 });
await page.click('[data-testid="ax-job-cancel"]');
await page.waitForSelector('[data-testid="ax-error"]:has-text("cancelled")', { timeout: 30_000 });
assert.equal(store.jobs.at(-1).status, "cancelled");
assert.equal(await page.$('[data-testid="ax-job-progress"]'), null);
ok("a running HB job can be cancelled; its chain state is dropped");

console.log(`\n${passed} checks passed`);
await browser.close();
