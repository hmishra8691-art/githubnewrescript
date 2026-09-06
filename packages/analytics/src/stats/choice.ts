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

export function conditionalLogit(sets: ChoiceSet[], p: number, opts: { maxIter?: number; ridge?: number } = {}): ConditionalLogit {
  const maxIter = opts.maxIter ?? 100, ridge = opts.ridge ?? 1e-3;
  let beta = new Array(p).fill(0);
  let ll = 0, iter = 0, converged = false;
  const util = (x: number[], b: number[]) => x.reduce((t, v, i) => t + v * b[i], 0);
  const evaluate = (b: number[]) => {
    let L = 0;
    const g = new Array(p).fill(0);
    const H: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
    for (const s of sets) {
      const w = s.weight ?? 1;
      const u = s.alternatives.map((x) => util(x, b));
      const m = Math.max(...u);
      const e = u.map((v) => Math.exp(v - m));
      const Z = e.reduce((t, v) => t + v, 0);
      const pr = e.map((v) => v / Z);
      L += w * (u[s.chosen] - m - Math.log(Z));
      const xbar = new Array(p).fill(0);
      s.alternatives.forEach((x, j) => x.forEach((v, i) => { xbar[i] += pr[j] * v; }));
      s.alternatives[s.chosen].forEach((v, i) => { g[i] += w * (v - xbar[i]); });
      s.alternatives.forEach((x, j) => { for (let a = 0; a < p; a++) for (let c = 0; c < p; c++) H[a][c] -= w * pr[j] * (x[a] - xbar[a]) * (x[c] - xbar[c]); });
    }
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
    if (change < 1e-8) { converged = true; break; }
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
