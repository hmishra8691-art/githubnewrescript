import { fitSem, type SemOutput } from "./sem.js";

/**
 * McDONALD'S ω (advanced models from the plan, 2026-10-22).
 *
 * Coefficient omega is the share of a sum score's variance that the common
 * factor explains: ω = (Σλ)²ψ / ((Σλ)²ψ + Σθ + 2Σθᵢⱼ), with λ the items'
 * loadings on the factor, ψ the factor's variance, θ the residual variances
 * and θᵢⱼ any residual covariances between the factor's items. Unlike α it
 * does not assume every item loads equally (tau-equivalence), so it is the
 * reliability a one-factor CFA implies. Read from a fitted CFA through the
 * existing ML estimator (`fitSem`), it inherits the estimator's rules: a model
 * that did not converge, is improper (Heywood) or not identified gives no ω.
 *
 * Validated in `omega.test.ts` against (1) the closed form of a just-identified
 * one-factor model of three items (λᵢ² = sᵢⱼsᵢₖ/sⱼₖ), computed by hand from
 * the covariance matrix, and (2) the published semTools `reliability()` output
 * for the Holzinger–Swineford three-factor CFA (omega 0.6253, 0.8852, 0.6878).
 */

export interface OmegaResult {
  factor: string;
  items: string[];
  omega: number;
  /** Σλ, Σθ and ψ it was computed from */
  sumLoadings: number;
  sumResidual: number;
  factorVariance: number;
  /** standardised loadings, item by item */
  loadings: { item: string; std: number | null; est: number }[];
  /** items with a negative standardised loading: reverse-keyed, or not measuring the factor — ω of the raw sum is then misleading */
  negative: string[];
}

/** ω for every factor of a fitted CFA / SEM measurement model */
export function omegaFromSem(out: SemOutput): OmegaResult[] {
  const res: OmegaResult[] = [];
  for (const f of out.latent) {
    /* an endogenous factor's variance in the table is its RESIDUAL variance, not ψ — ω is read from a measurement model */
    if (out.estimates.some((e) => e.kind === "regression" && e.lhs === f)) continue;
    const loads = out.estimates.filter((e) => e.kind === "loading" && e.lhs === f && !out.latent.includes(e.rhs));
    if (loads.length < 2) continue;
    const items = loads.map((l) => l.rhs);
    const psiEst = out.estimates.find((e) => (e.kind === "variance" || e.kind === "residual_variance") && e.lhs === f && e.rhs === f);
    const psi = psiEst?.est ?? 1;
    const theta = items.map((i) => out.estimates.find((e) => (e.kind === "residual_variance" || e.kind === "variance") && e.lhs === i && e.rhs === i)?.est ?? 0);
    const thetaCov = out.estimates.filter((e) => e.kind === "residual_covariance" && items.includes(e.lhs) && items.includes(e.rhs) && e.lhs !== e.rhs).reduce((t, e) => t + e.est, 0);
    const sumL = loads.reduce((t, l) => t + l.est, 0);
    const common = sumL * sumL * psi;
    const sumT = theta.reduce((t, v) => t + v, 0);
    const total = common + sumT + 2 * thetaCov;
    if (!(total > 0)) continue;
    res.push({ factor: f, items, omega: common / total, sumLoadings: sumL, sumResidual: sumT, factorVariance: psi, loadings: loads.map((l) => ({ item: l.rhs, std: l.std, est: l.est })), negative: loads.filter((l) => (l.std ?? l.est) < 0).map((l) => l.rhs) });
  }
  return res;
}

export interface OmegaRun {
  result: OmegaResult | null;
  /** why there is no ω, in the researcher's words */
  reason?: string;
  /** fit of the one-factor model (testable from four items; three items are just-identified) */
  fit?: { chisq: number; df: number; cfi: number | null; rmsea: number | null; srmr: number; n: number };
  warnings: string[];
}

/**
 * ω of a scale from its items: a one-factor CFA (latent variance fixed to 1,
 * every loading free), ML on the complete cases. Needs three items — two
 * items do not identify a one-factor model without an equality constraint.
 */
export function mcdonaldOmega(columns: Record<string, readonly (number | null)[]>, items: readonly string[]): OmegaRun {
  const names = items.filter((n) => Array.isArray(columns[n]));
  if (names.length < 3) return { result: null, reason: `McDonald's ω comes from a one-factor model, which needs at least three items to be identified — this scale has ${names.length}. Cronbach's α is reported.`, warnings: [] };
  /* the CFA syntax names variables; the items are renamed so any variable name is safe in it */
  const alias = names.map((_, i) => `i${i + 1}`);
  const data: Record<string, (number | null)[]> = {};
  names.forEach((n, i) => { data[alias[i]] = [...columns[n]]; });
  const run = fitSem({ syntax: `OMEGA_F =~ ${alias.join(" + ")}`, data }, { scaling: "unit_variance" });
  if (!run.output) return { result: null, reason: `McDonald's ω could not be estimated: ${run.error?.message ?? "the one-factor model did not give a valid solution"}`, warnings: [] };
  const om = omegaFromSem(run.output)[0];
  if (!om) return { result: null, reason: "McDonald's ω could not be computed from the one-factor model.", warnings: [] };
  const back = (a: string) => names[alias.indexOf(a)] ?? a;
  const result: OmegaResult = { ...om, factor: "Scale", items: om.items.map(back), loadings: om.loadings.map((l) => ({ ...l, item: back(l.item) })), negative: om.negative.map(back) };
  const f = run.output.fit;
  const warnings: string[] = [];
  if (result.negative.length) warnings.push(`${result.negative.join(", ")} load${result.negative.length === 1 ? "s" : ""} negatively on the common factor — reverse-code ${result.negative.length === 1 ? "it" : "them"} (or drop ${result.negative.length === 1 ? "it" : "them"}) before reading ω or α.`);
  if (f.df > 0 && ((f.cfi ?? 1) < 0.9 || (f.rmsea ?? 0) > 0.1)) warnings.push(`The one-factor model fits poorly (CFI ${f.cfi?.toFixed(3) ?? "—"}, RMSEA ${f.rmsea?.toFixed(3) ?? "—"}): the items may measure more than one thing, and ω assumes one.`);
  return { result, fit: { chisq: f.chisq, df: f.df, cfi: f.cfi, rmsea: f.rmsea, srmr: f.srmr, n: f.n }, warnings };
}
