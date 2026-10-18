import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSemSyntax, evalExpr, fitSem, noncentralChiSquareCdf, type SemEstimate, type SemOutput } from "./sem.js";
import { parseSemSyntax } from "./semSyntax.js";
import { Rng } from "./rng.js";
import { advancedDataset, advSpec, numericSurvey } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { chiSquareCdf } from "../stats/distributions.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * SEM against semopy 2.3 (solver trust-constr, expected information) and the
 * published lavaan values. scripts/stats-reference/sem_reference.py fits:
 *   Holzinger–Swineford 3-factor CFA (N = 301), Bollen's Political Democracy
 *   (N = 75, 2 structural paths, 6 residual covariances), and a simulated
 *   X → M → Y mediation model (N = 500).
 * Tolerances: estimates and SEs within 1e-4 of semopy (measured ≤ 3e-7),
 * χ² within 1e-3, CFI / TLI / RMSEA / SRMR within 1e-4, AIC / BIC within 0.01;
 * HS also within rounding of lavaan's published output.
 */
type RefEst = { lval: string; op: string; rval: string; est: number; se: number | null; std: number };
type Ref = { syntax: string; data: Record<string, number[]>; estimates: RefEst[]; fit: Record<string, number>; lavaanPublished?: Record<string, unknown>; truth?: Record<string, number>; indirect?: { est: number; sobelSe: number } };
const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "stats-reference", "fixtures", "sem.json"), "utf8")) as Record<"hs" | "poldem" | "mediation", Ref>;

/** semopy writes a loading as "x1 ~ visual"; ours is "visual =~ x1" */
function find(out: SemOutput, e: RefEst): SemEstimate | undefined {
  const latent = new Set(out.latent);
  if (e.op === "~" && latent.has(e.rval) && !latent.has(e.lval)) return out.estimates.find((x) => x.op === "=~" && x.lhs === e.rval && x.rhs === e.lval);
  if (e.op === "~") return out.estimates.find((x) => x.op === "~" && x.lhs === e.lval && x.rhs === e.rval);
  return out.estimates.find((x) => x.op === "~~" && ((x.lhs === e.lval && x.rhs === e.rval) || (x.lhs === e.rval && x.rhs === e.lval)));
}

function compare(name: "hs" | "poldem" | "mediation") {
  const ref = FX[name];
  const r = fitSem({ syntax: ref.syntax, data: ref.data });
  assert.equal(r.status, "done", JSON.stringify(r.diagnostics));
  const out = r.output!;
  assert.equal(out.estimates.length, ref.estimates.length, "same parameter table");
  let dEst = 0, dSe = 0;
  for (const e of ref.estimates) {
    const m = find(out, e);
    assert.ok(m, `missing ${e.lval} ${e.op} ${e.rval}`);
    dEst = Math.max(dEst, Math.abs(m!.est - e.est));
    if (e.se != null) { assert.ok(m!.free); dSe = Math.max(dSe, Math.abs((m!.se ?? NaN) - e.se)); } else assert.equal(m!.free, false);
  }
  assert.ok(dEst < 1e-4, `${name}: max |Δestimate| = ${dEst}`);
  assert.ok(dSe < 1e-4, `${name}: max |ΔSE| = ${dSe}`);
  const f = out.fit, rf = ref.fit;
  assert.equal(f.df, rf.df); assert.equal(f.npar, rf.npar); assert.equal(f.n, rf.n);
  assert.ok(Math.abs(f.chisq - rf.chisq) < 1e-3, `${name}: χ² ${f.chisq} vs ${rf.chisq}`);
  for (const k of ["cfi", "tli", "rmsea", "srmr"] as const) assert.ok(Math.abs((f[k] ?? NaN) - rf[k]) < 1e-4, `${name}: ${k} ${f[k]} vs ${rf[k]}`);
  for (const k of ["aic", "bic", "logLik", "baselineChisq"] as const) assert.ok(Math.abs(f[k] - rf[k]) < 0.01, `${name}: ${k} ${f[k]} vs ${rf[k]}`);
  return { out, dEst, dSe };
}

test("Holzinger–Swineford 3-factor CFA matches semopy and lavaan's published output", () => {
  const { out, dEst, dSe } = compare("hs");
  const pub = FX.hs.lavaanPublished as { chisq: number; cfi: number; tli: number; rmsea: number; rmseaLow: number; rmseaHigh: number; srmr: number; aic: number; bic: number; loadings: Record<string, [number, number]> };
  const f = out.fit;
  assert.equal(Math.round(f.chisq * 1000) / 1000, pub.chisq);
  assert.equal(Math.round(f.cfi! * 1000) / 1000, pub.cfi); assert.equal(Math.round(f.tli! * 1000) / 1000, pub.tli);
  assert.equal(Math.round(f.rmsea! * 1000) / 1000, pub.rmsea); assert.equal(Math.round(f.srmr * 1000) / 1000, pub.srmr);
  assert.equal(Math.round(f.rmseaLow! * 1000) / 1000, pub.rmseaLow, "RMSEA 90% CI low (noncentral χ²)"); assert.equal(Math.round(f.rmseaHigh! * 1000) / 1000, pub.rmseaHigh);
  assert.ok(Math.abs(f.aic - pub.aic) < 0.001 && Math.abs(f.bic - pub.bic) < 0.001);
  for (const [x, [est, se]] of Object.entries(pub.loadings)) {
    const l = out.estimates.find((e) => e.op === "=~" && e.rhs === x)!;
    assert.ok(Math.abs(l.est - est) <= 0.0006 && Math.abs(l.se! - se) <= 0.0006, `${x}: ${l.est} (${l.se}) vs lavaan ${est} (${se})`);
  }
  // markers fixed to 1, standardised loadings within (0, 1)
  assert.deepEqual(out.estimates.filter((e) => e.op === "=~" && !e.free).map((e) => [e.rhs, e.est]), [["x1", 1], ["x4", 1], ["x7", 1]]);
  for (const e of out.estimates.filter((e) => e.op === "=~")) assert.ok(e.std! > 0 && e.std! < 1);
  console.log(`  SEM HS vs semopy: max |Δest| ${dEst.toExponential(1)}, max |ΔSE| ${dSe.toExponential(1)}; χ²(${f.df}) = ${f.chisq.toFixed(3)}, CFI ${f.cfi!.toFixed(3)}, RMSEA ${f.rmsea!.toFixed(3)} [${f.rmseaLow!.toFixed(3)}, ${f.rmseaHigh!.toFixed(3)}], SRMR ${f.srmr.toFixed(3)}`);
});

test("Political Democracy (structural paths + residual covariances) matches semopy; std. residual covariances follow lavaan (residual correlations)", () => {
  const { out } = compare("poldem");
  assert.equal(Math.round(out.fit.chisq * 1000) / 1000, (FX.poldem.lavaanPublished as { chisq: number }).chisq);
  // lavaan's std.all for y1 ~~ y5 is the residual correlation (0.296), semopy divides by total variances
  const cov = out.estimates.find((e) => e.op === "~~" && ((e.lhs === "y1" && e.rhs === "y5") || (e.lhs === "y5" && e.rhs === "y1")))!;
  const v1 = out.estimates.find((e) => e.op === "~~" && e.lhs === "y1" && e.rhs === "y1")!, v5 = out.estimates.find((e) => e.op === "~~" && e.lhs === "y5" && e.rhs === "y5")!;
  assert.ok(Math.abs(cov.std! - cov.est / Math.sqrt(v1.est * v5.est)) < 1e-12);
  assert.equal(Math.round(cov.std! * 1000) / 1000, 0.296);
  // non-residual standardised estimates agree with semopy
  for (const e of FX.poldem.estimates.filter((x) => x.op !== "~~" || x.lval === x.rval)) assert.ok(Math.abs(find(out, e)!.std! - e.std) < 1e-4, `${e.lval} ${e.op} ${e.rval}`);
  assert.ok(out.defined.some((d) => d.automatic && d.name === "ind60 → dem60 → dem65"), "automatic indirect effect");
});

test("simulated mediation: estimates match semopy, the planted paths are recovered, and the indirect effect a·b has a delta-method SE", () => {
  const { out } = compare("mediation");
  const t = FX.mediation.truth!;
  const path = (l: string, r: string) => out.estimates.find((e) => e.op === "~" && e.lhs === l && e.rhs === r)!;
  assert.ok(Math.abs(path("M", "X").est - t.a) < 0.1 && Math.abs(path("Y", "M").est - t.b) < 0.1 && Math.abs(path("Y", "X").est - t.c) < 0.1);
  const ind = out.defined.find((d) => d.name === "ind")!;
  assert.ok(Math.abs(ind.est - FX.mediation.indirect!.est) < 1e-6);
  // full delta method (with the a–b covariance) vs Sobel (without): close in a recursive model
  assert.ok(Math.abs(ind.se! - FX.mediation.indirect!.sobelSe) / FX.mediation.indirect!.sobelSe < 0.05, `delta ${ind.se} vs Sobel ${FX.mediation.indirect!.sobelSe}`);
  assert.ok(ind.p! < 0.001 && ind.ciLow! > 0);
  assert.equal(out.defined.find((d) => d.automatic)!.est, ind.est, "the automatic X → M → Y effect is the same product");
});

test("identification is checked before fitting: scale, t-rule, one- and two-indicator factors, labels, syntax", () => {
  const avail = (n: string) => !/^[A-Z]$/.test(n);   // lower-case names are data columns, single capitals are factors
  const no = (syntax: string, re: RegExp) => { const b = checkSemSyntax(syntax, { available: avail }); assert.equal(b.model, null, syntax); assert.ok(b.errors.some((e) => re.test(e)), `${syntax}: ${b.errors}`); };
  no("F =~ NA*a + b + c", /no scale/);
  no("F =~ a + b\nF ~~ c", /only two indicators/);
  no("F =~ a\nG =~ b + c + d", /single indicator/);
  no("F =~ a + b + c\na ~~ b\na ~~ c\nb ~~ c", /t-rule/);
  no("F =~ a + b + c\nG =~ d + e + f\nind := q*r", /labels? no parameter/);
  no("y ~ 1 + x", /intercepts/);
  no("F =~ a + b + c\nu | t1", /thresholds/);
  no("F <~ a + b", /formative/);
  no("a == b", /constraints/);
  no("F =~ a + a2", /two indicators/);
  // a variable that is not in the data, and a factor named like a variable
  assert.ok(checkSemSyntax("F =~ a + b + zz", { available: (n) => n !== "zz" }).errors.some((e) => /zz is not a variable/.test(e)));
  assert.ok(checkSemSyntax("a =~ b + c + d", { available: () => true }).errors.some((e) => /also is a dataset variable/.test(e)));
  // unit-variance scaling identifies the NA* model
  assert.ok(checkSemSyntax("F =~ NA*a + b + c", { scaling: "unit_variance", available: avail }).model);
  // two correlated two-indicator factors are identified (warned)
  const two = checkSemSyntax("F =~ a + b\nG =~ c + d", { available: avail });
  assert.ok(two.model && two.warnings.some((w) => /only two indicators/.test(w)));
  const p = parseSemSyntax("# comment\nF =~ 1*a + l2*b + c ; G =~ d + e + f\nG ~ F");
  assert.equal(p.errors.length, 0); assert.equal(p.statements.length, 7);
  assert.equal(evalExpr("a*b + (c - 1)/2", { a: 2, b: 3, c: 5 }), 8);
});

function mvn(rng: Rng, R: number[][], n: number): number[][] {
  const p = R.length; const L = R.map(() => new Array(p).fill(0));
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) { let s = R[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]; L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j]; }
  return Array.from({ length: n }, () => { const z = R.map(() => rng.normal()); return L.map((row) => row.reduce((t, v, k) => t + v * z[k], 0)); });
}

test("a Heywood case (negative residual variance) returns NO estimates and NO fit indices", () => {
  // r12 = r13 = .8, r23 = .5 → λ1² = .8·.8/.5 = 1.28 > 1 for a one-factor model
  const X = mvn(new Rng(7), [[1, 0.8, 0.8], [0.8, 1, 0.5], [0.8, 0.5, 1]], 800);
  const r = fitSem({ syntax: "F =~ a + b + c", data: { a: X.map((x) => x[0]), b: X.map((x) => x[1]), c: X.map((x) => x[2]) } });
  assert.equal(r.status, "failed");
  assert.equal(r.output, null);
  assert.equal(r.error!.code, "improper_solution");
  assert.ok(r.diagnostics.some((d) => d.code === "heywood" && /Residual variance of a is negative/.test(d.message)), JSON.stringify(r.diagnostics));
});

test("non-convergence and a singular covariance matrix are failures, not results", () => {
  const ref = FX.hs;
  const r = fitSem({ syntax: ref.syntax, data: ref.data }, { maxIter: 1 });
  assert.equal(r.status, "failed"); assert.equal(r.error!.code, "not_converged"); assert.equal(r.output, null);
  const x = ref.data.x1;
  const s = fitSem({ syntax: "y ~ x1 + x1b", data: { y: ref.data.x2, x1: x, x1b: x.map((v) => 2 * v) } });
  assert.equal(s.status, "refused"); assert.equal(s.error!.code, "singular_covariance");
  // listwise deletion is stated
  const holes = Object.fromEntries(Object.entries(ref.data).map(([k, v]) => [k, v.map((y, i) => (k === "x1" && i % 30 === 0 ? null : y))]));
  const l = fitSem({ syntax: ref.syntax, data: holes });
  assert.equal(l.output!.nUsed, 301 - 11);
  assert.ok(l.diagnostics.some((d) => d.code === "listwise"));
});

test("noncentral χ² CDF reduces to the central one and is monotone in λ", () => {
  for (const [x, df] of [[10, 5], [30, 24], [85.3, 24]]) assert.ok(Math.abs(noncentralChiSquareCdf(x, df, 0) - chiSquareCdf(x, df)) < 1e-12);
  assert.ok(noncentralChiSquareCdf(30, 24, 5) < noncentralChiSquareCdf(30, 24, 1));
  // mean of χ'²(df, λ) = df + λ: the CDF at the mean is near 0.5
  const c = noncentralChiSquareCdf(24 + 40, 24, 40); assert.ok(c > 0.45 && c < 0.6, String(c));
});

test("the SEM runner: fit table, loadings, paths, indirect effects and a path diagram; a non-identified model is refused", () => {
  const { ds } = advancedDataset({ n: 300 });
  const def: AnalysisDefinition = { name: "Mediation", kind: "sem", dataset: advSpec, variables: [], options: { syntax: "X =~ X1 + X2 + X3\nM =~ M1 + M2 + M3\nY =~ Y1 + Y2 + Y3\nM ~ a*X\nY ~ c*X + b*M\nind := a*b" } };
  const r = runAnalysis(def, ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  for (const id of ["sem_fit", "sem_measurement", "sem_structural", "sem_variances", "sem_indirect", "sem_r2"]) assert.ok(r.tables.some((t) => t.id === id), id);
  const fit = r.tables.find((t) => t.id === "sem_fit")!;
  assert.ok(fit.rows.some((x) => x.m === "CFI") && fit.rows.some((x) => String(x.m).startsWith("RMSEA")));
  assert.equal(r.chart.nodes?.filter((n) => n.group === "latent").length, 3);
  assert.equal(r.chart.links?.length, 9 + 3);
  assert.deepEqual(r.variablesUsed, ["X1", "X2", "X3", "M1", "M2", "M3", "Y1", "Y2", "Y3"]);
  const ind = r.tables.find((t) => t.id === "sem_indirect")!.rows.find((x) => x.name === "ind")!;
  assert.ok(Math.abs((ind.est as number) - 0.2) < 0.1, `indirect ${ind.est} (planted 0.5 × 0.4 on the latent scale)`);
  const bad = runAnalysis({ ...def, options: { syntax: "F =~ X1 + X2" } }, ds);
  assert.ok(bad.error && /two indicators/.test(bad.error.message), JSON.stringify(bad.error));
  assert.equal(bad.tables.length, 0);
  // the HS data through a survey dataset gives the same χ² as the direct fit
  const hs = numericSurvey(FX.hs.data);
  const viaDs = runAnalysis({ name: "HS", kind: "sem", dataset: advSpec, variables: [], options: { syntax: FX.hs.syntax } }, hs.ds);
  assert.equal(viaDs.tables.find((t) => t.id === "sem_fit")!.rows.find((x) => x.m === "χ²")!.v, Math.round(FX.hs.fit.chisq * 1000) / 1000);
});
