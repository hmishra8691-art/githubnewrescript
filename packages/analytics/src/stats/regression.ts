/**
 * Regression: OLS (simple/multiple, with interaction terms), binary logistic
 * (IRLS), multinomial logistic (Newton on the softmax likelihood), plus the
 * moderation (interaction) and mediation (Baron–Kenny with a Sobel test)
 * wrappers built on them.
 */
import { inverse, multiplyVec, transpose, zeros, type Matrix } from "./matrix.js";
import { fTestP, normalCdf, tQuantile, tTestP, chiSquareP } from "./distributions.js";

export interface Coefficient {
  term: string;
  estimate: number;
  se: number | null;
  statistic: number | null;
  p: number | null;
  ci95: [number, number] | null;
  /** logistic only */
  oddsRatio?: number;
  standardized?: number | null;
}

export interface LinearModel {
  kind: "linear";
  n: number;
  coefficients: Coefficient[];
  r2: number;
  adjustedR2: number;
  f: number | null;
  fP: number | null;
  df: [number, number];
  residualSe: number;
  fitted: number[];
  residuals: number[];
  terms: string[];
}

export interface DesignSpec {
  /** predictor columns by name */
  predictors: { name: string; values: (number | null | undefined)[] }[];
  /** pairs of predictor names whose product is added as an interaction */
  interactions?: [string, string][];
}

/** Build X (with intercept) and y, dropping cases with any missing value. */
export function designMatrix(y: (number | null | undefined)[], spec: DesignSpec): { X: Matrix; y: number[]; terms: string[]; kept: number[] } {
  const terms = ["(Intercept)", ...spec.predictors.map((p) => p.name), ...(spec.interactions ?? []).map(([a, b]) => `${a} × ${b}`)];
  const X: Matrix = [], Y: number[] = [], kept: number[] = [];
  for (let i = 0; i < y.length; i++) {
    const yi = y[i];
    if (yi == null || !Number.isFinite(yi)) continue;
    const row = [1];
    let ok = true;
    for (const p of spec.predictors) { const v = p.values[i]; if (v == null || !Number.isFinite(v)) { ok = false; break; } row.push(v); }
    if (!ok) continue;
    for (const [a, b] of spec.interactions ?? []) {
      const ia = spec.predictors.findIndex((p) => p.name === a), ib = spec.predictors.findIndex((p) => p.name === b);
      row.push(row[ia + 1] * row[ib + 1]);
    }
    X.push(row); Y.push(yi); kept.push(i);
  }
  return { X, y: Y, terms, kept };
}

export function ols(y: (number | null | undefined)[], spec: DesignSpec): LinearModel | { error: string } {
  const { X, y: Y, terms } = designMatrix(y, spec);
  const n = X.length, k = terms.length;
  if (n <= k) return { error: `needs more than ${k} complete cases, has ${n}` };
  const Xt = transpose(X);
  const XtX = Xt.map((row) => Xt.map((col) => row.reduce((t, v, i) => t + v * col[i], 0)));
  const inv = inverse(XtX);
  if (!inv) return { error: "predictors are collinear — drop one" };
  const Xty = Xt.map((row) => row.reduce((t, v, i) => t + v * Y[i], 0));
  const beta = multiplyVec(inv, Xty);
  const fitted = X.map((row) => row.reduce((t, v, j) => t + v * beta[j], 0));
  const residuals = Y.map((v, i) => v - fitted[i]);
  const ybar = Y.reduce((a, b) => a + b, 0) / n;
  const ssTot = Y.reduce((t, v) => t + (v - ybar) ** 2, 0), ssRes = residuals.reduce((t, r) => t + r * r, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  const df = [k - 1, n - k] as [number, number];
  const adjustedR2 = 1 - (1 - r2) * ((n - 1) / (n - k));
  const sigma2 = ssRes / (n - k);
  const tcrit = tQuantile(0.975, n - k);
  const sdY = Math.sqrt(ssTot / (n - 1));
  const coefficients: Coefficient[] = beta.map((b, j) => {
    const se = Math.sqrt(Math.max(0, sigma2 * inv[j][j]));
    const t = se ? b / se : null;
    const col = X.map((r) => r[j]);
    const mx = col.reduce((a, v) => a + v, 0) / n, sdX = Math.sqrt(col.reduce((a, v) => a + (v - mx) ** 2, 0) / (n - 1));
    return { term: terms[j], estimate: b, se, statistic: t, p: t == null ? null : tTestP(t, n - k), ci95: [b - tcrit * se, b + tcrit * se],
      standardized: j === 0 ? null : sdY ? (b * sdX) / sdY : null };
  });
  const f = df[0] > 0 && ssRes > 0 ? ((ssTot - ssRes) / df[0]) / (ssRes / df[1]) : null;
  return { kind: "linear", n, coefficients, r2, adjustedR2, f, fP: f == null ? null : fTestP(f, df[0], df[1]), df, residualSe: Math.sqrt(sigma2), fitted, residuals, terms };
}

export interface LogisticModel {
  kind: "logistic";
  n: number;
  coefficients: Coefficient[];
  logLikelihood: number;
  nullLogLikelihood: number;
  mcFaddenR2: number;
  lrChiSquare: number;
  lrP: number;
  aic: number;
  accuracy: number;
  iterations: number;
  converged: boolean;
  fitted: number[];
  terms: string[];
}

/** Binary logistic regression by iteratively reweighted least squares. */
export function logistic(y: (number | null | undefined)[], spec: DesignSpec, maxIter = 50): LogisticModel | { error: string } {
  const { X, y: Y, terms } = designMatrix(y, spec);
  const n = X.length, k = terms.length;
  if (n <= k) return { error: `needs more than ${k} complete cases, has ${n}` };
  if (Y.some((v) => v !== 0 && v !== 1)) return { error: "outcome must be 0/1" };
  const ones = Y.filter((v) => v === 1).length;
  if (ones === 0 || ones === n) return { error: "outcome has no variation" };
  let beta = new Array(k).fill(0);
  beta[0] = Math.log(ones / (n - ones));
  let converged = false, iter = 0, cov: Matrix | null = null;
  for (iter = 0; iter < maxIter; iter++) {
    const eta = X.map((row) => row.reduce((t, v, j) => t + v * beta[j], 0));
    const mu = eta.map((e) => 1 / (1 + Math.exp(-e)));
    const w = mu.map((m) => Math.max(1e-9, m * (1 - m)));
    // X'WX and X'(y - mu)
    const XtWX = zeros(k, k), grad = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < k; a++) {
        grad[a] += X[i][a] * (Y[i] - mu[i]);
        for (let b = 0; b < k; b++) XtWX[a][b] += X[i][a] * w[i] * X[i][b];
      }
    }
    cov = inverse(XtWX);
    if (!cov) return { error: "predictors are collinear or separation occurred" };
    const step = multiplyVec(cov, grad);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) { converged = true; break; }
  }
  const eta = X.map((row) => row.reduce((t, v, j) => t + v * beta[j], 0));
  const fitted = eta.map((e) => 1 / (1 + Math.exp(-e)));
  const ll = Y.reduce((t, yi, i) => t + (yi ? Math.log(Math.max(fitted[i], 1e-12)) : Math.log(Math.max(1 - fitted[i], 1e-12))), 0);
  const p1 = ones / n;
  const ll0 = ones * Math.log(p1) + (n - ones) * Math.log(1 - p1);
  const coefficients: Coefficient[] = beta.map((b, j) => {
    const se = cov ? Math.sqrt(Math.max(0, cov[j][j])) : null;
    const z = se ? b / se : null;
    return { term: terms[j], estimate: b, se, statistic: z, p: z == null ? null : 2 * (1 - normalCdf(Math.abs(z))), ci95: se == null ? null : [b - 1.959964 * se, b + 1.959964 * se], oddsRatio: Math.exp(b) };
  });
  const lr = 2 * (ll - ll0);
  return { kind: "logistic", n, coefficients, logLikelihood: ll, nullLogLikelihood: ll0, mcFaddenR2: 1 - ll / ll0, lrChiSquare: lr, lrP: chiSquareP(lr, k - 1),
    aic: 2 * k - 2 * ll, accuracy: fitted.filter((p, i) => (p >= 0.5 ? 1 : 0) === Y[i]).length / n, iterations: iter + 1, converged, fitted, terms };
}

export interface MultinomialModel {
  kind: "multinomial";
  n: number;
  reference: string;
  categories: string[];
  /** one coefficient set per non-reference category */
  equations: { category: string; coefficients: Coefficient[] }[];
  logLikelihood: number;
  mcFaddenR2: number;
  converged: boolean;
  terms: string[];
}

/** Multinomial logistic regression (softmax) by Newton–Raphson; the first category is the reference. */
export function multinomialLogistic(y: (string | number | null | undefined)[], spec: DesignSpec, maxIter = 60): MultinomialModel | { error: string } {
  const cats = [...new Set(y.filter((v) => v != null).map(String))].sort();
  if (cats.length < 2) return { error: "outcome needs at least two categories" };
  const yi = y.map((v) => (v == null ? null : cats.indexOf(String(v))));
  const { X, y: Y, terms } = designMatrix(yi, spec);
  const n = X.length, k = terms.length, K = cats.length, P = (K - 1) * k;
  if (n <= P) return { error: `needs more than ${P} complete cases, has ${n}` };
  let theta = new Array(P).fill(0);
  let converged = false;
  const probs = (row: number[]): number[] => {
    const etas = [0, ...Array.from({ length: K - 1 }, (_, c) => row.reduce((t, v, j) => t + v * theta[c * k + j], 0))];
    const m = Math.max(...etas);
    const ex = etas.map((e) => Math.exp(e - m));
    const s = ex.reduce((a, b) => a + b, 0);
    return ex.map((e) => e / s);
  };
  let cov: Matrix | null = null;
  for (let iter = 0; iter < maxIter; iter++) {
    const grad = new Array(P).fill(0);
    const H = zeros(P, P);
    for (let i = 0; i < n; i++) {
      const pr = probs(X[i]);
      for (let c = 1; c < K; c++) {
        const ind = Y[i] === c ? 1 : 0;
        for (let a = 0; a < k; a++) {
          grad[(c - 1) * k + a] += X[i][a] * (ind - pr[c]);
          for (let d = 1; d < K; d++) {
            const w = c === d ? pr[c] * (1 - pr[c]) : -pr[c] * pr[d];
            for (let b = 0; b < k; b++) H[(c - 1) * k + a][(d - 1) * k + b] += X[i][a] * w * X[i][b];
          }
        }
      }
    }
    for (let a = 0; a < P; a++) H[a][a] += 1e-8; // ridge for stability
    cov = inverse(H);
    if (!cov) return { error: "model did not converge (collinear predictors or separation)" };
    const step = multiplyVec(cov, grad);
    theta = theta.map((t, j) => t + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) { converged = true; break; }
  }
  let ll = 0;
  for (let i = 0; i < n; i++) ll += Math.log(Math.max(probs(X[i])[Y[i]], 1e-12));
  const counts = cats.map((_, c) => Y.filter((v) => v === c).length);
  const ll0 = counts.reduce((t, c) => t + (c ? c * Math.log(c / n) : 0), 0);
  const equations = cats.slice(1).map((cat, ci) => ({
    category: cat,
    coefficients: terms.map((term, j) => {
      const idx = ci * k + j, b = theta[idx], se = cov ? Math.sqrt(Math.max(0, cov[idx][idx])) : null, z = se ? b / se : null;
      return { term, estimate: b, se, statistic: z, p: z == null ? null : 2 * (1 - normalCdf(Math.abs(z))), ci95: se == null ? null : [b - 1.959964 * se, b + 1.959964 * se] as [number, number], oddsRatio: Math.exp(b) };
    }),
  }));
  return { kind: "multinomial", n, reference: cats[0], categories: cats, equations, logLikelihood: ll, mcFaddenR2: 1 - ll / ll0, converged, terms };
}

/* ------------------------------------------------------------ mediation */

export interface MediationResult {
  a: Coefficient; b: Coefficient; cPrime: Coefficient; total: Coefficient;
  indirect: number; sobelZ: number | null; sobelP: number | null; proportionMediated: number | null;
}

/** Baron–Kenny steps with a Sobel test: X → M (a), M → Y controlling X (b), X → Y total (c) and direct (c'). */
export function mediation(x: (number | null | undefined)[], m: (number | null | undefined)[], y: (number | null | undefined)[]): MediationResult | { error: string } {
  const mA = ols(m, { predictors: [{ name: "X", values: x }] });
  const mTotal = ols(y, { predictors: [{ name: "X", values: x }] });
  const mFull = ols(y, { predictors: [{ name: "X", values: x }, { name: "M", values: m }] });
  if ("error" in mA) return mA; if ("error" in mTotal) return mTotal; if ("error" in mFull) return mFull;
  const a = mA.coefficients[1], b = mFull.coefficients[2], cPrime = mFull.coefficients[1], total = mTotal.coefficients[1];
  const indirect = a.estimate * b.estimate;
  const seSobel = a.se != null && b.se != null ? Math.sqrt(b.estimate ** 2 * a.se ** 2 + a.estimate ** 2 * b.se ** 2) : null;
  const z = seSobel ? indirect / seSobel : null;
  return { a, b, cPrime, total, indirect, sobelZ: z, sobelP: z == null ? null : 2 * (1 - normalCdf(Math.abs(z))), proportionMediated: total.estimate ? indirect / total.estimate : null };
}
