/**
 * CROSS-TABS: WHOLE TABLES IN ONE STEP (2026-11-16) — in the Data Analytics builder.
 *
 *   ALL QUESTIONS   pick the banner, press "All questions → Rows": every question is in Rows and the result is ONE
 *                   banner table with a section per question — not sixty ticks, not sixty tables
 *   NPS             the NPS question in that table carries Promoters / Passives / Detractors and the NPS score
 *                   without being asked
 *   ONE TABLE       a grid chosen from "One table for a loop or grid…" is one table with a row per statement;
 *                   with the banner each cell is one figure; Transpose puts the statements across the top
 *   CONTROL         Clear rows empties Rows; everything set stays editable
 *
 * The analytics API is the same in-process fake backend analytics-test.mjs uses: the REAL engine over the synthetic
 * fixture. The fixture has a grid and an NPS question but no loop — reading a loop by item is covered by the engine
 * tests (packages/analytics itemTable.test.ts), not here.
 *
 * Needs the Studio on :3000.   node scripts/crosstab-quick-tables-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import { navLabels } from "./lib/nav.mjs";
import assert from "node:assert/strict";
import { buildCatalogue, buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, BUILT_IN_DASHBOARD_TEMPLATES, applyTemplate, applyDashboardTemplate, dashboardAsTemplate, templateKind, reportPages } from "../packages/analytics/dist/index.js";
import { buildPptx, buildXlsx, isEmbeddableImage } from "../packages/analytics/dist/export/index.js";
import { def, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { variableMetadata } from "../packages/analytics/dist/dataset.js";
import { axTab } from "./lib/axNav.mjs";

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
  /* the Architect's catalogue — the package's own builder over the saved analyses (no plan, no qual on this fake) */
  if (head === "catalogue" && m === "GET") {
    const analyses = store.analyses.filter((x) => !x.deleted_at).map((x) => ({ id: x.id, name: x.name, kind: x.kind ?? x.definition?.kind, version: x.version ?? 1, updated_at: x.updated_at ?? now(), folder: x.folder ?? null, definition: x.definition }));
    const catalogue = buildCatalogue({ def, dictionary: variableMetadata(def).filter((v) => !v.hidden), analyses, charts: store.charts.filter((c) => !c.deleted_at).map((c) => ({ id: c.id, analysis_id: c.analysis_id, name: c.name, spec: c.spec, theme_id: c.theme_id ?? null, style_version: c.style_version ?? null })), planItems: [], hypotheses: [], findings: [], outputs: [], qualThemes: [], discoveries: [] });
    return json(route, { catalogue, plan: { plan: null, items: [], hypotheses: [], run: null, overview: {} } });
  }
  /* §36 — report templates, and laying one over a report */
  if (head === "report-templates") {
    if (m === "GET") return json(route, { templates: [...BUILT_IN_REPORT_TEMPLATES.map((t) => ({ ...t, kind: "report" })), ...BUILT_IN_DASHBOARD_TEMPLATES, ...store.reportTemplates], available: true });
    if (m === "POST") {
      const src = store.reports.find((r) => r.id === body.fromReportId);
      // §42 — a dashboard's shape is its widgets and scenery, not blocks
      if (src?.kind === "dashboard") {
        const t = { id: uid(), builtIn: false, ...dashboardAsTemplate(body.name, src.definition, body.description) };
        store.reportTemplates.push(t);
        return json(route, { template: t }, 201);
      }
      const blocks = (src?.definition?.blocks ?? []).map((b) => {
        if (b.type === "panel_grid") return { ...b, panels: b.panels.map((pnl) => ({ ...pnl, analysisId: "" })) };
        const { analysisId, analysisIds, ...rest } = b; return { ...rest, placeholder: b.title ?? b.type };
      });
      const t = { id: uid(), name: body.name, description: body.description, builtIn: false, kind: "report", blocks };
      store.reportTemplates.push(t);
      return json(route, { template: t }, 201);
    }
    if (m === "DELETE") { store.reportTemplates = store.reportTemplates.filter((t) => t.id !== itemId); return json(route, { ok: true }); }
  }
  if (head === "reports" && action === "apply-template" && m === "POST") {
    const r = store.reports.find((x) => x.id === itemId);
    const t = [...BUILT_IN_REPORT_TEMPLATES, ...BUILT_IN_DASHBOARD_TEMPLATES, ...store.reportTemplates].find((x) => x.id === body.templateId);
    if (!r || !t) return json(route, { error: "Unknown template." }, 404);
    // §42 — the two kinds share a gallery, so a mismatch is refused rather
    // than left to produce a definition nothing can render
    const wantKind = r.kind === "dashboard" ? "dashboard" : "report";
    const gotKind = templateKind(t);
    if (wantKind !== gotKind) return json(route, { error: `That is a ${gotKind} template, and this is a ${wantKind}. Pick a ${wantKind} template.` }, 409);
    r.definition = wantKind === "dashboard" ? applyDashboardTemplate(t, r.definition) : applyTemplate(t, r.definition);
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
    /*
     * §43 — the same validation the real route does, so the test exercises the
     * path a customer's deck actually takes. AX_DEBUG_IMG prints what arrived
     * and which blocks the export is building from: the first version of this
     * check passed while exporting an UNSAVED report that contained no map at
     * all, and that is what showed it.
     */
    const images = {};
    for (const [blockId, uri] of Object.entries(body.images ?? {}).slice(0, 40)) {
      const okImg = isEmbeddableImage(uri);
      if (process.env.AX_DEBUG_IMG) console.log("  [img]", blockId, typeof uri === "string" ? `${uri.slice(0, 32)}… len=${uri.length}` : typeof uri, "accepted:", okImg);
      if (typeof blockId === "string" && blockId.length <= 64 && okImg) images[blockId] = uri;
    }
    if (process.env.AX_DEBUG_IMG) console.log("  [img] blocks being exported:", (report.blocks ?? []).map((b) => `${b.id}:${b.type}`).join(", "));
    const buf = body.format === "xlsx" ? await buildXlsx({ report, results, theme: DEFAULT_THEME, settings: body.settings }) : await buildPptx({ report, results, theme: DEFAULT_THEME, settings: body.settings, images });
    store.lastExport = { format: body.format ?? "pptx", bytes: buf.length, images: Object.keys(images).length, mapNote: buf.toString("latin1").includes("Shown as ranked bars"), hasMedia: /ppt\/media\/image/.test(buf.toString("latin1")) };
    if (process.env.AX_SHOTS && Object.keys(images).length) (await import("node:fs")).writeFileSync(`${process.env.AX_SHOTS}/map-deck.pptx`, buf);
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
const shot = async (name) => { if (process.env.AX_SHOTS) await page.screenshot({ path: `${process.env.AX_SHOTS}/${name}.png`, fullPage: false }); };
/* run, then open the result's Tables tab (it opens on the chart) */
const run = async () => { await page.click('[data-testid="ax-run"]'); await page.waitForSelector('[data-testid="ax-result"]'); await page.waitForTimeout(400); await page.click('[data-testid="ax-result"] .ax-tab:has-text("Tables")'); await page.waitForSelector('[data-testid="ax-result"] table'); };
const tablesTab = () => text('[data-testid="ax-result"] .ax-tab:has-text("Tables")');
const tableCount = () => page.$$eval('[data-testid="ax-result"] table', (ts) => ts.length);
const headers = () => page.$$eval('[data-testid="ax-result"] table thead th', (ths) => ths.map((t) => t.textContent.replace(/\s+/g, " ").trim()).filter(Boolean));
const firstCells = () => page.$$eval('[data-testid="ax-result"] table tbody tr', (trs) => trs.map((tr) => (tr.querySelector("th, td")?.textContent ?? "").replace(/\s+/g, " ").trim()));

/* the dev server compiles the page on first request: allow for it */
await page.goto(`${STUDIO}/analytics`, { waitUntil: "domcontentloaded", timeout: 150000 });
await page.waitForSelector('[data-testid="ax-workspace"]', { timeout: 120000 });
await page.click('[data-testid="ax-quick-crosstab"]');
await page.waitForSelector('[data-testid="ax-builder"]');
await page.fill('[data-testid="ax-name"]', "Full banner run");
await page.click('[data-testid="ax-step-1"]');
await page.waitForSelector('[data-testid="ax-xt-quick"]');

console.log("\nALL QUESTIONS AGAINST A BANNER");
await page.click('[data-testid="ax-xt-target-columns"]');
await page.click('.ax-var:has-text("GENDER · Categorical") input');
assert.match(await text('[data-testid="ax-drop-columns"]'), /Gender/);
const label = await text('[data-testid="ax-xt-all-rows"]');
const n = Number(/\((\d+)\)/.exec(label)?.[1]);
assert.ok(n >= 15, `the button says how many questions it adds (${label})`);
await page.click('[data-testid="ax-xt-all-rows"]');
const inRows = await page.$$eval('[data-testid="ax-drop-rows"] .ax-pill, [data-testid="ax-drop-rows"] [draggable]', (els) => els.length);
assert.ok(inRows >= n || /Overall satisfaction/.test(await text('[data-testid="ax-drop-rows"]')), "Rows is filled");
assert.match(await text('[data-testid="ax-drop-rows"]'), /Overall satisfaction/);
assert.doesNotMatch(await text('[data-testid="ax-drop-rows"]'), /Gender/, "the banner is not also a row");
assert.match(await text(".ax-xt-summary"), /Banner, rows stacked/);
ok(`one click puts all ${n} questions in Rows (the banner left out) and sets a stacked banner table`);
await run();
assert.equal(await tablesTab(), "Tables (1)", "ONE table for the whole run");
const body = await text('[data-testid="ax-result"]');
for (const want of ["Overall satisfaction", "Region", "Recommend?", "Promoters (9–10)", "Passives (7–8)", "Detractors (0–6)", "NPS (promoters − detractors)"]) assert.ok(body.includes(want), `the table has “${want}” — ${body.slice(0, 900)}`);
await shot("xt-all-questions");
ok("the result is one banner table with a section per question; the NPS question carries Promoters / Passives / Detractors and the NPS score on its own");

console.log("\nA GRID AS ONE TABLE");
await page.click('[data-testid="ax-stage-builder"]'); await page.click('[data-testid="ax-step-1"]');
await page.waitForSelector('[data-testid="ax-xt-group"]');
const opts = await page.$$eval('[data-testid="ax-xt-group"] option', (os) => os.map((o) => [o.value, o.textContent]));
const grid = opts.find(([, t]) => /3 statements/.test(t));
assert.ok(grid, `the grid is offered: ${opts.map((o) => o[1]).join(" | ")}`);
await page.selectOption('[data-testid="ax-xt-group"]', grid[0]);
assert.match(await text(".ax-xt-summary"), /One row per item/);
assert.match(await text('[data-testid="ax-xt-items-note"]'), /Each cell is one figure/);
await run();
assert.equal(await tablesTab(), "Tables (1)");
const rows1 = (await firstCells()).filter(Boolean);
assert.deepEqual(rows1.filter((r) => ["Quality", "Value", "Service"].includes(r)), ["Quality", "Value", "Service"], `a row per statement (${rows1.join(" | ")})`);
const h1 = await headers();
assert.ok(h1.some((h) => /Total/.test(h)) && h1.some((h) => /Male/.test(h)) && h1.some((h) => /Female/.test(h)), `the banner is across the top (${h1.join(" | ")})`);
await shot("xt-item-table");
ok("the grid is one table: a row per statement, Total / Male / Female across the top, one figure per cell");

await page.click('[data-testid="ax-stage-builder"]'); await page.click('[data-testid="ax-step-1"]');
await page.waitForSelector('[data-testid="ax-xt-transpose"]');
await page.check('[data-testid="ax-xt-transpose"]');
assert.match(await text(".ax-xt-summary"), /transposed/);
await run();
const h2 = await headers();
assert.ok(["Quality", "Value", "Service"].every((x) => h2.some((h) => h.includes(x))), `the statements are across the top (${h2.join(" | ")})`);
const rows2 = (await firstCells()).filter(Boolean);
assert.ok(rows2.some((r) => /Total/.test(r)) && rows2.some((r) => /Male/.test(r)), `the banner is down the side (${rows2.join(" | ")})`);
await shot("xt-item-table-transposed");
ok("Transpose exchanges them: statements across the top, the banner down the side");

console.log("\nCONTROL");
await page.click('[data-testid="ax-stage-builder"]'); await page.click('[data-testid="ax-step-1"]');
await page.click('[data-testid="ax-xt-target-columns"]');
await page.click('.ax-var:has-text("GENDER · Categorical") input');
assert.doesNotMatch(await text('[data-testid="ax-drop-columns"]'), /Gender/);
assert.match(await text('[data-testid="ax-xt-items-note"]'), /Add a banner in Columns/);
await run();
const h3 = await headers();
assert.ok(h3.some((h) => /Base/.test(h)) || (await text('[data-testid="ax-result"]')).includes("Base (n)"), "without a banner the item table shows each statement's own profile");
ok("with no banner the item table runs on its own: each statement's base, answers, mean and top-2 box");
await page.click('[data-testid="ax-stage-builder"]'); await page.click('[data-testid="ax-step-1"]');
await page.click('[data-testid="ax-xt-clear-rows"]');
assert.doesNotMatch(await text('[data-testid="ax-drop-rows"]'), /Quality|Value|Service/);
ok("Clear rows empties Rows");

await browser.close();
console.log(`\nCROSS-TAB QUICK TABLES: ${passed} checks passed`);
