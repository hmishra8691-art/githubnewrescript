import type { AnalysisDefinition, AnalysisResult, ChartData, ChartType, ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, itemLabelOf, labelOf, numericColumn, scaleCodes, segmentDatasets, weights, type Dataset } from "../dataset.js";
import { boxShares, describe, frequencies } from "../stats/descriptive.js";
import { chiSquare, proportionCI, significanceLetters, oneWayAnova, type TestResult } from "../stats/tests.js";
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

/* ============================================================ crosstab */

interface Cell { count: number; w: number }

export function crosstab(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const rowVars = def.rows?.length ? def.rows : def.variables.slice(0, 1);
  const colVars = def.columns?.length ? def.columns : def.variables.slice(1, 2);
  const layerVar = def.layers?.[0];
  const measure = def.measure ?? "pct_col";
  const alpha = opt(def, "alpha", 0.05) as number;
  const showSig = opt(def, "significance", true) as boolean;
  const w = weights(ds);
  const warnings: string[] = [];
  const tables: ResultTable[] = [];
  const tests: TestResult[] = [];
  const insights: string[] = [];
  let chart: ChartData = {};

  if (!rowVars.length || !colVars.length) {
    return makeResult(def, ds, { tables, chart, warnings: ["A crosstab needs at least one row variable and one column variable."], recommendedCharts: ["table"], totalCases });
  }

  const layers: { label: string; ds: Dataset }[] = layerVar
    ? categoriesOf(ds, layerVar).map((c) => ({ label: `${labelOf(ds, layerVar)}: ${c.label}`, ds: { ...ds, cases: ds.cases.filter((x) => String(x.vars[layerVar]) === c.code || (Array.isArray(x.vars[layerVar]) && (x.vars[layerVar] as unknown[]).map(String).includes(c.code))) } }))
    : [{ label: "", ds }];

  for (const layer of layers) {
    const lw = weights(layer.ds);
    for (const rv of rowVars) for (const cv of colVars) {
      const rCats = categoriesOf(ds, rv), cCats = categoriesOf(ds, cv);
      const rMeta = ds.byName.get(rv);
      const rowsIsNumeric = rMeta?.role === "numeric" && !rMeta.categories;
      const rVals = categoricalColumn(layer.ds, rv), cVals = categoricalColumn(layer.ds, cv);
      const rNum = rowsIsNumeric ? numericColumn(layer.ds, rv) : null;
      // column keys: Total + each column category
      const colKeys = ["__total", ...cCats.map((c) => c.code)];
      const grid = new Map<string, Map<string, Cell>>();
      const colBase = new Map<string, Cell>(colKeys.map((k) => [k, { count: 0, w: 0 }]));
      const rowBase = new Map<string, Cell>();
      const numSums = new Map<string, { sum: number; w: number; n: number; vals: number[] }>();
      const inc = (m: Map<string, Cell>, k: string, wt: number) => { const c = m.get(k) ?? { count: 0, w: 0 }; c.count++; c.w += wt; m.set(k, c); };
      layer.ds.cases.forEach((_, i) => {
        const wt = lw?.[i] ?? 1;
        const rc = rVals[i], cc = cVals[i];
        if (cc == null) return;
        const cols = ["__total", ...(Array.isArray(cc) ? cc : [cc])];
        if (rowsIsNumeric) {
          const v = rNum![i];
          if (v == null) return;
          for (const ck of cols) { const s = numSums.get(ck) ?? { sum: 0, w: 0, n: 0, vals: [] }; s.sum += v * wt; s.w += wt; s.n++; s.vals.push(v); numSums.set(ck, s); inc(colBase, ck, wt); }
          return;
        }
        if (rc == null) return;
        const rcs = Array.isArray(rc) ? rc : [rc];
        for (const ck of cols) inc(colBase, ck, wt);
        for (const r of rcs) {
          inc(rowBase, r, wt);
          const rowMap = grid.get(r) ?? new Map<string, Cell>();
          for (const ck of cols) inc(rowMap, ck, wt);
          grid.set(r, rowMap);
        }
      });
      const title = `${labelOf(ds, rv)} × ${labelOf(ds, cv)}${layer.label ? ` — ${layer.label}` : ""}`;
      const columns = [{ key: "row", label: labelOf(ds, rv) }, { key: "__total", label: "Total", type: measure === "mean" ? "number" as const : measure === "count" ? "count" as const : "pct" as const, decimals: 1 }, ...cCats.map((c, j) => ({ key: c.code, label: `${c.label}${showSig ? ` (${String.fromCharCode(97 + (j % 26))})` : ""}`, type: measure === "mean" ? "number" as const : measure === "count" ? "count" as const : "pct" as const, decimals: 1 }))];
      const out: Record<string, unknown>[] = [];
      const totalW = colBase.get("__total")!.w;
      if (rowsIsNumeric) {
        const row: Record<string, unknown> = { row: "Mean" };
        const sdRow: Record<string, unknown> = { row: "Std. deviation" };
        const nRow: Record<string, unknown> = { row: "n" };
        for (const ck of colKeys) {
          const s = numSums.get(ck);
          const d = s ? describe(s.vals) : null;
          row[ck] = s && s.w ? round(s.sum / s.w) : null; sdRow[ck] = round(d?.sd); nRow[ck] = s?.n ?? 0;
        }
        out.push(row, sdRow, nRow);
        const groups = cCats.map((c) => ({ label: c.label, values: numSums.get(c.code)?.vals ?? [] })).filter((g) => g.values.length > 1);
        if (groups.length >= 2) tests.push({ ...oneWayAnova(groups), note: `${labelOf(ds, rv)} by ${labelOf(ds, cv)}` });
        chart = { categories: cCats.map((c) => c.label), series: [{ name: `Mean ${labelOf(ds, rv)}`, values: cCats.map((c) => { const s = numSums.get(c.code); return s && s.w ? round(s.sum / s.w) : null; }) }] };
      } else {
        const rowKeys = rCats.map((c) => c.code);
        for (const rk of rowKeys) {
          const label = rCats.find((c) => c.code === rk)?.label ?? rk;
          const row: Record<string, unknown> = { row: label };
          const rowMap = grid.get(rk) ?? new Map<string, Cell>();
          const counts = cCats.map((c) => rowMap.get(c.code)?.count ?? 0), bases = cCats.map((c) => colBase.get(c.code)?.count ?? 0);
          const letters = showSig ? significanceLetters(counts, bases, alpha) : [];
          for (const ck of colKeys) {
            const cell = rowMap.get(ck) ?? { count: 0, w: 0 };
            const base = colBase.get(ck)!;
            let v: number | null;
            if (measure === "count") v = round(cell.w, 1);
            else if (measure === "pct_row") v = pct(rowBase.get(rk)?.w ? (cell.w / rowBase.get(rk)!.w) * 100 : 0);
            else if (measure === "pct_total") v = pct(totalW ? (cell.w / totalW) * 100 : 0);
            else v = pct(base.w ? (cell.w / base.w) * 100 : 0);
            row[ck] = v;
            row[`${ck}__n`] = cell.count;
            const j = cCats.findIndex((c) => c.code === ck);
            if (j >= 0 && letters[j]) row[`${ck}__sig`] = letters[j];
          }
          out.push(row);
        }
        const baseRow: Record<string, unknown> = { row: "Base (n)", __format: "count" };
        for (const ck of colKeys) baseRow[ck] = colBase.get(ck)?.count ?? 0;
        out.push(baseRow);
        if (ds.weighted) { const wb: Record<string, unknown> = { row: "Weighted base", __format: "number" }; for (const ck of colKeys) wb[ck] = round(colBase.get(ck)?.w, 1); out.push(wb); }
        // chi-square over the raw count table (single-response rows/cols only)
        const table = rowKeys.map((rk) => cCats.map((c) => grid.get(rk)?.get(c.code)?.count ?? 0)).filter((r) => r.some((x) => x));
        if (table.length >= 2 && cCats.length >= 2 && rMeta?.role !== "multi" && ds.byName.get(cv)?.role !== "multi") {
          const cs = chiSquare(table);
          tests.push({ ...cs, note: `${labelOf(ds, rv)} × ${labelOf(ds, cv)}` });
          if (cs.p != null) insights.push(`${labelOf(ds, rv)} ${cs.p < alpha ? "differs significantly" : "does not differ significantly"} by ${labelOf(ds, cv)} (χ² = ${fmtNum(cs.statistic, 2)}, p ${cs.p < 0.001 ? "< .001" : "= " + cs.p.toFixed(3)}${cs.effectSize?.value != null ? `, Cramér's V = ${cs.effectSize.value.toFixed(2)}` : ""}).`);
        }
        // biggest column gap
        let best: { row: string; col: string; diff: number; total: number } | null = null;
        for (const rk of rowKeys) for (const c of cCats) {
          const cell = grid.get(rk)?.get(c.code)?.w ?? 0, base = colBase.get(c.code)?.w ?? 0, tot = totalW ? ((grid.get(rk)?.get("__total")?.w ?? 0) / totalW) * 100 : 0;
          if (!base || (colBase.get(c.code)?.count ?? 0) < 10) continue;
          const p = (cell / base) * 100, diff = p - tot;
          if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { row: rCats.find((x) => x.code === rk)?.label ?? rk, col: c.label, diff, total: tot };
        }
        if (best && Math.abs(best.diff) >= 5) insights.push(`Largest gap: “${best.row}” is ${fmtNum(Math.abs(best.diff), 1)} points ${best.diff > 0 ? "higher" : "lower"} among ${best.col} (${fmtPct(best.total + best.diff, 1)} vs ${fmtPct(best.total, 1)} overall).`);
        if (!chart.categories) chart = {
          categories: rCats.map((c) => c.label),
          series: cCats.map((c) => ({ name: c.label, values: rowKeys.map((rk) => { const cell = grid.get(rk)?.get(c.code)?.w ?? 0, base = colBase.get(c.code)?.w ?? 0; return pct(base ? (cell / base) * 100 : 0); }), sig: rowKeys.map((rk) => { const counts = cCats.map((cc) => grid.get(rk)?.get(cc.code)?.count ?? 0), bases = cCats.map((cc) => colBase.get(cc.code)?.count ?? 0); return showSig ? significanceLetters(counts, bases, alpha)[cCats.indexOf(c)] : ""; }) })),
          matrix: { rows: rCats.map((c) => c.label), columns: cCats.map((c) => c.label), values: rowKeys.map((rk) => cCats.map((c) => { const cell = grid.get(rk)?.get(c.code)?.w ?? 0, base = colBase.get(c.code)?.w ?? 0; return pct(base ? (cell / base) * 100 : 0); })) },
          valueFormat: "pct",
        };
      }
      const colBases: Record<string, number> = {}; for (const ck of colKeys) colBases[ck] = colBase.get(ck)?.count ?? 0;
      tables.push({ id: `xt_${rv}_${cv}${layerVar ? "_" + layer.label : ""}`, title, columns, rows: out, base: { n: colBase.get("__total")?.count ?? 0, weightedN: round(totalW, 1) ?? 0 }, columnBases: colBases,
        notes: [measure === "pct_col" ? "Column percentages." : measure === "pct_row" ? "Row percentages." : measure === "pct_total" ? "Percent of total." : measure === "mean" ? "Column means." : "Weighted counts.",
          ...(showSig && !rowsIsNumeric ? [`Letters mark columns significantly lower at the ${Math.round((1 - alpha) * 100)}% level (column proportion z-test).`] : []),
          ...(Object.values(colBases).some((b, i) => i > 0 && b < 30) ? ["Some columns have a base below 30 — read with caution."] : [])] });
      for (const [ck, b] of Object.entries(colBases)) if (ck !== "__total" && b > 0 && b < 30) warnings.push(`Column “${cCats.find((c) => c.code === ck)?.label ?? ck}” of ${labelOf(ds, cv)} has a base of ${b}.`);
    }
  }
  return makeResult(def, ds, { tables, chart, tests, insights, warnings: [...new Set(warnings)], recommendedCharts: ["bar_grouped", "bar_stacked_100", "heatmap_crosstab", "bar_horizontal", "table"], variablesUsed: [...rowVars, ...colVars, ...(layerVar ? [layerVar] : [])], totalCases });
}

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
