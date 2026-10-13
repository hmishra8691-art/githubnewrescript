import type { ChartType } from "./types.js";

/**
 * ONE PICTURE PER CHART TYPE (Data Analytics audit, Oct 2026 — C-8).
 *
 * The catalogue names 116 chart types. The renderer draws about 45 pictures:
 * a "rolling average", a "wave trend" and a "price elasticity" are the same
 * line chart under three names, "spider" is "radar", a "segment profile" is a
 * column chart. Offering all of them as choices promises variety the screen
 * does not deliver — and the PowerPoint export, which had its own list, drew
 * some of the same names as something else again.
 *
 * `CHART_PICTURE` says, for every type that has no drawing of its own, which
 * type it is drawn as. The renderer, the PowerPoint export and the chart
 * chooser all resolve through it, and a test renders every type to prove the
 * table: an alias must draw exactly what its picture draws, and no two types
 * that are not aliases may draw the same. A saved chart of an alias type still
 * opens and still draws — it is just no longer offered as a separate choice.
 */
export const CHART_PICTURE: Partial<Record<ChartType, ChartType>> = {
  // columns: one renderer for grouped, clustered and the "named" column charts
  bar_grouped: "bar_vertical", column_clustered: "bar_vertical", target_actual: "bar_vertical", rank_movement: "bar_vertical", segment_comparison: "bar_vertical",
  segment_profile: "bar_vertical", sentiment_distribution: "bar_vertical", preference_share: "bar_vertical", choice_probability: "bar_vertical", simulation: "bar_vertical",
  // horizontal bars
  ranking_bar: "bar_horizontal", keyword_bar: "bar_horizontal", attribute_importance: "bar_horizontal", maxdiff_utility: "bar_horizontal", maxdiff_preference: "bar_horizontal", maxdiff_best_worst: "bar_horizontal",
  // an estimate with its interval
  ci_plot: "mean_ci", error_bar: "mean_ci", diff_means: "mean_ci", diff_proportions: "mean_ci", coefficient_plot: "forest",
  funnel_brand: "funnel", funnel_purchase: "funnel", funnel_awareness: "funnel", funnel_dropout: "funnel",
  donut_nested: "donut", segment_size: "donut",
  // one line renderer
  line_multi: "line", rolling_average: "line", wave_trend: "line", yoy_trend: "line", mom_trend: "line", bump: "line", sentiment_trend: "line",
  price_sensitivity: "line", demand_curve: "line", purchase_probability: "line", revenue_curve: "line", price_elasticity: "line",
  density: "histogram",
  spider: "radar", radar_multi: "radar", radar_brand: "radar", radar_segment: "radar",
  scorecard: "kpi_card",
  theme_distribution: "treemap", topic_distribution: "treemap",
  // one heatmap renderer
  heatmap_crosstab: "heatmap", heatmap_satisfaction: "heatmap", heatmap_quota: "heatmap", rank_heatmap: "heatmap", segment_heatmap: "heatmap", theme_segment_heatmap: "heatmap",
  maxdiff_segment: "heatmap", maxdiff_heatmap: "heatmap", correlation_matrix: "heatmap_correlation",
  map_country: "choropleth", map_state: "choropleth",
  utility_by_level: "part_worth", wtp: "part_worth",
  segment_bubble: "bubble", alluvial: "sankey",
};

/** the type whose drawing this type is — itself, when it has one of its own */
export const chartPicture = (type: ChartType): ChartType => CHART_PICTURE[type] ?? type;

/** does this type have a drawing of its own (and so deserve a place in a list of choices)? */
export const isOwnPicture = (type: ChartType): boolean => !(type in CHART_PICTURE);

/** a ranked list of chart types with each picture once — the first-ranked type of every picture stays */
export function onePerPicture<T extends { type: ChartType }>(ranked: readonly T[]): T[] {
  const seen = new Set<ChartType>();
  return ranked.filter((r) => { const p = chartPicture(r.type); if (seen.has(p)) return false; seen.add(p); return true; });
}
