import type { AnalysisDefinition, AnalysisResult, ChartType } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import { chooseChart, type Audience } from "./chartPurpose.js";
import { chartsAvailable, recommendCharts, type ChartRecommendation } from "./recommend.js";
import { onePerPicture } from "./chartPictures.js";

/**
 * QUESTION-AWARE CHART SELECTION (Data Analytics audit, Oct 2026).
 *
 * `chooseChart` already reads WHY a chart is shown (purpose) and for WHOM
 * (audience). What it could not read is WHAT was asked: a multiple-choice
 * question whose bars add to more than 100 %, a Likert battery, a numeric
 * answer, a ranking. Without that, every categorical question got a bar and
 * a pie, every result with a mean got a mean chart, and nothing said what
 * the percentages were percentages OF.
 *
 * This layer adds the question's measurement structure on top of the same
 * candidate list: it lifts the charts that suit the structure, VETOES the
 * ones that would misrepresent it (a pie of overlapping answers, a mean of a
 * categorical, a line across unordered categories), states the denominator,
 * and says why — in a sentence a researcher can read. It never invents a
 * chart the data cannot draw; the candidates are the shape-based ones.
 */
export type Scale = "nominal" | "ordinal" | "multi" | "numeric" | "ranking" | "text" | "time" | "mixed" | "unknown";

const ORDINAL_TYPES = new Set(["rating", "rating_scale", "likert", "matrix_likert", "matrix_single", "star_rating", "semantic_differential"]);
const RANKING_TYPES = new Set(["ranking", "image_ranking"]);

const SCALE_WORDS = /\b(very|strongly|somewhat|slightly|neither|agree|disagree|satisf|dissatisf|likely|unlikely|poor|fair|good|excellent|never|rarely|sometimes|often|always|none|low|high|not at all|extremely)\b/i;
/** a single-choice list whose answers are numbers, or are worded as a scale, is a scale — "North, South, East, West" is not */
export function looksOrdered(categories: readonly { code: string; label: string }[] | undefined): boolean {
  if (!categories || categories.length < 3 || categories.length > 11) return false;
  return categories.every((c) => /^\d+$/.test(String(c.label).trim())) || categories.filter((c) => SCALE_WORDS.test(String(c.label))).length >= Math.ceil(categories.length / 2);
}

/** The measurement structure of one variable, from its dictionary entry. */
export function scaleOf(meta: Pick<VariableMeta, "role" | "questionType" | "categories"> | undefined): Scale {
  if (!meta) return "unknown";
  const t = meta.questionType ?? "";
  if (RANKING_TYPES.has(t)) return "ranking";
  if (meta.role === "multi") return "multi";
  if (meta.role === "text") return "text";
  if (meta.role === "date") return "time";
  if (meta.role === "numeric") return "numeric";
  if (meta.role === "scale") return ORDINAL_TYPES.has(t) || (meta.categories?.length ?? 0) >= 3 ? "ordinal" : "numeric";
  if (meta.role === "categorical") return ORDINAL_TYPES.has(t) || looksOrdered(meta.categories) ? "ordinal" : "nominal";
  return "unknown";
}

export interface ChartAdvice {
  /** the chart to open on */
  type: ChartType;
  /** why this one, in a sentence */
  reason: string;
  /** what the percentages / means are of: "% of the 212 respondents who answered; several answers allowed" */
  denominator: string;
  /** the same, short enough for the line under a chart */
  basis?: string;
  scale: Scale;
  /** ranked, best first — the one above is the first */
  alternatives: ChartRecommendation[];
  /** charts that were available but are wrong for this question, and why — so an override can be explained */
  avoided: { type: ChartType; why: string }[];
  /** reading notes: small base, overlapping answers, unordered categories */
  notes: string[];
}

const PIE_LIKE: ChartType[] = ["pie", "donut", "bar_stacked_100"];
const MEAN_LIKE: ChartType[] = ["mean_ci", "ci_plot", "error_bar", "diff_means"];
const LINE_LIKE: ChartType[] = ["line", "line_multi", "area", "spline", "wave_trend"];
const SMALL = 30;

const firstVars = (def: Pick<AnalysisDefinition, "variables" | "rows" | "columns">): string[] => [...(def.rows ?? []), ...(def.variables ?? []), ...(def.columns ?? [])].filter(Boolean);

/**
 * What the figures are a share / mean OF — never left for the reader to guess.
 * In a cross-tabulation the answer depends on the measure the table is in
 * (audit C-4): column percentages are shares of each column's respondents, row
 * percentages of each row's, counts are not shares at all.
 */
export function denominatorFor(result: Pick<AnalysisResult, "base" | "kind">, scale: Scale, measure?: string): string {
  const b = result.base;
  const who = b.label && b.label !== "All respondents" ? b.label.toLowerCase() : "respondents";
  const n = b.n ?? 0;
  if (n === 0) return `No ${who} in the selected data.`;
  const answered = b.total && n < b.total ? `the ${n} of ${b.total} ${who} who answered` : `all ${n} ${who}`;
  if (result.kind === "crosstab" && measure) {
    if (measure === "count") return `Numbers of ${who}, not shares; ${answered}.`;
    if (measure === "pct_row") return `% of the ${who} in each row; ${answered}.`;
    if (measure === "pct_col") return `% of the ${who} in each column; ${answered}.`;
    if (measure === "pct_total") return `% of ${answered}.`;
    if (measure === "mean") return `Means within each column; ${answered}.`;
  }
  if (scale === "multi") return `% of ${answered}; several answers were allowed, so the bars add to more than 100%.`;
  if (scale === "numeric") return `Based on ${answered}.`;
  if (scale === "ranking") return `Based on ${answered}; each ranked the items.`;
  return `% of ${answered}.`;
}

/** the short line under a chart: what the figures are of, and the base — "Column % · n = 212 of 400 answered" */
export function basisLine(result: Pick<AnalysisResult, "base" | "kind">, measure?: string): string {
  const b = result.base;
  const of = b.total && b.n < b.total ? `${b.n} of ${b.total} answered` : `${b.n}`;
  const w = b.weightedN !== b.n && b.weightedN ? ` (weighted ${b.weightedN})` : "";
  const what = result.kind === "crosstab" && measure ? ({ pct_col: "Column %", pct_row: "Row %", pct_total: "% of total", count: "Counts", mean: "Means" } as Record<string, string>)[measure] : undefined;
  return `${what ? `${what} · ` : ""}n = ${of}${w}`;
}

export function adviseChart(
  def: Pick<AnalysisDefinition, "kind" | "variables" | "columns" | "rows" | "measure" | "options">,
  result: AnalysisResult,
  variables: readonly VariableMeta[],
  opts: { audience?: Audience } = {},
): ChartAdvice {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const scales = firstVars(def).map((n) => scaleOf(byName.get(n)));
  const scale: Scale = def.kind === "trend" ? "time" : scales.length === 0 ? "unknown" : scales.every((s) => s === scales[0]) ? scales[0] : scales.includes("multi") ? "multi" : "mixed";
  const batteryOrdinal = scales.filter((s) => s === "ordinal").length >= 2;
  const nCat = result.chart.categories?.length ?? 0, nSer = result.chart.series?.length ?? 0;
  const n = result.base.n ?? 0;
  const ordered = def.kind === "trend" || scale === "time" || (result.chart.categories?.every((c) => /^\d{4}(-\d{2}|-W\d{2})?$/.test(c) || /^(wave|w)\s*\d+$/i.test(c)) ?? false);

  const candidates = chooseChart(def, result, { audience: opts.audience, limit: 40 });
  const avoided: { type: ChartType; why: string }[] = [];
  const veto = (type: ChartType, why: string) => avoided.push({ type, why });
  const notes: string[] = [];
  const adjust = new Map<ChartType, number>();
  const bump = (t: ChartType, by: number) => adjust.set(t, (adjust.get(t) ?? 0) + by);
  const vetoed = new Set<ChartType>();
  const forbid = (types: ChartType[], why: string) => { for (const t of types) if (candidates.some((c) => c.type === t) && !vetoed.has(t)) { vetoed.add(t); veto(t, why); } };

  if (scale === "multi") {
    forbid(PIE_LIKE, "answers overlap, so the parts do not make a whole");
    bump("bar_horizontal", 30); bump("lollipop", 8);
    notes.push("Several answers were allowed: percentages add to more than 100%.");
  }
  if (scale === "nominal" || scale === "multi") {
    forbid(MEAN_LIKE, "a mean of unordered categories means nothing");
    forbid(LINE_LIKE.filter((t) => !ordered), "a line implies an order that categories do not have");
    if (scale === "nominal") { bump(nCat > 6 ? "bar_horizontal" : "bar_vertical", 24); if (nCat > 5) forbid(["pie", "donut"], `${nCat} slices cannot be compared by eye`); }
  }
  if (scale === "ordinal") {
    bump(batteryOrdinal ? "diverging_likert" : "bar_vertical", batteryOrdinal ? 34 : 22);
    forbid(PIE_LIKE.filter((t) => t !== "bar_stacked_100"), "a scale has an order that slices throw away");
    if (!batteryOrdinal) notes.push("Scale points keep their order — they are not sorted by size.");
  }
  if (scale === "numeric") {
    bump("histogram", 28); bump("box_plot", 14);
    forbid(PIE_LIKE, "a numeric answer is a distribution, not parts of a whole");
  }
  if (scale === "ranking") { bump("ranking_bar", 26); bump("bar_horizontal", 20); forbid(PIE_LIKE, "ranks are not shares"); }
  if (scale === "text") { bump("word_cloud", 10); bump("theme_distribution", 14); }
  if (!ordered && def.kind !== "trend") forbid(LINE_LIKE, "there is no time or order to draw a line through");
  if (def.kind === "crosstab") {
    const cells = nCat * nSer;
    if (nSer <= 4 && cells <= 24) bump("bar_grouped", 10);
    /*
     * A MATRIX READ AS BARS (audit C-7): 12 rows × 8 columns drew 96 bars the eye cannot compare, because the heatmap
     * rule added too little to beat the grouped bar the runner suggests first. Past 24 cells (three or more series)
     * grouped bars are ruled out and the heatmap leads; past 120 a table does.
     */
    if (cells > 24 && nSer >= 3) {
      forbid(["bar_grouped", "bar_vertical", "column_clustered", "bar_horizontal"], `${cells} bars cannot be compared by eye — ${cells <= 120 ? "a heatmap shows every cell" : "a table shows every cell"}`);
      if (cells <= 120) { bump("heatmap_crosstab", 40); bump("heatmap", 30); }
    }
    if (cells > 120) { bump("table", 60); notes.push(`${cells} cells — a table reads better than any chart.`); }
    if (nSer > 6) forbid(["radar"], "too many series for a radar");
  }
  if (n > 0 && n < SMALL) {
    forbid(["pie", "donut"], `only ${n} respondents — slices would suggest a precision the sample does not have`);
    bump("table", 14);
    notes.push(`Only ${n} respondents answered — read the figures as indicative.`);
  }

  const avail = new Set(chartsAvailable(result));
  const scored = candidates
    .filter((c) => !vetoed.has(c.type))
    .map((c) => ({ ...c, score: c.score + (adjust.get(c.type) ?? 0) }));
  /* a lifted chart the shape-based pass did not list is still a candidate when the data can draw it */
  for (const [t, by] of adjust) if (by > 0 && avail.has(t) && !vetoed.has(t) && !scored.some((s) => s.type === t)) {
    const base = recommendCharts(result, 80, { aliases: true }).find((r) => r.type === t);
    if (base) scored.push({ ...base, score: base.score + by, purpose: candidates[0]?.purpose ?? "comparison", audience: opts.audience ?? "client", purposeWhy: candidates[0]?.purposeWhy ?? "" });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const type: ChartType = best?.type ?? "table";
  const why = (() => {
    const bits: string[] = [];
    if (scale === "multi") bits.push("a multiple-choice question: horizontal bars, each a share of respondents");
    else if (scale === "nominal") bits.push(`a categorical question with ${nCat || "several"} answers`);
    else if (scale === "ordinal") bits.push(batteryOrdinal ? "a battery of scale items: a diverging bar around the midpoint" : "a scale question: bars in scale order");
    else if (scale === "numeric") bits.push("a numeric answer: its distribution");
    else if (scale === "ranking") bits.push("a ranking: items in rank order");
    else if (scale === "time") bits.push("ordered periods");
    else if (def.kind === "crosstab") bits.push("a cross-tabulation");
    else bits.push(`the shape of this ${def.kind} result`);
    if (best?.reason) bits.push(best.reason.split(";")[0]);
    return bits.join(" — ");
  })();

  return {
    type, reason: why, denominator: denominatorFor(result, scale, def.kind === "crosstab" ? def.measure ?? "pct_col" : undefined), basis: basisLine(result, def.kind === "crosstab" ? def.measure ?? "pct_col" : undefined), scale,
    /* each picture once: "spider" beside "radar" is one choice, not two (audit C-8) */
    alternatives: onePerPicture(scored).slice(0, 6).map(({ purpose: _p, audience: _a, purposeWhy: _w, ...r }) => (void _p, void _a, void _w, r)),
    avoided, notes,
  };
}

/**
 * Is a chart type that was chosen (and saved) still right for this result?
 * A saved choice survives a refresh — unless the data can no longer draw it,
 * in which case the report falls back to the best chart and says so, rather
 * than rendering "No data to chart".
 */
export function checkChartChoice(result: AnalysisResult, type: ChartType): { valid: boolean; fallback?: ChartType; reason?: string } {
  if (type === "table") return { valid: true };
  const avail = chartsAvailable(result);
  if (avail.includes(type)) return { valid: true };
  const fb = recommendCharts(result, 1)[0]?.type ?? "table";
  return { valid: false, fallback: fb, reason: `${type.replace(/_/g, " ")} cannot draw this result (it needs a different data shape), so it is shown as ${fb.replace(/_/g, " ")}.` };
}

/**
 * The ranked chart list every consumer reads — the deck, the story, the report builder, the findings — so that one analysis is
 * drawn as one chart wherever it appears (audit C-5). When the result carries the question-aware advice it was run with, that
 * advice decides the order and what is ruled out; the purpose/audience fields come from the shape ranking beside it.
 */
export function rankedCharts(def: Pick<AnalysisDefinition, "kind" | "variables" | "columns" | "rows" | "measure" | "options">, result: AnalysisResult, opts: { audience?: Audience; limit?: number } = {}) {
  const base = chooseChart(def, result, { audience: opts.audience, limit: opts.limit ?? 40 });
  const adv = result.advice;
  if (!adv) return base;
  const order = [adv.type, ...adv.alternatives.map((a) => a.type)];
  const avoided = new Set(adv.avoided.map((a) => a.type));
  const rank = (t: ChartType) => { const i = order.indexOf(t); return i < 0 ? order.length : i; };
  const kept = base.filter((b) => !avoided.has(b.type));
  if (!kept.some((b) => b.type === adv.type) && base[0]) kept.push({ ...base[0], type: adv.type, reason: adv.reason });
  return kept.sort((a, b) => rank(a.type) - rank(b.type) || b.score - a.score);
}
