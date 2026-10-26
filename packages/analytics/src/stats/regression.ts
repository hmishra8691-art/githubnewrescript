/**
 * Regression: OLS (simple/multiple, with interaction terms), binary logistic
 * (IRLS), multinomial logistic (Newton on the softmax likelihood), plus the
 * moderation (interaction) and mediation (Baron–Kenny with a Sobel test)
 * wrappers built on them.
 */
import { inverse, multiplyVec, scaledInverse, transpose, zeros, type Matrix } from "./matrix.js";
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
  /** variance inflation factor of each predictor (intercept excluded); values above 10 mean the predictors overlap strongly */
  vif: Record<string, number>;
  /** plain-language cautions about the fit (strong overlap between predictors) */
  warnings: string[];
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
  const inv = scaledInverse(XtX);
  if (!inv) return { error: "predictors are collinear (one is a combination of the others) — drop one" };
  // variance inflation: the diagonal of the inverse correlation matrix of the predictors
  const vif: Record<string, number> = {}, vifWarnings: string[] = [];
  if (k > 2) {
    const P = Xt.slice(1), means = P.map((c) => c.reduce((t, v) => t + v, 0) / n);
    const S = P.map((ci, a) => P.map((cj, b) => ci.reduce((t, v, i) => t + (v - means[a]) * (cj[i] - means[b]), 0)));
    const R = S.map((row, a) => row.map((v, b) => (S[a][a] && S[b][b] ? v / Math.sqrt(S[a][a] * S[b][b]) : 0)));
    const Rinv = inverse(R, 1e-12);
    if (Rinv) terms.slice(1).forEach((t, j) => { vif[t] = Rinv[j][j]; if (Rinv[j][j] > 10) vifWarnings.push(`${t} overlaps strongly with the other predictors (VIF ${Rinv[j][j].toFixed(1)}), so its coefficient is unstable.`); });
    else vifWarnings.push("The predictors overlap almost completely, so individual coefficients cannot be told apart.");
  }
  const Xty = Xt.map((row) => row.reduce((t, v, i) => t + v * Y[i], 0));
  const beta = multiplyVec(inv, Xty);
  const fitted = X.map((row) => row.reduce((t, v, j) => t + v * beta[j], 0));
  const residuals = Y.map((v, i) => v - fitted[i]);
  const ybar = Y.reduce((a, b) => a + b, 0) / n;
  const ssTot = Y.reduce((t, v) => t + (v - ybar) ** 2, 0), ssRes = residuals.reduce((t, r) => t + r * r, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  const df = [k - 1, n - k] as [number, number];
  const adjustedR2 = ssTot ? 1 - (1 - r2) * ((n - 1) / (n - k)) : 0;
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
  /*
   * The quantity that has to be positive is the total sum of squares, not the
   * residual (audit S9). With a constant y, ssTot is exactly 0 while ssRes is
   * floating-point noise, so the old guard let the ratio through and F came
   * out at exactly −df[1]/df[0] — and `fTestP` of a negative F returns 1, so
   * an undefined model was presented as a clean "not significant". When y
   * does not vary there is no variance to explain and no F to report; the
   * `max(0, …)` then absorbs the same noise in a perfect-fit model.
   */
  const f = df[0] > 0 && ssRes > 0 && ssTot > 0 ? (Math.max(0, ssTot - ssRes) / df[0]) / (ssRes / df[1]) : null;
  return { kind: "linear", n, coefficients, r2, adjustedR2, f, fP: f == null ? null : fTestP(f, df[0], df[1]), df, residualSe: Math.sqrt(sigma2), fitted, residuals, terms, vif, warnings: vifWarnings };
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
    cov = scaledInverse(XtWX, 1e-11);
    if (!cov) return { error: "the model cannot be fitted: predictors are collinear, or an outcome group is perfectly predicted (separation)" };
    const step = multiplyVec(cov, grad);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) { converged = true; break; }
  }
  if (!converged) return { error: `the logistic model did not converge in ${maxIter} iterations — usually a sign of separation (a predictor that almost perfectly splits the outcome) or too few cases in one outcome group; its odds ratios would not be reliable, so none are shown` };
  const huge = beta.findIndex((b, j) => j > 0 && Math.abs(b) > 12);
  if (huge > 0) return { error: `the logistic model has an extreme coefficient for ${terms[huge]} (odds ratio beyond 150 000), which means a predictor almost perfectly splits the outcome (quasi-separation); no odds ratios are shown` };
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
    /*
     * Identification is tested on the information matrix itself (audit S5).
     * A 1e-8 ridge used to be added to the diagonal BEFORE this inversion,
     * and `inverse`'s tolerance is absolute, so a rank-deficient H always
     * inverted and the error below was unreachable: an exactly collinear
     * design was fitted and published with SEs of 8944 and p = 1.0000, while
     * `ols` and `logistic` both correctly refuse the very same design.
     * `scaledInverse` applies the scale-invariant relative tolerance those
     * two already use, and with it the ridge is not needed.
     */
    cov = scaledInverse(H, 1e-11);
    if (!cov) return { error: "the model cannot be fitted: predictors are collinear, or an outcome group is perfectly predicted (separation)" };
    const step = multiplyVec(cov, grad);
    theta = theta.map((t, j) => t + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) { converged = true; break; }
  }
  /*
   * A fit that ran out of iterations is not a fit (audit S5). `converged`
   * stayed false and every estimate, SE, z and p was returned anyway — so a
   * predictor that perfectly determines the outcome came back at p = 0.99,
   * and the only caller never read the flag. `logistic` refuses in exactly
   * these two situations; this now matches it.
   */
  if (!converged) return { error: `the multinomial model did not converge in ${maxIter} iterations — usually a sign of separation (a predictor that almost perfectly splits the outcome) or too few cases in an outcome group; its coefficients would not be reliable, so none are shown` };
  const huge = theta.findIndex((b, j) => j % k !== 0 && Math.abs(b) > 12);
  if (huge >= 0) return { error: `the multinomial model has an extreme coefficient for ${terms[huge % k]} (odds ratio beyond 150 000), which means a predictor almost perfectly splits the outcome (quasi-separation); no coefficients are shown` };
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
  /*
   * All three models are fitted on ONE complete-case base (audit S8).
   *
   * Each `ols` call drops the missings of the variables it is given, so with
   * a gap in any of x, m or y the three models were fitted on three different
   * subsets: X→M dropped cases missing x or m, X→Y dropped cases missing x or
   * y, and the full model dropped all three. The Baron–Kenny identity
   * c = c' + a·b then fails — a·b + c' = 1.1333 against c = 1.1758 on a
   * ten-case example with one gap — and `indirect`, `proportionMediated` and
   * the Sobel test are mutually inconsistent, with nothing to say so.
   */
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const len = Math.min(x.length, m.length, y.length);
  const xs: number[] = [], ms: number[] = [], ys: number[] = [];
  for (let i = 0; i < len; i++) if (ok(x[i]) && ok(m[i]) && ok(y[i])) { xs.push(x[i] as number); ms.push(m[i] as number); ys.push(y[i] as number); }
  const mA = ols(ms, { predictors: [{ name: "X", values: xs }] });
  const mTotal = ols(ys, { predictors: [{ name: "X", values: xs }] });
  const mFull = ols(ys, { predictors: [{ name: "X", values: xs }, { name: "M", values: ms }] });
  if ("error" in mA) return mA; if ("error" in mTotal) return mTotal; if ("error" in mFull) return mFull;
  const a = mA.coefficients[1], b = mFull.coefficients[2], cPrime = mFull.coefficients[1], total = mTotal.coefficients[1];
  const indirect = a.estimate * b.estimate;
  const seSobel = a.se != null && b.se != null ? Math.sqrt(b.estimate ** 2 * a.se ** 2 + a.estimate ** 2 * b.se ** 2) : null;
  const z = seSobel ? indirect / seSobel : null;
  return { a, b, cPrime, total, indirect, sobelZ: z, sobelP: z == null ? null : 2 * (1 - normalCdf(Math.abs(z))), proportionMediated: total.estimate ? indirect / total.estimate : null };
}
