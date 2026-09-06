/**
 * Hypothesis tests. Every function returns the statistic, degrees of freedom,
 * the two-sided p-value and, where it is standard, an effect size — so a table
 * can print "χ² = 12.4, df 3, p = .006, Cramér's V = .21" from one object.
 */
import { chiSquareP, fTestP, normalCdf, tTestP, logGamma } from "./distributions.js";
import { describe } from "./descriptive.js";

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

/* ------------------------------------------------------------ chi-square */

export function chiSquare(table: number[][]): TestResult {
  const R = table.length, C = table[0]?.length ?? 0;
  const rowT = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colT = Array.from({ length: C }, (_, j) => table.reduce((a, r) => a + r[j], 0));
  const N = rowT.reduce((a, b) => a + b, 0);
  if (R < 2 || C < 2 || N === 0) return { test: "chi_square", statistic: null, p: null, note: "needs at least a 2×2 table with data" };
  let x2 = 0, smallExpected = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const e = (rowT[i] * colT[j]) / N;
    if (e < 5) smallExpected++;
    if (e > 0) x2 += (table[i][j] - e) ** 2 / e;
  }
  const df = (R - 1) * (C - 1);
  const p = chiSquareP(x2, df);
  const v = Math.sqrt(x2 / (N * Math.min(R - 1, C - 1)));
  return { test: "chi_square", statistic: x2, df, p, effectSize: { name: "Cramér's V", value: v },
    detail: { n: N, cellsWithExpectedBelow5: smallExpected }, note: smallExpected ? `${smallExpected} cell(s) have expected counts below 5` : undefined };
}

/** Fisher's exact test for a 2×2 table (two-sided, by summing tables as or more extreme). */
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

/** Two-way ANOVA (balanced or not, Type I sums) with interaction; also serves ANCOVA when B is a covariate regressed out first. */
export function twoWayAnova(rows: { a: string; b: string; y: number | null | undefined }[]): { factorA: TestResult; factorB: TestResult; interaction: TestResult } {
  const data = rows.filter((r) => r.y != null && Number.isFinite(r.y)) as { a: string; b: string; y: number }[];
  const N = data.length;
  const A = [...new Set(data.map((r) => r.a))], B = [...new Set(data.map((r) => r.b))];
  const grand = data.reduce((t, r) => t + r.y, 0) / N;
  const meanOf = (f: (r: { a: string; b: string; y: number }) => boolean) => { const xs = data.filter(f); return xs.length ? xs.reduce((t, r) => t + r.y, 0) / xs.length : grand; };
  let ssA = 0, ssB = 0, ssAB = 0, ssE = 0;
  for (const a of A) ssA += data.filter((r) => r.a === a).length * (meanOf((r) => r.a === a) - grand) ** 2;
  for (const b of B) ssB += data.filter((r) => r.b === b).length * (meanOf((r) => r.b === b) - grand) ** 2;
  for (const a of A) for (const b of B) {
    const cell = data.filter((r) => r.a === a && r.b === b);
    if (!cell.length) continue;
    const cm = cell.reduce((t, r) => t + r.y, 0) / cell.length;
    ssAB += cell.length * (cm - meanOf((r) => r.a === a) - meanOf((r) => r.b === b) + grand) ** 2;
    ssE += cell.reduce((t, r) => t + (r.y - cm) ** 2, 0);
  }
  const dfA = A.length - 1, dfB = B.length - 1, dfAB = dfA * dfB, dfE = N - A.length * B.length;
  const mk = (name: string, ss: number, df: number): TestResult => {
    if (df <= 0 || dfE <= 0) return { test: name, statistic: null, p: null, note: "not enough cells" };
    const f = (ss / df) / (ssE / dfE);
    return { test: name, statistic: f, df: [df, dfE], p: fTestP(f, df, dfE), effectSize: { name: "partial η²", value: ss / (ss + ssE) } };
  };
  return { factorA: mk("anova_factor_a", ssA, dfA), factorB: mk("anova_factor_b", ssB, dfB), interaction: mk("anova_interaction", ssAB, dfAB) };
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
  const mu = (n1 * n2) / 2, sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigma ? (u - mu) / sigma : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { test: "mann_whitney", statistic: u, p, effectSize: { name: "rank-biserial r", value: 1 - (2 * u) / (n1 * n2) }, detail: { z, n1, n2, U1: u1, U2: u2 } };
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
  const mu = (n * (n + 1)) / 4, sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sigma ? (w - mu) / sigma : 0;
  return { test: "wilcoxon", statistic: w, p: 2 * (1 - normalCdf(Math.abs(z))), effectSize: { name: "r", value: Math.abs(z) / Math.sqrt(n) }, detail: { z, n, wPlus, wMinus } };
}

export function kruskalWallis(groups: { label: string; values: (number | null | undefined)[] }[]): TestResult {
  const gs = groups.map((g) => ({ label: g.label, xs: clean(g.values) })).filter((g) => g.xs.length);
  const N = gs.reduce((t, g) => t + g.xs.length, 0);
  if (gs.length < 2) return { test: "kruskal_wallis", statistic: null, p: null, note: "needs at least two groups" };
  const r = rank(gs.flatMap((g) => g.xs));
  let off = 0, h = 0;
  for (const g of gs) { const rs = r.slice(off, off + g.xs.length); off += g.xs.length; const R = rs.reduce((a, b) => a + b, 0); h += (R * R) / g.xs.length; }
  h = (12 / (N * (N + 1))) * h - 3 * (N + 1);
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
  const q = (12 / (n * k * (k + 1))) * rankSums.reduce((t, R) => t + R * R, 0) - 3 * n * (k + 1);
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

/** Wilson score interval for a proportion. */
export function proportionCI(x: number, n: number, confidence = 0.95): [number, number] | null {
  if (!n) return null;
  const z = confidence === 0.95 ? 1.959964 : confidence === 0.99 ? 2.575829 : 1.644854;
  const p = x / n, denom = 1 + (z * z) / n, centre = p + (z * z) / (2 * n), half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - half) / denom, (centre + half) / denom];
}

/**
 * Column-proportion significance letters (the market-research "a b c"
 * notation): each column gets a letter; a cell lists the letters of the
 * columns whose proportion is significantly LOWER than its own at alpha.
 */
export function significanceLetters(counts: number[], bases: number[], alpha = 0.05): string[] {
  const letters = counts.map((_, j) => String.fromCharCode(97 + (j % 26)));
  return counts.map((x, j) => {
    const out: string[] = [];
    for (let k = 0; k < counts.length; k++) {
      if (k === j || !bases[j] || !bases[k]) continue;
      const r = proportionTest(x, bases[j], counts[k], bases[k]);
      if (r.p != null && r.p < alpha && x / bases[j] > counts[k] / bases[k]) out.push(letters[k]);
    }
    return out.join("");
  });
}
