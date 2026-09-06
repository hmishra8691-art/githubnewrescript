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
import { buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME } from "../packages/analytics/dist/index.js";
import { buildPptx, buildXlsx } from "../packages/analytics/dist/export/index.js";
import { def, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";

/* ------------------------------------------------------------ fake backend */
const rows = synthRows(400);
const store = { analyses: [], charts: [], segments: [], themes: [], reports: [], shares: [], analysisVersions: [], reportVersions: [], exports: 0, audit: [] };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const compute = (definition) => {
  const ds = buildDataset(def, rows, { spec: definition.dataset ?? { environment: "LIVE", dataset: "all" }, weighting: definition.weighting ?? null });
  const result = runAnalysis(definition, ds);
  return { ...result, recommendations: recommendCharts(result) };
};
const reportResults = (definition) => {
  const ids = new Set();
  for (const b of definition.blocks ?? []) { if (b.analysisId) ids.add(b.analysisId); for (const id of b.analysisIds ?? []) ids.add(id); }
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
  if (!store[head]) return json(route, { error: "Unknown analytics endpoint." }, 404);
  if (m === "GET" && !itemId) { const kind = url.searchParams.get("kind"); return json(route, { items: coll(head).filter((x) => !x.deleted_at && (!kind || x.kind === kind)) }); }
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
    if (head === "analyses" && body.definition) { const changed = JSON.stringify({ ...row.definition, name: 0 }) !== JSON.stringify({ ...body.definition, name: 0 }); row.definition = body.definition; if (changed) { row.version++; store.analysisVersions.push({ analysis_id: row.id, version: row.version, definition: body.definition, created_at: now() }); } }
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
  return json(route, { report: { name: r.name, title: v.definition.title, subtitle: v.definition.subtitle, blocks: v.definition.blocks, widgets: v.definition.widgets ?? null, viewerSegments: v.definition.viewerSegments ?? [], branding: v.definition.branding ?? {} }, theme: v.theme, results: v.snapshot, version: v.version, publishedAt: v.published_at, mode: "snapshot", dataset: v.dataset, permission: s.permission });
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
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route(`**/api/surveys/${SURVEY}/analytics/**`, fakeApi);
await page.route(`**/api/surveys/${SURVEY}/analytics`, fakeApi);
await page.route("**/api/share/**", fakeShare);

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
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
await page.click('.ax-tab:has-text("Tables")');
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

console.log("\n§10 EXISTING NAVIGATION UNCHANGED + NEW ENTRY POINTS");
await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="dash-analytics"]');
assert.equal(await text('[data-testid="dash-analytics"]'), "Data Analytics");
assert.ok(await page.$('a.btn:has-text("Profile")') && await page.$('a.btn:has-text("Security")') && await page.$('[data-testid="dash-signout"]'));
ok("dashboard header keeps Profile / Security / Sign out and gains Data Analytics");
await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
const nav = await page.$$eval(".leftnav .nav-item", (es) => es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
assert.deepEqual(nav.slice(0, 17), ["Questions", "Survey Settings", "Survey Flow", "Logic", "Variables", "Calculations", "Quotas", "List Fill", "Design Generators", "Branding", "Scripts", "Data", "Versions & Deploy", "JSON", "Collaborators", "Internal notes", "Activity"]);
assert.match(nav[17], /Data Analytics/);
assert.match(await page.$eval('[data-testid="nav-analytics"]', (e) => e.getAttribute("href")), /^\/analytics/);
ok("Studio left nav: all 17 existing tabs unchanged, Data Analytics link added at the end");

console.log(`\nALL ${passed} CHECKS PASSED · audit events recorded by the fake backend: ${[...new Set(store.audit)].join(", ")}`);
await browser.close();
