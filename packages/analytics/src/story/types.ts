/**
 * THE STORY REPORT — the one definition a research video and its PowerPoint
 * are both made from.
 *
 * A story report is the approved report as data: the scenes in order, each
 * with its headline, its on-screen text, its voice-over, the visual it shows
 * (a chart or table whose numbers are FROZEN here from the analysis result
 * they came from, with a reference back to that analysis), its layout, its
 * motion and its notes (sources, footnotes, caveats); and the design the
 * whole thing is drawn in. The video renderer and the PowerPoint builder
 * read this and nothing else, so the two can only differ where their media
 * differ (motion, and the slide's fixed 16:9 page).
 *
 * Every number on screen is in a scene's `visual` and traces to `sources`.
 * Nothing here is generated from memory: the planner fills it from a run of
 * the analysis plan, a revision edits it through explicit operations, and a
 * person edits it field by field.
 */
import type { ChartType } from "../types.js";

export const STORY_SCHEMA = 1 as const;

/* ------------------------------------------------------------ design */

export type AspectRatio = "16:9" | "9:16" | "1:1";
export type FontFamilyId = "Inter" | "Source Serif 4" | "Montserrat";
export const FONT_FAMILIES: FontFamilyId[] = ["Inter", "Source Serif 4", "Montserrat"];
export type PresetId = "corporate_executive" | "modern_analytics" | "premium_editorial" | "minimal_research" | "cinematic_data_story" | "custom_brand";
export type MotionStyle = "none" | "subtle" | "standard" | "expressive";
export type Transition = "cut" | "fade" | "slide";
export type TitleStyle = "left_rule" | "kicker" | "centered" | "band";
export type Density = "airy" | "balanced" | "dense";
export type LogoPlacement = "top_right" | "bottom_right" | "bottom_left";

export interface DesignColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  /** chart rules and table borders */
  grid: string;
  /** chart series, in order; the first is the focus colour */
  chart: string[];
  tableHeaderBg: string;
  tableHeaderText: string;
  /** a highlighted category or cell */
  highlight: string;
  positive: string;
  negative: string;
}

/** sizes in px at 1080 px of the canvas' short side; scaled for other resolutions */
export interface TypeScale { display: number; title: number; headline: number; body: number; caption: number; stat: number; label: number }

export interface DesignConfig {
  preset: PresetId;
  name: string;
  colors: DesignColors;
  typography: { heading: FontFamilyId; body: FontFamilyId; numeric: FontFamilyId; headingWeight: 700; scale: TypeScale };
  density: Density;
  titleStyle: TitleStyle;
  /** decorative treatment only — never placed over data */
  imagery: "none" | "logo_only" | "geometric";
  motion: { style: MotionStyle; speed: number; transition: Transition };
  dataLabels: { show: boolean; decimals: number };
  footer: { text: string; showLogo: boolean; pageNumbers: boolean; sources: boolean };
  logo?: { dataUri: string; width: number; height: number; placement: LogoPlacement; assetId?: string; name?: string };
  video: { aspect: AspectRatio; height: 720 | 1080 | 1440 | 2160; fps: 24 | 25 | 30; targetDurationSec?: number; narration: boolean; subtitles: boolean; voice?: string };
}

/* ------------------------------------------------------------ visuals */

/** the chart types the story renderer draws itself, in video and as native PowerPoint charts */
export type StoryChartType = "bar" | "hbar" | "grouped_bar" | "stacked_100" | "line" | "donut";
export const STORY_CHART_TYPES: StoryChartType[] = ["bar", "hbar", "grouped_bar", "stacked_100", "line", "donut"];

/** where a number came from */
export interface SourceRef {
  /** the saved analysis (analytics_analyses.id) when there is one */
  analysisId?: string;
  /** the plan item (research.analysisPlan) it serves */
  plannedId?: string;
  /** the analysis name as the run named it */
  name: string;
  /** the stored run the report was built from */
  runId?: string;
  /** hash of the analysis definition that produced the frozen data */
  definitionHash?: string;
}

/** the numbers a chart draws, frozen from the result */
export interface FrozenChartData {
  categories: string[];
  series: { name: string; values: (number | null)[]; sig?: string[] }[];
  /** "pct" values are percentages (0–100); "mean" averages; "count" counts */
  valueFormat: "pct" | "mean" | "count" | "number";
  decimals: number;
  /** the base: respondents the chart is computed on */
  base: number | null;
  /** per-series base sizes, when the series are groups */
  seriesBases?: (number | null)[];
  /** significance letters are meaningful only when a test produced them */
  significanceTested: boolean;
  /** what the axis measures, in words */
  measure: string;
}

export interface FrozenTable {
  title: string;
  columns: { key: string; label: string; numeric: boolean; decimals?: number; pct?: boolean }[];
  rows: Record<string, string | number | null>[];
  base: number | null;
  notes: string[];
  /** rows shown on the main scene when the table is long; the rest are in the appendix */
  mainRows?: number;
}

export interface ChartRecommendationNote { type: StoryChartType; why: string; alternatives: { type: StoryChartType; why: string; allowed: boolean }[] }

export type SceneVisual =
  | { type: "none" }
  | { type: "bullets"; items: string[] }
  | { type: "chart"; chart: StoryChartType; data: FrozenChartData; highlight?: string[]; recommendation?: ChartRecommendationNote; source: SourceRef; sourceChart?: ChartType }
  | { type: "table"; table: FrozenTable; highlight?: string[]; source: SourceRef }
  | { type: "kpis"; items: { label: string; value: string; detail?: string; source?: SourceRef }[] }
  | { type: "stat"; value: string; label: string; detail: string; source?: SourceRef }
  | { type: "verdicts"; items: { label: string; text: string; verdict: "supported" | "not_supported" | "mixed" | "inconclusive" | "untested"; reason: string }[] }
  | { type: "facts"; items: { label: string; value: string }[] };

/* ------------------------------------------------------------ scenes */

export type SceneKind =
  | "title" | "objective" | "method" | "sample" | "summary" | "section"
  | "finding" | "comparison" | "hypotheses" | "statistic" | "kpis" | "wave" | "themes"
  | "conclusions" | "recommendations" | "limitations" | "appendix_table" | "closing";

export type SceneLayout = "title" | "text" | "visual_right" | "visual_full" | "stat_center" | "kpi_row" | "verdicts" | "facts" | "table" | "closing";

/** how strongly the data supports what the scene says — shown, never implied by colour alone */
export type EvidenceLevel = "significant" | "not_significant" | "descriptive" | "mixed" | "exploratory";

export interface Scene {
  id: string;
  kind: SceneKind;
  /** main narrative or appendix */
  section: "main" | "appendix";
  /** the small label above the title (the report section) */
  kicker?: string;
  title: string;
  subtitle?: string;
  /** on-screen explanation, one or two sentences */
  body?: string;
  /** what the narrator says, when narration is on; defaults to title + body */
  voiceover?: string;
  visual: SceneVisual;
  layout: SceneLayout;
  emphasis: "standard" | "focus";
  motion: { enter: "fade" | "rise" | "none"; chart: "grow" | "reveal" | "none"; transition: Transition | "inherit" };
  /** seconds; `auto` is computed from what has to be read */
  duration: number | "auto";
  notes: { sources: SourceRef[]; footnotes: string[]; caveats: string[] };
  evidence?: EvidenceLevel;
  /** fields a person changed — a regeneration and a revision leave these alone unless told otherwise */
  locked: string[];
  /** the engine's own version of this scene, for "restore the recommendation" */
  recommended?: Omit<Scene, "recommended" | "locked">;
}

export interface StoryReport {
  schema: typeof STORY_SCHEMA;
  title: string;
  subtitle: string;
  audience: "executive" | "client" | "researcher";
  /** where the content came from */
  createdFrom: { runId?: string | null; computedAt: string; n: number; environment: string; dataset: string; planHash?: string | null; surveyVersion?: string | null };
  design: DesignConfig;
  scenes: Scene[];
  /** outputs the researcher asked for */
  outputs: { pptx: boolean; video: boolean };
}

/* ------------------------------------------------------------ status */

export type StoryStatus = "draft" | "ready_for_review" | "validation_required" | "ready_to_render" | "rendering" | "completed" | "failed";
