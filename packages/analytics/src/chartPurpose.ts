import type { AnalysisDefinition, AnalysisResult, ChartFamily, ChartType } from "./types.js";
import { recommendCharts, type ChartRecommendation } from "./recommend.js";

/**
 * CHART SELECTION BY PURPOSE AND AUDIENCE (Research Engine audit, Phase 5).
 *
 * `recommendCharts` reads the SHAPE of a result — one series or several,
 * percentages, time, points — and that is the right first cut. What it
 * cannot know is WHY the chart is shown: to compare groups, to show how a
 * whole is made up, to show a distribution, a trend, a relationship, a
 * ranking, a number to watch, or a difference with its uncertainty — and
 * for WHOM: an executive who reads one message per slide, a researcher who
 * wants the interval and the test, a client in between. The purpose is read
 * from the analysis (its kind, its roles, the finding it carries); the
 * audience is the researcher's choice. Both adjust the shape-based scores,
 * never override them: a chart the data cannot draw is never chosen.
 */
export type AnalyticalPurpose = "comparison" | "composition" | "distribution" | "trend" | "relationship" | "ranking" | "kpi" | "significance" | "profile";
export type Audience = "executive" | "client" | "researcher";

export const PURPOSE_WORDS: Record<AnalyticalPurpose, string> = {
  comparison: "compare groups", composition: "show what the whole is made of", distribution: "show how answers spread", trend: "show change over time", relationship: "show how two measures move together",
  ranking: "rank the items", kpi: "show the number to watch", significance: "show a difference with its uncertainty", profile: "profile the segments",
};

export interface PurposeReading { purpose: AnalyticalPurpose; why: string }

const timeLike = (cats: string[] | undefined) => !!cats && cats.length >= 3 && cats.every((c) => /^\d{4}(?:-\d{2}|-W\d{2})?$/.test(c) || /^(?:wave|w)\s*\d+$/i.test(c));

/** The purpose a result is shown for, from its analysis and its shape. */
export function purposeOf(def: Pick<AnalysisDefinition, "kind" | "variables" | "columns" | "measure" | "options">, result: Pick<AnalysisResult, "chart" | "tests" | "kind">): PurposeReading {
  const cats = result.chart.categories;
  if (def.kind === "trend" || timeLike(cats)) return { purpose: "trend", why: "the categories are points in time" };
  switch (def.kind) {
    case "crosstab": return (def.columns?.length ?? def.variables.length - 1) > 0 ? { purpose: "comparison", why: "a crosstab compares the rows across the banner" } : { purpose: "composition", why: "a one-way table shows how the answers divide" };
    case "test": return result.tests.some((t) => t.p != null) ? { purpose: "significance", why: "a statistical test shows a difference and how sure it is" } : { purpose: "comparison", why: "a comparison of groups" };
    case "correlation": case "regression": return { purpose: "relationship", why: `${def.kind === "regression" ? "a model" : "a correlation"} relates measures to one another` };
    case "descriptive": case "topbox": case "csat": return { purpose: (result.chart.series?.length ?? 0) > 1 ? "comparison" : "distribution", why: "a descriptive shows how the answers spread" };
    case "nps": return { purpose: "kpi", why: "NPS is a number to watch" };
    case "ranking": case "maxdiff": case "turf": case "allocation": return { purpose: "ranking", why: `${def.kind} orders the items` };
    case "segmentation": case "cluster": return { purpose: "profile", why: "segments are profiled against one another" };
    case "brand": return { purpose: "comparison", why: "brands are compared along the funnel" };
    case "pricing": case "conjoint": return { purpose: "relationship", why: `${def.kind} relates choice to its drivers` };
    default: return { purpose: (result.chart.series?.length ?? 0) > 1 ? "comparison" : "distribution", why: "from the shape of the result" };
  }
}

/* per purpose: the chart types that serve it, in order of fit, with the bonus they get */
const FIT: Record<AnalyticalPurpose, [ChartType, number][]> = {
  comparison: [["bar_grouped", 16], ["bar_vertical", 14], ["column_clustered", 12], ["bar_horizontal", 10], ["diff_means", 8], ["heatmap", 2]],
  composition: [["bar_stacked_100", 16], ["donut", 14], ["pie", 12], ["bar_stacked", 10], ["treemap", 6]],
  distribution: [["histogram", 16], ["box_plot", 12], ["bar_vertical", 10], ["density", 8], ["violin", 6]],
  trend: [["line", 18], ["line_multi", 14], ["area", 8], ["wave_trend", 10], ["spline", 6]],
  relationship: [["scatter", 16], ["scatter_trendline", 14], ["coefficient_plot", 12], ["correlation_matrix", 8], ["bubble", 6]],
  ranking: [["ranking_bar", 18], ["bar_horizontal", 14], ["lollipop", 10], ["maxdiff_utility", 10], ["pareto", 6]],
  kpi: [["kpi_card", 20], ["gauge", 12], ["scorecard", 10], ["bullet", 8]],
  // bars for a client, the interval chart for a researcher: the audience weights decide between these two
  significance: [["bar_grouped", 14], ["bar_vertical", 14], ["mean_ci", 13], ["ci_plot", 12], ["diff_means", 10], ["error_bar", 8]],
  profile: [["segment_comparison", 16], ["radar", 12], ["segment_profile", 12], ["bar_grouped", 10], ["heatmap", 6]],
};
/* per audience: families lifted or pushed down */
const AUDIENCE: Record<Audience, Partial<Record<ChartFamily, number>>> = {
  executive: { statistical: -18, significance: -10, heatmap: -8, relationship: -6, advanced: -10, kpi: 8, bar: 6, pie: 4 },
  client: { statistical: -8, significance: -2, advanced: -6, bar: 4, kpi: 4 },
  researcher: { significance: 10, statistical: 6, relationship: 4, heatmap: 2, pie: -6 },
};

export interface ChartChoice extends ChartRecommendation { purpose: AnalyticalPurpose; audience: Audience; purposeWhy: string }

/**
 * The chart for a result, given why it is shown and to whom. The shape-based
 * recommendations are the candidates; the purpose lifts the types that serve
 * it and the audience lifts or lowers whole families; the best remaining
 * candidate wins, with its reason extended.
 */
export function chooseChart(def: Pick<AnalysisDefinition, "kind" | "variables" | "columns" | "measure" | "options">, result: AnalysisResult, opts: { purpose?: AnalyticalPurpose; audience?: Audience; limit?: number } = {}): ChartChoice[] {
  const audience = opts.audience ?? "client";
  const read = opts.purpose ? { purpose: opts.purpose, why: "as asked" } : purposeOf(def, result);
  const base = recommendCharts(result, 40);
  const fit = new Map(FIT[read.purpose]);
  const scored = base.map((r) => {
    const bonus = fit.get(r.type) ?? 0;
    const aud = AUDIENCE[audience][r.family] ?? 0;
    const why = [r.reason, bonus ? `${PURPOSE_WORDS[read.purpose]} (+${bonus})` : "", aud ? `${audience} audience (${aud > 0 ? "+" : ""}${aud})` : ""].filter(Boolean).join("; ");
    return { ...r, score: r.score + bonus + aud, reason: why, purpose: read.purpose, audience, purposeWhy: read.why };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 6);
}

/** one line for a caption or a card: "bar grouped — compare groups, client audience" */
export function describeChoice(c: ChartChoice): string {
  return `${c.type.replace(/_/g, " ")} — to ${PURPOSE_WORDS[c.purpose]}, for a${c.audience === "executive" ? "n" : ""} ${c.audience} audience`;
}
