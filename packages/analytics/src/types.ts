/**
 * THE ANALYTICS DATA MODEL.
 *
 *   Survey → Dataset (which responses) → AnalysisDefinition (what to compute)
 *          → AnalysisResult (tables, series, tests, insights)
 *          → ChartSpec (how to draw it) → ReportDefinition → published version → share
 *
 * Everything a saved analysis needs to be regenerated later is in
 * `AnalysisDefinition` (§39): dataset, variables, filters, segments, weighting,
 * method, options. Results are derived and never the source of truth — except
 * inside a published report snapshot, where they are frozen on purpose (§34).
 */
import type { Condition } from "@rescript/schema";

/* ------------------------------------------------------------ dataset */

export type Environment = "TEST" | "LIVE" | "ALL";

export interface DatasetSpec {
  environment: Environment;
  /** all responses, only quality-clean ones, or specific quality classes */
  dataset: "all" | "clean" | "custom";
  qualityClasses?: string[];
  /** response statuses to include; default complete only */
  statuses?: string[];
  from?: string;
  to?: string;
}

/* ------------------------------------------------------------ segments / filters */

export interface SegmentDef {
  id: string;
  name: string;
  /** an ordinary survey Condition over the response */
  condition: Condition;
  kind?: "segment" | "filter";
  description?: string;
  color?: string;
}

/* ------------------------------------------------------------ weighting */

export interface WeightingSpec {
  /** a numeric variable already holding a weight */
  variable?: string;
  /** rim targets: variable → category share (percent or proportion) */
  rim?: { variable: string; targets: Record<string, number> }[];
  cap?: [number, number];
}

/* ------------------------------------------------------------ analysis */

export type AnalysisKind =
  | "descriptive" | "topbox" | "crosstab" | "test" | "correlation" | "regression"
  | "segmentation" | "cluster" | "factor" | "reliability" | "trend"
  | "nps" | "csat" | "turf" | "gap" | "pricing" | "brand" | "ranking" | "allocation"
  | "text" | "quality" | "weighting" | "conjoint" | "maxdiff";

export const ANALYSIS_KINDS: { kind: AnalysisKind; label: string; group: string; description: string }[] = [
  { kind: "descriptive", label: "Descriptive", group: "Basics", description: "Frequencies, means, medians, spread, percentiles and confidence intervals" },
  { kind: "topbox", label: "Top / Bottom box", group: "Basics", description: "Top-1/2/3 and bottom-1/2/3 shares of a scale" },
  { kind: "crosstab", label: "Crosstab / Banner", group: "Tables", description: "Rows × columns (× layers) with row / column / total %, weighted, significance letters" },
  { kind: "test", label: "Statistical test", group: "Statistics", description: "Chi-square, Fisher, t-tests, ANOVA, Mann-Whitney, Wilcoxon, Kruskal-Wallis, Friedman, proportions" },
  { kind: "correlation", label: "Correlation", group: "Statistics", description: "Pearson, Spearman, Kendall — pairs and matrices with significance" },
  { kind: "regression", label: "Regression", group: "Statistics", description: "Linear, logistic, multinomial; interactions, moderation, mediation" },
  { kind: "segmentation", label: "Segment profile", group: "Segments", description: "Compare saved segments across variables, with sizing and significance" },
  { kind: "cluster", label: "Cluster analysis", group: "Segments", description: "K-means and hierarchical clustering with profiles and a dendrogram" },
  { kind: "factor", label: "Factor / PCA", group: "Statistics", description: "Loadings, eigenvalues, scree, rotation and factor scores" },
  { kind: "reliability", label: "Reliability", group: "Statistics", description: "Cronbach's alpha, item-total and inter-item correlations" },
  { kind: "trend", label: "Trend", group: "Time", description: "Wave-over-wave or period-over-period metrics with rolling averages and baselines" },
  { kind: "nps", label: "NPS", group: "KPIs", description: "Net Promoter Score, groups, by segment, trend and drivers" },
  { kind: "csat", label: "CSAT / CES", group: "KPIs", description: "Satisfaction and effort scores, top-box, segments and drivers" },
  { kind: "turf", label: "TURF", group: "Choice", description: "Total unduplicated reach and frequency, best combinations, incremental reach" },
  { kind: "gap", label: "Importance × Performance", group: "Choice", description: "Gaps, opportunity scores and the priority matrix" },
  { kind: "pricing", label: "Pricing", group: "Choice", description: "Van Westendorp price sensitivity and Gabor-Granger demand" },
  { kind: "brand", label: "Brand", group: "Brand", description: "Funnel (awareness → consideration → usage → preference), conversion, image and equity" },
  { kind: "ranking", label: "Ranking", group: "Basics", description: "Average rank, rank distribution, first/last-place shares and rank scores" },
  { kind: "allocation", label: "Allocation", group: "Basics", description: "Average allocation, share and distribution of constant-sum questions" },
  { kind: "text", label: "Text analytics", group: "Text", description: "Word and keyword frequency, sentiment, themes, coding frames, by segment" },
  { kind: "quality", label: "Data quality", group: "Data", description: "Speeding, straight-lining, missingness, duplicates, attention checks, quality classes" },
  { kind: "weighting", label: "Weighting", group: "Data", description: "Cell and rim weighting with efficiency diagnostics" },
  { kind: "conjoint", label: "Conjoint", group: "Choice", description: "Part-worth utilities, attribute importance, preference shares and market simulation" },
  { kind: "maxdiff", label: "MaxDiff", group: "Choice", description: "Best/worst counts, utility scores, relative importance and segment comparison" },
];

export interface AnalysisDefinition {
  id?: string;
  name: string;
  kind: AnalysisKind;
  dataset: DatasetSpec;
  /** the variables the analysis works on (dictionary names) */
  variables: string[];
  /** crosstab / banner / test groupings */
  rows?: string[];
  columns?: string[];
  layers?: string[];
  measure?: "count" | "pct_row" | "pct_col" | "pct_total" | "mean";
  /** a filter applied before anything else */
  filter?: Condition | null;
  /** saved filter ids resolved by the caller into `filter` */
  filterIds?: string[];
  /** segments compared side by side */
  segments?: SegmentDef[];
  weighting?: WeightingSpec | null;
  /** per-kind options (test name, k, factors, price variables, …) */
  options?: Record<string, unknown>;
  /** for reproducibility: the survey version the analysis was written against */
  surveyVersion?: string;
  version?: number;
  notes?: string;
}

/* ------------------------------------------------------------ result */

export type CellType = "text" | "number" | "pct" | "sig" | "count";

export interface ResultColumn { key: string; label: string; type?: CellType; decimals?: number }

export interface ResultTable {
  id: string;
  title: string;
  columns: ResultColumn[];
  /** cells by column key; `<key>__sig` carries significance letters, `<key>__n` a cell base, `__format` overrides the column type for a whole row (e.g. a base row inside a % table) */
  rows: Record<string, unknown>[];
  base?: { n: number; weightedN?: number; label?: string };
  /** column bases for banner-style tables (key → n) */
  columnBases?: Record<string, number>;
  notes?: string[];
}

export interface TreeNode { name: string; value?: number; children?: TreeNode[] }

/** Chart-ready data. Categories × series is the workhorse; the rest serve specific families. */
export interface ChartData {
  categories?: string[];
  series?: { name: string; values: (number | null)[]; errors?: (number | null)[]; ci?: ([number, number] | null)[]; sig?: string[]; meta?: Record<string, unknown> }[];
  matrix?: { rows: string[]; columns: string[]; values: (number | null)[][]; rowBases?: number[] };
  points?: { x: number; y: number; label?: string; size?: number; group?: string }[];
  nodes?: { id: string; label: string; value?: number; group?: string }[];
  links?: { source: string; target: string; value: number }[];
  tree?: TreeNode[];
  words?: { text: string; value: number; sentiment?: number }[];
  kpis?: { label: string; value: number | string; delta?: number; unit?: string; target?: number }[];
  dendrogram?: { left: number; right: number; height: number; size: number }[];
  valueFormat?: "pct" | "number" | "score";
}

export interface AnalysisResult {
  kind: AnalysisKind;
  name: string;
  base: { total: number; filtered: number; n: number; weightedN: number; label: string };
  tables: ResultTable[];
  chart: ChartData;
  /** statistical tests attached to the analysis */
  tests: import("./stats/tests.js").TestResult[];
  insights: string[];
  warnings: string[];
  recommendedCharts: ChartType[];
  /** per-segment sub-results for segment switching */
  segments?: { name: string; n: number; chart: ChartData }[];
  computedAt: string;
  definitionHash: string;
  variablesUsed: string[];
}

/* ------------------------------------------------------------ charts */

export type ChartFamily =
  | "bar" | "pie" | "trend" | "statistical" | "relationship" | "heatmap" | "radar" | "funnel" | "kpi"
  | "ranking" | "significance" | "segmentation" | "advanced" | "geographic" | "text" | "conjoint" | "maxdiff" | "pricing" | "table";

export type ChartType =
  // bar / column
  | "bar_vertical" | "bar_horizontal" | "bar_grouped" | "bar_stacked" | "bar_stacked_100" | "column_clustered" | "lollipop" | "dot_plot" | "pareto" | "ranking_bar"
  // pie
  | "pie" | "donut" | "donut_nested" | "donut_semi" | "donut_radial"
  // trend
  | "line" | "line_multi" | "area" | "area_stacked" | "spline" | "step_line" | "rolling_average" | "wave_trend" | "yoy_trend" | "mom_trend"
  // statistical
  | "histogram" | "box_plot" | "violin" | "density" | "strip" | "beeswarm" | "raincloud"
  // relationship
  | "scatter" | "bubble" | "scatter_trendline" | "scatter_ci" | "correlation_matrix" | "correlogram"
  // heatmaps
  | "heatmap" | "heatmap_crosstab" | "heatmap_correlation" | "heatmap_satisfaction" | "heatmap_ipa" | "heatmap_quota"
  // radar
  | "radar" | "spider" | "radar_multi" | "radar_brand" | "radar_segment"
  // funnel
  | "funnel" | "funnel_brand" | "funnel_purchase" | "funnel_awareness" | "funnel_dropout"
  // kpi
  | "kpi_card" | "gauge" | "progress_circle" | "bullet" | "target_actual" | "scorecard"
  // ranking
  | "bump" | "rank_movement" | "rank_heatmap"
  // significance
  | "ci_plot" | "error_bar" | "forest" | "diff_means" | "diff_proportions" | "coefficient_plot"
  // segmentation
  | "segment_size" | "segment_comparison" | "segment_profile" | "segment_heatmap" | "segment_bubble"
  // advanced
  | "sankey" | "alluvial" | "treemap" | "sunburst" | "dendrogram" | "chord" | "network" | "parallel_coordinates" | "waterfall" | "marimekko"
  // geographic
  | "map_country" | "map_state" | "choropleth" | "map_bubble" | "map_heat"
  // text
  | "word_cloud" | "keyword_bar" | "theme_distribution" | "topic_distribution" | "sentiment_distribution" | "sentiment_trend" | "theme_segment_heatmap"
  // conjoint / maxdiff / pricing
  | "attribute_importance" | "part_worth" | "utility_by_level" | "preference_share" | "choice_probability" | "simulation" | "wtp"
  | "maxdiff_utility" | "maxdiff_preference" | "maxdiff_best_worst" | "maxdiff_segment" | "maxdiff_heatmap"
  | "price_sensitivity" | "demand_curve" | "purchase_probability" | "revenue_curve" | "price_elasticity"
  // diverging likert
  | "diverging_likert" | "mean_ci"
  | "table";

export interface ChartOptions {
  title?: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  legend?: "top" | "right" | "bottom" | "none";
  dataLabels?: boolean;
  decimals?: number;
  percent?: boolean;
  numberFormat?: "plain" | "thousands" | "compact";
  fontFamily?: string;
  fontSize?: number;
  lineWidth?: number;
  markerSize?: number;
  gridLines?: boolean;
  background?: string;
  margins?: { top?: number; right?: number; bottom?: number; left?: number };
  width?: number;
  height?: number;
  orientation?: "horizontal" | "vertical";
  sort?: "none" | "asc" | "desc" | "value" | "label";
  topN?: number;
  hiddenCategories?: string[];
  notes?: string;
  footnote?: string;
  source?: string;
  showSignificance?: boolean;
  showCI?: boolean;
  benchmark?: { value: number; label?: string } | null;
  target?: { value: number; label?: string } | null;
  showBase?: boolean;
  colors?: string[];
  segmentIndex?: number;
}

export interface ChartSpec {
  id?: string;
  name?: string;
  analysisId?: string;
  type: ChartType;
  options: ChartOptions;
  themeId?: string | null;
  version?: number;
}

/* ------------------------------------------------------------ themes */

export interface ReportTheme {
  id?: string;
  name: string;
  logoUrl?: string;
  colors: { primary: string; secondary: string; accent: string; background: string; text: string; subtle: string; palette: string[] };
  fontFamily: string;
  headingFontFamily?: string;
  header?: string;
  footer?: string;
  guidelines?: string;
  cover?: { background?: string; textColor?: string; layout?: "left" | "center" };
  chart?: { gridLines?: boolean; dataLabels?: boolean; decimals?: number; cornerRadius?: number };
  typography?: { baseSize?: number; titleSize?: number };
}

export const DEFAULT_THEME: ReportTheme = {
  name: "Rescript",
  // brand-aligned: Electric Indigo first, Cyan second, then a balanced categorical ramp
  colors: { primary: "#4f46e5", secondary: "#131a2b", accent: "#06b6d4", background: "#ffffff", text: "#131a2b", subtle: "#6b7690",
    palette: ["#4f46e5", "#06b6d4", "#f59e0b", "#10b981", "#f43f5e", "#8b5cf6", "#f97316", "#84cc16", "#ec4899", "#64748b"] },
  fontFamily: "Inter, system-ui, sans-serif",
  chart: { gridLines: true, dataLabels: true, decimals: 0 },
  typography: { baseSize: 12, titleSize: 16 },
};

/* ------------------------------------------------------------ reports / dashboards */

export type ReportBlock =
  | { id: string; type: "cover"; title: string; subtitle?: string; date?: string; author?: string }
  | { id: string; type: "section"; title: string; subtitle?: string }
  | { id: string; type: "text"; title?: string; markdown: string }
  | { id: string; type: "chart"; title?: string; analysisId: string; chart: ChartSpec; caption?: string }
  | { id: string; type: "table"; title?: string; analysisId: string; tableId?: string; caption?: string }
  | { id: string; type: "kpi"; title?: string; analysisId: string; metric?: string }
  | { id: string; type: "insights"; title?: string; analysisIds: string[] }
  | { id: string; type: "executive_summary"; title?: string; analysisIds: string[]; text?: string };

export interface ReportDefinition {
  title: string;
  subtitle?: string;
  themeId?: string | null;
  mode: "live" | "snapshot";
  blocks: ReportBlock[];
  /** filters a shared viewer may switch — everything else is fixed */
  viewerSegments?: string[];
  branding?: { showLogo?: boolean; footer?: string; header?: string };
  exportDefaults?: ExportSettings;
}

export interface DashboardWidget {
  id: string;
  type: "kpi" | "chart" | "table" | "text" | "filter";
  title?: string;
  analysisId?: string;
  chart?: ChartSpec;
  text?: string;
  /** for filter widgets: the variable a viewer can pick a value of */
  variable?: string;
  w: number; h: number; x: number; y: number;
}

export interface DashboardDefinition {
  title: string;
  themeId?: string | null;
  widgets: DashboardWidget[];
  crossFilter?: boolean;
}

/* ------------------------------------------------------------ export */

export interface ExportSettings {
  format: "pptx" | "xlsx";
  themeId?: string | null;
  include: { executiveSummary: boolean; charts: boolean; tables: boolean; tests: boolean; sampleProfile: boolean; methodology: boolean; footnotes: boolean };
  pptx?: { slideSize?: "16x9" | "4x3" | "16x10"; titlePlacement?: "top" | "left"; chartWidth?: number; chartHeight?: number; fontFamily?: string; footer?: string; background?: string; logoUrl?: string; sectionDividers?: boolean; slideNumbers?: boolean };
  xlsx?: { workbookName?: string; sheetOrder?: string[]; sheetNames?: Record<string, string>; decimals?: number; percentFormat?: "0%" | "0.0%" | "0.00%"; tableStyle?: "plain" | "striped" | "bordered"; freezePanes?: boolean; autoFilter?: boolean; fontFamily?: string; includeNotes?: boolean; includeMetadata?: boolean };
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "pptx",
  include: { executiveSummary: true, charts: true, tables: true, tests: true, sampleProfile: true, methodology: true, footnotes: true },
  pptx: { slideSize: "16x9", titlePlacement: "top", sectionDividers: true, slideNumbers: true },
  xlsx: { decimals: 1, percentFormat: "0.0%", tableStyle: "striped", freezePanes: true, autoFilter: true, includeNotes: true, includeMetadata: true },
};
