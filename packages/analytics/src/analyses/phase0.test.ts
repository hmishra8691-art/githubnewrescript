import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { proportionCI } from "../stats/tests.js";
import type { AnalysisDefinition } from "../types.js";
import { def, synthRows } from "./fixture.js";

/**
 * PHASE 0 of the Data Analytics roadmap — the audit's confirmed statistical and chart defects (S-1 … S-5, I-1, C-1, C-2).
 * Each test fails on the code as it was before the fix (checked by reverting the fix).
 */
const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: dsSpec, variables, ...extra });

test("S-2: a weighted proportion's interval is built from the weighted estimate and the effective n, and contains it", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  ds.cases.forEach((c) => { c.weight = Number(c.vars.GENDER) === 2 ? 3 : 0.5; });
  ds.weighted = true;
  const r = runAnalysis(D("descriptive", ["GENDER"]), ds);
  const s = r.chart.series![0];
  s.values.forEach((v, i) => {
    const ci = s.ci![i]!; assert.ok(ci[0] <= (v as number) && (v as number) <= ci[1], `interval ${ci} contains ${v}`);
  });
  const women = r.chart.categories!.findIndex((_, i) => (s.values[i] as number) > 60);
  assert.ok(women >= 0, "weighted women are the majority");
  // the old interval was the unweighted one (about 47–57 for a 52% sample) and did not contain 86.7%
  assert.ok((s.ci![women]![0]) > 75, `weighted interval is centred on the weighted share: ${s.ci![women]}`);
  // wider than the interval an unweighted base of the same size would have, because the effective n is smaller
  const n = ds.cases.length;
  const naive = proportionCI(((s.values[women] as number) / 100) * n, n)!;
  assert.ok((s.ci![women]![1] - s.ci![women]![0]) > (naive[1] - naive[0]) * 100, "design effect widens the interval");
});

test("S-2: the confidence option is honoured at any level", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  const width = (conf: number) => { const s = runAnalysis(D("descriptive", ["GENDER"], { options: { confidence: conf } }), ds).chart.series![0]; return s.ci![0]![1] - s.ci![0]![0]; };
  assert.ok(width(0.99) > width(0.95) && width(0.95) > width(0.9) && width(0.9) > width(0.8));
  const a = proportionCI(50, 100, 0.8)!, b = proportionCI(50, 100, 0.9)!;
  assert.ok(Math.abs((b[1] - b[0]) - (a[1] - a[0])) > 0.01, "0.8 is no longer silently treated as 0.9");
});

test("S-5: the base and the low-base warning count the respondents who answered, not everyone in the dataset", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  ds.cases.forEach((c, i) => { if (i >= 8) c.vars.NPS = null; });
  const r = runAnalysis(D("nps", ["NPS"]), ds);
  assert.equal(r.base.total, 400);
  assert.equal(r.base.n, 8, "the base is the 8 who answered");
  assert.ok(r.warnings.some((w) => /only 8 respondents/.test(w)), `low-base warning fires on the valid n: ${r.warnings.join(" | ")}`);
  const d = runAnalysis(D("descriptive", ["NPS"]), ds);
  assert.equal(d.base.n, 8);
});

test("S-5: weighted base is the weighted answered cases", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  ds.cases.forEach((c, i) => { c.weight = 2; if (i >= 100) c.vars.NPS = null; });
  ds.weighted = true;
  const r = runAnalysis(D("nps", ["NPS"]), ds);
  assert.equal(r.base.n, 100);
  assert.equal(r.base.weightedN, 200);
});

test("S-5: an analysis whose variables are not dataset variables keeps the dataset base", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  const r = runAnalysis(D("descriptive", ["GENDER"]), ds);
  assert.equal(r.base.n, 400);
});

import { ols, logistic } from "../stats/regression.js";
import { mulberry32 } from "@rescript/engine";

test("S-4: near-collinear predictors are refused whatever their units; strong overlap is reported as a VIF warning", () => {
  const r = mulberry32(5); const n = 200;
  const x1 = Array.from({ length: n }, () => r() * 10), x3 = Array.from({ length: n }, () => r() * 10);
  const y = x1.map((v, i) => v + 0.5 * x3[i] + r());
  assert.ok("error" in ols(y, { predictors: [{ name: "a", values: x1 }, { name: "b", values: x1.map((v) => v * 2) }] }), "exact multiple");
  assert.ok("error" in ols(y, { predictors: [{ name: "a", values: x1 }, { name: "b", values: x1.map((v) => v * 2_000_000) }] }), "the same multiple in millions (the old absolute pivot test accepted it)");
  assert.ok("error" in ols(y, { predictors: [{ name: "a", values: x1 }, { name: "b", values: x1.map((v) => v * 0.000002) }] }), "the same multiple in millionths (the old test rejected for the wrong reason)");
  const near = ols(y, { predictors: [{ name: "a", values: x1 }, { name: "b", values: x1.map((v) => v + r() * 0.15) }, { name: "c", values: x3 }] });
  assert.ok(!("error" in near));
  if (!("error" in near)) { assert.ok(near.vif.a > 10 && near.vif.b > 10 && near.vif.c < 2); assert.ok(near.warnings.some((w) => /overlaps strongly/.test(w))); }
  const fine = ols(y, { predictors: [{ name: "a", values: x1 }, { name: "c", values: x3 }] });
  assert.ok(!("error" in fine) && fine.warnings.length === 0, "well-behaved predictors get no warning");
});

test("S-4: a perfectly separated logistic regression is an error, not a 6.5e11 odds ratio", () => {
  const x = Array.from({ length: 60 }, (_, i) => i), y = x.map((v) => (v >= 30 ? 1 : 0));
  const fit = logistic(y, { predictors: [{ name: "x", values: x }] });
  assert.ok("error" in fit, JSON.stringify("error" in fit ? fit : { converged: fit.converged }));
  // overlap in the groups: a normal fit still converges
  const r = mulberry32(9); const xs = Array.from({ length: 300 }, () => r() * 4 - 2), ys = xs.map((v) => (r() < 1 / (1 + Math.exp(-1.2 * v)) ? 1 : 0));
  const ok = logistic(ys, { predictors: [{ name: "x", values: xs }] });
  assert.ok(!("error" in ok) && ok.converged);
});

import { findingsFor } from "../findings.js";

test("I-1: a crosstab with several rows headlines each test with its own row and banner", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  const d: AnalysisDefinition = { name: "Profile", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["REGION", "SAT", "NPS"], columns: ["GENDER"] };
  const result = runAnalysis(d, ds);
  const label = (v: string) => ({ REGION: "Region", SAT: "Overall satisfaction", NPS: "Recommend", GENDER: "Gender" } as Record<string, string>)[v] ?? v;
  const fs = findingsFor(d, result, { label });
  assert.equal(fs.length, result.tests.length);
  const heads = fs.map((f) => f.headline);
  assert.ok(heads[0].startsWith("Region by Gender"), heads[0]);
  assert.ok(heads[1].startsWith("Overall satisfaction by Gender"), heads[1]);
  assert.ok(heads[2].startsWith("Recommend by Gender"), heads[2]);
  assert.deepEqual(fs.map((f) => f.variables), [["REGION", "GENDER"], ["SAT", "GENDER"], ["NPS", "GENDER"]]);
});

test("I-1: two banner variables are not mixed up either", () => {
  const ds = buildDataset(def, synthRows(400), { spec: dsSpec });
  const d: AnalysisDefinition = { name: "Profile", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["SAT", "REGION"], columns: ["GENDER", "COUNTRY"] };
  const fs = findingsFor(d, runAnalysis(d, ds), { label: (v) => v });
  const pairs = fs.map((f) => f.variables.join("|")).sort();
  assert.deepEqual(pairs, ["REGION|COUNTRY", "REGION|GENDER", "SAT|COUNTRY", "SAT|GENDER"]);
});
