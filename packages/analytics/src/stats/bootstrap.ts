import { Rng } from "../models/rng.js";

/**
 * BOOTSTRAP CONFIDENCE INTERVALS FOR AN INDIRECT EFFECT (advanced models from
 * the plan, 2026-10-22).
 *
 * The simple mediation model X → M → Y: a is the slope of M on X, b the slope
 * of Y on M controlling for X, and the indirect effect is a·b. Its sampling
 * distribution is skewed, so a symmetric Sobel / delta-method interval is
 * known to be too narrow on one side; the nonparametric bootstrap (resample
 * respondents with replacement, refit, take a·b) gives the percentile interval
 * and Efron's bias-corrected and accelerated (BCa) interval, which corrects
 * the percentile interval for the median bias (z0) and the skew (the jackknife
 * acceleration a).
 *
 * Everything is seeded (the estimators' mulberry32 `Rng`, index = floor(u·n)),
 * so the same data and seed give the same interval on every run and in every
 * request — `scripts/stats-reference/bootstrap_reference.py` re-implements the
 * same generator in Python and computes the replicates with numpy's least
 * squares and the intervals with scipy's normal distribution; the test holds
 * this file to it. Every fit is done from sufficient statistics (sums and
 * cross-products), so a replicate costs one pass over the resample and a
 * jackknife deletion costs O(1).
 */

/* ------------------------------------------------------------ a precise normal (the BCa levels need it) */

/** erfc to ~1e-15 relative: series below |x| < 2, Lentz continued fraction beyond */
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 2) {
    // erf(x) = 2/√π Σ (−1)^n x^(2n+1) / (n! (2n+1))
    let sum = x, term = x;
    for (let n = 1; n < 200; n++) {
      term *= -x * x / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * sum;
  }
  // erfc(x) = exp(−x²)/√π · 1/(x + 1/2 / (x + 1 / (x + 3/2 / (x + …))))
  const tiny = 1e-300;
  let f = x, C = x, D = 0;
  for (let n = 1; n < 500; n++) {
    const an = n / 2;
    D = x + an * D; D = Math.abs(D) < tiny ? 1 / tiny : 1 / D;
    C = x + an / C; if (Math.abs(C) < tiny) C = tiny;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * f);
}
/** Φ(z) to double precision */
export const phi = (z: number): number => 0.5 * erfc(-z / Math.SQRT2);
/** Φ⁻¹(p): Acklam's rational approximation polished by two Halley steps on the precise Φ */
export function phiInv(p: number): number {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let x: number;
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  for (let k = 0; k < 2; k++) {
    const e = phi(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    x = x - u / (1 + x * u / 2);
  }
  return x;
}

/** quantile type 7 (R's default, numpy's "linear") of a SORTED array */
export function quantile7(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[n - 1];
  const h = (n - 1) * q, lo = Math.floor(h), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/* ------------------------------------------------------------ the indirect effect from sums */

/** running sums for x, m, y — enough for both regressions of the mediation model */
class Sums {
  n = 0; x = 0; m = 0; y = 0; xx = 0; mm = 0; xm = 0; xy = 0; my = 0;
  add(x: number, m: number, y: number, w = 1) { this.n += w; this.x += w * x; this.m += w * m; this.y += w * y; this.xx += w * x * x; this.mm += w * m * m; this.xm += w * x * m; this.xy += w * x * y; this.my += w * m * y; }
  copy(): Sums { const s = new Sums(); Object.assign(s, this); return s; }
}

/** a, b, a·b from sums; null when either regression is degenerate (no variance in X, or X and M collinear) */
export function indirectFromSums(s: { n: number; x: number; m: number; y: number; xx: number; mm: number; xm: number; xy: number; my: number }): { a: number; b: number; ab: number } | null {
  const n = s.n;
  if (n < 3) return null;
  const Sxx = s.xx - s.x * s.x / n, Smm = s.mm - s.m * s.m / n, Sxm = s.xm - s.x * s.m / n, Sxy = s.xy - s.x * s.y / n, Smy = s.my - s.m * s.y / n;
  const det = Sxx * Smm - Sxm * Sxm;
  if (!(Sxx > 1e-12 * Math.max(1, Math.abs(s.xx))) || !(Math.abs(det) > 1e-12 * Math.max(1, Math.abs(Sxx * Smm)))) return null;
  const a = Sxm / Sxx;
  const b = (Sxx * Smy - Sxm * Sxy) / det;
  return { a, b, ab: a * b };
}

export interface BootstrapCi { level: number; low: number; high: number }
export interface IndirectBootstrap {
  /** complete cases used */
  n: number;
  a: number; b: number;
  /** the estimate on the full sample */
  indirect: number;
  draws: number;
  /** replicates where a regression was degenerate (dropped, counted) */
  failed: number;
  seed: number;
  /** standard deviation of the replicates */
  se: number;
  /** mean of the replicates minus the estimate */
  bias: number;
  percentile: BootstrapCi;
  bca: BootstrapCi & { z0: number; acceleration: number };
  /** both intervals exclude zero — the bootstrap reading of "the indirect effect is not zero" */
  excludesZero: { percentile: boolean; bca: boolean };
}

export interface IndirectBootstrapOptions {
  draws?: number;
  seed?: number;
  /** two-sided confidence level, default 0.95 */
  level?: number;
}

/**
 * The percentile and BCa intervals of a·b for X → M → Y, from `draws`
 * resamples of the complete cases. Listwise: a case with any of the three
 * missing is left out (and counted in `n`'s absence). Null when the full-sample
 * model cannot be fitted.
 */
export function bootstrapIndirect(x: readonly (number | null | undefined)[], m: readonly (number | null | undefined)[], y: readonly (number | null | undefined)[], opts: IndirectBootstrapOptions = {}): IndirectBootstrap | { error: string } {
  const draws = Math.max(200, Math.min(20_000, Math.round(opts.draws ?? 5000)));
  const seed = Math.max(0, Math.min(2 ** 31 - 1, Math.round(opts.seed ?? 1)));
  const level = opts.level && opts.level > 0.5 && opts.level < 1 ? opts.level : 0.95;
  const X: number[] = [], M: number[] = [], Y: number[] = [];
  const len = Math.min(x.length, m.length, y.length);
  for (let i = 0; i < len; i++) {
    const xi = x[i], mi = m[i], yi = y[i];
    if (xi == null || mi == null || yi == null || !Number.isFinite(xi) || !Number.isFinite(mi) || !Number.isFinite(yi)) continue;
    X.push(xi); M.push(mi); Y.push(yi);
  }
  const n = X.length;
  if (n < 10) return { error: `The bootstrap needs at least 10 complete cases of the predictor, the mediator and the outcome — ${n} have all three.` };
  const full = new Sums();
  for (let i = 0; i < n; i++) full.add(X[i], M[i], Y[i]);
  const est = indirectFromSums(full);
  if (!est) return { error: "The mediation model cannot be fitted: the predictor has no variance, or the predictor and the mediator are collinear." };

  /* replicates */
  const rng = new Rng(seed);
  const reps: number[] = [];
  let failed = 0;
  const counts = new Int32Array(n);
  for (let bIdx = 0; bIdx < draws; bIdx++) {
    counts.fill(0);
    for (let k = 0; k < n; k++) counts[Math.floor(rng.next() * n)]++;
    const s = new Sums();
    for (let i = 0; i < n; i++) if (counts[i]) s.add(X[i], M[i], Y[i], counts[i]);
    const r = indirectFromSums(s);
    if (r) reps.push(r.ab); else failed++;
  }
  if (reps.length < 100) return { error: `Only ${reps.length} of ${draws} bootstrap resamples could be fitted — the data are too degenerate for a bootstrap interval.` };
  const sorted = Float64Array.from(reps).sort();
  const B = sorted.length;
  const mean = reps.reduce((t, v) => t + v, 0) / B;
  const se = Math.sqrt(reps.reduce((t, v) => t + (v - mean) ** 2, 0) / (B - 1));
  const alpha = (1 - level) / 2;
  const percentile = { level, low: quantile7(sorted, alpha), high: quantile7(sorted, 1 - alpha) };

  /* BCa: z0 from the share of replicates below the estimate, a from the jackknife */
  let below = 0;
  for (const v of reps) if (v < est.ab) below++;
  const prop = below / B;
  const z0 = prop <= 0 ? -Infinity : prop >= 1 ? Infinity : phiInv(prop);
  const jack: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = full.copy();
    s.add(X[i], M[i], Y[i], -1);
    const r = indirectFromSums(s);
    if (r) jack.push(r.ab);
  }
  const jm = jack.reduce((t, v) => t + v, 0) / (jack.length || 1);
  let num = 0, den = 0;
  for (const v of jack) { const d = jm - v; num += d * d * d; den += d * d; }
  const acceleration = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
  const adj = (zAlpha: number) => { const t = z0 + zAlpha; return phi(z0 + t / (1 - acceleration * t)); };
  let bca: BootstrapCi & { z0: number; acceleration: number };
  if (!Number.isFinite(z0)) bca = { ...percentile, z0, acceleration };   // every replicate on one side: the BCa correction is undefined; the percentile interval stands and is said to
  else bca = { level, low: quantile7(sorted, adj(phiInv(alpha))), high: quantile7(sorted, adj(phiInv(1 - alpha))), z0, acceleration };
  const excl = (ci: BootstrapCi) => ci.low > 0 || ci.high < 0;
  return { n, a: est.a, b: est.b, indirect: est.ab, draws, failed, seed, se, bias: mean - est.ab, percentile, bca, excludesZero: { percentile: excl(percentile), bca: excl(bca) } };
}
