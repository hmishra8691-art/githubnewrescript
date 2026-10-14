/**
 * Hypothesis tests. Every function returns the statistic, degrees of freedom,
 * the two-sided p-value and, where it is standard, an effect size — so a table
 * can print "χ² = 12.4, df 3, p = .006, Cramér's V = .21" from one object.
 */
import { chiSquareP, fTestP, normalCdf, normalQuantile, tTestP, logGamma } from "./distributions.js";
import { describe } from "./descriptive.js";
import { solve } from "./matrix.js";

export interface TestResult {
  test: string;
  statistic: number | null;
  df?: number | [number, number];
  p: number | null;
  effectSize?: { name: string; value: number | null };
  detail?: Record<string, unknown>;
  note?: string;
}

const clean = (xs: (number | null | undefined)[]): number[] => xs.filter((x): x is number => x != null && Number.isFinite(x));
const rank = (xs: number[]): number[] => {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
};

/** Σ(t³ − t) over the groups of tied values — the tie term of every rank test's variance */
const tieSum = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b); let t = 0;
  for (let i = 0; i < sorted.length;) { let j = i; while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++; const g = j - i + 1; t += g ** 3 - g; i = j + 1; }
  return t;
};

/* ------------------------------------------------------------ chi-square */

export function chiSquare(table: number[][]): TestResult {
  const R = table.length, C = table[0]?.length ?? 0;
  const rowT = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colT = Array.from({ length: C }, (_, j) => table.reduce((a, r) => a + r[j], 0));
  const N = rowT.reduce((a, b) => a + b, 0);
  if (R < 2 || C < 2 || N === 0) return { test: "chi_square", statistic: null, p: null, note: "needs at least a 2×2 table with data" };
  let x2 = 0, smallExpected = 0, minExpected = Infinity;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const e = (rowT[i] * colT[j]) / N;
    if (e < 5) smallExpected++;
    if (e < minExpected) minExpected = e;
    if (e > 0) x2 += (table[i][j] - e) ** 2 / e;
  }
  const df = (R - 1) * (C - 1);
  let p = chiSquareP(x2, df);
  const v = Math.sqrt(x2 / (N * Math.min(R - 1, C - 1)));
  /*
   * Cochran's rule: the chi-square approximation is unreliable when more than a fifth of the cells expect fewer than 5,
   * or any expects fewer than 1. A 2×2 table of whole counts then gets Fisher's exact p; a larger table keeps the
   * approximate p but says so (`assumptionMet: false`), and a reader or a finding must not call it a clean result.
   */
  const assumptionMet = !(minExpected < 1 || smallExpected / (R * C) > 0.2);
  let pMethod: "asymptotic" | "fisher_exact" = "asymptotic";
  const whole = table.every((r) => r.every((x) => Number.isInteger(x)));
  if (!assumptionMet && R === 2 && C === 2 && whole) { p = fisherExact(table[0][0], table[0][1], table[1][0], table[1][1]).p ?? p; pMethod = "fisher_exact"; }
  const note = !smallExpected ? undefined
    : pMethod === "fisher_exact" ? `${smallExpected} cell(s) have expected counts below 5, so the exact (Fisher) p-value is given`
    : assumptionMet ? `${smallExpected} cell(s) have expected counts below 5`
    : `${smallExpected} cell(s) have expected counts below 5, so the p-value is approximate — combine thin categories or treat it as indicative`;
  return { test: "chi_square", statistic: x2, df, p, effectSize: { name: "Cramér's V", value: v },
    detail: { n: N, cellsWithExpectedBelow5: smallExpected, assumptionMet, pMethod }, note };
}

/** Fisher's exact test for a 2×2 table (two-sided, by summing tables as or more extreme). */
/**
 * Cochran–Armitage test for a trend in proportions across ordered groups (the "chi-square test for trend").
 * `successes[i]` of `totals[i]` in group i, scored by `scores` (default 1…k). Z = Σ sᵢ(xᵢ − nᵢp̂) / √(p̂(1 − p̂)[Σ nᵢsᵢ² − (Σ nᵢsᵢ)²/N]);
 * the sign is the direction of the trend (positive: the share rises with the score). It asks for a steady rise or fall — a
 * chi-square on the same table asks only whether the groups differ, and has less power against a gradient.
 */
export function trendProportions(successes: number[], totals: number[], scores?: number[]): TestResult {
  const k = totals.length;
  const s = scores && scores.length === k ? scores : Array.from({ length: k }, (_, i) => i + 1);
  const groups = totals.map((t, i) => ({ x: successes[i], n: t, s: s[i] })).filter((g) => g.n > 0);
  const N = groups.reduce((a, g) => a + g.n, 0), X = groups.reduce((a, g) => a + g.x, 0);
  if (groups.length < 3 || N === 0 || X === 0 || X === N) return { test: "trend_proportion", statistic: null, p: null, note: "needs at least three ordered groups and both outcomes present" };
  const p = X / N;
  const num = groups.reduce((a, g) => a + g.s * (g.x - g.n * p), 0);
  const sn = groups.reduce((a, g) => a + g.n * g.s, 0), sn2 = groups.reduce((a, g) => a + g.n * g.s * g.s, 0);
  const v = p * (1 - p) * (sn2 - (sn * sn) / N);
  if (!(v > 0)) return { test: "trend_proportion", statistic: null, p: null, note: "the scores do not vary" };
  const z = num / Math.sqrt(v);
  return { test: "trend_proportion", statistic: z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), effectSize: { name: "slope (share per score step)", value: num / (sn2 - (sn * sn) / N) }, detail: { z, chiSquare: z * z, df: 1, groups: groups.length, n: N, direction: z > 0 ? "rising" : "falling" } };
}

export function fisherExact(a: number, b: number, c: number, d: number): TestResult {
  const logHyper = (a1: number, b1: number, c1: number, d1: number) => {
    const n = a1 + b1 + c1 + d1;
    return logGamma(a1 + b1 + 1) + logGamma(c1 + d1 + 1) + logGamma(a1 + c1 + 1) + logGamma(b1 + d1 + 1)
      - logGamma(n + 1) - logGamma(a1 + 1) - logGamma(b1 + 1) - logGamma(c1 + 1) - logGamma(d1 + 1);
  };
  const pObs = Math.exp(logHyper(a, b, c, d));
  const r1 = a + b, c1 = a + c, n = a + b + c + d;
  let p = 0;
  for (let x = Math.max(0, r1 + c1 - n); x <= Math.min(r1, c1); x++) {
    const px = Math.exp(logHyper(x, r1 - x, c1 - x, n - r1 - c1 + x));
    if (px <= pObs + 1e-12) p += px;
  }
  const or = b * c === 0 ? null : (a * d) / (b * c);
  return { test: "fisher_exact", statistic: or, p: Math.min(1, p), effectSize: { name: "odds ratio", value: or }, detail: { n } };
}

/* ------------------------------------------------------------ t-tests */

export function oneSampleT(xs: (number | null | undefined)[], mu = 0): TestResult {
  const d = describe(xs);
  if (d.n < 2 || d.se == null || d.se === 0) return { test: "t_one_sample", statistic: null, p: null, note: "needs at least two values" };
  const t = (d.mean! - mu) / d.se;
  return { test: "t_one_sample", statistic: t, df: d.n - 1, p: tTestP(t, d.n - 1), effectSize: { name: "Cohen's d", value: (d.mean! - mu) / d.sd! }, detail: { mean: d.mean, n: d.n, ci95: d.ci95 } };
}

export function independentT(a: (number | null | undefined)[], b: (number | null | undefined)[], equalVariance = false): TestResult {
  const da = describe(a), db = describe(b);
  if (da.n < 2 || db.n < 2 || da.variance == null || db.variance == null) return { test: "t_independent", statistic: null, p: null, note: "each group needs at least two values" };
  let t: number, df: number;
  if (equalVariance) {
    const sp2 = ((da.n - 1) * da.variance + (db.n - 1) * db.variance) / (da.n + db.n - 2);
    t = (da.mean! - db.mean!) / Math.sqrt(sp2 * (1 / da.n + 1 / db.n)); df = da.n + db.n - 2;
  } else {
    const v1 = da.variance / da.n, v2 = db.variance / db.n;
    t = (da.mean! - db.mean!) / Math.sqrt(v1 + v2);
    df = (v1 + v2) ** 2 / (v1 ** 2 / (da.n - 1) + v2 ** 2 / (db.n - 1)); // Welch–Satterthwaite
  }
  const pooledSd = Math.sqrt(((da.n - 1) * da.variance + (db.n - 1) * db.variance) / (da.n + db.n - 2));
  return { test: equalVariance ? "t_independent" : "t_welch", statistic: t, df, p: tTestP(t, df),
    effectSize: { name: "Cohen's d", value: pooledSd ? (da.mean! - db.mean!) / pooledSd : null },
    detail: { meanA: da.mean, meanB: db.mean, nA: da.n, nB: db.n, difference: da.mean! - db.mean! } };
}

export function pairedT(a: (number | null | undefined)[], b: (number | null | undefined)[]): TestResult {
  const diffs: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = a[i], y = b[i]; if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) diffs.push(x - y); }
  const r = oneSampleT(diffs, 0);
  return { ...r, test: "t_paired", detail: { ...r.detail, pairs: diffs.length } };
}

/* ------------------------------------------------------------ ANOVA */

export function oneWayAnova(groups: { label: string; values: (number | null | undefined)[] }[]): TestResult {
  const gs = groups.map((g) => ({ label: g.label, xs: clean(g.values) })).filter((g) => g.xs.length > 0);
  const k = gs.length, N = gs.reduce((t, g) => t + g.xs.length, 0);
  if (k < 2 || N <= k) return { test: "anova_one_way", statistic: null, p: null, note: "needs at least two groups with data" };
  const grand = gs.reduce((t, g) => t + g.xs.reduce((a, b) => a + b, 0), 0) / N;
  let ssb = 0, ssw = 0;
  for (const g of gs) {
    const m = g.xs.reduce((a, b) => a + b, 0) / g.xs.length;
    ssb += g.xs.length * (m - grand) ** 2;
    ssw += g.xs.reduce((t, x) => t + (x - m) ** 2, 0);
  }
  const dfb = k - 1, dfw = N - k;
  const f = ssw === 0 ? Infinity : (ssb / dfb) / (ssw / dfw);
  return { test: "anova_one_way", statistic: f, df: [dfb, dfw], p: Number.isFinite(f) ? fTestP(f, dfb, dfw) : 0,
    effectSize: { name: "η²", value: ssb + ssw ? ssb / (ssb + ssw) : null },
    detail: { groups: gs.map((g) => ({ label: g.label, n: g.xs.length, mean: g.xs.reduce((a, b) => a + b, 0) / g.xs.length })), ssBetween: ssb, ssWithin: ssw } };
}

/**
 * Two-way ANOVA with interaction, by TYPE II sums of squares: each main effect is tested after the other factor
 * (SS(A | B) = RSS(B) − RSS(A + B)) and the interaction after both main effects, so the answer does not depend on
 * which factor is listed first and is right when the cells are unbalanced. (It used to compare marginal means, which
 * is right only for equal cell sizes: with cells of 30, 5, 8 and 40 the interaction F was 59 where numpy gives 6.4.)
 * Reference values are checked against numpy least squares in the test suite.
 */
export function twoWayAnova(rows: { a: string; b: string; y: number | null | undefined }[]): { factorA: TestResult; factorB: TestResult; interaction: TestResult } {
  const data = rows.filter((r) => r.y != null && Number.isFinite(r.y)) as { a: string; b: string; y: number }[];
  const N = data.length;
  const A = [...new Set(data.map((r) => r.a))].sort(), B = [...new Set(data.map((r) => r.b))].sort();
  const bad = (note: string): { factorA: TestResult; factorB: TestResult; interaction: TestResult } => ({ factorA: { test: "anova_factor_a", statistic: null, p: null, note }, factorB: { test: "anova_factor_b", statistic: null, p: null, note }, interaction: { test: "anova_interaction", statistic: null, p: null, note } });
  if (A.length < 2 || B.length < 2) return bad("needs at least two levels of each factor");
  // residual sum of squares of the least-squares fit of y on the given dummy columns (plus an intercept)
  const rss = (cols: (r: { a: string; b: string }) => number[]): number | null => {
    const X = data.map((r) => [1, ...cols(r)]);
    const k = X[0].length;
    const xtx = Array.from({ length: k }, () => new Array(k).fill(0)), xty = new Array(k).fill(0);
    X.forEach((x, i) => { for (let p = 0; p < k; p++) { xty[p] += x[p] * data[i].y; for (let q = 0; q < k; q++) xtx[p][q] += x[p] * x[q]; } });
    const beta = solve(xtx, xty);
    if (!beta) return null;
    return X.reduce((t, x, i) => { const fit = x.reduce((u, v, p) => u + v * beta[p], 0); return t + (data[i].y - fit) ** 2; }, 0);
  };
  const dumA = (r: { a: string }) => A.slice(1).map((l) => (r.a === l ? 1 : 0));
  const dumB = (r: { b: string }) => B.slice(1).map((l) => (r.b === l ? 1 : 0));
  const dumAB = (r: { a: string; b: string }) => { const da = dumA(r), db = dumB(r); return da.flatMap((x) => db.map((y) => x * y)); };
  const rssA = rss(dumA), rssB = rss(dumB), rssAplusB = rss((r) => [...dumA(r), ...dumB(r)]);
  // the full (cell-means) model's RSS is the within-cell sum of squares, and its df the number of occupied cells
  const cells = new Map<string, number[]>();
  for (const r of data) { const k = `${r.a}\u0000${r.b}`; (cells.get(k) ?? cells.set(k, []).get(k)!).push(r.y); }
  let ssE = 0; for (const ys of cells.values()) { const m = ys.reduce((t, v) => t + v, 0) / ys.length; ssE += ys.reduce((t, v) => t + (v - m) ** 2, 0); }
  const dfE = N - cells.size;
  if (rssA == null || rssB == null || rssAplusB == null) return bad("the design cannot be fitted (a level has no data)");
  if (cells.size < A.length * B.length) return bad("some combinations of the two factors have no respondents, so the interaction cannot be separated from the main effects");
  if (dfE <= 0 || ssE <= 0) return bad("not enough observations within the cells");
  const dfA = A.length - 1, dfB = B.length - 1, dfAB = dfA * dfB;
  const mk = (name: string, ss: number, df: number): TestResult => {
    const f = (ss / df) / (ssE / dfE);
    return { test: name, statistic: f, df: [df, dfE], p: fTestP(f, df, dfE), effectSize: { name: "partial η²", value: ss / (ss + ssE) }, detail: { sumOfSquares: ss, type: "II" } };
  };
  return { factorA: mk("anova_factor_a", rssB - rssAplusB, dfA), factorB: mk("anova_factor_b", rssA - rssAplusB, dfB), interaction: mk("anova_interaction", rssAplusB - ssE, dfAB) };
}

/* ------------------------------------------------------------ rank tests */

export function mannWhitney(a: (number | null | undefined)[], b: (number | null | undefined)[]): TestResult {
  const xa = clean(a), xb = clean(b);
  const n1 = xa.length, n2 = xb.length;
  if (n1 < 1 || n2 < 1) return { test: "mann_whitney", statistic: null, p: null, note: "both groups need data" };
  const r = rank([...xa, ...xb]);
  const r1 = r.slice(0, n1).reduce((t, x) => t + x, 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2, u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  /*
   * Ties and the continuity correction (Audit S-9). Likert answers tie constantly; without the tie term the variance is
   * too large and p too big, and without the continuity correction a small sample's p is too small. This is scipy's
   * mannwhitneyu(method="asymptotic", use_continuity=True), which is also what R's wilcox.test does.
   */
  const n = n1 + n2;
  const mu = (n1 * n2) / 2, sigma = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tieSum([...xa, ...xb]) / (n * (n - 1) || 1)));
  const z = sigma ? Math.max(0, Math.abs(u - mu) - 0.5) / sigma : 0;
  const p = Math.min(1, 2 * (1 - normalCdf(z)));
  return { test: "mann_whitney", statistic: u, p, effectSize: { name: "rank-biserial r", value: 1 - (2 * u) / (n1 * n2) }, detail: { z, n1, n2, U1: u1, U2: u2, ties: tieSum([...xa, ...xb]) > 0 } };
}

export function wilcoxonSignedRank(a: (number | null | undefined)[], b: (number | null | undefined)[]): TestResult {
  const d: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = a[i], y = b[i]; if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y) && x !== y) d.push(x - y); }
  const n = d.length;
  if (n < 1) return { test: "wilcoxon", statistic: null, p: null, note: "no non-zero paired differences" };
  const r = rank(d.map(Math.abs));
  const wPlus = d.reduce((t, x, i) => t + (x > 0 ? r[i] : 0), 0);
  const wMinus = d.reduce((t, x, i) => t + (x < 0 ? r[i] : 0), 0);
  const w = Math.min(wPlus, wMinus);
  const absd = d.map(Math.abs);
  const mu = (n * (n + 1)) / 4, sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieSum(absd) / 48);
  const z = sigma ? Math.max(0, Math.abs(w - mu) - 0.5) / sigma : 0;
  return { test: "wilcoxon", statistic: w, p: Math.min(1, 2 * (1 - normalCdf(z))), effectSize: { name: "r", value: z / Math.sqrt(n) }, detail: { z, n, wPlus, wMinus } };
}

export function kruskalWallis(groups: { label: string; values: (number | null | undefined)[] }[]): TestResult {
  const gs = groups.map((g) => ({ label: g.label, xs: clean(g.values) })).filter((g) => g.xs.length);
  const N = gs.reduce((t, g) => t + g.xs.length, 0);
  if (gs.length < 2) return { test: "kruskal_wallis", statistic: null, p: null, note: "needs at least two groups" };
  const r = rank(gs.flatMap((g) => g.xs));
  let off = 0, h = 0;
  for (const g of gs) { const rs = r.slice(off, off + g.xs.length); off += g.xs.length; const R = rs.reduce((a, b) => a + b, 0); h += (R * R) / g.xs.length; }
  h = (12 / (N * (N + 1))) * h - 3 * (N + 1);
  /* the tie correction (S-9): H is divided by 1 − Σ(t³ − t)/(N³ − N), as scipy.stats.kruskal does */
  const tieFactor = 1 - tieSum(gs.flatMap((g) => g.xs)) / (N ** 3 - N);
  if (tieFactor <= 0) return { test: "kruskal_wallis", statistic: null, p: null, note: "every value is the same, so there is nothing to rank" };
  h /= tieFactor;
  const df = gs.length - 1;
  return { test: "kruskal_wallis", statistic: h, df, p: chiSquareP(h, df), effectSize: { name: "ε²", value: (h - df) / (N - gs.length) } };
}

/** Friedman test for k related samples (rows = subjects, columns = conditions). */
export function friedman(matrix: (number | null | undefined)[][]): TestResult {
  const rows = matrix.filter((r) => r.every((x) => x != null && Number.isFinite(x))) as number[][];
  const n = rows.length, k = rows[0]?.length ?? 0;
  if (n < 2 || k < 2) return { test: "friedman", statistic: null, p: null, note: "needs at least two complete rows and two conditions" };
  const rankSums = new Array(k).fill(0);
  for (const r of rows) { const rk = rank(r); rk.forEach((v, j) => (rankSums[j] += v)); }
  let q = (12 / (n * k * (k + 1))) * rankSums.reduce((t, R) => t + R * R, 0) - 3 * n * (k + 1);
  /* ties within a subject (S-9): q is divided by 1 − Σ(t³ − t)/(n·k·(k² − 1)), as scipy.stats.friedmanchisquare does */
  const tieFactor = 1 - rows.reduce((t, r) => t + tieSum(r), 0) / (n * k * (k * k - 1));
  if (tieFactor <= 0) return { test: "friedman", statistic: null, p: null, note: "every subject gave the same value in every condition" };
  q /= tieFactor;
  return { test: "friedman", statistic: q, df: k - 1, p: chiSquareP(q, k - 1), effectSize: { name: "Kendall's W", value: q / (n * (k - 1)) }, detail: { rankSums } };
}

/* ------------------------------------------------------------ proportions */

export function proportionTest(x1: number, n1: number, x2?: number, n2?: number, p0 = 0.5): TestResult {
  if (n2 == null || x2 == null) {
    const p = x1 / n1, se = Math.sqrt((p0 * (1 - p0)) / n1);
    const z = se ? (p - p0) / se : 0;
    return { test: "proportion_one_sample", statistic: z, p: 2 * (1 - normalCdf(Math.abs(z))), detail: { p, p0, n: n1 } };
  }
  const p1 = x1 / n1, p2 = x2 / n2, pool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  const z = se ? (p1 - p2) / se : 0;
  return { test: "proportion_two_sample", statistic: z, p: 2 * (1 - normalCdf(Math.abs(z))), effectSize: { name: "Cohen's h", value: 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2)) }, detail: { p1, p2, n1, n2, difference: p1 - p2 } };
}

/**
 * Wilson score interval for a proportion, at any confidence level (it used to fall back to 90% for anything but
 * 95% or 99%). For weighted data pass the weighted proportion's successes on the Kish effective n, so the interval
 * is built from the weighted estimate: x = p × nEff, n = nEff (x need not be an integer).
 */
export function proportionCI(x: number, n: number, confidence = 0.95): [number, number] | null {
  if (!n || !(confidence > 0 && confidence < 1)) return null;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = x / n, denom = 1 + (z * z) / n, centre = p + (z * z) / (2 * n), half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - half) / denom, (centre + half) / denom];
}

