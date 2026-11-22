import { checkSnapshot, drillCondition, drillPlan, minBasesFor, protectSnapshot, type AnalysisDefinition, type AnalysisResult, type DrillVariants, type ReportDefinition, type ReportTheme } from "@rescript/analytics";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PUBLISHING A REPORT VERSION — one place for it, used by the Studio's Publish button (the analytics route) and by a
 * report schedule set to republish on refresh (reportSchedulesCore.ts). Computation and theme are handed in so this
 * can be tested end to end.
 *
 * A published version is immutable: definition, theme, the computed results, the viewer-filter and drill-down variants
 * frozen beside them, every frozen answer protected by the minimum base. Share links not pinned to a version
 * (`analytics_shares.report_version` null) show the report's current published version, so writing a new version and
 * moving `analytics_reports.published_version` to it is what makes those links show the new numbers. Links pinned to a
 * version keep showing that version.
 */
type Db = SupabaseClient;
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublishDeps {
  /** the report's analyses computed now, with extra saved filters and an extra inline condition (a drill value) */
  compute(definition: ReportDefinition, extraFilterIds?: string[], extraCondition?: Record<string, unknown> | null): Promise<Record<string, AnalysisResult>>;
  theme(themeId: string | null): Promise<ReportTheme>;
  /** survey version and revision the data was read under */
  source: { version: unknown; revision: unknown };
}

export interface PublishArgs {
  surveyId: string;
  reportId: string;
  /** the user publishing; null for a scheduled republish (the schedule is recorded in `note`) */
  userId: string | null;
  note?: string | null;
  /** publish a blank, partial or drill-problem report on purpose (the Studio's "publish anyway"); never set by a schedule */
  force?: boolean;
  /** the main results when the caller has just computed them (a schedule run), to avoid computing twice */
  snapshot?: Record<string, AnalysisResult>;
}

export type PublishOutcome =
  | { ok: true; version: number; publishedAt: string; name: string; mode: unknown; viewerFilters: number; drillValues: number; minBase: ReturnType<typeof minBasesFor>; withheld: string[] }
  | { ok: false; status: number; error: string; problems?: string[]; canForce?: boolean };

export async function publishReportWith(db: Db, deps: PublishDeps, a: PublishArgs): Promise<PublishOutcome> {
  const { surveyId, reportId } = a;
  const { data: report } = await db.from("analytics_reports").select("*").eq("id", reportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
  if (!report) return { ok: false, status: 404, error: "Unknown report." };
  const r = report as Row;
  const definition = r.definition as ReportDefinition;
  const snapshot = a.snapshot ?? (await deps.compute(definition));
  const theme = await deps.theme((r.theme_id as string | null) ?? null);
  /* never freeze a blank or partial report by accident — the researcher can still publish it on purpose */
  const check = checkSnapshot(definition, snapshot);
  if (!check.ok && a.force !== true) return { ok: false, status: 409, error: `Not published. ${check.problems.join(" ")}`, problems: check.problems, canForce: true };
  const ids = Object.keys(snapshot);
  const analysisDefs = ids.length ? await db.from("analytics_analyses").select("definition").in("id", ids) : { data: [] as Row[] };
  const environments = [...new Set(((analysisDefs.data ?? []) as Row[]).map((x) => (x.definition as AnalysisDefinition | undefined)?.dataset?.environment).filter(Boolean))];
  const dataset = { surveyVersion: deps.source.version, revision: deps.source.revision, responses: check.responses, environments, computedAt: new Date().toISOString() };
  /*
   * §36 — every filter a viewer may apply is computed now and frozen beside the base results: a shared report has no
   * dataset access, so switching filter reads a pre-computed answer. The filter NAMES are frozen too — a published
   * version is a record of what was said, including what the buttons said.
   */
  const viewerFilters = (definition.viewerFilters ?? []).filter((id) => UUID.test(id)).slice(0, 12);
  const filterResults: Record<string, Record<string, AnalysisResult>> = {};
  for (const filterId of viewerFilters) filterResults[filterId] = await deps.compute(definition, [filterId]);
  const { data: filterRows } = viewerFilters.length
    ? await db.from("analytics_segments").select("id, name").in("id", viewerFilters).eq("survey_id", surveyId)
    : { data: [] as { id: string; name: string }[] };
  const nameOf = (id: string) => ((filterRows ?? []) as { id: string; name: string }[]).find((f) => f.id === id)?.name;
  /*
   * R2 — the drill-down values are computed and frozen like filters; then every frozen answer is protected: no number
   * from fewer than the minimum base is written into the version.
   */
  const drill = drillPlan(definition);
  if (drill.problems.length && a.force !== true) return { ok: false, status: 409, error: `Not published. ${drill.problems.join(" ")}`, problems: drill.problems, canForce: true };
  const bases = minBasesFor(definition);
  const withheld: string[] = [];
  const guard = (rs: Record<string, AnalysisResult>, min: number, where: string) => { const p = protectSnapshot(rs, min); withheld.push(...p.withheld.map((w) => `${where}: ${w}`)); return p.results; };
  for (const id of Object.keys(filterResults)) filterResults[id] = guard(filterResults[id], bases.variants, nameOf(id) ?? "filter");
  let drillVariants: DrillVariants | null = null;
  if (drill.plan) {
    const dr: DrillVariants["results"] = {};
    for (const v of drill.plan.values) dr[String(v.value)] = guard(await deps.compute(definition, [], drillCondition(drill.plan.variable, v.value)), bases.variants, v.label);
    drillVariants = { variable: drill.plan.variable, label: drill.plan.label ?? drill.plan.variable, values: drill.plan.values, results: dr };
  }
  const protectedSnapshot = bases.main ? guard(snapshot, bases.main, "main") : snapshot;
  const variants = {
    filters: viewerFilters.map((id) => ({ id, name: nameOf(id) ?? "Filter" })),
    results: filterResults,
    ...(drillVariants ? { drill: drillVariants } : {}),
    minBase: bases,
  };
  /* the version number is read last, just before the write, so the window for two publishers to collide is small;
     the unique (report_id, version) constraint turns a collision into an error rather than two version 4s */
  const { data: last } = await db.from("analytics_report_versions").select("version").eq("report_id", reportId).order("version", { ascending: false }).limit(1);
  const version = (Number((last as Row[] | null)?.[0]?.version) || 0) + 1;
  const { error } = await db.from("analytics_report_versions").insert({ report_id: reportId, survey_id: surveyId, version, definition, theme, snapshot: protectedSnapshot, dataset, ...(viewerFilters.length || drillVariants ? { variants } : {}), note: a.note ?? null, published_by: a.userId });
  if (error) return { ok: false, status: 500, error: error.message };
  const { error: pointerError } = await db.from("analytics_reports").update({ published_version: version, ...(a.userId ? { updated_by: a.userId } : {}) }).eq("id", reportId);
  if (pointerError) return { ok: false, status: 500, error: `Version ${version} was written but the report could not be pointed at it (${pointerError.message}). Publish again.` };
  return { ok: true, version, publishedAt: new Date().toISOString(), name: String(r.name ?? ""), mode: r.mode, viewerFilters: viewerFilters.length, drillValues: drillVariants?.values.length ?? 0, minBase: bases, withheld: withheld.slice(0, 50) };
}
