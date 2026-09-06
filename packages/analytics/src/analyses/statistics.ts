import type { AnalysisDefinition, AnalysisResult, ChartData, ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, labelOf, numericColumn, segmentDatasets, weights, weightedN, type Dataset } from "../dataset.js";
import { describe, frequencies } from "../stats/descriptive.js";
import {
  chiSquare, fisherExact, friedman, independentT, kruskalWallis, mannWhitney, oneSampleT, oneWayAnova, pairedT, proportionCI, proportionTest,
  twoWayAnova, wilcoxonSignedRank, type TestResult,
} from "../stats/tests.js";
import { correlate, correlationMatrix } from "../stats/correlation.js";
import { logistic, mediation, multinomialLogistic, ols, type Coefficient } from "../stats/regression.js";
import { cronbachAlpha, factorAnalysis, hierarchical, kMeans, standardize } from "../stats/multivariate.js";
import { fmtNum, fmtP, fmtPct, makeResult, opt, pct, round } from "./common.js";
import { expandBattery } from "./basics.js";

const sigWord = (p: number | null | undefined, alpha = 0.05) => (p == null ? "could not be tested" : p < alpha ? "is statistically significant" : "is not statistically significant");

function groupsBy(ds: Dataset, y: string, g: string): { labels: string[]; groups: number[][]; codes: string[]; labelled: { label: string; values: number[] }[] } {
  const cats = categoriesOf(ds, g);
  const yv = numericColumn(ds, y), gv = categoricalColumn(ds, g);
  const groups = cats.map(() => [] as number[]);
  yv.forEach((v, i) => { const c = gv[i]; if (v == null || c == null || Array.isArray(c)) return; const j = cats.findIndex((x) => x.code === c); if (j >= 0) groups[j].push(v); });
  const keep = groups.map((gr, i) => i).filter((i) => groups[i].length > 0);
  return { labels: keep.map((i) => cats[i].label), groups: keep.map((i) => groups[i]), codes: keep.map((i) => cats[i].code), labelled: keep.map((i) => ({ label: cats[i].label, values: groups[i] })) };
}

function testTable(tests: TestResult[]): ResultTable {
  return {
    id: "tests", title: "Test results",
    columns: [{ key: "test", label: "Test" }, { key: "statistic", label: "Statistic", type: "number", decimals: 3 }, { key: "df", label: "df" }, { key: "p", label: "p-value" }, { key: "effect", label: "Effect size" }, { key: "note", label: "Note" }],
    rows: tests.map((t) => ({ test: TEST_LABEL[t.test] ?? t.test, statistic: round(t.statistic, 3), df: Array.isArray(t.df) ? t.df.map((d) => round(d, 1)).join(", ") : round(t.df, 1), p: fmtP(t.p), effect: t.effectSize ? `${t.effectSize.name} = ${fmtNum(t.effectSize.value, 3)}` : "", note: t.note ?? "" })),
  };
}

const TEST_LABEL: Record<string, string> = {
  chi_square: "Chi-square test of independence", fisher_exact: "Fisher's exact test", t_one_sample: "One-sample t-test", t_independent: "Independent-samples t-test", t_welch: "Welch's t-test", t_paired: "Paired-samples t-test",
  anova_one_way: "One-way ANOVA", anova_two_way: "Two-way ANOVA", mann_whitney: "Mann-Whitney U", wilcoxon_signed_rank: "Wilcoxon signed-rank", kruskal_wallis: "Kruskal-Wallis H", friedman: "Friedman test",
  proportion_one_sample: "One-sample proportion z-test", proportion_two_sample: "Two-sample proportion z-test",
};

/* ============================================================ tests */

export function statisticalTest(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const test = opt(def, "test", "auto") as string;
  const alpha = opt(def, "alpha", 0.05) as number;
  const [a, b, c] = def.variables;
  const tests: TestResult[] = [];
  const tables: ResultTable[] = [];
  const insights: string[] = [];
  const warnings: string[] = [];
  let chart: ChartData = {};
  const roleOf = (v: string) => ds.byName.get(v)?.role;
  const isNum = (v: string) => roleOf(v) === "numeric" || roleOf(v) === "scale";

  const chosen = test !== "auto" ? test : !b ? (isNum(a) ? "t_one_sample" : "proportion_one_sample")
    : isNum(a) && !isNum(b) ? (categoriesOf(ds, b).length > 2 ? "anova_one_way" : "t_independent")
    : isNum(a) && isNum(b) ? "t_paired" : "chi_square";

  if (["t_one_sample", "proportion_one_sample"].includes(chosen)) {
    if (chosen === "t_one_sample") {
      const mu = opt(def, "mu", 0) as number;
      const vals = numericColumn(ds, a);
      const r = oneSampleT(vals, mu); tests.push(r);
      const d = describe(vals, weights(ds));
      insights.push(`The mean of ${labelOf(ds, a)} (${fmtNum(d.mean, 2)}) ${sigWord(r.p, alpha)}ly different from ${mu} (t = ${fmtNum(r.statistic, 2)}, p ${fmtP(r.p)}).`.replace("significantly different", "significantly different").replace("is statistically significantly", "is significantly").replace("is not statistically significantly", "is not significantly"));
      chart = { categories: [labelOf(ds, a)], series: [{ name: "Mean", values: [round(d.mean)], ci: [d.ci95 ? [round(d.ci95[0])!, round(d.ci95[1])!] : null] }], kpis: [{ label: "Mean", value: round(d.mean) ?? 0 }, { label: "Test value", value: mu }] };
    } else {
      const target = String(opt(def, "category", categoriesOf(ds, a)[0]?.code ?? ""));
      const p0 = opt(def, "p0", 0.5) as number;
      const col = categoricalColumn(ds, a);
      let x = 0, n = 0;
      for (const v of col) { if (v == null) continue; n++; if ((Array.isArray(v) ? v : [v]).includes(target)) x++; }
      const r = proportionTest(x, n, undefined, undefined, p0); tests.push(r);
      const ci = proportionCI(x, n);
      insights.push(`${fmtPct(n ? (x / n) * 100 : 0, 1)} chose “${categoriesOf(ds, a).find((cc) => cc.code === target)?.label ?? target}” — this ${sigWord(r.p, alpha)}ly different from ${fmtPct(p0 * 100)} (z = ${fmtNum(r.statistic, 2)}, p ${fmtP(r.p)}).`.replace("is statistically significantly", "is significantly").replace("is not statistically significantly", "is not significantly"));
      chart = { categories: [labelOf(ds, a)], series: [{ name: "Proportion", values: [pct(n ? (x / n) * 100 : 0)], ci: [ci ? [round(ci[0] * 100, 1)!, round(ci[1] * 100, 1)!] : null] }], valueFormat: "pct" };
    }
  } else if (["t_independent", "t_welch", "anova_one_way", "mann_whitney", "kruskal_wallis"].includes(chosen)) {
    const g = groupsBy(ds, a, b);
    if (g.groups.length < 2) warnings.push(`${labelOf(ds, b)} has fewer than two groups with data.`);
    else {
      const equalVar = opt(def, "equalVariance", false) as boolean;
      let r: TestResult;
      if (chosen === "t_independent" || chosen === "t_welch") {
        if (g.groups.length > 2) warnings.push(`${labelOf(ds, b)} has ${g.groups.length} groups — only the first two are compared; use ANOVA for all groups.`);
        r = independentT(g.groups[0], g.groups[1], chosen === "t_independent" ? equalVar : false);
      } else if (chosen === "mann_whitney") r = mannWhitney(g.groups[0], g.groups[1]);
      else if (chosen === "kruskal_wallis") r = kruskalWallis(g.labelled);
      else r = oneWayAnova(g.labelled);
      r.note = `${labelOf(ds, a)} by ${labelOf(ds, b)}`;
      tests.push(r);
      const means = g.groups.map((gr) => describe(gr));
      tables.push({ id: "groups", title: `${labelOf(ds, a)} by ${labelOf(ds, b)}`, columns: [{ key: "group", label: labelOf(ds, b) }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "sd", label: "SD", type: "number", decimals: 2 }, { key: "median", label: "Median", type: "number", decimals: 2 }, { key: "lo", label: "95% CI low", type: "number", decimals: 2 }, { key: "hi", label: "95% CI high", type: "number", decimals: 2 }],
        rows: g.labels.map((l, i) => ({ group: l, n: means[i].n, mean: round(means[i].mean), sd: round(means[i].sd), median: round(means[i].median), lo: round(means[i].ci95?.[0]), hi: round(means[i].ci95?.[1]) })) });
      const hi = means.map((m, i) => ({ m: m.mean ?? 0, l: g.labels[i] })).sort((x, y) => y.m - x.m);
      insights.push(`The difference in ${labelOf(ds, a)} across ${labelOf(ds, b)} ${sigWord(r.p, alpha)} (${TEST_LABEL[r.test] ?? r.test}, p ${fmtP(r.p)}). Highest: ${hi[0].l} (${fmtNum(hi[0].m, 2)}); lowest: ${hi[hi.length - 1].l} (${fmtNum(hi[hi.length - 1].m, 2)}).`);
      if (r.effectSize?.value != null) insights.push(`Effect size ${r.effectSize.name} = ${fmtNum(r.effectSize.value, 2)} (${effectWord(r.effectSize.name, r.effectSize.value)}).`);
      chart = { categories: g.labels, series: [{ name: `Mean ${labelOf(ds, a)}`, values: means.map((m) => round(m.mean)), ci: means.map((m) => (m.ci95 ? [round(m.ci95[0])!, round(m.ci95[1])!] : null)) }], points: g.groups.flatMap((gr, i) => gr.map((v) => ({ x: i, y: v, group: g.labels[i] }))) };
    }
  } else if (["t_paired", "wilcoxon_signed_rank", "friedman"].includes(chosen)) {
    const vars = def.variables.filter(isNum);
    if (chosen === "friedman") {
      const cols = vars.map((v) => numericColumn(ds, v));
      const rows: number[][] = [];
      for (let i = 0; i < ds.cases.length; i++) { const r = cols.map((c) => c[i]); if (r.every((x) => x != null)) rows.push(r as number[]); }
      const r = friedman(rows); r.note = vars.map((v) => labelOf(ds, v)).join(", "); tests.push(r);
      insights.push(`The ${vars.length} repeated measures ${sigWord(r.p, alpha).replace("is", "differ")} (Friedman χ² = ${fmtNum(r.statistic, 2)}, p ${fmtP(r.p)}).`);
    } else {
      const x = numericColumn(ds, a), y = numericColumn(ds, b);
      const r = chosen === "t_paired" ? pairedT(x, y) : wilcoxonSignedRank(x, y); r.note = `${labelOf(ds, a)} vs ${labelOf(ds, b)}`; tests.push(r);
      const dx = describe(x, weights(ds)), dy = describe(y, weights(ds));
      insights.push(`${labelOf(ds, a)} (mean ${fmtNum(dx.mean, 2)}) vs ${labelOf(ds, b)} (mean ${fmtNum(dy.mean, 2)}): the paired difference ${sigWord(r.p, alpha)} (p ${fmtP(r.p)}).`);
    }
    const means = vars.map((v) => describe(numericColumn(ds, v), weights(ds)));
    chart = { categories: vars.map((v) => labelOf(ds, v)), series: [{ name: "Mean", values: means.map((m) => round(m.mean)), ci: means.map((m) => (m.ci95 ? [round(m.ci95[0])!, round(m.ci95[1])!] : null)) }] };
    tables.push({ id: "paired", title: "Measures", columns: [{ key: "v", label: "Variable" }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "sd", label: "SD", type: "number", decimals: 2 }], rows: vars.map((v, i) => ({ v: labelOf(ds, v), n: means[i].n, mean: round(means[i].mean), sd: round(means[i].sd) })) });
  } else if (chosen === "anova_two_way") {
    const yv = numericColumn(ds, a), av = categoricalColumn(ds, b), bv = categoricalColumn(ds, c);
    const rows: { a: string; b: string; y: number }[] = [];
    yv.forEach((y, i) => { if (y != null && typeof av[i] === "string" && typeof bv[i] === "string") rows.push({ a: av[i] as string, b: bv[i] as string, y }); });
    const r = twoWayAnova(rows);
    r.factorA.note = labelOf(ds, b); r.factorB.note = labelOf(ds, c); r.interaction.note = `${labelOf(ds, b)} × ${labelOf(ds, c)}`;
    tests.push(r.factorA, r.factorB, r.interaction);
    insights.push(`Main effect of ${labelOf(ds, b)} ${sigWord(r.factorA.p, alpha)} (p ${fmtP(r.factorA.p)}); main effect of ${labelOf(ds, c)} ${sigWord(r.factorB.p, alpha)} (p ${fmtP(r.factorB.p)}); the interaction ${sigWord(r.interaction.p, alpha)} (p ${fmtP(r.interaction.p)}).`);
    const aCats = categoriesOf(ds, b), bCats = categoriesOf(ds, c);
    chart = { categories: aCats.map((x) => x.label), series: bCats.map((bc) => ({ name: bc.label, values: aCats.map((ac) => { const cell = rows.filter((rw) => rw.a === ac.code && rw.b === bc.code).map((rw) => rw.y); return cell.length ? round(cell.reduce((s, v) => s + v, 0) / cell.length) : null; }) })) };
  } else if (chosen === "chi_square" || chosen === "fisher_exact") {
    const rc = categoriesOf(ds, a), cc = categoriesOf(ds, b);
    const rv = categoricalColumn(ds, a), cv = categoricalColumn(ds, b);
    const table = rc.map(() => cc.map(() => 0));
    rv.forEach((r, i) => { const col = cv[i]; if (typeof r !== "string" || typeof col !== "string") return; const ri = rc.findIndex((x) => x.code === r), ci = cc.findIndex((x) => x.code === col); if (ri >= 0 && ci >= 0) table[ri][ci]++; });
    const live = table.filter((r) => r.some(Boolean));
    let r: TestResult;
    if (chosen === "fisher_exact") {
      if (live.length !== 2 || live[0].length !== 2) { warnings.push("Fisher's exact test needs a 2×2 table — chi-square used instead."); r = chiSquare(live); }
      else r = fisherExact(live[0][0], live[0][1], live[1][0], live[1][1]);
    } else r = chiSquare(live);
    r.note = `${labelOf(ds, a)} × ${labelOf(ds, b)}`; tests.push(r);
    insights.push(`The association between ${labelOf(ds, a)} and ${labelOf(ds, b)} ${sigWord(r.p, alpha)} (${TEST_LABEL[r.test]}, p ${fmtP(r.p)}${r.effectSize?.value != null ? `; ${r.effectSize.name} = ${fmtNum(r.effectSize.value, 2)}` : ""}).`);
    const colTotals = cc.map((_, j) => table.reduce((t, row) => t + row[j], 0));
    tables.push({ id: "contingency", title: `${labelOf(ds, a)} × ${labelOf(ds, b)} (counts)`, columns: [{ key: "row", label: labelOf(ds, a) }, ...cc.map((x) => ({ key: x.code, label: x.label, type: "count" as const }))], rows: rc.map((x, i) => ({ row: x.label, ...Object.fromEntries(cc.map((y, j) => [y.code, table[i][j]])) })), columnBases: Object.fromEntries(cc.map((y, j) => [y.code, colTotals[j]])) });
    chart = { categories: rc.map((x) => x.label), series: cc.map((y, j) => ({ name: y.label, values: rc.map((_, i) => pct(colTotals[j] ? (table[i][j] / colTotals[j]) * 100 : 0)) })), matrix: { rows: rc.map((x) => x.label), columns: cc.map((y) => y.label), values: table.map((row, i) => row.map((v, j) => pct(colTotals[j] ? (v / colTotals[j]) * 100 : 0))) }, valueFormat: "pct" };
  } else warnings.push(`Unknown test “${chosen}”.`);

  if (tests.length) tables.unshift(testTable(tests));
  return makeResult(def, ds, { tables, chart, tests, insights, warnings, recommendedCharts: ["mean_ci", "bar_grouped", "box_plot", "error_bar", "diff_means"], totalCases });
}

function effectWord(name: string, v: number): string {
  const a = Math.abs(v);
  if (name.startsWith("Cohen")) return a < 0.2 ? "negligible" : a < 0.5 ? "small" : a < 0.8 ? "medium" : "large";
  if (name.includes("Cram") || name === "phi") return a < 0.1 ? "negligible" : a < 0.3 ? "small" : a < 0.5 ? "medium" : "large";
  if (name.startsWith("eta") || name.startsWith("η")) return a < 0.01 ? "negligible" : a < 0.06 ? "small" : a < 0.14 ? "medium" : "large";
  return a < 0.1 ? "small" : a < 0.3 ? "medium" : "large";
}

/* ============================================================ correlation */

export function correlation(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const method = opt(def, "method", "pearson") as "pearson" | "spearman" | "kendall";
  const alpha = opt(def, "alpha", 0.05) as number;
  const vars = expandBattery(ds, def.variables).filter((v) => { const r = ds.byName.get(v)?.role; return r === "numeric" || r === "scale"; });
  const warnings: string[] = [];
  if (vars.length < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Correlation needs at least two numeric or scale variables."], recommendedCharts: ["scatter"], totalCases });
  const cols = vars.map((v) => numericColumn(ds, v));
  const insights: string[] = [];
  if (vars.length === 2) {
    const r = correlate(cols[0], cols[1], method);
    const pts = cols[0].map((x, i) => ({ x, y: cols[1][i] })).filter((p): p is { x: number; y: number } => p.x != null && p.y != null);
    insights.push(`${labelOf(ds, vars[0])} and ${labelOf(ds, vars[1])} are ${strengthWord(r.r)} ${r.r != null && r.r < 0 ? "negatively" : "positively"} correlated (${method} r = ${fmtNum(r.r, 3)}, n = ${r.n}); the correlation ${sigWord(r.p, alpha)} (p ${fmtP(r.p)}).`);
    const fit = ols(pts.map((p) => p.y), { predictors: [{ name: "x", values: pts.map((p) => p.x) }] });
    return makeResult(def, ds, {
      tables: [{ id: "corr", title: "Correlation", columns: [{ key: "pair", label: "Pair" }, { key: "method", label: "Method" }, { key: "r", label: "r", type: "number", decimals: 3 }, { key: "p", label: "p-value" }, { key: "n", label: "n", type: "count" }], rows: [{ pair: `${labelOf(ds, vars[0])} × ${labelOf(ds, vars[1])}`, method, r: round(r.r, 3), p: fmtP(r.p), n: r.n }] }],
      chart: { points: pts, series: "error" in fit ? undefined : [{ name: "Trend", values: [fit.coefficients[0].estimate, fit.coefficients[1].estimate], meta: { kind: "line_fit", r2: fit.r2 } }] },
      tests: [{ test: `${method}_correlation`, statistic: r.r, p: r.p, note: `n = ${r.n}` }], insights, warnings,
      recommendedCharts: ["scatter_trendline", "scatter", "bubble", "scatter_ci"], variablesUsed: vars, totalCases,
    });
  }
  const m = correlationMatrix(vars.map((v, i) => ({ name: labelOf(ds, v), values: cols[i] })), method);
  const rows = m.variables.map((v, i) => ({ variable: v, ...Object.fromEntries(m.variables.map((w, j) => [`c${j}`, round(m.r[i][j], 2)])), ...Object.fromEntries(m.variables.map((w, j) => [`c${j}__sig`, i !== j && m.p[i][j] != null && m.p[i][j]! < alpha ? "*" : ""])) }));
  const pairs: { a: string; b: string; r: number; p: number | null }[] = [];
  for (let i = 0; i < vars.length; i++) for (let j = i + 1; j < vars.length; j++) if (m.r[i][j] != null) pairs.push({ a: m.variables[i], b: m.variables[j], r: m.r[i][j]!, p: m.p[i][j] });
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  if (pairs.length) insights.push(`Strongest correlation: ${pairs[0].a} × ${pairs[0].b} (r = ${fmtNum(pairs[0].r, 2)}, p ${fmtP(pairs[0].p)}).${pairs.length > 1 ? ` Weakest: ${pairs[pairs.length - 1].a} × ${pairs[pairs.length - 1].b} (r = ${fmtNum(pairs[pairs.length - 1].r, 2)}).` : ""}`);
  const sigCount = pairs.filter((p) => p.p != null && p.p < alpha).length;
  insights.push(`${sigCount} of ${pairs.length} pairs are significant at α = ${alpha}.`);
  return makeResult(def, ds, {
    tables: [{ id: "corr_matrix", title: `Correlation matrix (${method})`, columns: [{ key: "variable", label: "" }, ...m.variables.map((v, j) => ({ key: `c${j}`, label: v, type: "number" as const, decimals: 2 }))], rows, notes: [`* p < ${alpha}`] },
      { id: "corr_pairs", title: "Pairwise correlations", columns: [{ key: "a", label: "Variable A" }, { key: "b", label: "Variable B" }, { key: "r", label: "r", type: "number", decimals: 3 }, { key: "p", label: "p-value" }], rows: pairs.map((p) => ({ a: p.a, b: p.b, r: round(p.r, 3), p: fmtP(p.p) })) }],
    chart: { matrix: { rows: m.variables, columns: m.variables, values: m.r.map((r) => r.map((x) => round(x, 2))) }, valueFormat: "number" },
    insights, warnings, recommendedCharts: ["heatmap_correlation", "correlation_matrix", "correlogram", "network"], variablesUsed: vars, totalCases,
  });
}

function strengthWord(r: number | null): string {
  if (r == null) return "not";
  const a = Math.abs(r);
  return a < 0.1 ? "negligibly" : a < 0.3 ? "weakly" : a < 0.5 ? "moderately" : a < 0.7 ? "strongly" : "very strongly";
}

/* ============================================================ regression */

function coefTable(id: string, title: string, terms: Coefficient[], logisticModel = false): ResultTable {
  return {
    id, title,
    columns: [{ key: "term", label: "Term" }, { key: "estimate", label: logisticModel ? "Log-odds" : "Estimate", type: "number", decimals: 3 }, ...(logisticModel ? [{ key: "or", label: "Odds ratio", type: "number" as const, decimals: 3 }] : [{ key: "std", label: "Standardized β", type: "number" as const, decimals: 3 }]), { key: "se", label: "Std. error", type: "number", decimals: 3 }, { key: "stat", label: logisticModel ? "z" : "t", type: "number", decimals: 3 }, { key: "p", label: "p-value" }, { key: "lo", label: "95% CI low", type: "number", decimals: 3 }, { key: "hi", label: "95% CI high", type: "number", decimals: 3 }],
    rows: terms.map((t) => ({ term: t.term, estimate: round(t.estimate, 3), or: round(t.oddsRatio, 3), std: round(t.standardized, 3), se: round(t.se, 3), stat: round(t.statistic, 3), p: fmtP(t.p), lo: round(t.ci95?.[0], 3), hi: round(t.ci95?.[1], 3), p__sig: t.p != null && t.p < 0.05 ? "*" : "" })),
  };
}

/** Expand a categorical predictor into dummy columns (reference = first category). */
function predictorColumns(ds: Dataset, name: string): { name: string; values: (number | null)[] }[] {
  const meta = ds.byName.get(name);
  if (meta?.role === "categorical" && meta.categories && meta.categories.length > 2) {
    const col = categoricalColumn(ds, name);
    return meta.categories.slice(1).map((c) => ({ name: `${labelOf(ds, name)} = ${c.label}`, values: col.map((v) => (v == null ? null : (Array.isArray(v) ? v.includes(c.code) : v === c.code) ? 1 : 0)) }));
  }
  if (meta?.role === "categorical" && meta.categories?.length === 2) {
    const col = categoricalColumn(ds, name), ref = meta.categories[1].code;
    return [{ name: `${labelOf(ds, name)} = ${meta.categories[1].label}`, values: col.map((v) => (v == null ? null : v === ref ? 1 : 0)) }];
  }
  return [{ name: labelOf(ds, name), values: numericColumn(ds, name) }];
}

export function regression(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const model = opt(def, "model", "linear") as "linear" | "logistic" | "multinomial" | "mediation";
  const [y, ...xs] = def.variables;
  const warnings: string[] = [];
  const insights: string[] = [];
  const tables: ResultTable[] = [];
  const tests: TestResult[] = [];
  let chart: ChartData = {};
  if (!y || !xs.length) return makeResult(def, ds, { tables, chart, warnings: ["Regression needs a dependent variable followed by at least one predictor."], recommendedCharts: ["coefficient_plot"], totalCases });

  if (model === "mediation") {
    const [x, m] = xs;
    if (!m) return makeResult(def, ds, { tables, chart, warnings: ["Mediation needs outcome, predictor and mediator."], recommendedCharts: ["coefficient_plot"], totalCases });
    const r = mediation(numericColumn(ds, x), numericColumn(ds, m), numericColumn(ds, y));
    if ("error" in r) return makeResult(def, ds, { tables, chart, warnings: [r.error], recommendedCharts: ["coefficient_plot"], totalCases });
    tables.push({ id: "mediation", title: `Mediation: ${labelOf(ds, x)} → ${labelOf(ds, m)} → ${labelOf(ds, y)}`, columns: [{ key: "path", label: "Path" }, { key: "estimate", label: "Estimate", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }, { key: "p", label: "p-value" }],
      rows: [{ path: `a: ${labelOf(ds, x)} → ${labelOf(ds, m)}`, estimate: round(r.a.estimate, 3), se: round(r.a.se, 3), p: fmtP(r.a.p) }, { path: `b: ${labelOf(ds, m)} → ${labelOf(ds, y)} (controlling X)`, estimate: round(r.b.estimate, 3), se: round(r.b.se, 3), p: fmtP(r.b.p) }, { path: `c′: direct ${labelOf(ds, x)} → ${labelOf(ds, y)}`, estimate: round(r.cPrime.estimate, 3), se: round(r.cPrime.se, 3), p: fmtP(r.cPrime.p) }, { path: "c: total effect", estimate: round(r.total.estimate, 3), se: round(r.total.se, 3), p: fmtP(r.total.p) }, { path: "a×b: indirect effect", estimate: round(r.indirect, 3), se: null, p: fmtP(r.sobelP) }, { path: "Proportion mediated", estimate: round(r.proportionMediated, 3), se: null, p: "" }] });
    tests.push({ test: "sobel", statistic: r.sobelZ, p: r.sobelP, note: "Indirect effect" });
    insights.push(`The indirect effect of ${labelOf(ds, x)} on ${labelOf(ds, y)} through ${labelOf(ds, m)} is ${fmtNum(r.indirect, 3)} (Sobel z = ${fmtNum(r.sobelZ, 2)}, p ${fmtP(r.sobelP)}); ${r.proportionMediated != null ? `${fmtPct(r.proportionMediated * 100)} of the total effect is mediated` : "the proportion mediated could not be computed"}.`);
    chart = { nodes: [{ id: "x", label: labelOf(ds, x) }, { id: "m", label: labelOf(ds, m) }, { id: "y", label: labelOf(ds, y) }], links: [{ source: "x", target: "m", value: r.a.estimate }, { source: "m", target: "y", value: r.b.estimate }, { source: "x", target: "y", value: r.cPrime.estimate }] };
    return makeResult(def, ds, { tables, chart, tests, insights, warnings, recommendedCharts: ["network", "coefficient_plot", "table"], totalCases });
  }

  const predictors = xs.flatMap((x) => predictorColumns(ds, x));
  const interactions = (opt(def, "interactions", []) as [string, string][]).map(([a, b]) => [labelOf(ds, a), labelOf(ds, b)] as [string, string]).filter(([a, b]) => predictors.some((p) => p.name === a) && predictors.some((p) => p.name === b));
  const moderation = opt(def, "moderation", false) as boolean;
  if (moderation && predictors.length >= 2 && !interactions.length) interactions.push([predictors[0].name, predictors[1].name]);
  const spec = { predictors, interactions };

  if (model === "linear") {
    const yv = numericColumn(ds, y);
    const fit = ols(yv, spec);
    if ("error" in fit) return makeResult(def, ds, { tables, chart, warnings: [fit.error], recommendedCharts: ["coefficient_plot"], totalCases });
    tables.push({ id: "fit", title: "Model fit", columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 3 }], rows: [{ stat: "R²", value: round(fit.r2, 3) }, { stat: "Adjusted R²", value: round(fit.adjustedR2, 3) }, { stat: "F", value: round(fit.f, 3) }, { stat: "F p-value", value: fmtP(fit.fP) }, { stat: "Residual SE", value: round(fit.residualSe, 3) }, { stat: "n", value: fit.fitted.length }, { stat: "df", value: Array.isArray(fit.df) ? fit.df.join(", ") : fit.df }] });
    tables.push(coefTable("coef", `Coefficients — ${labelOf(ds, y)}`, fit.coefficients));
    tests.push({ test: "f_model", statistic: fit.f, df: fit.df, p: fit.fP, note: "Overall model" });
    const sig = fit.coefficients.slice(1).filter((t) => t.p != null && t.p < 0.05).sort((a, b) => Math.abs(b.standardized ?? 0) - Math.abs(a.standardized ?? 0));
    insights.push(`The model explains ${fmtPct(fit.r2 * 100, 1)} of the variance in ${labelOf(ds, y)} (adjusted R² = ${fmtNum(fit.adjustedR2, 3)}, F = ${fmtNum(fit.f, 2)}, p ${fmtP(fit.fP)}).`);
    if (sig.length) insights.push(`Significant predictors: ${sig.map((t) => `${t.term} (β = ${fmtNum(t.standardized, 2)}, p ${fmtP(t.p)})`).join("; ")}. ${sig[0].term} has the strongest standardized effect.`);
    else insights.push("No predictor is significant at the 5% level.");
    if (interactions.length) { const it = fit.coefficients.filter((t) => t.term.includes(" × ")); for (const t of it) insights.push(`Interaction ${t.term} ${sigWord(t.p)} (b = ${fmtNum(t.estimate, 3)}, p ${fmtP(t.p)})${moderation ? " — " + (t.p != null && t.p < 0.05 ? "moderation is supported" : "no moderation detected") : ""}.`); }
    chart = { categories: fit.coefficients.slice(1).map((t) => t.term), series: [{ name: "Standardized β", values: fit.coefficients.slice(1).map((t) => round(t.standardized, 3)), ci: fit.coefficients.slice(1).map((t) => (t.ci95 ? [round(t.ci95[0], 3)!, round(t.ci95[1], 3)!] : null)), sig: fit.coefficients.slice(1).map((t) => (t.p != null && t.p < 0.05 ? "*" : "")) }], points: fit.fitted.map((f, i) => ({ x: f, y: fit.residuals[i] })) };
    return makeResult(def, ds, { tables, chart, tests, insights, warnings, recommendedCharts: ["coefficient_plot", "bar_horizontal", "forest", "scatter"], totalCases });
  }
  if (model === "logistic") {
    const target = opt(def, "target", null) as string | null;
    const col = categoricalColumn(ds, y);
    const cats = categoriesOf(ds, y);
    const pos = target ?? cats[cats.length - 1]?.code;
    const yv = col.map((v) => (v == null ? null : (Array.isArray(v) ? v.includes(pos) : v === pos) ? 1 : 0));
    const fit = logistic(yv, spec);
    if ("error" in fit) return makeResult(def, ds, { tables, chart, warnings: [fit.error], recommendedCharts: ["coefficient_plot"], totalCases });
    tables.push({ id: "fit", title: "Model fit", columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 3 }], rows: [{ stat: "McFadden pseudo-R²", value: round(fit.mcFaddenR2, 3) }, { stat: "LR χ²", value: round(fit.lrChiSquare, 3) }, { stat: "LR p-value", value: fmtP(fit.lrP) }, { stat: "AIC", value: round(fit.aic, 2) }, { stat: "Classification accuracy", value: pct(fit.accuracy * 100) }, { stat: "n", value: fit.n }] });
    tables.push(coefTable("coef", `Coefficients — P(${labelOf(ds, y)} = ${cats.find((c) => c.code === pos)?.label ?? pos})`, fit.coefficients, true));
    tests.push({ test: "lr_model", statistic: fit.lrChiSquare, p: fit.lrP, note: "Likelihood-ratio vs. null" });
    const sig = fit.coefficients.slice(1).filter((t) => t.p != null && t.p < 0.05);
    insights.push(`Predicting ${labelOf(ds, y)} = “${cats.find((c) => c.code === pos)?.label ?? pos}”: McFadden R² = ${fmtNum(fit.mcFaddenR2, 3)}, accuracy ${fmtPct(fit.accuracy * 100)}.`);
    if (sig.length) insights.push(`Significant predictors: ${sig.map((t) => `${t.term} (OR = ${fmtNum(t.oddsRatio, 2)}, p ${fmtP(t.p)})`).join("; ")}.`);
    chart = { categories: fit.coefficients.slice(1).map((t) => t.term), series: [{ name: "Odds ratio", values: fit.coefficients.slice(1).map((t) => round(t.oddsRatio, 3)), ci: fit.coefficients.slice(1).map((t) => (t.ci95 ? [round(Math.exp(t.ci95[0]), 3)!, round(Math.exp(t.ci95[1]), 3)!] : null)), sig: fit.coefficients.slice(1).map((t) => (t.p != null && t.p < 0.05 ? "*" : "")) }] };
    return makeResult(def, ds, { tables, chart, tests, insights, warnings, recommendedCharts: ["forest", "coefficient_plot", "bar_horizontal"], totalCases });
  }
  // multinomial
  const col = categoricalColumn(ds, y).map((v) => (v == null || Array.isArray(v) ? null : v));
  const fit = multinomialLogistic(col, spec);
  if ("error" in fit) return makeResult(def, ds, { tables, chart, warnings: [fit.error], recommendedCharts: ["coefficient_plot"], totalCases });
  const cats = categoriesOf(ds, y);
  const lbl = (c: string) => cats.find((x) => x.code === c)?.label ?? c;
  for (const eq of fit.equations) tables.push(coefTable(`coef_${eq.category}`, `${lbl(eq.category)} vs ${lbl(fit.reference)}`, eq.coefficients, true));
  insights.push(`Multinomial model for ${labelOf(ds, y)} (reference “${lbl(fit.reference)}”), ${fit.equations.length} equations, McFadden R² = ${fmtNum(fit.mcFaddenR2, 3)}.`);
  chart = { categories: fit.equations[0]?.coefficients.slice(1).map((t) => t.term) ?? [], series: fit.equations.map((eq) => ({ name: lbl(eq.category), values: eq.coefficients.slice(1).map((t) => round(t.estimate, 3)) })) };
  return makeResult(def, ds, { tables, chart, tests, insights, warnings, recommendedCharts: ["bar_grouped", "coefficient_plot", "table"], totalCases });
}

/* ============================================================ factor */

export function factor(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = expandBattery(ds, def.variables).filter((v) => ["numeric", "scale"].includes(ds.byName.get(v)?.role ?? ""));
  if (vars.length < 3) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Factor analysis needs at least three numeric or scale variables."], recommendedCharts: ["heatmap"], totalCases });
  const r = factorAnalysis(vars.map((v) => ({ name: labelOf(ds, v), values: numericColumn(ds, v) })), { method: opt(def, "method", "pca"), factors: opt(def, "factors", undefined), rotation: opt(def, "rotation", "varimax") });
  if ("error" in r) return makeResult(def, ds, { tables: [], chart: {}, warnings: [r.error as string], recommendedCharts: ["heatmap"], totalCases });
  const k = r.loadings[0]?.length ?? 0;
  const fNames = Array.from({ length: k }, (_, i) => `Factor ${i + 1}`);
  const load: ResultTable = { id: "loadings", title: "Rotated factor loadings", columns: [{ key: "v", label: "Variable" }, ...fNames.map((f, j) => ({ key: `f${j}`, label: f, type: "number" as const, decimals: 2 })), { key: "h2", label: "Communality", type: "number", decimals: 2 }],
    rows: r.variables.map((v, i) => ({ v, ...Object.fromEntries(fNames.map((_, j) => [`f${j}`, round(r.loadings[i][j], 2)])), ...Object.fromEntries(fNames.map((_, j) => [`f${j}__sig`, Math.abs(r.loadings[i][j]) >= 0.4 ? "*" : ""])), h2: round(r.communalities[i], 2) })), notes: ["* loading ≥ .40"] };
  const eig: ResultTable = { id: "eigen", title: "Eigenvalues and variance explained", columns: [{ key: "c", label: "Component" }, { key: "e", label: "Eigenvalue", type: "number", decimals: 3 }, { key: "v", label: "% variance", type: "pct", decimals: 1 }, { key: "cum", label: "Cumulative %", type: "pct", decimals: 1 }], rows: r.eigenvalues.map((e, i) => ({ c: i + 1, e: round(e, 3), v: pct(r.explained[i] * 100), cum: pct(r.cumulative[i] * 100) })) };
  const insights = [`${k} factor${k === 1 ? "" : "s"} retained, explaining ${fmtPct(r.cumulative[k - 1] * 100, 1)} of the variance. KMO = ${fmtNum(r.kmo, 2)} (${r.kmo == null ? "n/a" : r.kmo >= 0.8 ? "meritorious" : r.kmo >= 0.7 ? "middling" : r.kmo >= 0.6 ? "mediocre" : "poor"} sampling adequacy).`];
  for (let j = 0; j < k; j++) { const top = r.variables.map((v, i) => ({ v, l: r.loadings[i][j] })).filter((x) => Math.abs(x.l) >= 0.4).sort((a, b) => Math.abs(b.l) - Math.abs(a.l)); if (top.length) insights.push(`Factor ${j + 1}: ${top.map((t) => t.v).slice(0, 4).join(", ")}.`); }
  return makeResult(def, ds, {
    tables: [eig, load], chart: { matrix: { rows: r.variables, columns: fNames, values: r.loadings.map((row) => row.map((x) => round(x, 2))) }, categories: r.eigenvalues.map((_, i) => `${i + 1}`), series: [{ name: "Eigenvalue", values: r.eigenvalues.map((e) => round(e, 3)) }] },
    insights, recommendedCharts: ["heatmap", "line", "bar_horizontal", "scatter"], variablesUsed: vars, totalCases,
  });
}

/* ============================================================ reliability */

export function reliability(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = expandBattery(ds, def.variables).filter((v) => ["numeric", "scale"].includes(ds.byName.get(v)?.role ?? ""));
  if (vars.length < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Reliability needs at least two scale items."], recommendedCharts: ["bar_horizontal"], totalCases });
  const r = cronbachAlpha(vars.map((v) => ({ name: labelOf(ds, v), values: numericColumn(ds, v) })));
  const word = r.alpha == null ? "n/a" : r.alpha >= 0.9 ? "excellent" : r.alpha >= 0.8 ? "good" : r.alpha >= 0.7 ? "acceptable" : r.alpha >= 0.6 ? "questionable" : "poor";
  const insights = [`Cronbach's α = ${fmtNum(r.alpha, 3)} (${word}) across ${vars.length} items, n = ${r.n}; standardized α = ${fmtNum(r.standardizedAlpha, 3)}; mean inter-item correlation ${fmtNum(r.meanInterItem, 2)}.`];
  const weak = r.itemTotal.filter((it) => it.correlation != null && it.correlation < 0.3);
  if (weak.length) insights.push(`Items with weak item-total correlation (< .30): ${weak.map((w) => w.name).join(", ")}${weak.some((w) => r.alpha != null && w.alphaIfDeleted != null && w.alphaIfDeleted > r.alpha) ? " — dropping them would raise α." : "."}`);
  return makeResult(def, ds, {
    tables: [{ id: "alpha", title: "Scale reliability", columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 3 }], rows: [{ stat: "Cronbach's α", value: round(r.alpha, 3) }, { stat: "Standardized α", value: round(r.standardizedAlpha, 3) }, { stat: "Items", value: vars.length }, { stat: "n (complete cases)", value: r.n }, { stat: "Mean inter-item r", value: round(r.meanInterItem, 3) }] },
      { id: "items", title: "Item statistics", columns: [{ key: "name", label: "Item" }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "sd", label: "SD", type: "number", decimals: 2 }, { key: "r", label: "Item-total r", type: "number", decimals: 3 }, { key: "aid", label: "α if deleted", type: "number", decimals: 3 }], rows: r.itemTotal.map((it) => ({ name: it.name, mean: round(it.mean), sd: round(it.sd), r: round(it.correlation, 3), aid: round(it.alphaIfDeleted, 3) })) }],
    chart: { categories: r.itemTotal.map((it) => it.name), series: [{ name: "Item-total correlation", values: r.itemTotal.map((it) => round(it.correlation, 3)) }, { name: "α if deleted", values: r.itemTotal.map((it) => round(it.alphaIfDeleted, 3)) }], matrix: { rows: r.itemTotal.map((it) => it.name), columns: r.itemTotal.map((it) => it.name), values: r.interItem.map((row) => row.map((x) => round(x, 2))) }, kpis: [{ label: "Cronbach's α", value: round(r.alpha, 3) ?? 0 }] },
    insights, recommendedCharts: ["bar_horizontal", "heatmap_correlation", "kpi_card", "dot_plot"], variablesUsed: vars, totalCases,
  });
}

/* ============================================================ cluster */

export function cluster(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = expandBattery(ds, def.variables).filter((v) => ["numeric", "scale"].includes(ds.byName.get(v)?.role ?? ""));
  const k = opt(def, "k", 3) as number;
  const method = opt(def, "method", "kmeans") as "kmeans" | "hierarchical";
  const profileVars = (opt(def, "profile", []) as string[]).filter((v) => ds.byName.has(v));
  if (vars.length < 2) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Clustering needs at least two numeric or scale variables."], recommendedCharts: ["segment_size"], totalCases });
  const cols = vars.map((v) => numericColumn(ds, v));
  const keep: number[] = [];
  const rows: number[][] = [];
  for (let i = 0; i < ds.cases.length; i++) { const r = cols.map((c) => c[i]); if (r.every((x) => x != null)) { rows.push(r as number[]); keep.push(i); } }
  if (rows.length < k * 5) return makeResult(def, ds, { tables: [], chart: {}, warnings: [`Only ${rows.length} complete cases — too few for ${k} clusters.`], recommendedCharts: ["segment_size"], totalCases });
  const z = opt(def, "standardize", true) ? standardize(rows).rows : rows;
  let assignments: number[], sizes: number[], dendro: ChartData["dendrogram"] | undefined, silhouette: number | null = null;
  if (method === "hierarchical") {
    const h = hierarchical(z, k, opt(def, "linkage", "ward"));
    assignments = h.assignments; sizes = Array.from({ length: k }, (_, c) => assignments.filter((a) => a === c).length); dendro = h.merges;
  } else {
    const km = kMeans(z, k, opt(def, "seed", 42), 100);
    assignments = km.assignments; sizes = km.sizes; silhouette = km.silhouette;
  }
  const names = Array.from({ length: k }, (_, c) => `Cluster ${c + 1}`);
  // profile: mean of each input var per cluster
  const means = names.map((_, c) => vars.map((_, j) => { const xs = rows.filter((_, i) => assignments[i] === c).map((r) => r[j]); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }));
  const overall = vars.map((_, j) => rows.reduce((a, r) => a + r[j], 0) / rows.length);
  const tables: ResultTable[] = [
    { id: "sizes", title: "Cluster sizes", columns: [{ key: "c", label: "Cluster" }, { key: "n", label: "n", type: "count" }, { key: "pct", label: "%", type: "pct", decimals: 1 }], rows: names.map((n, c) => ({ c: n, n: sizes[c], pct: pct((sizes[c] / rows.length) * 100) })), base: { n: rows.length }, notes: silhouette != null ? [`Silhouette = ${fmtNum(silhouette, 3)}`] : undefined },
    { id: "profile", title: "Cluster profile (means of clustering variables)", columns: [{ key: "v", label: "Variable" }, { key: "all", label: "All", type: "number", decimals: 2 }, ...names.map((n, c) => ({ key: `c${c}`, label: n, type: "number" as const, decimals: 2 }))], rows: vars.map((v, j) => ({ v: labelOf(ds, v), all: round(overall[j]), ...Object.fromEntries(names.map((_, c) => [`c${c}`, round(means[c][j])])) })) },
  ];
  const tests: TestResult[] = vars.map((v, j) => ({ ...oneWayAnova(names.map((nm, c) => ({ label: nm, values: rows.filter((_, i) => assignments[i] === c).map((r) => r[j]) }))), note: labelOf(ds, v) }));
  // profile against extra categorical variables
  for (const pv of profileVars) {
    const cats = categoriesOf(ds, pv), col = categoricalColumn(ds, pv);
    tables.push({ id: `profile_${pv}`, title: `${labelOf(ds, pv)} by cluster (column %)`, columns: [{ key: "cat", label: labelOf(ds, pv) }, ...names.map((n, c) => ({ key: `c${c}`, label: n, type: "pct" as const, decimals: 1 }))],
      rows: cats.map((cat) => ({ cat: cat.label, ...Object.fromEntries(names.map((_, c) => { const idx = keep.filter((_, i) => assignments[i] === c); const hit = idx.filter((i) => { const v = col[i]; return Array.isArray(v) ? v.includes(cat.code) : v === cat.code; }).length; return [`c${c}`, pct(idx.length ? (hit / idx.length) * 100 : 0)]; })) })) });
  }
  const insights = [`${k} clusters found${silhouette != null ? ` (silhouette ${fmtNum(silhouette, 2)} — ${silhouette > 0.5 ? "well separated" : silhouette > 0.25 ? "reasonable structure" : "weak structure"})` : ""}; the largest is ${names[sizes.indexOf(Math.max(...sizes))]} with ${fmtPct((Math.max(...sizes) / rows.length) * 100)} of respondents.`];
  for (let c = 0; c < k; c++) {
    const diffs = vars.map((v, j) => ({ v: labelOf(ds, v), d: (means[c][j] ?? 0) - overall[j] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (diffs.length) insights.push(`${names[c]} (${fmtPct((sizes[c] / rows.length) * 100)}): ${diffs.slice(0, 2).map((d) => `${d.d > 0 ? "higher" : "lower"} ${d.v}`).join(", ")}.`);
  }
  return makeResult(def, ds, {
    tables, chart: { categories: vars.map((v) => labelOf(ds, v)), series: names.map((n, c) => ({ name: n, values: means[c].map((m) => round(m)) })), kpis: names.map((n, c) => ({ label: n, value: sizes[c] })), dendrogram: dendro, points: rows.map((r, i) => ({ x: r[0], y: r[1] ?? 0, group: names[assignments[i]] })) },
    tests, insights, recommendedCharts: method === "hierarchical" ? ["dendrogram", "segment_profile", "radar_segment", "segment_size"] : ["segment_profile", "radar_segment", "segment_size", "scatter", "heatmap"], variablesUsed: vars, totalCases,
  });
}

/* ============================================================ segmentation (segment profile) */

export function segmentation(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const segs = segmentDatasets(ds, def.segments);
  if (!segs.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["Add at least one segment to compare."], recommendedCharts: ["segment_comparison"], totalCases });
  const alpha = opt(def, "alpha", 0.05) as number;
  const tables: ResultTable[] = [{ id: "sizes", title: "Segment sizes", columns: [{ key: "s", label: "Segment" }, { key: "n", label: "n", type: "count" }, { key: "wn", label: "Weighted n", type: "number", decimals: 1 }, { key: "pct", label: "% of base", type: "pct", decimals: 1 }], rows: segs.map(({ segment, data }) => ({ s: segment.name, n: data.cases.length, wn: round(weightedN(data), 1), pct: pct(ds.cases.length ? (data.cases.length / ds.cases.length) * 100 : 0) })), base: { n: ds.cases.length } }];
  const tests: TestResult[] = [];
  const insights: string[] = [];
  const chartSeries: NonNullable<ChartData["series"]> = segs.map(({ segment }) => ({ name: segment.name, values: [] as (number | null)[] }));
  const chartCats: string[] = [];
  for (const v of expandBattery(ds, def.variables)) {
    const meta = ds.byName.get(v);
    if (!meta) continue;
    if (meta.role === "numeric" || meta.role === "scale") {
      const groups = segs.map(({ data }) => numericColumn(data, v).filter((x): x is number => x != null));
      const means = groups.map((g, i) => describe(g, weights(segs[i].data)));
      const t = groups.filter((g) => g.length > 1).length >= 2 ? (groups.length === 2 ? independentT(groups[0], groups[1]) : oneWayAnova(groups.map((g, i) => ({ label: segs[i].segment.name, values: g })))) : null;
      if (t) { t.note = labelOf(ds, v); tests.push(t); }
      tables.push({ id: `seg_${v}`, title: `${labelOf(ds, v)} — mean by segment`, columns: [{ key: "s", label: "Segment" }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "sd", label: "SD", type: "number", decimals: 2 }], rows: segs.map(({ segment }, i) => ({ s: segment.name, n: means[i].n, mean: round(means[i].mean), sd: round(means[i].sd) })), notes: t ? [`${TEST_LABEL[t.test] ?? t.test}: p ${fmtP(t.p)}`] : undefined });
      chartCats.push(labelOf(ds, v));
      means.forEach((m, i) => chartSeries[i].values.push(round(m.mean)));
      const hi = means.map((m, i) => ({ m: m.mean ?? 0, s: segs[i].segment.name })).sort((a, b) => b.m - a.m);
      if (t && t.p != null && t.p < alpha) insights.push(`${labelOf(ds, v)} differs significantly by segment (p ${fmtP(t.p)}): ${hi[0].s} highest (${fmtNum(hi[0].m, 2)}), ${hi[hi.length - 1].s} lowest (${fmtNum(hi[hi.length - 1].m, 2)}).`);
    } else if (meta.role === "categorical" || meta.role === "multi") {
      const cats = categoriesOf(ds, v);
      const fs = segs.map(({ data }) => frequencies(categoricalColumn(data, v), weights(data), cats));
      const table = cats.map((c) => fs.map((f) => f.rows.find((r) => r.code === c.code)?.count ?? 0)).filter((r) => r.some(Boolean));
      const t = table.length >= 2 && fs.length >= 2 && meta.role !== "multi" ? chiSquare(table) : null;
      if (t) { t.note = labelOf(ds, v); tests.push(t); }
      tables.push({ id: `seg_${v}`, title: `${labelOf(ds, v)} by segment (column %)`, columns: [{ key: "cat", label: labelOf(ds, v) }, ...segs.map(({ segment }, i) => ({ key: `s${i}`, label: segment.name, type: "pct" as const, decimals: 1 }))], rows: cats.map((c) => ({ cat: c.label, ...Object.fromEntries(fs.map((f, i) => [`s${i}`, pct(f.rows.find((r) => r.code === c.code)?.validPct ?? 0)])) })), columnBases: Object.fromEntries(fs.map((f, i) => [`s${i}`, f.valid])), notes: t ? [`χ² p ${fmtP(t.p)}`] : undefined });
      if (chartCats.length === 0 && def.variables.length === 1) { chartCats.push(...cats.map((c) => c.label)); fs.forEach((f, i) => { chartSeries[i].values = cats.map((c) => pct(f.rows.find((r) => r.code === c.code)?.validPct ?? 0)); }); }
      else { const top = cats[0]; chartCats.push(`${labelOf(ds, v)}: ${top?.label ?? ""}`); fs.forEach((f, i) => chartSeries[i].values.push(pct(f.rows.find((r) => r.code === top?.code)?.validPct ?? 0))); }
      if (t && t.p != null && t.p < alpha) insights.push(`${labelOf(ds, v)} distribution differs significantly by segment (χ² p ${fmtP(t.p)}).`);
    }
  }
  if (!insights.length) insights.push(`No significant differences between segments were found at α = ${alpha}.`);
  return makeResult(def, ds, { tables, chart: { categories: chartCats, series: chartSeries, kpis: segs.map(({ segment, data }) => ({ label: segment.name, value: data.cases.length })) }, tests, insights, recommendedCharts: ["segment_comparison", "radar_segment", "segment_heatmap", "bar_grouped", "segment_size"], totalCases });
}

/* ============================================================ weighting */

export function weighting(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const info = ds.weightInfo;
  const tables: ResultTable[] = [];
  const warnings: string[] = [];
  if (!ds.weighted) warnings.push("No weighting is configured on this analysis — showing unweighted profile. Add rim targets or a weight variable in the Weighting step.");
  const targets = def.weighting?.rim ?? [];
  const rows: Record<string, unknown>[] = [];
  const cats: string[] = [], unw: (number | null)[] = [], wtd: (number | null)[] = [], tgt: (number | null)[] = [];
  for (const t of targets) {
    const frame = categoriesOf(ds, t.variable);
    const fu = frequencies(categoricalColumn(ds, t.variable), undefined, frame), fw = frequencies(categoricalColumn(ds, t.variable), weights(ds), frame);
    const sum = Object.values(t.targets).reduce((a, b) => a + b, 0) || 1;
    for (const c of frame) {
      const target = t.targets[c.code] != null ? (t.targets[c.code] / sum) * 100 : null;
      const u = fu.rows.find((r) => r.code === c.code)?.validPct ?? 0, w = fw.rows.find((r) => r.code === c.code)?.validPct ?? 0;
      rows.push({ variable: labelOf(ds, t.variable), category: c.label, unweighted: pct(u), weighted: pct(w), target, diff: target == null ? null : pct(w - target) });
      cats.push(`${labelOf(ds, t.variable)}: ${c.label}`); unw.push(pct(u)); wtd.push(pct(w)); tgt.push(target == null ? null : pct(target));
    }
  }
  if (rows.length) tables.push({ id: "targets", title: "Sample profile vs targets", columns: [{ key: "variable", label: "Variable" }, { key: "category", label: "Category" }, { key: "unweighted", label: "Unweighted %", type: "pct", decimals: 1 }, { key: "weighted", label: "Weighted %", type: "pct", decimals: 1 }, { key: "target", label: "Target %", type: "pct", decimals: 1 }, { key: "diff", label: "Weighted − target", type: "pct", decimals: 1 }], rows });
  if (info) tables.push({ id: "diag", title: "Weight diagnostics", columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 3 }], rows: [{ stat: "Weighting efficiency %", value: round(info.efficiency, 1) }, { stat: "Design effect", value: round(info.designEffect, 3) }, { stat: "Effective n", value: Math.round(ds.cases.length / info.designEffect) }, { stat: "Min weight", value: round(info.min, 3) }, { stat: "Max weight", value: round(info.max, 3) }, { stat: "Converged", value: info.converged ? "yes" : "no" }] });
  const ws = ds.cases.map((c) => c.weight);
  const d = describe(ws);
  tables.push({ id: "dist", title: "Weight distribution", columns: [{ key: "stat", label: "Statistic" }, { key: "value", label: "Value", type: "number", decimals: 3 }], rows: [{ stat: "n", value: d.n }, { stat: "Mean", value: round(d.mean, 3) }, { stat: "SD", value: round(d.sd, 3) }, { stat: "Min", value: round(d.min, 3) }, { stat: "p5", value: round(d.percentiles.p5, 3) }, { stat: "Median", value: round(d.median, 3) }, { stat: "p95", value: round(d.percentiles.p95, 3) }, { stat: "Max", value: round(d.max, 3) }] });
  const insights = info ? [`Weighting efficiency ${fmtPct(info.efficiency, 0)} (design effect ${fmtNum(info.designEffect, 2)}; effective n ≈ ${Math.round(ds.cases.length / info.designEffect)} of ${ds.cases.length}). Weights range ${fmtNum(info.min, 2)}–${fmtNum(info.max, 2)}.${info.converged ? "" : " Rim weighting did not fully converge — targets may be inconsistent."}`] : [];
  if (info && info.efficiency < 70) warnings.push("Efficiency below 70% — consider relaxing targets or capping weights.");
  return makeResult(def, ds, { tables, chart: { categories: cats, series: [{ name: "Unweighted", values: unw }, { name: "Weighted", values: wtd }, { name: "Target", values: tgt }], valueFormat: "pct", kpis: info ? [{ label: "Efficiency", value: round(info.efficiency, 0) ?? 0, unit: "%" }, { label: "Design effect", value: round(info.designEffect, 2) ?? 1 }] : undefined }, insights, warnings, recommendedCharts: ["bar_grouped", "histogram", "kpi_card", "dot_plot"], totalCases });
}

/* ============================================================ data quality */

export function quality(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const n = ds.cases.length;
  const classes = frequencies(ds.cases.map((c) => c.quality?.classification ?? "UNASSESSED"), undefined, null);
  const dur = describe(ds.cases.map((c) => c.durationSec));
  const speedThreshold = opt(def, "speedSeconds", dur.median != null ? dur.median * 0.4 : 0) as number;
  const speeders = ds.cases.filter((c) => c.durationSec != null && c.durationSec < speedThreshold).length;
  const qs = describe(ds.cases.map((c) => c.quality?.qualityScore ?? null));
  const rs = describe(ds.cases.map((c) => c.quality?.riskScore ?? null));
  // missingness per variable (non-derived, non-complex)
  const vars = ds.variables.filter((v) => !v.derived && v.role !== "complex" && v.role !== "system" && v.optionCode == null);
  const missing = vars.map((v) => ({ v: v.label, name: v.name, missing: n ? (ds.cases.filter((c) => c.vars[v.name] == null || c.vars[v.name] === "" || (Array.isArray(c.vars[v.name]) && !(c.vars[v.name] as unknown[]).length)).length / n) * 100 : 0 })).sort((a, b) => b.missing - a.missing);
  // straight-lining on matrix batteries: identical answers across all rows
  const batteries = new Map<string, string[]>();
  for (const v of ds.variables) if (v.rowCode != null && !v.derived && (v.role === "scale" || v.role === "categorical") && v.questionId) batteries.set(v.questionId, [...(batteries.get(v.questionId) ?? []), v.name]);
  const straight: { q: string; pct: number }[] = [];
  for (const [qid, names] of batteries) {
    if (names.length < 3) continue;
    const q = ds.def.questions.find((x) => x.id === qid);
    const hits = ds.cases.filter((c) => { const vals = names.map((nm) => c.vars[nm]).filter((x) => x != null); return vals.length === names.length && new Set(vals.map(String)).size === 1; }).length;
    straight.push({ q: q?.code ?? qid, pct: n ? (hits / n) * 100 : 0 });
  }
  // duplicates by respondent code / identical answer signature
  const sigs = new Map<string, number>();
  for (const c of ds.cases) { const s = JSON.stringify(c.answers); sigs.set(s, (sigs.get(s) ?? 0) + 1); }
  const dupes = [...sigs.values()].filter((x) => x > 1).reduce((t, x) => t + x - 1, 0);
  const flagCounts = new Map<string, number>();
  for (const c of ds.cases) for (const f of c.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  const tables: ResultTable[] = [
    { id: "summary", title: "Data quality summary", columns: [{ key: "m", label: "Metric" }, { key: "v", label: "Value" }], rows: [{ m: "Responses", v: n }, { m: "Median duration (s)", v: round(dur.median, 0) }, { m: `Speeders (< ${Math.round(speedThreshold)} s)`, v: `${speeders} (${fmtPct(n ? (speeders / n) * 100 : 0, 1)})` }, { m: "Mean quality score", v: round(qs.mean, 1) }, { m: "Mean risk score", v: round(rs.mean, 1) }, { m: "Duplicate answer signatures", v: dupes }, ...classes.rows.map((r) => ({ m: `Class: ${r.label}`, v: `${r.count} (${fmtPct(r.validPct, 1)})` }))] },
    { id: "missing", title: "Missing data by variable (top 25)", columns: [{ key: "v", label: "Variable" }, { key: "name", label: "Name" }, { key: "missing", label: "Missing %", type: "pct", decimals: 1 }], rows: missing.slice(0, 25).map((m) => ({ ...m, missing: pct(m.missing) })) },
  ];
  if (straight.length) tables.push({ id: "straight", title: "Straight-lining by matrix question", columns: [{ key: "q", label: "Question" }, { key: "pct", label: "Straight-lined %", type: "pct", decimals: 1 }], rows: straight.map((s) => ({ q: s.q, pct: pct(s.pct) })) });
  if (flagCounts.size) tables.push({ id: "flags", title: "Response flags", columns: [{ key: "f", label: "Flag" }, { key: "n", label: "n", type: "count" }, { key: "pct", label: "%", type: "pct", decimals: 1 }], rows: [...flagCounts].sort((a, b) => b[1] - a[1]).map(([f, c]) => ({ f, n: c, pct: pct(n ? (c / n) * 100 : 0) })) });
  const insights = [`${n} responses; median completion ${fmtNum(dur.median, 0)} s; ${fmtPct(n ? (speeders / n) * 100 : 0, 1)} speeders${classes.rows.some((r) => r.code !== "CLEAN" && r.code !== "UNASSESSED") ? `; ${fmtPct(classes.rows.filter((r) => r.code !== "CLEAN" && r.code !== "UNASSESSED").reduce((t, r) => t + r.validPct, 0), 1)} classified as other than clean` : ""}.`];
  if (missing[0] && missing[0].missing > 20) insights.push(`Highest missingness: ${missing[0].v} (${fmtPct(missing[0].missing, 1)}).`);
  if (straight.some((s) => s.pct > 10)) insights.push(`Straight-lining above 10% on ${straight.filter((s) => s.pct > 10).map((s) => s.q).join(", ")}.`);
  if (dupes) insights.push(`${dupes} responses share an identical answer set with another response.`);
  return makeResult(def, ds, {
    tables, chart: { categories: classes.rows.map((r) => r.label), series: [{ name: "Responses", values: classes.rows.map((r) => r.count) }], kpis: [{ label: "Responses", value: n }, { label: "Speeders", value: speeders }, { label: "Mean quality", value: round(qs.mean, 0) ?? 0 }, { label: "Duplicates", value: dupes }] },
    insights, recommendedCharts: ["kpi_card", "donut", "bar_horizontal", "histogram"], totalCases,
  });
}
