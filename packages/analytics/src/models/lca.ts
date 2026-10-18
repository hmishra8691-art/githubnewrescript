/**
 * LATENT CLASS ANALYSIS for categorical indicators — maximum likelihood by EM
 * with multiple random starts (seeded).
 *
 * Model: P(x_i) = Σ_k π_k Π_j ρ_jk[x_ij]. Local independence within class;
 * one multinomial per indicator per class. Respondents with a missing
 * indicator are dropped (listwise) and counted — no FIML is claimed.
 *
 * For each candidate number of classes K (1..Kmax) the best of `starts`
 * random starts is kept, and how many starts reached that log-likelihood is
 * reported: a best value found by a single start is a warning (possible local
 * maximum). Classes are reported largest first, so labels are stable across
 * runs (label switching is resolved by size, and in tests by matching).
 *
 * Nothing picks "the most classes": the recommendation is the lowest BIC among
 * the solutions that are identified and have no empty class, and the table
 * shows AIC / SABIC / entropy / smallest class so the trade-off is visible.
 */
import { Rng } from "./rng.js";
import { diag, fingerprintNumbers, MODELS_VERSION, nowMs, type ModelDiagnostic, type ModelRun } from "./spec.js";

export interface LcaInput {
  /** N × J: category index 0..R_j−1 per indicator, null = missing */
  data: (number | null)[][];
  /** R_j, the number of categories of each indicator */
  categories: number[];
  itemNames?: string[];
  /** respondent ids, parallel to `data` (for the membership table) */
  ids?: string[];
}

export interface LcaOptions {
  minClasses?: number;
  maxClasses?: number;
  /** random starts per K (default 20) */
  starts?: number;
  maxIter?: number;
  /** convergence: absolute change of the log-likelihood (default 1e-9) */
  tol?: number;
  seed?: number;
}

export interface LcaFit {
  k: number;
  logLik: number;
  npar: number;
  /** residual df against the full response-pattern table (Π R_j − 1 − npar); may be huge */
  df: number;
  aic: number;
  bic: number;
  sabic: number;
  /** relative entropy (1 = perfect separation); null for one class */
  entropy: number | null;
  /** class proportions π_k (largest first) */
  classSizes: number[];
  /** proportions by modal assignment */
  modalSizes: number[];
  /** ρ[k][j][r] */
  itemProbs: number[][][];
  /** N_used × K posterior membership probabilities (dataset order of used cases) */
  posterior: number[][];
  modal: number[];
  /** mean posterior probability of each class among cases assigned to each modal class (K × K) */
  avgPosteriorByModal: number[][];
  iterations: number;
  converged: boolean;
  starts: number;
  /** starts that reached the best log-likelihood (within 0.01) */
  replicated: number;
  /** ρ estimates at the boundary (< 1e-6 or > 1 − 1e-6) */
  boundary: number;
  identified: boolean;
  warnings: ModelDiagnostic[];
}

export interface LcaOutput {
  fits: LcaFit[];
  /** K recommended by BIC among valid solutions, null when none is valid */
  recommended: number | null;
  recommendation: string;
  nUsed: number;
  nDropped: number;
  usedIndex: number[];
}

const RHO_FLOOR = 1e-12;

interface Patterns { rows: number[][]; w: number[]; caseToPattern: number[] }
function collapse(rows: number[][]): Patterns {
  const map = new Map<string, number>(); const out: number[][] = []; const w: number[] = []; const c2p: number[] = [];
  for (const r of rows) { const key = r.join(","); let i = map.get(key); if (i == null) { i = out.length; map.set(key, i); out.push(r); w.push(0); } w[i]++; c2p.push(i); }
  return { rows: out, w, caseToPattern: c2p };
}

/** one EM run from a given start; returns parameters, posterior over patterns and LL */
function em(P: Patterns, R: number[], K: number, pi0: number[], rho0: number[][][], maxIter: number, tol: number) {
  const J = R.length, M = P.rows.length;
  let pi = pi0.slice(), rho = rho0.map((a) => a.map((b) => b.slice()));
  const post = Array.from({ length: M }, () => new Array(K).fill(0));
  let ll = -Infinity, iter = 0, converged = false;
  const lp = new Array(K).fill(0);
  const estep = () => {
    let L = 0;
    for (let m = 0; m < M; m++) {
      const x = P.rows[m];
      let mx = -Infinity;
      for (let k = 0; k < K; k++) { let s = Math.log(pi[k]); for (let j = 0; j < J; j++) s += Math.log(rho[k][j][x[j]]); lp[k] = s; if (s > mx) mx = s; }
      let Z = 0; for (let k = 0; k < K; k++) { lp[k] = Math.exp(lp[k] - mx); Z += lp[k]; }
      for (let k = 0; k < K; k++) post[m][k] = lp[k] / Z;
      L += P.w[m] * (mx + Math.log(Z));
    }
    return L;
  };
  ll = estep();
  for (iter = 1; iter <= maxIter; iter++) {
    // M-step
    const W = P.w.reduce((t, v) => t + v, 0);
    const nk = new Array(K).fill(0);
    const cnt = Array.from({ length: K }, () => R.map((r) => new Array(r).fill(0)));
    for (let m = 0; m < M; m++) { const x = P.rows[m], w = P.w[m]; for (let k = 0; k < K; k++) { const pw = post[m][k] * w; nk[k] += pw; for (let j = 0; j < J; j++) cnt[k][j][x[j]] += pw; } }
    pi = nk.map((v) => Math.max(v / W, 1e-300));
    rho = cnt.map((ck, k) => ck.map((cj) => { const tot = nk[k]; if (!(tot > 1e-300)) return cj.map(() => 1 / cj.length); const pr = cj.map((v) => Math.max(v / tot, RHO_FLOOR)); const s = pr.reduce((t, v) => t + v, 0); return pr.map((v) => v / s); }));
    const next = estep();
    const change = next - ll;
    ll = next;
    if (Math.abs(change) < tol) { converged = true; break; }
  }
  return { pi, rho, post, ll, iter, converged };
}

function randomStart(rng: Rng, R: number[], K: number): { pi: number[]; rho: number[][][] } {
  const pi = new Array(K).fill(1 / K);
  const rho = Array.from({ length: K }, () => R.map((r) => { const g = Array.from({ length: r }, () => rng.gamma(1)); const s = g.reduce((t, v) => t + v, 0); return g.map((v) => Math.max(v / s, 1e-3)); }));
  return { pi, rho };
}

/** Fit K = min..max latent class models. Pure; seeded; deterministic. */
export function latentClass(input: LcaInput, opts: LcaOptions = {}): ModelRun<LcaOutput> {
  const t0 = nowMs();
  const R = input.categories;
  const J = R.length;
  const minK = Math.max(1, Math.floor(opts.minClasses ?? 1)), maxK = Math.max(minK, Math.floor(opts.maxClasses ?? 4));
  const starts = Math.max(1, Math.floor(opts.starts ?? 20)), maxIter = Math.max(10, Math.floor(opts.maxIter ?? 2000)), tol = opts.tol ?? 1e-9, seed = Math.floor(opts.seed ?? 1);
  const used: number[][] = [], usedIndex: number[] = [];
  input.data.forEach((row, i) => {
    if (row.length !== J) return;
    if (row.every((v, j) => v != null && Number.isInteger(v) && v >= 0 && v < R[j])) { used.push(row as number[]); usedIndex.push(i); }
  });
  const N = used.length;
  const metaOptions = { minClasses: minK, maxClasses: maxK, starts, maxIter, tol, missing: "listwise" };
  const meta = { model: "lca" as const, version: MODELS_VERSION, seed, dataFingerprint: fingerprintNumbers([R, ...used]), n: N, options: metaOptions, elapsedMs: 0 };
  const diagnostics: ModelDiagnostic[] = [];
  const refuse = (code: string, message: string): ModelRun<LcaOutput> => ({ status: "refused", diagnostics: [diag(code, "error", message)], output: null, meta: { ...meta, elapsedMs: nowMs() - t0 }, error: { code, message } });
  if (J < 2) return refuse("too_few_indicators", "Latent class analysis needs at least two categorical indicators (three or more for more than two classes to be identified).");
  if (R.some((r) => !(r >= 2))) return refuse("constant_indicator", "Every indicator needs at least two categories; one of the chosen variables has fewer.");
  if (N < 30) return refuse("too_few_cases", `Only ${N} respondents answered every indicator — at least 30 are needed (more than 100 for stable class solutions).`);
  if (input.data.length - N > 0) diagnostics.push(diag("listwise", "info", `${input.data.length - N} of ${input.data.length} respondents were left out because they did not answer every indicator (listwise deletion; no missing-data model is used).`));
  // categories actually observed
  R.forEach((r, j) => { const seen = new Set(used.map((x) => x[j])); if (seen.size < 2) diagnostics.push(diag("constant_indicator", "warning", `${input.itemNames?.[j] ?? `Indicator ${j + 1}`} takes a single value among the respondents used — it cannot separate classes.`)); else if (seen.size < r) diagnostics.push(diag("empty_category", "info", `${input.itemNames?.[j] ?? `Indicator ${j + 1}`}: ${r - seen.size} of its ${r} categories were never chosen; their probabilities are estimated at zero.`)); });
  const P = collapse(used);
  const cellsLog = R.reduce((t, r) => t + Math.log(r), 0);
  const rng = new Rng(seed);
  const fits: LcaFit[] = [];
  for (let K = minK; K <= maxK; K++) {
    const npar = (K - 1) + K * R.reduce((t, r) => t + (r - 1), 0);
    // residual df against all response patterns; for large tables it is effectively infinite
    const cells = cellsLog < Math.log(1e15) ? Math.round(Math.exp(cellsLog)) : Infinity;
    const df = cells - 1 - npar;
    const identified = df >= 0 && npar < N;
    const warnings: ModelDiagnostic[] = [];
    if (!identified) {
      warnings.push(diag("not_identified", "error", `${K} classes need ${npar} parameters, more than the ${Number.isFinite(cells) ? cells - 1 : "available"} independent response-pattern frequencies${npar >= N ? ` or the ${N} respondents` : ""} — the model is not identified. Add indicators or fit fewer classes.`));
      fits.push({ k: K, logLik: NaN, npar, df, aic: NaN, bic: NaN, sabic: NaN, entropy: null, classSizes: [], modalSizes: [], itemProbs: [], posterior: [], modal: [], avgPosteriorByModal: [], iterations: 0, converged: false, starts: 0, replicated: 0, boundary: 0, identified: false, warnings });
      continue;
    }
    let best: ReturnType<typeof em> | null = null;
    const lls: number[] = [];
    const nStarts = K === 1 ? 1 : starts;
    for (let s = 0; s < nStarts; s++) {
      const st = randomStart(rng, R, K);
      const r = em(P, R, K, st.pi, st.rho, maxIter, tol);
      lls.push(r.ll);
      if (!best || r.ll > best.ll + 1e-9) best = r;
    }
    const b = best!;
    const replicated = lls.filter((v) => Math.abs(v - b.ll) < 0.01).length;
    // order classes by size (largest first)
    const order = b.pi.map((_, k) => k).sort((x, y) => b.pi[y] - b.pi[x]);
    const pi = order.map((k) => b.pi[k]);
    const rho = order.map((k) => b.rho[k]);
    const postPat = b.post.map((row) => order.map((k) => row[k]));
    const posterior = P.caseToPattern.map((m) => postPat[m]);
    const modal = posterior.map((row) => row.indexOf(Math.max(...row)));
    const modalSizes = new Array(K).fill(0); modal.forEach((k) => modalSizes[k]++);
    const avg = Array.from({ length: K }, () => new Array(K).fill(0));
    posterior.forEach((row, i) => { for (let k = 0; k < K; k++) avg[modal[i]][k] += row[k]; });
    for (let a = 0; a < K; a++) for (let k = 0; k < K; k++) avg[a][k] = modalSizes[a] ? avg[a][k] / modalSizes[a] : NaN;
    let ent: number | null = null;
    if (K > 1) { let e = 0; for (const row of posterior) for (const p of row) if (p > 0) e -= p * Math.log(p); ent = 1 - e / (N * Math.log(K)); }
    const boundary = rho.reduce((t, ck) => t + ck.reduce((u, cj, j) => u + (new Set(used.map((x) => x[j])).size >= 2 ? cj.filter((v) => v < 1e-6 || v > 1 - 1e-6).length : 0), 0), 0);
    if (K > 1 && replicated < 2) warnings.push(diag("local_maximum", "warning", `The best log-likelihood for ${K} classes was reached by only ${replicated} of ${nStarts} random starts — it may be a local maximum. Treat this solution with caution or run more starts.`));
    if (!b.converged) warnings.push(diag("not_converged", "error", `EM did not converge for ${K} classes within ${maxIter} iterations — this solution is not reported as valid.`));
    const tiny = pi.map((v, k) => ({ v, k })).filter((x) => x.v * N < 1 || x.v < 0.01);
    if (K > 1 && tiny.length) warnings.push(diag("empty_class", "warning", `${tiny.map((x) => `Class ${x.k + 1}`).join(", ")} ${tiny.length === 1 ? "is" : "are"} empty or nearly empty (${tiny.map((x) => `${(x.v * 100).toFixed(1)}%`).join(", ")}) — ${K} classes over-extract.`));
    if (boundary > 0) warnings.push(diag("boundary", "info", `${boundary} item-response probabilit${boundary === 1 ? "y is" : "ies are"} at the boundary (0 or 1); standard for well-separated classes, but the corresponding parameters are not freely estimated.`));
    const ll = b.ll;
    fits.push({
      k: K, logLik: ll, npar, df, aic: -2 * ll + 2 * npar, bic: -2 * ll + npar * Math.log(N), sabic: -2 * ll + npar * Math.log((N + 2) / 24), entropy: ent,
      classSizes: pi, modalSizes: modalSizes.map((v) => v / N), itemProbs: rho, posterior, modal, avgPosteriorByModal: avg,
      iterations: b.iter, converged: b.converged, starts: nStarts, replicated, boundary, identified: true, warnings,
    });
  }
  const valid = fits.filter((f) => f.identified && f.converged && !f.warnings.some((w) => w.code === "empty_class"));
  const byBic = [...valid].sort((a, b) => a.bic - b.bic);
  const rec = byBic[0] ?? null;
  let recommendation = "No valid solution: every candidate was unidentified, did not converge or had an empty class.";
  if (rec) {
    const byAic = [...valid].sort((a, b) => a.aic - b.aic)[0];
    const bySabic = [...valid].sort((a, b) => a.sabic - b.sabic)[0];
    const parts = [`BIC is lowest at ${rec.k} class${rec.k === 1 ? "" : "es"}${rec.k > 1 ? ` (smallest class ${(Math.min(...rec.classSizes) * 100).toFixed(1)}%, entropy ${rec.entropy?.toFixed(2)})` : ""}.`];
    if (byAic.k !== rec.k) parts.push(`AIC prefers ${byAic.k} (AIC penalises parameters less and tends to over-extract).`);
    if (bySabic.k !== rec.k) parts.push(`Sample-size-adjusted BIC prefers ${bySabic.k}.`);
    if (rec.k > 1 && rec.entropy != null && rec.entropy < 0.6) parts.push("Entropy below 0.6: classification of individuals into classes is uncertain — use the posterior probabilities, not hard assignment.");
    if (rec.k === maxK && maxK > 1) parts.push(`The largest K tried has the lowest BIC — try more classes before settling.`);
    parts.push("Choose by interpretability and class size as well as by the criteria; the recommendation is not automatic.");
    recommendation = parts.join(" ");
  }
  const allBad = !valid.length;
  return {
    status: allBad ? "failed" : "done",
    diagnostics: [...diagnostics, ...fits.flatMap((f) => f.warnings.map((w) => ({ ...w, message: w.message })))],
    output: allBad ? null : { fits, recommended: rec?.k ?? null, recommendation, nUsed: N, nDropped: input.data.length - N, usedIndex },
    meta: { ...meta, elapsedMs: nowMs() - t0 },
    ...(allBad ? { error: { code: "no_valid_solution", message: recommendation } } : {}),
  };
}
