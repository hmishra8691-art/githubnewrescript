import type { AnalysisResult, ChartSpec } from "../types.js";

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
