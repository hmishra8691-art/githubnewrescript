/**
 * THE CHART FOR EVERY FINDING — chosen from the data, validated against it,
 * explained.
 *
 * The analytics package already ranks ~100 chart types for a result by its
 * shape, purpose and audience (`chooseChart`). A story scene draws a smaller
 * set — the types the renderer can animate frame by frame AND emit as native,
 * editable PowerPoint charts with identical numbers: bars (vertical and
 * horizontal), grouped bars, 100% stacked bars, lines and donuts. This module
 * maps the ranked choice onto that set, checks every candidate against the
 * data (a donut for something that is not parts of a whole, a line across
 * categories with no order, a grouped chart with one series), and says why
 * the default was chosen and why each alternative is or is not allowed.
 */
import type { AnalysisDefinition, AnalysisResult, ChartData, ChartType } from "../types.js";
import { chartDecimals } from "../chartFormat.js";
import type { Audience } from "../chartPurpose.js";
import { rankedCharts } from "../questionChart.js";
import type { ChartRecommendationNote, FrozenChartData, FrozenTable, StoryChartType } from "./types.js";
import { STORY_CHART_TYPES } from "./types.js";

/* ------------------------------------------------------------ freezing the numbers */

/** the categories × series a result draws, frozen for the report; null when the result has none */
export function freezeChartData(result: AnalysisResult, def?: Pick<AnalysisDefinition, "measure" | "kind">): FrozenChartData | null {
  const c = result.chart;
  if (!c.categories?.length || !c.series?.length) return null;
  const series = c.series.filter((s) => !(s.meta as { axis?: string } | undefined)?.axis || (s.meta as { axis?: string }).axis !== "secondary")
    .map((s) => ({ name: s.name, values: c.categories!.map((_, i) => (typeof s.values[i] === "number" && Number.isFinite(s.values[i]) ? Math.round((s.values[i] as number) * 1e6) / 1e6 : null)), ...(s.sig?.some(Boolean) ? { sig: c.categories!.map((_, i) => s.sig?.[i] ?? "") } : {}) }));
  if (!series.length) return null;
  const pct = c.valueFormat === "pct" || def?.measure === "pct_col" || def?.measure === "pct_row" || def?.measure === "pct_total";
  const mean = def?.measure === "mean" || c.valueFormat === "score";
  const valueFormat: FrozenChartData["valueFormat"] = pct ? "pct" : mean ? "mean" : def?.measure === "count" ? "count" : "number";
  const significanceTested = series.some((s) => s.sig?.some(Boolean)) && result.tests.some((t) => t.p != null);
  const seriesBases = result.tables[0]?.columnBases ? series.map((s) => result.tables[0].columnBases?.[s.name] ?? null) : undefined;
  return {
    categories: [...c.categories], series, valueFormat,
    decimals: valueFormat === "mean" ? 2 : valueFormat === "pct" ? 0 : 0,
    base: result.base?.n ?? null,
    ...(seriesBases && seriesBases.some((x) => x != null) ? { seriesBases } : {}),
    significanceTested,
    measure: valueFormat === "pct" ? "% of respondents" : valueFormat === "mean" ? "mean score" : valueFormat === "count" ? "respondents" : "value",
  };
}

/** a result table, frozen; long tables keep every row (the appendix shows them) with a main-scene cut */
export function freezeTable(result: AnalysisResult, tableIndex = 0, opts: { mainRows?: number } = {}): FrozenTable | null {
  const t = result.tables[tableIndex];
  if (!t || !t.rows.length) return null;
  const columns = t.columns.map((c) => ({ key: c.key, label: c.label, numeric: !!c.type && c.type !== "text", ...(c.decimals != null ? { decimals: c.decimals } : {}), ...(c.type === "pct" ? { pct: true } : {}) }));
  /* a row's own format (a crosstab's "Base (n)" row is counts inside percentage columns) travels with it */
  const rows = t.rows.map((r) => ({ ...Object.fromEntries(columns.map((c) => { const v = r[c.key]; return [c.key, typeof v === "number" ? (Number.isFinite(v) ? v : null) : v == null ? null : String(v)]; })), ...(typeof r.__format === "string" ? { __format: r.__format } : {}) }));
  return { title: t.title, columns, rows, base: t.base?.n ?? result.base?.n ?? null, notes: [...(t.notes ?? [])], ...(opts.mainRows && rows.length > opts.mainRows ? { mainRows: opts.mainRows } : {}) };
}

/* ------------------------------------------------------------ what each type is for */

const WORDS: Record<StoryChartType, string> = {
  bar: "vertical bars", hbar: "horizontal bars", grouped_bar: "grouped bars", stacked_100: "100% stacked bars", line: "a line", donut: "a donut",
};
export const chartWords = (t: StoryChartType) => WORDS[t];

/** the analytics types each story type stands for */
const FAMILY: Record<StoryChartType, ChartType[]> = {
  bar: ["bar_vertical", "column_clustered", "histogram", "pareto", "diff_means", "diff_proportions", "mean_ci", "error_bar", "ci_plot", "target_actual", "preference_share"],
  hbar: ["bar_horizontal", "ranking_bar", "lollipop", "dot_plot", "maxdiff_utility", "maxdiff_preference", "attribute_importance", "coefficient_plot", "forest", "keyword_bar"],
  grouped_bar: ["bar_grouped", "segment_comparison", "segment_profile", "maxdiff_best_worst", "heatmap_crosstab", "radar", "radar_multi", "radar_segment"],
  stacked_100: ["bar_stacked_100", "bar_stacked", "diverging_likert", "sentiment_distribution"],
  line: ["line", "line_multi", "spline", "wave_trend", "yoy_trend", "mom_trend", "area", "step_line", "rolling_average"],
  donut: ["donut", "pie", "donut_semi", "segment_size"],
};
export function storyTypeFor(t: ChartType | string): StoryChartType | null {
  for (const k of STORY_CHART_TYPES) if (FAMILY[k].includes(t as ChartType)) return k;
  return null;
}

/* ------------------------------------------------------------ validation */

const looksOrdered = (cats: string[]) =>
  cats.length >= 3 && (
    cats.every((c) => /^\s*-?\d+(\.\d+)?\s*$/.test(c)) ||
    cats.every((c) => /\b(19|20)\d{2}\b|\b(q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|wave|month|year|w\d+)\b/i.test(c))
  );

/** may this chart type draw these numbers without misrepresenting them? */
export function chartAllowed(type: StoryChartType, data: FrozenChartData): { ok: boolean; why: string } {
  const n = data.categories.length, s = data.series.length;
  const anyNeg = data.series.some((x) => x.values.some((v) => (v ?? 0) < 0));
  switch (type) {
    case "donut": {
      if (s !== 1) return { ok: false, why: "a donut shows one set of parts of a whole — this has several series" };
      if (anyNeg) return { ok: false, why: "a donut cannot show negative values" };
      if (n > 6) return { ok: false, why: `a donut with ${n} slices is unreadable — use bars` };
      if (data.valueFormat !== "pct" && data.valueFormat !== "count") return { ok: false, why: "these values are averages or scores, not parts of a whole — a donut would imply they add up" };
      if (data.valueFormat === "pct") { const sum = data.series[0].values.reduce<number>((a, v) => a + (v ?? 0), 0); if (sum < 95 || sum > 105) return { ok: false, why: `the shares add up to ${Math.round(sum)}%, not 100% (a multi-select, or a filtered set) — a donut would misstate them` }; }
      return { ok: true, why: "parts of a whole, few categories" };
    }
    case "line":
      if (!looksOrdered(data.categories)) return { ok: false, why: "a line implies an order or a time sequence between the categories, and these have none" };
      return { ok: true, why: "an ordered sequence (time, waves or a numeric scale)" };
    case "grouped_bar":
      if (s < 2) return { ok: false, why: "grouped bars need two or more groups — this has one series" };
      if (s > 6) return { ok: false, why: `${s} groups per category are too many to compare side by side` };
      return { ok: true, why: "compares groups category by category" };
    case "stacked_100":
      if (s < 2) return { ok: false, why: "a 100% stack needs several parts per bar" };
      if (data.valueFormat !== "pct") return { ok: false, why: "a 100% stack needs shares; these are not percentages" };
      return { ok: true, why: "composition of each group" };
    case "bar": case "hbar":
      if (s > 1 && type === "bar" && n * s > 24) return { ok: false, why: "too many bars for a vertical chart — use horizontal or grouped bars" };
      return { ok: true, why: type === "hbar" ? "ranks categories; long labels stay readable" : "compares a few categories" };
  }
}

/* ------------------------------------------------------------ recommendation */

/**
 * The default chart and the alternatives, each with its reason. The ranked
 * analytics choice wins when it maps to a type that is allowed for the data;
 * otherwise the next allowed one does. Long category labels prefer
 * horizontal bars (they stay readable without being cut).
 */
export function recommendStoryChart(def: Pick<AnalysisDefinition, "kind" | "variables" | "columns" | "measure" | "options"> | null, result: AnalysisResult, data: FrozenChartData, audience: Audience = "client"): ChartRecommendationNote {
  const ranked = def ? rankedCharts(def, result, { audience, limit: 40 }) : [];
  const longLabels = data.categories.some((c) => c.length > 18) || data.categories.length > 7;
  const order: { type: StoryChartType; why: string }[] = [];
  for (const r of ranked) { const t = storyTypeFor(r.type); if (t && !order.some((o) => o.type === t)) order.push({ type: t, why: r.reason }); }
  /* the shape alone, when the ranking said nothing usable */
  const shape: StoryChartType[] = data.series.length > 1 ? (data.valueFormat === "pct" ? ["grouped_bar", "stacked_100", "hbar"] : ["grouped_bar", "hbar", "bar"]) : (longLabels ? ["hbar", "bar", "donut"] : ["bar", "hbar", "donut", "line"]);
  for (const t of [...shape, ...STORY_CHART_TYPES]) if (!order.some((o) => o.type === t)) order.push({ type: t, why: "" });
  if (longLabels) { const i = order.findIndex((o) => o.type === "hbar"); if (i > 0 && order[0].type === "bar") order.unshift(...order.splice(i, 1)); }
  const checked = order.map((o) => ({ ...o, check: chartAllowed(o.type, data) }));
  const best = checked.find((o) => o.check.ok) ?? { type: "hbar" as StoryChartType, why: "", check: { ok: true, why: "fallback" } };
  const purpose = ranked[0] ? `to ${ranked[0].purposeWhy || ranked[0].purpose}` : "";
  const why = [`${WORDS[best.type]}: ${best.check.why}`, longLabels && best.type === "hbar" ? "the category labels are long, and horizontal bars keep them whole" : "", purpose ? `the analysis is read ${purpose}` : "", data.valueFormat === "mean" ? "bars start at zero so their lengths stay proportional to the means" : ""].filter(Boolean).join("; ");
  return {
    type: best.type,
    why,
    alternatives: checked.filter((o) => o.type !== best.type).map((o) => ({ type: o.type, why: o.check.why, allowed: o.check.ok })),
  };
}

/* ------------------------------------------------------------ formatting the numbers */

/**
 * decimals a story chart's labels need: the design's setting, never fewer than the one rule every other chart uses
 * (`chartDecimals`: none for percentages and whole numbers, one for other values, two where one would draw different
 * values alike), so the same chart reads the same in the browser, the PowerPoint and the story.
 */
export function displayDecimals(data: Pick<FrozenChartData, "valueFormat" | "series">, designDecimals: number): number {
  if (data.valueFormat === "count") return designDecimals;
  const chart = { valueFormat: data.valueFormat === "pct" ? "pct" : undefined, series: data.series.map((x) => ({ name: x.name, values: x.values.map((v) => v ?? NaN) })) } as unknown as ChartData;
  return Math.max(designDecimals, chartDecimals(chart));
}

/** a value as a chart label shows it; null is "—" (not zero), and the decimals never hide a difference that the table shows */
export function formatValue(v: number | null | undefined, data: Pick<FrozenChartData, "valueFormat" | "decimals">, decimals?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = decimals ?? data.decimals;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return data.valueFormat === "pct" ? `${s}%` : s;
}

/** the axis range: bars always from zero; lines may start above zero only when the axis says so */
export function valueDomain(data: FrozenChartData, type: StoryChartType): { min: number; max: number } {
  const vals = data.series.flatMap((s) => s.values).filter((v): v is number => v != null);
  if (type === "stacked_100") return { min: 0, max: 100 };
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const nice = (x: number) => { if (x <= 0) return 0; const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
  if (data.valueFormat === "pct" && max <= 100 && max > 60) return { min, max: 100 };
  return { min: min < 0 ? -nice(-min) : 0, max: nice(max * 1.08) || 1 };
}
