/**
 * REPORT BUILDER + ANIMATED STORY (Data Analytics audit, Phase 4) — through the
 * real UI against the in-process fake backend (REAL analytics engine: the same
 * draftReport / regenerateScene / storyHtml / gateInterpretation the route uses).
 *
 *  1. "Build with Rescript": brief → REVIEW (what was chosen and why, what was
 *     left out and why, key questions nothing answers) → create. Nothing is
 *     saved before Create.
 *  2. the created report has real captions from the results, no invented numbers
 *  3. the Story tab: preview, edit text, change chart (only valid ones), hide,
 *     regenerate, save → reload keeps it; export is blocked while unsaved
 *  4. the exported HTML plays in a real browser: scenes advance, keyboard works,
 *     no network, no console errors
 *  5. publish → the SHARED page plays the story from the frozen snapshot
 *  6. a model's interpretation passes the number gate or is dropped — and is
 *     labelled "not a finding" on screen
 *  7. empty state: no saved analyses → an actionable message, no blank report
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/report-builder-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { navLabels } from "./lib/nav.mjs";
import assert from "node:assert/strict";
import { checkSnapshot, reportAnalysisIds, failedResult, adviseChart, buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, BUILT_IN_DASHBOARD_TEMPLATES, applyTemplate, applyDashboardTemplate, dashboardAsTemplate, templateKind, reportPages, draftReport, regenerateScene, storyHtml, gateInterpretation } from "../packages/analytics/dist/index.js";
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
  const out = {};
  for (const id of reportAnalysisIds(definition)) { const a = store.analyses.find((x) => x.id === id && !x.deleted_at); if (!a) continue; try { if (store.failIds?.has(id)) throw new Error("boom"); out[id] = compute({ ...a.definition, id, name: a.name }); } catch { out[id] = { ...failedResult(a.name, a.definition.kind), recommendations: [] }; } }
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
  /* the report builder — the same engine calls the real route makes */
  if (head === "report-builder") {
    const vars = variableMetadata(def).filter((v) => !v.hidden);
    if (itemId === "draft") {
      store.drafts = (store.drafts ?? 0) + 1;
      const b = body.brief ?? {};
      const brief = { objective: String(b.objective ?? ""), audience: b.audience ?? "client", tone: b.tone ?? "plain", keyQuestions: b.keyQuestions ?? [], ...(b.analysisIds?.length ? { analysisIds: b.analysisIds } : {}), ...(b.includeTests === false ? { includeTests: false } : {}), ...(b.includeCrosstabs === false ? { includeCrosstabs: false } : {}), ...(b.maxItems ? { maxItems: b.maxItems } : {}) };
      if (!brief.objective && !brief.keyQuestions.length) return json(route, { error: "State the objective or at least one key question — the report is built around what you want to learn." }, 400);
      const live = store.analyses.filter((a) => !a.deleted_at && (!brief.analysisIds || brief.analysisIds.includes(a.id)));
      if (!live.length) return json(route, { error: "This survey has no saved analyses yet. Create the analyses first (the Analysis tab can create them from the analysis plan), then build the report." }, 409);
      const items = live.map((a) => { try { if (store.failIds?.has(a.id)) throw new Error("boom"); return { id: a.id, name: a.name, definition: { ...a.definition, id: a.id, name: a.name }, result: compute({ ...a.definition, id: a.id, name: a.name }) }; } catch { return { id: a.id, name: a.name, definition: a.definition, result: failedResult(a.name, a.definition.kind) }; } });
      let model = { status: "not_asked", detail: "Interpretation was not requested." }, interpretation = null;
      if (body.interpretation) {
        if (!store.fakeModel) model = { status: "no_model", detail: "No AI model is configured for this workspace, so no interpretation was written. Findings are unaffected." };
        else { const g = gateInterpretation(items, store.fakeModel); const kept = g.implications.length + g.recommendations.length; interpretation = kept ? g : null; model = { status: kept ? "gated" : "nothing", detail: `${kept} of ${g.offered} model sentences passed the number check${g.rejected.length ? `; dropped: ${g.rejected.map((r) => `“${r.text.slice(0, 60)}” (${r.reason})`).join(" | ")}` : ""}.` }; }
      }
      const draft = draftReport(brief, items, vars, { story: body.story === true, interpretation });
      return json(route, { ...draft, model, truncated: false, analysesRead: items.length });
    }
    if (itemId === "scene") {
      const r = store.reports.find((x) => x.id === body.reportId); const story = r?.definition?.story;
      if (!story) return json(route, { error: "This report has no story." }, 404);
      const items = store.analyses.filter((a) => !a.deleted_at).map((a) => ({ id: a.id, name: a.name, definition: { ...a.definition, id: a.id, name: a.name }, result: compute({ ...a.definition, id: a.id, name: a.name }) }));
      const out = regenerateScene(story, body.sceneId, items, vars);
      return "error" in out ? json(route, { error: out.error }, 409) : json(route, { scene: out.scene });
    }
    if (itemId === "story") {
      const r = store.reports.find((x) => x.id === body.reportId); const story = r?.definition?.story;
      if (!story?.scenes?.length) return json(route, { error: "This report has no story to export. Build one with the report builder first." }, 404);
      const results = reportResults({ story }); const chk = checkSnapshot({ story }, results);
      if (!chk.ok) return json(route, { error: `The story cannot be exported yet: ${chk.problems.join(" ")}`, code: "story_blank" }, 409);
      store.lastStoryExport = { narration: body.narration === true };
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-disposition": 'attachment; filename="story.html"', "x-rescript-export-notes": encodeURIComponent(JSON.stringify([body.narration ? "No speech provider is configured, so the story was exported without narration." : "Exported without narration.", `${story.scenes.filter((s) => !s.hidden).length} scenes, from the latest computed results.`])), "access-control-expose-headers": "x-rescript-export-notes, content-disposition" }, body: storyHtml(story, { results }) });
    }
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
  return json(route, { report: { name: r.name, title: v.definition.title, subtitle: v.definition.subtitle, blocks: v.definition.blocks, story: v.definition.story ?? null, widgets: v.definition.widgets ?? null, hero: v.definition.hero ?? null, bands: v.definition.bands ?? null, viewerSegments: v.definition.viewerSegments ?? [], branding: v.definition.branding ?? {} }, theme: v.theme, results: v.snapshot, version: v.version, publishedAt: v.published_at, mode: "snapshot", dataset: v.dataset, permission: s.permission });
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

/* ------------------------------------------------------------------ seed */
const sat = mkAnalysis("Overall satisfaction", { variables: ["SAT"] });
const consider = mkAnalysis("Brands considered", { variables: ["CONSIDER"] });
const xt = mkAnalysis("Satisfaction by gender", { kind: "crosstab", variables: [], extra: { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" } });
const broken = mkAnalysis("Region split", { variables: ["REGION"] });
const dupe = mkAnalysis("Satisfaction again", { variables: ["SAT"] });
store.failIds = new Set([broken.id]);
const framed = (sel) => page.frameLocator(sel);
const fx = '[data-testid="ax-story-preview"]';

/* ------------------------------------------------------------------ 1 */
console.log("\n§1 THE BUILDER — brief, review, create");
await openReports();
await page.click('[data-testid="ax-build-report"]');
await page.waitForSelector('[data-testid="ax-builder"]');
assert.equal(await page.$eval('[data-testid="ax-builder-draft"]', (b) => b.disabled), true, "no objective and no question: nothing to build around");
await page.fill('[data-testid="ax-builder-objective"]', "Understand how satisfied customers are and which brands they consider");
await page.fill('[data-testid="ax-builder-questions"]', "How satisfied are customers overall?\nWhat is the average delivery time?");
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-review"]');
assert.equal(store.reports.length, 0, "a draft saves nothing — the review comes first");
const incl = await page.$$eval('[data-testid="ax-builder-included"]', (es) => es.map((e) => e.textContent.replace(/\s+/g, " ")));
assert.equal(incl.length, 3, `satisfaction, brands, satisfaction by gender: ${incl.join(" || ")}`);
const consText = incl.find((t) => t.includes("Brands considered"));
assert.match(consText, /bar horizontal/, "multiple-choice: horizontal bars");
assert.match(consText, /several answers were allowed.*more than 100%/, "with its denominator");
assert.match(incl.find((t) => t.includes("Overall satisfaction")), /answers a key question/);
ok("the review shows each chart, why it was chosen and what its percentages are of");
const skipped = await page.$$eval('[data-testid="ax-builder-skipped"]', (es) => es.map((e) => e.textContent.replace(/\s+/g, " ")));
assert.equal(skipped.length, 2);
assert.ok(skipped.some((s) => /Region split.*could not be computed|Region split — /.test(s)), `the failed analysis is listed: ${skipped.join(" | ")}`);
assert.ok(skipped.some((s) => /Satisfaction again.*exactly what “Overall satisfaction”/.test(s)), "the repeat names what it repeats");
ok("analyses that cannot be shown or repeat another are left out, each with its reason");
const notes = await page.$$eval('[data-testid="ax-builder-note"]', (es) => es.map((e) => e.textContent));
assert.ok(notes.some((n) => /No saved analysis answers/.test(n) && /delivery time/.test(n)), "the key question nothing answers is named, not papered over");
ok("a key question no saved analysis answers is reported");
// untick one and rebuild
await page.click('[data-testid="ax-builder-included"]:has-text("Brands considered") input[type=checkbox]');
await page.click('[data-testid="ax-builder-rebuild"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-builder-included"]').length === 2);
assert.equal(store.drafts, 2); assert.equal(store.reports.length, 0);
ok("unticking an analysis rebuilds the draft without it, still saving nothing");
// put it back through a fresh brief so the story has a battery of scales later: go back and re-draft with everything
await page.click('text=← Change the brief');
await page.fill('[data-testid="ax-builder-objective"]', "Understand how satisfied customers are and which brands they consider");
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-review"]');
await page.click('[data-testid="ax-builder-create"]');
await page.waitForSelector('[data-testid="ax-report-builder"]');
assert.equal(store.reports.length, 1);
const made = store.reports[0];
assert.equal(made.definition.blocks[0].type, "cover");
ok("Create writes one report and opens it");

/* ------------------------------------------------------------------ 2 */
console.log("\n§2 THE REPORT — every sentence from the results");
const bodyText = await page.$eval('[data-testid="ax-report-builder"]', (e) => e.textContent.replace(/\s+/g, " "));
assert.match(bodyText, /400 respondents in the selected data/);
assert.match(bodyText, /% of all 400 respondents/);
assert.match(bodyText, /several answers were allowed, so the bars add to more than 100%/);
assert.match(bodyText, /39\.5%/, "the headline of the satisfaction analysis, as the analysis printed it");
for (const b of made.definition.blocks.filter((x) => x.type === "chart")) assert.ok(store.analyses.some((a) => a.id === b.analysisId), "every chart block points at a saved analysis");
ok("captions are the analyses' own insights with their denominators; every chart reads a saved analysis");

/* ------------------------------------------------------------------ 3 */
console.log("\n§3 THE STORY — preview, edit, regenerate, save");
await page.click('[data-testid="ax-story-toggle"]');
await page.waitForSelector('[data-testid="ax-story"]');
const nScenes = await count('[data-testid="ax-story-scene"]');
assert.ok(nScenes >= 6, `title, objective, sample, findings, summary: ${nScenes}`);
await page.waitForSelector(fx);
assert.equal(await framed(fx).locator(".scene").count(), nScenes, "the preview has every scene");
assert.match(await framed(fx).locator(".scene").first().textContent(), /Understand how satisfied|Survey findings/);
ok("the story the builder made opens in the Story tab and is previewed with the real renderer");
// edit a finding
await page.click('[data-testid="ax-story-scene"]:has-text("Overall satisfaction")');
await page.waitForSelector('[data-testid="ax-story-editor"]');
const original = await page.inputValue('[data-testid="ax-story-text"]');
assert.match(original, /Overall satisfaction/);
await page.fill('[data-testid="ax-story-text"]', "Most customers are fairly satisfied.");
await page.waitForFunction(() => document.querySelector('[data-testid="ax-story-preview"]').srcdoc.includes("Most customers are fairly satisfied."));
assert.match(await page.$eval('[data-testid="ax-story-editor"]', (e) => e.textContent), /written by you/);
ok("edited text shows in the preview and is marked as the researcher's own");
const opts = await page.$$eval('[data-testid="ax-story-chart"] option', (os) => os.map((o) => o.value));
assert.ok(opts.includes("bar_vertical") && !opts.includes("nonsense") && opts.length >= 2, `only charts the result can draw: ${opts}`);
await page.selectOption('[data-testid="ax-story-chart"]', "bar_horizontal");
await page.waitForFunction(() => document.querySelector('[data-testid="ax-story-preview"]').srcdoc.includes('class="bar h"'));
ok("the chart can be changed per scene, to one the data can draw");
// regenerate restores the engine's words
await page.click('[data-testid="ax-story-regenerate"]');
await page.waitForFunction((o) => document.querySelector('[data-testid="ax-story-text"]').value === o, original);
assert.equal(await page.$eval('[data-testid="ax-story-chart"]', (s) => s.value), "bar_horizontal", "a chart choice that is still valid survives regeneration");
ok("regenerating a scene rebuilds it from its analysis and keeps a still-valid chart choice");
// hide a scene
await page.click('[data-testid="ax-story-scene"]:has-text("Brands considered")');
await page.uncheck('[data-testid="ax-story-editor"] input[type=checkbox]');
await page.waitForFunction((n) => document.querySelector('[data-testid="ax-story-preview"]').srcdoc.split('data-scene="').length - 1 === n - 1, nScenes);
ok("a scene can be hidden from the story");
// export is blocked while there are unsaved edits
assert.equal(await page.$eval('[data-testid="ax-story-export"]', (b) => b.disabled), true, "export reads the saved story");
await page.click('[data-testid="ax-report-save"]');
await page.waitForFunction(() => document.querySelector('[data-testid="ax-report-save"]').textContent.trim() === "Saved");
assert.equal(store.reports[0].definition.story.scenes.filter((s) => s.hidden).length, 1);
ok("saving persists the story, hidden scene included");
// reload: still there
await openReport(made.name);
assert.match(await text('[data-testid="ax-story-toggle"]'), /Story ●/);
await page.click('[data-testid="ax-story-toggle"]');
await page.waitForSelector(fx);
assert.equal(await count('[data-testid="ax-story-scene"]'), nScenes);
ok("after a reload the story is as saved");

/* a report that has no story offers to build one from its own analyses */
const handmade = mkReport("Hand-made", { title: "Hand-made", mode: "live", blocks: [{ id: "c0", type: "cover", title: "Hand-made" }, { id: "c1", type: "chart", title: "Satisfaction", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } }, { id: "c2", type: "chart", title: "By gender", analysisId: xt.id, chart: { type: "bar_grouped", options: {} } }] });
await openReport("Hand-made");
await page.click('[data-testid="ax-story-toggle"]');
await page.waitForSelector('[data-testid="ax-story-empty"]');
await page.click('[data-testid="ax-story-make"]');
await page.waitForSelector(fx);
const types = await page.$$eval('[data-testid="ax-story-scene"]', (es) => es.map((e) => e.textContent));
assert.ok(types.length >= 4 && /Overall satisfaction|Satisfaction/.test(types.join(" ")));
assert.equal(await page.$eval('[data-testid="ax-report-save"]', (b) => b.textContent.trim()), "Save", "the new story is an unsaved edit until saved");
ok("a report with no story offers to build one from its own charts — as an unsaved edit");
confirmAnswer = true;
await openReport(made.name);
await page.click('[data-testid="ax-story-toggle"]'); await page.waitForSelector(fx);

/* ------------------------------------------------------------------ 4 */
console.log("\n§4 EXPORT — one HTML file that really plays");
const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-story-export"]')]);
const fs = await import("node:fs");
const file = `${process.env.AX_OUT ?? "/tmp"}/story-test.html`;
await dl.saveAs(file);
const html = fs.readFileSync(file, "utf8");
assert.match(html, /^<!doctype html>/);
assert.equal((html.match(/data-scene="/g) ?? []).length, nScenes - 1, "every visible scene, no hidden one");
assert.ok(!/(src|href)="https?:/.test(html), "no network reference");
assert.match(await text('[data-testid="ax-story-msg"]'), /Story downloaded.*without narration/);
ok("the story downloads as a self-contained file, and says it has no narration");
await page.check('[data-testid="ax-story"] .card:has-text("Export") input[type=checkbox]');
await Promise.all([page.waitForEvent("download"), page.click('[data-testid="ax-story-export"]')]);
assert.equal(store.lastStoryExport.narration, true);
assert.match(await text('[data-testid="ax-story-msg"]'), /No speech provider is configured, so the story was exported without narration/);
ok("asking for narration without a speech provider says so — never a silent success");
assert.match(await text('[data-testid="ax-story"]'), /Video \(MP4\) is not available/);
ok("video is not offered, and the page says why");
// play the file in a real browser
const net = []; const errs = [];
const player = await ctx.newPage();
player.on("pageerror", (e) => errs.push(e.message)); player.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await player.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith("file:") || u.startsWith("data:") || u.startsWith("about:")) return r.continue(); net.push(u); return r.abort(); });
await player.goto(`file://${file}`);
await player.waitForSelector(".scene.on");
const total = await player.$$eval(".scene", (s) => s.length);
assert.equal((await player.$eval("#count", (e) => e.textContent)), `1 / ${total}`);
await player.keyboard.press("ArrowRight");
assert.equal((await player.$eval("#count", (e) => e.textContent)), `2 / ${total}`);
await player.keyboard.press("ArrowLeft");
await player.click("#play");
await player.waitForFunction(() => document.querySelector("#count").textContent.startsWith("2 /"), null, { timeout: 12000 });
await player.click("#play");
assert.match(await player.$eval("#play", (e) => e.textContent), /Play/, "pauses");
await player.click("#cc");
assert.ok(await player.$eval("#stage", (e) => e.classList.contains("caps")), "captions toggle");
if (process.env.AX_SHOTS) { await player.keyboard.press("ArrowRight"); await player.waitForTimeout(1200); await player.screenshot({ path: `${process.env.AX_SHOTS}/story-scene.png` }); }
assert.deepEqual(errs, [], "no console errors while playing");
assert.deepEqual(net, [], "no network request while playing");
ok("the exported file plays: scenes advance by themselves, keyboard and captions work, no errors, no network");
await player.close();

/* ------------------------------------------------------------------ 5 */
console.log("\n§5 SHARING — the shared page plays the frozen story");
await page.click('[data-testid="ax-report-publish"]');
await page.waitForSelector('.ax-ok:has-text("Published version 1")');
const snap = store.reportVersions[0].snapshot;
assert.ok(Object.keys(snap).length >= 3, "the snapshot holds every analysis the report and story read");
await page.click('[data-testid="ax-report-share"]');
await page.waitForSelector('[data-testid="ax-share-dialog"]');
await page.click('[data-testid="ax-share-create"]');
await page.waitForSelector('[data-testid="ax-share-link"] input');
const link = await page.$eval('[data-testid="ax-share-link"] input', (e) => e.value);
const anon = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
await anon.route("**/api/share/**", fakeShare);
const pub = await anon.newPage();
await pub.goto(link, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-view"]');
await pub.click('[data-testid="ax-share-story"]');
const sf = pub.frameLocator('[data-testid="ax-share-story-frame"]');
await sf.locator(".scene.on").first().waitFor();
assert.equal(await sf.locator(".scene").count(), nScenes - 1);
const shared = await pub.frameLocator('[data-testid="ax-share-story-frame"]').locator("body").innerHTML();
assert.ok(/<text[^>]*class="val"[^>]*>39\.5%</.test(shared), "the shared story DRAWS the frozen snapshot's number in a chart, not only in its sentence");
assert.ok(!shared.includes("has no results to draw"), "no scene of the shared story is blank");
// change the live data: the shared story must not move
store.analyses.find((a) => a.id === sat.id).definition.variables = ["REGION"];
await pub.reload({ waitUntil: "networkidle" }); await pub.click('[data-testid="ax-share-story"]');
assert.ok(/<text[^>]*class="val"[^>]*>39\.5%</.test(await pub.frameLocator('[data-testid="ax-share-story-frame"]').locator("body").innerHTML()), "a saved-analysis edit after publishing does not change the shared story");
store.analyses.find((a) => a.id === sat.id).definition.variables = ["SAT"];
ok("the shared story plays from the published snapshot — not live data, not blank");
await anon.close();

/* ------------------------------------------------------------------ 6 */
console.log("\n§6 INTERPRETATION — a model's words pass the number gate or are dropped");
store.fakeModel = { implications: ["The most common satisfaction answer may be “4”, at 39.5%, which suggests broad satisfaction.", "Satisfaction rose by 37% last quarter."], recommendations: ["Follow up with the 400 respondents on what drives the gap."] };
await openReports();
await page.click('[data-testid="ax-build-report"]');
await page.fill('[data-testid="ax-builder-objective"]', "Understand satisfaction");
await page.check('text=add an AI-written interpretation >> input');
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-review"]');
const mtxt = await text('[data-testid="ax-builder-model"]');
assert.match(mtxt, /2 of 3 model sentences passed the number check/);
assert.match(mtxt, /37%.*not in the run/);
await page.click('[data-testid="ax-builder-create"]');
await page.waitForSelector('[data-testid="ax-report-builder"]');
const rep2 = store.reports[store.reports.length - 1];
assert.ok(rep2.definition.blocks.some((b) => b.type === "section" && b.title === "Interpretation"));
assert.ok(!JSON.stringify(rep2.definition).includes("37%"), "the invented number is in nothing that was saved");
await page.click('[data-testid="ax-story-toggle"]');
await page.waitForSelector(fx);
const frameHtml = await page.$eval(fx, (f) => f.srcdoc);
assert.match(frameHtml, /Interpretation<span class="tag">not a finding<\/span>/, "the reading is labelled on screen");
assert.ok(!frameHtml.includes("37%"));
ok("the review states what passed and what was dropped; the dropped sentence is nowhere in the saved report");
store.fakeModel = null;

/* ------------------------------------------------------------------ 7 */
console.log("\n§7 EMPTY STATE — no analyses, no blank report");
const keep = store.analyses.splice(0, store.analyses.length);
await openReports();
await page.click('[data-testid="ax-build-report"]');
await page.fill('[data-testid="ax-builder-objective"]', "Anything");
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-error"]');
assert.match(await text('[data-testid="ax-builder-error"]'), /no saved analyses yet.*Create the analyses first/);
assert.equal(store.reports.length, 3, "nothing was created");
store.analyses.push(...keep);
ok("with no saved analyses the builder says what to do instead of producing an empty report");

/* every analysis failing: the review says nothing could be shown and creating is not offered */
store.failIds = new Set(store.analyses.map((a) => a.id));
await openReports();
await page.click('[data-testid="ax-build-report"]');
await page.fill('[data-testid="ax-builder-objective"]', "Anything");
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-review"]');
assert.match(await text('[data-testid="ax-builder-review"]'), /Nothing could be shown/);
assert.equal(await page.$eval('[data-testid="ax-builder-create"]', (b) => b.disabled), true);
assert.equal(await count('[data-testid="ax-builder-included"]'), 0);
assert.ok((await count('[data-testid="ax-builder-skipped"]')) >= 3, "every analysis is listed with its reason");
ok("when nothing can be shown the review says so and Create is not offered");

console.log(`\n${passed} checks passed`);
await browser.close();
