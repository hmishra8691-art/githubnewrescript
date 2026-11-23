/**
 * LATENT-CLASS CHOICE MODEL (LC-MNL) for conjoint / discrete-choice data (2026-11-23).
 *
 * Segments respondents by HOW they choose: K classes, each with its own part-worths, and every respondent belonging
 * to one class with probability π_k. The likelihood of respondent n's choices is
 *
 *     L_n = Σ_k π_k Π_t exp(x_{n,t,c} β_k) / Σ_j exp(x_{n,t,j} β_k)
 *
 * maximised by EM (Kamakura & Russell 1989; Train 2009 ch. 14): the E-step gives each respondent's class
 * probabilities; the M-step is one weighted conditional logit per class (Newton–Raphson, warm-started) and the
 * class shares. Several random starts per K (seeded) — the best kept, and how many reached it reported, as for the
 * latent class model of indicators. K chosen by BIC (N = respondents), never automatically past the criteria.
 *
 * Standard errors are those of each class's weighted logit (respondents weighted by their posterior), the usual
 * EM by-product; they treat the posteriors as known and are somewhat too small — stated with the result.
 */
import { Rng } from "./rng.js";
import { invert } from "./linalg.js";
import type { ChoiceSet } from "../stats/choice.js";

export interface LcMnlFit {
  k: number;
  logLik: number;
  npar: number;
  aic: number;
  bic: number;
  /** relative entropy of the classification (1 = perfectly separated); null for one class */
  entropy: number | null;
  /** class shares, largest first */
  shares: number[];
  /** β per class (coded parameters) */
  betas: number[][];
  /** SEs per class from the weighted logit */
  se: number[][];
  /** respondents × classes */
  posterior: number[][];
  modal: number[];
  iterations: number;
  converged: boolean;
  starts: number;
  replicated: number;
  warnings: string[];
}

export interface LcMnlOutput { fits: LcMnlFit[]; recommended: number | null; recommendation: string; n: number; tasks: number }

const softmaxInto = (x: number[][], b: number[], out: number[]) => {
  let m = -Infinity;
  for (let j = 0; j < x.length; j++) { let u = 0; const r = x[j]; for (let i = 0; i < b.length; i++) u += r[i] * b[i]; out[j] = u; if (u > m) m = u; }
  let z = 0;
  for (let j = 0; j < x.length; j++) { out[j] = Math.exp(out[j] - m); z += out[j]; }
  for (let j = 0; j < x.length; j++) out[j] /= z;
};

/** log Π_t P(chosen | β) for one respondent */
function respLogLik(sets: ChoiceSet[], b: number[], buf: number[]): number {
  let ll = 0;
  for (const s of sets) { softmaxInto(s.alternatives, b, buf); ll += Math.log(Math.max(buf[s.chosen], 1e-300)); }
  return ll;
}

/** Newton steps on Σ_n w_n Σ_t log P(chosen | β), from β (warm start); returns β and the information matrix */
function weightedLogit(resp: ChoiceSet[][], w: number[], p: number, beta0: number[], steps: number, ridge = 1e-4): { beta: number[]; info: Float64Array | null } {
  let beta = beta0.slice();
  let info: Float64Array | null = null;
  const prob = new Array(64).fill(0);
  for (let it = 0; it < steps; it++) {
    const g = new Array(p).fill(0);
    const H = new Float64Array(p * p);
    const xbar = new Array(p).fill(0);
    for (let n = 0; n < resp.length; n++) {
      const wn = w[n]; if (!(wn > 1e-12)) continue;
      for (const s of resp[n]) {
        const A = s.alternatives.length;
        if (prob.length < A) prob.length = A;
        softmaxInto(s.alternatives, beta, prob);
        xbar.fill(0);
        for (let j = 0; j < A; j++) { const r = s.alternatives[j]; for (let i = 0; i < p; i++) xbar[i] += prob[j] * r[i]; }
        const xc = s.alternatives[s.chosen];
        for (let i = 0; i < p; i++) g[i] += wn * (xc[i] - xbar[i]);
        for (let j = 0; j < A; j++) {
          const r = s.alternatives[j], pj = prob[j] * wn;
          for (let a = 0; a < p; a++) { const da = r[a] - xbar[a]; if (da === 0) continue; for (let c = a; c < p; c++) H[a * p + c] += pj * da * (r[c] - xbar[c]); }
        }
      }
    }
    for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) H[a * p + c] = H[c * p + a];
    info = H.slice();
    for (let a = 0; a < p; a++) H[a * p + a] += ridge;
    const Hi = invert(H, p);
    if (!Hi) break;
    let step = 0;
    const next = beta.slice();
    for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += Hi[a * p + c] * (g[c] - ridge * beta[c]); next[a] += s; step = Math.max(step, Math.abs(s)); }
    beta = next;
    if (step < 1e-7) break;
  }
  return { beta, info };
}

/** Fit K = min..max latent-class choice models. Pure; seeded; deterministic. */
export function latentClassChoice(respondents: ChoiceSet[][], p: number, opts: { minClasses?: number; maxClasses?: number; starts?: number; seed?: number; maxIter?: number; tol?: number } = {}): LcMnlOutput | { error: string } {
  const resp = respondents.map((sets) => sets.filter((s) => Number.isInteger(s.chosen) && s.chosen >= 0 && s.chosen < s.alternatives.length)).filter((s) => s.length > 0);
  const N = resp.length, T = resp.reduce((a, s) => a + s.length, 0);
  const minK = Math.max(1, Math.floor(opts.minClasses ?? 1)), maxK = Math.max(minK, Math.floor(opts.maxClasses ?? 4));
  if (maxK > 8) return { error: "At most 8 classes." };
  if (N < 50) return { error: `Only ${N} respondents answered the choice tasks — a latent-class choice model needs at least 50 (more than 200 for stable classes).` };
  if (T < maxK * p * 5) return { error: `${T} choice tasks are too few for ${maxK} classes of ${p} parameters each (about five tasks per parameter are needed). Fit fewer classes.` };
  const starts = Math.max(1, Math.floor(opts.starts ?? 10)), maxIter = Math.max(10, Math.floor(opts.maxIter ?? 300)), tol = opts.tol ?? 1e-6;
  const rng = new Rng(Math.floor(opts.seed ?? 1));
  const buf = new Array(64).fill(0);
  /* the aggregate model, the start for every class */
  const agg = weightedLogit(resp, new Array(N).fill(1), p, new Array(p).fill(0), 50).beta;
  const fits: LcMnlFit[] = [];
  for (let K = minK; K <= maxK; K++) {
    const npar = K * p + (K - 1);
    let best: { ll: number; pi: number[]; betas: number[][]; post: number[][]; iter: number; converged: boolean } | null = null;
    const lls: number[] = [];
    const nStarts = K === 1 ? 1 : starts;
    for (let st = 0; st < nStarts; st++) {
      let pi = new Array(K).fill(1 / K);
      let betas = Array.from({ length: K }, () => agg.map((b) => (K === 1 ? b : b + rng.normal() * Math.max(0.5, Math.abs(b)))));
      let ll = -Infinity, iter = 0, converged = false;
      let post = Array.from({ length: N }, () => new Array(K).fill(1 / K));
      for (iter = 1; iter <= maxIter; iter++) {
        /* E-step */
        let L = 0;
        const lp = new Array(K).fill(0);
        for (let n = 0; n < N; n++) {
          let m = -Infinity;
          for (let k = 0; k < K; k++) { lp[k] = Math.log(pi[k]) + respLogLik(resp[n], betas[k], buf); if (lp[k] > m) m = lp[k]; }
          let z = 0; for (let k = 0; k < K; k++) { lp[k] = Math.exp(lp[k] - m); z += lp[k]; }
          for (let k = 0; k < K; k++) post[n][k] = lp[k] / z;
          L += m + Math.log(z);
        }
        if (Math.abs(L - ll) < tol) { ll = L; converged = true; break; }
        ll = L;
        /* M-step */
        pi = Array.from({ length: K }, (_, k) => Math.max(post.reduce((a, r) => a + r[k], 0) / N, 1e-6));
        const s = pi.reduce((a, b) => a + b, 0); pi = pi.map((v) => v / s);
        betas = betas.map((b, k) => weightedLogit(resp, post.map((r) => r[k]), p, b, 3).beta);
      }
      lls.push(ll);
      if (!best || ll > best.ll + 1e-9) best = { ll, pi, betas, post: post.map((r) => r.slice()), iter, converged };
    }
    const b = best!;
    const order = b.pi.map((_, k) => k).sort((x, y) => b.pi[y] - b.pi[x]);
    const shares = order.map((k) => b.pi[k]);
    const betas = order.map((k) => b.betas[k]);
    const posterior = b.post.map((r) => order.map((k) => r[k]));
    const modal = posterior.map((r) => r.indexOf(Math.max(...r)));
    let entropy: number | null = null;
    if (K > 1) { let e = 0; for (const r of posterior) for (const q of r) if (q > 0) e -= q * Math.log(q); entropy = 1 - e / (N * Math.log(K)); }
    const se = betas.map((beta, k) => {
      const { info } = weightedLogit(resp, posterior.map((r) => r[k]), p, beta, 1, 0);
      const V = info ? invert(info, p) : null;
      return Array.from({ length: p }, (_, i) => (V && V[i * p + i] > 0 ? Math.sqrt(V[i * p + i]) : NaN));
    });
    const replicated = lls.filter((v) => Math.abs(v - b.ll) < 0.01).length;
    const warnings: string[] = [];
    if (!b.converged) warnings.push(`EM did not converge for ${K} classes within ${maxIter} iterations.`);
    if (K > 1 && replicated < 2) warnings.push(`The best log-likelihood for ${K} classes was reached by only ${replicated} of ${nStarts} starts — possibly a local maximum.`);
    if (K > 1 && shares.some((v) => v * N < 10 || v < 0.03)) warnings.push(`A class has fewer than 10 respondents or under 3% — ${K} classes over-extract.`);
    if (se.flat().some((v) => !Number.isFinite(v))) warnings.push("Some part-worths are not identified within a class (a level never chosen by its members).");
    fits.push({ k: K, logLik: b.ll, npar, aic: -2 * b.ll + 2 * npar, bic: -2 * b.ll + npar * Math.log(N), entropy, shares, betas, se, posterior, modal, iterations: b.iter, converged: b.converged, starts: nStarts, replicated, warnings });
  }
  const valid = fits.filter((f) => f.converged && !f.warnings.some((w) => /over-extract/.test(w)));
  const rec = [...valid].sort((a, b) => a.bic - b.bic)[0] ?? null;
  const parts: string[] = [];
  if (rec) {
    parts.push(`BIC is lowest at ${rec.k} class${rec.k === 1 ? "" : "es"}${rec.k > 1 ? ` (shares ${rec.shares.map((v) => `${Math.round(v * 100)}%`).join(", ")}, entropy ${rec.entropy?.toFixed(2)})` : ""}.`);
    if (rec.k === maxK && maxK > 1) parts.push("The largest K tried has the lowest BIC — try more classes before settling.");
    parts.push("Choose by interpretability and class size as well as by BIC.");
  } else parts.push("No valid solution: every candidate failed to converge or had a near-empty class.");
  return { fits, recommended: rec?.k ?? null, recommendation: parts.join(" "), n: N, tasks: T };
}
