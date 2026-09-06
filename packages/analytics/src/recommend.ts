/**
 * INTELLIGENT CHART RECOMMENDATIONS (§12). Given what an analysis produced —
 * how many categories, how many series, whether the values are proportions,
 * means or a matrix, whether there is a time axis — rank the chart types that
 * present it well and explain why. The runner's own `recommendedCharts` is the
 * first opinion; this refines it against the actual data shape so a 12-series
 * pie never gets suggested.
 */
import type { AnalysisResult, ChartFamily, ChartType } from "./types.js";

export interface ChartRecommendation { type: ChartType; score: number; reason: string; family: ChartFamily }

export const CHART_CATALOG: { type: ChartType; family: ChartFamily; label: string; description: string; needs: ("categories" | "series" | "matrix" | "points" | "kpis" | "words" | "tree" | "dendrogram" | "nodes")[] }[] = [
  { type: "bar_vertical", family: "bar", label: "Vertical bar", description: "One value per category", needs: ["categories", "series"] },
  { type: "bar_horizontal", family: "bar", label: "Horizontal bar", description: "Ranked categories, long labels", needs: ["categories", "series"] },
  { type: "bar_grouped", family: "bar", label: "Grouped bar", description: "Compare series side by side", needs: ["categories", "series"] },
  { type: "bar_stacked", family: "bar", label: "Stacked bar", description: "Parts of a total per category", needs: ["categories", "series"] },
  { type: "bar_stacked_100", family: "bar", label: "100% stacked bar", description: "Distribution within each category", needs: ["categories", "series"] },
  { type: "column_clustered", family: "bar", label: "Clustered column", description: "Series clustered per category", needs: ["categories", "series"] },
  { type: "lollipop", family: "bar", label: "Lollipop", description: "Ranked values with a light footprint", needs: ["categories", "series"] },
  { type: "dot_plot", family: "bar", label: "Dot plot", description: "Compare values across groups", needs: ["categories", "series"] },
  { type: "pareto", family: "bar", label: "Pareto", description: "Sorted bars with a cumulative line", needs: ["categories", "series"] },
  { type: "ranking_bar", family: "ranking", label: "Ranking bar", description: "Items ordered by rank", needs: ["categories", "series"] },
  { type: "diverging_likert", family: "bar", label: "Diverging Likert", description: "Agreement scales centred on neutral", needs: ["categories", "series"] },
  { type: "pie", family: "pie", label: "Pie", description: "Share of a whole, few categories", needs: ["categories", "series"] },
  { type: "donut", family: "pie", label: "Donut", description: "Share of a whole with a centre KPI", needs: ["categories", "series"] },
  { type: "donut_nested", family: "pie", label: "Nested donut", description: "Two-level share breakdown", needs: ["categories", "series"] },
  { type: "donut_semi", family: "pie", label: "Semi-donut", description: "Half-ring share", needs: ["categories", "series"] },
  { type: "donut_radial", family: "pie", label: "Radial bars", description: "Concentric progress rings", needs: ["categories", "series"] },
  { type: "line", family: "trend", label: "Line", description: "Change over time", needs: ["categories", "series"] },
  { type: "line_multi", family: "trend", label: "Multi-line", description: "Several series over time", needs: ["categories", "series"] },
  { type: "area", family: "trend", label: "Area", description: "Volume over time", needs: ["categories", "series"] },
  { type: "area_stacked", family: "trend", label: "Stacked area", description: "Composition over time", needs: ["categories", "series"] },
  { type: "spline", family: "trend", label: "Smoothed line", description: "Smoothed trend", needs: ["categories", "series"] },
  { type: "step_line", family: "trend", label: "Step line", description: "Discrete level changes", needs: ["categories", "series"] },
  { type: "rolling_average", family: "trend", label: "Rolling average", description: "Trend with moving average", needs: ["categories", "series"] },
  { type: "wave_trend", family: "trend", label: "Wave trend", description: "Wave-over-wave comparison", needs: ["categories", "series"] },
  { type: "yoy_trend", family: "trend", label: "Year-over-year", description: "Same period, different years", needs: ["categories", "series"] },
  { type: "mom_trend", family: "trend", label: "Month-over-month", description: "Monthly movement", needs: ["categories", "series"] },
  { type: "histogram", family: "statistical", label: "Histogram", description: "Distribution of a numeric variable", needs: ["categories", "series"] },
  { type: "box_plot", family: "statistical", label: "Box plot", description: "Median, quartiles and outliers", needs: ["points"] },
  { type: "violin", family: "statistical", label: "Violin", description: "Distribution shape by group", needs: ["points"] },
  { type: "density", family: "statistical", label: "Density", description: "Smoothed distribution", needs: ["categories", "series"] },
  { type: "strip", family: "statistical", label: "Strip", description: "Every value by group", needs: ["points"] },
  { type: "beeswarm", family: "statistical", label: "Beeswarm", description: "Every value without overlap", needs: ["points"] },
  { type: "raincloud", family: "statistical", label: "Raincloud", description: "Density + box + points", needs: ["points"] },
  { type: "scatter", family: "relationship", label: "Scatter", description: "Relationship between two measures", needs: ["points"] },
  { type: "bubble", family: "relationship", label: "Bubble", description: "Scatter with size", needs: ["points"] },
  { type: "scatter_trendline", family: "relationship", label: "Scatter with trend", description: "Relationship with fitted line", needs: ["points"] },
  { type: "scatter_ci", family: "relationship", label: "Scatter with CI", description: "Fitted line with confidence band", needs: ["points"] },
  { type: "correlation_matrix", family: "relationship", label: "Correlation matrix", description: "All pairwise correlations", needs: ["matrix"] },
  { type: "correlogram", family: "relationship", label: "Correlogram", description: "Correlations as sized circles", needs: ["matrix"] },
  { type: "heatmap", family: "heatmap", label: "Heatmap", description: "Values as colour cells", needs: ["matrix"] },
  { type: "heatmap_crosstab", family: "heatmap", label: "Crosstab heatmap", description: "Row × column percentages", needs: ["matrix"] },
  { type: "heatmap_correlation", family: "heatmap", label: "Correlation heatmap", description: "Diverging colour for r", needs: ["matrix"] },
  { type: "heatmap_satisfaction", family: "heatmap", label: "Satisfaction heatmap", description: "Items × segments", needs: ["matrix"] },
  { type: "heatmap_ipa", family: "heatmap", label: "Importance-performance matrix", description: "Quadrant chart", needs: ["points"] },
  { type: "heatmap_quota", family: "heatmap", label: "Quota heatmap", description: "Quota cell fill", needs: ["matrix"] },
  { type: "radar", family: "radar", label: "Radar", description: "Profile across attributes", needs: ["categories", "series"] },
  { type: "spider", family: "radar", label: "Spider", description: "Profile with filled area", needs: ["categories", "series"] },
  { type: "radar_multi", family: "radar", label: "Multi-radar", description: "Several profiles overlaid", needs: ["categories", "series"] },
  { type: "radar_brand", family: "radar", label: "Brand radar", description: "Brand image profiles", needs: ["categories", "series"] },
  { type: "radar_segment", family: "radar", label: "Segment radar", description: "Segment profiles", needs: ["categories", "series"] },
  { type: "funnel", family: "funnel", label: "Funnel", description: "Sequential stages", needs: ["categories", "series"] },
  { type: "funnel_brand", family: "funnel", label: "Brand funnel", description: "Awareness → usage per brand", needs: ["categories", "series"] },
  { type: "funnel_purchase", family: "funnel", label: "Purchase funnel", description: "Purchase stages", needs: ["categories", "series"] },
  { type: "funnel_awareness", family: "funnel", label: "Awareness funnel", description: "Awareness stages", needs: ["categories", "series"] },
  { type: "funnel_dropout", family: "funnel", label: "Drop-out funnel", description: "Survey completion by page", needs: ["categories", "series"] },
  { type: "kpi_card", family: "kpi", label: "KPI card", description: "Headline number", needs: ["kpis"] },
  { type: "gauge", family: "kpi", label: "Gauge", description: "Score on a dial", needs: ["kpis"] },
  { type: "progress_circle", family: "kpi", label: "Progress circle", description: "Percent complete", needs: ["kpis"] },
  { type: "bullet", family: "kpi", label: "Bullet", description: "Value vs target bands", needs: ["kpis"] },
  { type: "target_actual", family: "kpi", label: "Target vs actual", description: "Bars against targets", needs: ["categories", "series"] },
  { type: "scorecard", family: "kpi", label: "Scorecard", description: "Several KPIs", needs: ["kpis"] },
  { type: "bump", family: "ranking", label: "Bump", description: "Rank changes over time", needs: ["categories", "series"] },
  { type: "rank_movement", family: "ranking", label: "Rank movement", description: "Rank shifts between waves", needs: ["categories", "series"] },
  { type: "rank_heatmap", family: "ranking", label: "Rank heatmap", description: "Rank position distribution", needs: ["matrix"] },
  { type: "ci_plot", family: "significance", label: "Confidence intervals", description: "Estimates with CIs", needs: ["categories", "series"] },
  { type: "error_bar", family: "significance", label: "Error bars", description: "Bars with error bars", needs: ["categories", "series"] },
  { type: "forest", family: "significance", label: "Forest plot", description: "Effects with CIs", needs: ["categories", "series"] },
  { type: "diff_means", family: "significance", label: "Difference of means", description: "Group means with significance", needs: ["categories", "series"] },
  { type: "diff_proportions", family: "significance", label: "Difference of proportions", description: "Group proportions with significance", needs: ["categories", "series"] },
  { type: "coefficient_plot", family: "significance", label: "Coefficient plot", description: "Regression coefficients with CIs", needs: ["categories", "series"] },
  { type: "mean_ci", family: "significance", label: "Mean with CI", description: "Means and confidence intervals", needs: ["categories", "series"] },
  { type: "segment_size", family: "segmentation", label: "Segment sizes", description: "Share of each segment", needs: ["kpis"] },
  { type: "segment_comparison", family: "segmentation", label: "Segment comparison", description: "Metrics by segment", needs: ["categories", "series"] },
  { type: "segment_profile", family: "segmentation", label: "Segment profile", description: "Segment means per variable", needs: ["categories", "series"] },
  { type: "segment_heatmap", family: "segmentation", label: "Segment heatmap", description: "Segments × variables", needs: ["categories", "series"] },
  { type: "segment_bubble", family: "segmentation", label: "Segment bubble", description: "Segments sized and positioned", needs: ["points"] },
  { type: "sankey", family: "advanced", label: "Sankey", description: "Flows between states", needs: ["nodes"] },
  { type: "alluvial", family: "advanced", label: "Alluvial", description: "Category flows", needs: ["nodes"] },
  { type: "treemap", family: "advanced", label: "Treemap", description: "Hierarchical shares", needs: ["tree"] },
  { type: "sunburst", family: "advanced", label: "Sunburst", description: "Hierarchical rings", needs: ["tree"] },
  { type: "dendrogram", family: "advanced", label: "Dendrogram", description: "Hierarchical clustering tree", needs: ["dendrogram"] },
  { type: "chord", family: "advanced", label: "Chord", description: "Relationships between groups", needs: ["nodes"] },
  { type: "network", family: "advanced", label: "Network", description: "Nodes and links", needs: ["nodes"] },
  { type: "parallel_coordinates", family: "advanced", label: "Parallel coordinates", description: "Profiles across many axes", needs: ["categories", "series"] },
  { type: "waterfall", family: "advanced", label: "Waterfall", description: "Incremental contributions", needs: ["categories", "series"] },
  { type: "marimekko", family: "advanced", label: "Marimekko", description: "Widths and heights as shares", needs: ["matrix"] },
  { type: "map_country", family: "geographic", label: "Country map", description: "Values by country", needs: ["categories", "series"] },
  { type: "map_state", family: "geographic", label: "State / region map", description: "Values by region", needs: ["categories", "series"] },
  { type: "choropleth", family: "geographic", label: "Choropleth", description: "Shaded regions", needs: ["categories", "series"] },
  { type: "map_bubble", family: "geographic", label: "Bubble map", description: "Sized markers on a map", needs: ["points"] },
  { type: "map_heat", family: "geographic", label: "Heat map (geo)", description: "Density on a map", needs: ["points"] },
  { type: "word_cloud", family: "text", label: "Word cloud", description: "Word frequency", needs: ["words"] },
  { type: "keyword_bar", family: "text", label: "Keyword bar", description: "Top keywords", needs: ["words"] },
  { type: "theme_distribution", family: "text", label: "Theme distribution", description: "Coded themes", needs: ["tree"] },
  { type: "topic_distribution", family: "text", label: "Topic distribution", description: "Topics", needs: ["tree"] },
  { type: "sentiment_distribution", family: "text", label: "Sentiment", description: "Positive / neutral / negative", needs: ["categories", "series"] },
  { type: "sentiment_trend", family: "text", label: "Sentiment trend", description: "Sentiment over time", needs: ["categories", "series"] },
  { type: "theme_segment_heatmap", family: "text", label: "Theme × segment", description: "Themes by segment", needs: ["matrix"] },
  { type: "attribute_importance", family: "conjoint", label: "Attribute importance", description: "Relative importance", needs: ["categories", "series"] },
  { type: "part_worth", family: "conjoint", label: "Part-worth utilities", description: "Utility by level", needs: ["tree"] },
  { type: "utility_by_level", family: "conjoint", label: "Utility by level", description: "Levels within attributes", needs: ["tree"] },
  { type: "preference_share", family: "conjoint", label: "Preference share", description: "Simulated shares", needs: ["categories", "series"] },
  { type: "choice_probability", family: "conjoint", label: "Choice probability", description: "Probability per profile", needs: ["categories", "series"] },
  { type: "simulation", family: "conjoint", label: "Market simulation", description: "Scenario shares", needs: ["categories", "series"] },
  { type: "wtp", family: "conjoint", label: "Willingness to pay", description: "WTP per level", needs: ["tree"] },
  { type: "maxdiff_utility", family: "maxdiff", label: "MaxDiff utilities", description: "Item utilities", needs: ["categories", "series"] },
  { type: "maxdiff_preference", family: "maxdiff", label: "MaxDiff preference share", description: "Rescaled shares", needs: ["categories", "series"] },
  { type: "maxdiff_best_worst", family: "maxdiff", label: "Best vs worst", description: "Best and worst counts", needs: ["categories", "series"] },
  { type: "maxdiff_segment", family: "maxdiff", label: "MaxDiff by segment", description: "Item scores by segment", needs: ["matrix"] },
  { type: "maxdiff_heatmap", family: "maxdiff", label: "MaxDiff heatmap", description: "Items × segments", needs: ["matrix"] },
  { type: "price_sensitivity", family: "pricing", label: "Price sensitivity meter", description: "Van Westendorp curves", needs: ["categories", "series"] },
  { type: "demand_curve", family: "pricing", label: "Demand curve", description: "Purchase likelihood by price", needs: ["categories", "series"] },
  { type: "purchase_probability", family: "pricing", label: "Purchase probability", description: "Probability by price", needs: ["categories", "series"] },
  { type: "revenue_curve", family: "pricing", label: "Revenue curve", description: "Revenue index by price", needs: ["categories", "series"] },
  { type: "price_elasticity", family: "pricing", label: "Price elasticity", description: "Elasticity between points", needs: ["categories", "series"] },
  { type: "table", family: "table", label: "Table", description: "The numbers themselves", needs: [] },
];

export const CHART_FAMILIES: { family: ChartFamily; label: string }[] = [
  { family: "bar", label: "Bar & column" }, { family: "pie", label: "Pie & donut" }, { family: "trend", label: "Line & trend" }, { family: "statistical", label: "Distribution" },
  { family: "relationship", label: "Relationship" }, { family: "heatmap", label: "Heatmaps" }, { family: "radar", label: "Radar" }, { family: "funnel", label: "Funnels" }, { family: "kpi", label: "KPI & gauges" },
  { family: "ranking", label: "Ranking" }, { family: "significance", label: "Significance" }, { family: "segmentation", label: "Segments" }, { family: "advanced", label: "Advanced" }, { family: "geographic", label: "Maps" },
  { family: "text", label: "Text" }, { family: "conjoint", label: "Conjoint" }, { family: "maxdiff", label: "MaxDiff" }, { family: "pricing", label: "Pricing" }, { family: "table", label: "Tables" },
];

export function chartsAvailable(result: AnalysisResult): ChartType[] {
  const d = result.chart;
  const has = { categories: !!d.categories?.length, series: !!d.series?.length, matrix: !!d.matrix, points: !!d.points?.length, kpis: !!d.kpis?.length, words: !!d.words?.length, tree: !!d.tree?.length, dendrogram: !!d.dendrogram?.length, nodes: !!d.nodes?.length };
  return CHART_CATALOG.filter((c) => c.needs.every((n) => has[n])).map((c) => c.type);
}

export function recommendCharts(result: AnalysisResult, limit = 6): ChartRecommendation[] {
  const d = result.chart;
  const nCat = d.categories?.length ?? 0, nSer = d.series?.length ?? 0;
  const isPct = d.valueFormat === "pct";
  const timeLike = ["trend"].includes(result.kind) || (d.categories?.every((c) => /^\d{4}(-\d{2}|-W\d{2})?$/.test(c)) ?? false);
  const available = new Set(chartsAvailable(result));
  const out: ChartRecommendation[] = [];
  const add = (type: ChartType, score: number, reason: string) => { if (!available.has(type)) return; const c = CHART_CATALOG.find((x) => x.type === type)!; out.push({ type, score, reason, family: c.family }); };
  // the runner's own order carries weight
  result.recommendedCharts.forEach((t, i) => add(t, 60 - i * 6, `Suggested for ${result.kind} results`));
  if (nCat && nSer === 1) {
    if (isPct && nCat <= 6 && !["topbox", "csat"].includes(result.kind)) add("pie", 55, `${nCat} categories that sum to a whole`), add("donut", 52, "Shares with room for a headline figure");
    if (nCat > 6) add("bar_horizontal", 58, `${nCat} categories — horizontal bars keep labels readable`);
    else add("bar_vertical", 50, "Few categories, one measure");
    if (nCat >= 5) add("lollipop", 40, "A lighter alternative to bars for ranked values");
    if (d.series?.[0]?.ci?.some(Boolean)) add("mean_ci", 56, "Confidence intervals are available"), add("ci_plot", 50, "Show uncertainty around each estimate");
  }
  if (nCat && nSer >= 2) {
    add(nSer <= 4 ? "bar_grouped" : "bar_stacked", 54, `${nSer} series to compare${nSer > 4 ? " — stacking keeps it compact" : ""}`);
    if (isPct) add("bar_stacked_100", 50, "Percentages within each category");
    if (nCat >= 3 && nSer <= 6 && nCat <= 12) add("radar", 38, "Profile shape across attributes");
    if (nCat * nSer > 24) add("heatmap", 48, "Many cells — colour reads faster than bars");
  }
  if (timeLike && nCat >= 3) add("line", 70, "Ordered periods — a line shows the trend"), add("area", 45, "Volume over time"), add(nSer > 1 ? "line_multi" : "spline", 55, "Several series over time");
  if (d.points?.length) { add("scatter", 55, "Paired values per case or item"); if (d.points.length > 200) add("bubble", 30, "Dense points — sizing helps"); }
  if (d.matrix) add("heatmap", 52, "A two-way table maps naturally to a heatmap");
  if (d.kpis?.length) add("kpi_card", 45, "Headline figures"), add(d.kpis.length > 1 ? "scorecard" : "gauge", 40, d.kpis.length > 1 ? "Several KPIs together" : "A single score on a dial");
  if (d.words?.length) add("word_cloud", 60, "Word frequencies"), add("keyword_bar", 50, "Exact keyword counts");
  if (d.tree?.length) add("treemap", 50, "Hierarchical shares");
  if (d.dendrogram?.length) add("dendrogram", 65, "Hierarchical clustering merges");
  if (d.nodes?.length) add("network", 50, "Nodes and links"), add("sankey", 45, "Flows between nodes");
  add("table", 20, "The exact numbers");
  const best = new Map<ChartType, ChartRecommendation>();
  for (const r of out) { const cur = best.get(r.type); if (!cur || r.score > cur.score) best.set(r.type, r); }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
