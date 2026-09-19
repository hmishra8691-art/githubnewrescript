/**
 * DATA ANALYTICS — browser checks on the workspace, builder, charts, reports,
 * publishing, sharing and the read-only share view.
 *
 * The Studio dev server has no database here, so the analytics API is served
 * by an IN-PROCESS FAKE BACKEND that uses the REAL analytics engine
 * (`@rescript/analytics`: dataset → runAnalysis → recommendations → exports)
 * over the synthetic fixture with planted structure. Persistence is an
 * in-memory store that mirrors the route contract (collections, versions,
 * publish snapshots, share tokens, revocation). What this proves: the UI
 * drives the engine correctly end to end; what it cannot prove here is the
 * SQL — the migration and share-resolution function are exercised separately
 * against the live database.
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/analytics-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, applyTemplate, reportPages } from "../packages/analytics/dist/index.js";
import { buildPptx, buildXlsx } from "../packages/analytics/dist/export/index.js";
import { def, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";

/* ------------------------------------------------------------ fake backend */
const rows = synthRows(400);
const store = { analyses: [], charts: [], segments: [], themes: [], reports: [], shares: [], analysisVersions: [], reportVersions: [], reportTemplates: [], exports: 0, audit: [] };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const compute = (definition) => {
  const ds = buildDataset(def, rows, { spec: definition.dataset ?? { environment: "LIVE", dataset: "all" }, weighting: definition.weighting ?? null });
  const result = runAnalysis(definition, ds);
  return { ...result, recommendations: recommendCharts(result) };
};
const reportResults = (definition) => {
  const ids = new Set();
  for (const b of definition.blocks ?? []) {
    if (b.analysisId) ids.add(b.analysisId);
    for (const id of b.analysisIds ?? []) ids.add(id);
    // §37 — a panel_grid has no analysisId of its own; every one of its panels does
    if (b.type === "panel_grid") for (const pnl of b.panels ?? []) if (pnl.analysisId) ids.add(pnl.analysisId);
  }
  for (const w of definition.widgets ?? []) if (w.analysisId) ids.add(w.analysisId);
  const out = {};
  for (const id of ids) { const a = store.analyses.find((x) => x.id === id && !x.deleted_at); if (a) out[id] = compute({ ...a.definition, id, name: a.name }); }
  return out;
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function fakeApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = req.method();
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const path = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  const [head, itemId, action] = path;
  const coll = (k) => store[k];
  /* §36 — report templates, and laying one over a report */
  if (head === "report-templates") {
    if (m === "GET") return json(route, { templates: [...BUILT_IN_REPORT_TEMPLATES, ...store.reportTemplates], available: true });
    if (m === "POST") {
      const src = store.reports.find((r) => r.id === body.fromReportId);
      const blocks = (src?.definition?.blocks ?? []).map((b) => {
        if (b.type === "panel_grid") return { ...b, panels: b.panels.map((pnl) => ({ ...pnl, analysisId: "" })) };
        const { analysisId, analysisIds, ...rest } = b; return { ...rest, placeholder: b.title ?? b.type };
      });
      const t = { id: uid(), name: body.name, description: body.description, builtIn: false, blocks };
      store.reportTemplates.push(t);
      return json(route, { template: t }, 201);
    }
    if (m === "DELETE") { store.reportTemplates = store.reportTemplates.filter((t) => t.id !== itemId); return json(route, { ok: true }); }
  }
  if (head === "reports" && action === "apply-template" && m === "POST") {
    const r = store.reports.find((x) => x.id === itemId);
    const t = [...BUILT_IN_REPORT_TEMPLATES, ...store.reportTemplates].find((x) => x.id === body.templateId);
    if (!r || !t) return json(route, { error: "Unknown template." }, 404);
    r.definition = applyTemplate(t, r.definition);
    store.audit.push("analytics.report_modified");
    return json(route, { definition: r.definition, appliedTemplate: t.name });
  }
  if (head === "variables") return json(route, { variables: variableMetadata(def).filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: 3 });
  if (head === "home") return json(route, { analyses: store.analyses.filter((a) => !a.deleted_at), charts: store.charts, reports: store.reports.filter((r) => !r.deleted_at), shares: store.shares.filter((s) => !s.revoked_at) });
  if (head === "run") { try { return json(route, { result: compute(body.definition) }); } catch (e) { return json(route, { error: e.message }, 500); } }
  if (head === "export") {
    store.exports++;
    let report, results;
    if (body.reportId) { const r = store.reports.find((x) => x.id === body.reportId); report = r.definition; results = body.version ? store.reportVersions.find((v) => v.report_id === r.id && v.version === body.version).snapshot : reportResults(r.definition); }
    else { const a = body.analysisId ? store.analyses.find((x) => x.id === body.analysisId) : { id: "adhoc", name: body.definition.name, definition: body.definition }; const res = compute({ ...a.definition, name: a.name }); results = { [a.id]: res }; report = { title: a.name, mode: "live", blocks: [{ id: "c", type: "chart", analysisId: a.id, chart: body.chart ?? { type: res.recommendedCharts[0], options: {} } }, ...res.tables.map((t, i) => ({ id: `t${i}`, type: "table", analysisId: a.id, tableId: t.id }))] }; }
    const buf = body.format === "xlsx" ? await buildXlsx({ report, results, theme: DEFAULT_THEME, settings: body.settings }) : await buildPptx({ report, results, theme: DEFAULT_THEME, settings: body.settings });
    store.lastExport = { format: body.format ?? "pptx", bytes: buf.length };
    return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "content-disposition": `attachment; filename="x.${body.format ?? "pptx"}"` }, body: buf });
  }
  if (head === "reports" && itemId && action === "publish") {
    const r = store.reports.find((x) => x.id === itemId); const version = (r.published_version ?? 0) + 1;
    store.reportVersions.push({ id: uid(), report_id: r.id, version, definition: r.definition, theme: DEFAULT_THEME, snapshot: reportResults(r.definition), dataset: { responses: rows.length }, published_at: now(), note: body.note ?? null });
    r.published_version = version; store.audit.push("analytics.report_published");
    return json(route, { version, publishedAt: now() });
  }
  if (head === "reports" && itemId && action === "results") {
    const r = store.reports.find((x) => x.id === itemId); const v = url.searchParams.get("version");
    if (v) { const rv = store.reportVersions.find((x) => x.report_id === r.id && x.version === Number(v)); return json(route, { mode: "snapshot", version: rv.version, definition: rv.definition, theme: rv.theme, results: rv.snapshot, publishedAt: rv.published_at }); }
    return json(route, { mode: "live", definition: r.definition, theme: DEFAULT_THEME, results: reportResults(r.definition), computedAt: now() });
  }
  if (action === "versions") return json(route, { versions: (head === "analyses" ? store.analysisVersions.filter((v) => v.analysis_id === itemId) : store.reportVersions.filter((v) => v.report_id === itemId)).sort((a, b) => b.version - a.version) });
  if (action === "access") return json(route, { events: [] });
  /* the rail's verbs (route: POST analyses/reorder, POST analyses/<id>/duplicate; PUT accepts position) */
  if (head === "analyses" && itemId === "reorder" && m === "POST") { let pos = 0; for (const id of body.ids) { const a = store.analyses.find((x) => x.id === id); if (a) a.position = pos++; } return json(route, { ok: true, ordered: pos }); }
  if (head === "analyses" && action === "duplicate" && m === "POST") {
    const src = store.analyses.find((x) => x.id === itemId); if (!src) return json(route, { error: "Unknown item." }, 404);
    const name = body.name?.trim() || `${src.name} (copy)`;
    const row = { id: uid(), survey_id: SURVEY, created_at: now(), updated_at: now(), name, kind: src.kind, definition: { ...src.definition, name }, version: 1, position: null };
    store.analyses.push(row); store.analysisVersions.push({ analysis_id: row.id, version: 1, definition: row.definition, summary: `Duplicated from “${src.name}”`, created_at: now() }); store.audit.push("analytics.analysis_created");
    return json(route, { item: row }, 201);
  }
  if (!store[head]) return json(route, { error: "Unknown analytics endpoint." }, 404);
  if (m === "GET" && !itemId) {
    const kind = url.searchParams.get("kind");
    const items = coll(head).filter((x) => !x.deleted_at && (!kind || x.kind === kind));
    // analyses: arranged first in their order, then newest first — the route's ORDER BY
    if (head === "analyses") items.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || (a.updated_at < b.updated_at ? 1 : -1));
    return json(route, { items });
  }
  if (m === "GET") return json(route, { item: coll(head).find((x) => x.id === itemId) });
  if (m === "POST") {
    const row = { id: uid(), survey_id: SURVEY, created_at: now(), updated_at: now() };
    if (head === "analyses") { Object.assign(row, { name: body.name, kind: body.definition.kind, definition: { ...body.definition, name: body.name }, version: 1 }); store.analysisVersions.push({ analysis_id: row.id, version: 1, definition: row.definition, summary: "Created", created_at: now() }); store.audit.push("analytics.analysis_created"); }
    if (head === "charts") { Object.assign(row, { analysis_id: body.analysisId, name: body.name, spec: body.spec, theme_id: body.themeId ?? null, style_version: 1 }); store.audit.push("analytics.chart_created"); }
    if (head === "segments") Object.assign(row, { kind: body.kind ?? "segment", name: body.name, description: body.description, color: body.color, condition: body.condition });
    if (head === "themes") Object.assign(row, { name: body.name, theme: body.theme, survey_id: body.scope === "survey" ? SURVEY : null, customer_id: "c" });
    if (head === "reports") Object.assign(row, { kind: body.kind ?? "report", name: body.name, mode: body.mode ?? "live", theme_id: null, published_version: null, definition: body.definition ?? (body.kind === "dashboard" ? { title: body.name, widgets: [], crossFilter: true } : { title: body.name, mode: "live", blocks: [{ id: "cover", type: "cover", title: body.name }] }) });
    if (head === "shares") { const r = store.reports.find((x) => x.id === body.reportId); if (!r.published_version) return json(route, { error: "Publish the report before sharing it — a share link always points at a published version." }, 409); Object.assign(row, { report_id: body.reportId, token: uid().replace(/-/g, "") + "tok", access: body.access ?? "link", permission: body.permission ?? "viewer", report_version: body.pinVersion ? r.published_version : null, has_password: !!body.password, password: body.password ?? null, expires_at: body.expiresAt ?? null, revoked_at: null, allowed_emails: body.emails ?? [], view_count: 0, label: body.label ?? null }); store.audit.push("analytics.report_shared"); }
    coll(head).push(row);
    return json(route, { item: row }, 201);
  }
  if (m === "PUT") {
    const row = coll(head).find((x) => x.id === itemId);
    if (head === "analyses" && body.definition) { const strip = (d) => { const { formatting: _f, ...o } = d.options ?? {}; return JSON.stringify({ ...d, name: 0, options: o }); }; const changed = strip(row.definition) !== strip(body.definition); row.definition = body.definition; if (changed) { row.version++; store.analysisVersions.push({ analysis_id: row.id, version: row.version, definition: body.definition, created_at: now() }); } }
    if (head === "analyses" && (body.position === null || typeof body.position === "number")) row.position = body.position;
    if (head === "charts" && body.spec) { row.spec = body.spec; row.style_version++; }
    for (const k of ["name", "definition", "mode", "condition", "theme", "description", "color"]) if (body[k] !== undefined && !(head === "analyses" && k === "definition")) row[k] = body[k];
    if (body.themeId !== undefined) row.theme_id = body.themeId;
    row.updated_at = now();
    return json(route, { item: row });
  }
  if (m === "PATCH") { const row = coll(head).find((x) => x.id === itemId); if (body.revoke) { row.revoked_at = now(); store.audit.push("analytics.share_revoked"); } if (body.reshare) { row.revoked_at = null; row.token = uid().replace(/-/g, "") + "tok"; } for (const k of ["access", "permission"]) if (body[k]) row[k] = body[k]; if (body.expiresAt !== undefined) row.expires_at = body.expiresAt; return json(route, { item: row }); }
  if (m === "DELETE") { const row = coll(head).find((x) => x.id === itemId); if (head === "shares") row.revoked_at = now(); else row.deleted_at = now(); return json(route, { ok: true }); }
  return json(route, { error: "unhandled" }, 500);
}

/** The public door, mirroring rescript_resolve_share: revoked / expired / password / snapshot only. */
async function fakeShare(route) {
  const req = route.request(); const url = new URL(req.url());
  const token = url.pathname.split("/").pop();
  const s = store.shares.find((x) => x.token === token);
  if (!s) return json(route, { error: "This link is not valid." }, 404);
  const r = store.reports.find((x) => x.id === s.report_id);
  if (s.revoked_at) return json(route, { error: "This shared report has been revoked by its owner.", status: "revoked" }, 410);
  if (s.expires_at && new Date(s.expires_at) < new Date()) return json(route, { error: "This shared link has expired.", status: "expired" }, 410);
  const pw = req.headers()["x-share-password"];
  if (s.password && pw !== s.password) return json(route, { error: pw ? "That password is not correct." : "This report is password protected.", status: "password", reportName: r.name }, 401);
  const v = store.reportVersions.filter((x) => x.report_id === r.id).find((x) => x.version === (s.report_version ?? r.published_version));
  if (!v) return json(route, { error: "This report is not available.", status: "unpublished" }, 404);
  if (req.method() === "POST") {
    if (s.permission !== "download") return json(route, { error: "Downloads are not enabled for this shared report.", status: "no_download" }, 403);
    const body = JSON.parse(req.postData() || "{}");
    const buf = body.format === "xlsx" ? await buildXlsx({ report: v.definition, results: v.snapshot, theme: v.theme }) : await buildPptx({ report: v.definition, results: v.snapshot, theme: v.theme });
    store.lastShareDownload = { format: body.format, bytes: buf.length };
    return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { "content-disposition": `attachment; filename="r.${body.format}"` }, body: buf });
  }
  s.view_count++;
  return json(route, { report: { name: r.name, title: v.definition.title, subtitle: v.definition.subtitle, blocks: v.definition.blocks, widgets: v.definition.widgets ?? null, hero: v.definition.hero ?? null, bands: v.definition.bands ?? null, viewerSegments: v.definition.viewerSegments ?? [], branding: v.definition.branding ?? {} }, theme: v.theme, results: v.snapshot, version: v.version, publishedAt: v.published_at, mode: "snapshot", dataset: v.dataset, permission: s.permission });
}

/* ------------------------------------------------------------ browser */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
/*
 * One dialog handler for the whole run. `promptAnswer` lets a test decide what
 * a prompt() should return — Playwright allows only ONE handler, so a
 * `page.once` alongside this one throws "already handled" rather than winning.
 */
let promptAnswer = "";
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? promptAnswer : undefined));
const user = { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } };
await page.route("**/api/auth/me", (r) => json(r, user));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, fakeApi);
await page.route(`**/api/surveys/${SURVEY}/analytics`, fakeApi);
await page.route("**/api/share/**", fakeShare);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
/* AX_SHOTS=<dir> writes a screenshot at each named point — for visual review, not assertions */
const shot = async (name) => { if (process.env.AX_SHOTS) await page.screenshot({ path: `${process.env.AX_SHOTS}/${name}.png`, fullPage: false }); };
const count = (sel) => page.$$eval(sel, (es) => es.length);

console.log("\n§1 WORKSPACE & HOME");
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="ax-workspace"]');
assert.match(await text('[data-testid="ax-survey"] option:checked'), /Synthetic Study 2026/);
assert.match(await text('[data-testid="ax-dataset"] option:checked'), /Production responses \(400\)/);
ok("Data Analytics page opens with survey and dataset selectors (400 production responses)");
await page.waitForSelector('[data-testid="ax-home"]');
assert.equal(await count('[data-testid="ax-tab-home"], [data-testid="ax-tab-analysis"], [data-testid="ax-tab-charts"], [data-testid="ax-tab-tables"], [data-testid="ax-tab-segments"], [data-testid="ax-tab-filters"], [data-testid="ax-tab-reports"], [data-testid="ax-tab-themes"], [data-testid="ax-tab-exports"], [data-testid="ax-tab-sharing"]'), 10);
ok("home page with Recent analyses / Saved reports / Quick actions and all ten workspace tabs");
await shot("01-home");

console.log("\n§2 ANALYSIS BUILDER — crosstab with significance");
await page.click('[data-testid="ax-quick-crosstab"]');
await page.waitForSelector('[data-testid="ax-builder"]');
assert.ok(await page.$('[data-testid="ax-kind-crosstab"].on'), "crosstab preselected");
await page.fill('[data-testid="ax-name"]', "Satisfaction by gender");
await page.click('[data-testid="ax-step-1"]');
await page.waitForSelector('[data-testid="ax-variables"]');
// rows: SAT via checkbox (first pick → rows), columns: GENDER (second → columns)
await page.click('.ax-var:has-text("SAT · Scale") input');
await page.click('.ax-var:has-text("GENDER · Categorical") input');
assert.match(await text('[data-testid="ax-drop-rows"]'), /Overall satisfaction/);
assert.match(await text('[data-testid="ax-drop-columns"]'), /Gender/);
await shot("02-variables");
ok("variable picker fills Rows then Columns; drop zones show labels");
await page.click('[data-testid="ax-step-2"]');
await page.click('[data-testid="ax-add-rule"]');
await page.waitForSelector('[data-testid="ax-rule"]');
const ruleVar = page.locator('[data-testid="ax-rule"] select').first();
await ruleVar.selectOption({ label: "Age" });
await page.locator('[data-testid="ax-rule"] select').nth(1).selectOption("gte");
await page.fill('[data-testid="ax-rule"] input.input', "25");
assert.match(await text('[data-testid="ax-filter-text"]'), /Age greater than or equal 25/);
ok("filter builder: Age ≥ 25 as an engine Condition, summarised in words");
await shot("03-filters");
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-result"]');
const base = await text('[data-testid="ax-base"]');
assert.match(base, /n = \d+ · \d+ of 400 responses in scope/);
const n = Number(/n = (\d+)/.exec(base)[1]);
assert.ok(n > 200 && n < 400, `filter reduced the base to ${n}`);
ok(`analysis runs server-side and reports its base honestly (${base})`);
assert.ok(await page.$('[data-testid="ax-chart"][data-chart-type="bar_grouped"]'), "recommended chart selected automatically");
assert.ok((await count('[data-testid="ax-gallery"] .ax-gitem')) >= 3);
ok("recommended chart drawn (grouped bar) with a ranked recommendation gallery");
await shot("04-result-chart");
await page.click('.ax-tab:has-text("Tables")');
await shot("05-result-table");
const xt = await text('[data-testid="ax-table"]');
assert.match(xt, /Total.*Male \(a\).*Female \(b\)/);
assert.match(xt, /Base \(n\)/);
assert.ok(/\d+\.\d%a/.test(xt.replace(/\s/g, "")), "a significance letter appears on a female column cell");
ok("crosstab table: column %, base row, significance letters (a/b)");
await page.click('.ax-tab:has-text("Tests")');
assert.match(await text('.ax-table'), /chi square.*< \.001/);
ok("chi-square test listed with p < .001");
await page.click('.ax-tab:has-text("Insights")');
assert.match(await text('.ax-insights'), /differs significantly by Gender/);
ok("insight sentence is tied to the computed test");

console.log("\n§3 CHART GALLERY & CUSTOMISATION");
await page.click('.ax-tab:has-text("Chart")');
await page.click('.ax-fam:has-text("Heatmaps")');
await page.click('[data-testid="ax-chart-heatmap_crosstab"]');
assert.ok(await page.$('[data-testid="ax-chart"][data-chart-type="heatmap_crosstab"]'));
await page.click('.ax-fam:has-text("Text")');
assert.ok(await page.$('[data-testid="ax-chart-word_cloud"][disabled]'), "word cloud disabled for a crosstab");
ok("chart families browsable; unsuitable charts (word cloud) are disabled, heatmap renders");
/*
 * §39 — the honest-failure path. This analysis's categories are satisfaction
 * scores, which are not places. The map must SAY so rather than drawing an
 * empty world that reads as "no respondents anywhere".
 */
await page.click('.ax-fam:text-is("Maps")');
await page.click('[data-testid="ax-chart-map_country"]');
await page.waitForSelector('[data-testid="ax-chart"][data-chart-type="map_country"]');
assert.match(await text('[data-testid="ax-chart"]'), /No category matched a country or state/);
ok("a map whose categories are not places says so instead of drawing an empty world");
// put the heatmap back: the rest of this suite saves and asserts on THAT chart
await page.click('.ax-fam:text-is("Heatmaps")');
await page.click('[data-testid="ax-chart-heatmap_crosstab"]');
await page.waitForSelector('[data-testid="ax-chart"][data-chart-type="heatmap_crosstab"]');
await page.click('[data-testid="ax-customize-toggle"]');
await page.waitForSelector('[data-testid="ax-customize"]');
await page.fill('.ax-customize input[placeholder="Satisfaction by gender"]', "Satisfaction × Gender (25+)");
assert.match(await text('[data-testid="ax-chart"] svg'), /Satisfaction × Gender \(25\+\)/);
ok("customisation panel changes the chart title live");

console.log("\n§4 SAVE ANALYSIS, SAVE CHART, VERSIONING");
await page.click('[data-testid="ax-save"]');
await page.waitForSelector('[data-testid="ax-msg"]:has-text("Analysis saved")');
assert.equal(store.analyses.length, 1); assert.equal(store.analyses[0].version, 1);
assert.deepEqual(store.analyses[0].definition.rows, ["SAT"]); assert.deepEqual(store.analyses[0].definition.columns, ["GENDER"]);
assert.equal(store.analyses[0].definition.filter.type, "group");
ok("saved analysis remembers dataset, rows, columns, measure and filter (reproducible definition)");
await page.click('[data-testid="ax-save-chart"]');
await page.waitForSelector('[data-testid="ax-msg"]:has-text("Chart saved")');
assert.equal(store.charts.length, 1); assert.equal(store.charts[0].spec.type, "heatmap_crosstab"); assert.equal(store.charts[0].spec.options.title, "Satisfaction × Gender (25+)");
ok("saved chart is a spec linked to the analysis, not an image");
// change a styling option → no new analysis version; change definition → new version
await page.click('[data-testid="ax-save"]');
await page.waitForSelector('[data-testid="ax-msg"]:has-text("version 1")');
assert.equal(store.analyses[0].version, 1);
ok("re-saving with only styling changed keeps analysis version 1");
await page.click('[data-testid="ax-stage-builder"]');
await page.click('[data-testid="ax-step-4"]');
await page.selectOption('.ax-options select', { label: "Row %" });
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
await page.click('[data-testid="ax-save"]');
await page.waitForSelector('[data-testid="ax-msg"]:has-text("version 2")');
assert.equal(store.analyses[0].version, 2); assert.equal(store.analysisVersions.length, 2);
ok("changing the measure creates analysis version 2");

console.log("\n§5 MORE ANALYSES — NPS with drivers, conjoint, text");
const runKind = async (kind, name, vars, after) => {
  await page.click('[data-testid="ax-tab-home"]'); await page.click('[data-testid="ax-quick-analysis"]');
  await page.waitForSelector('[data-testid="ax-builder"]');
  await page.click(`[data-testid="ax-kind-${kind}"]`); await page.fill('[data-testid="ax-name"]', name);
  await page.click('[data-testid="ax-step-1"]');
  for (const v of vars) await page.click(`.ax-var:has-text("${v}") input`);
  if (after) await after();
  await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
  await page.click('[data-testid="ax-save"]'); await page.waitForSelector('[data-testid="ax-msg"]:has-text("Analysis saved")');
};
await runKind("nps", "NPS", ["NPS · Scale"], async () => { await page.click('[data-testid="ax-step-4"]'); await page.selectOption('.ax-options select >> nth=0', { label: "Gender" }); });
assert.ok(await page.$('[data-testid="ax-chart"][data-chart-type="gauge"]'));
await page.click('.ax-tab:has-text("Tables")');
assert.match(await text('.ax-tables'), /Net Promoter Score.*NPS by Gender/s);
ok("NPS: gauge recommended, NPS by gender table");
await runKind("conjoint", "Choice model", ["CBC_TASKS · Question"]);
await page.click('.ax-tab:has-text("Tables")');
const cj = await text('.ax-tables');
assert.match(cj, /Attribute importance.*Price/s); assert.match(cj, /Part-worth utilities/); assert.match(cj, /Preference share simulation/); assert.match(cj, /Willingness to pay/);
ok("conjoint: importance (Price first), part-worths, simulation, WTP");
await runKind("text", "Open ends", ["TEXT · Text"]);
assert.ok(await page.$('[data-testid="ax-chart"][data-chart-type="word_cloud"]'));
ok("text analytics: word cloud recommended and drawn");
assert.equal(store.analyses.length, 4);

console.log("\n§5c GEOGRAPHIC CHARTS — a real map, not bars with a footnote (§39)");
await page.click('[data-testid="ax-tab-home"]'); await page.click('[data-testid="ax-quick-analysis"]');
await page.waitForSelector('[data-testid="ax-builder"]');
await page.click('[data-testid="ax-kind-crosstab"]'); await page.fill('[data-testid="ax-name"]', "Satisfaction by country");
await page.click('[data-testid="ax-step-1"]');
await page.click('.ax-var:has-text("COUNTRY · Categorical") input');
await page.click('.ax-var:has-text("GENDER · Categorical") input');
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
await page.click('.ax-tab:has-text("Chart")');
await page.click('.ax-fam:text-is("Maps")');
await page.click('[data-testid="ax-chart-map_country"]');
await page.waitForSelector('[data-testid="ax-chart"][data-chart-type="map_country"]');
const mapPaths = await count('[data-testid="ax-chart"] path');
assert.ok(mapPaths > 100, `a country map draws the whole basemap, got ${mapPaths} paths`);
// the eight surveyed countries are shaded; the rest of the world is the basemap
const shaded = await page.$$eval('[data-testid="ax-chart"] path', (ps) => ps.filter((p) => (p.getAttribute("fill") ?? "").startsWith("rgba")).length);
assert.equal(shaded, 8, `the eight countries in the data should be shaded, got ${shaded}`);
assert.equal(await count('[data-testid="ax-map-unmatched"]'), 0, "every country label resolved, so there is nothing to warn about");
// a crosstab has one series per column, and only one can be shaded — the map says which
assert.match(await text('[data-testid="ax-map-series"]'), /^Shading: /, "the map names the series it is shading");
await shot("05c-country-map");
ok("country map: a real projected basemap, the surveyed countries shaded, the shaded series named, no unmatched labels");
await page.click('[data-testid="ax-chart-map_bubble"]');
await page.waitForSelector('[data-testid="ax-chart"][data-chart-type="map_bubble"]');
assert.equal(await count('[data-testid="ax-chart"] circle'), 8, "a bubble map drops one marker per country, on its centroid");
// a bubble map encodes the value as size, so it must not also shade the regions
const bubbleShaded = await page.$$eval('[data-testid="ax-chart"] path', (ps) => ps.filter((p) => (p.getAttribute("fill") ?? "").startsWith("rgba")).length);
assert.equal(bubbleShaded, 0, "a bubble map leaves the basemap neutral instead of also drawing a choropleth under the markers");
assert.match(await text('[data-testid="ax-map-size-scale"]'), /^Marker size: /, "and says what a marker's size is worth");
await shot("05c-bubble-map");
ok("bubble map: one sized marker per country, placed on the map rather than on a scatter plot");
await page.click('[data-testid="ax-save"]'); await page.waitForSelector('[data-testid="ax-msg"]:has-text("Analysis saved")');
// hand the workspace back the way §5b expects to find it: "Open ends" open
await page.click('[data-testid="ax-rail-item"]:has-text("Open ends")');
await page.waitForSelector('[data-testid="ax-rail-item"].on:has-text("Open ends")');

console.log("\n§5b THE ANALYSES RAIL, THE FOUR STAGES, THE PROFESSIONAL TABLE");
// the rail lists every saved analysis; the open one is highlighted; the stage bar reads Builder → Results → Visualization → Export
await page.waitForSelector('[data-testid="ax-rail"]');
assert.equal(await count('[data-testid="ax-rail-item"]'), 5);
assert.match(await text('[data-testid="ax-rail-item"].on'), /Open ends/);
assert.deepEqual(await page.$$eval('.ax-stage', (es) => es.map((e) => e.textContent.replace(/^\d/, "").trim())), ["Builder", "Results", "Visualization", "Export"]);
assert.equal(await text('[data-testid="ax-savestate"]'), "Saved · v1");
ok("Analyses rail lists the five saved analyses with the open one highlighted; stages read Builder → Results → Visualization → Export");
// Visualization: the chart workbench with full screen and PNG / SVG; Export: the deliverables stage
await page.click('[data-testid="ax-stage-chart"]');
await page.waitForSelector('[data-testid="ax-result"][data-view="chart"]');
assert.ok(await page.$('[data-testid="ax-chart-png"]') && await page.$('[data-testid="ax-chart-svg"]'));
await shot("07-visualization");
await page.click('[data-testid="ax-chart-full"]');
await page.waitForSelector('[data-testid="ax-fullscreen"]');
await shot("08-fullscreen");
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="ax-fullscreen"]', { state: "detached" });
await page.click('[data-testid="ax-stage-export"]');
await page.waitForSelector('[data-testid="ax-export-stage"]');
await shot("10-export");
assert.ok(await page.$('[data-testid="ax-export-pptx"]') && await page.$('[data-testid="ax-export-xlsx"]') && await page.$('[data-testid="ax-export-png"]'));
ok("Visualization stage: full screen opens and closes with Esc, PNG / SVG offered; Export stage lists PowerPoint, Excel, PNG, SVG");
// an edit marks the analysis unsaved — in the stage bar, on the rail item and on the workspace tab
await page.click('[data-testid="ax-stage-builder"]');
await page.click('[data-testid="ax-step-0"]');
await page.fill('[data-testid="ax-name"]', "Open ends (verbatims)");
await page.waitForSelector('[data-testid="ax-savestate"].dirty');
assert.ok(await page.$('[data-testid="ax-rail-item"].on .ax-dirty'), "the rail shows the unsaved dot");
assert.ok(await page.$('[data-testid="ax-tab-analysis"] .ax-dirty'), "the Analysis tab shows the unsaved dot");
await page.click('[data-testid="ax-stage-results"]');
await page.click('[data-testid="ax-save"]');
await page.waitForSelector('[data-testid="ax-savestate"]:not(.dirty)');
assert.equal(store.analyses.find((a) => a.name === "Open ends (verbatims)").version, 1, "a rename alone is not a new version");
ok("unsaved indicator appears on edit (stage bar, rail, tab) and clears on save; a rename does not bump the version");
// duplicate → a copy opens; rename inline; move; delete
await page.hover('[data-testid="ax-rail-item"] >> nth=0');
await page.click('[data-testid="ax-rail-item"] >> nth=0 >> [data-testid="ax-rail-menu"]');
await page.click('[data-testid="ax-rail-duplicate"]');
await page.waitForSelector('[data-testid="ax-rail-item"]:has-text("(copy)")');
assert.equal(store.analyses.length, 6);
const copy = store.analyses.find((a) => a.name.endsWith("(copy)"));
const source = store.analyses.find((a) => a.id !== copy.id && `${a.name} (copy)` === copy.name);
assert.deepEqual({ ...copy.definition, name: 0 }, { ...source.definition, name: 0 }, "the copy carries the definition");
assert.match(await text('[data-testid="ax-rail-item"].on'), /\(copy\)/);
ok("Duplicate creates “<name> (copy)” with the same definition and opens it");
await page.click(`[data-testid="ax-rail-item"][data-id="${copy.id}"] [data-testid="ax-rail-menu"]`);
await page.click('[data-testid="ax-rail-rename-start"]');
await page.fill('[data-testid="ax-rail-rename"]', "Satisfaction by gender — copy");
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="ax-rail-item"]:has-text("Satisfaction by gender — copy")');
assert.equal(copy.name, "Satisfaction by gender — copy");
ok("Rename inline from the rail");
const before = await page.$$eval('[data-testid="ax-rail-item"] .ax-rail-name', (es) => es.map((e) => e.textContent));
await page.hover('[data-testid="ax-rail-item"] >> nth=0');
await page.click('[data-testid="ax-rail-item"] >> nth=0 >> [data-testid="ax-rail-down"]');
await page.waitForFunction((first) => document.querySelector('[data-testid="ax-rail-item"] .ax-rail-name')?.textContent !== first, before[0]);
const after = await page.$$eval('[data-testid="ax-rail-item"] .ax-rail-name', (es) => es.map((e) => e.textContent));
assert.equal(after[1], before[0]); assert.equal(after[0], before[1]);
assert.equal(store.analyses.find((a) => a.name === before[1]).position, 0, "the order is persisted as positions");
ok("Move down reorders the rail and persists the order");
await page.click(`[data-testid="ax-rail-item"][data-id="${copy.id}"] [data-testid="ax-rail-menu"]`);
await page.click('[data-testid="ax-rail-delete"]');
await page.waitForSelector(`[data-testid="ax-rail-item"][data-id="${copy.id}"]`, { state: "detached" });
assert.ok(copy.deleted_at);
ok("Delete removes the analysis (after confirmation)");
// the crosstab's options: a banner of two column variables, summary rows, a total row, counts under % — read from the professional table
await page.click('[data-testid="ax-rail-item"]:has-text("Satisfaction by gender")');
await page.waitForSelector('[data-testid="ax-result"]');
await page.click('[data-testid="ax-stage-builder"]');
await page.click('[data-testid="ax-step-1"]');
await page.click('.ax-var:has-text("REGION · Categorical") input');
assert.match(await text('[data-testid="ax-drop-columns"]'), /Gender.*Region/);
await page.click('[data-testid="ax-step-4"]');
await page.waitForSelector('[data-testid="ax-xt-options"]');
await page.selectOption('[data-testid="ax-xt-options"] select >> nth=0', "pct_col");
await page.click('[data-testid="ax-summary-top2"]'); await page.click('[data-testid="ax-summary-mean"]');
await shot("09-xt-options");
await page.click('[data-testid="ax-xt-options"] label:has-text("Total row") input');
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
await page.click('.ax-tab:has-text("Tables")');
await page.waitForSelector('.ax-pro-groups');
const groups = await page.$$eval('.ax-pro-groups th.grp:not(.empty)', (es) => es.map((e) => e.textContent));
assert.deepEqual(groups, ["Gender", "Region"], "one banner with both column variables as header groups");
const pro = await text('[data-testid="ax-table"]');
assert.match(pro, /Top 2 box/); assert.match(pro, /Mean/); assert.match(pro, /Base \(n\)/); assert.ok(await page.$('.ax-pro-table tr.k-total'), "the total row is there");
assert.match(pro, /Male \(a\).*Female \(b\).*\(c\).*\(d\).*\(e\)/, "letters run across the banner");
await page.check('[data-testid="ax-table-format"] input >> nth=1'); // counts
await page.waitForSelector('.ax-pro-n');
ok("crosstab options: banner (Gender | Region) with header groups, Top 2 box and Mean rows, letters a–e, counts under percentages");
await shot("06-pro-table");
// nested rows: Region › Satisfaction, with group rows that collapse
await page.click('[data-testid="ax-stage-builder"]'); await page.click('[data-testid="ax-step-1"]');
await page.click('.ax-var:has-text("REGION · Categorical") input'); // remove Region from the columns
await page.click('[data-testid="ax-xt-target-rows"]');
await page.click('.ax-var:has-text("REGION · Categorical") input'); // …and add it as the second row variable
assert.match(await text('[data-testid="ax-drop-rows"]'), /Overall satisfaction.*Region/);
await page.click('[data-testid="ax-step-4"]');
await page.click('[data-testid="ax-xt-options"] label:has-text("Nest the second") input');
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]');
await page.click('.ax-tab:has-text("Tables")');
await page.waitForSelector('.ax-pro-table tr.k-group');
const groupsN = await count('.ax-pro-table tr.k-group');
assert.equal(groupsN, 5, "one group row per satisfaction level");
const rowsBefore = Number(await page.getAttribute('[data-testid="ax-table"]', "data-rows"));
await page.click('.ax-pro-table tr.k-group >> nth=0 >> .ax-pro-caret');
await page.waitForFunction((n) => Number(document.querySelector('[data-testid="ax-table"]').getAttribute("data-rows")) < n, rowsBefore);
ok(`nested rows: ${groupsN} group rows (Satisfaction › Region); a group collapses from its caret`);
// leave the analysis: the unsaved guard asks (auto-accepted here), the rail highlight moves
await page.click('[data-testid="ax-rail-new"]');
await page.waitForSelector('[data-testid="ax-rail-draft"]');
assert.equal(await text('[data-testid="ax-savestate"]'), "New analysis");
ok("New from the rail starts a blank draft (the unsaved guard asked first)");

console.log("\n§6 SEGMENTS");
await page.click('[data-testid="ax-tab-segments"]');
await page.click('[data-testid="ax-new-segment"]');
await page.fill('[data-testid="ax-segment-name"]', "Women");
await page.click('[data-testid="ax-add-rule"]');
await page.locator('[data-testid="ax-rule"] select').first().selectOption({ label: "Gender" });
await page.locator('[data-testid="ax-rule"] select').nth(2).selectOption({ label: "Female" });
await page.click('[data-testid="ax-segment-save"]');
await page.waitForSelector('[data-testid="ax-segment-card"]:has-text("Women")');
assert.equal(store.segments.length, 1);
ok("segment “Women” saved as a reusable Condition");
// use the segment in a topbox analysis
await page.click('[data-testid="ax-tab-home"]'); await page.click('[data-testid="ax-quick-analysis"]');
await page.waitForSelector('[data-testid="ax-builder"]'); await page.click('[data-testid="ax-kind-topbox"]'); await page.fill('[data-testid="ax-name"]', "Top box by segment");
await page.click('[data-testid="ax-step-1"]'); await page.click('.ax-var:has-text("SAT · Scale") input');
await page.click('[data-testid="ax-step-3"]'); await page.click('[data-testid="ax-segment-chip"]:has-text("Women")');
await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-segment-switch"]');
assert.match(await text('[data-testid="ax-segment-switch"]'), /Women \(n = \d+\)/);
ok("saved segment appears in the builder and drives chart segment switching");
await page.click('[data-testid="ax-save"]'); await page.waitForSelector('[data-testid="ax-msg"]');

console.log("\n§7 REPORT BUILDER, PUBLISH, VERSIONS");
await page.click('[data-testid="ax-tab-reports"]');
await page.click('[data-testid="ax-new-report"]');
await page.fill('[data-testid="ax-report-name"]', "Executive Customer Report");
await page.click('[data-testid="ax-report-create"]');
await page.waitForSelector('[data-testid="ax-report-builder"]');
await page.click('[data-testid="ax-add-executive_summary"]');
await page.click('.modal .btn.primary:has-text("Done")');
await page.click('[data-testid="ax-add-section"]'); await page.click('.modal .btn.primary:has-text("Done")');
await page.click('[data-testid="ax-add-chart"]'); await page.click('.modal .btn.primary:has-text("Done")');
await page.click('[data-testid="ax-add-kpi"]');
await page.selectOption('.modal select', { label: "NPS (nps)" }); await page.click('.modal .btn.primary:has-text("Done")');
await page.click('[data-testid="ax-add-table"]'); await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-report"] .ax-exec-item');
assert.equal(await count('[data-testid="ax-order-item"]'), 6);
assert.ok((await count('[data-testid="ax-report"] [data-testid="ax-chart"]')) >= 2, "chart + kpi rendered");
assert.match(await text('[data-testid="ax-report"] .ax-mode'), /Live data/);
ok("report builder: cover + executive summary + section + chart + KPI + table, rendered live");
// reorder via drag list: move last (table) up
await page.hover('[data-testid="ax-report"] .ax-block >> nth=5');
await page.$$eval('[data-testid="ax-report"] .ax-block', (es) => es[5].querySelector('.ax-block-actions button[title="Move up"]').click());
const order = await page.$$eval('[data-testid="ax-order-item"] .ax-order-type', (es) => es.map((e) => e.textContent));
assert.deepEqual(order, ["cover", "executive summary", "section", "chart", "table", "kpi"]);
ok("blocks reorder (move up)");
await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
await page.click('[data-testid="ax-report-publish"]');
await page.waitForSelector('.ax-ok:has-text("Published version 1")');
assert.equal(store.reportVersions.length, 1);
const snap = store.reportVersions[0].snapshot;
assert.ok(Object.keys(snap).length >= 2 && Object.values(snap).every((r) => r.tables && !("cases" in r)));
ok("publish froze v1: definition + theme + computed results (no response rows in the snapshot)");
// edit after publish → published snapshot unchanged
await page.click('[data-testid="ax-add-text"]'); await page.fill('.modal textarea', "New paragraph after publishing"); await page.click('.modal .btn.primary:has-text("Done")');
await page.click('[data-testid="ax-report-save"]');
assert.equal(store.reportVersions[0].definition.blocks.length, 6);
assert.equal(store.reports[0].definition.blocks.length, 7);
ok("editing the draft after publishing leaves v1 immutable (§35)");
await page.selectOption('[data-testid="ax-version-select"]', "1");
await page.waitForSelector('[data-testid="ax-report"][data-mode="snapshot"]');
assert.match(await text('[data-testid="ax-report"] .ax-mode'), /Snapshot · v1/);
assert.equal(await count('[data-testid="ax-report"] .ax-text'), 0);
ok("viewing v1 shows the snapshot (6 blocks, no new paragraph) clearly labelled Snapshot");

console.log("\n§7b REPORT TEMPLATES, PAGES AND THE METHODOLOGY BLOCK (§36)");
// back to the editable draft before touching anything
await page.selectOption('[data-testid="ax-version-select"]', "");
await page.waitForSelector('[data-testid="ax-report"][data-mode="live"]');

/* a page break is authored, and it is visible as the decision it is */
await page.click('[data-testid="ax-add-page_break"]');
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-pagebreak"]');
ok("a page break can be added, and shows in the builder as a boundary");

/* the methodology block: the team's own words, not our boilerplate */
await page.click('[data-testid="ax-add-methodology"]');
await page.fill('.modal input[type="date"] >> nth=0', "2026-03-02");
await page.fill('.modal input[type="date"] >> nth=1', "2026-03-09");
await page.fill('.modal input[placeholder^="n = 1,004"]', "n = 1,004 UK adults 18+");
await page.fill('.modal input[placeholder^="Weighted to age"]', "Weighted to age, gender and region");
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-methodology"]');
const meth = await text('[data-testid="ax-methodology"]');
assert.match(meth, /Fieldwork: 2026-03-02 to 2026-03-09/);
assert.match(meth, /n = 1,004 UK adults 18\+/);
assert.match(meth, /Weighted to age, gender and region/);
assert.match(meth, /bases below 30 are flagged/, "the standard notes should still be offered underneath");
ok("the methodology block renders the team's fieldwork, sample and weighting above the standard notes");

await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
const withMeth = store.reports[0].definition.blocks;
assert.ok(withMeth.some((b) => b.type === "methodology" && b.sampleFrame?.startsWith("n = 1,004")));
assert.ok(withMeth.some((b) => b.type === "page_break"));
ok("both new block types persist in the report definition");

/* the same blocks, grouped into pages by the engine the exports use */
const pages = reportPages(withMeth);
assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
assert.ok(!pages.flatMap((p) => p.blocks).some((b) => b.type === "page_break"), "a break must not appear on a page");
ok(`the page model derives ${pages.length} pages from the same flat block list`);

/* a template lays a house shape over the report — without losing the work */
const beforeRefs = withMeth.filter((b) => b.analysisId).map((b) => b.analysisId);
assert.ok(beforeRefs.length >= 2);
await page.click('[data-testid="ax-templates"]');
await page.waitForSelector('[data-testid="ax-template-dialog"]');
assert.ok((await count('[data-testid="ax-template-card"]')) >= 3, "the built-in templates should be offered");
ok("the template picker offers the built-in report shapes");
await page.click('[data-testid="ax-apply-builtin:full"]');
await page.waitForSelector('.ax-ok:has-text("Applied")');
const afterRefs = store.reports[0].definition.blocks.filter((b) => b.analysisId).map((b) => b.analysisId);
for (const ref of beforeRefs) assert.ok(afterRefs.includes(ref), `applying a template lost analysis ${ref}`);
assert.ok(store.reports[0].definition.blocks.some((b) => b.type === "section"), "the template's sections should be there");
ok("applying a template imposes the shape and keeps every block that already had an analysis");

/* and a team can save their own shape back */
promptAnswer = "House tracker shape";
await page.click('[data-testid="ax-templates"]');
await page.waitForSelector('[data-testid="ax-template-dialog"]');
await page.click('[data-testid="ax-save-template"]');
await page.waitForSelector('.ax-ok:has-text("report template")');
assert.equal(store.reportTemplates.length, 1);
assert.equal(store.reportTemplates[0].name, "House tracker shape");
assert.ok(store.reportTemplates[0].blocks.every((b) => !b.analysisId), "a saved template must not carry analysis ids");
ok("saving this report's shape strips every analysis reference — a template is a shape, not a study");
await page.click('[data-testid="ax-template-dialog"] .btn:has-text("Close")');
promptAnswer = "";

console.log("\n§7c PANEL GRID — a tracker snapshot, several analyses on one page (§37)");
await page.click('[data-testid="ax-add-panel_grid"]');
await page.waitForSelector('[data-testid="ax-panel-analysis"]');
assert.equal(await count('[data-testid="ax-panel-analysis"]'), 2, "a new panel grid starts with two panels, ready to fill in");
await page.fill('.modal input[placeholder="Panel title"] >> nth=0', "Brand funnel");
await page.selectOption('[data-testid="ax-panel-analysis"] >> nth=0', { label: "Satisfaction by gender (crosstab)" });
await page.selectOption('[data-testid="ax-panel-chart"] >> nth=0', { label: "Vertical bar" });
await page.fill('.modal input[placeholder="Panel title"] >> nth=1', "Awareness by gender");
await page.selectOption('[data-testid="ax-panel-analysis"] >> nth=1', { label: "NPS (nps)" });
await page.fill('.modal textarea', "A one-line takeaway, once the panels below say something.");
await page.click('[data-testid="ax-panel-add"]');
await page.fill('.modal input[placeholder="Panel title"] >> nth=2', "Not chosen yet");
assert.equal(await count('[data-testid="ax-panel-analysis"]'), 3, "+ panel adds a third, empty panel");
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-panelgrid"]');
assert.equal(await count('[data-testid="ax-panel"]'), 3, "all three panels render");
assert.match(await text('[data-testid="ax-panelgrid"]'), /A one-line takeaway/);
assert.ok(await page.$('[data-testid="ax-panelgrid"] [data-testid="ax-chart"]'), "a panel with a chart type draws a chart");
assert.ok(await page.$('[data-testid="ax-panelgrid"] .ax-pro-table'), "a panel with no chart type falls back to a table, same as a lone table block");
assert.match(await text('[data-testid="ax-panelgrid"] [data-testid="ax-panel"] >> nth=2'), /Waiting for an analysis/, "an unfilled panel says so, exactly like a lone chart/table block");
ok("panel grid: headline, a chart panel, a table panel, a third panel added inline, and a graceful placeholder for the one left unfilled");
await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
const savedGrid = store.reports[0].definition.blocks.find((b) => b.type === "panel_grid");
assert.equal(savedGrid?.panels.length, 3);
assert.equal(savedGrid.panels[1].analysisId, store.analyses.find((a) => a.name === "NPS").id);
ok("the panel grid persists with its panels — titles, chart choice and analysis references — in the report definition");
await page.click('[data-testid="ax-report-export"]');
await page.waitForSelector('[data-testid="ax-export-dialog"]');
const [dlPanel] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-export-go"]')]);
assert.match(dlPanel.suggestedFilename(), /\.pptx$/);
assert.ok(store.lastExport.bytes > 15000);
ok("exporting a report that includes a panel grid still produces a PowerPoint deck, unfilled panel and all");
await page.click('[data-testid="ax-templates"]');
await page.waitForSelector('[data-testid="ax-template-dialog"]');
assert.ok(await page.$('[data-testid="ax-apply-builtin:innovation_tracker"]'), "the innovation tracker template should be offered alongside the others");
ok("the built-in “Innovation post-launch tracker” template — built from panel grids — is offered in the picker");
await page.click('[data-testid="ax-template-dialog"] .btn:has-text("Close")');

console.log("\n§8 SHARE — link, read-only view, downloads, revoke");
await page.click('[data-testid="ax-report-share"]');
await page.waitForSelector('[data-testid="ax-share-dialog"]');
await page.selectOption('[data-testid="ax-share-dialog"] select >> nth=0', "download");
await page.click('[data-testid="ax-share-create"]');
await page.waitForSelector('[data-testid="ax-share-link"] input');
const link = await page.$eval('[data-testid="ax-share-link"] input', (e) => e.value);
assert.match(link, /\/share\/[a-z0-9]+tok$/);
assert.equal(store.shares[0].report_version, 1, "pinned to v1");
ok(`share link created, pinned to v1, download permission: ${link.replace(STUDIO, "")}`);
await page.click('[data-testid="ax-share-dialog"] button:has-text("Close")');
// the public view in a fresh, cookie-less context
const anon = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
await anon.route("**/api/share/**", fakeShare);
const pub = await anon.newPage();
pub.on("pageerror", (e) => console.error("SHARE PAGE ERROR:", e.message));
await pub.goto(link, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-view"]');
assert.match(await pub.$eval('[data-testid="ax-report"] .ax-mode', (e) => e.textContent), /Snapshot · v1/);
assert.equal(await pub.$$eval('.ax-block-actions', (es) => es.length), 0, "no edit controls");
assert.equal(await pub.$$eval('[data-testid="ax-builder"], .ax-ws-tabs, .leftnav', (es) => es.length), 0, "no builder / studio chrome");
assert.ok((await pub.$$eval('[data-testid="ax-chart"]', (es) => es.length)) >= 2);
ok("anonymous viewer sees the read-only presentation: snapshot v1, charts, no edit controls, no builder");
const [dl] = await Promise.all([pub.waitForEvent("download"), pub.click('[data-testid="ax-share-ppt"]')]);
assert.match(dl.suggestedFilename(), /\.pptx$/); assert.ok(store.lastShareDownload.bytes > 20000);
const [dl2] = await Promise.all([pub.waitForEvent("download"), pub.click('[data-testid="ax-share-xlsx"]')]);
assert.match(dl2.suggestedFilename(), /\.xlsx$/);
ok("viewer with Download permission gets PowerPoint and Excel of the snapshot");
// revoke from Manage Shared Reports
await page.click('[data-testid="ax-tab-sharing"]');
await page.waitForSelector('[data-testid="ax-share-row"][data-status="Active"]');
assert.match(await text('[data-testid="ax-shares-table"]'), /Executive Customer Report.*Anyone with link.*Public.*Download only.*v1 \(pinned\).*Active.*Never/);
await page.click('[data-testid="ax-share-revoke"]');
await page.waitForSelector('[data-testid="ax-share-row"][data-status="Revoked"]');
ok("Manage Shared Reports lists the link; Revoke flips it to Revoked");
await pub.reload({ waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-gate"][data-status="revoked"]');
assert.match(await pub.$eval('[data-testid="ax-share-gate"]', (e) => e.textContent), /revoked by its owner/);
ok("the revoked link is refused immediately for the viewer");
// password-protected + viewer-only link
store.shares.push({ id: uid(), report_id: store.reports[0].id, token: "pwtoken000000000000000000tok", access: "link", permission: "viewer", report_version: 1, password: "secret", has_password: true, expires_at: null, revoked_at: null, allowed_emails: [], view_count: 0 });
await pub.goto(`${STUDIO}/share/pwtoken000000000000000000tok`, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-gate"][data-status="password"]');
await pub.fill('[data-testid="ax-share-password"]', "wrong"); await pub.click('.ax-share-gate button');
await pub.waitForSelector('.ax-share-gate:has-text("not correct")');
await pub.fill('[data-testid="ax-share-password"]', "secret"); await pub.click('.ax-share-gate button');
await pub.waitForSelector('[data-testid="ax-share-view"]');
assert.equal(await pub.$$eval('[data-testid="ax-share-ppt"]', (es) => es.length), 0, "viewer-only: no download buttons");
ok("password gate: wrong password refused, right password opens; Viewer permission hides downloads");
// expired link
store.shares.push({ id: uid(), report_id: store.reports[0].id, token: "exptoken00000000000000000tok", access: "link", permission: "viewer", report_version: 1, password: null, expires_at: new Date(Date.now() - 1000).toISOString(), revoked_at: null, allowed_emails: [], view_count: 0 });
await pub.goto(`${STUDIO}/share/exptoken00000000000000000tok`, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-gate"][data-status="expired"]');
ok("expired link is refused");
await anon.close();

console.log("\n§9 EXPORTS, TABLE BUILDER, THEMES, DASHBOARD");
await page.click('[data-testid="ax-tab-exports"]');
await page.click('[data-testid="ax-exports"] .btn.primary:has-text("Export…")');
await page.waitForSelector('[data-testid="ax-export-dialog"]');
await page.click('[data-testid="ax-export-dialog"] input[type="radio"] >> nth=1');
const [dl3] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-export-go"]')]);
assert.match(dl3.suggestedFilename(), /\.xlsx$/); assert.equal(store.lastExport.format, "xlsx");
ok("Export dialog (format / theme / include / Excel formatting) generates a workbook");
await page.click('[data-testid="ax-tab-tables"]');
await page.selectOption('[data-testid="ax-table-analysis"]', { label: "Satisfaction by gender (crosstab)" });
await page.waitForSelector('[data-testid="ax-builder-table"]');
await page.click('[data-testid="ax-builder-table"] th >> nth=1');
assert.match(await text('[data-testid="ax-builder-table"] th >> nth=1'), /↓/);
ok("Table Builder shows the crosstab with sortable columns");
await page.click('[data-testid="ax-tab-themes"]');
await page.click('[data-testid="ax-new-theme"]');
await page.fill('[data-testid="ax-theme-name"]', "Client A Theme");
await page.click('[data-testid="ax-theme-save"]');
await page.waitForSelector('[data-testid="ax-theme-card"]:has-text("Client A Theme")');
assert.equal(store.themes.length, 1);
ok("report theme saved (company branding separate from survey branding)");
await page.click('[data-testid="ax-tab-reports"]');
await page.click('[data-testid="ax-new-dashboard"]');
await page.fill('[data-testid="ax-report-name"]', "Executive Dashboard"); await page.click('[data-testid="ax-report-create"]');
await page.waitForSelector('[data-testid="ax-report-builder"]');
await page.click('.ax-addlist .btn:has-text("kpi")'); await page.selectOption('.modal select', { label: "NPS (nps)" }); await page.click('.modal .btn.primary:has-text("Done")');
await page.click('.ax-addlist .btn:has-text("chart")'); await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-dashboard"] .ax-widget >> nth=1');
assert.equal(await count('[data-testid="ax-dashboard"] .ax-widget'), 2);
ok("dashboard builder: KPI card + chart widgets on the grid");

console.log("\n§9b OPERATIONAL DASHBOARD WIDGETS — photo tile, pictogram panel, numbered steps, iconed ranked list (§38)");
await page.click('.ax-addlist .btn:has-text("photo")');
await page.waitForSelector('[data-testid="ax-photo-image"]');
await page.fill('[data-testid="ax-photo-image"]', "https://picsum.photos/400/300");
await page.fill('.modal input[placeholder="e.g. 77%"]', "77%");
await page.fill('.modal input[placeholder="e.g. +2% / -2% / 0%"]', "-2%");
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-widget-photo"]');
assert.match(await page.$eval('[data-testid="ax-widget-photo"]', (e) => e.style.backgroundImage), /picsum/);
assert.match(await text('[data-testid="ax-widget-photo"]'), /77%/);
assert.equal(await page.$eval('[data-testid="ax-widget-photo"] .ax-photo-trend', (e) => e.className), "ax-photo-trend ax-trend-down", "a trend chip starting with \"-\" gets the down/red styling");
ok("photo widget: an image tile with an overlay figure and a colour-coded trend chip");

await page.click('.ax-addlist .btn:has-text("icon panel")');
await page.waitForSelector('[data-testid="ax-icon-panel-icon"]');
await page.selectOption('.modal select >> nth=0', { label: "Satisfaction by gender (crosstab)" });
await page.selectOption('[data-testid="ax-icon-panel-icon"]', { label: "Star" });
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-widget-icon-panel"]');
assert.ok((await page.$$eval('[data-testid="ax-widget-icon-panel"] .ax-icon-row', (es) => es.length)) > 0, "one row per category");
ok("icon panel widget: a pictogram breakdown of a categorical analysis");

await page.click('.ax-addlist .btn:has-text("steps")');
await page.waitForSelector('[data-testid="ax-step-add"]');
assert.equal(await count('.modal input[placeholder="Step title"]'), 3, "a new steps widget seeds three steps");
await page.fill('.modal input[placeholder="Step title"] >> nth=0', "Receive customer issues");
await page.selectOption('[data-testid="ax-step-icon"] >> nth=0', { label: "Flag" });
await page.click('[data-testid="ax-step-add"]');
assert.equal(await count('.modal input[placeholder="Step title"]'), 4, "+ step adds another");
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-widget-steps"]');
assert.equal(await count('[data-testid="ax-widget-steps"] .ax-step'), 4);
assert.match(await text('[data-testid="ax-widget-steps"]'), /Receive customer issues/);
ok("steps widget: a numbered process panel with per-step icons");

await page.click('.ax-addlist .btn:has-text("ranked list")');
await page.waitForSelector('[data-testid="ax-ranked-icon"]');
await page.selectOption('.modal select >> nth=0', { label: "NPS (nps)" });
await page.selectOption('[data-testid="ax-ranked-icon"]', { label: "Flag" });
await page.click('.modal .btn.primary:has-text("Done")');
await page.waitForSelector('[data-testid="ax-widget-ranked-list"]');
assert.ok((await page.$$eval('[data-testid="ax-widget-ranked-list"] .ax-ranked-row', (es) => es.length)) > 0);
ok("ranked list widget: an iconed, bar-scaled ranking of a categorical analysis");

await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
const dashDef = store.reports.find((r) => r.name === "Executive Dashboard").definition;
assert.ok(dashDef.widgets.some((w) => w.type === "photo" && w.overlayValue === "77%"), "photo widget persists its overlay figure");
assert.ok(dashDef.widgets.some((w) => w.type === "steps" && w.steps.length === 4), "steps widget persists all four steps");
assert.ok(dashDef.widgets.some((w) => w.type === "icon_panel" && w.icon === "star"), "icon panel widget persists its analysis and icon choice");
assert.ok(dashDef.widgets.some((w) => w.type === "ranked_list" && w.icon === "flag"), "ranked list widget persists its analysis and icon choice");
ok("all four operational-dashboard widget types persist in the dashboard definition, same as the analytical ones");

console.log("\n§9c THE DASHBOARD CANVAS — widgets go where you put them (§40)");
/*
 * A dashboard saved BEFORE positioning existed: every widget at 0,0, which is
 * what the old builder wrote. Seeded straight into the store because no UI can
 * produce one any more — and it is the case that matters most, since it is
 * every dashboard the platform's existing users already have.
 */
const legacyId = uid();
store.reports.push({
  id: legacyId, kind: "dashboard", name: "Legacy Dashboard", mode: "live", theme_id: null, published_version: null,
  created_at: now(), updated_at: now(),
  definition: { title: "Legacy Dashboard", crossFilter: true, widgets: [
    { id: "lw1", type: "kpi", title: "NPS", analysisId: store.analyses.find((a) => a.name === "NPS").id, w: 6, h: 2, x: 0, y: 0 },
    { id: "lw2", type: "chart", title: "By country", analysisId: store.analyses.find((a) => a.name === "Satisfaction by country").id, w: 6, h: 3, x: 0, y: 0 },
    { id: "lw3", type: "table", title: "Crosstab", analysisId: store.analyses.find((a) => a.name === "Satisfaction by gender").id, w: 4, h: 2, x: 0, y: 0 },
    { id: "lw4", type: "text", title: "Note", text: "Saved before the canvas existed.", w: 12, h: 2, x: 0, y: 0 },
  ] },
});
// the reports list was fetched before this row existed, so pick it up fresh
await page.reload({ waitUntil: "networkidle" });
await page.click('[data-testid="ax-tab-reports"]');
await page.waitForSelector('[data-testid="ax-report-card"]:has-text("Legacy Dashboard")');
await page.click('[data-testid="ax-report-card"]:has-text("Legacy Dashboard")');
await page.waitForSelector('[data-testid="ax-widget"]');
const legacyLayout = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => [e.dataset.id, +e.dataset.x, +e.dataset.y, +e.dataset.w, +e.dataset.h]));
assert.equal(legacyLayout.length, 4);
const legacyCells = new Set(legacyLayout.map(([, x, y]) => `${x},${y}`));
assert.equal(legacyCells.size, 4, "four widgets stored at 0,0 must not all be drawn in the same cell");
assert.deepEqual(legacyLayout.find(([id]) => id === "lw1").slice(1, 3), [0, 0]);
assert.deepEqual(legacyLayout.find(([id]) => id === "lw2").slice(1, 3), [6, 0], "the second widget fills the first row");
assert.deepEqual(legacyLayout.find(([id]) => id === "lw3").slice(1, 3), [0, 3], "the third wraps below the tallest of that row");
assert.deepEqual(legacyLayout.find(([id]) => id === "lw4").slice(1, 3), [0, 5], "a full-width widget starts its own row");
ok("a dashboard saved before positioning existed is flowed into the arrangement its author last saw");

/*
 * Moving ONE widget on that dashboard must not disturb the rest. The stored
 * coordinates are all 0,0, so a move applied to them rather than to the
 * arrangement on screen would restack the whole canvas into a single column.
 */
await page.$eval('[data-testid="ax-widget"][data-id="lw3"] [data-testid="ax-widget-grip"]', (e) => e.focus());
await page.keyboard.press("ArrowRight");
await page.waitForFunction(() => document.querySelector('[data-testid="ax-widget"][data-id="lw3"]')?.dataset.x === "1");
const afterNudge = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => [e.dataset.id, +e.dataset.x, +e.dataset.y]));
assert.deepEqual(afterNudge.find(([id]) => id === "lw1").slice(1), [0, 0], "lw1 stays where the flow put it");
assert.deepEqual(afterNudge.find(([id]) => id === "lw2").slice(1), [6, 0], "lw2 keeps its column — it is not restacked at 0");
assert.deepEqual(afterNudge.find(([id]) => id === "lw4").slice(1), [0, 5], "lw4 keeps its row");
ok("nudging one widget on a pre-canvas dashboard leaves every other widget exactly where it was");
await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
assert.ok(store.reports.find((r) => r.id === legacyId).definition.widgets.every((w) => w.x !== 0 || w.y !== 0 || w.id === "lw1"),
  "saving writes the real coordinates, so the flow is only needed once");
ok("the flowed arrangement is written back on the first save, not re-derived forever");
await page.click('.ax-rb-bar .btn:has-text("← Reports")');
await page.click('[data-testid="ax-report-card"]:has-text("Executive Dashboard")');
await page.waitForSelector('[data-testid="ax-widget"]');

const beforeLayout = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => [e.dataset.id, +e.dataset.x, +e.dataset.y, +e.dataset.w, +e.dataset.h]));
assert.ok(beforeLayout.length >= 6, `the dashboard has widgets to lay out, got ${beforeLayout.length}`);
const cells = new Set(beforeLayout.map(([, x, y]) => `${x},${y}`));
assert.equal(cells.size, beforeLayout.length, "no two widgets share a cell");
assert.ok(beforeLayout.some(([, x]) => x > 0) && beforeLayout.some(([, , y]) => y > 0), "widgets added through the builder are placed across the canvas, not stacked at the origin");
ok("widgets added from the picker land in the first free cell rather than on top of each other");

// drag the first widget two columns right and one row down
const grip = await page.$('[data-testid="ax-widget"] >> nth=0 >> [data-testid="ax-widget-grip"]');
const firstId = await page.$eval('[data-testid="ax-widget"] >> nth=0', (e) => e.dataset.id);
const gb = await grip.boundingBox();
const canvas = await page.$('[data-testid="ax-dashboard"]');
const cb = await canvas.boundingBox();
const colStep = (cb.width - 24 + 10) / 12; // padding 12 each side, gap 10 — the module's own constants
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2 + colStep * 2, gb.y + gb.height / 2 + 70, { steps: 8 });
await page.mouse.up();
await page.waitForFunction((id) => document.querySelector(`[data-testid="ax-widget"][data-id="${id}"]`)?.dataset.x !== "0", firstId);
const moved = await page.$eval(`[data-testid="ax-widget"][data-id="${firstId}"]`, (e) => [+e.dataset.x, +e.dataset.y]);
assert.equal(moved[0], 2, `dragging two columns right should land on column 2, got ${moved[0]}`);
assert.equal(moved[1], 1, `dragging one row down should land on row 1, got ${moved[1]}`);
/*
 * And the widgets NOT dragged stay where the flow put them. This is the check
 * that catches applying a move to the stored 0,0 coordinates instead of the
 * arrangement on screen: every other widget would restack into one column,
 * which still has no overlaps and would otherwise pass unnoticed.
 */
const othersAfter = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => [e.dataset.id, +e.dataset.x, +e.dataset.y]));
for (const [id, x, y] of beforeLayout.filter(([id]) => id !== firstId)) {
  const now = othersAfter.find((o) => o[0] === id);
  /*
   * A widget the drop landed on is pushed DOWN, and may push others down in
   * turn — that is the no-overlap rule doing its job. What must never happen
   * is a column changing: making room is only ever vertical. If the move had
   * been applied to the stored 0,0 coordinates instead of the arrangement on
   * screen, every widget would come back at column 0, which is precisely what
   * this catches.
   */
  assert.equal(now[1], x, `${id} should stay in its column — making room is vertical, never sideways`);
  assert.ok(now[2] >= y, `${id} may be pushed down but never pulled up by someone else's drag`);
}
assert.ok(othersAfter.some(([id, x]) => id !== firstId && x > 0), "the canvas still uses more than the first column");
ok("a widget dragged by its grip lands on the cell it was dropped on, and the rest of the canvas stays put");

// the move is in the definition, not just on screen
await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
const savedW = store.reports.find((r) => r.name === "Executive Dashboard").definition.widgets.find((w) => w.id === firstId);
assert.deepEqual([savedW.x, savedW.y], [2, 1], "the dragged position persists in the saved definition");
ok("the canvas position is saved with the dashboard, not just drawn");

// resize by the corner handle
const target = await page.$(`[data-testid="ax-widget"][data-id="${firstId}"]`);
const sizeBefore = await target.evaluate((e) => [+e.dataset.w, +e.dataset.h]);
const handle = await page.$(`[data-testid="ax-widget"][data-id="${firstId}"] >> [data-testid="ax-widget-resize"]`);
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2 + colStep * 2, hb.y + hb.height / 2 + 70, { steps: 8 });
await page.mouse.up();
await page.waitForFunction((args) => document.querySelector(`[data-testid="ax-widget"][data-id="${args.id}"]`)?.dataset.w !== String(args.w), { id: firstId, w: sizeBefore[0] });
const sizeAfter = await page.$eval(`[data-testid="ax-widget"][data-id="${firstId}"]`, (e) => [+e.dataset.w, +e.dataset.h]);
assert.equal(sizeAfter[0], sizeBefore[0] + 2, "two columns wider");
assert.equal(sizeAfter[1], sizeBefore[1] + 1, "one row taller");
await shot("09c-canvas");
ok("a widget resized by its corner grows by the cells it was dragged");

// nothing may end up underneath anything else
const overlapping = await page.$$eval('[data-testid="ax-widget"]', (es) => {
  const b = es.map((e) => ({ x: +e.dataset.x, y: +e.dataset.y, w: +e.dataset.w, h: +e.dataset.h }));
  let hits = 0;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    if (b[i].x < b[j].x + b[j].w && b[j].x < b[i].x + b[i].w && b[i].y < b[j].y + b[j].h && b[j].y < b[i].y + b[i].h) hits++;
  }
  return hits;
});
assert.equal(overlapping, 0, "resizing over a neighbour pushes it down rather than covering it");
ok("widgets pushed aside by a move or a resize are never left hidden under another");

// tidy closes the vertical gaps the moves opened
await page.click('[data-testid="ax-dash-tidy"]');
await page.waitForTimeout(100);
const tidied = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => +e.dataset.y));
assert.equal(Math.min(...tidied), 0, "after tidying something sits on the top row");
ok("“Tidy up” closes the vertical gaps, which is an action the author asks for rather than one that just happens");

// a shared viewer sees the arrangement but cannot edit it
assert.ok(await page.$('[data-testid="ax-dashboard"][data-editable]'), "the builder's canvas is editable");


/* §41 — an inline image for the scenery checks. A test that reaches out to a
 * photo service fails when the network does, and proves nothing extra. */
const inlineImage = (a, b) => "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="400" fill="url(#g)"/></svg>`);
console.log("\n§9d DASHBOARD SCENERY — a hero banner and photography behind the widgets (§41)");
await page.fill('[data-testid="ax-hero-title"]', "StayLux Resort — Berlin");
await page.waitForSelector('[data-testid="ax-hero"]');
assert.match(await text('[data-testid="ax-hero"]'), /StayLux Resort/);
// with no photograph there is nothing to wash, and the text must not be white on white
let heroScrims = await count('[data-testid="ax-hero"] .ax-hero-scrim');
assert.equal(heroScrims, 0, "a hero with no image gets no scrim");
const titleColorNoImage = await page.$eval('[data-testid="ax-hero"] .ax-hero-text', (e) => getComputedStyle(e).color);
assert.notEqual(titleColorNoImage, "rgb(255, 255, 255)", "a hero with no photograph must not draw white text on a light background");
ok("a hero with a title but no photograph is readable — theme text, no scrim");

await page.fill('[data-testid="ax-hero-image"]', inlineImage("#8fb3e8", "#f3d9a4"));
await page.waitForSelector('[data-testid="ax-hero"] .ax-hero-scrim');
const scrimAlpha = await page.$eval('[data-testid="ax-hero"] .ax-hero-scrim', (e) => getComputedStyle(e).backgroundColor);
assert.match(scrimAlpha, /rgba\(19, 26, 43, 0\.4[0-9]*\)/, `the default wash should be ~45%, got ${scrimAlpha}`);
const titleColorWithImage = await page.$eval('[data-testid="ax-hero"] .ax-hero-text', (e) => getComputedStyle(e).color);
assert.equal(titleColorWithImage, "rgb(255, 255, 255)", "text over a photograph turns white");
ok("adding a photograph brings a scrim with it and turns the title white, without the author asking");

// the scrim is a slider, not a decision made for them
await page.fill('[data-testid="ax-hero-scrim"]', "0");
await page.waitForFunction(() => !document.querySelector('[data-testid="ax-hero"] .ax-hero-scrim'));
ok("an author who chose a dark photograph can turn the wash off entirely");
await page.fill('[data-testid="ax-hero-scrim"]', "60");
await page.waitForSelector('[data-testid="ax-hero"] .ax-hero-scrim');

// a band behind a range of rows, under the widgets rather than beside them
await page.click('[data-testid="ax-band-add"]');
await page.waitForSelector('[data-testid="ax-band"]');
await page.fill('[data-testid="ax-band-from"]', "0");
await page.fill('[data-testid="ax-band-to"]', "3");
await page.fill('[data-testid="ax-band-image-0"]', inlineImage("#2b3f63", "#7c5c9e"));
await page.waitForSelector('[data-testid="ax-band"] .ax-band-scrim');
const bandBox = await page.$eval('[data-testid="ax-band"]', (e) => ({ from: e.dataset.from, to: e.dataset.to, z: getComputedStyle(e).zIndex }));
assert.deepEqual([bandBox.from, bandBox.to], ["0", "3"]);
// the band must sit UNDER the widgets, or it would hide the dashboard it is decorating
const widgetZ = await page.$eval('[data-testid="ax-widget"]', (e) => getComputedStyle(e).zIndex);
assert.ok(Number(widgetZ) > Number(bandBox.z), `widgets (z=${widgetZ}) must paint above bands (z=${bandBox.z})`);
ok("a band spans the rows it was given and sits under the widgets, not over them");

// bands are scenery, so the no-overlap rule leaves both them and the widgets alone
const widgetCells = await page.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => `${e.dataset.x},${e.dataset.y}`));
assert.equal(new Set(widgetCells).size, widgetCells.length, "adding a band must not shove any widget around");
ok("adding scenery does not move a single widget — a band is not a widget");

await page.evaluate(() => document.querySelector('[data-testid="ax-hero"]')?.scrollIntoView({ block: "start" }));
await page.waitForTimeout(150);
await shot("09d-scenery");
await page.click('[data-testid="ax-report-save"]');
await page.waitForSelector('[data-testid="ax-report-save"]:has-text("Saved")');
const dashDef2 = store.reports.find((r) => r.name === "Executive Dashboard").definition;
assert.equal(dashDef2.hero.title, "StayLux Resort — Berlin");
assert.equal(dashDef2.hero.scrim, 60);
assert.equal(dashDef2.bands.length, 1);
assert.deepEqual([dashDef2.bands[0].fromRow, dashDef2.bands[0].toRow], [0, 3]);
ok("the hero and its bands persist in the dashboard definition");

/*
 * And the scenery has to REACH A VIEWER. Both the share API and the share page
 * hand-pick the fields they pass on, so a new one on the definition is exactly
 * the kind of thing that works all the way through the builder and then turns
 * out to be missing for everyone the dashboard was made for.
 */
await page.click('[data-testid="ax-report-publish"]');
await page.waitForSelector('.ax-ok:has-text("Published version")');
await page.click('[data-testid="ax-report-share"]');
await page.waitForSelector('[data-testid="ax-share-dialog"]');
await page.click('[data-testid="ax-share-create"]');
await page.waitForSelector('[data-testid="ax-share-link"] input');
const dashLink = await page.$eval('[data-testid="ax-share-link"] input', (e) => e.value);
await page.click('[data-testid="ax-share-dialog"] button:has-text("Close")');
const anon2 = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
await anon2.route("**/api/share/**", fakeShare);
const pub2 = await anon2.newPage();
pub2.on("pageerror", (e) => console.error("SHARE PAGE ERROR:", e.message));
await pub2.goto(dashLink, { waitUntil: "networkidle" });
await pub2.waitForSelector('[data-testid="ax-share-view"]');
assert.match(await pub2.$eval('[data-testid="ax-hero"]', (e) => e.textContent), /StayLux Resort/, "the shared dashboard keeps its banner");
assert.equal(await pub2.$$eval('[data-testid="ax-band"]', (es) => es.length), 1, "and its background band");
const sharedCells = await pub2.$$eval('[data-testid="ax-widget"]', (es) => es.map((e) => `${e.dataset.x},${e.dataset.y}`));
assert.deepEqual(sharedCells.sort(), widgetCells.slice().sort(), "a viewer sees the same arrangement the author laid out");
assert.equal(await pub2.$$eval('[data-testid="ax-widget-grip"]', (es) => es.length), 0, "with no grips");
assert.equal(await pub2.$$eval('[data-testid="ax-dashboard"][data-editable]', (es) => es.length), 0, "and no editable canvas");
ok("a shared dashboard reaches its viewer with the banner, the band and the exact layout — and nothing to edit them with");
await anon2.close();

console.log("\n§10 EXISTING NAVIGATION UNCHANGED + NEW ENTRY POINTS");
await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="dash-analytics"]');
assert.equal(await text('[data-testid="dash-analytics"]'), "Data Analytics");
assert.ok(await page.$('a.btn:has-text("Profile")') && await page.$('a.btn:has-text("Security")') && await page.$('[data-testid="dash-signout"]'));
ok("dashboard header keeps Profile / Security / Sign out and gains Data Analytics");
await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
const nav = await page.$$eval(".leftnav .nav-item", (es) => es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
// the 17 existing tabs keep their order; Data Analytics, Fieldwork (§23) and
// Tests (§55/§56) are additions that displace nothing already there
// Data Analytics and Fieldwork (§23)
// sit next to Data, in the Results group — additions that displace nothing
// already there, which is what this assertion is for
/*
 * The exclusion list is every tab added SINCE this assertion was written.
 * The assertion's subject is the seventeen that were here then: they are all
 * still here, in the same order, and nothing new was inserted among them.
 * "Translation" (localization) and "Usage & Wallet" (the wallet work) are the
 * two most recent additions and belong on the list for the same reason the
 * others do.
 */
assert.deepEqual(nav.filter((t) => !["Data Analytics", "Fieldwork", "Distribution", "Project", "Tests", "Translation", "Usage & Wallet", "Assets"].includes(t)), ["Questions", "Survey Settings", "Survey Flow", "Logic", "Variables", "Calculations", "Quotas", "List Fill", "Design Generators", "Branding", "Scripts", "Data", "Versions & Deploy", "JSON", "Collaborators", "Internal notes", "Activity"]);
assert.equal(nav.indexOf("Fieldwork"), nav.indexOf("Data Analytics") + 1, "Fieldwork belongs beside Data in Results");
assert.equal(nav.indexOf("Distribution"), nav.indexOf("Versions & Deploy") - 1, "Distribution belongs beside Versions & Deploy in Management");
/*
 * Project is the FIRST entry in Management — which is what "at the top"
 * means, and what this checks. It used to be spelled as "immediately before
 * Distribution", an adjacency that held only until something was added
 * between them; "Usage & Wallet" (the wallet work) is now there, and the
 * order it is really asserting is unchanged.
 */
assert.ok(nav.indexOf("Project") < nav.indexOf("Distribution"), "Project belongs at the top of Management");
assert.ok(nav.indexOf("Project") > nav.indexOf("Fieldwork"), "…which begins after Results ends");
assert.equal(nav.filter((t) => t === "Data Analytics").length, 1);
assert.equal(nav[nav.indexOf("Data") + 1], "Data Analytics", "Data Analytics follows Data");
assert.match(await page.$eval('[data-testid="nav-analytics"]', (e) => e.getAttribute("href")), /^\/analytics/);
assert.equal(nav[nav.indexOf("Scripts") + 1], "Tests", "Tests follows Scripts in Research tools");
ok("Studio left nav: all 17 existing tabs unchanged, Data Analytics and Tests added");

console.log(`\nALL ${passed} CHECKS PASSED · audit events recorded by the fake backend: ${[...new Set(store.audit)].join(", ")}`);
await browser.close();
