import { test } from "node:test";
import assert from "node:assert/strict";
import { chiSquareP, fTestP, normalCdf, normalQuantile, tCdf, tQuantile } from "./distributions.js";
import { boxShares, describe, frequencies } from "./descriptive.js";
import { chiSquare, fisherExact, friedman, independentT, kruskalWallis, mannWhitney, oneSampleT, oneWayAnova, pairedT, proportionCI, proportionTest, significanceLetters, twoWayAnova, wilcoxonSignedRank } from "./tests.js";
import { correlate, correlationMatrix } from "./correlation.js";
import { logistic, mediation, multinomialLogistic, ols } from "./regression.js";
import { cronbachAlpha, factorAnalysis, hierarchical, kMeans, rimWeights, standardize } from "./multivariate.js";
import { inverse, symmetricEigen } from "./matrix.js";

/**
 * Reference values checked against R / scipy. Tolerances are loose enough for
 * the numerical methods used and tight enough that a wrong formula fails.
 */
const close = (a: number | null | undefined, b: number, tol = 1e-3, msg?: string) => {
  assert.ok(a != null && Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);
};

test("distributions match tabulated values", () => {
  close(normalCdf(1.959964), 0.975, 1e-5);
  close(normalCdf(-1), 0.158655, 1e-5);
  close(normalQuantile(0.975), 1.959964, 1e-4);
  close(tCdf(2.228, 10), 0.975, 1e-3);           // t crit 10 df
  close(tQuantile(0.975, 10), 2.228, 2e-3);
  close(chiSquareP(3.841, 1), 0.05, 1e-3);
  close(chiSquareP(7.815, 3), 0.05, 1e-3);
  close(fTestP(4.26, 2, 9), 0.05, 2e-3);         // F crit(2, 9)
});

test("describe: mean, sd, se, ci, median, percentiles, mode, missing", () => {
  const d = describe([2, 4, 4, 4, 5, 5, 7, 9, null, undefined]);
  assert.equal(d.n, 8); assert.equal(d.missing, 2);
  close(d.mean, 5); close(d.sd, 2.138, 1e-3); close(d.se, 0.756, 1e-3);
  assert.equal(d.median, 4.5); assert.equal(d.mode, 4); assert.equal(d.min, 2); assert.equal(d.max, 9); assert.equal(d.range, 7); assert.equal(d.sum, 40);
  close(d.quartiles[0], 4, 1e-9); close(d.quartiles[2], 5.5, 1e-9);
  close(d.ci95![0], 5 - 2.365 * 0.756, 5e-3);
  // weighted: doubling one case's weight moves the mean
  const w = describe([1, 2, 3], [1, 1, 2]);
  close(w.mean, 2.25); assert.equal(w.weightedN, 4);
});

test("frequencies: counts, percent of total vs valid, multi-select arrays, unknown codes appended", () => {
  const f = frequencies([1, 2, 2, null, [1, 2], 3], undefined, [{ code: "1", label: "A" }, { code: "2", label: "B" }]);
  assert.equal(f.n, 6); assert.equal(f.valid, 5); assert.equal(f.missing, 1);
  const a = f.rows.find((r) => r.code === "1")!, b = f.rows.find((r) => r.code === "2")!;
  assert.equal(a.count, 2); assert.equal(b.count, 3);
  close(b.pct, 50); close(b.validPct, 60);
  assert.ok(f.rows.some((r) => r.code === "3" && r.label === "3"), "a code outside the frame is still reported");
});

test("top/bottom box", () => {
  const b = boxShares([1, 2, 3, 4, 5, 5, 5, 4], undefined, [1, 2, 3, 4, 5]);
  close(b.top1, 37.5); close(b.top2, 62.5); close(b.bottom2, 25); close(b.top3, 75);
});

test("chi-square and Fisher on a 2×2", () => {
  const x = chiSquare([[30, 10], [20, 40]]);
  close(x.statistic, 16.667, 1e-2); assert.equal(x.df, 1); assert.ok(x.p! < 0.001); close(x.effectSize!.value, 0.408, 1e-2);
  const f = fisherExact(3, 1, 1, 3);
  close(f.p, 0.486, 1e-2);
  const f2 = fisherExact(10, 0, 0, 10); assert.ok(f2.p! < 0.001);
});

test("t-tests: one-sample, Welch, pooled, paired", () => {
  const one = oneSampleT([5.1, 4.9, 5.6, 5.8, 6.0, 5.2, 4.8, 5.5], 5);
  close(one.statistic, 2.3803, 1e-3); close(one.p, 0.0489, 1e-3);
  const a = [20, 22, 19, 24, 25, 21], b = [28, 30, 27, 32, 29, 31];
  const w = independentT(a, b);
  close(w.statistic, -6.3067, 1e-3); close(w.df as number, 9.5756, 1e-3); assert.ok(w.p! < 0.001); close(w.detail!.difference as number, -7.6667, 1e-3);
  const pooled = independentT(a, b, true); assert.equal(pooled.df, 10);
  const pr = pairedT([1, 2, 3, 4, 5], [2, 3, 4, 5, 7]);
  close(pr.statistic, -6, 1e-6); assert.equal(pr.df, 4);
});

test("ANOVA one-way / two-way, Kruskal, Mann-Whitney, Wilcoxon, Friedman", () => {
  const an = oneWayAnova([{ label: "a", values: [1, 2, 3] }, { label: "b", values: [2, 3, 4] }, { label: "c", values: [5, 6, 7] }]);
  close(an.statistic, 13, 1e-6); assert.deepEqual(an.df, [2, 6]); close(an.p, 0.0066, 1e-3); close(an.effectSize!.value, 0.8125, 1e-4);
  const tw = twoWayAnova([
    { a: "m", b: "x", y: 1 }, { a: "m", b: "x", y: 2 }, { a: "m", b: "y", y: 5 }, { a: "m", b: "y", y: 6 },
    { a: "f", b: "x", y: 2 }, { a: "f", b: "x", y: 3 }, { a: "f", b: "y", y: 6 }, { a: "f", b: "y", y: 7 },
  ]);
  close(tw.factorB.statistic, 64, 1e-9); assert.ok(tw.factorB.p! < 0.01, "B has a large effect"); assert.ok(tw.interaction.p! > 0.5, "no interaction");
  const kw = kruskalWallis([{ label: "a", values: [1, 2, 3] }, { label: "b", values: [7, 8, 9] }]);
  close(kw.statistic, 3.857, 1e-2);
  const mw = mannWhitney([1, 2, 3, 4], [6, 7, 8, 9]);
  assert.equal(mw.statistic, 0); close(mw.p, 0.0286, 1.5e-2, 'normal approximation of the exact 0.0286');
  const wx = wilcoxonSignedRank([10, 12, 14, 16, 18], [9, 11, 12, 15, 17]);
  assert.equal(wx.statistic, 0);
  const fr = friedman([[1, 2, 3], [1, 2, 3], [1, 3, 2], [1, 2, 3]]);
  close(fr.statistic, 6.5, 1e-6); assert.equal(fr.df, 2);
});

test("proportions: z-test, Wilson CI, significance letters", () => {
  const pt = proportionTest(60, 100, 40, 100);
  close(pt.statistic, 2.828, 1e-2); close(pt.p, 0.0047, 1e-3);
  const ci = proportionCI(50, 100)!; close(ci[0], 0.404, 1e-2); close(ci[1], 0.596, 1e-2);
  const letters = significanceLetters([72, 61, 30], [100, 100, 100]);
  assert.equal(letters[0], "c", "72% beats 30% (c) but not 61%");
  assert.equal(letters[1], "c"); assert.equal(letters[2], "");
});

test("correlation: Pearson, Spearman, Kendall, matrix", () => {
  const x = [1, 2, 3, 4, 5, 6], y = [2, 4, 5, 4, 5, 7];
  const p = correlate(x, y); close(p.r, 0.8783, 1e-3); close(p.p, 0.0213, 1e-3);
  const s = correlate(x, y, "spearman"); close(s.r, 0.8533, 1e-3);
  const k = correlate(x, y, "kendall"); close(k.r, 0.7877, 1e-3);
  const m = correlationMatrix([{ name: "x", values: x }, { name: "y", values: y }, { name: "z", values: x.map((v) => -v) }]);
  close(m.r[0][2], -1, 1e-9); close(m.r[0][1], 0.8783, 1e-3);
});

test("OLS recovers a known line and reports R², F and standardized betas", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8], z = [2, 1, 4, 3, 6, 5, 8, 7];
  const y = x.map((v, i) => 3 + 2 * v - 0.5 * z[i]);
  const m = ols(y, { predictors: [{ name: "x", values: x }, { name: "z", values: z }] });
  assert.ok(!("error" in m));
  close(m.coefficients[0].estimate, 3, 1e-6); close(m.coefficients[1].estimate, 2, 1e-6); close(m.coefficients[2].estimate, -0.5, 1e-6);
  close(m.r2, 1, 1e-9);
  const noisy = ols([1, 3, 2, 5, 4, 6, 8, 7], { predictors: [{ name: "x", values: x }] });
  assert.ok(!("error" in noisy)); close(noisy.r2, 0.8622, 1e-3); assert.ok(noisy.fP! < 0.01); assert.ok(noisy.coefficients[1].ci95![0] < noisy.coefficients[1].estimate);
  const inter = ols(y, { predictors: [{ name: "x", values: x }, { name: "z", values: z }], interactions: [["x", "z"]] });
  assert.ok(!("error" in inter) && inter.terms.includes("x × z"));
});

test("logistic and multinomial regression fit separable-ish data sensibly", () => {
  const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const y = [0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1];
  const m = logistic(y, { predictors: [{ name: "x", values: x }] });
  assert.ok(!("error" in m));
  assert.ok(m.coefficients[1].estimate > 0 && m.coefficients[1].oddsRatio! > 1);
  assert.ok(m.accuracy >= 0.8); assert.ok(m.mcFaddenR2 > 0.3 && m.mcFaddenR2 < 1);
  const cat = x.map((v) => (v < 4 ? "low" : v < 8 ? "mid" : "high"));
  const mn = multinomialLogistic(cat, { predictors: [{ name: "x", values: x }] });
  assert.ok(!("error" in mn)); assert.equal(mn.equations.length, 2); assert.ok(mn.mcFaddenR2 > 0.5);
});

test("mediation: full mediation shows indirect ≈ total and small direct", () => {
  const x = Array.from({ length: 40 }, (_, i) => i / 4);
  const m = x.map((v, i) => 2 * v + (i % 3) * 0.1);
  const y = m.map((v, i) => 1.5 * v + (i % 5) * 0.05);
  const r = mediation(x, m, y);
  assert.ok(!("error" in r));
  close(r.a.estimate, 2, 0.05); close(r.b.estimate, 1.5, 0.1); assert.ok(Math.abs(r.cPrime.estimate) < 0.3); assert.ok(r.sobelP! < 0.001);
});

test("k-means separates two obvious clouds; hierarchical agrees; silhouette is high", () => {
  const rows = [[0, 0], [0.1, 0.2], [0.2, 0], [-0.1, 0.1], [5, 5], [5.1, 5.2], [4.9, 5], [5.2, 4.8]];
  const km = kMeans(rows, 2, 7);
  assert.deepEqual(km.sizes.sort(), [4, 4]);
  assert.equal(km.assignments[0], km.assignments[3]); assert.notEqual(km.assignments[0], km.assignments[4]);
  assert.ok(km.silhouette! > 0.9);
  const h = hierarchical(rows, 2);
  assert.equal(h.assignments[0], h.assignments[1]); assert.notEqual(h.assignments[0], h.assignments[5]);
  assert.equal(h.merges.length, 7);
  const z = standardize(rows); close(z.means[0], 2.55, 1e-6);
});

test("PCA on two correlated blocks finds two factors; alpha of a coherent scale is high", () => {
  const n = 60;
  const f1 = Array.from({ length: n }, (_, i) => Math.sin(i)), f2 = Array.from({ length: n }, (_, i) => Math.cos(i * 1.7));
  const cols = [
    { name: "a1", values: f1.map((v, i) => v + 0.1 * ((i * 7) % 5) / 5) }, { name: "a2", values: f1.map((v, i) => 0.9 * v + 0.1 * ((i * 3) % 5) / 5) }, { name: "a3", values: f1.map((v) => 1.1 * v) },
    { name: "b1", values: f2.map((v, i) => v + 0.1 * ((i * 11) % 5) / 5) }, { name: "b2", values: f2.map((v) => 0.8 * v) }, { name: "b3", values: f2.map((v, i) => 1.2 * v + 0.05 * (i % 2)) },
  ];
  const fa = factorAnalysis(cols, { factors: 2 });
  assert.ok(!("error" in fa));
  assert.equal(fa.factors, 2); assert.ok(fa.cumulative[1] > 90, `two factors explain ${fa.cumulative[1]}%`);
  const f0 = fa.loadings.map((l) => Math.abs(l[0]) > Math.abs(l[1]) ? 0 : 1);
  assert.equal(new Set(f0.slice(0, 3)).size, 1); assert.equal(new Set(f0.slice(3)).size, 1); assert.notEqual(f0[0], f0[3]);
  assert.ok(fa.kmo! > 0.5);
  const rel = cronbachAlpha(cols.slice(0, 3));
  assert.ok(rel.alpha! > 0.95); assert.equal(rel.items, 3); assert.ok(rel.itemTotal.every((it) => it.correlation! > 0.9));
});

test("rim weighting hits marginal targets and reports efficiency", () => {
  const cases = [
    ...Array.from({ length: 70 }, () => ({ gender: "m", age: "young" })), ...Array.from({ length: 30 }, () => ({ gender: "f", age: "young" })),
    ...Array.from({ length: 40 }, () => ({ gender: "m", age: "old" })), ...Array.from({ length: 60 }, () => ({ gender: "f", age: "old" })),
  ];
  const w = rimWeights(cases, [{ variable: "gender", targets: { m: 50, f: 50 } }, { variable: "age", targets: { young: 40, old: 60 } }]);
  assert.ok(w.converged);
  for (const a of w.achieved) close(a.achieved, a.target, 1e-3, `${a.variable}=${a.category}`);
  assert.ok(w.efficiency > 0.85 && w.efficiency <= 1);
  close(w.weights.reduce((t, x) => t + x, 0) / w.weights.length, 1, 1e-9);
});

test("matrix helpers: inverse and symmetric eigen", () => {
  const inv = inverse([[4, 7], [2, 6]])!;
  close(inv[0][0], 0.6, 1e-9); close(inv[0][1], -0.7, 1e-9);
  const e = symmetricEigen([[2, 1], [1, 2]]);
  close(e.values[0], 3, 1e-9); close(e.values[1], 1, 1e-9);
  assert.equal(inverse([[1, 2], [2, 4]]), null, "singular");
});
