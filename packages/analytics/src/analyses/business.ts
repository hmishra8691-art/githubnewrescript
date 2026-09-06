import type { AnalysisDefinition, AnalysisResult, ChartData, ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, itemLabelOf, labelOf, numericColumn, scaleCodes, segmentDatasets, textColumn, weights, type Dataset } from "../dataset.js";
import { boxShares, describe, frequencies } from "../stats/descriptive.js";
import { correlate } from "../stats/correlation.js";
import { proportionCI, proportionTest, type TestResult } from "../stats/tests.js";
import { ols } from "../stats/regression.js";
import { fmtNum, fmtP, fmtPct, makeResult, opt, pct, round } from "./common.js";
import { expandBattery } from "./basics.js";

/* ============================================================ NPS */

export interface NpsBreakdown { n: number; promoters: number; passives: number; detractors: number; nps: number | null; ci: [number, number] | null; mean: number | null }

export function npsOf(values: (number | null)[], w?: number[]): NpsBreakdown {
  let P = 0, N = 0, D = 0, W = 0, n = 0;
  const wv: number[] = [];
  values.forEach((v, i) => { if (v == null) return; const wt = w?.[i] ?? 1; W += wt; n++; if (v >= 9) P += wt; else if (v >= 7) N += wt; else D += wt; wv.push(v >= 9 ? 100 : v >= 7 ? 0 : -100); });
  if (!W) return { n: 0, promoters: 0, passives: 0, detractors: 0, nps: null, ci: null, mean: null };
  const p = (P / W) * 100, d = (D / W) * 100, nps = p - d;
  // CI from the variance of the −100/0/100 scoring
  const sd = describe(wv).sd ?? 0;
  const se = sd / Math.sqrt(n);
  return { n, promoters: p, passives: (N / W) * 100, detractors: d, nps, ci: [nps - 1.96 * se, nps + 1.96 * se], mean: describe(values, w).mean };
}

export function nps(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const v = def.variables[0];
  if (!v) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Choose the 0–10 likelihood-to-recommend question."], recommendedCharts: ["gauge"], totalCases });
  const w = weights(ds);
  const vals = numericColumn(ds, v);
  const r = npsOf(vals, w);
  const dist = frequencies(vals.map((x) => (x == null ? null : String(x))), w, Array.from({ length: 11 }, (_, i) => ({ code: String(i), label: String(i) })));
  const tables: ResultTable[] = [
    { id: "nps", title: "Net Promoter Score", columns: [{ key: "m", label: "Metric" }, { key: "v", label: "Value", type: "number", decimals: 1 }], rows: [{ m: "NPS", v: round(r.nps, 1) }, { m: "95% CI low", v: round(r.ci?.[0], 1) }, { m: "95% CI high", v: round(r.ci?.[1], 1) }, { m: "Promoters % (9–10)", v: pct(r.promoters) }, { m: "Passives % (7–8)", v: pct(r.passives) }, { m: "Detractors % (0–6)", v: pct(r.detractors) }, { m: "Mean score", v: round(r.mean) }, { m: "n", v: r.n }], base: { n: r.n } },
    { id: "dist", title: "Score distribution", columns: [{ key: "label", label: "Score" }, { key: "count", label: "n", type: "count" }, { key: "validPct", label: "%", type: "pct", decimals: 1 }], rows: dist.rows.map((x) => ({ label: x.label, count: x.count, validPct: pct(x.validPct) })) },
  ];
  const insights = [`NPS is ${fmtNum(r.nps, 0)} (95% CI ${fmtNum(r.ci?.[0], 0)} to ${fmtNum(r.ci?.[1], 0)}): ${fmtPct(r.promoters, 0)} promoters, ${fmtPct(r.passives, 0)} passives, ${fmtPct(r.detractors, 0)} detractors (n = ${r.n}).`];
  const tests: TestResult[] = [];
  // by segment / by group
  const by = opt(def, "by", def.columns?.[0] ?? null) as string | null;
  const segRows: { name: string; n: number; chart: ChartData }[] = [];
  if (by && ds.byName.has(by)) {
    const cats = categoriesOf(ds, by), col = categoricalColumn(ds, by);
    const rows = cats.map((c) => { const idx = col.map((x, i) => (Array.isArray(x) ? x.includes(c.code) : x === c.code) ? i : -1).filter((i) => i >= 0); const rr = npsOf(idx.map((i) => vals[i]), w ? idx.map((i) => w[i]) : undefined); return { group: c.label, code: c.code, ...rr }; }).filter((x) => x.n > 0);
    tables.push({ id: "by", title: `NPS by ${labelOf(ds, by)}`, columns: [{ key: "group", label: labelOf(ds, by) }, { key: "n", label: "n", type: "count" }, { key: "nps", label: "NPS", type: "number", decimals: 1 }, { key: "promoters", label: "Promoters %", type: "pct", decimals: 1 }, { key: "passives", label: "Passives %", type: "pct", decimals: 1 }, { key: "detractors", label: "Detractors %", type: "pct", decimals: 1 }], rows: rows.map((x) => ({ group: x.group, n: x.n, nps: round(x.nps, 1), promoters: pct(x.promoters), passives: pct(x.passives), detractors: pct(x.detractors) })) });
    const sorted = [...rows].sort((a, b) => (b.nps ?? 0) - (a.nps ?? 0));
    if (sorted.length > 1) {
      insights.push(`By ${labelOf(ds, by)}: highest NPS in ${sorted[0].group} (${fmtNum(sorted[0].nps, 0)}), lowest in ${sorted[sorted.length - 1].group} (${fmtNum(sorted[sorted.length - 1].nps, 0)}).`);
      // promoter share difference between extremes
      const a = sorted[0], b = sorted[sorted.length - 1];
      const t = proportionTest(Math.round((a.promoters / 100) * a.n), a.n, Math.round((b.promoters / 100) * b.n), b.n); t.note = `Promoter share: ${a.group} vs ${b.group}`; tests.push(t);
    }
    segRows.push(...rows.map((x) => ({ name: x.group, n: x.n, chart: { kpis: [{ label: "NPS", value: round(x.nps, 0) ?? 0 }], categories: ["Promoters", "Passives", "Detractors"], series: [{ name: x.group, values: [pct(x.promoters), pct(x.passives), pct(x.detractors)] }] } })));
  }
  for (const { segment, data } of segmentDatasets(ds, def.segments)) { const rr = npsOf(numericColumn(data, v), weights(data)); segRows.push({ name: segment.name, n: rr.n, chart: { kpis: [{ label: "NPS", value: round(rr.nps, 0) ?? 0 }], categories: ["Promoters", "Passives", "Detractors"], series: [{ name: segment.name, values: [pct(rr.promoters), pct(rr.passives), pct(rr.detractors)] }] } }); }
  // trend over time
  const period = opt(def, "period", "_started_month") as string;
  const trendRows = trendSeries(ds, period, (sub) => npsOf(numericColumn(sub, v), weights(sub)).nps);
  if (trendRows.length > 1) tables.push({ id: "trend", title: "NPS over time", columns: [{ key: "period", label: "Period" }, { key: "n", label: "n", type: "count" }, { key: "value", label: "NPS", type: "number", decimals: 1 }], rows: trendRows.map((t) => ({ period: t.period, n: t.n, value: round(t.value, 1) })) });
  // drivers
  const drivers = (opt(def, "drivers", []) as string[]).filter((d) => ds.byName.has(d));
  if (drivers.length) {
    const fit = ols(vals, { predictors: drivers.map((d) => ({ name: labelOf(ds, d), values: numericColumn(ds, d) })) });
    if (!("error" in fit)) {
      const rows = fit.coefficients.slice(1).map((c) => ({ driver: c.term, beta: round(c.standardized, 3), estimate: round(c.estimate, 3), p: fmtP(c.p), r: round(correlate(numericColumn(ds, drivers[fit.coefficients.indexOf(c) - 1]), vals).r, 3) })).sort((a, b) => Math.abs(b.beta ?? 0) - Math.abs(a.beta ?? 0));
      tables.push({ id: "drivers", title: "Key drivers of recommendation", columns: [{ key: "driver", label: "Driver" }, { key: "beta", label: "Standardized β", type: "number", decimals: 3 }, { key: "r", label: "Correlation", type: "number", decimals: 3 }, { key: "estimate", label: "Estimate", type: "number", decimals: 3 }, { key: "p", label: "p-value" }], rows, notes: [`R² = ${fmtNum(fit.r2, 3)}`] });
      if (rows[0]) insights.push(`Strongest driver of likelihood to recommend: ${rows[0].driver} (β = ${fmtNum(rows[0].beta, 2)}); the drivers explain ${fmtPct(fit.r2 * 100, 0)} of the variance.`);
    }
  }
  return makeResult(def, ds, {
    tables, chart: { kpis: [{ label: "NPS", value: round(r.nps, 0) ?? 0, target: opt(def, "target", undefined) }, { label: "Promoters", value: pct(r.promoters) ?? 0, unit: "%" }, { label: "Passives", value: pct(r.passives) ?? 0, unit: "%" }, { label: "Detractors", value: pct(r.detractors) ?? 0, unit: "%" }], categories: ["Detractors (0–6)", "Passives (7–8)", "Promoters (9–10)"], series: [{ name: "Share", values: [pct(r.detractors), pct(r.passives), pct(r.promoters)] }], valueFormat: "pct", ...(trendRows.length > 1 ? { matrix: undefined } : {}), points: undefined },
    tests, insights, recommendedCharts: ["gauge", "kpi_card", "bar_stacked_100", "line", "bar_horizontal"], segments: segRows.length ? segRows : undefined, totalCases,
  });
}

/* ============================================================ CSAT / CES */

export function csat(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = def.variables.filter((v) => ds.byName.has(v));
  if (!vars.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Choose one or more satisfaction / effort scale questions."], recommendedCharts: ["gauge"], totalCases });
  const w = weights(ds);
  const kind = opt(def, "metric", "csat") as "csat" | "ces";
  const rows = vars.map((v) => {
    const codes = scaleCodes(ds, v);
    const vals = numericColumn(ds, v);
    const d = describe(vals, w);
    const top = codes.length >= 3 ? boxShares(vals, w, codes, [1, 2]) : null;
    const max = codes.length ? codes[codes.length - 1] : (d.max ?? 0);
    const min = codes.length ? codes[0] : (d.min ?? 0);
    const index = d.mean == null || max === min ? null : ((d.mean - min) / (max - min)) * 100;
    // CSAT = % satisfied (top 2 boxes); CES = % low-effort (bottom 2 boxes... conventionally high agreement "easy")
    const score = kind === "csat" ? top?.top2 ?? null : top?.top2 ?? null;
    return { item: labelOf(ds, v), n: d.n, mean: round(d.mean), index: pct(index), score: pct(score), top1: pct(top?.top1), bottom2: pct(top?.bottom2), ci: d.ci95 };
  });
  const primary = rows[0];
  const insights = [`${kind.toUpperCase()} for ${primary.item}: ${fmtPct(primary.score, 0)} ${kind === "csat" ? "satisfied (top-2 box)" : "agree it was easy (top-2 box)"}; mean ${fmtNum(primary.mean, 2)} (index ${fmtNum(primary.index, 0)}/100, n = ${primary.n}).`];
  if (rows.length > 1) { const s = [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)); insights.push(`Highest: ${s[0].item} (${fmtPct(s[0].score, 0)}); lowest: ${s[s.length - 1].item} (${fmtPct(s[s.length - 1].score, 0)}).`); }
  const tables: ResultTable[] = [{ id: "csat", title: kind === "csat" ? "Customer satisfaction" : "Customer effort", columns: [{ key: "item", label: "Item" }, { key: "n", label: "n", type: "count" }, { key: "score", label: kind === "csat" ? "Satisfied % (top 2)" : "Easy % (top 2)", type: "pct", decimals: 1 }, { key: "top1", label: "Top box %", type: "pct", decimals: 1 }, { key: "bottom2", label: "Bottom 2 %", type: "pct", decimals: 1 }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "index", label: "Index (0–100)", type: "number", decimals: 0 }], rows: rows.map(({ ci, ...r }) => r), base: { n: ds.cases.length } }];
  const by = opt(def, "by", def.columns?.[0] ?? null) as string | null;
  const segRows: { name: string; n: number; chart: ChartData }[] = [];
  if (by && ds.byName.has(by)) {
    const cats = categoriesOf(ds, by), col = categoricalColumn(ds, by), v = vars[0], codes = scaleCodes(ds, v), vals = numericColumn(ds, v);
    const byRows = cats.map((c) => { const idx = col.map((x, i) => (Array.isArray(x) ? x.includes(c.code) : x === c.code) ? i : -1).filter((i) => i >= 0); const sub = idx.map((i) => vals[i]); const sw = w ? idx.map((i) => w[i]) : undefined; const b = codes.length >= 3 ? boxShares(sub, sw, codes, [1, 2]) : null; const d = describe(sub, sw); return { group: c.label, n: d.n, score: pct(b?.top2), mean: round(d.mean) }; }).filter((x) => x.n > 0);
    tables.push({ id: "by", title: `${kind.toUpperCase()} by ${labelOf(ds, by)}`, columns: [{ key: "group", label: labelOf(ds, by) }, { key: "n", label: "n", type: "count" }, { key: "score", label: "Top-2 %", type: "pct", decimals: 1 }, { key: "mean", label: "Mean", type: "number", decimals: 2 }], rows: byRows });
    segRows.push(...byRows.map((x) => ({ name: x.group, n: x.n, chart: { kpis: [{ label: kind.toUpperCase(), value: x.score ?? 0, unit: "%" }] } })));
  }
  const period = opt(def, "period", "_started_month") as string;
  const tr = trendSeries(ds, period, (sub) => { const codes = scaleCodes(ds, vars[0]); return codes.length >= 3 ? boxShares(numericColumn(sub, vars[0]), weights(sub), codes, [2]).top2 ?? null : describe(numericColumn(sub, vars[0]), weights(sub)).mean; });
  if (tr.length > 1) tables.push({ id: "trend", title: `${kind.toUpperCase()} over time`, columns: [{ key: "period", label: "Period" }, { key: "n", label: "n", type: "count" }, { key: "value", label: "Score", type: "number", decimals: 1 }], rows: tr.map((t) => ({ period: t.period, n: t.n, value: round(t.value, 1) })) });
  const drivers = (opt(def, "drivers", []) as string[]).filter((d) => ds.byName.has(d));
  if (drivers.length) {
    const y = numericColumn(ds, vars[0]);
    const fit = ols(y, { predictors: drivers.map((d) => ({ name: labelOf(ds, d), values: numericColumn(ds, d) })) });
    if (!("error" in fit)) {
      const drows = fit.coefficients.slice(1).map((c) => ({ driver: c.term, beta: round(c.standardized, 3), p: fmtP(c.p) })).sort((a, b) => Math.abs(b.beta ?? 0) - Math.abs(a.beta ?? 0));
      tables.push({ id: "drivers", title: "Key drivers", columns: [{ key: "driver", label: "Driver" }, { key: "beta", label: "Standardized β", type: "number", decimals: 3 }, { key: "p", label: "p-value" }], rows: drows, notes: [`R² = ${fmtNum(fit.r2, 3)}`] });
      if (drows[0]) insights.push(`Strongest driver: ${drows[0].driver} (β = ${fmtNum(drows[0].beta, 2)}).`);
    }
  }
  return makeResult(def, ds, {
    tables, chart: { kpis: rows.map((r) => ({ label: r.item, value: r.score ?? 0, unit: "%", target: opt(def, "target", undefined) })), categories: rows.map((r) => r.item), series: [{ name: kind === "csat" ? "Satisfied %" : "Easy %", values: rows.map((r) => r.score) }, { name: "Mean", values: rows.map((r) => r.mean), ci: rows.map((r) => (r.ci ? [round(r.ci[0])!, round(r.ci[1])!] : null)), meta: { axis: "secondary" } }], valueFormat: "pct" },
    insights, recommendedCharts: ["gauge", "kpi_card", "bar_horizontal", "diverging_likert", "line"], segments: segRows.length ? segRows : undefined, variablesUsed: vars, totalCases,
  });
}

/* ============================================================ trend */

function trendSeries(ds: Dataset, period: string, metric: (sub: Dataset) => number | null): { period: string; n: number; value: number | null }[] {
  const groups = new Map<string, typeof ds.cases>();
  for (const c of ds.cases) { const k = c.vars[period]; if (k == null) continue; const key = String(k); groups.set(key, [...(groups.get(key) ?? []), c]); }
  return [...groups.keys()].sort().map((k) => { const sub = { ...ds, cases: groups.get(k)! }; return { period: k, n: sub.cases.length, value: metric(sub) }; });
}

export function trend(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const period = opt(def, "period", def.columns?.[0] ?? "_started_month") as string;
  const metric = opt(def, "metric", "mean") as "mean" | "pct" | "count" | "nps" | "top2";
  const window = opt(def, "rolling", 0) as number;
  const target = String(opt(def, "category", ""));
  const vars = def.variables.filter((v) => ds.byName.has(v));
  const series: NonNullable<ChartData["series"]> = [];
  const tables: ResultTable[] = [];
  const insights: string[] = [];
  let periods: string[] = [];
  const baseSeries = trendSeries(ds, period, (sub) => sub.cases.length);
  periods = baseSeries.map((b) => b.period);
  if (!vars.length || metric === "count") {
    series.push({ name: "Responses", values: baseSeries.map((b) => b.n) });
    tables.push({ id: "trend", title: `Responses by ${labelOf(ds, period)}`, columns: [{ key: "period", label: "Period" }, { key: "n", label: "Responses", type: "count" }], rows: baseSeries.map((b) => ({ period: b.period, n: b.n })) });
  } else {
    for (const v of vars) {
      const codes = scaleCodes(ds, v);
      const rows = trendSeries(ds, period, (sub) => {
        const vals = numericColumn(sub, v), w = weights(sub);
        if (metric === "nps") return npsOf(vals, w).nps;
        if (metric === "top2") return codes.length >= 3 ? boxShares(vals, w, codes, [2]).top2 ?? null : null;
        if (metric === "pct") { const f = frequencies(categoricalColumn(sub, v), w, categoriesOf(ds, v)); return f.rows.find((r) => r.code === (target || f.rows[0]?.code))?.validPct ?? null; }
        return describe(vals, w).mean;
      });
      const values = rows.map((r) => round(r.value, 2));
      series.push({ name: labelOf(ds, v), values });
      if (window > 1) series.push({ name: `${labelOf(ds, v)} (${window}-period avg)`, values: rolling(values, window), meta: { dashed: true } });
      tables.push({ id: `trend_${v}`, title: `${labelOf(ds, v)} — ${metricLabel(metric, target)} by ${labelOf(ds, period)}`, columns: [{ key: "period", label: "Period" }, { key: "n", label: "n", type: "count" }, { key: "value", label: metricLabel(metric, target), type: "number", decimals: 2 }, { key: "change", label: "Change vs previous", type: "number", decimals: 2 }, { key: "vsFirst", label: "Change vs first", type: "number", decimals: 2 }], rows: rows.map((r, i) => ({ period: r.period, n: r.n, value: round(r.value, 2), change: i > 0 && r.value != null && rows[i - 1].value != null ? round(r.value - rows[i - 1].value!, 2) : null, vsFirst: i > 0 && r.value != null && rows[0].value != null ? round(r.value - rows[0].value!, 2) : null })) });
      const first = rows.find((r) => r.value != null), last = [...rows].reverse().find((r) => r.value != null);
      if (first && last && first !== last) { const diff = last.value! - first.value!; insights.push(`${labelOf(ds, v)} moved from ${fmtNum(first.value, 1)} (${first.period}) to ${fmtNum(last.value, 1)} (${last.period}) — ${diff > 0 ? "up" : diff < 0 ? "down" : "flat"}${diff ? ` ${fmtNum(Math.abs(diff), 1)} points` : ""} across ${rows.length} periods.`); }
      const slope = ols(rows.map((r) => r.value), { predictors: [{ name: "t", values: rows.map((_, i) => i) }] });
      if (!("error" in slope) && rows.length >= 4) insights.push(`Linear trend for ${labelOf(ds, v)}: ${fmtNum(slope.coefficients[1].estimate, 2)} per period (p ${fmtP(slope.coefficients[1].p)}) — ${slope.coefficients[1].p != null && slope.coefficients[1].p < 0.05 ? "a significant trend" : "no significant trend"}.`);
    }
  }
  const baseline = opt(def, "baseline", null) as number | null;
  return makeResult(def, ds, {
    tables, chart: { categories: periods, series, valueFormat: metric === "pct" || metric === "top2" ? "pct" : "number" }, insights,
    warnings: periods.length < 2 ? ["Only one period in the data — a trend needs at least two."] : baseSeries.some((b) => b.n < 30) ? ["Some periods have fewer than 30 responses."] : [],
    recommendedCharts: ["line", "line_multi", "area", "rolling_average", "wave_trend", "bar_vertical"], variablesUsed: [...vars, period], totalCases,
    ...(baseline != null ? {} : {}),
  });
}

function rolling(values: (number | null)[], k: number): (number | null)[] {
  return values.map((_, i) => { const win = values.slice(Math.max(0, i - k + 1), i + 1).filter((x): x is number => x != null); return win.length === k ? round(win.reduce((a, b) => a + b, 0) / k, 2) : null; });
}
function metricLabel(m: string, target: string): string { return m === "nps" ? "NPS" : m === "top2" ? "Top-2 box %" : m === "pct" ? `% ${target || "selected"}` : m === "count" ? "Responses" : "Mean"; }

/* ============================================================ TURF */

export function turf(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const items = expandBattery(ds, def.variables);
  const maxSize = Math.min(opt(def, "maxSize", 5) as number, items.length);
  const w = weights(ds);
  const n = ds.cases.length;
  const W = w ? w.reduce((a, b) => a + b, 0) : n;
  if (items.length < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["TURF needs a multi-select question or several 0/1 items."], recommendedCharts: ["bar_horizontal"], totalCases });
  // reach matrix: case × item
  const cols = items.map((v) => numericColumn(ds, v).map((x) => (x != null && x > 0 ? 1 : 0)));
  const reachOf = (set: number[]) => { let r = 0, f = 0; for (let i = 0; i < n; i++) { let hit = 0; for (const j of set) hit += cols[j][i]; if (hit) { r += w?.[i] ?? 1; f += hit * (w?.[i] ?? 1); } } return { reach: (r / W) * 100, frequency: r ? f / r : 0 }; };
  const single = items.map((v, j) => ({ item: itemLabelOf(ds, v), j, reach: reachOf([j]).reach }));
  // greedy forward selection + exhaustive best for small k
  const best: { size: number; items: string[]; reach: number; frequency: number; incremental: number }[] = [];
  const chosen: number[] = [];
  let prev = 0;
  for (let k = 1; k <= maxSize; k++) {
    let cand: number[] | null = null, candReach = -1, candFreq = 0;
    if (items.length <= 12) {
      for (const combo of combinations(items.length, k)) { const r = reachOf(combo); if (r.reach > candReach) { candReach = r.reach; cand = combo; candFreq = r.frequency; } }
    } else {
      for (let j = 0; j < items.length; j++) { if (chosen.includes(j)) continue; const r = reachOf([...chosen, j]); if (r.reach > candReach) { candReach = r.reach; cand = [...chosen, j]; candFreq = r.frequency; } }
    }
    if (!cand) break;
    chosen.splice(0, chosen.length, ...cand);
    best.push({ size: k, items: cand.map((j) => itemLabelOf(ds, items[j])), reach: candReach, frequency: candFreq, incremental: candReach - prev });
    prev = candReach;
  }
  // incremental order (greedy path) for the chart
  const greedy: { item: string; reach: number; incremental: number }[] = [];
  const g: number[] = []; let gp = 0;
  for (let k = 0; k < maxSize; k++) { let bj = -1, br = -1; for (let j = 0; j < items.length; j++) { if (g.includes(j)) continue; const r = reachOf([...g, j]).reach; if (r > br) { br = r; bj = j; } } if (bj < 0) break; g.push(bj); greedy.push({ item: itemLabelOf(ds, items[bj]), reach: br, incremental: br - gp }); gp = br; }
  const insights = [`The best ${maxSize}-item combination reaches ${fmtPct(best[best.length - 1]?.reach, 1)} of respondents (${best[best.length - 1]?.items.join(", ")}).`, `The single best item is “${single.slice().sort((a, b) => b.reach - a.reach)[0].item}” (${fmtPct(Math.max(...single.map((s) => s.reach)), 1)}); adding “${greedy[1]?.item ?? "—"}” contributes the most incremental reach (+${fmtNum(greedy[1]?.incremental, 1)} points).`];
  const dim = best.findIndex((b) => b.incremental < 2);
  if (dim > 0) insights.push(`Returns diminish after ${dim} item${dim === 1 ? "" : "s"} — each further item adds under 2 points of reach.`);
  return makeResult(def, ds, {
    tables: [{ id: "turf", title: "Best combinations by size", columns: [{ key: "size", label: "Items" }, { key: "items", label: "Combination" }, { key: "reach", label: "Reach %", type: "pct", decimals: 1 }, { key: "frequency", label: "Frequency", type: "number", decimals: 2 }, { key: "incremental", label: "Incremental reach", type: "pct", decimals: 1 }], rows: best.map((b) => ({ ...b, items: b.items.join(" + "), reach: pct(b.reach), frequency: round(b.frequency), incremental: pct(b.incremental) })), base: { n } },
      { id: "single", title: "Reach by item", columns: [{ key: "item", label: "Item" }, { key: "reach", label: "Reach %", type: "pct", decimals: 1 }], rows: single.sort((a, b) => b.reach - a.reach).map((s) => ({ item: s.item, reach: pct(s.reach) })) },
      { id: "greedy", title: "Incremental reach (greedy order)", columns: [{ key: "step", label: "Step" }, { key: "item", label: "Item added" }, { key: "reach", label: "Cumulative reach %", type: "pct", decimals: 1 }, { key: "incremental", label: "Incremental", type: "pct", decimals: 1 }], rows: greedy.map((x, i) => ({ step: i + 1, item: x.item, reach: pct(x.reach), incremental: pct(x.incremental) })) }],
    chart: { categories: greedy.map((x) => x.item), series: [{ name: "Cumulative reach", values: greedy.map((x) => pct(x.reach)) }, { name: "Incremental", values: greedy.map((x) => pct(x.incremental)) }], valueFormat: "pct" },
    insights, recommendedCharts: ["waterfall", "bar_vertical", "line", "bar_horizontal"], variablesUsed: items, totalCases,
  });
}

function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return;
  while (true) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/* ============================================================ GAP / IPA */

export function gap(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const importance = expandBattery(ds, (opt(def, "importance", []) as string[]).length ? (opt(def, "importance", []) as string[]) : def.variables.slice(0, Math.ceil(def.variables.length / 2)));
  const performance = expandBattery(ds, (opt(def, "performance", []) as string[]).length ? (opt(def, "performance", []) as string[]) : def.variables.slice(Math.ceil(def.variables.length / 2)));
  const w = weights(ds);
  const k = Math.min(importance.length, performance.length);
  if (k < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Importance-performance analysis needs matched importance and performance items (at least two pairs)."], recommendedCharts: ["scatter"], totalCases });
  const rows = Array.from({ length: k }, (_, i) => {
    const imp = describe(numericColumn(ds, importance[i]), w), perf = describe(numericColumn(ds, performance[i]), w);
    const label = ds.byName.get(performance[i])?.categories && ds.byName.get(performance[i])?.rowCode ? itemLabelOf(ds, performance[i]).replace(/^.*—\s*/, "") : itemLabelOf(ds, performance[i]);
    return { attribute: label, importance: imp.mean, performance: perf.mean, gap: imp.mean != null && perf.mean != null ? perf.mean - imp.mean : null, n: Math.min(imp.n, perf.n), opportunity: imp.mean != null && perf.mean != null ? imp.mean + Math.max(imp.mean - perf.mean, 0) : null };
  });
  const mi = rows.reduce((t, r) => t + (r.importance ?? 0), 0) / k, mp = rows.reduce((t, r) => t + (r.performance ?? 0), 0) / k;
  const quadrant = (r: typeof rows[number]) => (r.importance ?? 0) >= mi ? ((r.performance ?? 0) >= mp ? "Keep up the good work" : "Concentrate here") : (r.performance ?? 0) >= mp ? "Possible overkill" : "Low priority";
  const out = rows.map((r) => ({ ...r, quadrant: quadrant(r) })).sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0));
  const focus = out.filter((r) => r.quadrant === "Concentrate here");
  const insights = [`Largest negative gap (importance exceeds performance): ${out[0].attribute} (${fmtNum(out[0].gap, 2)}).`, focus.length ? `Priorities to concentrate on (high importance, below-average performance): ${focus.map((f) => f.attribute).join(", ")}.` : "No attribute falls in the “concentrate here” quadrant."];
  return makeResult(def, ds, {
    tables: [{ id: "ipa", title: "Importance × performance", columns: [{ key: "attribute", label: "Attribute" }, { key: "n", label: "n", type: "count" }, { key: "importance", label: "Importance (mean)", type: "number", decimals: 2 }, { key: "performance", label: "Performance (mean)", type: "number", decimals: 2 }, { key: "gap", label: "Gap (perf − imp)", type: "number", decimals: 2 }, { key: "opportunity", label: "Opportunity score", type: "number", decimals: 2 }, { key: "quadrant", label: "Quadrant" }], rows: out.map((r) => ({ ...r, importance: round(r.importance), performance: round(r.performance), gap: round(r.gap), opportunity: round(r.opportunity) })), notes: [`Quadrants split at mean importance ${fmtNum(mi, 2)} and mean performance ${fmtNum(mp, 2)}. Opportunity = importance + max(importance − performance, 0).`] }],
    chart: { points: out.map((r) => ({ x: r.importance ?? 0, y: r.performance ?? 0, label: r.attribute, group: r.quadrant })), categories: out.map((r) => r.attribute), series: [{ name: "Importance", values: out.map((r) => round(r.importance)) }, { name: "Performance", values: out.map((r) => round(r.performance)) }, { name: "Gap", values: out.map((r) => round(r.gap)) }], kpis: [{ label: "Mean importance", value: round(mi) ?? 0 }, { label: "Mean performance", value: round(mp) ?? 0 }] },
    insights, recommendedCharts: ["heatmap_ipa", "scatter", "bar_grouped", "dot_plot", "bar_horizontal"], variablesUsed: [...importance.slice(0, k), ...performance.slice(0, k)], totalCases,
  });
}

/* ============================================================ pricing */

export function pricing(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const method = opt(def, "method", "van_westendorp") as "van_westendorp" | "gabor_granger";
  const w = weights(ds);
  if (method === "gabor_granger") {
    // variables: purchase-intent items at ascending price points; options.prices: number[]; options.acceptCodes: codes counted as "would buy"
    const items = expandBattery(ds, def.variables);
    const prices = (opt(def, "prices", []) as number[]).length ? (opt(def, "prices", []) as number[]) : items.map((_, i) => i + 1);
    const accept = (opt(def, "acceptCodes", []) as (string | number)[]).map(String);
    const rows = items.map((v, i) => {
      const col = categoricalColumn(ds, v);
      let W = 0, yes = 0;
      col.forEach((x, j) => { if (x == null) return; const wt = w?.[j] ?? 1; W += wt; const codes = Array.isArray(x) ? x : [x]; const ok = accept.length ? codes.some((c) => accept.includes(c)) : codes.some((c) => Number(c) >= 4 || c === "1" || c.toLowerCase() === "yes"); if (ok) yes += wt; });
      const p = W ? (yes / W) * 100 : 0;
      return { price: prices[i], label: labelOf(ds, v), n: Math.round(W), probability: p, revenue: (p / 100) * prices[i] };
    }).sort((a, b) => a.price - b.price);
    const rev = [...rows].sort((a, b) => b.revenue - a.revenue)[0];
    const elastic = rows.slice(1).map((r, i) => { const p0 = rows[i]; const dq = (r.probability - p0.probability) / ((r.probability + p0.probability) / 2), dp = (r.price - p0.price) / ((r.price + p0.price) / 2); return { from: p0.price, to: r.price, elasticity: dp ? dq / dp : null }; });
    const insights = [`Revenue-maximising price point: ${fmtNum(rev.price, 2)} (${fmtPct(rev.probability, 0)} would buy, revenue index ${fmtNum(rev.revenue, 2)}).`, `Purchase probability falls from ${fmtPct(rows[0]?.probability, 0)} at ${fmtNum(rows[0]?.price, 2)} to ${fmtPct(rows[rows.length - 1]?.probability, 0)} at ${fmtNum(rows[rows.length - 1]?.price, 2)}.`];
    const steep = elastic.filter((e) => e.elasticity != null).sort((a, b) => a.elasticity! - b.elasticity!)[0];
    if (steep) insights.push(`Demand is most elastic between ${fmtNum(steep.from, 2)} and ${fmtNum(steep.to, 2)} (elasticity ${fmtNum(steep.elasticity, 2)}).`);
    return makeResult(def, ds, {
      tables: [{ id: "gg", title: "Gabor-Granger demand", columns: [{ key: "price", label: "Price", type: "number", decimals: 2 }, { key: "n", label: "n", type: "count" }, { key: "probability", label: "Would buy %", type: "pct", decimals: 1 }, { key: "revenue", label: "Revenue index", type: "number", decimals: 2 }], rows: rows.map((r) => ({ ...r, probability: pct(r.probability), revenue: round(r.revenue) })) },
        { id: "elasticity", title: "Price elasticity between points", columns: [{ key: "from", label: "From", type: "number", decimals: 2 }, { key: "to", label: "To", type: "number", decimals: 2 }, { key: "elasticity", label: "Arc elasticity", type: "number", decimals: 2 }], rows: elastic.map((e) => ({ ...e, elasticity: round(e.elasticity) })) }],
      chart: { categories: rows.map((r) => String(r.price)), series: [{ name: "Purchase probability %", values: rows.map((r) => pct(r.probability)) }, { name: "Revenue index", values: rows.map((r) => round(r.revenue)), meta: { axis: "secondary" } }], points: rows.map((r) => ({ x: r.price, y: r.probability, label: String(r.price) })) },
      insights, recommendedCharts: ["demand_curve", "revenue_curve", "purchase_probability", "price_elasticity", "line"], variablesUsed: items, totalCases,
    });
  }
  // Van Westendorp: four price questions — too cheap, cheap (bargain), expensive, too expensive
  const [tooCheap, cheap, expensive, tooExpensive] = [opt(def, "tooCheap", def.variables[0]), opt(def, "cheap", def.variables[1]), opt(def, "expensive", def.variables[2]), opt(def, "tooExpensive", def.variables[3])] as string[];
  if (!tooCheap || !cheap || !expensive || !tooExpensive) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Van Westendorp needs the four price questions: too cheap, bargain, expensive, too expensive."], recommendedCharts: ["price_sensitivity"], totalCases });
  const cols = { tooCheap: numericColumn(ds, tooCheap), cheap: numericColumn(ds, cheap), expensive: numericColumn(ds, expensive), tooExpensive: numericColumn(ds, tooExpensive) };
  const keep = cols.tooCheap.map((_, i) => i).filter((i) => cols.tooCheap[i] != null && cols.cheap[i] != null && cols.expensive[i] != null && cols.tooExpensive[i] != null && cols.tooCheap[i]! <= cols.cheap[i]! && cols.expensive[i]! <= cols.tooExpensive[i]!);
  const dropped = cols.tooCheap.filter((x) => x != null).length - keep.length;
  const all = keep.flatMap((i) => [cols.tooCheap[i]!, cols.cheap[i]!, cols.expensive[i]!, cols.tooExpensive[i]!]);
  const grid = [...new Set(all)].sort((a, b) => a - b);
  const W = keep.reduce((t, i) => t + (w?.[i] ?? 1), 0) || 1;
  const cum = (vals: (number | null)[], p: number, dir: "le" | "ge") => keep.reduce((t, i) => t + ((dir === "le" ? vals[i]! <= p : vals[i]! >= p) ? (w?.[i] ?? 1) : 0), 0) / W * 100;
  const curves = grid.map((p) => ({ price: p, tooCheap: cum(cols.tooCheap, p, "ge"), cheap: cum(cols.cheap, p, "ge"), expensive: cum(cols.expensive, p, "le"), tooExpensive: cum(cols.tooExpensive, p, "le") }));
  // "not cheap" = 100 - cheap ; "not expensive" = 100 - expensive
  const cross = (a: (c: typeof curves[number]) => number, b: (c: typeof curves[number]) => number) => {
    for (let i = 1; i < curves.length; i++) { const d0 = a(curves[i - 1]) - b(curves[i - 1]), d1 = a(curves[i]) - b(curves[i]); if (d0 === 0) return curves[i - 1].price; if (d0 * d1 < 0) { const t = d0 / (d0 - d1); return curves[i - 1].price + t * (curves[i].price - curves[i - 1].price); } }
    return null;
  };
  const pmc = cross((c) => c.tooCheap, (c) => c.expensive);           // point of marginal cheapness: too cheap ∩ not cheap(=expensive)
  const pme = cross((c) => c.cheap, (c) => c.tooExpensive);           // point of marginal expensiveness: not expensive(=cheap) ∩ too expensive
  const opp = cross((c) => c.tooCheap, (c) => c.tooExpensive);        // optimal price point
  const ipp = cross((c) => c.cheap, (c) => c.expensive);              // indifference price point
  const insights = [`Acceptable price range: ${fmtNum(pmc, 2)} (point of marginal cheapness) to ${fmtNum(pme, 2)} (point of marginal expensiveness).`, `Optimal price point ${fmtNum(opp, 2)}; indifference price point ${fmtNum(ipp, 2)} (n = ${keep.length}${dropped ? `, ${dropped} inconsistent responses excluded` : ""}).`];
  return makeResult(def, ds, {
    tables: [{ id: "vw", title: "Van Westendorp price points", columns: [{ key: "m", label: "Price point" }, { key: "v", label: "Value", type: "number", decimals: 2 }], rows: [{ m: "Point of marginal cheapness (PMC)", v: round(pmc) }, { m: "Optimal price point (OPP)", v: round(opp) }, { m: "Indifference price point (IPP)", v: round(ipp) }, { m: "Point of marginal expensiveness (PME)", v: round(pme) }, { m: "Valid respondents", v: keep.length }], base: { n: keep.length } },
      { id: "curves", title: "Cumulative price curves (%)", columns: [{ key: "price", label: "Price", type: "number", decimals: 2 }, { key: "tooCheap", label: "Too cheap", type: "pct", decimals: 1 }, { key: "cheap", label: "Cheap / bargain", type: "pct", decimals: 1 }, { key: "expensive", label: "Expensive", type: "pct", decimals: 1 }, { key: "tooExpensive", label: "Too expensive", type: "pct", decimals: 1 }], rows: curves.map((c) => ({ price: c.price, tooCheap: pct(c.tooCheap), cheap: pct(c.cheap), expensive: pct(c.expensive), tooExpensive: pct(c.tooExpensive) })) }],
    chart: { categories: curves.map((c) => String(c.price)), series: [{ name: "Too cheap", values: curves.map((c) => pct(c.tooCheap)) }, { name: "Cheap", values: curves.map((c) => pct(c.cheap)) }, { name: "Expensive", values: curves.map((c) => pct(c.expensive)) }, { name: "Too expensive", values: curves.map((c) => pct(c.tooExpensive)) }], kpis: [{ label: "PMC", value: round(pmc) ?? 0 }, { label: "OPP", value: round(opp) ?? 0 }, { label: "IPP", value: round(ipp) ?? 0 }, { label: "PME", value: round(pme) ?? 0 }], valueFormat: "pct" },
    insights, warnings: dropped ? [`${dropped} respondents gave inconsistent price answers and were excluded.`] : [], recommendedCharts: ["price_sensitivity", "line_multi", "kpi_card"], variablesUsed: [tooCheap, cheap, expensive, tooExpensive], totalCases,
  });
}

/* ============================================================ brand funnel */

export function brand(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  // options.stages: [{name, variable}] — each a multi-select over the same brand code frame (or 0/1 flags per brand)
  const stages = (opt(def, "stages", []) as { name: string; variable: string }[]).filter((s) => ds.byName.has(s.variable));
  const fallback = def.variables.filter((v) => ds.byName.has(v)).map((v, i) => ({ name: ["Awareness", "Familiarity", "Consideration", "Trial", "Usage", "Preference", "Loyalty"][i] ?? labelOf(ds, v), variable: v }));
  const st = stages.length ? stages : fallback;
  if (st.length < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["A brand funnel needs at least two stages (e.g. awareness and consideration) over the same brand list."], recommendedCharts: ["funnel_brand"], totalCases });
  const w = weights(ds);
  const brands = categoriesOf(ds, st[0].variable);
  const n = ds.cases.length, W = w ? w.reduce((a, b) => a + b, 0) : n;
  const share = (v: string, code: string) => { const col = categoricalColumn(ds, v); let s = 0; col.forEach((x, i) => { if (x == null) return; if ((Array.isArray(x) ? x : [x]).includes(code)) s += w?.[i] ?? 1; }); return W ? (s / W) * 100 : 0; };
  const matrix = brands.map((b) => st.map((s) => share(s.variable, b.code)));
  const rows = brands.map((b, i) => { const row: Record<string, unknown> = { brand: b.label }; st.forEach((s, j) => { row[`s${j}`] = pct(matrix[i][j]); if (j > 0) row[`c${j}`] = pct(matrix[i][j - 1] ? (matrix[i][j] / matrix[i][j - 1]) * 100 : 0); }); return row; });
  const columns = [{ key: "brand", label: "Brand" }, ...st.flatMap((s, j) => [{ key: `s${j}`, label: `${s.name} %`, type: "pct" as const, decimals: 1 }, ...(j > 0 ? [{ key: `c${j}`, label: `${st[j - 1].name} → ${s.name} conversion %`, type: "pct" as const, decimals: 1 }] : [])])];
  const leader = brands.map((b, i) => ({ b: b.label, v: matrix[i][st.length - 1], top: matrix[i][0] })).sort((a, b) => b.v - a.v);
  const insights = [`${leader[0].b} leads at the ${st[st.length - 1].name.toLowerCase()} stage (${fmtPct(leader[0].v, 0)}); ${[...leader].sort((a, b) => b.top - a.top)[0].b} has the highest ${st[0].name.toLowerCase()} (${fmtPct(Math.max(...leader.map((l) => l.top)), 0)}).`];
  const weakest = brands.map((b, i) => { let worst = { j: 1, c: 101 }; for (let j = 1; j < st.length; j++) { const c = matrix[i][j - 1] ? (matrix[i][j] / matrix[i][j - 1]) * 100 : 0; if (c < worst.c) worst = { j, c }; } return { b: b.label, ...worst }; });
  const wk = weakest.sort((a, b) => a.c - b.c)[0];
  if (wk) insights.push(`Largest funnel leak: ${wk.b} converts only ${fmtPct(wk.c, 0)} from ${st[wk.j - 1].name.toLowerCase()} to ${st[wk.j].name.toLowerCase()}.`);
  // brand image / equity attributes optional
  const image = (opt(def, "image", []) as string[]).filter((v) => ds.byName.has(v));
  const tables: ResultTable[] = [{ id: "funnel", title: "Brand funnel", columns, rows, base: { n } }];
  if (image.length) {
    const img = brands.map((b) => ({ brand: b.label, ...Object.fromEntries(image.map((v) => [v, pct(share(v, b.code))])) }));
    tables.push({ id: "image", title: "Brand image (% associating)", columns: [{ key: "brand", label: "Brand" }, ...image.map((v) => ({ key: v, label: labelOf(ds, v), type: "pct" as const, decimals: 1 }))], rows: img });
  }
  return makeResult(def, ds, {
    tables, chart: { categories: st.map((s) => s.name), series: brands.map((b, i) => ({ name: b.label, values: matrix[i].map((x) => pct(x)) })), matrix: { rows: brands.map((b) => b.label), columns: st.map((s) => s.name), values: matrix.map((r) => r.map((x) => pct(x))) }, valueFormat: "pct" },
    insights, recommendedCharts: ["funnel_brand", "bar_grouped", "heatmap", "radar_brand", "line_multi"], variablesUsed: st.map((s) => s.variable), totalCases,
  });
}

/* ============================================================ text analytics */

const STOP = new Set("a an the and or but if then so of to in on at for from by with about as into like through after over between out against during without before under around among is are was were be been being am do does did have has had having i me my we our you your he she it its they them their this that these those there here what which who whom whose not no nor very can will just should would could also than too more most some any all each other such only own same s t don ve ll re d m up down off again further once because while where when how why both few many much".split(" "));
const POS = new Set("good great excellent love loved amazing awesome fantastic wonderful happy satisfied easy helpful best better nice friendly fast quick perfect pleased recommend reliable quality enjoy enjoyed clear simple convenient smooth positive impressed thanks thank".split(" "));
const NEG = new Set("bad poor terrible awful hate hated worst worse slow difficult hard confusing expensive problem problems issue issues broken disappointed disappointing frustrating frustrated annoying rude unhelpful useless waste never wrong error errors fail failed complicated late delay delayed cheap ugly dislike negative unhappy".split(" "));

export function tokenize(s: string): string[] { return s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).map((t) => t.replace(/^['-]+|['-]+$/g, "")).filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)); }

export function sentimentOf(tokens: string[]): number { let s = 0; for (let i = 0; i < tokens.length; i++) { const neg = i > 0 && ["not", "no", "never", "dont", "don't", "isnt", "wasnt"].includes(tokens[i - 1]); if (POS.has(tokens[i])) s += neg ? -1 : 1; else if (NEG.has(tokens[i])) s += neg ? 1 : -1; } return s; }

export function text(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const v = def.variables.find((x) => ds.byName.get(x)?.role === "text") ?? def.variables[0];
  if (!v) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Choose an open-ended text question."], recommendedCharts: ["word_cloud"], totalCases });
  const col = textColumn(ds, v);
  const w = weights(ds);
  const frame = (opt(def, "themes", []) as { name: string; keywords: string[] }[]);
  const topN = opt(def, "topN", 30) as number;
  const words = new Map<string, number>(), bigrams = new Map<string, number>();
  let answered = 0, pos = 0, neg = 0, neu = 0, totalLen = 0;
  const themeHits = new Map<string, number>(frame.map((t) => [t.name, 0]));
  const perCase: { i: number; sent: number; themes: string[] }[] = [];
  col.forEach((t, i) => {
    if (!t || !t.trim()) return;
    answered++;
    const wt = w?.[i] ?? 1;
    const toks = tokenize(t);
    totalLen += t.trim().split(/\s+/).length;
    for (const tk of toks) words.set(tk, (words.get(tk) ?? 0) + wt);
    for (let k = 1; k < toks.length; k++) { const bg = `${toks[k - 1]} ${toks[k]}`; bigrams.set(bg, (bigrams.get(bg) ?? 0) + wt); }
    const s = sentimentOf(toks);
    if (s > 0) pos += wt; else if (s < 0) neg += wt; else neu += wt;
    const lower = t.toLowerCase();
    const themes = frame.filter((th) => th.keywords.some((k) => lower.includes(k.toLowerCase()))).map((th) => th.name);
    for (const th of themes) themeHits.set(th, (themeHits.get(th) ?? 0) + wt);
    perCase.push({ i, sent: s, themes });
  });
  const totalW = pos + neg + neu || 1;
  const topWords = [...words].sort((a, b) => b[1] - a[1]).slice(0, topN);
  const topBigrams = [...bigrams].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const tables: ResultTable[] = [
    { id: "summary", title: "Text summary", columns: [{ key: "m", label: "Metric" }, { key: "v", label: "Value" }], rows: [{ m: "Responses with text", v: answered }, { m: "Response rate", v: fmtPct(ds.cases.length ? (answered / ds.cases.length) * 100 : 0, 0) }, { m: "Average length (words)", v: round(answered ? totalLen / answered : 0, 1) }, { m: "Positive %", v: fmtPct((pos / totalW) * 100, 0) }, { m: "Neutral %", v: fmtPct((neu / totalW) * 100, 0) }, { m: "Negative %", v: fmtPct((neg / totalW) * 100, 0) }], base: { n: answered } },
    { id: "words", title: "Most frequent words", columns: [{ key: "word", label: "Word" }, { key: "count", label: "Mentions", type: "number", decimals: 0 }, { key: "pct", label: "% of responses", type: "pct", decimals: 1 }], rows: topWords.map(([word, c]) => ({ word, count: round(c, 0), pct: pct(answered ? (c / answered) * 100 : 0) })) },
  ];
  if (topBigrams.length) tables.push({ id: "phrases", title: "Frequent phrases", columns: [{ key: "phrase", label: "Phrase" }, { key: "count", label: "Mentions", type: "number", decimals: 0 }], rows: topBigrams.map(([phrase, c]) => ({ phrase, count: round(c, 0) })) });
  const themeRows = frame.length ? frame.map((t) => ({ theme: t.name, count: round(themeHits.get(t.name) ?? 0, 0), pct: pct(answered ? ((themeHits.get(t.name) ?? 0) / answered) * 100 : 0) })).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)) : [];
  if (frame.length) tables.push({ id: "themes", title: "Themes (coding frame)", columns: [{ key: "theme", label: "Theme" }, { key: "count", label: "Responses", type: "number", decimals: 0 }, { key: "pct", label: "%", type: "pct", decimals: 1 }], rows: themeRows, notes: ["Keyword-based coding — a response may match several themes."] });
  // sentiment by segment variable
  const by = opt(def, "by", def.columns?.[0] ?? null) as string | null;
  if (by && ds.byName.has(by)) {
    const cats = categoriesOf(ds, by), bc = categoricalColumn(ds, by);
    tables.push({ id: "by", title: `Sentiment by ${labelOf(ds, by)}`, columns: [{ key: "group", label: labelOf(ds, by) }, { key: "n", label: "n", type: "count" }, { key: "pos", label: "Positive %", type: "pct", decimals: 1 }, { key: "neg", label: "Negative %", type: "pct", decimals: 1 }, { key: "net", label: "Net sentiment", type: "number", decimals: 1 }],
      rows: cats.map((c) => { const pc = perCase.filter((p) => { const x = bc[p.i]; return Array.isArray(x) ? x.includes(c.code) : x === c.code; }); const n = pc.length; const P = pc.filter((p) => p.sent > 0).length, N = pc.filter((p) => p.sent < 0).length; return { group: c.label, n, pos: pct(n ? (P / n) * 100 : 0), neg: pct(n ? (N / n) * 100 : 0), net: round(n ? ((P - N) / n) * 100 : 0, 1) }; }).filter((r) => r.n > 0) });
  }
  const examples = perCase.slice().sort((a, b) => b.sent - a.sent);
  const insights = [`${answered} of ${ds.cases.length} respondents answered (${fmtPct(ds.cases.length ? (answered / ds.cases.length) * 100 : 0, 0)}); sentiment is ${fmtPct((pos / totalW) * 100, 0)} positive, ${fmtPct((neg / totalW) * 100, 0)} negative (net ${fmtNum(((pos - neg) / totalW) * 100, 0)}).`];
  if (topWords.length) insights.push(`Most mentioned: ${topWords.slice(0, 5).map(([wd]) => `“${wd}”`).join(", ")}.`);
  if (themeRows[0]) insights.push(`Top theme: ${themeRows[0].theme} (${fmtPct(themeRows[0].pct, 0)} of responses).`);
  return makeResult(def, ds, {
    tables, chart: { words: topWords.map(([text, value]) => ({ text, value: round(value, 0) ?? 0, sentiment: POS.has(text) ? 1 : NEG.has(text) ? -1 : 0 })), categories: ["Positive", "Neutral", "Negative"], series: [{ name: "Sentiment", values: [pct((pos / totalW) * 100), pct((neu / totalW) * 100), pct((neg / totalW) * 100)] }], kpis: [{ label: "Responses", value: answered }, { label: "Net sentiment", value: round(((pos - neg) / totalW) * 100, 0) ?? 0 }], tree: themeRows.length ? themeRows.map((t) => ({ name: t.theme, value: t.count ?? 0 })) : undefined, valueFormat: "pct" },
    insights, warnings: answered < 20 ? ["Fewer than 20 text responses — themes and sentiment are indicative only."] : [], recommendedCharts: ["word_cloud", "keyword_bar", "sentiment_distribution", "theme_distribution", "treemap"], variablesUsed: [v], totalCases,
    segments: examples.length ? undefined : undefined,
  });
}

export { proportionCI };
