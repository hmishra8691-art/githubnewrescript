import { chiSquareP } from "./stats/distributions.js";
import { scaledInverse, inverse } from "./stats/matrix.js";
import { designMatrix, type DesignSpec, type LinearModel, type LogisticModel } from "./stats/regression.js";
import type { DataAdvice } from "./dataAdvice.js";

/**
 * DOES THE MODEL'S FOUNDATION HOLD? (Level 5 roadmap M5 — 2026-11-29)
 *
 * Every model rests on assumptions; a coefficient read from a model whose assumptions fail can be wrong in sign,
 * size or significance. Each check here says what was measured, against what threshold, whether it holds, and
 * what to do when it does not — in words a researcher acts on.
 *
 *   linear regression    cases per predictor; overlap between predictors (VIF); normal residuals (Jarque–Bera);
 *                        constant variance (Breusch–Pagan, Koenker's form); cases that decide the fit (Cook's D)
 *   logistic regression  events per predictor; convergence; separation; overlap between predictors
 *   tables and tests     the existing data advice (expected cells, skew, unequal variance, small groups), in the
 *                        same shape
 *
 * The thresholds are the conventional ones and each is stated with the check.
 */
export type CheckState = "holds" | "caution" | "fails";
export interface AssumptionCheck { id: string; check: string; observed: string; threshold: string; state: CheckState; whatToDo?: string }

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");

function vifs(spec: DesignSpec, y: (number | null | undefined)[]): Record<string, number> {
  const { X, terms } = designMatrix(y, spec);
  const n = X.length, k = terms.length;
  if (k <= 2 || n <= k) return {};
  const P = terms.slice(1).map((_, j) => X.map((r) => r[j + 1]!));
  const means = P.map((c) => c.reduce((t, v) => t + v, 0) / n);
  const S = P.map((ci, a) => P.map((cj, b) => ci.reduce((t, v, i) => t + (v - means[a]!) * (cj[i]! - means[b]!), 0)));
  const R = S.map((row, a) => row.map((v, b) => (S[a]![a] && S[b]![b] ? v / Math.sqrt(S[a]![a]! * S[b]![b]!) : 0)));
  const Rinv = inverse(R, 1e-12);
  return Rinv ? Object.fromEntries(terms.slice(1).map((t, j) => [t, Rinv[j]![j]!])) : {};
}

function vifCheck(v: Record<string, number>): AssumptionCheck | null {
  const entries = Object.entries(v);
  if (!entries.length) return null;
  const [worst, max] = entries.sort((a, b) => b[1] - a[1])[0]!;
  return { id: "collinearity", check: "Predictors do not overlap too much", observed: `largest VIF ${f(max, 1)} (${worst})`, threshold: "VIF under 5; over 10 is serious", state: max > 10 ? "fails" : max > 5 ? "caution" : "holds", ...(max > 5 ? { whatToDo: `${worst} carries largely the same information as other predictors, so its coefficient is unstable. Drop one of the overlapping predictors, or combine them into an index.` } : {}) };
}

/** linear regression: the fit and the design it was fitted on */
export function linearModelChecks(fit: LinearModel, spec: DesignSpec, y: (number | null | undefined)[]): AssumptionCheck[] {
  const out: AssumptionCheck[] = [];
  const { X } = designMatrix(y, spec);
  const n = fit.n, k = fit.terms.length, p = k - 1;
  const perPred = p ? n / p : Infinity;
  out.push({ id: "cases_per_predictor", check: "Enough cases for the number of predictors", observed: `${n} cases, ${p} predictor${p === 1 ? "" : "s"} (${f(perPred, 0)} each)`, threshold: "at least 10 cases per predictor; 20 is comfortable", state: perPred < 10 ? "fails" : perPred < 20 ? "caution" : "holds", ...(perPred < 10 ? { whatToDo: "The model is fitting noise. Use fewer predictors or more cases." } : {}) });
  const v = vifCheck(fit.vif ?? {});
  if (v) out.push(v);
  /* residuals: skewness and kurtosis → Jarque–Bera */
  const e = fit.residuals, m = e.reduce((a, b) => a + b, 0) / n;
  const m2 = e.reduce((a, b) => a + (b - m) ** 2, 0) / n, m3 = e.reduce((a, b) => a + (b - m) ** 3, 0) / n, m4 = e.reduce((a, b) => a + (b - m) ** 4, 0) / n;
  const skew = m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt = m2 > 0 ? m4 / m2 ** 2 : 3;
  const jb = (n / 6) * (skew ** 2 + (kurt - 3) ** 2 / 4), jbP = chiSquareP(jb, 2);
  out.push({ id: "normal_residuals", check: "Residuals are roughly normal", observed: `skewness ${f(skew)}, kurtosis ${f(kurt)}, Jarque–Bera p ${jbP < 0.001 ? "< 0.001" : f(jbP, 3)}`, threshold: "p ≥ 0.05, or 200+ cases (the coefficients' tests are then robust to it)", state: jbP >= 0.05 ? "holds" : n >= 200 ? "caution" : "fails", ...(jbP < 0.05 ? { whatToDo: n >= 200 ? "With this many cases the tests on the coefficients still hold; prediction intervals for single cases do not. Look at the largest residuals before reading individual predictions." : "With few cases the p-values lean on normal residuals. Transform a skewed outcome (log or rank), or bootstrap the coefficients." } : {}) });
  /* constant variance: Breusch–Pagan (Koenker) — regress e² on the predictors; n·R² ~ χ²(p) */
  if (p >= 1 && X.length === n) {
    const e2 = e.map((x) => x * x), mean2 = e2.reduce((a, b) => a + b, 0) / n;
    const Xt = X[0]!.map((_, j) => X.map((r) => r[j]!));
    const XtX = Xt.map((row) => Xt.map((col) => row.reduce((t, val, i) => t + val * col[i]!, 0)));
    const inv = scaledInverse(XtX);
    if (inv) {
      const Xty = Xt.map((row) => row.reduce((t, val, i) => t + val * e2[i]!, 0));
      const b = inv.map((row) => row.reduce((t, val, j) => t + val * Xty[j]!, 0));
      const fitted = X.map((r) => r.reduce((t, val, j) => t + val * b[j]!, 0));
      const ssr = fitted.reduce((t, val) => t + (val - mean2) ** 2, 0), sst = e2.reduce((t, val) => t + (val - mean2) ** 2, 0);
      const lm = sst > 0 ? (n * ssr) / sst : 0, bpP = chiSquareP(lm, p);
      out.push({ id: "constant_variance", check: "The spread of the residuals is the same throughout", observed: `Breusch–Pagan n·R² = ${f(lm)}, p ${bpP < 0.001 ? "< 0.001" : f(bpP, 3)}`, threshold: "p ≥ 0.05", state: bpP >= 0.05 ? "holds" : "caution", ...(bpP < 0.05 ? { whatToDo: "The coefficients are still unbiased, but their standard errors and p-values are not to be trusted as printed. Read significance with robust (heteroscedasticity-consistent) standard errors, or model the outcome on a transformed scale." } : {}) });
      /* influence: Cook's distance from the leverage of each case */
      const s2 = fit.residualSe ** 2;
      let over = 0, worst = 0;
      for (let i = 0; i < n; i++) {
        const xi = X[i]!; const h = xi.reduce((t, a, r) => t + a * inv[r]!.reduce((u, c, cIdx) => u + c * xi[cIdx]!, 0), 0);
        const d = s2 > 0 && h < 1 ? (e[i]! ** 2 / (k * s2)) * (h / (1 - h) ** 2) : 0;
        if (d > 4 / n) over++;
        if (d > worst) worst = d;
      }
      out.push({ id: "influence", check: "No single case decides the fit", observed: `largest Cook's distance ${f(worst)}; ${over} case${over === 1 ? "" : "s"} above 4/n`, threshold: "no case above 1; few above 4/n", state: worst > 1 ? "fails" : over > Math.max(3, n * 0.05) ? "caution" : "holds", ...(worst > 1 ? { whatToDo: "One case moves the coefficients on its own. Look at it: a data error is removed, a real but unusual case is reported with and without it." } : over > Math.max(3, n * 0.05) ? { whatToDo: "Several cases pull the fit. Refit without them and report whether the conclusions change." } : {}) });
    }
  }
  return out;
}

/** logistic regression */
export function logisticModelChecks(fit: LogisticModel, spec: DesignSpec, y: (number | null | undefined)[]): AssumptionCheck[] {
  const out: AssumptionCheck[] = [];
  const { y: Y } = designMatrix(y, spec);
  const ones = Y.filter((v) => v === 1).length, zeros = Y.length - ones, p = fit.terms.length - 1;
  const epv = p ? Math.min(ones, zeros) / p : Infinity;
  out.push({ id: "events_per_predictor", check: "Enough of the rarer outcome for the number of predictors", observed: `${Math.min(ones, zeros)} cases of the rarer outcome, ${p} predictor${p === 1 ? "" : "s"} (${f(epv, 1)} each)`, threshold: "at least 10 per predictor", state: epv < 5 ? "fails" : epv < 10 ? "caution" : "holds", ...(epv < 10 ? { whatToDo: "The odds ratios are biased away from 1 and unstable. Use fewer predictors, or a penalised (Firth) model." } : {}) });
  out.push({ id: "converged", check: "The estimation converged", observed: fit.converged ? `converged in ${fit.iterations} iterations` : `stopped after ${fit.iterations} iterations without converging`, threshold: "converged", state: fit.converged ? "holds" : "fails", ...(fit.converged ? {} : { whatToDo: "The estimates are not final. This usually means separation (below) or a predictor with almost no variation." }) });
  const extreme = fit.fitted.filter((q) => q < 1e-6 || q > 1 - 1e-6).length;
  const huge = fit.coefficients.slice(1).filter((c) => Math.abs(c.estimate) > 10).map((c) => c.term);
  out.push({ id: "separation", check: "No predictor separates the outcome perfectly", observed: `${extreme} case${extreme === 1 ? "" : "s"} predicted with certainty${huge.length ? `; very large coefficients for ${huge.join(", ")}` : ""}`, threshold: "no case predicted at 0 or 1, no coefficient beyond ±10", state: huge.length || extreme > 0 ? "fails" : "holds", ...(huge.length || extreme > 0 ? { whatToDo: `${huge.length ? huge.join(", ") : "Some predictor"} predicts the outcome (almost) perfectly for some group, so its odds ratio runs to infinity. Combine that predictor's sparse categories, or use a penalised (Firth) model.` } : {}) });
  const v = vifCheck(vifs(spec, y));
  if (v) out.push(v);
  return out;
}

/** the existing data advice for tables and tests, in the same shape */
export function adviceChecks(a: DataAdvice): AssumptionCheck[] {
  const words: Record<string, string> = { expected_cells: "Expected cell counts are large enough for chi-square", small_group: "Every group is large enough to compare", skew: "The outcome is not strongly skewed", unequal_variance: "Groups have similar spread", ceiling: "The scale is not bunched at the top", floor: "The scale is not bunched at the bottom", low_base: "Enough respondents to test anything", missing: "Few answers are missing", one_group: "There are groups to compare", thin_category: "No category is too thin", few_per_predictor: "Enough cases for the number of predictors" };
  return a.checks.map((c) => ({ id: c.code, check: words[c.code] ?? c.code.replace(/_/g, " "), observed: c.message, threshold: "see the check", state: c.severity === "warning" ? "fails" : "caution", ...(a.recommended ? { whatToDo: `${a.recommended.label}: ${a.recommended.reason}` } : {}) }));
}

/** one line for a result's warnings: only what fails */
export const failedChecks = (checks: AssumptionCheck[]): string[] => checks.filter((c) => c.state === "fails").map((c) => `Assumption not met — ${c.check.toLowerCase()}: ${c.observed}. ${c.whatToDo ?? ""}`.trim());
