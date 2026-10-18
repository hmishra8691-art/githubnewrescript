/**
 * STRUCTURAL EQUATION MODELLING — CFA measurement models and structural paths,
 * maximum likelihood on the covariance matrix.
 *
 * Representation: RAM (McArdle–McDonald). All variables, observed first then
 * latent, in one vector v = A v + u, Cov(u) = S, so the implied covariance of
 * the observed variables is Σ(θ) = F (I − A)⁻¹ S (I − A)⁻ᵀ Fᵀ. Loadings and
 * regressions live in A; variances, residual variances and covariances in S.
 *
 * Estimation: minimise F_ML = log|Σ| + tr(S Σ⁻¹) − log|S| − p with BFGS
 * (quasi-Newton, analytic gradient, inverse-Hessian seeded with the expected
 * information), polished by Fisher scoring. S is the ML covariance (divisor N)
 * of the listwise-complete cases — lavaan's default `likelihood = "normal"`,
 * so χ² = N·F_min and the numbers match lavaan / semopy.
 *
 * Defaults (lavaan `sem()`): the first loading of each factor is fixed to 1
 * (or, with scaling "unit_variance", every latent (residual) variance is fixed
 * to 1 and loadings are free); every residual / exogenous variance is free;
 * exogenous latent variables covary; exogenous observed variables covary
 * (estimated, equivalent to lavaan's fixed.x for every other number);
 * endogenous residuals are uncorrelated unless written with `~~`.
 *
 * Validity rules enforced here, not left to the reader: identification is
 * checked before fitting (scale per factor, t-rule / df ≥ 0, one- and
 * two-indicator factors) and after (singular information matrix); a run that
 * does not converge, or converges to an improper solution (negative variance,
 * standardised loading or latent correlation beyond ±1 — a Heywood case),
 * returns status "failed" with NO coefficients or fit indices as results.
 */
import { parseSemSyntax, semNames, type SemParse } from "./semSyntax.js";
import { cholesky, invert, logDetFromChol, cholInverse, minEigenSym } from "./linalg.js";
import { diag, fingerprintNumbers, MODELS_VERSION, nowMs, type ModelDiagnostic, type ModelRun } from "./spec.js";
import { chiSquareP, gammaP, normalCdf, normalQuantile, logGamma } from "../stats/distributions.js";

export interface SemOptions {
  scaling?: "marker" | "unit_variance";
  maxIter?: number;
  /** confidence level for the CIs (default 0.95) */
  confidence?: number;
}
export interface SemInput {
  syntax: string;
  /** dataset columns by name; the model's observed variables must be here */
  data: Record<string, (number | null | undefined)[]>;
}

export interface SemEstimate {
  lhs: string; op: "=~" | "~" | "~~"; rhs: string; label: string | null; free: boolean;
  est: number; se: number | null; z: number | null; p: number | null; ciLow: number | null; ciHigh: number | null;
  /** completely standardised (lavaan std.all) */
  std: number | null;
  kind: "loading" | "regression" | "variance" | "residual_variance" | "covariance" | "residual_covariance";
}
export interface SemDefinedEstimate { name: string; expr: string; est: number; se: number | null; z: number | null; p: number | null; ciLow: number | null; ciHigh: number | null; automatic: boolean }
export interface SemFit {
  n: number; npar: number; chisq: number; df: number; pvalue: number | null;
  baselineChisq: number; baselineDf: number;
  cfi: number | null; tli: number | null; rmsea: number | null; rmseaLow: number | null; rmseaHigh: number | null; srmr: number;
  logLik: number; aic: number; bic: number;
}
export interface SemOutput {
  observed: string[]; latent: string[];
  estimates: SemEstimate[]; defined: SemDefinedEstimate[]; fit: SemFit;
  r2: { variable: string; r2: number }[];
  nUsed: number; nDropped: number; iterations: number; scaling: "marker" | "unit_variance";
  /** observed − implied covariance, standardised by the observed SDs (the SRMR's residuals) */
  residualCorrelations: { a: string; b: string; residual: number }[];
}

/* ------------------------------------------------------------------ the model */

interface Entry { matrix: "A" | "S"; r: number; c: number; theta: number | null; value: number; label: string | null; op: "=~" | "~" | "~~"; lhs: string; rhs: string; user: boolean }
export interface SemModel {
  vars: string[]; p: number; m: number; observed: string[]; latent: string[];
  entries: Entry[]; nTheta: number; thetaLabels: (string | null)[];
  defined: SemParse["defined"]; scaling: "marker" | "unit_variance";
  exogenousObserved: number[];
}

export interface SemBuild { model: SemModel | null; errors: string[]; warnings: string[]; df: number | null; moments: number; npar: number }

/** Build (and statically check) the model from parsed syntax. `available` = names the data has (when known). */
export function buildSemModel(parse: SemParse, opts: { scaling?: "marker" | "unit_variance"; available?: (name: string) => boolean } = {}): SemBuild {
  const errors = [...parse.errors]; const warnings: string[] = [];
  const scaling = opts.scaling ?? "marker";
  const { latent, observed } = semNames(parse);
  if (opts.available) {
    const missing = observed.filter((o) => !opts.available!(o));
    if (missing.length) errors.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not a variable in this dataset (and not defined as a latent variable with =~).`);
    const clash = latent.filter((l) => opts.available!(l));
    if (clash.length) errors.push(`${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} defined as latent (=~) but also ${clash.length === 1 ? "is a dataset variable" : "are dataset variables"} — give the factor another name.`);
  }
  const p = observed.length, vars = [...observed, ...latent], m = vars.length;
  const moments = (p * (p + 1)) / 2;
  if (errors.length) return { model: null, errors, warnings, df: null, moments, npar: 0 };
  if (p < 2) return { model: null, errors: ["A model needs at least two observed variables."], warnings, df: null, moments, npar: 0 };
  const ix = new Map(vars.map((v, i) => [v, i]));
  const map = new Map<string, Entry>();
  const keyOf = (mat: "A" | "S", r: number, c: number) => (mat === "S" && r < c ? `S:${c}:${r}` : `${mat}:${r}:${c}`);
  const firstIndicator = new Map<string, string>();
  for (const s of parse.statements) {
    let mat: "A" | "S", r: number, c: number;
    if (s.op === "=~") { mat = "A"; r = ix.get(s.rhs.name)!; c = ix.get(s.lhs)!; if (!firstIndicator.has(s.lhs)) firstIndicator.set(s.lhs, s.rhs.name); }
    else if (s.op === "~") { mat = "A"; r = ix.get(s.lhs)!; c = ix.get(s.rhs.name)!; }
    else { mat = "S"; r = ix.get(s.lhs)!; c = ix.get(s.rhs.name)!; }
    const k = keyOf(mat, r, c);
    if (map.has(k)) { errors.push(`Line ${s.line}: ${s.lhs} ${s.op} ${s.rhs.name} is specified twice.`); continue; }
    if (mat === "A" && map.has(keyOf("A", c, r)) && s.op === "~") warnings.push(`${s.lhs} and ${s.rhs.name} predict each other (a non-recursive model) — check identification carefully.`);
    map.set(k, { matrix: mat, r: mat === "S" ? Math.max(r, c) : r, c: mat === "S" ? Math.min(r, c) : c, theta: null, value: s.rhs.fixed ?? NaN, label: s.rhs.label ?? null, op: s.op, lhs: s.lhs, rhs: s.rhs.name, user: true, ...(s.rhs.free ? { free: true } : {}) } as Entry & { free?: boolean });
  }
  // marker scaling: the first loading fixed to 1 unless the user fixed a loading of that factor, or freed the first (NA*)
  for (const l of latent) {
    const li = ix.get(l)!;
    const loadings = [...map.values()].filter((e) => e.matrix === "A" && e.c === li && e.op === "=~");
    if (scaling === "marker") {
      const anyFixed = loadings.some((e) => Number.isFinite(e.value));
      const first = map.get(keyOf("A", ix.get(firstIndicator.get(l)!)!, li)) as Entry & { free?: boolean };
      if (!anyFixed && first && !first.free) first.value = 1;
    }
  }
  const endo = new Set<number>();
  for (const e of map.values()) if (e.matrix === "A") endo.add(e.r);
  // variances
  for (let v = 0; v < m; v++) {
    const k = keyOf("S", v, v);
    if (map.has(k)) continue;
    const isLatent = v >= p;
    const fixedOne = isLatent && scaling === "unit_variance";
    map.set(k, { matrix: "S", r: v, c: v, theta: null, value: fixedOne ? 1 : NaN, label: null, op: "~~", lhs: vars[v], rhs: vars[v], user: false });
  }
  // covariances among exogenous latents, and among exogenous observed
  const exoLat = latent.map((l) => ix.get(l)!).filter((i) => !endo.has(i));
  const exoObs = observed.map((o) => ix.get(o)!).filter((i) => !endo.has(i));
  for (const grp of [exoLat, exoObs]) for (let a = 0; a < grp.length; a++) for (let b = 0; b < a; b++) {
    const k = keyOf("S", grp[a], grp[b]);
    if (!map.has(k)) map.set(k, { matrix: "S", r: Math.max(grp[a], grp[b]), c: Math.min(grp[a], grp[b]), theta: null, value: NaN, label: null, op: "~~", lhs: vars[Math.min(grp[a], grp[b])], rhs: vars[Math.max(grp[a], grp[b])], user: false });
  }
  // theta indices (labels shared → equality)
  const entries = [...map.values()];
  const byLabel = new Map<string, number>(); const thetaLabels: (string | null)[] = [];
  let nTheta = 0;
  for (const e of entries) {
    if (Number.isFinite(e.value)) continue;
    if (e.label && byLabel.has(e.label)) { e.theta = byLabel.get(e.label)!; continue; }
    e.theta = nTheta++; thetaLabels.push(e.label);
    if (e.label) byLabel.set(e.label, e.theta);
  }
  // labels on fixed parameters still name a value for := expressions
  const knownLabels = new Set(entries.filter((e) => e.label).map((e) => e.label!));
  for (const d of parse.defined) {
    const unknown = d.labels.filter((l) => !knownLabels.has(l));
    if (unknown.length) errors.push(`Line ${d.line}: “${d.name} := ${d.expr}” uses ${unknown.join(", ")}, which ${unknown.length === 1 ? "labels" : "label"} no parameter — label paths like “y ~ b*m”.`);
  }
  // identification — scale and indicators per factor
  for (const l of latent) {
    const li = ix.get(l)!;
    const loads = entries.filter((e) => e.matrix === "A" && e.c === li && e.op === "=~");
    const fixedLoad = loads.some((e) => e.theta == null && e.value !== 0);
    const varEntry = entries.find((e) => e.matrix === "S" && e.r === li && e.c === li)!;
    if (!fixedLoad && varEntry.theta != null) errors.push(`${l} has no scale: fix one loading (e.g. “${l} =~ 1*${loads[0]?.rhs ?? "x"} + …”) or its variance (“${l} ~~ 1*${l}”). The model is not identified.`);
    if (loads.length === 1) {
      const ind = loads[0].r;
      const resid = entries.find((e) => e.matrix === "S" && e.r === ind && e.c === ind)!;
      if (resid.theta != null) errors.push(`${l} has a single indicator (${vars[ind]}); fix its residual variance (e.g. “${vars[ind]} ~~ 0*${vars[ind]}”) or add indicators. The model is not identified.`);
    } else if (loads.length === 2) {
      const linked = entries.some((e) => (e.matrix === "S" && e.r !== e.c && (e.r === li || e.c === li) && e.c >= 0 && (e.r >= p && e.c >= p)) || (e.matrix === "A" && e.op === "~" && (e.r === li || e.c === li)));
      if (!linked) errors.push(`${l} has only two indicators and is not related to any other factor — a two-indicator factor is identified only when it covaries with, or is regressed on, another factor. Add a third indicator.`);
      else warnings.push(`${l} has only two indicators: it is identified only through its relation to other factors (empirically fragile).`);
    }
  }
  const df = moments - nTheta;
  if (nTheta > moments) errors.push(`The model has ${nTheta} free parameters but only ${moments} variances and covariances to fit (df = ${df}). It is not identified (t-rule) — remove paths or covariances, or add indicators.`);
  const model: SemModel = { vars, p, m, observed, latent, entries, nTheta, thetaLabels, defined: parse.defined, scaling, exogenousObserved: exoObs };
  return { model: errors.length ? null : model, errors, warnings, df, moments, npar: nTheta };
}

/** parse + build in one step (what the readiness rule and the runner call) */
export function checkSemSyntax(syntax: string, opts: { scaling?: "marker" | "unit_variance"; available?: (name: string) => boolean } = {}): SemBuild & { parse: SemParse } {
  const parse = parseSemSyntax(syntax);
  return { ...buildSemModel(parse, opts), parse };
}

/* ------------------------------------------------------------------ implied covariance & derivatives */

interface Implied { Sigma: Float64Array; B: Float64Array; C: Float64Array; Smat: Float64Array }
function implied(model: SemModel, theta: ArrayLike<number>): Implied | null {
  const { m, p } = model;
  const A = new Float64Array(m * m), Smat = new Float64Array(m * m);
  for (const e of model.entries) {
    const v = e.theta == null ? e.value : theta[e.theta];
    if (e.matrix === "A") A[e.r * m + e.c] = v; else { Smat[e.r * m + e.c] = v; Smat[e.c * m + e.r] = v; }
  }
  const IA = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) IA[i * m + j] = (i === j ? 1 : 0) - A[i * m + j];
  const B = invert(IA, m);
  if (!B) return null;
  // C = B S Bᵀ
  const BS = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let k = 0; k < m; k++) { const b = B[i * m + k]; if (b === 0) continue; for (let j = 0; j < m; j++) BS[i * m + j] += b * Smat[k * m + j]; }
  const C = new Float64Array(m * m);
  for (let i = 0; i < m; i++) for (let j = 0; j <= i; j++) { let s = 0; for (let k = 0; k < m; k++) s += BS[i * m + k] * B[j * m + k]; C[i * m + j] = s; C[j * m + i] = s; }
  const Sigma = new Float64Array(p * p);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) Sigma[i * p + j] = C[i * m + j];
  return { Sigma, B, C, Smat };
}

/** dΣ/dθ_t for every free parameter, as p×p flats (equality-constrained entries summed) */
function dSigma(model: SemModel, imp: Implied): Float64Array[] {
  const { m, p } = model;
  const out = Array.from({ length: model.nTheta }, () => new Float64Array(p * p));
  const { B, C } = imp;
  for (const e of model.entries) {
    if (e.theta == null) continue;
    const D = out[e.theta];
    if (e.matrix === "A") {
      // dΣ = u vᵀ + v uᵀ with u = B[:, r], v = C[c, :]
      for (let i = 0; i < p; i++) { const ui = B[i * m + e.r], vi = C[e.c * m + i]; for (let j = 0; j < p; j++) D[i * p + j] += ui * C[e.c * m + j] + vi * B[j * m + e.r]; }
    } else if (e.r === e.c) {
      for (let i = 0; i < p; i++) { const bi = B[i * m + e.r]; if (bi === 0) continue; for (let j = 0; j < p; j++) D[i * p + j] += bi * B[j * m + e.r]; }
    } else {
      for (let i = 0; i < p; i++) { const bir = B[i * m + e.r], bic = B[i * m + e.c]; for (let j = 0; j < p; j++) D[i * p + j] += bir * B[j * m + e.c] + bic * B[j * m + e.r]; }
    }
  }
  return out;
}

interface Eval { f: number; g: Float64Array; imp: Implied; Sinv: Float64Array }
function evaluate(model: SemModel, S: Float64Array, logDetS: number, theta: ArrayLike<number>, withGrad = true): Eval | null {
  const p = model.p;
  const imp = implied(model, theta);
  if (!imp) return null;
  const L = cholesky(imp.Sigma, p);
  if (!L) return null;
  const Sinv = cholInverse(L, p);
  let tr = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) tr += S[i * p + j] * Sinv[j * p + i];
  const f = logDetFromChol(L, p) + tr - logDetS - p;
  const g = new Float64Array(model.nTheta);
  if (withGrad) {
    // W = Σ⁻¹ − Σ⁻¹ S Σ⁻¹ ; g_t = tr(W dΣ_t)
    const T = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let k = 0; k < p; k++) { const a = Sinv[i * p + k]; for (let j = 0; j < p; j++) T[i * p + j] += a * S[k * p + j]; }
    const W = new Float64Array(p * p);
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { let s = 0; for (let k = 0; k < p; k++) s += T[i * p + k] * Sinv[k * p + j]; W[i * p + j] = Sinv[i * p + j] - s; }
    const D = dSigma(model, imp);
    for (let t = 0; t < model.nTheta; t++) { let s = 0; const d = D[t]; for (let i = 0; i < p * p; i++) s += W[i] * d[i]; g[t] = s; }
  }
  return { f, g, imp, Sinv };
}

/** expected (Fisher) information per observation: I_ab = ½ tr(Σ⁻¹ dΣ_a Σ⁻¹ dΣ_b) */
function expectedInfo(model: SemModel, imp: Implied, Sinv: Float64Array): Float64Array {
  const p = model.p, q = model.nTheta;
  const D = dSigma(model, imp);
  const M = D.map((d) => { const out = new Float64Array(p * p); for (let i = 0; i < p; i++) for (let k = 0; k < p; k++) { const a = Sinv[i * p + k]; if (a === 0) continue; for (let j = 0; j < p; j++) out[i * p + j] += a * d[k * p + j]; } return out; });
  const I = new Float64Array(q * q);
  for (let a = 0; a < q; a++) for (let b = 0; b <= a; b++) { let s = 0; const A = M[a], Bm = M[b]; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) s += A[i * p + j] * Bm[j * p + i]; I[a * q + b] = I[b * q + a] = 0.5 * s; }
  return I;
}

/* ------------------------------------------------------------------ fitting */

function startValues(model: SemModel, S: Float64Array): Float64Array {
  const { p, m } = model;
  const th = new Float64Array(model.nTheta).fill(NaN);
  const set = (t: number | null, v: number) => { if (t != null && !Number.isFinite(th[t])) th[t] = v; };
  const svar = (i: number) => (i < p ? S[i * p + i] : NaN);
  const markerOf = new Map<number, number>();
  for (const e of model.entries) if (e.matrix === "A" && e.op === "=~" && e.theta == null && e.value !== 0 && e.r < p && !markerOf.has(e.c)) markerOf.set(e.c, e.r);
  for (const e of model.entries) {
    if (e.theta == null) continue;
    if (e.matrix === "A" && e.op === "=~") {
      const mk = markerOf.get(e.c);
      if (model.scaling === "unit_variance") set(e.theta, e.r < p ? Math.sqrt(Math.max(0.5 * svar(e.r), 1e-3)) : 0.7);
      else if (mk != null && e.r < p) { const v = S[e.r * p + mk] / S[mk * p + mk]; set(e.theta, Number.isFinite(v) && Math.abs(v) > 0.05 ? v : 1); }
      else set(e.theta, 1);
    } else if (e.matrix === "A") set(e.theta, 0);
    else if (e.r === e.c) {
      if (e.r < p) set(e.theta, model.exogenousObserved.includes(e.r) ? svar(e.r) : 0.5 * svar(e.r));
      else { const mk = markerOf.get(e.r); set(e.theta, mk != null ? Math.max(0.05, 0.5 * svar(mk)) : 0.5); }
    } else set(e.theta, e.r < p && e.c < p && model.exogenousObserved.includes(e.r) && model.exogenousObserved.includes(e.c) ? S[e.r * p + e.c] : 0);
  }
  for (let t = 0; t < th.length; t++) if (!Number.isFinite(th[t])) th[t] = 0.1;
  void m;
  return th;
}

interface FitTrace { theta: Float64Array; f: number; iterations: number; converged: boolean; gradMax: number }
function optimise(model: SemModel, S: Float64Array, logDetS: number, start: Float64Array, maxIter: number): FitTrace {
  const q = model.nTheta;
  let theta = Float64Array.from(start);
  let cur = evaluate(model, S, logDetS, theta);
  if (!cur || !Number.isFinite(cur.f)) return { theta, f: NaN, iterations: 0, converged: false, gradMax: NaN };
  // inverse Hessian seeded with the expected Hessian of F (≈ 2 I₁)
  const seedH = () => { const I = expectedInfo(model, cur!.imp, cur!.Sinv); for (let i = 0; i < q * q; i++) I[i] *= 2; const inv = invert(I, q); if (inv) return inv; const id = new Float64Array(q * q); for (let i = 0; i < q; i++) id[i * q + i] = 1; return id; };
  let H = seedH();
  let iter = 0, converged = false;
  const gmax = (g: Float64Array) => g.reduce((t, v) => Math.max(t, Math.abs(v)), 0);
  for (iter = 1; iter <= maxIter; iter++) {
    const g = cur.g;
    if (gmax(g) < 1e-9) { converged = true; break; }
    const d = new Float64Array(q);
    for (let i = 0; i < q; i++) { let s = 0; for (let j = 0; j < q; j++) s -= H[i * q + j] * g[j]; d[i] = s; }
    let slope = 0; for (let i = 0; i < q; i++) slope += d[i] * g[i];
    if (!(slope < 0)) { H = seedH(); for (let i = 0; i < q; i++) { let s = 0; for (let j = 0; j < q; j++) s -= H[i * q + j] * g[j]; d[i] = s; } slope = 0; for (let i = 0; i < q; i++) slope += d[i] * g[i]; if (!(slope < 0)) break; }
    let step = 1, next: Eval | null = null, nt = theta;
    for (let ls = 0; ls < 50; ls++) {
      nt = theta.map((v, i) => v + step * d[i]);
      next = evaluate(model, S, logDetS, nt);
      if (next && Number.isFinite(next.f) && next.f <= cur.f + 1e-4 * step * slope) break;
      next = null; step *= 0.5;
    }
    if (!next) break;
    const sv = nt.map((v, i) => v - theta[i]);
    const yv = next.g.map((v, i) => v - g[i]);
    let sy = 0; for (let i = 0; i < q; i++) sy += sv[i] * yv[i];
    const fChange = cur.f - next.f;
    theta = nt; cur = next;
    if (sy > 1e-14) {
      // BFGS inverse update: H ← (I − ρ s yᵀ) H (I − ρ y sᵀ) + ρ s sᵀ
      const rho = 1 / sy;
      const Hy = new Float64Array(q); for (let i = 0; i < q; i++) { let s = 0; for (let j = 0; j < q; j++) s += H[i * q + j] * yv[j]; Hy[i] = s; }
      let yHy = 0; for (let i = 0; i < q; i++) yHy += yv[i] * Hy[i];
      for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) H[i * q + j] += -rho * (Hy[i] * sv[j] + sv[i] * Hy[j]) + (rho * rho * yHy + rho) * sv[i] * sv[j];
    }
    if (gmax(cur.g) < 1e-9 || (fChange >= 0 && fChange < 1e-15 * Math.max(1, Math.abs(cur.f)) && gmax(cur.g) < 1e-6)) { converged = true; break; }
  }
  // Fisher-scoring polish near the solution: a few Gauss–Newton steps on the expected information
  for (let k = 0; k < 25 && cur && gmax(cur.g) > 1e-11 && gmax(cur.g) < 1e-3; k++) {
    const I = expectedInfo(model, cur.imp, cur.Sinv); for (let i = 0; i < q * q; i++) I[i] *= 2;
    const inv = invert(I, q); if (!inv) break;
    const d = new Float64Array(q); for (let i = 0; i < q; i++) { let s = 0; for (let j = 0; j < q; j++) s -= inv[i * q + j] * cur.g[j]; d[i] = s; }
    let step = 1, accepted: Eval | null = null, nt = theta;
    for (let ls = 0; ls < 30; ls++) { nt = theta.map((v, i) => v + step * d[i]); const e = evaluate(model, S, logDetS, nt); if (e && e.f <= cur.f + 1e-15 * Math.max(1, Math.abs(cur.f))) { accepted = e; break; } step *= 0.5; }
    if (!accepted) break;
    theta = nt; cur = accepted;
  }
  const gm = cur ? gmax(cur.g) : NaN;
  return { theta, f: cur ? cur.f : NaN, iterations: iter, converged: converged || gm < 1e-6, gradMax: gm };
}

/* ------------------------------------------------------------------ helpers */

/** P(χ'²(df, λ) ≤ x): Poisson mixture of central χ², summed outward from the mode */
export function noncentralChiSquareCdf(x: number, df: number, lambda: number): number {
  if (x <= 0) return 0;
  if (lambda <= 0) return gammaP(df / 2, x / 2);
  const h = lambda / 2, j0 = Math.max(0, Math.floor(h));
  const logw = (j: number) => -h + j * Math.log(h) - logGamma(j + 1);
  let total = 0;
  for (let j = j0; j < j0 + 2000; j++) { const t = Math.exp(logw(j)) * gammaP(df / 2 + j, x / 2); total += t; if (Math.exp(logw(j)) < 1e-14 && j > j0) break; }
  for (let j = j0 - 1; j >= 0; j--) { const w = Math.exp(logw(j)); total += w * gammaP(df / 2 + j, x / 2); if (w < 1e-14) break; }
  return Math.min(1, Math.max(0, total));
}

/** λ such that cdf(x; df, λ) = target, by bisection (cdf decreases in λ) */
function lambdaFor(x: number, df: number, target: number): number {
  if (noncentralChiSquareCdf(x, df, 0) < target) return 0;
  let lo = 0, hi = Math.max(10, x * 2);
  while (noncentralChiSquareCdf(x, df, hi) > target && hi < 1e7) hi *= 2;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (noncentralChiSquareCdf(x, df, mid) > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** evaluate a := expression (labels, numbers, + − * / parentheses) */
export function evalExpr(expr: string, values: Record<string, number>): number {
  const toks = expr.match(/[A-Za-z_.][A-Za-z0-9_.]*|\d+\.?\d*(?:e[-+]?\d+)?|\.\d+|[-+*/()]/gi) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const prim = (): number => {
    const t = toks[i++];
    if (t === "(") { const v = sum(); if (toks[i++] !== ")") throw new Error("unbalanced parentheses"); return v; }
    if (t === "-") return -prim();
    if (t === "+") return prim();
    if (t != null && /^[\d.]/.test(t)) return Number(t);
    if (t != null && t in values) return values[t];
    throw new Error(`unknown term ${t}`);
  };
  const prod = (): number => { let v = prim(); while (peek() === "*" || peek() === "/") { const op = toks[i++]; const r = prim(); v = op === "*" ? v * r : v / r; } return v; };
  const sum = (): number => { let v = prod(); while (peek() === "+" || peek() === "-") { const op = toks[i++]; const r = prod(); v = op === "+" ? v + r : v - r; } return v; };
  const v = sum();
  if (i !== toks.length) throw new Error("unexpected token");
  return v;
}

/* ------------------------------------------------------------------ the estimator */

export function fitSem(input: SemInput, opts: SemOptions = {}): ModelRun<SemOutput> {
  const t0 = nowMs();
  const scaling = opts.scaling ?? "marker";
  const conf = opts.confidence ?? 0.95;
  const zc = normalQuantile(1 - (1 - conf) / 2);
  const build = checkSemSyntax(input.syntax, { scaling, available: (n) => Array.isArray(input.data[n]) });
  const baseMeta = { model: "sem" as const, version: MODELS_VERSION, seed: null, dataFingerprint: "", n: 0, options: { scaling, estimator: "ML", information: "expected", missing: "listwise", confidence: conf }, elapsedMs: 0 };
  const diagnostics: ModelDiagnostic[] = build.warnings.map((w) => diag("identification_warning", "warning", w));
  const stop = (status: "refused" | "failed", code: string, message: string, extra: ModelDiagnostic[] = []): ModelRun<SemOutput> =>
    ({ status, diagnostics: [...diagnostics, ...extra, diag(code, "error", message)], output: null, meta: { ...baseMeta, elapsedMs: nowMs() - t0 }, error: { code, message } });
  if (!build.model) return stop("refused", build.errors.some((e) => /not identified|t-rule|no scale/.test(e)) ? "not_identified" : "invalid_model", build.errors.join(" "));
  const model = build.model;
  const { p, observed } = model;
  // listwise-complete cases on the observed variables
  const cols = observed.map((o) => input.data[o]);
  const nAll = Math.max(...cols.map((c) => c.length));
  const rows: number[][] = [];
  for (let i = 0; i < nAll; i++) { const r = cols.map((c) => c[i]); if (r.every((v) => typeof v === "number" && Number.isFinite(v))) rows.push(r as number[]); }
  const N = rows.length;
  baseMeta.n = N; baseMeta.dataFingerprint = fingerprintNumbers(rows);
  if (nAll - N > 0) diagnostics.push(diag("listwise", "info", `${nAll - N} of ${nAll} respondents were left out because they lack a value on at least one model variable (listwise deletion; FIML is not used).`));
  if (N < Math.max(50, 5 * model.nTheta)) diagnostics.push(diag("small_sample", N < model.nTheta + p ? "error" : "warning", `${N} complete cases for ${model.nTheta} free parameters — ML estimates and fit indices are unreliable below about ${Math.max(100, 10 * model.nTheta)} cases.`));
  if (N <= p) return stop("refused", "too_few_cases", `Only ${N} complete cases for ${p} observed variables — the sample covariance matrix is singular.`);
  const mean = new Array(p).fill(0); for (const r of rows) for (let j = 0; j < p; j++) mean[j] += r[j] / N;
  const S = new Float64Array(p * p);
  for (const r of rows) for (let a = 0; a < p; a++) for (let b = 0; b <= a; b++) S[a * p + b] += (r[a] - mean[a]) * (r[b] - mean[b]) / N;
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) S[b * p + a] = S[a * p + b];
  const zeroVar = observed.filter((_, j) => !(S[j * p + j] > 1e-12));
  if (zeroVar.length) return stop("refused", "constant_variable", `${zeroVar.join(", ")} ${zeroVar.length === 1 ? "has" : "have"} no variance among the complete cases.`);
  const LS = cholesky(S, p);
  if (!LS) return stop("refused", "singular_covariance", "The sample covariance matrix is not positive definite (a variable is a linear combination of others, or there are too few cases).");
  const logDetS = logDetFromChol(LS, p);
  const maxIter = Math.max(1, Math.floor(opts.maxIter ?? 1000));
  let fit = optimise(model, S, logDetS, startValues(model, S), maxIter);
  if (!fit.converged && maxIter >= 50) {
    // one retry from a damped start
    const alt = startValues(model, S).map((v) => v * 0.5 + 0.05);
    const f2 = optimise(model, S, logDetS, alt, maxIter);
    if (f2.converged || (Number.isFinite(f2.f) && !(f2.f > fit.f))) fit = f2;
  }
  if (!fit.converged || !Number.isFinite(fit.f)) return stop("failed", "not_converged", `The estimator did not converge (largest gradient ${Number.isFinite(fit.gradMax) ? fit.gradMax.toExponential(1) : "undefined"} after ${fit.iterations} iterations). No estimates or fit indices are reported. Check the model for under-identification, very different variable scales, or an over-ambitious structure.`);
  const ev = evaluate(model, S, logDetS, fit.theta)!;
  const { C, Smat } = ev.imp;
  const m = model.m;
  // improper solutions (Heywood cases)
  const improper: ModelDiagnostic[] = [];
  for (let v = 0; v < m; v++) if (Smat[v * m + v] < 0) improper.push(diag("heywood", "error", `${v < p ? "Residual variance" : "Variance"} of ${model.vars[v]} is negative (${Smat[v * m + v].toFixed(3)}) — an improper solution (Heywood case).`));
  const sd = Array.from({ length: m }, (_, v) => Math.sqrt(Math.max(C[v * m + v], 0)));
  for (const e of model.entries) if (e.matrix === "A" && e.op === "=~" && e.r < p) { const v = e.theta == null ? e.value : fit.theta[e.theta]; const s = sd[e.r] ? v * sd[e.c] / sd[e.r] : 0; if (Math.abs(s) > 1 + 1e-6) improper.push(diag("heywood", "error", `Standardised loading of ${e.rhs} on ${e.lhs} is ${s.toFixed(3)} (beyond ±1) — an improper solution.`)); }
  if (model.latent.length) {
    const li = model.latent.map((_, k) => p + k);
    const Cl = new Float64Array(li.length * li.length);
    li.forEach((a, i) => li.forEach((b, j) => { Cl[i * li.length + j] = C[a * m + b]; }));
    if (!cholesky(Cl, li.length)) improper.push(diag("heywood", "error", "The latent covariance matrix is not positive definite (a factor correlation at or beyond ±1) — an improper solution."));
  }
  if (improper.length) return stop("failed", "improper_solution", "The model converged to an improper solution, so its coefficients and fit indices are not valid and are not reported. Typical causes: too few indicators per factor, a misspecified structure, or a small sample.", improper);
  // standard errors from the expected information
  const q = model.nTheta;
  const I1 = expectedInfo(model, ev.imp, ev.Sinv);
  const info = I1.map((v) => v * N);
  const minEig = minEigenSym(I1, q);
  const scaleI = Math.max(...Array.from({ length: q }, (_, i) => Math.abs(I1[i * q + i])));
  if (!(minEig > 1e-9 * scaleI)) return stop("failed", "not_identified", "The information matrix is singular at the solution — the model is empirically not identified (some parameters cannot be told apart from the data). No estimates are reported.");
  const V = invert(info, q);
  if (!V) return stop("failed", "not_identified", "The information matrix could not be inverted — the model is empirically not identified.");
  const se = Array.from({ length: q }, (_, t) => Math.sqrt(Math.max(V[t * q + t], 0)));
  const pz = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));
  const estimates: SemEstimate[] = model.entries.map((e) => {
    const est = e.theta == null ? e.value : fit.theta[e.theta];
    const s = e.theta == null ? null : se[e.theta];
    const isLatR = e.r >= p, endoR = model.entries.some((x) => x.matrix === "A" && x.r === e.r);
    let std: number | null = null;
    if (e.matrix === "A") std = sd[e.r] ? est * sd[e.c] / sd[e.r] : null;
    else if (e.r === e.c) std = C[e.r * m + e.r] ? est / C[e.r * m + e.r] : null;
    else { const d = Math.sqrt(Smat[e.r * m + e.r] * Smat[e.c * m + e.c]); std = d > 0 ? est / d : null; }
    const kind: SemEstimate["kind"] = e.matrix === "A" ? (e.op === "=~" ? "loading" : "regression") : e.r === e.c ? (endoR ? "residual_variance" : "variance") : (endoR || model.entries.some((x) => x.matrix === "A" && x.r === e.c) ? "residual_covariance" : "covariance");
    void isLatR;
    const z = s ? est / s : null;
    return { lhs: e.matrix === "A" ? (e.op === "=~" ? e.lhs : e.lhs) : model.vars[e.c], op: e.op, rhs: e.matrix === "A" ? e.rhs : model.vars[e.r], label: e.label, free: e.theta != null, est, se: s, z, p: z == null ? null : pz(z), ciLow: s == null ? null : est - zc * s, ciHigh: s == null ? null : est + zc * s, std, kind };
  });
  // order: loadings, regressions, covariances, variances
  const rank: Record<SemEstimate["kind"], number> = { loading: 0, regression: 1, covariance: 2, residual_covariance: 2, variance: 3, residual_variance: 3 };
  estimates.sort((a, b) => rank[a.kind] - rank[b.kind]);
  // defined parameters + automatic indirect effects (delta method, numeric gradient)
  const labelValues = (th: ArrayLike<number>) => { const out: Record<string, number> = {}; for (const e of model.entries) if (e.label) out[e.label] = e.theta == null ? e.value : th[e.theta]; return out; };
  const delta = (fn: (th: Float64Array) => number): { est: number; se: number | null } => {
    const est = fn(fit.theta);
    const g = new Float64Array(q);
    for (let t = 0; t < q; t++) { const h = 1e-6 * Math.max(1, Math.abs(fit.theta[t])); const a = Float64Array.from(fit.theta), b = Float64Array.from(fit.theta); a[t] += h; b[t] -= h; g[t] = (fn(a) - fn(b)) / (2 * h); }
    let v = 0; for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) v += g[i] * V[i * q + j] * g[j];
    return { est, se: v >= 0 ? Math.sqrt(v) : null };
  };
  const definedOut: SemDefinedEstimate[] = [];
  for (const d of model.defined) {
    try {
      const r = delta((th) => evalExpr(d.expr, labelValues(th)));
      const z = r.se ? r.est / r.se : null;
      definedOut.push({ name: d.name, expr: d.expr, est: r.est, se: r.se, z, p: z == null ? null : pz(z), ciLow: r.se == null ? null : r.est - zc * r.se, ciHigh: r.se == null ? null : r.est + zc * r.se, automatic: false });
    } catch (e) { diagnostics.push(diag("defined_error", "warning", `“${d.name} := ${d.expr}” could not be evaluated (${(e as Error).message}).`)); }
  }
  // automatic: every x → m → y chain of structural regressions
  const reg = model.entries.filter((e) => e.matrix === "A" && e.op === "~");
  const val = (e: Entry, th: ArrayLike<number>) => (e.theta == null ? e.value : th[e.theta]);
  for (const a of reg) for (const b of reg) {
    if (b.c !== a.r) continue; // a: M ← X ; b: Y ← M
    if (a.c === b.r) continue;
    const x = model.vars[a.c], mm = model.vars[a.r], y = model.vars[b.r];
    const r = delta((th) => val(a, th) * val(b, th));
    const z = r.se ? r.est / r.se : null;
    definedOut.push({ name: `${x} → ${mm} → ${y}`, expr: `${a.label ?? `(${mm}~${x})`}*${b.label ?? `(${y}~${mm})`}`, est: r.est, se: r.se, z, p: z == null ? null : pz(z), ciLow: r.se == null ? null : r.est - zc * r.se, ciHigh: r.se == null ? null : r.est + zc * r.se, automatic: true });
  }
  // fit
  const moments = (p * (p + 1)) / 2;
  const df = moments - q;
  const chisq = Math.max(0, N * fit.f);
  // baseline: free variances (+ covariances among exogenous observed, as lavaan's fixed.x baseline)
  const exo = model.exogenousObserved;
  let logDetB = 0;
  for (let j = 0; j < p; j++) if (!exo.includes(j)) logDetB += Math.log(S[j * p + j]);
  if (exo.length) { const k = exo.length; const Sx = new Float64Array(k * k); exo.forEach((a, i) => exo.forEach((b, jj) => { Sx[i * k + jj] = S[a * p + b]; })); const Lx = cholesky(Sx, k); logDetB += Lx ? logDetFromChol(Lx, k) : exo.reduce((t, a) => t + Math.log(S[a * p + a]), 0); }
  const baselineChisq = Math.max(0, N * (logDetB - logDetS));
  const baselineDf = moments - p - (exo.length * (exo.length - 1)) / 2;
  const cfi = baselineChisq > 0 || chisq > 0 ? 1 - Math.max(chisq - df, 0) / Math.max(baselineChisq - baselineDf, chisq - df, 0) : null;
  const tli = df > 0 && baselineDf > 0 ? (baselineChisq / baselineDf - chisq / df) / (baselineChisq / baselineDf - 1) : null;
  const rmsea = df > 0 ? Math.sqrt(Math.max(chisq - df, 0) / (df * N)) : null;
  const rmseaLow = df > 0 ? Math.sqrt(lambdaFor(chisq, df, 0.95) / (df * N)) : null;
  const rmseaHigh = df > 0 ? Math.sqrt(lambdaFor(chisq, df, 0.05) / (df * N)) : null;
  const Sig = ev.imp.Sigma;
  let ss = 0; const residualCorrelations: SemOutput["residualCorrelations"] = [];
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { const r = (S[i * p + j] - Sig[i * p + j]) / Math.sqrt(S[i * p + i] * S[j * p + j]); ss += r * r; if (i !== j) residualCorrelations.push({ a: observed[j], b: observed[i], residual: r }); }
  const srmr = Math.sqrt(ss / moments);
  const LSig = cholesky(Sig, p)!;
  let trSS = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) trSS += S[i * p + j] * ev.Sinv[j * p + i];
  const logLik = -0.5 * N * (p * Math.log(2 * Math.PI) + logDetFromChol(LSig, p) + trSS);
  const fitOut: SemFit = { n: N, npar: q, chisq, df, pvalue: df > 0 ? chiSquareP(chisq, df) : null, baselineChisq, baselineDf, cfi: cfi == null ? null : Math.min(1, Math.max(0, cfi)), tli, rmsea, rmseaLow, rmseaHigh, srmr, logLik, aic: -2 * logLik + 2 * q, bic: -2 * logLik + q * Math.log(N) };
  if (df === 0) diagnostics.push(diag("just_identified", "info", "The model is just-identified (df = 0): it reproduces the covariances exactly, so χ², CFI, TLI and RMSEA say nothing about fit."));
  const r2 = model.vars.map((v, i) => ({ v, i })).filter(({ i }) => model.entries.some((e) => e.matrix === "A" && e.r === i)).map(({ v, i }) => ({ variable: v, r2: C[i * m + i] > 0 ? 1 - Smat[i * m + i] / C[i * m + i] : NaN }));
  residualCorrelations.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  return {
    status: "done", diagnostics,
    output: { observed, latent: model.latent, estimates, defined: definedOut, fit: fitOut, r2, nUsed: N, nDropped: nAll - N, iterations: fit.iterations, scaling, residualCorrelations: residualCorrelations.slice(0, 10) },
    meta: { ...baseMeta, elapsedMs: nowMs() - t0 },
  };
}
