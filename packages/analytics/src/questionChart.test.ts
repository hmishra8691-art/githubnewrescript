import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { adviseChart, checkChartChoice, scaleOf, looksOrdered, denominatorFor } from "./questionChart.js";
import type { AnalysisDefinition } from "./types.js";
import { def, synthRows } from "./analyses/fixture.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const rows = synthRows();
const ds = buildDataset(def, rows, { spec });
const vars = variableMetadata(def);
const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: spec, variables, ...extra } as AnalysisDefinition);
const advise = (d: AnalysisDefinition, data = ds) => { const r = runAnalysis(d, data); return { r, a: adviseChart(d, r, vars) }; };

test("scaleOf reads the structure from the dictionary", () => {
  const by = (n: string) => scaleOf(vars.find((v) => v.name === n));
  assert.equal(by("GENDER"), "nominal");
  assert.equal(by("REGION"), "nominal");
  assert.equal(by("SAT"), "ordinal", "a 1–5 satisfaction scale is ordered");
  assert.equal(by("AGE"), "numeric");
  assert.equal(by("CONSIDER"), "multi");
  assert.equal(by("TEXT"), "text");
  assert.equal(looksOrdered([{ code: "1", label: "North" }, { code: "2", label: "South" }, { code: "3", label: "East" }]), false);
  assert.equal(looksOrdered([{ code: "1", label: "Very unlikely" }, { code: "2", label: "Unlikely" }, { code: "3", label: "Likely" }, { code: "4", label: "Very likely" }]), true);
});

test("a multiple-choice question gets horizontal bars, never a pie, and an explicit denominator", () => {
  const { a } = advise(D("descriptive", ["CONSIDER"]));
  assert.equal(a.scale, "multi");
  assert.equal(a.type, "bar_horizontal");
  assert.ok(a.avoided.some((x) => x.type === "pie" || x.type === "donut" || x.type === "bar_stacked_100") || !a.alternatives.some((x) => x.type === "pie"));
  assert.ok(!a.alternatives.some((x) => x.type === "pie" || x.type === "donut"), "no pie among the alternatives");
  assert.match(a.denominator, /several answers were allowed.*more than 100%/);
  assert.ok(a.notes.some((n) => /more than 100%/.test(n)));
});

test("a categorical question is never offered a mean chart or a line", () => {
  const { a } = advise(D("descriptive", ["REGION"]));
  assert.equal(a.scale, "nominal");
  for (const bad of ["mean_ci", "ci_plot", "line", "area", "spline"] as const) assert.ok(!a.alternatives.some((x) => x.type === bad), `${bad} offered for a categorical question`);
  assert.match(a.reason, /categorical question/);
});

test("a numeric answer is shown as a distribution", () => {
  const { r, a } = advise(D("descriptive", ["AGE"]));
  assert.equal(a.scale, "numeric");
  assert.ok(["histogram", "box_plot", "bar_vertical", "bar_horizontal"].includes(a.type), `got ${a.type}`);
  assert.ok(!a.alternatives.some((x) => x.type === "pie"));
  assert.ok(r.base.n > 0);
});

test("a scale question keeps its order: bars in scale order, no pie", () => {
  const { a } = advise(D("descriptive", ["SAT"]));
  assert.equal(a.scale, "ordinal");
  assert.ok(!a.alternatives.some((x) => x.type === "pie" || x.type === "donut"));
  assert.ok(a.notes.some((n) => /scale order|keep their order/i.test(n)));
});

test("a thin base is flagged and never gets a pie", () => {
  const thin = buildDataset(def, rows.slice(0, 20), { spec });
  const { a } = advise(D("descriptive", ["GENDER"]), thin);
  assert.ok(a.notes.some((n) => /Only \d+ respondents/.test(n)), a.notes.join("|"));
  assert.ok(!a.alternatives.some((x) => x.type === "pie" || x.type === "donut"));
});

test("a crosstab states what the percentages are of", () => {
  const { a, r } = advise(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }));
  assert.match(a.denominator, new RegExp(`${r.base.n}`));
  assert.ok(a.alternatives.length > 0);
});

test("denominatorFor says so when nobody answered", () => {
  assert.match(denominatorFor({ kind: "descriptive", base: { total: 40, filtered: 40, n: 0, weightedN: 0, label: "All respondents" } }, "nominal"), /No respondents/);
  assert.match(denominatorFor({ kind: "descriptive", base: { total: 400, filtered: 400, n: 212, weightedN: 212, label: "All respondents" } }, "nominal"), /the 212 of 400 respondents who answered/);
});

test("checkChartChoice: a saved choice survives unless the data cannot draw it", () => {
  const r = runAnalysis(D("descriptive", ["GENDER"]), ds);
  assert.equal(checkChartChoice(r, "bar_vertical").valid, true);
  assert.equal(checkChartChoice(r, "table").valid, true);
  const bad = checkChartChoice(r, "word_cloud");
  assert.equal(bad.valid, false);
  assert.ok(bad.fallback && bad.reason && /cannot draw this result/.test(bad.reason));
});

test("a single-choice list with numeric or scale-worded answers is a scale; a list of places is not", () => {
  const cat = (labels: string[]) => ({ role: "categorical" as const, questionType: "single_select", categories: labels.map((l, i) => ({ code: String(i + 1), label: l })) });
  assert.equal(scaleOf(cat(["1", "2", "3", "4", "5"])), "ordinal");
  assert.equal(scaleOf(cat(["Very poor", "Poor", "Fair", "Good", "Very good"])), "ordinal");
  assert.equal(scaleOf(cat(["North", "South", "East", "West"])), "nominal");
});

test("no line through unordered categories, even when a runner suggests one", () => {
  const r = runAnalysis(D("descriptive", ["REGION"]), ds);
  const withLine = { ...r, recommendedCharts: ["line" as const, "line_multi" as const, "bar_vertical" as const] };
  const a = adviseChart(D("descriptive", ["REGION"]), withLine, vars);
  assert.ok(!a.alternatives.some((x) => x.type === "line" || x.type === "line_multi"), a.alternatives.map((x) => x.type).join(","));
  assert.ok(a.avoided.some((x) => x.type === "line" && /order/.test(x.why)));
  // …but ordered periods do get a line
  const waves = { ...r, kind: "trend" as const, chart: { ...r.chart, categories: ["2026-01", "2026-02", "2026-03"], series: [{ name: "x", values: [1, 2, 3] }] } };
  assert.equal(adviseChart(D("trend", ["REGION"]), waves, vars).type, "line");
});

test("no line for a numeric answer's bins either (they are not periods)", () => {
  const r = runAnalysis(D("descriptive", ["AGE"]), ds);
  const a = adviseChart(D("descriptive", ["AGE"]), { ...r, recommendedCharts: ["line" as const, "area" as const, "histogram" as const] }, vars);
  assert.ok(!a.alternatives.some((x) => x.type === "line" || x.type === "area"), a.alternatives.map((x) => x.type).join(","));
});
