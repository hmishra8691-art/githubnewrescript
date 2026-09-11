import { NextRequest, NextResponse } from "next/server";
import { assertNotReadOnly, getMeter, projectContext, recordUsage } from "@/lib/metering";
import type { AuditEvent, Capability } from "@rescript/access";
import { buildPptx, buildXlsx } from "@rescript/analytics/export";
import {
  DEFAULT_THEME, BUILT_IN_REPORT_TEMPLATES, applyTemplate, describeTemplate,
  type AnalysisDefinition, type AnalysisResult, type ChartSpec, type ReportDefinition, type ReportTemplate, type ReportTheme,
} from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireProject, type ProjectContext } from "@/lib/guard";
import { compute, hashPassword, loadDefinition, loadTheme, newToken, variablesPayload } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE ANALYTICS API — one router for the module (§32, §33, §38).
 *
 *   GET  variables                    dictionary-derived variable metadata + dataset counts
 *   POST run                          compute an AnalysisDefinition server-side → AnalysisResult
 *   GET  home                         recent analyses / reports / shares for the landing page
 *   GET|POST  analyses|charts|segments|themes|reports|shares
 *   GET|PUT|DELETE  <collection>/<id>
 *   GET  analyses/<id>/versions       definition versions (§17)
 *   POST reports/<id>/publish         freeze a version: definition + theme + computed snapshot (§34, §35)
 *   GET  reports/<id>/versions
 *   GET  reports/<id>/results         live results for every analysis a report references
 *   PATCH shares/<id>                 revoke / change expiry, access, permission (§22)
 *   GET  shares/<id>/access           access history
 *   POST export                       PowerPoint / Excel of a report (published version or live) or one analysis
 *   GET  report-templates             built-in + workspace report shapes (§36)
 *   POST report-templates             save this report's shape as a template
 *   DELETE report-templates/<id>      remove a workspace template
 *   POST reports/<id>/apply-template  lay a template over a report, keeping filled blocks
 *
 * Every branch passes `requireProject` with the analytics capability the action
 * needs; the role → capability table lives in `@rescript/access`, so a viewer
 * that tampers with the UI still gets 403 here. Responses never leave this
 * process: only computed results do.
 */

const COLLECTIONS = {
  analyses: { table: "analytics_analyses", read: "analytics.read", write: "analytics.edit", created: "analytics.analysis_created", modified: "analytics.analysis_modified", deleted: "analytics.analysis_deleted" },
  charts: { table: "analytics_charts", read: "analytics.read", write: "analytics.edit", created: "analytics.chart_created", modified: "analytics.chart_modified", deleted: "analytics.chart_modified" },
  segments: { table: "analytics_segments", read: "analytics.read", write: "analytics.edit", created: null, modified: null, deleted: null },
  themes: { table: "analytics_themes", read: "analytics.read", write: "analytics.edit", created: null, modified: null, deleted: null },
  reports: { table: "analytics_reports", read: "analytics.read", write: "analytics.edit", created: "analytics.report_created", modified: "analytics.report_modified", deleted: "analytics.report_modified" },
  shares: { table: "analytics_shares", read: "analytics.read", write: "analytics.publish", created: "analytics.report_shared", modified: "analytics.report_shared", deleted: "analytics.share_revoked" },
} as const;
type Collection = keyof typeof COLLECTIONS;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function gate(req: NextRequest, surveyId: string, cap: Capability) {
  return requireProject(req, surveyId, cap);
}

function log(ctx: ProjectContext, action: AuditEvent | null, entityId: string | null, detail: Record<string, unknown>) {
  if (!action) return;
  void audit({ action, userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "analytics", entityId, detail });
}

export async function GET(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const [head, itemId, action] = params.path ?? [];
  const surveyId = params.id;
  const db = supabaseService();

  if (head === "variables") {
    const ctx = await gate(req, surveyId, "analytics.read"); if (isFailure(ctx)) return ctx.response;
    const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
    return json(await variablesPayload(db, surveyId, loaded));
  }
  if (head === "home") {
    const ctx = await gate(req, surveyId, "analytics.read"); if (isFailure(ctx)) return ctx.response;
    const [a, c, r, s] = await Promise.all([
      db.from("analytics_analyses").select("id, name, kind, version, updated_at, updated_by").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(12),
      db.from("analytics_charts").select("id, name, analysis_id, spec, updated_at").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(12),
      db.from("analytics_reports").select("id, name, kind, mode, published_version, updated_at").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(12),
      db.from("analytics_shares").select("id, report_id, access, permission, expires_at, revoked_at, view_count, created_at").eq("survey_id", surveyId).is("revoked_at", null).order("created_at", { ascending: false }).limit(12),
    ]);
    return json({ analyses: a.data ?? [], charts: c.data ?? [], reports: r.data ?? [], shares: s.data ?? [] });
  }
  /*
   * §36 — REPORT TEMPLATES. A separate branch rather than a COLLECTIONS entry
   * because the table is keyed on the CUSTOMER and not on a survey (like
   * `analytics_themes`, and for the same reason: a house report shape belongs
   * to the workspace, not to whichever study it was first drawn in). The
   * generic collection paths all scope by `survey_id`, and bending them would
   * put a survey predicate on the one table that must not have one.
   *
   * The built-ins are returned alongside the workspace's own, so the picker
   * has something in it on the first day — a template feature with an empty
   * library is a template feature nobody uses.
   */
  if (head === "report-templates") {
    const ctx = await gate(req, surveyId, "analytics.read"); if (isFailure(ctx)) return ctx.response;
    const { data, error } = await db
      .from("analytics_report_templates")
      .select("id, name, description, template, created_at, updated_at")
      .eq("customer_id", ctx.user.customerId ?? "")
      .is("deleted_at", null)
      .order("name", { ascending: true });
    if (error) {
      if (/analytics_report_templates|does not exist|schema cache/i.test(error.message)) {
        return json({ templates: BUILT_IN_REPORT_TEMPLATES, available: false, note: "Saving your own report templates needs migration 0014." });
      }
      return bad(error.message, 500);
    }
    const saved = (data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
      description: (t.description as string) ?? undefined,
      builtIn: false,
      ...((t.template as object) ?? {}),
      blocks: ((t.template as { blocks?: unknown[] })?.blocks ?? []),
    }));
    return json({ templates: [...BUILT_IN_REPORT_TEMPLATES, ...saved], available: true });
  }

  if (head && head in COLLECTIONS) {
    const coll = COLLECTIONS[head as Collection];
    const ctx = await gate(req, surveyId, coll.read); if (isFailure(ctx)) return ctx.response;
    if (!itemId) {
      let q = db.from(coll.table).select("*").eq("survey_id", surveyId).order(head === "shares" ? "created_at" : "updated_at", { ascending: false });
      if (head !== "shares") q = q.is("deleted_at", null);
      if (head === "themes") {
        // themes are shared across the customer (§11): the survey's own plus the workspace's
        q = db.from(coll.table).select("*").is("deleted_at", null).or(`survey_id.eq.${surveyId}${ctx.user.customerId ? `,customer_id.eq.${ctx.user.customerId}` : ""}`).order("updated_at", { ascending: false });
      }
      const kind = req.nextUrl.searchParams.get("kind"); if (kind && (head === "segments" || head === "reports")) q = q.eq("kind", kind);
      const analysisId = req.nextUrl.searchParams.get("analysisId"); if (analysisId && head === "charts") q = q.eq("analysis_id", analysisId);
      const { data, error } = await q; if (error) return bad(error.message, 500);
      return json({ items: (data ?? []).map((row) => head === "shares" ? { ...row, password_hash: undefined, has_password: !!row.password_hash } : row) });
    }
    if (!isUuid(itemId)) return bad("Unknown item.", 404);
    if (action === "versions" && (head === "analyses" || head === "reports")) {
      const table = head === "analyses" ? "analytics_analysis_versions" : "analytics_report_versions";
      const col = head === "analyses" ? "analysis_id" : "report_id";
      const cols = head === "analyses" ? "id, version, definition, summary, created_by, created_at" : "id, version, note, published_by, published_at, dataset, theme";
      const { data, error } = await db.from(table).select(cols).eq(col, itemId).eq("survey_id", surveyId).order("version", { ascending: false });
      if (error) return bad(error.message, 500);
      return json({ versions: data ?? [] });
    }
    if (action === "results" && head === "reports") {
      const { data: report } = await db.from("analytics_reports").select("*").eq("id", itemId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
      if (!report) return bad("Unknown report.", 404);
      const version = req.nextUrl.searchParams.get("version");
      if (version) {
        const { data: v } = await db.from("analytics_report_versions").select("*").eq("report_id", itemId).eq("version", Number(version)).maybeSingle();
        if (!v) return bad("Unknown version.", 404);
        return json({ mode: "snapshot", version: v.version, definition: v.definition, theme: v.theme, results: v.snapshot, dataset: v.dataset, publishedAt: v.published_at });
      }
      const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
      const results = await computeReport(db, surveyId, loaded, report.definition as ReportDefinition);
      return json({ mode: "live", definition: report.definition, theme: await loadTheme(db, report.theme_id), results, computedAt: new Date().toISOString() });
    }
    if (action === "access" && head === "shares") {
      const { data, error } = await db.from("analytics_share_access").select("id, viewer_user_id, viewer_email, event, created_at").eq("share_id", itemId).eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(200);
      if (error) return bad(error.message, 500);
      return json({ events: data ?? [] });
    }
    const { data, error } = await db.from(coll.table).select("*").eq("id", itemId).eq("survey_id", surveyId).maybeSingle();
    if (error) return bad(error.message, 500);
    if (!data || (head !== "shares" && data.deleted_at)) return bad("Unknown item.", 404);
    return json({ item: head === "shares" ? { ...data, password_hash: undefined, has_password: !!data.password_hash } : data });
  }
  return bad("Unknown analytics endpoint.", 404);
}

/**
 * Compute every analysis a report references.
 *
 * `extraFilterIds` is how a REPORT-LEVEL filter and a viewer filter (§36) are
 * applied: the ids are appended to each analysis's own `filterIds`, and
 * `resolveSaved` already ANDs those into one condition. So "the North region
 * report" is the same saved analyses seen through one more filter, rather
 * than a duplicate set of analyses that has to be maintained twice — which is
 * the mistake that makes regional reports drift from the national one.
 */
async function computeReport(
  db: ReturnType<typeof supabaseService>,
  surveyId: string,
  loaded: Awaited<ReturnType<typeof loadDefinition>> & { def: unknown },
  report: ReportDefinition | { widgets?: { analysisId?: string }[]; blocks?: unknown[] },
  extraFilterIds: string[] = [],
) {
  const ids = new Set<string>();
  for (const b of (report as ReportDefinition).blocks ?? []) { if ("analysisId" in b && b.analysisId) ids.add(b.analysisId); if ("analysisIds" in b) for (const id of b.analysisIds) ids.add(id); }
  for (const w of (report as { widgets?: { analysisId?: string }[] }).widgets ?? []) if (w.analysisId) ids.add(w.analysisId);
  if (!ids.size) return {};
  const reportFilter = (report as ReportDefinition).filterId;
  const applied = [...new Set([...(reportFilter ? [reportFilter] : []), ...extraFilterIds])].filter(isUuid);
  const { data } = await db.from("analytics_analyses").select("id, name, definition").in("id", [...ids]).eq("survey_id", surveyId).is("deleted_at", null);
  const results: Record<string, AnalysisResult> = {};
  for (const a of data ?? []) {
    const own = a.definition as AnalysisDefinition;
    const def = {
      ...own,
      id: a.id,
      name: a.name as string,
      ...(applied.length ? { filterIds: [...new Set([...(own.filterIds ?? []), ...applied])] } : {}),
    };
    results[a.id] = await compute(db, surveyId, loaded as never, def);
  }
  return results;
}

export async function POST(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const [head, itemId, action] = params.path ?? [];
  const surveyId = params.id;
  const db = supabaseService();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (head === "run") {
    const ctx = await gate(req, surveyId, "analytics.read"); if (isFailure(ctx)) return ctx.response;
    const def = body.definition as AnalysisDefinition | undefined;
    if (!def || !def.kind || !def.dataset) return bad("A definition with kind and dataset is required.");
    if (!["TEST", "LIVE", "ALL"].includes(def.dataset.environment)) return bad("dataset.environment must be TEST, LIVE or ALL.");
    const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
    try {
      const result = await compute(db, surveyId, loaded, { ...def, name: def.name || def.kind });
      return json({ result });
    } catch (e) { return bad(`Analysis failed: ${(e as Error).message}`, 500); }
  }

  if (head === "export") {
    const ctx = await gate(req, surveyId, "analytics.export"); if (isFailure(ctx)) return ctx.response;
    const format = body.format === "xlsx" ? "xlsx" : "pptx";
    // METERING: report generation respects READ_ONLY (unless exports are allowed) and is recorded as REPORT_GENERATION
    const mctx = projectContext(ctx);
    const blocked = await assertNotReadOnly(getMeter(), mctx, "export");
    if (blocked) return blocked;
    const settings = (body.settings as Record<string, unknown>) ?? {};
    const themeId = (body.themeId as string | null) ?? null;
    let report: ReportDefinition & { author?: string; date?: string }; let results: Record<string, AnalysisResult>; let reportId: string | null = null; let analysisId: string | null = null; let reportVersion: number | null = null; let themeSrc: unknown = null; let name = "";
    if (typeof body.reportId === "string" && isUuid(body.reportId)) {
      const { data: r } = await db.from("analytics_reports").select("*").eq("id", body.reportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
      if (!r) return bad("Unknown report.", 404);
      reportId = r.id; name = r.name;
      const useVersion = typeof body.version === "number" ? body.version : r.mode === "snapshot" ? r.published_version : null;
      if (useVersion != null) {
        const { data: v } = await db.from("analytics_report_versions").select("*").eq("report_id", r.id).eq("version", useVersion).maybeSingle();
        if (!v) return bad("That report version does not exist.", 404);
        report = v.definition as ReportDefinition; results = v.snapshot as Record<string, AnalysisResult>; reportVersion = v.version; themeSrc = v.theme;
      } else {
        const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
        report = r.definition as ReportDefinition; results = await computeReport(db, surveyId, loaded, report);
      }
      if (!themeId && !themeSrc) themeSrc = await loadTheme(db, r.theme_id);
    } else if (typeof body.analysisId === "string" && isUuid(body.analysisId)) {
      const { data: a } = await db.from("analytics_analyses").select("*").eq("id", body.analysisId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
      if (!a) return bad("Unknown analysis.", 404);
      const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
      analysisId = a.id; name = a.name;
      const result = await compute(db, surveyId, loaded, { ...(a.definition as AnalysisDefinition), id: a.id, name: a.name });
      results = { [a.id]: result };
      const chart = (body.chart as ChartSpec | undefined) ?? { type: result.recommendedCharts[0] ?? "bar_vertical", options: {} };
      report = { title: a.name, subtitle: ctx.survey.title, mode: "live", blocks: [{ id: "c", type: "chart", analysisId: a.id, chart }, ...result.tables.map((t, i) => ({ id: `t${i}`, type: "table" as const, analysisId: a.id, tableId: t.id }))] };
    } else if (body.definition && typeof body.definition === "object") {
      // ad-hoc: export an unsaved analysis
      const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
      const def = body.definition as AnalysisDefinition; name = def.name || def.kind;
      const result = await compute(db, surveyId, loaded, def);
      results = { adhoc: result };
      const chart = (body.chart as ChartSpec | undefined) ?? { type: result.recommendedCharts[0] ?? "bar_vertical", options: {} };
      report = { title: name, subtitle: ctx.survey.title, mode: "live", blocks: [{ id: "c", type: "chart", analysisId: "adhoc", chart }, ...result.tables.map((t, i) => ({ id: `t${i}`, type: "table" as const, analysisId: "adhoc", tableId: t.id }))] };
    } else return bad("reportId, analysisId or definition is required.");
    const theme = themeId ? await loadTheme(db, themeId) : (themeSrc as ReportTheme | null) ?? DEFAULT_THEME;
    const meta = { survey: ctx.survey.title, generatedBy: ctx.user.fullName || ctx.user.email };
    const buf = format === "pptx" ? await buildPptx({ report: { ...report, author: report.author ?? ctx.user.fullName }, results, theme, settings: settings as never, meta }) : await buildXlsx({ report, results, theme, settings: settings as never, meta: { Survey: ctx.survey.title, "Generated by": ctx.user.fullName || ctx.user.email } });
    await db.from("analytics_exports").insert({ survey_id: surveyId, report_id: reportId, analysis_id: analysisId, format, settings, report_version: reportVersion, bytes: buf.length, created_by: ctx.user.userId });
    void recordUsage(getMeter(), mctx, { eventType: "REPORT_GENERATION", quantity: 1, metadata: { format, bytes: buf.length, reportId, analysisId } });
    log(ctx, "analytics.export_generated", reportId ?? analysisId, { name, format, version: reportVersion });
    const filename = `${(name || "analytics").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "analytics"}.${format}`;
    return new NextResponse(new Uint8Array(buf), { status: 200, headers: { "content-type": format === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
  }

  if (head === "reports" && itemId && action === "publish") {
    const ctx = await gate(req, surveyId, "analytics.publish"); if (isFailure(ctx)) return ctx.response;
    if (!isUuid(itemId)) return bad("Unknown report.", 404);
    const { data: r } = await db.from("analytics_reports").select("*").eq("id", itemId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
    if (!r) return bad("Unknown report.", 404);
    const loaded = await loadDefinition(db, surveyId); if ("error" in loaded) return bad(loaded.error, loaded.status);
    const definition = r.definition as ReportDefinition;
    const snapshot = await computeReport(db, surveyId, loaded, definition);
    const theme = await loadTheme(db, r.theme_id);
    const { data: last } = await db.from("analytics_report_versions").select("version").eq("report_id", itemId).order("version", { ascending: false }).limit(1);
    const version = (last?.[0]?.version ?? 0) + 1;
    const first = Object.values(snapshot)[0];
    const analysisDefs = await db.from("analytics_analyses").select("definition").in("id", Object.keys(snapshot));
    const environments = [...new Set((analysisDefs.data ?? []).map((a) => (a.definition as AnalysisDefinition).dataset?.environment).filter(Boolean))];
    const dataset = { surveyVersion: loaded.version, revision: loaded.revision, responses: first?.base.total ?? 0, environments, computedAt: new Date().toISOString() };
    /*
     * §36 — every filter a viewer is allowed to apply is computed NOW and
     * frozen beside the base results.
     *
     * A shared report is a snapshot with no dataset access, deliberately: its
     * public page cannot compose a condition or reach a response row, and
     * that does not change. What changes is that it can hold more than one
     * frozen answer, so switching filter in a shared report reads a
     * pre-computed result — the same bargain switching SEGMENT has always
     * made. The cost is paid here, once, by the person publishing, instead of
     * on every view by a stranger.
     */
    const viewerFilters = (definition.viewerFilters ?? []).filter(isUuid).slice(0, 12);
    const filterResults: Record<string, Record<string, AnalysisResult>> = {};
    for (const filterId of viewerFilters) {
      filterResults[filterId] = await computeReport(db, surveyId, loaded, definition, [filterId]);
    }
    /*
     * The filter NAMES are frozen too. A filter renamed — or redefined — in
     * the workspace next month must not change the labels on a report
     * published today: a published version is a record of what was said, and
     * that includes what the buttons said.
     */
    const { data: filterRows } = viewerFilters.length
      ? await db.from("analytics_segments").select("id, name").in("id", viewerFilters).eq("survey_id", surveyId)
      : { data: [] as { id: string; name: string }[] };
    const variants = {
      filters: viewerFilters.map((id) => ({ id, name: (filterRows ?? []).find((f) => f.id === id)?.name ?? "Filter" })),
      results: filterResults,
    };
    const { error } = await db.from("analytics_report_versions").insert({ report_id: itemId, survey_id: surveyId, version, definition, theme, snapshot, dataset, ...(viewerFilters.length ? { variants } : {}), note: typeof body.note === "string" ? body.note : null, published_by: ctx.user.userId });
    if (error) return bad(error.message, 500);
    await db.from("analytics_reports").update({ published_version: version, updated_by: ctx.user.userId }).eq("id", itemId);
    log(ctx, "analytics.report_published", itemId, { name: r.name, version, mode: r.mode, viewerFilters: viewerFilters.length });
    return json({ version, publishedAt: new Date().toISOString(), viewerFilters: viewerFilters.length });
  }

  /*
   * §36 — save the shape of THIS report as a reusable template, or lay a
   * template over a report.
   *
   *   POST report-templates                   { name, description?, fromReportId? | template? }
   *   POST reports/<id>/apply-template        { templateId }
   */
  if (head === "report-templates" && !itemId) {
    const ctx = await gate(req, surveyId, "analytics.edit"); if (isFailure(ctx)) return ctx.response;
    const name = String(body.name ?? "").trim();
    if (!name) return bad("A template needs a name.");
    if (!ctx.user.customerId) return bad("A template belongs to a workspace, and this session has none.", 409);

    let template: ReportTemplate | null = null;
    if (typeof body.fromReportId === "string" && isUuid(body.fromReportId)) {
      const { data: r } = await db.from("analytics_reports").select("definition, theme_id").eq("id", body.fromReportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
      if (!r) return bad("Unknown report.", 404);
      const def = r.definition as ReportDefinition;
      /*
       * The STRUCTURE is saved, not the study: every analysis reference is
       * stripped, and the block's title becomes the placeholder. A template
       * that carried analysis ids would point at another survey's analyses
       * the moment it was reused, which is the one thing a template must
       * never do.
       */
      template = {
        name,
        description: typeof body.description === "string" ? body.description : undefined,
        themeId: (r.theme_id as string) ?? null,
        exportDefaults: def.exportDefaults,
        blocks: (def.blocks ?? []).map((b) => {
          if (b.type === "chart" || b.type === "table" || b.type === "kpi") {
            const { analysisId, ...rest } = b as Record<string, unknown>;
            return { ...rest, placeholder: (b as { title?: string }).title ?? b.type } as never;
          }
          if (b.type === "insights" || b.type === "executive_summary") {
            const { analysisIds, ...rest } = b as Record<string, unknown>;
            return { ...rest, placeholder: (b as { title?: string }).title ?? b.type } as never;
          }
          return b as never;
        }),
      };
    } else if (body.template && typeof body.template === "object") {
      template = { ...(body.template as ReportTemplate), name };
    }
    if (!template) return bad("Say which report to save the shape of, or supply a template.");
    if (!template.blocks?.length) return bad("That report has no blocks, so there is no shape to save.");

    const { data, error } = await db.from("analytics_report_templates").insert({
      customer_id: ctx.user.customerId,
      name,
      description: template.description ?? null,
      template: { blocks: template.blocks, themeId: template.themeId ?? null, exportDefaults: template.exportDefaults ?? null },
      source_survey_id: surveyId,
      created_by: ctx.user.userId,
    }).select("id, name").single();

    if (error) {
      if (/analytics_report_templates|does not exist|schema cache/i.test(error.message)) {
        return bad("Saving report templates needs migration 0014.", 503);
      }
      if (/duplicate|unique/i.test(error.message)) {
        return bad(`This workspace already has a report template called “${name}”.`, 409);
      }
      return bad(error.message, 500);
    }
    log(ctx, "analytics.report_created", data.id, { name, template: true, blocks: template.blocks.length, shape: describeTemplate(template) });
    return json({ template: { id: data.id, name: data.name, builtIn: false, blocks: template.blocks } }, 201);
  }

  if (head === "reports" && itemId && action === "apply-template") {
    const ctx = await gate(req, surveyId, "analytics.edit"); if (isFailure(ctx)) return ctx.response;
    if (!isUuid(itemId)) return bad("Unknown report.", 404);
    const templateId = String(body.templateId ?? "");
    if (!templateId) return bad("templateId is required.");

    let template = BUILT_IN_REPORT_TEMPLATES.find((t) => t.id === templateId) ?? null;
    if (!template) {
      if (!isUuid(templateId)) return bad("Unknown template.", 404);
      const { data: t } = await db.from("analytics_report_templates").select("id, name, description, template").eq("id", templateId).eq("customer_id", ctx.user.customerId ?? "").is("deleted_at", null).maybeSingle();
      if (!t) return bad("Unknown template.", 404);
      template = { id: t.id as string, name: t.name as string, description: (t.description as string) ?? undefined, ...((t.template as object) ?? {}), blocks: ((t.template as { blocks?: never[] })?.blocks ?? []) };
    }

    const { data: r } = await db.from("analytics_reports").select("definition, name, theme_id").eq("id", itemId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
    if (!r) return bad("Unknown report.", 404);

    /*
     * Applying a template never discards finished work: `applyTemplate`
     * carries every block that already points at an analysis into the new
     * shape, and appends anything the shape had no room for. Choosing a
     * template at four in the afternoon must not be the action a person
     * cannot undo.
     */
    const definition = applyTemplate(template, r.definition as ReportDefinition);
    const { error } = await db.from("analytics_reports").update({
      definition,
      ...(definition.themeId ? { theme_id: definition.themeId } : {}),
      updated_by: ctx.user.userId,
    }).eq("id", itemId);
    if (error) return bad(error.message, 500);
    log(ctx, "analytics.report_modified", itemId, { name: r.name, appliedTemplate: template.name, blocks: definition.blocks.length });
    return json({ definition, appliedTemplate: template.name });
  }

  if (head && head in COLLECTIONS && !itemId) {
    const coll = COLLECTIONS[head as Collection];
    const ctx = await gate(req, surveyId, coll.write); if (isFailure(ctx)) return ctx.response;
    const now = { created_by: ctx.user.userId, updated_by: ctx.user.userId };
    let row: Record<string, unknown>;
    if (head === "analyses") {
      const def = body.definition as AnalysisDefinition | undefined; const name = String(body.name ?? def?.name ?? "").trim();
      if (!def?.kind || !name) return bad("name and definition are required.");
      row = { survey_id: surveyId, name, kind: def.kind, definition: { ...def, name }, version: 1, folder: body.folder ?? null, tags: Array.isArray(body.tags) ? body.tags : [], ...now };
    } else if (head === "charts") {
      const spec = body.spec as ChartSpec | undefined; const analysisId = body.analysisId as string | undefined;
      if (!spec?.type || !analysisId || !isUuid(analysisId)) return bad("analysisId and spec are required.");
      row = { survey_id: surveyId, analysis_id: analysisId, name: String(body.name ?? spec.name ?? spec.options?.title ?? "Chart"), spec, theme_id: body.themeId ?? null, ...now };
    } else if (head === "segments") {
      if (!body.condition || !body.name) return bad("name and condition are required.");
      row = { survey_id: surveyId, kind: body.kind === "filter" ? "filter" : "segment", name: String(body.name), description: body.description ?? null, color: body.color ?? null, condition: body.condition, ...now };
    } else if (head === "themes") {
      if (!body.theme || !body.name) return bad("name and theme are required.");
      row = { survey_id: body.scope === "survey" ? surveyId : null, customer_id: body.scope === "survey" ? null : ctx.user.customerId, name: String(body.name), theme: { ...(body.theme as object), name: body.name }, is_default: !!body.isDefault, ...now };
    } else if (head === "reports") {
      if (!body.name) return bad("name is required.");
      const kind = body.kind === "dashboard" ? "dashboard" : "report";
      const definition = (body.definition as object) ?? (kind === "dashboard" ? { title: body.name, widgets: [], crossFilter: true } : { title: body.name, mode: body.mode === "snapshot" ? "snapshot" : "live", blocks: [{ id: "cover", type: "cover", title: body.name }] });
      row = { survey_id: surveyId, kind, name: String(body.name), definition, theme_id: body.themeId ?? null, mode: body.mode === "snapshot" ? "snapshot" : "live", ...now };
    } else {
      // shares (§18, §21): a report must be PUBLISHED before it can be shared — a link only ever reaches a version
      const reportId = body.reportId as string | undefined;
      if (!reportId || !isUuid(reportId)) return bad("reportId is required.");
      const { data: r } = await db.from("analytics_reports").select("id, name, published_version").eq("id", reportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
      if (!r) return bad("Unknown report.", 404);
      if (!r.published_version) return bad("Publish the report before sharing it — a share link always points at a published version.", 409);
      const access = body.access === "users" ? "users" : body.access === "private" ? "private" : "link";
      const permission = body.permission === "download" ? "download" : "viewer";
      const emails = Array.isArray(body.emails) ? (body.emails as string[]).map((e) => e.trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e)) : [];
      let userIds: string[] = Array.isArray(body.userIds) ? (body.userIds as string[]).filter(isUuid) : [];
      if (emails.length) { const { data: profiles } = await db.from("profiles").select("id, email").in("email", emails); userIds = [...new Set([...userIds, ...(profiles ?? []).map((p) => p.id as string)])]; }
      row = { survey_id: surveyId, report_id: reportId, token: newToken(), access, permission, report_version: body.pinVersion ? r.published_version : null, password_hash: typeof body.password === "string" && body.password ? await hashPassword(body.password) : null, expires_at: body.expiresAt ?? null, allowed_user_ids: userIds, allowed_emails: emails, label: body.label ?? null, created_by: ctx.user.userId };
    }
    const { data, error } = await db.from(coll.table).insert(row).select("*").single();
    if (error) return bad(error.message, 500);
    if (head === "analyses") await db.from("analytics_analysis_versions").insert({ analysis_id: data.id, survey_id: surveyId, version: 1, definition: data.definition, summary: "Created", created_by: ctx.user.userId });
    log(ctx, coll.created, data.id, head === "shares" ? { name: (await db.from("analytics_reports").select("name").eq("id", data.report_id).maybeSingle()).data?.name, access: data.access, permission: data.permission, expires: data.expires_at } : { name: data.name, kind: data.kind });
    return json({ item: head === "shares" ? { ...data, password_hash: undefined, has_password: !!data.password_hash } : data }, 201);
  }
  return bad("Unknown analytics endpoint.", 404);
}

/** Decide whether a definition change is a real analysis change (new version) or only cosmetic (§17). */
function analysisChanged(a: AnalysisDefinition, b: AnalysisDefinition): boolean {
  const pick = (d: AnalysisDefinition) => JSON.stringify({ kind: d.kind, dataset: d.dataset, variables: d.variables, rows: d.rows, columns: d.columns, layers: d.layers, measure: d.measure, filter: d.filter, filterIds: d.filterIds, segments: d.segments, weighting: d.weighting, options: d.options });
  return pick(a) !== pick(b);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const [head, itemId] = params.path ?? [];
  const surveyId = params.id;
  if (!head || !(head in COLLECTIONS) || !itemId || !isUuid(itemId) || head === "shares") return bad("Unknown analytics endpoint.", 404);
  const coll = COLLECTIONS[head as Collection];
  const ctx = await gate(req, surveyId, coll.write); if (isFailure(ctx)) return ctx.response;
  const db = supabaseService();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { data: cur } = await db.from(coll.table).select("*").eq("id", itemId).is("deleted_at", null).maybeSingle();
  if (!cur || (cur.survey_id && cur.survey_id !== surveyId)) return bad("Unknown item.", 404);
  const patch: Record<string, unknown> = { updated_by: ctx.user.userId };
  let detail: Record<string, unknown> = { name: body.name ?? cur.name };
  if (head === "analyses") {
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (body.folder !== undefined) patch.folder = body.folder;
    if (Array.isArray(body.tags)) patch.tags = body.tags;
    if (body.definition) {
      const next = { ...(body.definition as AnalysisDefinition), name: (patch.name as string) ?? cur.name };
      if (analysisChanged(cur.definition as AnalysisDefinition, next)) {
        const version = (cur.version as number) + 1;
        patch.version = version; patch.kind = next.kind;
        await db.from("analytics_analysis_versions").insert({ analysis_id: itemId, survey_id: surveyId, version, definition: next, summary: typeof body.summary === "string" ? body.summary : "Definition changed", created_by: ctx.user.userId });
        detail = { ...detail, version };
      }
      patch.definition = next;
    }
  } else if (head === "charts") {
    if (typeof body.name === "string") patch.name = body.name;
    if (body.spec) { patch.spec = body.spec; patch.style_version = (cur.style_version as number) + 1; }
    if (body.themeId !== undefined) patch.theme_id = body.themeId;
  } else if (head === "segments") {
    for (const k of ["name", "description", "color", "condition", "kind"]) if (body[k] !== undefined) patch[k] = body[k];
  } else if (head === "themes") {
    if (typeof body.name === "string") patch.name = body.name;
    if (body.theme) patch.theme = { ...(body.theme as object), name: (patch.name as string) ?? cur.name };
    if (body.isDefault !== undefined) patch.is_default = !!body.isDefault;
  } else if (head === "reports") {
    if (typeof body.name === "string") patch.name = body.name;
    if (body.definition) patch.definition = body.definition;
    if (body.themeId !== undefined) patch.theme_id = body.themeId;
    if (body.mode === "live" || body.mode === "snapshot") patch.mode = body.mode;
  }
  const { data, error } = await db.from(coll.table).update(patch).eq("id", itemId).select("*").single();
  if (error) return bad(error.message, 500);
  log(ctx, coll.modified, itemId, detail);
  return json({ item: data });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const [head, itemId] = params.path ?? [];
  const surveyId = params.id;
  if (head !== "shares" || !itemId || !isUuid(itemId)) return bad("Unknown analytics endpoint.", 404);
  const ctx = await gate(req, surveyId, "analytics.publish"); if (isFailure(ctx)) return ctx.response;
  const db = supabaseService();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const { data: cur } = await db.from("analytics_shares").select("*, analytics_reports(name)").eq("id", itemId).eq("survey_id", surveyId).maybeSingle();
  if (!cur) return bad("Unknown share.", 404);
  const patch: Record<string, unknown> = {};
  const name = (cur as { analytics_reports?: { name?: string } }).analytics_reports?.name;
  if (body.revoke === true) {
    patch.revoked_at = new Date().toISOString(); patch.revoked_by = ctx.user.userId;
  } else {
    if (body.access === "users" || body.access === "private" || body.access === "link") patch.access = body.access;
    if (body.permission === "download" || body.permission === "viewer") patch.permission = body.permission;
    if (body.expiresAt !== undefined) patch.expires_at = body.expiresAt;
    if (body.pinVersion !== undefined) patch.report_version = body.pinVersion === null ? null : Number(body.pinVersion);
    if (body.password !== undefined) patch.password_hash = body.password ? await hashPassword(String(body.password)) : null;
    if (Array.isArray(body.emails)) {
      const emails = (body.emails as string[]).map((e) => e.trim().toLowerCase()).filter((e) => /.+@.+\..+/.test(e));
      const { data: profiles } = emails.length ? await db.from("profiles").select("id, email").in("email", emails) : { data: [] };
      patch.allowed_emails = emails; patch.allowed_user_ids = [...new Set([...(Array.isArray(body.userIds) ? (body.userIds as string[]).filter(isUuid) : []), ...(profiles ?? []).map((p) => p.id as string)])];
    }
    if (body.label !== undefined) patch.label = body.label;
    if (body.reshare === true) { patch.revoked_at = null; patch.revoked_by = null; patch.token = newToken(); }
  }
  const { data, error } = await db.from("analytics_shares").update(patch).eq("id", itemId).select("*").single();
  if (error) return bad(error.message, 500);
  log(ctx, body.revoke ? "analytics.share_revoked" : "analytics.report_shared", itemId, { name, access: data.access, permission: data.permission, expires: data.expires_at, reshared: !!body.reshare });
  return json({ item: { ...data, password_hash: undefined, has_password: !!data.password_hash } });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const [head, itemId] = params.path ?? [];
  const surveyId = params.id;

  /*
   * §36 — remove a workspace report template. Soft, like every other
   * analytics delete, and scoped to the workspace rather than the survey: a
   * template is not owned by the study it happened to be saved from, so it
   * cannot be deleted through one either. A built-in is not deletable at all
   * — it is code, not a row.
   */
  if (head === "report-templates" && itemId) {
    const ctx = await gate(req, surveyId, "analytics.edit"); if (isFailure(ctx)) return ctx.response;
    if (!isUuid(itemId)) return bad("A built-in template cannot be removed.", 400);
    const db2 = supabaseService();
    const { error } = await db2.from("analytics_report_templates")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", itemId).eq("customer_id", ctx.user.customerId ?? "");
    if (error) return bad(error.message, 500);
    log(ctx, "analytics.report_modified", itemId, { templateRemoved: true });
    return json({ ok: true });
  }

  if (!head || !(head in COLLECTIONS) || !itemId || !isUuid(itemId)) return bad("Unknown analytics endpoint.", 404);
  const coll = COLLECTIONS[head as Collection];
  const ctx = await gate(req, surveyId, coll.write); if (isFailure(ctx)) return ctx.response;
  const db = supabaseService();
  if (head === "shares") {
    const { data, error } = await db.from("analytics_shares").update({ revoked_at: new Date().toISOString(), revoked_by: ctx.user.userId }).eq("id", itemId).eq("survey_id", surveyId).select("id, report_id").single();
    if (error) return bad(error.message, 500);
    log(ctx, "analytics.share_revoked", itemId, { reportId: data.report_id });
    return json({ ok: true });
  }
  const { data, error } = await db.from(coll.table).update({ deleted_at: new Date().toISOString(), updated_by: ctx.user.userId }).eq("id", itemId).or(`survey_id.eq.${surveyId}${head === "themes" && ctx.user.customerId ? `,customer_id.eq.${ctx.user.customerId}` : ""}`).select("id, name").single();
  if (error) return bad(error.message, 500);
  if (head === "analyses") await db.from("analytics_charts").update({ deleted_at: new Date().toISOString() }).eq("analysis_id", itemId);
  log(ctx, coll.deleted, itemId, { name: data.name, deleted: true });
  return json({ ok: true });
}
