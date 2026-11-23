/**
 * LATENT CLASS — WHAT THE CLASSES ARE RELATED TO (2026-11-23).
 *
 * After `latentClass` (step 1: the measurement model), three ways to relate the classes to other variables, from the
 * quickest to the statistically correct:
 *
 *   modalCrosstab    ASSIGN, THEN CROSS-TAB. Each respondent is put in their most likely class and the class is
 *                    cross-tabulated with the variable. Easy to read, but classification error shrinks the
 *                    differences between classes: the lower the entropy, the more. Refused below entropy 0.6,
 *                    flagged below 0.8.
 *
 *   bchDistal        THE BCH THREE-STEP for a variable the classes may DIFFER on (a distal outcome: spend, NPS,
 *                    region…). Bolck, Croon & Hagenaars (2004); Vermunt (2010); Bakk & Vermunt (2016). Each
 *                    respondent gets a weight per class, the inverse of the classification-error matrix at their
 *                    assigned class, so the class-specific means / proportions are corrected for misclassification.
 *
 *   mlThreeStep      THE ML THREE-STEP for variables that may PREDICT class membership (covariates: age, region…).
 *                    Vermunt (2010): a multinomial logit of the class on the covariates, with the assigned class as
 *                    an indicator whose error probabilities are fixed at the step-1 classification-error matrix.
 *                    Odds ratios against the largest class, with standard errors from the observed information.
 *
 * The step-1 model is held fixed in steps 2 and 3 (that is the point of the method: the covariates do not move the
 * classes). The uncertainty of step 1 itself is not propagated into the step-3 standard errors — the standard
 * three-step practice, stated with every result.
 */
import { invert } from "./linalg.js";
import { Rng } from "./rng.js";
import { gammaP, normalCdf, normalQuantile } from "../stats/distributions.js";

const chiSf = (x: number, df: number) => (x > 0 && df > 0 ? Math.max(0, 1 - gammaP(df / 2, x / 2)) : 1);

/* ------------------------------------------------------------------ step 2 */

/**
 * D[t][s] = P(assigned s | true class t), from the posteriors and the modal assignment (Vermunt 2010, eq. 6).
 * Rows sum to 1. Diagonal near 1 = little classification error.
 */
export function classificationErrors(posterior: number[][], modal: number[], K: number): number[][] {
  const D = Array.from({ length: K }, () => new Array(K).fill(0));
  const tot = new Array(K).fill(0);
  posterior.forEach((p, i) => { for (let t = 0; t < K; t++) { D[t][modal[i]] += p[t]; tot[t] += p[t]; } });
  return D.map((row, t) => row.map((v) => (tot[t] > 0 ? v / tot[t] : 0)));
}

export function relativeEntropy(posterior: number[][]): number | null {
  const K = posterior[0]?.length ?? 0, N = posterior.length;
  if (K < 2 || !N) return null;
  let e = 0;
  for (const row of posterior) for (const p of row) if (p > 0) e -= p * Math.log(p);
  return 1 - e / (N * Math.log(K));
}

/** BCH weights: w[i][t] = (D⁻¹)[modal_i][t]. Null when D cannot be inverted (classes not separated at all). */
export function bchWeights(D: number[][], modal: number[]): number[][] | null {
  const K = D.length;
  const inv = invert(D.flat(), K);
  if (!inv) return null;
  return modal.map((s) => Array.from({ length: K }, (_, t) => inv[s * K + t]));
}

/* ------------------------------------------------------------------ step 3: distal outcomes (BCH) */

export interface DistalCategorical { kind: "categorical"; values: (number | string | null)[]; categories: { code: number | string; label: string }[] }
export interface DistalNumeric { kind: "numeric"; values: (number | null)[] }

export interface BchResult {
  kind: "categorical" | "numeric";
  /** per class: proportions per category (categorical) or [mean] (numeric) */
  estimates: number[][];
  /** 95% bootstrap percentile intervals, same shape as estimates */
  lower: number[][];
  upper: number[][];
  /** numeric only: the class-specific SD */
  sd?: number[];
  /** the overall test that the classes do not differ: Wald χ² on bootstrap covariance */
  test: { chi2: number; df: number; p: number } | null;
  n: number;
  bootstrap: number;
  warnings: string[];
}

function bchEstimate(w: number[][], y: DistalCategorical | DistalNumeric, idx: number[], K: number): { est: number[][]; sd?: number[]; clipped: boolean } {
  let clipped = false;
  if (y.kind === "numeric") {
    const est: number[][] = [], sd: number[] = [];
    for (let t = 0; t < K; t++) {
      let sw = 0, sy = 0;
      for (const i of idx) { const v = y.values[i]; if (v == null) continue; sw += w[i][t]; sy += w[i][t] * v; }
      const m = sw !== 0 ? sy / sw : NaN;
      let ss = 0;
      for (const i of idx) { const v = y.values[i]; if (v == null) continue; ss += w[i][t] * (v - m) ** 2; }
      est.push([m]); sd.push(sw > 0 && ss > 0 ? Math.sqrt(ss / sw) : NaN);
    }
    return { est, sd, clipped };
  }
  const C = y.categories.length;
  const est = Array.from({ length: K }, () => new Array(C).fill(0));
  for (let t = 0; t < K; t++) {
    const tot = new Array(C).fill(0);
    for (const i of idx) { const v = y.values[i]; if (v == null) continue; const c = y.categories.findIndex((x) => String(x.code) === String(v)); if (c >= 0) tot[c] += w[i][t]; }
    let pos = tot.map((v) => { if (v < 0) { clipped = true; return 0; } return v; });
    const s = pos.reduce((a, b) => a + b, 0);
    pos = pos.map((v) => (s > 0 ? v / s : NaN));
    est[t] = pos;
  }
  return { est, clipped };
}

/**
 * Class-specific means (numeric) or proportions (categorical) of a variable, corrected for classification error.
 * The bootstrap resamples respondents and recomputes D and the weights (the step-1 posteriors held fixed).
 */
export function bchDistal(posterior: number[][], modal: number[], y: DistalCategorical | DistalNumeric, opts: { bootstrap?: number; seed?: number } = {}): BchResult | { error: string } {
  const K = posterior[0]?.length ?? 0;
  if (K < 2) return { error: "A distal-outcome analysis needs at least two classes." };
  const all = posterior.map((_, i) => i).filter((i) => y.values[i] != null);
  if (all.length < 30) return { error: `Only ${all.length} respondents have a value on this variable — at least 30 are needed.` };
  const D = classificationErrors(posterior, modal, K);
  const w = bchWeights(D, modal);
  if (!w) return { error: "The classes are not separated enough to correct for classification error (the classification-error matrix cannot be inverted). Fit fewer classes." };
  const base = bchEstimate(w, y, all, K);
  const B = Math.max(0, Math.floor(opts.bootstrap ?? 200));
  const rng = new Rng(Math.floor(opts.seed ?? 1));
  const draws: number[][][] = [];
  for (let b = 0; b < B; b++) {
    const idx = all.map(() => all[Math.floor(rng.next() * all.length)]);
    const Db = classificationErrors(idx.map((i) => posterior[i]), idx.map((i) => modal[i]), K);
    const wb = bchWeights(Db, modal);
    if (!wb) continue;
    draws.push(bchEstimate(wb, y, idx, K).est);
  }
  const shape = base.est.map((r) => r.map(() => 0));
  const q = (t: number, c: number, p: number) => { const v = draws.map((d) => d[t][c]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.floor(p * (v.length - 1))))] : NaN; };
  const lower = shape.map((r, t) => r.map((_, c) => q(t, c, 0.025)));
  const upper = shape.map((r, t) => r.map((_, c) => q(t, c, 0.975)));
  /* Wald test of equal classes: contrasts class t − class 0, over all categories but the last (numeric: the mean) */
  let test: BchResult["test"] = null;
  const C = base.est[0].length;
  const cols = y.kind === "numeric" ? [0] : Array.from({ length: Math.max(1, C - 1) }, (_, c) => c);
  const vec = (e: number[][]) => { const out: number[] = []; for (let t = 1; t < K; t++) for (const c of cols) out.push(e[t][c] - e[0][c]); return out; };
  const d = vec(base.est);
  const dv = draws.map(vec).filter((v) => v.every(Number.isFinite));
  if (dv.length >= 30 && d.every(Number.isFinite)) {
    const m = d.length;
    const mean = new Array(m).fill(0); for (const v of dv) for (let a = 0; a < m; a++) mean[a] += v[a] / dv.length;
    const S = new Array(m * m).fill(0);
    for (const v of dv) for (let a = 0; a < m; a++) for (let b2 = 0; b2 < m; b2++) S[a * m + b2] += ((v[a] - mean[a]) * (v[b2] - mean[b2])) / (dv.length - 1);
    const Si = invert(S, m);
    if (Si) { let chi2 = 0; for (let a = 0; a < m; a++) for (let b2 = 0; b2 < m; b2++) chi2 += d[a] * Si[a * m + b2] * d[b2]; test = { chi2, df: m, p: chiSf(chi2, m) }; }
  }
  const warnings: string[] = [];
  if (base.clipped) warnings.push("Some corrected proportions came out below zero (possible with BCH weights when a category is rare in a class) and were set to zero.");
  if (draws.length < B) warnings.push(`${B - draws.length} of ${B} bootstrap samples could not be corrected and were left out.`);
  return { kind: y.kind, estimates: base.est, lower, upper, ...(base.sd ? { sd: base.sd } : {}), test, n: all.length, bootstrap: draws.length, warnings };
}

/* ------------------------------------------------------------------ step 3: covariates (ML) */

export interface MlThreeStepResult {
  /** coefficients[t−1][j]: class t (t ≥ 1) against class 0, for intercept (j = 0) and each covariate column */
  coefficients: number[][];
  se: number[][];
  /** per covariate column (not the intercept): Wald χ² that it predicts nothing, df K − 1 */
  wald: { chi2: number; df: number; p: number }[];
  logLik: number;
  iterations: number;
  converged: boolean;
  n: number;
  warnings: string[];
}

function softmaxRow(beta: number[][], x: number[], K: number): number[] {
  const eta = [0];
  for (let t = 1; t < K; t++) { let s = 0; for (let j = 0; j < x.length; j++) s += beta[t - 1][j] * x[j]; eta.push(s); }
  const mx = Math.max(...eta);
  const e = eta.map((v) => Math.exp(v - mx));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / z);
}

function loglik3(beta: number[][], X: number[][], modal: number[], D: number[][], K: number): number {
  let ll = 0;
  for (let i = 0; i < X.length; i++) {
    const p = softmaxRow(beta, X[i], K);
    let s = 0; for (let t = 0; t < K; t++) s += p[t] * D[t][modal[i]];
    ll += Math.log(Math.max(s, 1e-300));
  }
  return ll;
}

/**
 * Multinomial logit of the class on covariates X (each row starts with 1 for the intercept), with the assigned class
 * measured with the fixed error D. EM: the E-step gives each respondent's class probabilities given their assigned
 * class and covariates; the M-step is a weighted multinomial logit by Newton–Raphson.
 */
export function mlThreeStep(posterior: number[][], modal: number[], X: number[][], opts: { maxIter?: number; tol?: number } = {}): MlThreeStepResult | { error: string } {
  const K = posterior[0]?.length ?? 0, N = X.length, P = X[0]?.length ?? 0;
  if (K < 2) return { error: "Covariates need at least two classes." };
  if (N < 30 || N <= (K - 1) * P * 5) return { error: `Only ${N} respondents for ${(K - 1) * P} coefficients — at least five respondents per coefficient (and 30 in all) are needed.` };
  const D = classificationErrors(posterior, modal, K);
  let beta = Array.from({ length: K - 1 }, () => new Array(P).fill(0));
  /* start from the class sizes */
  const sizes = new Array(K).fill(0); posterior.forEach((p) => p.forEach((v, t) => (sizes[t] += v)));
  for (let t = 1; t < K; t++) beta[t - 1][0] = Math.log(Math.max(sizes[t], 1e-6) / Math.max(sizes[0], 1e-6));
  const maxIter = opts.maxIter ?? 500, tol = opts.tol ?? 1e-9;
  let ll = loglik3(beta, X, modal, D, K), iter = 0, converged = false;
  const m = (K - 1) * P;
  for (iter = 1; iter <= maxIter; iter++) {
    /* E-step */
    const q = X.map((x, i) => { const p = softmaxRow(beta, x, K); const r = p.map((v, t) => v * D[t][modal[i]]); const z = r.reduce((a, b) => a + b, 0) || 1; return r.map((v) => v / z); });
    /* M-step: a few Newton steps on Σ_i Σ_t q_it log softmax_t(x_i) */
    for (let nt = 0; nt < 5; nt++) {
      const g = new Array(m).fill(0), H = new Array(m * m).fill(0);
      for (let i = 0; i < N; i++) {
        const p = softmaxRow(beta, X[i], K), x = X[i];
        for (let a = 1; a < K; a++) {
          for (let j = 0; j < P; j++) g[(a - 1) * P + j] += (q[i][a] - p[a]) * x[j];
          for (let b = 1; b < K; b++) {
            const w = p[a] * ((a === b ? 1 : 0) - p[b]);
            for (let j = 0; j < P; j++) for (let k = 0; k < P; k++) H[((a - 1) * P + j) * m + (b - 1) * P + k] += w * x[j] * x[k];
          }
        }
      }
      const Hi = invert(H, m);
      if (!Hi) return { error: "The covariates are collinear or a category has no respondents — the model cannot be estimated. Drop or merge covariates." };
      let step = 0;
      for (let a = 0; a < m; a++) { let s = 0; for (let b = 0; b < m; b++) s += Hi[a * m + b] * g[b]; const r = Math.floor(a / P), c = a % P; beta[r][c] += s; step = Math.max(step, Math.abs(s)); }
      if (step < 1e-10) break;
    }
    const next = loglik3(beta, X, modal, D, K);
    if (Math.abs(next - ll) < tol) { ll = next; converged = true; break; }
    ll = next;
  }
  /* standard errors: the observed information of the three-step log-likelihood, by central differences */
  const flat = beta.flat();
  const f = (v: number[]) => loglik3(Array.from({ length: K - 1 }, (_, r) => v.slice(r * P, r * P + P)), X, modal, D, K);
  const h = 1e-4;
  const Hn = new Array(m * m).fill(0);
  for (let a = 0; a < m; a++) for (let b = a; b < m; b++) {
    const e = (da: number, db: number) => { const v = flat.slice(); v[a] += da; v[b] += db; return f(v); };
    const val = a === b ? (e(h, 0) - 2 * ll + e(-h, 0)) / (h * h) : (e(h, h) - e(h, -h) - e(-h, h) + e(-h, -h)) / (4 * h * h);
    Hn[a * m + b] = Hn[b * m + a] = -val;
  }
  const V = invert(Hn, m);
  const warnings: string[] = [];
  if (!converged) warnings.push(`The covariate model did not converge in ${maxIter} iterations.`);
  if (!V) return { error: "The covariate model's information matrix is singular (separation: a covariate predicts a class perfectly, or a category has no respondents in some class)." };
  const se = beta.map((row, r) => row.map((_, c) => { const v = V[(r * P + c) * m + r * P + c]; return v > 0 ? Math.sqrt(v) : NaN; }));
  const wald = Array.from({ length: P - 1 }, (_, j0) => {
    const j = j0 + 1;
    const ids = Array.from({ length: K - 1 }, (_, r) => r * P + j);
    const sub = ids.flatMap((a) => ids.map((b) => V[a * m + b]));
    const Si = invert(sub, ids.length);
    const bv = ids.map((a) => flat[a]);
    if (!Si) return { chi2: NaN, df: K - 1, p: NaN };
    let chi2 = 0; for (let a = 0; a < ids.length; a++) for (let b = 0; b < ids.length; b++) chi2 += bv[a] * Si[a * ids.length + b] * bv[b];
    return { chi2, df: K - 1, p: chiSf(chi2, K - 1) };
  });
  if (se.flat().some((v) => !Number.isFinite(v) || v > 50)) warnings.push("Some standard errors are very large — a covariate may (almost) perfectly predict a class; read those odds ratios with caution.");
  return { coefficients: beta, se, wald, logLik: ll, iterations: iter, converged, n: N, warnings };
}

/** a two-sided p-value and a 95% interval for an odds ratio from a coefficient and its SE */
export function oddsRatio(b: number, se: number): { or: number; lower: number; upper: number; z: number; p: number } {
  const z = b / se, zc = normalQuantile(0.975);
  return { or: Math.exp(b), lower: Math.exp(b - zc * se), upper: Math.exp(b + zc * se), z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/* ------------------------------------------------------------------ assign, then cross-tab */

export interface ModalCrosstab {
  /** counts[class][category] */
  counts: number[][];
  /** column % within class */
  percents: number[][];
  test: { chi2: number; df: number; p: number } | null;
  entropy: number | null;
  status: "ok" | "caution" | "refused";
  message: string;
}

/** the assigned class against a categorical variable; refused when entropy < 0.6, flagged below 0.8 */
export function modalCrosstab(posterior: number[][], modal: number[], y: DistalCategorical): ModalCrosstab {
  const K = posterior[0]?.length ?? 0, C = y.categories.length;
  const entropy = relativeEntropy(posterior);
  const counts = Array.from({ length: K }, () => new Array(C).fill(0));
  modal.forEach((s, i) => { const v = y.values[i]; if (v == null) return; const c = y.categories.findIndex((x) => String(x.code) === String(v)); if (c >= 0) counts[s][c]++; });
  const percents = counts.map((r) => { const s = r.reduce((a, b) => a + b, 0); return r.map((v) => (s ? (v / s) * 100 : NaN)); });
  const rowT = counts.map((r) => r.reduce((a, b) => a + b, 0)), colT = counts[0].map((_, c) => counts.reduce((a, r) => a + r[c], 0)), N = rowT.reduce((a, b) => a + b, 0);
  let chi2 = 0;
  for (let t = 0; t < K; t++) for (let c = 0; c < C; c++) { const e = (rowT[t] * colT[c]) / (N || 1); if (e > 0) chi2 += (counts[t][c] - e) ** 2 / e; }
  const df = (K - 1) * (C - 1);
  const test = N > 0 && df > 0 ? { chi2, df, p: chiSf(chi2, df) } : null;
  const ent = entropy ?? 1;
  const status = ent < 0.6 ? "refused" : ent < 0.8 ? "caution" : "ok";
  const message = status === "refused"
    ? `Entropy is ${ent.toFixed(2)}: respondents are assigned to classes too uncertainly for a cross-tab of the assigned class to be meaningful. Use the three-step method instead, which corrects for classification error.`
    : status === "caution"
      ? `Entropy is ${ent.toFixed(2)}: the assigned classes contain misclassified respondents, so this cross-tab understates the differences between classes. The three-step method corrects for that.`
      : `Entropy is ${ent.toFixed(2)}: classes are well separated; the cross-tab of the assigned class is a fair picture (the three-step method is still the exact one).`;
  return { counts, percents, test, entropy, status, message };
}
