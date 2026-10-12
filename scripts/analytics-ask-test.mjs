/**
 * INTELLIGENT MODE FOR ANALYTICS — the "Ask" tab (Data Analytics audit, Phase 5),
 * through the real UI against the in-process fake backend. The fake runs the REAL
 * reading engine (proposeFromText / parseAskOps / parseUndo) and the REAL apply
 * and undo code (lib/analyticsAskApply.ts) over an in-memory database, so what is
 * checked here is what the route does — except for the HTTP/auth shell around it.
 *
 *  1. a request becomes a PROPOSAL; nothing is saved until it is applied, and
 *     the screen says "Proposed — not applied"
 *  2. apply → "Done", the analyses exist (with the request recorded), and
 *     Undo takes exactly those back
 *  3. what repeats a saved analysis is Blocked with the reason, never saved twice
 *  4. "remove redundant analyses": repeats and tests a cross-tab carries; an
 *     analysis a report uses stays
 *  5. "best chart for each question": a pie on a multiple-choice question becomes
 *     horizontal bars with the reason; the person can swap for another valid chart;
 *     undo restores the original
 *  6. what is not understood / ambiguous is said, and nothing is invented
 *  7. management summary / animated report → the report builder's review,
 *     pre-filled; nothing is created from the Ask tab itself
 *  8. history survives a reload
 *
 * Needs `pnpm dev:studio` (3000).   node scripts/analytics-ask-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { navLabels } from "./lib/nav.mjs";
import assert from "node:assert/strict";
import { checkSnapshot, reportAnalysisIds, failedResult, adviseChart, buildDataset, runAnalysis, recommendCharts, DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, BUILT_IN_DASHBOARD_TEMPLATES, applyTemplate, applyDashboardTemplate, dashboardAsTemplate, templateKind, reportPages, draftReport, regenerateScene, storyHtml, gateInterpretation, proposeFromText, parseAskOps, parseUndo, surveyKnownNames } from "../packages/analytics/dist/index.js";
import { applyOps, undoRecords } from "../apps/studio/lib/analyticsAskApply.ts";
import { memoryDb } from "./lib/memdb.mjs";
import { buildPptx, buildXlsx, isEmbeddableImage } from "../packages/analytics/dist/export/index.js";
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
  /* Intelligent Mode — the real reading engine and the real apply/undo code over the fake store */
  if (head === "intelligent" && m === "POST") {
    const dataset = { environment: "LIVE", dataset: "all" };
    const vars = variableMetadata(def);
    const db = memoryDb({ analytics_analyses: store.analyses, analytics_analysis_versions: store.analysisVersions, analytics_charts: store.charts, analytics_reports: store.reports });
    const contextFor = async (needResults) => {
      const analyses = store.analyses.filter((a) => !a.deleted_at).map((a) => ({ id: a.id, name: a.name, definition: { ...a.definition, id: a.id, name: a.name } }));
      const reports = store.reports.filter((r) => !r.deleted_at && r.kind === "report").map((r) => ({ id: r.id, name: r.name, definition: r.definition }));
      const results = {};
      if (needResults) for (const a of analyses) results[a.id] = compute(a.definition);
      return { variables: vars, known: surveyKnownNames(def, vars), analyses, reports, results, dataset };
    };
    if (itemId === "propose") {
      store.proposes = (store.proposes ?? 0) + 1;
      const request = String(body.request ?? "").trim();
      if (!request) return json(route, { error: "Say what you want done, for example: “cross-tabs of satisfaction by age and gender”." }, 400);
      return json(route, { ...proposeFromText(request, await contextFor(true)), model: { status: "not_asked", detail: "" } });
    }
    if (itemId === "apply") {
      const { ops, rejected } = parseAskOps(body.ops);
      if (!ops.length) return json(route, { error: rejected[0] ?? "There is nothing to apply." }, 400);
      store.lastApplyOps = ops;
      const applied = await applyOps(db, SURVEY, "1.0", "u1", ops, dataset, String(body.request ?? ""), contextFor);
      for (const a of applied) if (a.status === "done") store.audit.push("analytics.intelligent_applied");
      return json(route, { applied, rejected });
    }
    if (itemId === "undo") {
      const records = parseUndo(body.records);
      if (!records.length) return json(route, { error: "There is nothing to undo." }, 400);
      return json(route, { undone: await undoRecords(db, SURVEY, "u1", records) });
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
const openReports = async () => { await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ax-workspace"]'); await page.click('[data-testid="ax-tab-reports"]'); };
const openReport = async (name) => { await openReports(); await page.click(`[data-testid="ax-report-card"]:has-text("${name}")`); await page.waitForSelector('[data-testid="ax-report-builder"]'); };
const exportNow = async () => { await page.click('[data-testid="ax-report-export"]'); await page.waitForSelector('[data-testid="ax-export-dialog"]'); };

/* ------------------------------------------------------------------ 1 */

/* ------------------------------------------------------------------ seed */
const sat = mkAnalysis("Overall satisfaction", { variables: ["SAT"] });
const consider = mkAnalysis("Brands considered", { variables: ["CONSIDER"] });
const region = mkAnalysis("Region", { variables: ["REGION"] });
const R = mkReport("Quarterly report", { title: "Quarterly report", mode: "live", blocks: [
  { id: "b-brands", type: "chart", title: "Brands considered", analysisId: consider.id, chart: { type: "pie", options: {} } },
  { id: "b-sat", type: "chart", title: "Overall satisfaction", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } },
] });
const openAsk = async () => { await page.goto(`${STUDIO}/analytics`, { waitUntil: "networkidle" }); await page.waitForSelector('[data-testid="ax-workspace"]'); await page.click('[data-testid="ax-tab-ask"]'); await page.waitForSelector('[data-testid="ax-ask"]'); };
const ask = async (t) => { await page.fill('[data-testid="ax-ask-input"]', t); await page.click('[data-testid="ax-ask-propose"]'); await page.waitForSelector('[data-testid="ax-ask-review"]'); await page.waitForFunction((x) => !document.querySelector('[data-testid="ax-ask-propose"]').textContent.includes("Reading"), null); };
const items = () => page.$$eval('[data-testid="ax-ask-item"]', (es) => es.map((e) => ({ text: e.textContent.replace(/\s+/g, " ").trim(), status: e.getAttribute("data-status"), op: e.getAttribute("data-op") })));
const live = () => store.analyses.filter((a) => !a.deleted_at);

/* ------------------------------------------------------------------ 1 */
console.log("\n§1 A REQUEST BECOMES A PROPOSAL — nothing is saved yet");
await openAsk();
const before = live().length;
await ask("Create cross-tabs of satisfaction by age and gender");
let it = await items();
assert.equal(it.length, 2, JSON.stringify(it));
assert.ok(it.every((i) => i.status === "proposed" && i.op === "add_crosstab" && /Proposed — not applied/.test(i.text)));
assert.ok(it.some((i) => /Cross-tab Overall satisfaction by Age/.test(i.text)) && it.some((i) => /by Gender/.test(i.text)), it.map((i) => i.text).join(" | "));
assert.ok(it.every((i) => /with column percentages and significance letters/.test(i.text)), "each item says why and what it does");
assert.equal(live().length, before, "proposing wrote nothing");
assert.equal(store.lastApplyOps, undefined);
ok("two cross-tabs are proposed with their reasons, labelled 'not applied', and nothing is saved");

/* ------------------------------------------------------------------ 2 */
console.log("\n§2 APPLY → DONE → UNDO");
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="done"]').length === 2);
assert.equal(live().length, before + 2);
const made = live().slice(before);
assert.ok(made.every((a) => a.kind === "crosstab" && a.definition.options.requested === "Create cross-tabs of satisfaction by age and gender" && a.definition.rows[0] === "SAT"), "saved as real crosstabs, with the request that made them");
assert.equal(store.analysisVersions.filter((v) => made.some((a) => a.id === v.analysis_id)).length, 2, "each has its first version");
assert.match(await text('[data-testid="ax-ask-msg"]'), /2 applied/);
ok("applying saves exactly the two analyses and the screen says Done");
await page.click('[data-testid="ax-ask-undo"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="proposed"]').length === 2);
assert.equal(live().length, before, "undo took back exactly what was added");
assert.ok(made.every((a) => a.deleted_at));
assert.equal(await count('[data-testid="ax-ask-undo"]'), 0, "an undone batch cannot be undone again");
ok("Undo removes them again and the items return to 'Proposed'");

/* ------------------------------------------------------------------ 3 */
console.log("\n§3 A REPEAT IS BLOCKED, NOT SAVED TWICE");
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="done"]').length === 2);
await ask("Create cross-tabs of satisfaction by gender");
it = await items();
assert.equal(it.length, 1);
assert.match(it[0].text, /Cannot be applied: You already have “Overall satisfaction by Gender”/);
assert.equal(await page.$eval('[data-testid="ax-ask-check"]', (c) => c.disabled), true);
assert.equal(await page.$eval('[data-testid="ax-ask-check"]', (c) => c.checked), false, "a blocked item is not shown ticked");
assert.equal(await page.$eval('[data-testid="ax-ask-apply"]', (b) => b.disabled), true, "nothing to apply");
ok("a cross-tab you already have is shown as blocked with the reason and cannot be applied");
const catchAll = live().length;
// the workspace shows what was applied without a reload
await page.click('[data-testid="ax-tab-analysis"]');
await page.waitForSelector('[data-testid="ax-rail"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ax-rail-item"]')].some((e) => /Overall satisfaction by Age/.test(e.textContent)));
ok("the Analysis rail lists what was applied, with no reload");
await page.click('[data-testid="ax-tab-ask"]');

/* ------------------------------------------------------------------ 3b */
console.log("\n§3b A PROPOSAL THAT WENT STALE — the server's answer wins");
await ask("Create a cross-tab of satisfaction by region");
assert.equal((await items()).length, 1);
const tabs0 = live().length;
// meanwhile, somebody else saves exactly that analysis
mkAnalysis("Satisfaction by region (colleague)", { kind: "crosstab", variables: [], extra: { rows: ["SAT"], columns: ["REGION"], measure: "pct_col" } });
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="blocked"]').length === 1);
assert.match((await items())[0].text, /Blocked.*already have “Satisfaction by region \(colleague\)”/);
assert.equal(live().length, tabs0 + 1, "only the colleague's analysis exists — nothing was saved twice");
assert.match(await text('[data-testid="ax-ask-msg"]'), /0 applied, 1 not applied/);
assert.equal(await count('[data-testid="ax-ask-undo"]'), 0, "nothing was done, so there is nothing to undo");
ok("applying a proposal that went stale shows Blocked with the server's reason — not Done — and saves nothing");
store.analyses.pop();

/* ------------------------------------------------------------------ 4 */
console.log("\n§4 REMOVE REDUNDANT ANALYSES");
const rep1 = mkAnalysis("Satisfaction again", { variables: ["SAT"] });             // repeats Overall satisfaction (which the report uses)
const chi = mkAnalysis("Satisfaction gap by gender", { kind: "test", variables: ["SAT", "GENDER"], extra: { options: { test: "auto" } } });   // the cross-tab above already reports it
await ask("Remove redundant analyses");
it = await items();
assert.equal(it.length, 2, JSON.stringify(it));
assert.ok(it.every((i) => i.op === "remove_analysis" && i.status === "proposed"));
assert.ok(it.some((i) => /Remove “Satisfaction again”/.test(i.text) && /Kept: “Overall satisfaction”/.test(i.text)));
assert.ok(it.some((i) => /Remove “Satisfaction gap by gender”/.test(i.text) && /already reports this chi-square test/.test(i.text)));
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="done"]').length === 2);
assert.ok(rep1.deleted_at && chi.deleted_at, "both removed");
assert.ok(!sat.deleted_at, "the one the report uses, and that the repeat duplicates, is kept");
ok("repeats and a test a cross-tab already carries are removed; the researcher's own analysis is kept");
await page.click('[data-testid="ax-ask-undo"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="proposed"]').length === 2);
assert.ok(!rep1.deleted_at && !chi.deleted_at, "undo restores them");
ok("Undo restores what was removed");
// the one a report uses cannot be removed even when it is the repeat
store.reports[0].definition.blocks.push({ id: "b-dup", type: "chart", title: "Dup", analysisId: rep1.id, chart: { type: "bar_vertical", options: {} } });
await ask("remove duplicate analyses");
it = await items();
assert.ok(it.some((i) => /Cannot be applied: It is used by “Quarterly report”/.test(i.text)), it.map((i) => i.text).join(" | "));
store.reports[0].definition.blocks.pop(); rep1.deleted_at = now(); chi.deleted_at = now();
ok("an analysis a report uses is blocked from removal, with the report named");

/* ------------------------------------------------------------------ 5 */
console.log("\n§5 BEST CHART FOR EACH QUESTION");
await ask("Choose the best chart for each question");
it = await items();
assert.equal(it.length, 1, `only the misfit is proposed: ${JSON.stringify(it)}`);
assert.match(it[0].text, /show “Brands considered” as bar horizontal \(now pie\)/);
assert.match(it[0].text, /implies the answers add up to 100%, but people could choose several/);
const alts = await page.$$eval('[data-testid="ax-ask-alt"] option', (os) => os.map((o) => o.value).filter(Boolean));
assert.ok(alts.length >= 1 && !alts.includes("pie") && !alts.includes("bar_horizontal"), alts.join(","));
ok("a pie on a multiple-choice question becomes horizontal bars, with the reason; the satisfaction chart that already suits is left alone");
await page.selectOption('[data-testid="ax-ask-alt"]', alts[0]);
assert.match((await items())[0].text, new RegExp(`as ${alts[0].replace(/_/g, " ")}`));
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="done"]').length === 1);
const blockType = () => store.reports[0].definition.blocks.find((b) => b.id === "b-brands").chart.type;
assert.equal(blockType(), alts[0], "the swapped chart is the one saved");
assert.equal(store.reports[0].definition.blocks.find((b) => b.id === "b-sat").chart.type, "bar_vertical", "the other chart is untouched");
ok("the person's swap for another valid chart is what is applied");
await page.click('[data-testid="ax-ask-undo"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="proposed"]').length === 1);
assert.equal(blockType(), "pie");
ok("Undo puts the original chart back");
await ask("Choose the best chart for each question");
await page.click('[data-testid="ax-ask-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ax-ask-item"][data-status="done"]').length === 1);
assert.equal(blockType(), "bar_horizontal");
await ask("Choose the best chart for each question");
assert.match(await text('[data-testid="ax-ask-note"]'), /Every chart in your reports already suits its question/);
assert.equal((await items()).length, 0);
ok("asked again, everything already suits — it says so instead of proposing churn");

/* ------------------------------------------------------------------ 6 */
console.log("\n§6 WHAT IS NOT UNDERSTOOD IS SAID");
await ask("Create a cross-tab of loyalty by gender");
assert.equal((await items()).length, 0);
assert.match(await text('[data-testid="ax-ask-unread"]'), /could not find a question on the left of “by”/);
await ask("Remove redundant analyses and then do my taxes");
assert.match(await text('[data-testid="ax-ask-unread"]'), /do my taxes.*I do not know how to do that here/);
await ask("brands by gender");
assert.match(await text('[data-testid="ax-ask-unread"]'), /could mean.*Brands aware of.*Brands considered|could mean.*Brands considered.*Brands aware of/);
assert.equal((await items()).length, 0);
const nBefore = live().length;
ok("an unknown question, an unsupported ask and an ambiguous name are each reported — nothing is guessed or saved");
assert.equal(live().length, nBefore);

/* ------------------------------------------------------------------ 7 */
console.log("\n§7 REPORTS GO THROUGH THE BUILDER'S REVIEW");
const reportsBefore = store.reports.length;
await ask("Prepare a management summary");
it = await items();
assert.equal(it.length, 1); assert.equal(it[0].op, "build_report");
assert.equal(await count('[data-testid="ax-ask-check"]'), 0, "a report has no tick-box: it is reviewed, not applied");
await page.click('[data-testid="ax-ask-builder"]');
await page.waitForSelector('[data-testid="ax-builder"]');
assert.equal(await page.$eval('[data-testid="ax-builder-audience"]', (s) => s.value), "executive");
assert.match(await page.$eval('[data-testid="ax-builder-objective"]', (t) => t.value), /management summary/i);
assert.equal(await page.$eval('[data-testid="ax-builder-story"]', (c) => c.checked), false, "a management summary is not animated unless asked");
assert.equal(store.reports.length, reportsBefore, "opening the builder creates nothing");
await page.click('[data-testid="ax-builder-draft"]');
await page.waitForSelector('[data-testid="ax-builder-review"]');
assert.ok((await count('[data-testid="ax-builder-included"]')) >= 1);
await page.click('[data-testid="ax-builder-create"]');
await page.waitForFunction((n) => true, null);
await page.waitForSelector('[data-testid="ax-ask-msg"]');
assert.equal(store.reports.length, reportsBefore + 1);
assert.match(await text('[data-testid="ax-ask-msg"]'), /Report created/);
ok("a management summary opens the report builder pre-filled for an executive audience; the review comes before creation");
await ask("Make an animated video report of the key findings");
assert.match(await text('[data-testid="ax-ask-note"]'), /Video files \(MP4\) cannot be generated here/);
await page.click('[data-testid="ax-ask-builder"]');
await page.waitForSelector('[data-testid="ax-builder"]');
assert.equal(await page.$eval('[data-testid="ax-builder-story"]', (c) => c.checked), true);
await page.click('button:has-text("Cancel")');
ok("an animated report asks for the story, and says plainly that video files are not produced");

/* ------------------------------------------------------------------ 8 */
console.log("\n§8 HISTORY");
await openAsk();
await page.waitForSelector('[data-testid="ax-ask-history"]');
await page.click('[data-testid="ax-ask-history"] summary');
const hist = await page.$$eval('[data-testid="ax-ask-history-item"]', (es) => es.map((e) => e.textContent.replace(/\s+/g, " ")));
assert.ok(hist.some((h) => /Choose the best chart for each question.*1 applied/.test(h)), hist.join(" | "));
assert.ok(hist.some((h) => /Remove redundant analyses.*2 applied/.test(h)));
ok("what was applied is listed after a reload, with how many items landed");
assert.ok(store.audit.filter((a) => a === "analytics.intelligent_applied").length >= 5);

console.log(`\n${passed} checks passed`);
await browser.close();
