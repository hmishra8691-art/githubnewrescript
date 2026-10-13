import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_CATALOG } from "./recommend.js";
import { CHART_PICTURE, chartPicture, isOwnPicture, onePerPicture } from "./chartPictures.js";
import { chartDecimals, chartFormatCode } from "./chartFormat.js";
import { adviseChart, rankedCharts, denominatorFor, basisLine } from "./questionChart.js";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { findingsFor } from "./findings.js";
import { buildPptx, pptxSubstitute } from "./export/pptx.js";
import { D, def, spec, synthRows } from "./analyses/fixture.js";
import type { AnalysisDefinition, ChartType, ReportDefinition } from "./types.js";

/**
 * ONE CHART SYSTEM (Data Analytics audit, Oct 2026 — Phase 3, C-3 … C-8, C-13).
 * One drawing per picture, one chooser every surface reads, one answer for the
 * decimals and the base line, and a PowerPoint that says when it drew
 * something else.
 */
const rows = synthRows();
const ds = buildDataset(def, rows, { spec });
const vars = variableMetadata(def);
const XT = (extra: Partial<AnalysisDefinition> = {}, options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "xt", kind: "crosstab", dataset: spec, variables: [], rows: ["SAT"], columns: ["GENDER"], options, ...extra } as AnalysisDefinition);

test("the registry: every alias points at a picture that is its own, in one hop", () => {
  for (const [alias, picture] of Object.entries(CHART_PICTURE) as [ChartType, ChartType][]) {
    assert.ok(isOwnPicture(picture), `${alias} → ${picture}: the target is not itself an alias`);
    assert.equal(chartPicture(alias), picture);
    assert.ok(CHART_CATALOG.some((c) => c.type === picture), `${picture} is a chart in the catalogue`);
  }
  for (const c of CHART_CATALOG) assert.equal(chartPicture(chartPicture(c.type)), chartPicture(c.type), `${c.type} resolves once`);
  assert.ok(CHART_CATALOG.filter((c) => isOwnPicture(c.type)).length < CHART_CATALOG.length, "the catalogue lists more names than there are drawings");
});

test("one entry per picture: a list with an alias and its picture keeps the better-ranked one only", () => {
  const ranked = [{ type: "ranking_bar" as ChartType }, { type: "bar_horizontal" as ChartType }, { type: "pie" as ChartType }, { type: "donut_nested" as ChartType }, { type: "donut" as ChartType }];
  assert.deepEqual(onePerPicture(ranked).map((r) => r.type), ["ranking_bar", "pie", "donut_nested"]);
});

test("one chooser: advice, the recommended list, the ranked list and the findings agree, for any analysis", () => {
  const defs: AnalysisDefinition[] = [D("descriptive", ["REGION"]), D("descriptive", ["CONSIDER"]), XT(), XT({ rows: ["REGION"], columns: ["GENDER"] }), XT({ rows: ["SAT"], columns: ["REGION"] })];
  for (const d of defs) {
    const r = runAnalysis(d, ds);
    const a = r.advice!;
    assert.ok(a, `${d.kind} ${d.rows ?? d.variables}: a result carries its advice`);
    assert.equal(chartPicture(r.recommendedCharts[0]), chartPicture(a.type), "the list the result recommends opens on the advised picture");
    assert.equal(chartPicture(rankedCharts(d, r, {})[0].type), chartPicture(a.type), "the ranked list the report and deck read opens on it too");
    assert.equal(a.alternatives[0].type, a.type, "the first alternative is the advised chart");
    const pics = a.alternatives.map((x) => chartPicture(x.type));
    assert.equal(new Set(pics).size, pics.length, "no picture is offered twice");
    const f = findingsFor(d, r);
    for (const x of f) if (x.chart) assert.equal(chartPicture(x.chart), chartPicture(a.type), "a finding draws what the app draws");
  }
});

/** a crosstab result reshaped to a given number of categories and series, to test the chooser at sizes the fixture does not reach */
const shaped = (cats: number, series: number) => {
  const d = XT({ rows: ["SAT"], columns: ["REGION"] });
  const r = runAnalysis(d, ds);
  const categories = Array.from({ length: cats }, (_, i) => `Row ${i + 1}`);
  const s = Array.from({ length: series }, (_, j) => ({ name: `Col ${j + 1}`, values: categories.map((_c, i) => (i * 7 + j * 3) % 40) }));
  return { d, r: { ...r, chart: { ...r.chart, categories, series: s, valueFormat: "pct" as const } } };
};

test("golden choices for a crosstab: bars while they can be read, a heat-map when they cannot, a table when nothing can", () => {
  const small = shaped(5, 2); assert.equal(chartPicture(adviseChart(small.d, small.r, vars).type), "bar_vertical");
  const mid = shaped(12, 8);
  const midAdvice = adviseChart(mid.d, mid.r, vars);
  assert.equal(midAdvice.type, "heatmap_crosstab", "12 × 8 = 96 cells");
  assert.ok(midAdvice.avoided.some((x) => /cannot be compared by eye/.test(x.why)), "and it says why bars were not chosen");
  const huge = shaped(30, 8);
  assert.equal(adviseChart(huge.d, huge.r, vars).type, "table", "30 × 8 = 240 cells");
  assert.ok(!adviseChart(huge.d, huge.r, vars).alternatives.some((x) => ["bar_grouped", "bar_vertical", "bar_horizontal"].includes(x.type)), "no bar chart among the alternatives either");
});

test("C-3 — decimals: what the researcher set, else the theme if it says so, else what the values call for", () => {
  const pct = { categories: ["a"], series: [{ name: "s", values: [12.4, 30.7] }], valueFormat: "pct" as const };
  const score = { categories: ["a"], series: [{ name: "s", values: [3.82, 4.1] }] };
  const counts = { categories: ["a"], series: [{ name: "s", values: [120, 85] }] };
  assert.equal(chartDecimals(pct), 0);
  assert.equal(chartDecimals(score), 1, "a mean is not rounded to 4");
  assert.equal(chartDecimals(counts), 0);
  assert.equal(chartDecimals(score, 2), 2, "the chart's own setting wins");
  assert.equal(chartDecimals(score, undefined, 0), 0, "a theme that sets it is obeyed");
  assert.equal(chartDecimals(pct, 9), 4, "bounded");
  assert.equal(chartFormatCode(1, true), '0.0"%"');
  assert.equal(chartFormatCode(0, false), "0");
});

test("C-3 — the stock themes no longer force zero decimals on every chart", async () => {
  const { DEFAULT_THEME } = await import("./types.js");
  const { THEME_PRESETS } = await import("./themes.js");
  assert.equal(DEFAULT_THEME.chart?.decimals, undefined);
  assert.ok(THEME_PRESETS.length >= 3);
  for (const t of THEME_PRESETS) assert.equal(t.chart?.decimals, undefined, t.name);
});

test("C-4 — the base line and denominator follow the measure the crosstab is in", () => {
  const out = (m: string) => { const d = XT({ measure: m as never }); const r = runAnalysis(d, ds); return r.advice!; };
  assert.match(out("pct_col").denominator, /in each column/);
  assert.match(out("pct_row").denominator, /in each row/);
  assert.match(out("count").denominator, /not shares/);
  assert.match(out("pct_col").basis!, /^Column % · n = /);
  assert.match(out("pct_row").basis!, /^Row % · n = /);
  assert.match(out("count").basis!, /^Counts · n = /);
  assert.match(basisLine({ kind: "descriptive", base: { total: 400, filtered: 400, n: 212, weightedN: 230, label: "All respondents" } }), /^n = 212 of 400 answered \(weighted 230\)$/);
  assert.match(denominatorFor({ kind: "descriptive", base: { total: 400, filtered: 400, n: 400, weightedN: 400, label: "All respondents" } }, "nominal"), /all 400 respondents/);
});

test("C-6 — a crosstab chart is drawn in the measure of its table", () => {
  const cell = (r: ReturnType<typeof runAnalysis>, cat: string, col: string) => r.tables[0].rows.find((x) => x.row === cat)![col] as number;
  for (const [measure, fmt] of [["pct_col", "pct"], ["pct_row", "pct"], ["pct_total", "pct"], ["count", "number"]] as const) {
    const r = runAnalysis(XT({ measure }), ds);
    assert.equal(r.chart.valueFormat, fmt, measure);
    const cats = r.chart.categories!;
    for (const s of r.chart.series!) {
      const col = r.tables[0].columns.find((c) => c.label.startsWith(s.name))!.key;
      cats.forEach((cat, i) => assert.ok(Math.abs((s.values[i] as number) - cell(r, cat, col)) < 0.51, `${measure}: ${cat} / ${s.name} — the bar is the number in the table (${s.values[i]} vs ${cell(r, cat, col)})`));
    }
  }
  const row = runAnalysis(XT({ measure: "pct_row" }), ds);
  const sums = row.chart.categories!.map((_c, i) => row.chart.series!.every((s) => s.values[i] == null) ? null : row.chart.series!.reduce((a, s) => a + ((s.values[i] as number) ?? 0), 0));
  assert.ok(sums.some((x) => x != null));
  for (const sum of sums) if (sum != null) assert.ok(Math.abs(sum - 100) < 1.5, "row percentages across the columns add to 100");
});

test("C-13 — a column the table suppresses for a small base is not drawn, and the chart says so", () => {
  const r = runAnalysis(XT({ rows: ["SAT"], columns: ["REGION"] }, { minBase: 130 }), ds);
  const suppressed = r.tables[0].columns.filter((c) => /\*$/.test(c.label)).map((c) => c.label.replace(/ \(\w\)/, "").replace(" *", ""));
  assert.ok(suppressed.length > 0, "the fixture has a region below 130 respondents");
  for (const name of suppressed) assert.ok(!r.chart.series!.some((s) => s.name === name), `${name} is not a bar`);
  assert.ok(r.warnings.some((w) => /left out of the chart/.test(w)));
  const none = runAnalysis(XT({ rows: ["SAT"], columns: ["REGION"] }), ds);
  assert.ok(none.chart.series!.length > r.chart.series!.length, "without the minimum all columns are drawn");
  assert.ok(!none.warnings.some((w) => /left out of the chart/.test(w)));
});

test("C-8 — PowerPoint says when it drew something else", async () => {
  assert.equal(pptxSubstitute("bar_vertical"), null);
  assert.equal(pptxSubstitute("column_clustered"), null, "an alias of a drawing PowerPoint has is not a substitution");
  assert.equal(pptxSubstitute("ranking_bar"), null);
  assert.equal(pptxSubstitute("forest")?.as, "bars");
  assert.equal(pptxSubstitute("coefficient_plot")?.as, "bars", "an alias inherits its picture's answer");
  assert.equal(pptxSubstitute("heatmap_crosstab")?.as, "a table");
  assert.equal(pptxSubstitute("table"), null);
  const r = runAnalysis(XT(), ds);
  const deck = (type: ChartType) => { const rep: ReportDefinition = { title: "T", mode: "snapshot", blocks: [{ id: "c", type: "chart", analysisId: "a1", chart: { type, options: {} } }] }; return buildPptx({ report: rep, results: { a1: r }, meta: {} }).then((b) => b.toString("latin1")); };
  assert.doesNotMatch(await deck("bar_grouped"), /PowerPoint has no/, "a drawing PowerPoint has says nothing");
  assert.match(await deck("forest"), /Shown as bars.{1,6}PowerPoint has no forest chart/s);
  assert.match(await deck("heatmap_crosstab"), /Shown as a table.{1,6}PowerPoint has no heat-map chart/s);
});
