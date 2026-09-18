import type { AnalysisDefinition, AnalysisResult, ChartData, ChartType, ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, itemLabelOf, labelOf, numericColumn, scaleCodes, segmentDatasets, weights, type Dataset } from "../dataset.js";
import { boxShares, describe, frequencies } from "../stats/descriptive.js";
import { proportionCI } from "../stats/tests.js";
import { fmtNum, fmtPct, makeResult, opt, pct, round } from "./common.js";

/* ============================================================ descriptive */

export function descriptive(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const tables: ResultTable[] = [];
  const insights: string[] = [];
  const warnings: string[] = [];
  const w = weights(ds);
  const categories: string[] = [];
  const series: NonNullable<ChartData["series"]> = [];
  let chart: ChartData = {};
  const recommended: ChartType[] = [];
  const ci = opt(def, "confidence", 0.95) as number;

  for (const name of def.variables) {
    const meta = ds.byName.get(name);
    const label = labelOf(ds, name);
    if (!meta) { warnings.push(`Variable ${name} is not in this survey's dictionary.`); continue; }
    if (meta.role === "numeric" || (meta.role === "scale" && opt(def, "scaleAsNumeric", false))) {
      const d = describe(numericColumn(ds, name), w, ci);
      tables.push({
        id: `desc_${name}`, title: `${label} — descriptive statistics`,
        columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 2 }],
        rows: [
          { stat: "Valid n", value: d.n }, { stat: "Weighted n", value: round(d.weightedN, 1) }, { stat: "Missing", value: d.missing },
          { stat: "Mean", value: round(d.mean) }, { stat: "Median", value: round(d.median) }, { stat: "Mode", value: round(d.mode) },
          { stat: "Std. deviation", value: round(d.sd) }, { stat: "Std. error", value: round(d.se, 3) }, { stat: "Variance", value: round(d.variance) },
          { stat: "Minimum", value: round(d.min) }, { stat: "Maximum", value: round(d.max) }, { stat: "Range", value: round(d.range) }, { stat: "Sum", value: round(d.sum) },
          { stat: `${Math.round(ci * 100)}% CI lower`, value: round(d.ci95?.[0]) }, { stat: `${Math.round(ci * 100)}% CI upper`, value: round(d.ci95?.[1]) },
          ...Object.entries(d.percentiles).map(([k, v]) => ({ stat: `Percentile ${k.slice(1)}`, value: round(v) })),
        ],
        base: { n: d.n, weightedN: round(d.weightedN, 1) ?? d.n },
      });
      categories.push(label);
      if (!series.length) series.push({ name: "Mean", values: [], ci: [] });
      series[0].values.push(round(d.mean));
      series[0].ci!.push(d.ci95 ? [round(d.ci95[0])!, round(d.ci95[1])!] : null);
      if (d.mean != null) insights.push(`${label}: mean ${fmtNum(d.mean, 2)} (median ${fmtNum(d.median, 2)}, SD ${fmtNum(d.sd, 2)}, n = ${d.n}).`);
      // histogram data for a single numeric variable
      if (def.variables.length === 1) {
        const vals = numericColumn(ds, name).filter((x): x is number => x != null);
        const bins = histogram(vals, opt(def, "bins", 10));
        chart = { categories: bins.map((b) => b.label), series: [{ name: label, values: bins.map((b) => b.count) }] };
        /*
         * THE POINTS A DISTRIBUTION CHART NEEDS.
         *
         * `box_plot`, `violin`, `raincloud`, `beeswarm` and `strip` all read
         * `chart.points`, and this runner recommended box_plot while emitting
         * none — so choosing the chart it suggested rendered "No data to
         * chart". The catalogue was writing cheques the analysis did not
         * honour. Every value is carried (capped, because a chart of 50 000
         * dots is neither faster nor more informative than a chart of 2 000),
         * with x as the variable's position so several numerics plot side by
         * side.
         */
        const POINT_CAP = 2000;
        const step = vals.length > POINT_CAP ? Math.ceil(vals.length / POINT_CAP) : 1;
        chart.points = vals
          .filter((_, i) => i % step === 0)
          .map((v) => ({ x: 0, y: v, label, group: label }));
        if (step > 1) {
          warnings.push(`Distribution charts show every ${step}${step === 2 ? "nd" : step === 3 ? "rd" : "th"} case (${Math.ceil(vals.length / step)} of ${vals.length}) — the statistics above use all of them.`);
        }
        recommended.push("histogram", "box_plot", "density", "mean_ci");
      }
    } else if (meta.role === "categorical" || meta.role === "multi" || meta.role === "scale") {
      // (scale handled as categorical distribution; a mean row is added below)
      const cats = categoriesOf(ds, name);
      const f = frequencies(categoricalColumn(ds, name), w, cats);
      tables.push({
        id: `freq_${name}`, title: `${label} — frequencies`,
        columns: [{ key: "code", label: "Code" }, { key: "label", label: "Response" }, { key: "count", label: "n", type: "count" }, { key: "weightedCount", label: "Weighted n", type: "number", decimals: 1 }, { key: "pct", label: "% of total", type: "pct", decimals: 1 }, { key: "validPct", label: "% of valid", type: "pct", decimals: 1 }],
        rows: [...f.rows.map((r) => ({ ...r, weightedCount: round(r.weightedCount, 1), pct: pct(r.pct), validPct: pct(r.validPct) })), { code: "", label: "Missing", count: f.missing, weightedCount: round(f.weightedN - f.weightedValid, 1), pct: pct(f.weightedN ? ((f.weightedN - f.weightedValid) / f.weightedN) * 100 : 0), validPct: null }],
        base: { n: f.valid, weightedN: round(f.weightedValid, 1) ?? f.valid },
        notes: meta.role === "multi" ? ["Multiple responses allowed — percentages sum to more than 100%."] : undefined,
      });
      const top = [...f.rows].sort((a, b) => b.validPct - a.validPct)[0];
      if (top && f.valid) insights.push(`${label}: the most common response is “${top.label}” (${fmtPct(top.validPct, 1)} of ${f.valid}).`);
      if (def.variables.length === 1 || !chart.categories) {
        chart = { categories: f.rows.map((r) => r.label), series: [{ name: label, values: f.rows.map((r) => pct(r.validPct)), ci: f.rows.map((r) => { const c = proportionCI(r.count, f.valid); return c ? [round(c[0] * 100, 1)!, round(c[1] * 100, 1)!] : null; }) }], valueFormat: "pct" };
        recommended.push(f.rows.length <= 6 && meta.role !== "multi" ? "pie" : "bar_horizontal", "bar_vertical", "donut", "lollipop");
        if (meta.role === "scale") recommended.unshift("diverging_likert");
      } else {
        // several categoricals → stacked comparison when they share a code frame
        chart.series ??= [];
      }
    } else if (meta.role === "text") {
      const vals = categoricalColumn(ds, name).filter((v) => v != null);
      tables.push({ id: `text_${name}`, title: `${label} — responses`, columns: [{ key: "n", label: "Responses", type: "count" }], rows: [{ n: vals.length }], notes: ["Use Text analytics for themes, keywords and sentiment."] });
    } else {
      warnings.push(`${label} (${meta.questionType}) has no descriptive summary — use the dedicated analysis for this question type.`);
    }
  }
  if (!chart.categories && categories.length) { chart = { categories, series }; recommended.push("mean_ci", "bar_horizontal", "dot_plot"); }
  // several scale variables sharing a frame → stacked distribution
  const scaleVars = def.variables.filter((v) => ds.byName.get(v)?.role === "scale");
  if (scaleVars.length > 1) {
    const frame = categoriesOf(ds, scaleVars[0]);
    const same = scaleVars.every((v) => categoriesOf(ds, v).map((c) => c.code).join() === frame.map((c) => c.code).join());
    if (same) {
      chart = { categories: scaleVars.map((v) => labelOf(ds, v)), series: frame.map((c) => ({ name: c.label, values: scaleVars.map((v) => { const f = frequencies(categoricalColumn(ds, v), w, frame); return pct(f.rows.find((r) => r.code === c.code)?.validPct ?? 0); }) })), valueFormat: "pct" };
      recommended.splice(0, recommended.length, "bar_stacked_100", "diverging_likert", "heatmap", "mean_ci");
    }
  }
  const segs = segmentDatasets(ds, def.segments).map(({ segment, data }) => {
    const v = def.variables[0];
    const meta = ds.byName.get(v);
    if (!meta) return { name: segment.name, n: data.cases.length, chart: {} };
    if (meta.role === "numeric") { const d = describe(numericColumn(data, v), weights(data)); return { name: segment.name, n: data.cases.length, chart: { categories: [labelOf(ds, v)], series: [{ name: "Mean", values: [round(d.mean)] }] } }; }
    const f = frequencies(categoricalColumn(data, v), weights(data), categoriesOf(ds, v));
    return { name: segment.name, n: data.cases.length, chart: { categories: f.rows.map((r) => r.label), series: [{ name: segment.name, values: f.rows.map((r) => pct(r.validPct)) }], valueFormat: "pct" as const } };
  });
  return makeResult(def, ds, { tables, chart, insights, warnings, recommendedCharts: [...new Set(recommended)], segments: segs.length ? segs : undefined, totalCases });
}

export function histogram(values: number[], bins = 10): { label: string; from: number; to: number; count: number }[] {
  if (!values.length) return [];
  const min = Math.min(...values), max = Math.max(...values);
  if (min === max) return [{ label: String(min), from: min, to: max, count: values.length }];
  const width = (max - min) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0, label: "" }));
  for (const v of values) { let i = Math.floor((v - min) / width); if (i >= bins) i = bins - 1; out[i].count++; }
  const d = width >= 10 ? 0 : width >= 1 ? 1 : 2;
  for (const b of out) b.label = `${b.from.toFixed(d)}–${b.to.toFixed(d)}`;
  return out;
}

/* ============================================================ top / bottom box */

export function topbox(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const w = weights(ds);
  const boxes = opt(def, "boxes", [1, 2, 3]) as number[];
  const rows: Record<string, unknown>[] = [];
  const categories: string[] = [];
  const topSeries: (number | null)[] = [], bottomSeries: (number | null)[] = [], meanSeries: (number | null)[] = [];
  const warnings: string[] = [];
  const primary = opt(def, "primaryBox", 2) as number;
  for (const name of def.variables) {
    const codes = scaleCodes(ds, name);
    if (codes.length < 2) { warnings.push(`${itemLabelOf(ds, name)} is not an ordered scale.`); continue; }
    const vals = numericColumn(ds, name);
    const s = boxShares(vals, w, codes, boxes);
    const d = describe(vals, w);
    categories.push(itemLabelOf(ds, name));
    topSeries.push(pct(s[`top${primary}`]));
    bottomSeries.push(pct(s[`bottom${primary}`]));
    meanSeries.push(round(d.mean));
    const row: Record<string, unknown> = { variable: itemLabelOf(ds, name), n: s.n, mean: round(d.mean) };
    for (const k of boxes) { row[`top${k}`] = pct(s[`top${k}`]); row[`bottom${k}`] = pct(s[`bottom${k}`]); }
    row.net = pct((s[`top${primary}`] ?? 0) - (s[`bottom${primary}`] ?? 0));
    rows.push(row);
  }
  const columns = [{ key: "variable", label: "Item" }, { key: "n", label: "n", type: "count" as const }, { key: "mean", label: "Mean", type: "number" as const, decimals: 2 },
    ...boxes.flatMap((k) => [{ key: `top${k}`, label: `Top ${k} box %`, type: "pct" as const, decimals: 1 }, { key: `bottom${k}`, label: `Bottom ${k} box %`, type: "pct" as const, decimals: 1 }]),
    { key: "net", label: `Net (top ${primary} − bottom ${primary})`, type: "pct" as const, decimals: 1 }];
  const insights: string[] = [];
  const ranked = rows.map((r, i) => ({ label: categories[i], top: r[`top${primary}`] as number | null })).filter((r) => r.top != null).sort((a, b) => b.top! - a.top!);
  if (ranked.length) insights.push(`Highest top-${primary}-box: ${ranked[0].label} (${fmtPct(ranked[0].top, 1)})${ranked.length > 1 ? `; lowest: ${ranked[ranked.length - 1].label} (${fmtPct(ranked[ranked.length - 1].top, 1)})` : ""}.`);
  const segs = segmentDatasets(ds, def.segments).map(({ segment, data }) => ({
    name: segment.name, n: data.cases.length,
    chart: { categories, series: [{ name: `Top ${primary} box`, values: def.variables.filter((v) => scaleCodes(ds, v).length >= 2).map((v) => pct(boxShares(numericColumn(data, v), weights(data), scaleCodes(ds, v), boxes)[`top${primary}`])) }], valueFormat: "pct" as const },
  }));
  return makeResult(def, ds, {
    tables: [{ id: "topbox", title: "Top / bottom box", columns, rows, base: { n: ds.cases.length } }],
    chart: { categories, series: [{ name: `Top ${primary} box`, values: topSeries }, { name: `Bottom ${primary} box`, values: bottomSeries }, { name: "Mean", values: meanSeries, meta: { axis: "secondary" } }], valueFormat: "pct" },
    insights, warnings, recommendedCharts: ["bar_horizontal", "diverging_likert", "bar_grouped", "lollipop", "dot_plot"], segments: segs.length ? segs : undefined, totalCases,
  });
}

/* the crosstab lives in ./crosstab.ts */
export { crosstab } from "./crosstab.js";

/* ============================================================ ranking */

export function ranking(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  // variables are the VAR_<code> rank columns of one ranking question, or the question's whole battery
  const vars = expandBattery(ds, def.variables);
  const w = weights(ds);
  const rows: Record<string, unknown>[] = [];
  const nItems = vars.length;
  const dist: number[][] = [];
  for (const v of vars) {
    const vals = numericColumn(ds, v);
    const d = describe(vals, w);
    const counts = Array.from({ length: nItems }, () => 0);
    let W = 0;
    vals.forEach((x, i) => { if (x != null && x >= 1 && x <= nItems) { counts[x - 1] += w?.[i] ?? 1; W += w?.[i] ?? 1; } });
    const share = counts.map((c) => (W ? (c / W) * 100 : 0));
    // Borda-style rank score: n-items points for first place
    const score = W ? counts.reduce((t, c, i) => t + c * (nItems - i), 0) / W : 0;
    dist.push(share);
    rows.push({ item: itemLabelOf(ds, v), n: d.n, mean: round(d.mean), first: pct(share[0]), top3: pct(share.slice(0, 3).reduce((a, b) => a + b, 0)), last: pct(share[nItems - 1]), score: round(score) });
  }
  rows.sort((a, b) => ((a.mean as number) ?? 99) - ((b.mean as number) ?? 99));
  const insights = rows.length ? [`“${rows[0].item}” ranks highest on average (mean rank ${fmtNum(rows[0].mean as number, 2)}, ranked first by ${fmtPct(rows[0].first as number, 1)}); “${rows[rows.length - 1].item}” ranks lowest.`] : [];
  return makeResult(def, ds, {
    tables: [{ id: "ranking", title: "Ranking summary", columns: [{ key: "item", label: "Item" }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean rank", type: "number", decimals: 2 }, { key: "first", label: "Ranked 1st %", type: "pct", decimals: 1 }, { key: "top3", label: "Top 3 %", type: "pct", decimals: 1 }, { key: "last", label: "Ranked last %", type: "pct", decimals: 1 }, { key: "score", label: "Rank score", type: "number", decimals: 2 }], rows, base: { n: ds.cases.length }, notes: ["Rank score: Borda count (first place = number of items points), averaged."] },
      { id: "ranking_dist", title: "Rank distribution (%)", columns: [{ key: "item", label: "Item" }, ...Array.from({ length: nItems }, (_, i) => ({ key: `r${i + 1}`, label: `Rank ${i + 1}`, type: "pct" as const, decimals: 1 }))], rows: vars.map((v, i) => ({ item: itemLabelOf(ds, v), ...Object.fromEntries(dist[i].map((s, j) => [`r${j + 1}`, pct(s)])) })) }],
    chart: { categories: rows.map((r) => r.item as string), series: [{ name: "Mean rank", values: rows.map((r) => r.mean as number | null) }, { name: "Ranked 1st %", values: rows.map((r) => r.first as number | null) }], matrix: { rows: vars.map((v) => itemLabelOf(ds, v)), columns: Array.from({ length: nItems }, (_, i) => `Rank ${i + 1}`), values: dist.map((d) => d.map((x) => pct(x))) } },
    insights, recommendedCharts: ["ranking_bar", "bar_stacked_100", "rank_heatmap", "bar_horizontal", "bump"], variablesUsed: vars, totalCases,
  });
}

/* ============================================================ allocation */

export function allocation(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = expandBattery(ds, def.variables).filter((v) => !v.endsWith("_total"));
  const w = weights(ds);
  const rows = vars.map((v) => {
    const vals = numericColumn(ds, v);
    const d = describe(vals, w);
    const nonZero = vals.filter((x) => x != null && x > 0).length;
    return { item: itemLabelOf(ds, v), n: d.n, mean: round(d.mean), median: round(d.median), sd: round(d.sd), share: null as number | null, nonZero: pct(d.n ? (nonZero / d.n) * 100 : 0), min: d.min, max: d.max };
  });
  const totalMean = rows.reduce((t, r) => t + (r.mean ?? 0), 0);
  for (const r of rows) r.share = pct(totalMean ? ((r.mean ?? 0) / totalMean) * 100 : 0);
  const sorted = [...rows].sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
  const insights = sorted.length ? [`“${sorted[0].item}” receives the largest average allocation (${fmtNum(sorted[0].mean, 1)}, ${fmtPct(sorted[0].share, 1)} of the total)${sorted.length > 1 ? `; “${sorted[sorted.length - 1].item}” the smallest (${fmtNum(sorted[sorted.length - 1].mean, 1)})` : ""}.`] : [];
  return makeResult(def, ds, {
    tables: [{ id: "allocation", title: "Allocation summary", columns: [{ key: "item", label: "Item" }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean", type: "number", decimals: 1 }, { key: "median", label: "Median", type: "number", decimals: 1 }, { key: "sd", label: "SD", type: "number", decimals: 1 }, { key: "share", label: "Share of total %", type: "pct", decimals: 1 }, { key: "nonZero", label: "Allocated > 0 %", type: "pct", decimals: 1 }, { key: "min", label: "Min", type: "number" }, { key: "max", label: "Max", type: "number" }], rows, base: { n: ds.cases.length } }],
    chart: { categories: rows.map((r) => r.item), series: [{ name: "Mean allocation", values: rows.map((r) => r.mean) }], valueFormat: "number" },
    insights, recommendedCharts: ["bar_horizontal", "donut", "bar_stacked_100", "box_plot", "treemap"], variablesUsed: vars, totalCases,
  });
}

/** If a single question-level variable (e.g. the multi's `VAR`) was passed, expand to its per-item columns. */
export function expandBattery(ds: Dataset, names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const meta = ds.byName.get(n);
    const qid = meta?.questionId;
    const siblings = qid ? ds.variables.filter((v) => v.questionId === qid && (v.optionCode != null || v.rowCode != null) && !v.derived) : [];
    if (meta && (meta.optionCode != null || meta.rowCode != null)) out.push(n);
    else if (siblings.length) out.push(...siblings.map((s) => s.name));
    else out.push(n);
  }
  return [...new Set(out)];
}
