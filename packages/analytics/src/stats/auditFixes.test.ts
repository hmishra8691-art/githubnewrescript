import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionalLogit, type ChoiceSet } from "./choice.js";
import { erfc, normalCdf } from "./distributions.js";
import { proportionTest } from "./tests.js";
import { factorAnalysis } from "./multivariate.js";
import { mediation, multinomialLogistic, ols } from "./regression.js";

/**
 * Regression tests for the statistical-correctness audit of 2026-10-26
 * (claude/audit-statistics-2026-10-26.md, findings S1 and S3–S9; S2 and S7
 * live beside the models they belong to).
 *
 * Every test here fails against the code as it stood before that audit. They
 * assert the CORRECTED behaviour — a scipy value, an algebraic identity, a
 * brute-force optimum — rather than whatever the new code happens to emit,
 * because the point of the exercise was that several of the old tests pinned
 * the defect instead of the answer.
 */

const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tolerance ${tol})`);

/* ============================================================ S6 — Φ to double precision */

test("S6: Φ is accurate to 1e-15 and Φ(0) is exactly 0.5", () => {
  // the Abramowitz–Stegun polynomial this replaced returned 0.4999998255363571 at zero
  assert.equal(normalCdf(0), 0.5);
  // scipy.stats.norm.cdf, 17 significant figures
  const ref: [number, number][] = [
    [0.5, 0.69146246127401312], [1, 0.84134474606854293], [1.959963984540054, 0.97499999999999998],
    [2, 0.97724986805182079], [3, 0.9986501019683699], [5, 0.99999971334842808],
    [-1.5, 0.066807201268858071], [8, 0.99999999999999933],
  ];
  for (const [z, p] of ref) close(normalCdf(z), p, 5e-15, `Φ(${z})`);
  close(erfc(0.5), 0.47950012218695348, 1e-15, "erfc(0.5)");
  close(erfc(2.5), 0.00040695201744495886, 1e-18, "erfc(2.5)");
  // monotone and bounded across the whole range the tests use
  let prev = 0;
  for (let z = -8; z <= 8; z += 0.01) { const v = normalCdf(z); assert.ok(v >= prev && v <= 1, `Φ(${z}) = ${v}`); prev = v; }
});

test("S6: a two-sided p can never exceed 1", () => {
  // the reproduction from the audit: identical proportions gave p = 1.0000003489272857
  assert.equal(proportionTest(50, 100, 50, 100).p, 1);
  assert.equal(proportionTest(50, 100).p, 1);
  for (let x = 0; x <= 40; x++) {
    const r = proportionTest(x, 40, 40 - x, 40);
    assert.ok(r.p! >= 0 && r.p! <= 1, `two-sample p = ${r.p} at x = ${x}`);
    const o = proportionTest(x, 40);
    assert.ok(o.p! >= 0 && o.p! <= 1, `one-sample p = ${o.p} at x = ${x}`);
  }
});

test("S6: the proportion tests match statsmodels", () => {
  const a = proportionTest(50, 100, 40, 100);
  close(a.statistic!, 1.4213381090374024, 1e-14, "z");
  close(a.p!, 0.1552184896846841, 1e-14, "p");
  const b = proportionTest(5, 20, 15, 20);
  close(b.statistic!, -3.1622776601683791, 1e-14, "z");
  close(b.p!, 0.001565402258002548, 1e-15, "p");
  close(proportionTest(60, 100).p!, 0.045500263896358431, 1e-15, "one-sample p");
});

/* ============================================================ S9 — the F guard */

test("S9: a constant outcome yields no F rather than a negative one", () => {
  const m = ols([5, 5, 5, 5, 5], { predictors: [{ name: "x", values: [1, 2, 3, 4, 5] }] });
  assert.ok(!("error" in m));
  assert.equal(m.f, null, "F was -3, and fTestP(-3, 1, 3) = 1 presented it as 'not significant'");
  assert.equal(m.fP, null);
  assert.equal(m.r2, 0);
  assert.equal(m.adjustedR2, 0, "adjusted R² was -0.3333 for an outcome with no variance");
  const two = ols([7, 7, 7, 7, 7, 7], { predictors: [{ name: "x", values: [1, 2, 3, 4, 5, 6] }, { name: "z", values: [2, 1, 4, 3, 6, 5] }] });
  assert.ok(!("error" in two) && two.f === null);
  // a real model is untouched
  const ok = ols([1, 3, 2, 5, 4, 6, 8, 7], { predictors: [{ name: "x", values: [1, 2, 3, 4, 5, 6, 7, 8] }] });
  assert.ok(!("error" in ok) && ok.f! > 0 && ok.fP! < 0.01);
});

/* ============================================================ S8 — one mediation base */

test("S8: the Baron–Kenny identity holds when a variable has a gap", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const m = [2, 3, 5, 4, 6, 8, 7, 9, 10, null];
  const y = [3, 4, 6, 5, 8, 9, 10, 12, 11, 14];
  const r = mediation(x, m, y);
  assert.ok(!("error" in r));
  // the three models used to be fitted on three different subsets: a·b + c' = 1.1333 against c = 1.1758
  close(r.a.estimate * r.b.estimate + r.cPrime.estimate, r.total.estimate, 1e-12, "a·b + c' = c");
  close(r.indirect / r.total.estimate, r.proportionMediated!, 1e-12, "proportionMediated");
  // and every model saw the same number of cases
  const complete = x.filter((_, i) => m[i] != null && y[i] != null).length;
  assert.equal(r.a.se != null && r.b.se != null, true);
  assert.equal(complete, 9);
  // with no missing data the answer is unchanged
  const full = mediation(x, [2, 3, 5, 4, 6, 8, 7, 9, 10, 12], y);
  assert.ok(!("error" in full));
  close(full.a.estimate * full.b.estimate + full.cPrime.estimate, full.total.estimate, 1e-12, "identity, complete data");
});

/* ============================================================ S5 — multinomial guards */

test("S5: a perfectly separated multinomial is refused, not fitted", () => {
  const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  // x determines the category exactly, so the MLE does not exist. The ridge used to be
  // added before the singularity test, and this was fitted: coefficients of 406 and
  // −74.8, standard errors of 9320, p = 0.965, McFadden R² = 0.9999999972.
  const sep = multinomialLogistic(x.map((v) => (v < 4 ? "low" : v < 8 ? "mid" : "high")), { predictors: [{ name: "x", values: x }] });
  assert.ok("error" in sep, "a separated design must be refused");
  // a collinear design, which ols and logistic already refused on the same data
  const mixed = x.map((v) => (v % 3 === 0 ? "a" : v % 3 === 1 ? "b" : "c"));
  const col = multinomialLogistic(mixed, { predictors: [{ name: "x", values: x }, { name: "z", values: x.map((v) => 2 * v) }] });
  assert.ok("error" in col, "x and z are the same variable");
  assert.ok("error" in ols(x, { predictors: [{ name: "x", values: mixed.map((_, i) => i) }, { name: "z", values: mixed.map((_, i) => 2 * i) }] }), "ols agrees");
});

test("S5: an estimable multinomial still fits, with usable standard errors", () => {
  const rot: Record<string, string> = { low: "mid", mid: "high", high: "low" };
  const x: number[] = [], cat: string[] = [];
  for (let i = 0; i < 96; i++) { const v = i % 12; x.push(v); const b = v < 4 ? "low" : v < 8 ? "mid" : "high"; cat.push(i % 5 === 0 ? rot[b] : b); }
  const m = multinomialLogistic(cat, { predictors: [{ name: "x", values: x }] });
  assert.ok(!("error" in m), "error" in (m as { error?: string }) ? (m as { error: string }).error : "");
  assert.equal(m.equations.length, 2);
  assert.ok(m.converged);
  assert.ok(m.mcFaddenR2 > 0.2 && m.mcFaddenR2 < 1);
  for (const eq of m.equations) for (const c of eq.coefficients) {
    assert.ok(c.se != null && Number.isFinite(c.se) && c.se < 10, `${eq.category} ${c.term} se = ${c.se}`);
    assert.ok(c.p != null && c.p >= 0 && c.p <= 1, `${eq.category} ${c.term} p = ${c.p}`);
  }
});

/* ============================================================ S1 — conditional logit */

const binary = (chosen: number, other: number): ChoiceSet[] => [
  ...Array.from({ length: chosen }, () => ({ alternatives: [[1], [0]], chosen: 0 })),
  ...Array.from({ length: other }, () => ({ alternatives: [[1], [0]], chosen: 1 })),
];

test("S1: an identified design is unchanged and matches the closed form", () => {
  const f = conditionalLogit(binary(140, 60), 1, { ridge: 0 });
  close(f.beta[0], Math.log(140 / 60), 1e-9, "β");
  close(f.se[0], 1 / Math.sqrt(200 * 0.7 * 0.3), 1e-9, "SE");
  assert.ok(f.converged && f.identified);
  assert.deepEqual(f.warnings, []);
  assert.ok(f.p[0] > 0 && f.p[0] < 1e-6);
  // the default ridge must not change any of that materially
  const d = conditionalLogit(binary(140, 60), 1);
  assert.ok(d.converged && d.identified && d.warnings.length === 0);
  close(d.beta[0], Math.log(140 / 60), 1e-3, "β with the default ridge");
});

test("S1: a collinear design reports no standard errors instead of inventing them", () => {
  // x2 = 2·x1, so only b1 + 2·b2 is identified. The SEs used to be exactly 0.894/√ridge —
  // 8.9 at ridge 1e-2, 283 at 1e-5 — a function of the penalty rather than of the data.
  const sets: ChoiceSet[] = Array.from({ length: 100 }, (_, i) => ({ alternatives: [[1, 2], [-1, -2]], chosen: i < 70 ? 0 : 1 }));
  const fits = [1e-2, 1e-3, 1e-4].map((ridge) => conditionalLogit(sets, 2, { ridge }));
  for (const f of fits) {
    assert.equal(f.identified, false, "the design does not identify both coefficients");
    assert.ok(f.se.every(Number.isNaN), `se = ${JSON.stringify(f.se)}`);
    assert.ok(f.z.every(Number.isNaN), "a NaN SE used to become z = 0, p = 1 — a real-looking null");
    assert.ok(f.p.every(Number.isNaN));
    assert.ok(f.warnings.some((w) => /collinear/i.test(w)));
  }
  // the combination the data does identify is still recovered, and does not drift with the penalty
  const combos = fits.map((f) => f.beta[0] + 2 * f.beta[1]);
  for (const c of combos) close(c, combos[0], 1e-3, "b1 + 2·b2 is stable across ridges");
});

test("S1: separation is reported however small the penalty that hides it", () => {
  const always: ChoiceSet[] = Array.from({ length: 100 }, () => ({ alternatives: [[1], [0]], chosen: 0 }));
  for (const ridge of [1e-2, 1e-3, 1e-4, 0]) {
    const f = conditionalLogit(always, 1, { ridge });
    // at ridge 1e-3 this used to be converged: true, p = 0.37, no warning at all
    assert.equal(f.converged, false, `ridge ${ridge} reported convergence`);
    assert.ok(f.warnings.some((w) => /separation/i.test(w)), `ridge ${ridge}: ${JSON.stringify(f.warnings)}`);
  }
  // a column that never varies is unidentified rather than separated
  const flat: ChoiceSet[] = Array.from({ length: 50 }, (_, i) => ({ alternatives: [[1, 0], [-1, 0]], chosen: i < 30 ? 0 : 1 }));
  const z = conditionalLogit(flat, 2, { ridge: 0 });
  assert.equal(z.identified, false);
  assert.ok(z.se.every(Number.isNaN));
});

/* ============================================================ S3 — varimax */

const varimaxCriterion = (L: number[][]): number => {
  const p = L.length, k = L[0].length;
  let s = 0;
  for (let j = 0; j < k; j++) {
    let q = 0, r = 0;
    for (let i = 0; i < p; i++) { const v = L[i][j]; q += v ** 4; r += v * v; }
    s += (p * q - r * r) / (p * p);
  }
  return s;
};
/** the best criterion reachable by any rotation of a two-factor solution, by search */
const bestPlanar = (L: number[][], steps = 36000): number => {
  let best = -Infinity;
  for (let d = 0; d < steps; d++) {
    const a = (d * Math.PI) / steps, c = Math.cos(a), s = Math.sin(a);
    best = Math.max(best, varimaxCriterion(L.map((r) => [r[0] * c + r[1] * s, -r[0] * s + r[1] * c])));
  }
  return best;
};

test("S3: varimax reaches the optimal rotation, including from a saddle point", () => {
  const n = 60;
  const f1 = Array.from({ length: n }, (_, i) => Math.sin(i)), f2 = Array.from({ length: n }, (_, i) => Math.cos(i * 1.7));
  const cols = [
    { name: "a1", values: f1.map((v, i) => v + (0.1 * ((i * 7) % 5)) / 5) }, { name: "a2", values: f1.map((v, i) => 0.9 * v + (0.1 * ((i * 3) % 5)) / 5) }, { name: "a3", values: f1.map((v) => 1.1 * v) },
    { name: "b1", values: f2.map((v, i) => v + (0.1 * ((i * 11) % 5)) / 5) }, { name: "b2", values: f2.map((v) => 0.8 * v) }, { name: "b3", values: f2.map((v, i) => 1.2 * v + 0.05 * (i % 2)) },
  ];
  const un = factorAnalysis(cols, { factors: 2, rotation: "none" });
  const ro = factorAnalysis(cols, { factors: 2 });
  assert.ok(!("error" in un) && !("error" in ro));
  /*
   * Two clean blocks put every unrotated loading at ±0.71 on both factors.
   * That is a stationary point of the criterion, so the old gradient ascent
   * never started: it returned a criterion of 0.0003 where 0.4989 was
   * available, and the package test that covered this was passing on a
   * tie-break in the fourth decimal.
   */
  const optimum = bestPlanar(un.loadings);
  assert.ok(varimaxCriterion(un.loadings) < 0.01, "the unrotated solution really is at the saddle");
  close(varimaxCriterion(ro.loadings), optimum, optimum * 1e-4, "rotated criterion reaches the optimum");
  // and the result is simple structure: each block on its own factor
  const onFactor = ro.loadings.map((l) => (Math.abs(l[0]) > Math.abs(l[1]) ? 0 : 1));
  assert.equal(new Set(onFactor.slice(0, 3)).size, 1);
  assert.equal(new Set(onFactor.slice(3)).size, 1);
  assert.notEqual(onFactor[0], onFactor[3]);
  for (const l of ro.loadings) assert.ok(Math.max(...l.map(Math.abs)) > 0.9 && Math.min(...l.map(Math.abs)) < 0.1, `not simple structure: ${l}`);
});

test("S3: varimax reaches the optimum on messy loadings too", () => {
  // a deterministic pseudo-random battery; the old rotation fell up to 48% short here
  let seed = 20261026;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  let worstShortfall = 0;
  for (let trial = 0; trial < 12; trial++) {
    const n = 90, f1 = Array.from({ length: n }, nrm), f2 = Array.from({ length: n }, nrm);
    const cols = Array.from({ length: 7 }, (_, j) => {
      const a = rnd() * 2 - 1, b = rnd() * 2 - 1;
      return { name: `v${j}`, values: f1.map((v, i) => a * v + b * f2[i] + 0.4 * nrm()) };
    });
    const un = factorAnalysis(cols, { factors: 2, rotation: "none" });
    const ro = factorAnalysis(cols, { factors: 2 });
    if ("error" in un || "error" in ro) continue;
    const best = bestPlanar(un.loadings);
    if (best <= 0) continue;
    worstShortfall = Math.max(worstShortfall, 1 - varimaxCriterion(ro.loadings) / best);
  }
  assert.ok(worstShortfall < 1e-4, `worst shortfall against a brute-force search was ${(worstShortfall * 100).toFixed(2)}%`);
});

/* ============================================================ S4 — explained variance */

test("S4: principal-axis percentages are never negative and never fall", () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const n = 400, f1 = Array.from({ length: n }, nrm), f2 = Array.from({ length: n }, nrm);
  const cols = Array.from({ length: 8 }, (_, j) => ({ name: `v${j}`, values: f1.map((v, i) => (j < 4 ? v : f2[i]) * 0.8 + 0.6 * nrm()) }));
  for (const method of ["pca", "principal_axis"] as const) {
    const r = factorAnalysis(cols, { method });
    assert.ok(!("error" in r));
    /*
     * principal_axis replaces the diagonal of R with SMC communalities, so the
     * trace of the matrix it decomposes is Σ SMC and its lower eigenvalues are
     * negative. Dividing those by p produced six negative "% of variance"
     * entries and a cumulative that fell from 60.3% to 52.8% as factors were
     * added — straight into the client-facing table.
     */
    for (const e of r.explained) assert.ok(e >= 0, `${method}: negative % of variance ${e}`);
    r.cumulative.forEach((c, i) => { if (i) assert.ok(c >= r.cumulative[i - 1] - 1e-9, `${method}: cumulative fell at ${i} (${r.cumulative[i - 1]} → ${c})`); });
    close(r.cumulative.at(-1)!, 100, 1e-6, `${method}: cumulative reaches 100%`);
    assert.equal(r.eigenvalues.length, cols.length);
    assert.ok(r.factors >= 1 && r.factors <= cols.length);
  }
});
