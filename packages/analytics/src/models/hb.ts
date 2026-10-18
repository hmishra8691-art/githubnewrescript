/**
 * HIERARCHICAL BAYES MULTINOMIAL LOGIT (HB-MNL) — the Allenby / Rossi /
 * Sawtooth CBC/HB model, for CBC and MaxDiff choice data.
 *
 *   upper level   β_i ~ N(μ, Σ)
 *   lower level   P(choice in task t | β_i) = exp(x_c β_i) / Σ_j exp(x_j β_i)
 *   priors        μ flat; Σ ~ inverse-Wishart(ν₀ = p + priorDf, V₀ = ν₀ · priorVariance · I)
 *
 * One iteration, per chain:
 *   1. β_i | μ, Σ, y_i   random-walk Metropolis–Hastings, proposal β_i + ρ·chol(Σ)·z;
 *                         ρ adapted during burn-in toward the target acceptance (×1.1 above,
 *                         ×0.9 below — Sawtooth's rule), then FIXED, so the kept draws come
 *                         from a valid (time-homogeneous) Markov chain;
 *   2. μ | β, Σ           Gibbs: N(β̄, Σ / N);
 *   3. Σ | β, μ           Gibbs: IW(ν₀ + N, V₀ + Σ_i (β_i − μ)(β_i − μ)ᵀ), drawn by Bartlett.
 *
 * Several chains run from dispersed starts with independent seeded streams;
 * convergence is judged by split-R̂ and effective sample size on μ, Geweke z
 * per chain, and the acceptance rate. The sampler is a SERIALISABLE STATE
 * MACHINE: `hbInit` → `hbAdvance` (as many times as the time budget needs) →
 * `hbSummarise`. The state is plain JSON (seeded RNG state included), so a run
 * can be continued in a later request and gives exactly the draws of an
 * uninterrupted run — chunked execution without losing reproducibility.
 *
 * Coding is whatever the caller's design matrix uses (the platform passes the
 * aggregate MNL's effects coding with the None constant); `transform` maps the
 * coded parameters to the reported quantities (every level, reference included).
 */
import { Rng, type RngState } from "./rng.js";
import { cholesky, cholInverse } from "./linalg.js";
import { diag, fingerprintNumbers, MODELS_VERSION, type ModelDiagnostic } from "./spec.js";
import { quantileSorted } from "./linalg.js";

export interface HbRespondent {
  id: string;
  /** rows = alternatives of every task in order, columns = p coded parameters (row-major) */
  X: ArrayLike<number>;
  /** alternatives per task */
  taskSizes: ArrayLike<number>;
  /** chosen alternative per task, 0-based within the task */
  chosen: ArrayLike<number>;
}
export interface HbData {
  p: number;
  paramNames: string[];
  respondents: HbRespondent[];
  /** reported quantities = rows · β (default: identity on the coded parameters) */
  transform?: { names: string[]; rows: number[][] };
  /**
   * Shape of the prior covariance (p×p, flat), V₀ = ν₀ · priorVariance · shape. Default I.
   * For effects-coded attributes pass `effectsPriorShape`, which gives every level — the
   * reference level included — the same prior variance (Sawtooth's CBC/HB prior).
   */
  priorShape?: number[];
}

/**
 * The prior covariance shape for effects-coded blocks: for an attribute with k levels
 * (k − 1 coded columns) the block is I − J/k, so each level's implied prior variance is
 * (k − 1)/k · priorVariance, the reference level's too; other columns (None) get 1.
 */
export function effectsPriorShape(p: number, blocks: number[][]): number[] {
  const S = new Array(p * p).fill(0);
  for (let i = 0; i < p; i++) S[i * p + i] = 1;
  for (const cols of blocks) {
    const k = cols.length + 1;
    for (const a of cols) for (const b of cols) S[a * p + b] = (a === b ? 1 : 0) - 1 / k;
  }
  return S;
}
export interface HbOptions {
  chains?: number;
  burnIn?: number;
  /** iterations after burn-in, per chain */
  draws?: number;
  thin?: number;
  seed?: number;
  priorVariance?: number;
  /** additional prior degrees of freedom (ν₀ = p + priorDf) */
  priorDf?: number;
  targetAcceptance?: number;
}
export type HbResolved = Required<HbOptions>;

export const HB_DEFAULTS: HbResolved = { chains: 2, burnIn: 5000, draws: 5000, thin: 5, seed: 1, priorVariance: 1, priorDf: 5, targetAcceptance: 0.3 };

export function resolveHbOptions(o: HbOptions = {}): HbResolved {
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    chains: int(o.chains, HB_DEFAULTS.chains, 1, 4), burnIn: int(o.burnIn, HB_DEFAULTS.burnIn, 100, 100_000), draws: int(o.draws, HB_DEFAULTS.draws, 100, 100_000),
    thin: int(o.thin, HB_DEFAULTS.thin, 1, 100), seed: int(o.seed, HB_DEFAULTS.seed, 0, 2 ** 31 - 1), priorVariance: num(o.priorVariance, HB_DEFAULTS.priorVariance, 0.01, 100),
    priorDf: int(o.priorDf, HB_DEFAULTS.priorDf, 1, 1000), targetAcceptance: num(o.targetAcceptance, HB_DEFAULTS.targetAcceptance, 0.05, 0.9),
  };
}

interface ChainState {
  rng: RngState;
  beta: number[]; mu: number[]; sigma: number[]; rho: number; ll: number[];
  accPost: number; propPost: number;
  /** scale of the joint shift move (adapted in burn-in, then fixed) and its acceptance after burn-in */
  shift: number; shiftAcc: number; shiftProp: number;
  /** running sums over kept draws: reported quantities per respondent (N × L), squares, coded β (N × p) */
  sumQ: number[]; sumQ2: number[]; sumB: number[];
  kept: number;
  /** kept draws of μ in reported units (kept × L), Σ diagonal in reported units, total log-likelihood */
  muDraws: number[]; sigDraws: number[]; llDraws: number[];
  /** per burn-in block: mean log-likelihood (for the trace summary) */
  burnTrace: number[];
}
export interface HbState {
  kind: "hb-state"; version: string; options: HbResolved;
  p: number; N: number; L: number; tasks: number;
  fingerprint: string;
  /** iterations completed by every chain */
  iteration: number; total: number;
  chains: ChainState[];
  elapsedMs: number;
}

const transformOf = (d: HbData) => d.transform ?? { names: d.paramNames, rows: d.paramNames.map((_, i) => d.paramNames.map((__, j) => (i === j ? 1 : 0))) };

export function hbFingerprint(d: HbData): string {
  return fingerprintNumbers((function* () { yield [d.p, d.respondents.length]; if (d.priorShape) yield d.priorShape; for (const r of d.respondents) { yield r.taskSizes; yield r.chosen; yield r.X; } })());
}

/** the non-zero entries of a respondent's design rows (effects-coded rows are mostly zeros) */
interface Sparse { start: Int32Array; col: Int32Array; val: Float64Array; sizes: ArrayLike<number>; chosen: ArrayLike<number> }
function sparseOf(r: HbRespondent, p: number): Sparse {
  const rows = r.X.length / p;
  const start = new Int32Array(rows + 1); const cols: number[] = [], vals: number[] = [];
  for (let j = 0; j < rows; j++) { start[j] = cols.length; for (let k = 0; k < p; k++) { const v = r.X[j * p + k]; if (v !== 0) { cols.push(k); vals.push(v); } } }
  start[rows] = cols.length;
  return { start, col: Int32Array.from(cols), val: Float64Array.from(vals), sizes: r.taskSizes, chosen: r.chosen };
}
/** log-likelihood from the sparse rows — the sampler's hot loop */
function sparseLL(sp: Sparse, b: ArrayLike<number>, off: number, u: Float64Array): number {
  const { start, col, val, sizes, chosen } = sp;
  let L = 0, row = 0;
  for (let t = 0; t < sizes.length; t++) {
    const n = sizes[t];
    let mx = -Infinity;
    for (let j = 0; j < n; j++) { let s = 0; for (let e = start[row + j], end = start[row + j + 1]; e < end; e++) s += val[e] * b[off + col[e]]; u[j] = s; if (s > mx) mx = s; }
    let Z = 0; for (let j = 0; j < n; j++) Z += Math.exp(u[j] - mx);
    L += u[chosen[t]] - mx - Math.log(Z);
    row += n;
  }
  return L;
}

/** log-likelihood of one respondent's choices at β (offset into a flat array) */
function respLL(r: HbRespondent, p: number, b: ArrayLike<number>, off: number, u: Float64Array): number {
  const X = r.X, sizes = r.taskSizes, ch = r.chosen;
  let L = 0, row = 0;
  for (let t = 0; t < sizes.length; t++) {
    const n = sizes[t];
    let mx = -Infinity;
    for (let j = 0; j < n; j++) { let s = 0; const base = (row + j) * p; for (let k = 0; k < p; k++) s += X[base + k] * b[off + k]; u[j] = s; if (s > mx) mx = s; }
    let Z = 0; for (let j = 0; j < n; j++) Z += Math.exp(u[j] - mx);
    L += u[ch[t]] - mx - Math.log(Z);
    row += n;
  }
  return L;
}

/**
 * Starting values: a pooled MNL, then each respondent's ridge-penalised MNL
 * pulled toward it (three Newton steps, penalty 1). Starting the chains where
 * the individual data already points — instead of at zero with Σ = prior —
 * shortens burn-in a lot; it does not change the stationary distribution.
 */
function startingValues(data: HbData): { pooled: Float64Array; individual: Float64Array } {
  const { p } = data; const N = data.respondents.length;
  const newton = (b: Float64Array, resp: HbRespondent[], ridge: number, centre: Float64Array | null, steps: number) => {
    for (let it = 0; it < steps; it++) {
      const g = new Float64Array(p), H = new Float64Array(p * p);
      for (const r of resp) {
        let row = 0;
        for (let t = 0; t < r.taskSizes.length; t++) {
          const n = r.taskSizes[t]; const u = new Float64Array(n); let mx = -Infinity;
          for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < p; k++) s += r.X[(row + j) * p + k] * b[k]; u[j] = s; if (s > mx) mx = s; }
          let Z = 0; for (let j = 0; j < n; j++) { u[j] = Math.exp(u[j] - mx); Z += u[j]; }
          const xbar = new Float64Array(p);
          for (let j = 0; j < n; j++) for (let k = 0; k < p; k++) xbar[k] += (u[j] / Z) * r.X[(row + j) * p + k];
          for (let k = 0; k < p; k++) g[k] += r.X[(row + r.chosen[t]) * p + k] - xbar[k];
          for (let j = 0; j < n; j++) { const w = u[j] / Z; for (let a = 0; a < p; a++) { const da = r.X[(row + j) * p + a] - xbar[a]; if (da === 0) continue; for (let c = 0; c < p; c++) H[a * p + c] += w * da * (r.X[(row + j) * p + c] - xbar[c]); } }
          row += n;
        }
      }
      for (let k = 0; k < p; k++) { g[k] -= ridge * (b[k] - (centre ? centre[k] : 0)); H[k * p + k] += ridge; }
      const L = cholesky(H, p); if (!L) break;
      const Hi = cholInverse(L, p);
      for (let a = 0; a < p; a++) { let s = 0; for (let c = 0; c < p; c++) s += Hi[a * p + c] * g[c]; b[a] += Math.max(-2, Math.min(2, s)); }
    }
  };
  const pooled = new Float64Array(p);
  newton(pooled, data.respondents, 1e-3, null, 8);
  const individual = new Float64Array(N * p);
  data.respondents.forEach((r, i) => { const b = Float64Array.from(pooled); newton(b, [r], 1, pooled, 3); individual.set(b, i * p); });
  return { pooled, individual };
}

export function hbInit(data: HbData, options: HbOptions = {}): HbState {
  const o = resolveHbOptions(options);
  const { p } = data; const N = data.respondents.length; const T = transformOf(data); const L = T.names.length;
  const master = new Rng(o.seed);
  const chains: ChainState[] = [];
  const u = new Float64Array(64);
  const start = startingValues(data);
  for (let c = 0; c < o.chains; c++) {
    const rng = new Rng(master.int() ^ (c * 0x5bd1e995));
    // chain 1 starts at the individual ridge estimates; the others are dispersed around them (so R̂ can detect non-convergence)
    const mu = Array.from({ length: p }, (_, k) => start.pooled[k] + (c === 0 ? 0 : 0.5 * rng.normal()));
    const beta: number[] = new Array(N * p);
    for (let i = 0; i < N; i++) for (let k = 0; k < p; k++) beta[i * p + k] = start.individual[i * p + k] + (c === 0 ? 0 : mu[k] - start.pooled[k] + 0.3 * rng.normal());
    const shape = data.priorShape ?? null;
    const sigma = new Array(p * p).fill(0); for (let k = 0; k < p * p; k++) sigma[k] = o.priorVariance * (shape ? shape[k] : k % (p + 1) === 0 ? 1 : 0);
    const ll = data.respondents.map((r, i) => { const need = Math.max(...Array.from(r.taskSizes as ArrayLike<number>), 1); const uu = need > u.length ? new Float64Array(need) : u; return respLL(r, p, beta, i * p, uu); });
    chains.push({ rng: rng.save(), beta, mu, sigma, rho: 0.1, ll, accPost: 0, propPost: 0, shift: 1, shiftAcc: 0, shiftProp: 0, sumQ: new Array(N * L).fill(0), sumQ2: new Array(N * L).fill(0), sumB: new Array(N * p).fill(0), kept: 0, muDraws: [], sigDraws: [], llDraws: [], burnTrace: [] });
  }
  const tasks = data.respondents.reduce((t, r) => t + r.taskSizes.length, 0);
  return { kind: "hb-state", version: MODELS_VERSION, options: o, p, N, L, tasks, fingerprint: hbFingerprint(data), iteration: 0, total: o.burnIn + o.draws, chains, elapsedMs: 0 };
}

/** draw Σ ~ IW(df, Psi) (flat p×p) via Bartlett on W ~ Wishart(df, Psi⁻¹) */
export function drawInvWishart(rng: Rng, df: number, Psi: Float64Array, p: number): Float64Array | null {
  const LP = cholesky(Psi, p); if (!LP) return null;
  const PsiInv = cholInverse(LP, p);
  const C = cholesky(PsiInv, p); if (!C) return null;
  const A = new Float64Array(p * p);
  for (let i = 0; i < p; i++) { A[i * p + i] = Math.sqrt(rng.chisq(df - i)); for (let j = 0; j < i; j++) A[i * p + j] = rng.normal(); }
  // M = C A (lower), W = M Mᵀ
  const M = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { let s = 0; for (let k = j; k <= i; k++) s += C[i * p + k] * A[k * p + j]; M[i * p + j] = s; }
  const W = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { let s = 0; for (let k = 0; k <= j; k++) s += M[i * p + k] * M[j * p + k]; W[i * p + j] = W[j * p + i] = s; }
  const LW = cholesky(W, p); if (!LW) return null;
  return cholInverse(LW, p);
}

/**
 * Advance every chain by up to `maxIterations`, stopping early at `deadline`
 * (a `now()` value in ms). Mutates and returns the state. Deterministic: the
 * chunking never changes the draws.
 */
export function hbAdvance(state: HbState, data: HbData, budget: { maxIterations?: number; deadline?: number; now?: () => number } = {}): HbState {
  if (state.fingerprint !== hbFingerprint(data)) throw new Error("hb: the data changed since this run started (fingerprint mismatch) — start a new run.");
  const now = budget.now ?? (() => Date.now());
  const t0 = now();
  const o = state.options, { p, N, L } = state;
  const T = transformOf(data);
  const nu0 = p + o.priorDf;
  const maxAlt = Math.max(2, ...data.respondents.map((r) => Math.max(...Array.from(r.taskSizes as ArrayLike<number>))));
  const u = new Float64Array(maxAlt);
  const todo = Math.min(state.total - state.iteration, budget.maxIterations ?? Infinity);
  const chains = state.chains.map((c) => ({ c, rng: new Rng(c.rng), beta: Float64Array.from(c.beta), mu: Float64Array.from(c.mu), sigma: Float64Array.from(c.sigma), ll: Float64Array.from(c.ll) }));
  const sparse = data.respondents.map((r) => sparseOf(r, p));
  const prop = new Float64Array(p), z = new Float64Array(p), dev = new Float64Array(p), dev0 = new Float64Array(p), q = new Float64Array(L), delta = new Float64Array(p), llShift = new Float64Array(N);
  let done = 0;
  const blockLen = Math.max(1, Math.floor(o.burnIn / 20));
  while (done < todo) {
    const it = state.iteration + done; // 0-based index of this iteration
    for (const ch of chains) {
      const { rng, beta, mu, sigma, ll } = ch;
      const Ls = cholesky(sigma, p);
      if (!Ls) throw new Error("hb: Σ lost positive definiteness");
      // Σ⁻¹ once per iteration: the prior ratio is −½[(b′−μ)ᵀΣ⁻¹(b′−μ) − (b−μ)ᵀΣ⁻¹(b−μ)]
      const Si = cholInverse(Ls, p);
      const rho = ch.c.rho;
      let acc = 0;
      for (let i = 0; i < N; i++) {
        const off = i * p;
        for (let k = 0; k < p; k++) z[k] = rng.normal();
        for (let k = 0; k < p; k++) { let s = 0; for (let j = 0; j <= k; j++) s += Ls[k * p + j] * z[j]; prop[k] = beta[off + k] + rho * s; }
        for (let k = 0; k < p; k++) { dev[k] = prop[k] - mu[k]; dev0[k] = beta[off + k] - mu[k]; }
        let q1 = 0, q0 = 0;
        for (let a = 0; a < p; a++) { let s1 = 0, s0 = 0; for (let b = 0; b < p; b++) { const w = Si[a * p + b]; s1 += w * dev[b]; s0 += w * dev0[b]; } q1 += dev[a] * s1; q0 += dev0[a] * s0; }
        const llNew = sparseLL(sparse[i], prop, 0, u);
        const logA = llNew - ll[i] - 0.5 * (q1 - q0);
        if (Math.log(rng.open()) < logA) { for (let k = 0; k < p; k++) beta[off + k] = prop[k]; ll[i] = llNew; acc++; }
      }
      if (it < o.burnIn) {
        ch.c.rho *= acc / N > o.targetAcceptance ? 1.1 : 0.9;
        ch.c.rho = Math.min(10, Math.max(1e-4, ch.c.rho));
      } else { ch.c.accPost += acc; ch.c.propPost += N; }
      /*
       * JOINT SHIFT MOVE: β_i → β_i + δ for every i and μ → μ + δ together, δ ~ s · chol(Σ / N) · z.
       * N(β_i + δ | μ + δ, Σ) = N(β_i | μ, Σ) and μ's prior is flat, so the acceptance ratio is the
       * likelihood ratio alone. It moves the population location in one step, which the
       * respondent-by-respondent random walk does only slowly — the reason HB's μ chains
       * are so autocorrelated in the centred parameterisation. Valid MH; s adapted in burn-in only.
       */
      {
        for (let k = 0; k < p; k++) z[k] = rng.normal();
        const sN = ch.c.shift / Math.sqrt(N);
        for (let k = 0; k < p; k++) { let s = 0; for (let j = 0; j <= k; j++) s += Ls[k * p + j] * z[j]; delta[k] = sN * s; }
        let dLL = 0;
        for (let i = 0; i < N; i++) { for (let k = 0; k < p; k++) prop[k] = beta[i * p + k] + delta[k]; const v = sparseLL(sparse[i], prop, 0, u); llShift[i] = v; dLL += v - ll[i]; }
        const ok = Math.log(rng.open()) < dLL;
        if (ok) { for (let i = 0; i < N; i++) { for (let k = 0; k < p; k++) beta[i * p + k] += delta[k]; ll[i] = llShift[i]; } for (let k = 0; k < p; k++) mu[k] += delta[k]; }
        if (it < o.burnIn) { ch.c.shift = Math.min(20, Math.max(0.01, ch.c.shift * (ok ? 1.1 : 0.93))); }
        else { ch.c.shiftProp++; if (ok) ch.c.shiftAcc++; }
      }
      // μ | β, Σ
      const bbar = new Float64Array(p);
      for (let i = 0; i < N; i++) for (let k = 0; k < p; k++) bbar[k] += beta[i * p + k] / N;
      for (let k = 0; k < p; k++) z[k] = rng.normal();
      for (let k = 0; k < p; k++) { let s = 0; for (let j = 0; j <= k; j++) s += Ls[k * p + j] * z[j]; mu[k] = bbar[k] + s / Math.sqrt(N); }
      // Σ | β, μ
      const Psi = new Float64Array(p * p);
      if (data.priorShape) for (let k = 0; k < p * p; k++) Psi[k] = nu0 * o.priorVariance * data.priorShape[k];
      else for (let k = 0; k < p; k++) Psi[k * p + k] = nu0 * o.priorVariance;
      for (let i = 0; i < N; i++) { for (let k = 0; k < p; k++) dev[k] = beta[i * p + k] - mu[k]; for (let a = 0; a < p; a++) { const da = dev[a]; for (let b = 0; b <= a; b++) Psi[a * p + b] += da * dev[b]; } }
      for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) Psi[b * p + a] = Psi[a * p + b];
      const S = drawInvWishart(rng, nu0 + N, Psi, p);
      if (S) ch.sigma.set(S);
      // bookkeeping
      if (it < o.burnIn) {
        const blk = Math.floor(it / blockLen);
        let tot = 0; for (let i = 0; i < N; i++) tot += ll[i];
        if (ch.c.burnTrace.length <= blk) ch.c.burnTrace.push(0);
        ch.c.burnTrace[blk] += tot / blockLen;
      } else if ((it - o.burnIn) % o.thin === 0) {
        const c = ch.c;
        let tot = 0;
        for (let i = 0; i < N; i++) {
          tot += ll[i];
          for (let l = 0; l < L; l++) { const row = T.rows[l]; let s = 0; for (let k = 0; k < p; k++) s += row[k] * beta[i * p + k]; q[l] = s; c.sumQ[i * L + l] += s; c.sumQ2[i * L + l] += s * s; }
          for (let k = 0; k < p; k++) c.sumB[i * p + k] += beta[i * p + k];
        }
        for (let l = 0; l < L; l++) { const row = T.rows[l]; let s = 0, v = 0; for (let k = 0; k < p; k++) { s += row[k] * mu[k]; for (let j = 0; j < p; j++) v += row[k] * ch.sigma[k * p + j] * row[j]; } c.muDraws.push(s); c.sigDraws.push(v); }
        c.llDraws.push(tot);
        c.kept++;
      }
    }
    done++;
    if (budget.deadline != null && done % 10 === 0 && now() >= budget.deadline) break;
  }
  for (const ch of chains) { ch.c.rng = ch.rng.save(); ch.c.beta = Array.from(ch.beta); ch.c.mu = Array.from(ch.mu); ch.c.sigma = Array.from(ch.sigma); ch.c.ll = Array.from(ch.ll); }
  state.iteration += done;
  state.elapsedMs += now() - t0;
  return state;
}

export const hbDone = (s: HbState): boolean => s.iteration >= s.total;

/* ------------------------------------------------------------------ diagnostics */

/** split-R̂ (Gelman et al. 2013) over chains, each split in two halves */
export function splitRhat(chains: number[][]): number {
  const halves: number[][] = [];
  for (const c of chains) { const h = Math.floor(c.length / 2); if (h < 2) return NaN; halves.push(c.slice(0, h), c.slice(c.length - h)); }
  const n = Math.min(...halves.map((h) => h.length)), m = halves.length;
  const means = halves.map((h) => h.slice(0, n).reduce((t, v) => t + v, 0) / n);
  const grand = means.reduce((t, v) => t + v, 0) / m;
  const B = (n / (m - 1)) * means.reduce((t, v) => t + (v - grand) ** 2, 0);
  const W = halves.reduce((t, h, j) => t + h.slice(0, n).reduce((s, v) => s + (v - means[j]) ** 2, 0) / (n - 1), 0) / m;
  if (!(W > 0)) return B > 0 ? Infinity : 1;
  const varPlus = ((n - 1) / n) * W + B / n;
  return Math.sqrt(varPlus / W);
}

/** effective sample size, summed over chains (Geyer initial positive sequence on each chain's autocorrelations) */
export function effectiveSize(chains: number[][]): number {
  let total = 0;
  for (const x of chains) {
    const n = x.length; if (n < 4) continue;
    const mean = x.reduce((t, v) => t + v, 0) / n;
    const c0 = x.reduce((t, v) => t + (v - mean) ** 2, 0) / n;
    if (!(c0 > 0)) { total += n; continue; }
    const ac = (lag: number) => { let s = 0; for (let i = 0; i + lag < n; i++) s += (x[i] - mean) * (x[i + lag] - mean); return s / n / c0; };
    let sum = 0;
    for (let k = 1; k + 1 < n; k += 2) { const pair = ac(k) + ac(k + 1); if (pair <= 0) break; sum += pair; if (k > 1000) break; }
    total += n / (1 + 2 * sum);
  }
  return total;
}

/** variance of a segment's mean: sample variance / effective sample size (robust to long autocorrelation) */
function varOfMean(x: number[]): number {
  const n = x.length; const mean = x.reduce((t, v) => t + v, 0) / n;
  const v = x.reduce((t, y) => t + (y - mean) ** 2, 0) / Math.max(1, n - 1);
  return v / Math.max(1, effectiveSize([x]));
}
/** Geweke z: mean of the first 10% vs the last 50% of a chain, each mean's variance from its effective size */
export function gewekeZ(x: number[]): number {
  const n = x.length; if (n < 20) return NaN;
  const a = x.slice(0, Math.floor(0.1 * n)), b = x.slice(Math.floor(0.5 * n));
  const ma = a.reduce((t, v) => t + v, 0) / a.length, mb = b.reduce((t, v) => t + v, 0) / b.length;
  const v = varOfMean(a) + varOfMean(b);
  return v > 0 ? (ma - mb) / Math.sqrt(v) : 0;
}

/* ------------------------------------------------------------------ summary */

export interface HbParamSummary { name: string; mean: number; sd: number; lo: number; hi: number; rhat: number; ess: number; popSd: number }
export interface HbIndividual { id: string; mean: number[]; sd: number[]; rlh: number; pctCert: number; tasks: number; logLik: number }
export interface HbOutput {
  names: string[];
  mu: HbParamSummary[];
  individual: HbIndividual[];
  fit: { rlh: number; pctCert: number; logLik: number; nullLogLik: number; respondents: number; tasks: number; meanDrawLogLik: number };
  chains: { chain: number; acceptance: number; jump: number; kept: number; geweke: { name: string; z: number }[] }[];
  /** log-likelihood by block: burn-in blocks then kept-draw blocks, per chain */
  trace: { phase: "burn-in" | "draws"; block: number; logLik: number[]; rlh: number }[];
  maxRhat: number; minEss: number;
  converged: boolean;
  diagnostics: ModelDiagnostic[];
  options: HbResolved;
  iterations: number;
  fingerprint: string;
  version: string;
}

export function hbSummarise(state: HbState, data: HbData): HbOutput {
  const o = state.options, { p, N, L } = state;
  const T = transformOf(data);
  const chains = state.chains;
  const K = chains.reduce((t, c) => t + c.kept, 0);
  const diagnostics: ModelDiagnostic[] = [];
  const perParam = (l: number) => chains.map((c) => Array.from({ length: c.kept }, (_, d) => c.muDraws[d * L + l]));
  const mu: HbParamSummary[] = T.names.map((name, l) => {
    const xs = perParam(l); const all = xs.flat().sort((a, b) => a - b);
    const mean = all.reduce((t, v) => t + v, 0) / all.length;
    const sd = Math.sqrt(all.reduce((t, v) => t + (v - mean) ** 2, 0) / Math.max(1, all.length - 1));
    const sig = chains.flatMap((c) => Array.from({ length: c.kept }, (_, d) => c.sigDraws[d * L + l]));
    const popSd = Math.sqrt(Math.max(0, sig.reduce((t, v) => t + v, 0) / Math.max(1, sig.length)));
    const constant = sd < 1e-12;
    return { name, mean, sd, lo: quantileSorted(all, 0.025), hi: quantileSorted(all, 0.975), rhat: constant ? 1 : chains.length > 1 || xs[0].length >= 8 ? splitRhat(xs) : NaN, ess: constant ? all.length : effectiveSize(xs), popSd };
  });
  const varying = mu.filter((m) => m.sd > 1e-12);
  const maxRhat = varying.length ? Math.max(...varying.map((m) => m.rhat).filter(Number.isFinite)) : 1;
  const minEss = varying.length ? Math.min(...varying.map((m) => m.ess)) : K;
  const u = new Float64Array(Math.max(2, ...data.respondents.map((r) => Math.max(...Array.from(r.taskSizes as ArrayLike<number>)))));
  let totLL = 0, totNull = 0, totTasks = 0;
  const individual: HbIndividual[] = data.respondents.map((r, i) => {
    const mean = new Array(L).fill(0), sd = new Array(L).fill(0), b = new Float64Array(p);
    for (let l = 0; l < L; l++) { let s = 0, s2 = 0; for (const c of chains) { s += c.sumQ[i * L + l]; s2 += c.sumQ2[i * L + l]; } const m = s / K; mean[l] = m; sd[l] = Math.sqrt(Math.max(0, s2 / K - m * m) * (K / Math.max(1, K - 1))); }
    for (let k = 0; k < p; k++) { let s = 0; for (const c of chains) s += c.sumB[i * p + k]; b[k] = s / K; }
    const ll = respLL(r, p, b, 0, u);
    let nul = 0; for (let t = 0; t < r.taskSizes.length; t++) nul -= Math.log(r.taskSizes[t]);
    totLL += ll; totNull += nul; totTasks += r.taskSizes.length;
    return { id: r.id, mean, sd, rlh: Math.exp(ll / r.taskSizes.length), pctCert: nul ? 1 - ll / nul : 0, tasks: r.taskSizes.length, logLik: ll };
  });
  const chainsOut = chains.map((c, ci) => ({
    chain: ci + 1, acceptance: c.propPost ? c.accPost / c.propPost : NaN, jump: c.rho, kept: c.kept,
    geweke: T.names.map((name, l) => ({ name, z: gewekeZ(Array.from({ length: c.kept }, (_, d) => c.muDraws[d * L + l])) })),
  }));
  const trace: HbOutput["trace"] = [];
  const nb = Math.max(...chains.map((c) => c.burnTrace.length));
  for (let b = 0; b < nb; b++) { const lls = chains.map((c) => c.burnTrace[b] ?? NaN); trace.push({ phase: "burn-in", block: b + 1, logLik: lls, rlh: Math.exp((lls.reduce((t, v) => t + v, 0) / lls.length) / state.tasks) }); }
  const blocks = 10;
  for (let b = 0; b < blocks; b++) {
    const lls = chains.map((c) => { const from = Math.floor((b * c.kept) / blocks), to = Math.floor(((b + 1) * c.kept) / blocks); const xs = c.llDraws.slice(from, to); return xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : NaN; });
    trace.push({ phase: "draws", block: b + 1, logLik: lls, rlh: Math.exp((lls.reduce((t, v) => t + v, 0) / lls.length) / state.tasks) });
  }
  const meanDrawLogLik = chains.reduce((t, c) => t + c.llDraws.reduce((s, v) => s + v, 0), 0) / Math.max(1, K);
  // verdicts
  if (chains.length < 2) diagnostics.push(diag("single_chain", "warning", "Only one chain was run, so R̂ compares the two halves of that chain; run two or more chains for a proper convergence check."));
  if (Number.isFinite(maxRhat) && maxRhat > 1.1) diagnostics.push(diag("rhat_high", "error", `The chains have not converged: the largest R̂ on the population means is ${maxRhat.toFixed(2)} (should be below 1.1). Increase the burn-in and draws; these utilities are not reported as valid.`));
  else if (Number.isFinite(maxRhat) && maxRhat > 1.05) diagnostics.push(diag("rhat_borderline", "warning", `The largest R̂ is ${maxRhat.toFixed(3)} — acceptable (< 1.1) but more iterations would make the estimates firmer.`));
  if (minEss < 100) diagnostics.push(diag("ess_low", "warning", `The smallest effective sample size of a population mean is ${minEss.toFixed(0)} — fewer than 100 effectively independent draws; credible intervals are rough. Run more draws.`));
  for (const c of chainsOut) {
    if (c.acceptance < 0.1 || c.acceptance > 0.6) diagnostics.push(diag("acceptance", "warning", `Chain ${c.chain}: acceptance rate ${(c.acceptance * 100).toFixed(0)}% after burn-in (target ${(o.targetAcceptance * 100).toFixed(0)}%) — the burn-in may be too short for the jump size to settle.`));
    const bad = c.geweke.filter((g) => Number.isFinite(g.z) && Math.abs(g.z) > 3);
    if (bad.length > Math.max(1, Math.floor(c.geweke.length / 5))) diagnostics.push(diag("geweke", "warning", `Chain ${c.chain}: ${bad.length} of ${c.geweke.length} parameters have |Geweke z| > 3 — the start and the end of the kept draws differ; the chain may still be drifting.`));
  }
  const converged = !diagnostics.some((d) => d.severity === "error");
  return {
    names: T.names, mu, individual,
    fit: { rlh: Math.exp(totLL / totTasks), pctCert: totNull ? 1 - totLL / totNull : 0, logLik: totLL, nullLogLik: totNull, respondents: N, tasks: totTasks, meanDrawLogLik },
    chains: chainsOut, trace, maxRhat, minEss, converged, diagnostics, options: o, iterations: state.iteration, fingerprint: state.fingerprint, version: state.version,
  };
}

/** run to completion in one call (tests, small studies); `deadline` makes it give up rather than overrun */
export function hbRun(data: HbData, options: HbOptions = {}, budget: { deadline?: number; now?: () => number } = {}): { state: HbState; output: HbOutput | null } {
  const state = hbInit(data, options);
  hbAdvance(state, data, { deadline: budget.deadline, now: budget.now });
  return { state, output: hbDone(state) ? hbSummarise(state, data) : null };
}
