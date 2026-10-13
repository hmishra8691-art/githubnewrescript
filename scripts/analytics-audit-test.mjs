/**
 * DATA ANALYTICS AUDIT (Oct 2026) — regressions for the screenshot failures,
 * driven through the real UI against the in-process fake backend (same
 * contract as analytics-test.mjs: REAL analytics engine, in-memory store).
 *
 *  1. export of a report whose insights / executive-summary blocks have no
 *     analysisIds ("Cannot read properties of undefined (reading 'flatMap')")
 *  2. an export that cannot be built says so in a sentence, never raw text
 *  3. publish refuses to freeze a blank report (n = 0 everywhere), with an
 *     explicit "publish anyway"; the share page says "no respondents" rather
 *     than drawing zeros
 *  4. opening a saved analysis keeps its own dataset (no phantom "unsaved")
 *  5. Saved charts: a failing analysis shows "could not be computed / Try again"
 *     (not "Computing…" for ever), and the retry works
 *  6. double-clicking Save creates ONE analysis
 *  7. a stale result cannot be exported
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/analytics-audit-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { navLabels } from "./lib/nav.mjs";
import assert from "node:assert/strict";
import { checkSnapshot, reportAnalysisIds, failedResult, adviseChart, buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, BUILT_IN_DASHBOARD_TEMPLATES, applyTemplate, applyDashboardTemplate, dashboardAsTemplate, templateKind, reportPages } from "../packages/analytics/dist/index.js";
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
  const advice = adviseChart(definition, result, variableMetadata(def));
  return { ...result, recommendations: advice.alternatives, advice };
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
  for (const id of ids) { const a = store.analyses.find((x) => x.id === id && !x.deleted_at); if (!a) continue; try { if (store.failIds?.has(id)) throw new Error('boom'); out[id] = compute({ ...a.definition, id, name: a.name }); } catch { out[id] = { ...failedResult(a.name, a.kind), recommendations: [] }; } }
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
  if (head === "run") { try { if (store.failRunNames?.has(body.definition?.name)) throw new Error("boom"); return json(route, { result: compute(body.definition) }); } catch (e) { return json(route, { error: "The analysis could not be computed. Check that its variables exist in this survey and have answers, then try again. (ref abc123)" }, 500); } }
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
    const chk = checkSnapshot(report, results);
    const withData = reportAnalysisIds(report).filter((id) => results[id] && !results[id].error && (results[id].base?.n ?? 0) > 0);
    if (reportAnalysisIds(report).length && !withData.length) return json(route, { error: `Nothing to export. ${chk.problems.join(" ")}` }, 409);
    if (store.breakExport) return json(route, { error: "The export could not be built. Nothing was downloaded. Try again, or export a single analysis; if it keeps failing quote reference abc123 to support." }, 500);
    const buf = body.format === "xlsx" ? await buildXlsx({ report, results, theme: DEFAULT_THEME, settings: body.settings }) : await buildPptx({ report, results, theme: DEFAULT_THEME, settings: body.settings, images });
    store.lastExport = { format: body.format ?? "pptx", bytes: buf.length, images: Object.keys(images).length, mapNote: buf.toString("latin1").includes("Shown as ranked bars"), hasMedia: /ppt\/media\/image/.test(buf.toString("latin1")) };
    if (process.env.AX_SHOTS && Object.keys(images).length) (await import("node:fs")).writeFileSync(`${process.env.AX_SHOTS}/map-deck.pptx`, buf);
    return route.fulfill({ status: 200, contentType: "application/octet-stream", headers: { ...(chk.problems.length ? { "x-rescript-export-notes": encodeURIComponent(JSON.stringify(chk.problems)) } : {}), "access-control-expose-headers": "x-rescript-export-notes", "content-disposition": `attachment; filename="x.${body.format ?? "pptx"}"` }, body: buf });
  }
  if (head === "reports" && itemId && action === "publish") {
    const r = store.reports.find((x) => x.id === itemId); const version = (r.published_version ?? 0) + 1;
    const snapshot = reportResults(r.definition);
    const chk = checkSnapshot(r.definition, snapshot);
    if (!chk.ok && body.force !== true) return json(route, { error: `Not published. ${chk.problems.join(" ")}`, problems: chk.problems, canForce: true }, 409);
    store.reportVersions.push({ id: uid(), report_id: r.id, version, definition: r.definition, theme: DEFAULT_THEME, snapshot, dataset: { responses: chk.responses }, published_at: now(), note: body.note ?? null });
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
let confirmAnswer = true; const dialogs = [];
page.on("dialog", (d) => { dialogs.push(`${d.type()}: ${d.message()}`); if (d.type() === "confirm" && !confirmAnswer) return d.dismiss(); return d.accept(d.type() === "prompt" ? promptAnswer : undefined); });
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


const mkAnalysis = (name, { env = "LIVE", kind = "descriptive", variables = ["SAT"], extra = {} } = {}) => {
  const id = uid(); const definition = { name, kind, dataset: { environment: env, dataset: "all" }, variables, ...extra };
  const row = { id, survey_id: SURVEY, created_at: now(), updated_at: now(), name, kind, definition, version: 1, position: null };
  store.analyses.push(row); store.analysisVersions.push({ analysis_id: id, version: 1, definition, summary: "", created_at: now() });
  return row;
};
const mkReport = (name, definition) => {
  const row = { id: uid(), survey_id: SURVEY, created_at: now(), updated_at: now(), kind: "report", name, mode: "live", theme_id: null, published_version: null, definition };
  store.reports.push(row); return row;
};
const openReports = async () => { await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ax-workspace"]'); await axTab(page, "reports"); };
const openReport = async (name) => { await openReports(); await page.click(`[data-testid="ax-report-card"]:has-text("${name}")`); await page.waitForSelector('[data-testid="ax-report-builder"]'); };
const exportNow = async () => { await page.click('[data-testid="ax-report-export"]'); await page.waitForSelector('[data-testid="ax-export-dialog"]'); };

/* ------------------------------------------------------------------ 1 */
console.log("\n§1 EXPORT — blocks with no analysisIds");
const sat = mkAnalysis("Satisfaction");
const ragged = mkReport("Ragged findings", { title: "Ragged findings", mode: "live", blocks: [
  { id: "b0", type: "cover", title: "Ragged findings" },
  { id: "b1", type: "chart", title: "Satisfaction", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } },
  { id: "b2", type: "insights", title: "Findings" },
  { id: "b3", type: "executive_summary", title: "Summary" },
] });
await openReport("Ragged findings");
assert.ok((await count('[data-testid="ax-report"] .ax-insights li')) >= 1, "an insights block with no chosen analyses summarises the report's analyses");
assert.ok((await count('[data-testid="ax-report"] .ax-exec-item')) >= 1, "so does the executive summary");
ok("the viewer shows the report's insights and executive summary for blocks with no chosen analyses");
await exportNow();
const [dl1] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-export-go"]')]);
assert.match(dl1.suggestedFilename(), /\.pptx$/);
assert.ok(store.lastExport.bytes > 15000, `deck is ${store.lastExport.bytes} bytes`);
ok("PowerPoint export of that report succeeds (was: 500 Cannot read properties of undefined (reading 'flatMap'))");

/* ------------------------------------------------------------------ 2 */
console.log("\n§2 EXPORT — failures are a sentence, not an exception");
store.breakExport = true;
await openReport("Ragged findings"); await exportNow();
await page.click('[data-testid="ax-export-go"]');
await page.waitForSelector('[data-testid="ax-export-error"]');
const err = await text('[data-testid="ax-export-error"]');
assert.match(err, /could not be built.*Nothing was downloaded/);
assert.doesNotMatch(err, /flatMap|undefined|TypeError|Cannot read/);
ok("a failed build tells the researcher nothing was downloaded, with a reference — no raw exception text");
store.breakExport = false;

/* ------------------------------------------------------------------ 3 */
console.log("\n§3 PUBLISH — never freeze a blank report");
const empty = mkAnalysis("Satisfaction (test data)", { env: "TEST" });
const blank = mkReport("Blank report", { title: "Blank report", mode: "live", blocks: [{ id: "c0", type: "cover", title: "Blank report" }, { id: "c1", type: "chart", title: "Satisfaction", analysisId: empty.id, chart: { type: "bar_vertical", options: {} } }] });
await openReport("Blank report");
assert.ok(await page.waitForSelector('[data-testid="ax-nodata"]'), "the authoring view says there are no respondents, not a chart of zeros");
ok("a chart whose analysis saw nobody says so instead of drawing zeros");
confirmAnswer = false; dialogs.length = 0;
await page.click('[data-testid="ax-report-publish"]');
await page.waitForFunction(() => true); await page.waitForTimeout(400);
assert.equal(store.reportVersions.filter((v) => v.report_id === blank.id).length, 0, "declining the warning must not publish");
assert.ok(dialogs.some((d) => /every chart and number would read 0/.test(d)), `the warning names the reason: ${dialogs.join(" | ")}`);
ok("publish stops and explains: every chart and number would read 0");
confirmAnswer = true;
await page.click('[data-testid="ax-report-publish"]');
await page.waitForSelector('.ax-ok:has-text("Published version 1")');
assert.equal(store.reportVersions.filter((v) => v.report_id === blank.id).length, 1, "publishing anyway is possible when the author insists");
ok("the author can still publish it on purpose");
await page.click('[data-testid="ax-report-share"]');
await page.waitForSelector('[data-testid="ax-share-dialog"]');
await page.click('[data-testid="ax-share-create"]');
await page.waitForSelector('[data-testid="ax-share-link"] input');
const link2 = await page.$eval('[data-testid="ax-share-link"] input', (e) => e.value);
const anon = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
await anon.route("**/api/share/**", fakeShare);
const pub = await anon.newPage();
await pub.goto(link2, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-view"]');
assert.ok((await pub.$$eval('[data-testid="ax-nodata"]', (es) => es.length)) >= 1, "the shared page says no respondents");
assert.equal(await pub.$$eval('[data-testid="ax-chart"]', (es) => es.length), 0, "and draws no chart of zeros");
ok("the shared snapshot shows 'no respondents' — not a chart of 0%");
await anon.close();
confirmAnswer = true;

/* a report that mixes a populated and an empty analysis announces the populated base */
const mixed = mkReport("Mixed report", { title: "Mixed report", mode: "live", blocks: [
  { id: "m1", type: "chart", analysisId: empty.id, chart: { type: "bar_vertical", options: {} } },
  { id: "m2", type: "chart", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } }] });
await openReport("Mixed report");
await page.click('[data-testid="ax-report-publish"]');
await page.waitForSelector('.ax-ok:has-text("Published version 1")');
assert.equal(store.reportVersions.find((v) => v.report_id === mixed.id).dataset.responses, 400, "responses = the largest base, whatever order the analyses came back in");
ok("'N responses' is the largest base in the report, not whichever analysis came first");

/* ------------------------------------------------------------------ 4 */
console.log("\n§4 SAVED ANALYSIS — opening it changes nothing");
const testEnv = mkAnalysis("Saved on test data", { env: "TEST" });
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await axTab(page, "analysis");
await page.waitForSelector('[data-testid="ax-rail"]');
await page.click(`[data-testid="ax-rail-item"][data-id="${testEnv.id}"]`);
await page.waitForSelector('[data-testid="ax-builder"]');
await page.waitForSelector('[data-testid="ax-savestate"]');
await page.waitForTimeout(600);
assert.match(await text('[data-testid="ax-savestate"]'), /Saved · v1/, "an untouched saved analysis is not 'unsaved'");
assert.equal(await count('[data-testid="ax-stale"]'), 0, "and its result is not out of date");
ok("opening a saved analysis (stored on TEST data, workspace selector on production) leaves it Saved · v1, not stale");
await page.click('[data-testid="ax-save"]');
await page.waitForTimeout(300);
assert.equal(store.analyses.find((a) => a.id === testEnv.id).definition.dataset.environment, "TEST", "saving must not rewrite the stored dataset to the selector's");
ok("saving it does not rewrite its stored dataset to the workspace selector's");

/* ------------------------------------------------------------------ 5 */
console.log("\n§5 SAVED CHARTS — a failure is shown and retryable");
const flaky = mkAnalysis("Flaky analysis");
store.charts.push({ id: uid(), survey_id: SURVEY, analysis_id: flaky.id, name: "Flaky chart", spec: { type: "bar_vertical", options: {} }, theme_id: null, style_version: 1, created_at: now(), updated_at: now() });
store.failRunNames = new Set(["Flaky analysis"]);
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await axTab(page, "charts");
await page.waitForSelector('[data-testid="ax-chart-failed"]');
const failedText = await text('[data-testid="ax-chart-failed"]');
assert.match(failedText, /could not be computed/);
ok("a chart whose analysis fails says so — it does not sit on 'Computing…'");
store.failRunNames = new Set();
await page.click('[data-testid="ax-chart-failed"] button');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-chart-failed"]').length === 0);
ok("Try again recomputes it");

/* ------------------------------------------------------------------ 6 */
console.log("\n§6 SAVE — one click, one analysis");
await axTab(page, "analysis");
await page.click('[data-testid="ax-rail-new"]');
await page.waitForSelector('[data-testid="ax-builder"]');
await page.fill('[data-testid="ax-name"]', "Double-clicked");
await page.click('[data-testid="ax-step-1"]');
await page.click('.ax-var:has-text("SAT · Scale") input');
await page.click('[data-testid="ax-run"]');
await page.waitForSelector('[data-testid="ax-save"]');
const before = store.analyses.length;
await page.evaluate(() => { const b = document.querySelector('[data-testid="ax-save"]'); b.click(); b.click(); });
await page.waitForTimeout(700);
assert.equal(store.analyses.length - before, 1, `a double click created ${store.analyses.length - before} analyses`);
ok("two quick clicks on Save create one analysis");

/* ------------------------------------------------------------------ 7 */
console.log("\n§7 STALE — a result that is out of date cannot be exported");
await page.click('.ax-stage:has-text("Builder")');
await page.click('[data-testid="ax-step-1"]');
await page.click('.ax-var:has-text("GENDER · Categorical") input');   // a variable changes the numbers
await page.click('[data-testid="ax-step-5"]');                         // back to the (old) results
await page.waitForSelector('[data-testid="ax-stale"]');
const exports0 = store.exports;
await page.click('[data-testid="ax-export-pptx"]');
await page.waitForSelector('[data-testid="ax-error"]');
assert.equal(store.exports, exports0, "no export request while the results are out of date");
assert.match(await text('[data-testid="ax-error"]'), /out of date/);
ok("after a change that alters the numbers, Export refuses until the analysis is run again");

/* ------------------------------------------------------------------ 8 */
console.log("\n§8 CHARTS — chosen from what was asked, and the denominator is stated");
const multi = mkAnalysis("Brands considered", { variables: ["CONSIDER"] });
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await axTab(page, "analysis");
await page.waitForSelector('[data-testid="ax-rail"]');
await page.click(`[data-testid="ax-rail-item"][data-id="${multi.id}"]`);
await page.waitForSelector('[data-testid="ax-chart-advice"]');
const adviceText = await text('[data-testid="ax-chart-advice"]');
assert.match(adviceText, /multiple-choice question/);
assert.match(await text('[data-testid="ax-denominator"]'), /several answers were allowed.*more than 100%/);
ok("a multiple-choice question says why it is drawn as horizontal bars, and that its bars add to more than 100%");
assert.ok(!/\bpie\b/i.test(await page.$eval('.ax-gallery, [data-testid="ax-gallery"]', (e) => e.textContent).catch(() => "")), "no pie is recommended for overlapping answers");

const gender = mkAnalysis("Gender split", { variables: ["GENDER"] });
mkReport("Saved word cloud", { title: "Saved word cloud", mode: "live", blocks: [{ id: "w1", type: "chart", title: "Gender", analysisId: gender.id, chart: { type: "word_cloud", options: {} } }] });
await openReport("Saved word cloud");
await page.waitForSelector('[data-testid="ax-chart-fallback"]');
assert.match(await text('[data-testid="ax-chart-fallback"]'), /cannot draw this result/);
assert.ok((await count('[data-testid="ax-report"] [data-testid="ax-chart"]')) >= 1, "the block still shows a chart");
ok("a saved chart type that cannot draw the result falls back and says why (was: 'No data to chart')");

/* ------------------------------------------------------------------ 9 */
console.log("\n§9 RAIL — planned and your own analyses are kept apart");
const planned = mkAnalysis("Planned crosstab", { kind: "crosstab", variables: ["SAT", "GENDER"], extra: { rows: ["SAT"], columns: ["GENDER"], options: { planned: "xt_1" } } });
await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" });
await axTab(page, "analysis");
await page.waitForSelector('[data-testid="ax-rail-scope"]');
const all = await count('[data-testid="ax-rail-item"]');
await page.click('[data-testid="ax-rail-scope-planned"]');
assert.equal(await count('[data-testid="ax-rail-item"]'), 1, "only the generated analysis");
assert.match(await text('[data-testid="ax-rail-item"]'), /Planned · /);
await page.click('[data-testid="ax-rail-scope-mine"]');
assert.equal(await count('[data-testid="ax-rail-item"]'), all - 1, "everything else is the researcher's own");
ok("the rail separates generated analyses from the ones a person built");

console.log(`\n${passed} checks passed`);
await browser.close();
