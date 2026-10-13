import type { AnalysisResult, ChartSpec, DashboardDefinition, ReportDefinition } from "../types.js";

export interface SeriesOut { name: string; labels: string[]; values: (number | null)[]; ci?: ([number, number] | null)[]; sig?: string[]; meta?: { pct?: boolean; axis?: string; dashed?: boolean } }

/** The categories × series a chart draws, after the spec's sort / topN / hidden-category options. */
export function seriesForChart(result: AnalysisResult, spec: ChartSpec): SeriesOut[] {
  const d = result.chart;
  const segIdx = spec.options.segmentIndex;
  const source = segIdx != null && result.segments?.[segIdx] ? result.segments[segIdx].chart : d;
  if (!source.categories?.length || !source.series?.length) return [];
  let idx = source.categories.map((_, i) => i);
  const hidden = new Set(spec.options.hiddenCategories ?? []);
  idx = idx.filter((i) => !hidden.has(source.categories![i]));
  const sort = spec.options.sort ?? "none";
  if (sort === "asc" || sort === "desc" || sort === "value") idx.sort((a, b) => ((source.series![0].values[b] ?? -Infinity) - (source.series![0].values[a] ?? -Infinity)) * (sort === "asc" ? -1 : 1));
  if (sort === "label") idx.sort((a, b) => source.categories![a].localeCompare(source.categories![b]));
  if (spec.options.topN) idx = idx.slice(0, spec.options.topN);
  const pct = (source.valueFormat ?? d.valueFormat) === "pct" || !!spec.options.percent;
  return source.series.filter((s) => !s.meta?.axis || s.meta.axis !== "secondary" || spec.type === "table").map((s) => ({ name: s.name, labels: idx.map((i) => source.categories![i]), values: idx.map((i) => s.values[i] ?? null), ci: s.ci ? idx.map((i) => s.ci![i] ?? null) : undefined, sig: s.sig ? idx.map((i) => s.sig![i] ?? "") : undefined, meta: { pct, axis: s.meta?.axis as string | undefined, dashed: s.meta?.dashed as boolean | undefined } }));
}

export function chartTitleFor(result: AnalysisResult, spec: ChartSpec): string {
  return spec.options.title ?? spec.name ?? result.name;
}


/**
 * A thing the person asked to export that cannot be exported, with the sentence they should see. Routes show
 * `message` as it is (nothing technical in it) instead of a bare 500.
 */
export class ExportUnsupportedError extends Error {
  readonly userFacing = true;
  constructor(message: string) { super(message); this.name = "ExportUnsupportedError"; }
}

/**
 * What the PowerPoint and Excel builders read: a report's `blocks`. A DASHBOARD stores `widgets` instead, and the
 * builders used to fail on it with "Cannot read properties of undefined (reading 'flatMap')" — in the editor and on a
 * shared dashboard's Download button (audit R-1). A dashboard is exported as the report its widgets spell out, in
 * reading order: its title as the cover, then each chart, table, KPI and text widget that has something to show.
 * Photos, filters, icon panels and empty template slots are left out — they are decoration or interaction, not findings.
 */
export function reportForExport<R extends { title: string }>(input: R): R & Pick<ReportDefinition, "blocks"> {
  const r = input as unknown as Partial<ReportDefinition> & Partial<DashboardDefinition>;
  if (Array.isArray(r.blocks)) return input as R & Pick<ReportDefinition, "blocks">;
  if (!Array.isArray(r.widgets)) throw new ExportUnsupportedError("This item has no pages or widgets to export.");
  const title = r.hero?.title || r.title || "Dashboard";
  const blocks: ReportDefinition["blocks"] = [{ id: "cover", type: "cover", title, ...(r.hero?.subtitle ? { subtitle: r.hero.subtitle } : {}) }];
  const ordered = [...r.widgets].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const w of ordered) {
    if (w.type === "chart" && w.analysisId && w.chart) blocks.push({ id: w.id, type: "chart", ...(w.title ? { title: w.title } : {}), analysisId: w.analysisId, chart: w.chart });
    else if (w.type === "table" && w.analysisId) blocks.push({ id: w.id, type: "table", ...(w.title ? { title: w.title } : {}), analysisId: w.analysisId });
    else if (w.type === "kpi" && w.analysisId) blocks.push({ id: w.id, type: "kpi", ...(w.title ? { title: w.title } : {}), analysisId: w.analysisId });
    else if (w.type === "text" && w.text?.trim()) blocks.push({ id: w.id, type: "text", ...(w.title ? { title: w.title } : {}), markdown: w.text });
  }
  if (blocks.length === 1) throw new ExportUnsupportedError("This dashboard has no charts, tables or KPIs with an analysis chosen yet, so there is nothing to export. Pick an analysis for at least one widget.");
  return { ...input, title, ...(r.title && r.hero?.title ? { subtitle: r.title } : {}), blocks };
}
