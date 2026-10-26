/**
 * Conditional (multinomial) logit for choice data — the aggregate model behind
 * conjoint part-worths and MaxDiff utilities. Each choice set has k
 * alternatives with feature vectors x_j and one chosen index; the likelihood
 * is Π exp(x_c β) / Σ_j exp(x_j β). Newton–Raphson with analytic gradient and
 * Hessian. A small ridge keeps the step well behaved when a level is rarely
 * chosen; it deliberately does NOT touch the covariance, which is taken from
 * the unpenalised information matrix so that an unidentified design is
 * reported as unidentified rather than given standard errors by the penalty.
 */
import { inverse, scaledInverse, type Matrix } from "./matrix.js";
import { normalCdf } from "./distributions.js";

export interface ChoiceSet { alternatives: number[][]; chosen: number; weight?: number }

export interface ConditionalLogit {
  beta: number[];
  se: number[];
  z: number[];
  p: number[];
  logLikelihood: number;
  nullLogLikelihood: number;
  mcFaddenR2: number;
  iterations: number;
  converged: boolean;
  /** false when the design does not identify every coefficient: `se`, `z` and `p` are NaN */
  identified: boolean;
  /** collinearity, separation or a step that failed — empty when the fit is sound */
  warnings: string[];
  n: number;
  hitRate: number;
}

export function conditionalLogit(allSets: ChoiceSet[], p: number, opts: { maxIter?: number; ridge?: number } = {}): ConditionalLogit {
  const maxIter = opts.maxIter ?? 100, ridge = opts.ridge ?? 1e-3;
  /*
   * A set whose chosen index points at no alternative (−1 from a failed
   * lookup, or past the end) carries no information and used to throw from
   * inside `evaluate` — one such set took a whole analysis down (METHOD-03).
   * The callers now report what they skipped; this keeps the model itself safe.
   */
  const sets = allSets.filter((s) => Number.isInteger(s.chosen) && s.chosen >= 0 && s.chosen < s.alternatives.length);
  let beta = new Array(p).fill(0);
  let ll = 0, iter = 0, converged = false;
  const util = (x: number[], b: number[]) => x.reduce((t, v, i) => t + v * b[i], 0);
  /*
   * One pass over the choice sets, with no per-set allocation: the gradient and the Hessian are accumulated in place (the
   * Hessian by its upper triangle, mirrored at the end). The same arithmetic as before, which allocated four arrays and a
   * p×p loop per alternative per set — at tens of thousands of respondents that was most of the run time (audit F-3).
   */
  const evaluate = (b: number[]) => {
    let L = 0;
    const g = new Array(p).fill(0);
    const Hf = new Float64Array(p * p);
    const xbar = new Float64Array(p);
    let u = new Float64Array(8), e = new Float64Array(8);
    for (const s of sets) {
      const w = s.weight ?? 1, alts = s.alternatives, A = alts.length;
      if (u.length < A) { u = new Float64Array(A); e = new Float64Array(A); }
      let m = -Infinity;
      for (let j = 0; j < A; j++) { const x = alts[j]; let t = 0; for (let i = 0; i < p; i++) t += x[i] * b[i]; u[j] = t; if (t > m) m = t; }
      let Z = 0;
      for (let j = 0; j < A; j++) { e[j] = Math.exp(u[j] - m); Z += e[j]; }
      L += w * (u[s.chosen] - m - Math.log(Z));
      xbar.fill(0);
      for (let j = 0; j < A; j++) { const pr = e[j] / Z, x = alts[j]; for (let i = 0; i < p; i++) xbar[i] += pr * x[i]; }
      const ch = alts[s.chosen];
      for (let i = 0; i < p; i++) g[i] += w * (ch[i] - xbar[i]);
      for (let j = 0; j < A; j++) {
        const wp = w * (e[j] / Z), x = alts[j];
        for (let a = 0; a < p; a++) { const da = x[a] - xbar[a]; if (da === 0) continue; const f = wp * da; for (let c = a; c < p; c++) Hf[a * p + c] -= f * (x[c] - xbar[c]); }
      }
    }
    const H: Matrix = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, c) => (c >= a ? Hf[a * p + c] : Hf[c * p + a])));
    return { L, g, H };
  };
  /*
   * The ridge stabilises the OPTIMISATION. It is not allowed to be the thing
   * that makes the model look identified (audit S1).
   *
   * It used to be added to H inside `evaluate`, before the one and only
   * inversion, so `inverse` could never return null — there was no
   * collinearity check and no separation check anywhere in this function, and
   * the reported standard errors were exactly 0.894/√ridge, a function of the
   * penalty constant rather than of the data. With two attributes where
   * x2 = 2·x1, the identified combination b1 + 2·b2 came back correct every
   * time while the individual SEs ran from 8.9 to 283 as the ridge moved from
   * 1e-2 to 1e-5, with nothing said. `evaluate` now returns the unpenalised
   * likelihood, gradient and Hessian; the penalty is applied for the Newton
   * step and the line search only, and the covariance below comes from the
   * unpenalised information matrix.
   */
  type Eval = { L: number; g: number[]; H: Matrix };
  const penalised = (b: number[], e: Eval): Eval => {
    if (!ridge) return e;
    let L = e.L;
    const g = e.g.slice(), H = e.H.map((r) => r.slice());
    for (let i = 0; i < p; i++) { L -= (ridge / 2) * b[i] * b[i]; g[i] -= ridge * b[i]; H[i][i] -= ridge; }
    return { L, g, H };
  };
  const warnings: string[] = [];
  let raw = evaluate(beta);
  let cur = penalised(beta, raw);
  ll = cur.L;
  for (iter = 1; iter <= maxIter; iter++) {
    const negH = cur.H.map((r) => r.map((v) => -v));
    const inv = inverse(negH);
    if (!inv) { warnings.push("The information matrix could not be inverted, so the fit stopped before it had settled."); break; }
    const step = inv.map((r) => r.reduce((t, v, i) => t + v * cur.g[i], 0));
    let t = 1, next = beta.map((b, i) => b + step[i]), rawNext = evaluate(next), ev = penalised(next, rawNext);
    while (ev.L < cur.L && t > 1e-4) { t /= 2; next = beta.map((b, i) => b + t * step[i]); rawNext = evaluate(next); ev = penalised(next, rawNext); }
    const change = Math.abs(ev.L - cur.L);
    beta = next; cur = ev; raw = rawNext; ll = ev.L;
    /* the change is judged against the size of the likelihood: an absolute 1e-8 is below the floating-point noise of a log-likelihood in the hundreds of thousands, so large samples never "converged" and ran all 100 iterations, line search and all (audit F-3) */
    if (change < 1e-8 * Math.max(1, Math.abs(ev.L))) { converged = true; break; }
  }
  /*
   * "The objective stopped moving" is not convergence (audit S1). Under
   * separation the likelihood flattens toward zero while β marches to ±∞, so
   * the relative-change test on its own reported converged: true with
   * β = 24.2 and SE = 18013, and an attribute chosen in every single task
   * came out at p = 0.35 — a number that moved to p = 0.04 if the ridge was
   * raised. The gradient has to be at zero too, and β has to be of a finite
   * size for the maximum to exist at all.
   */
  const gradMax = p ? Math.max(...cur.g.map(Math.abs)) : 0;
  if (converged && gradMax > 1e-6 * Math.max(1, Math.abs(cur.L))) {
    converged = false;
    warnings.push("The fit stopped changing without reaching a maximum — its gradient is still away from zero — so these utilities are approximate.");
  }
  /*
   * Separation, detected rather than guessed at.
   *
   * The ridge gives the penalised objective a finite maximum however
   * separated the data are: with the default 1e-3 it stopped β at 9.28, below
   * the ±12 bound, so the bound on its own never fired and an attribute
   * chosen in every single task came back at p = 0.37, converged, with
   * nothing said. The defining property needs no threshold — when the data
   * are separated the LIKELIHOOD is still rising as β is scaled up, because
   * its maximum is at infinity. One extra evaluation settles it, and the
   * margin is wide: −3.5 on a 200-set binary design, −119 on a simulated
   * 300-respondent conjoint, against +9.2e-3 under separation.
   */
  const anyBeta = p > 0 && beta.some((b) => b !== 0);
  if (anyBeta && Math.max(...beta.map(Math.abs)) > 12) {
    converged = false;
    warnings.push("A utility has run past ±12, which means a level almost perfectly determines the choice (separation). Its true value is unbounded, so neither it nor its significance can be read from this data.");
  } else if (anyBeta && evaluate(beta.map((b) => b * 1.5)).L - raw.L > 1e-8 * Math.max(1, Math.abs(raw.L))) {
    converged = false;
    warnings.push("The likelihood is still rising as the utilities grow, which means a level determines the choice wherever it appears (separation). The penalty is the only thing holding these estimates finite, so neither their size nor their significance comes from the data — collect choices in which that level loses, or drop it.");
  }
  /*
   * The covariance comes from the UNPENALISED information matrix, through the
   * same scale-invariant rank test `ols` and `logistic` use. When the design
   * does not identify every coefficient this is singular, and the standard
   * errors are then reported as NaN rather than as a number the penalty
   * invented. A NaN SE also has to stay NaN downstream: `se[i] ? … : 0` made
   * it z = 0, p = 1 — indistinguishable from a real null result.
   */
  const cov = scaledInverse(raw.H.map((r) => r.map((v) => -v)), 1e-11);
  const identified = cov != null;
  if (!identified) warnings.push("The attributes are collinear, or a level never varies, so their utilities cannot be told apart. The estimates still describe the combination the data identifies, but no standard errors or p-values are available.");
  const se = beta.map((_, i) => (cov ? Math.sqrt(Math.max(cov[i][i], 0)) : NaN));
  const z = beta.map((b, i) => (Number.isFinite(se[i]) && se[i] > 0 ? b / se[i] : NaN));
  const pv = z.map((v) => (Number.isFinite(v) ? Math.min(1, 2 * (1 - normalCdf(Math.abs(v)))) : NaN));
  const W = sets.reduce((t, s) => t + (s.weight ?? 1), 0);
  const null0 = sets.reduce((t, s) => t - (s.weight ?? 1) * Math.log(s.alternatives.length), 0);
  let hits = 0;
  for (const s of sets) { const u = s.alternatives.map((x) => util(x, beta)); if (u.indexOf(Math.max(...u)) === s.chosen) hits += s.weight ?? 1; }
  return { beta, se, z, p: pv, logLikelihood: ll, nullLogLikelihood: null0, mcFaddenR2: null0 ? 1 - ll / null0 : 0, iterations: iter, converged, identified, warnings, n: sets.length, hitRate: W ? hits / W : 0 };
}

/** Share of preference for a set of profiles under the logit rule. */
export function logitShares(utilities: number[]): number[] {
  const m = Math.max(...utilities);
  const e = utilities.map((u) => Math.exp(u - m));
  const Z = e.reduce((t, v) => t + v, 0);
  return e.map((v) => v / Z);
}
