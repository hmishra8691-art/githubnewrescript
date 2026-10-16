/**
 * Conditional (multinomial) logit for choice data — the aggregate model behind
 * conjoint part-worths and MaxDiff utilities. Each choice set has k
 * alternatives with feature vectors x_j and one chosen index; the likelihood
 * is Π exp(x_c β) / Σ_j exp(x_j β). Newton–Raphson with analytic gradient and
 * Hessian, ridge-stabilised so a level never chosen still converges.
 */
import { inverse, type Matrix } from "./matrix.js";
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
    for (let i = 0; i < p; i++) { L -= (ridge / 2) * b[i] * b[i]; g[i] -= ridge * b[i]; H[i][i] -= ridge; }
    return { L, g, H };
  };
  let cur = evaluate(beta);
  ll = cur.L;
  for (iter = 1; iter <= maxIter; iter++) {
    const negH = cur.H.map((r) => r.map((v) => -v));
    const inv = inverse(negH);
    if (!inv) break;
    const step = inv.map((r) => r.reduce((t, v, i) => t + v * cur.g[i], 0));
    let t = 1, next = beta.map((b, i) => b + step[i]), ev = evaluate(next);
    while (ev.L < cur.L && t > 1e-4) { t /= 2; next = beta.map((b, i) => b + t * step[i]); ev = evaluate(next); }
    const change = Math.abs(ev.L - cur.L);
    beta = next; cur = ev; ll = ev.L;
    /* the change is judged against the size of the likelihood: an absolute 1e-8 is below the floating-point noise of a log-likelihood in the hundreds of thousands, so large samples never "converged" and ran all 100 iterations, line search and all (audit F-3) */
    if (change < 1e-8 * Math.max(1, Math.abs(ev.L))) { converged = true; break; }
  }
  const negH = cur.H.map((r) => r.map((v) => -v));
  const cov = inverse(negH);
  const se = beta.map((_, i) => (cov ? Math.sqrt(Math.max(cov[i][i], 0)) : NaN));
  const z = beta.map((b, i) => (se[i] ? b / se[i] : 0));
  const pv = z.map((v) => 2 * (1 - normalCdf(Math.abs(v))));
  const W = sets.reduce((t, s) => t + (s.weight ?? 1), 0);
  const null0 = sets.reduce((t, s) => t - (s.weight ?? 1) * Math.log(s.alternatives.length), 0);
  let hits = 0;
  for (const s of sets) { const u = s.alternatives.map((x) => util(x, beta)); if (u.indexOf(Math.max(...u)) === s.chosen) hits += s.weight ?? 1; }
  return { beta, se, z, p: pv, logLikelihood: ll, nullLogLikelihood: null0, mcFaddenR2: null0 ? 1 - ll / null0 : 0, iterations: iter, converged, n: sets.length, hitRate: W ? hits / W : 0 };
}

/** Share of preference for a set of profiles under the logit rule. */
export function logitShares(utilities: number[]): number[] {
  const m = Math.max(...utilities);
  const e = utilities.map((u) => Math.exp(u - m));
  const Z = e.reduce((t, v) => t + v, 0);
  return e.map((v) => v / Z);
}
