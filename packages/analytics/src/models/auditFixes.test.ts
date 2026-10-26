import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRhat } from "./hb.js";
import { fitSem } from "./sem.js";
import { Rng } from "./rng.js";
import { advancedDataset, advSpec } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * Regression tests for findings S2 and S7 of the statistical-correctness
 * audit of 2026-10-26 (claude/audit-statistics-2026-10-26.md). Both fail
 * against the code as it stood before that audit.
 */

const study = advancedDataset({ n: 60 });
const D = (options: Record<string, unknown>): AnalysisDefinition =>
  ({ name: "hb", kind: "hb", dataset: advSpec, variables: ["CBC"], options: { timeBudgetMs: 600_000, ...options } });
const rowOf = (r: ReturnType<typeof runAnalysis>, m: string) => r.tables.find((t) => t.id === "hb_diagnostics")?.rows.find((x) => x.m === m)?.v;

/* ============================================================ S2 — HB convergence */

test("S2: splitRhat's failure modes are values, not holes", () => {
  // fewer than four draws in a chain: there is no split-R̂ to compute
  assert.ok(Number.isNaN(splitRhat([[1, 2], [3, 4]])));
  assert.ok(Number.isNaN(splitRhat([[1, 2, 3]])));
  // chains each constant at a DIFFERENT value — the worst non-convergence there is.
  // `.filter(Number.isFinite)` used to drop this, so it could never trip rhat_high.
  assert.equal(splitRhat([[1, 1, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5]]), Infinity);
  // chains agreeing on one constant value are fine
  assert.equal(splitRhat([[2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2]]), 1);
  // and a well-mixed pair is near 1
  const a = Array.from({ length: 200 }, (_, i) => Math.sin(i * 1.1));
  const b = Array.from({ length: 200 }, (_, i) => Math.sin(i * 1.1 + 0.4));
  const ok = splitRhat([a, b]);
  assert.ok(Number.isFinite(ok) && ok > 0.9 && ok < 1.3, `R̂ = ${ok}`);
});

test("S2: too few kept draws is a refusal, not a pass", () => {
  /*
   * thin 50 over 100 draws keeps 2 per chain. Every parameter then has sd 0,
   * takes the `constant` shortcut to R̂ = 1 and drops out of the varying set,
   * so the check passed vacuously: this exact run used to publish part-worths,
   * importances and simulated shares under "Converged — estimates below are
   * valid", with a largest R̂ of null and a credible interval of
   * [0.9646, 0.9646].
   */
  const thin = runAnalysis(D({ chains: 2, burnIn: 100, draws: 100, thin: 50, seed: 1 }), study.ds);
  assert.equal(rowOf(thin, "Draws used (all chains)"), 4);
  assert.equal(rowOf(thin, "Verdict"), "NOT converged — estimates are withheld");
  assert.ok(thin.warnings.some((w) => /R̂ could not be computed/.test(w)), JSON.stringify(thin.warnings));
  assert.ok(thin.warnings.some((w) => /not reported as valid/.test(w)));

  // the same run with no thinning keeps 100 per chain, and R̂ is a number again
  const full = runAnalysis(D({ chains: 2, burnIn: 100, draws: 100, thin: 1, seed: 1 }), study.ds);
  assert.equal(rowOf(full, "Draws used (all chains)"), 200);
  assert.equal(typeof rowOf(full, "Largest R̂ (population means)"), "number");
  assert.ok(!full.warnings.some((w) => /R̂ could not be computed/.test(w)), JSON.stringify(full.warnings));
});

/* ============================================================ S7 — SEM CFI */

test("S7: CFI is 1, not NaN, when the model fits at least as well as its df", () => {
  const rng = new Rng(1);
  const n = 100, v0: number[] = [], v1: number[] = [], v2: number[] = [];
  for (let i = 0; i < n; i++) { v0.push(rng.normal()); v1.push(rng.normal()); v2.push(rng.normal()); }
  const run = fitSem({ syntax: "v1 ~ v0\nv2 ~ v0", data: { v0, v1, v2 } });
  assert.equal(run.status, "done");
  const f = run.output!.fit;
  /*
   * The precondition: three independent variables, so both the model and the
   * baseline fit better than their degrees of freedom and both
   * non-centralities are at or below zero. The denominator max(χ²₀−df₀,
   * χ²−df, 0) is then exactly 0 — and the old guard tested the two χ²
   * STATISTICS rather than the two non-centralities, so 0/0 came through as
   * NaN. `Math.max(0, NaN)` is NaN, so the clip did not catch it either, and
   * the dashboard rendered `NaN ?? 0` as CFI 0, reading a model with p = .63
   * and SRMR = .020 as "below conventional cut-offs".
   */
  assert.ok(f.chisq - f.df <= 0, `model non-centrality ${f.chisq - f.df} should be ≤ 0`);
  assert.ok(f.baselineChisq - f.baselineDf <= 0, `baseline non-centrality ${f.baselineChisq - f.baselineDf} should be ≤ 0`);
  assert.equal(f.cfi, 1);
  assert.ok(f.pvalue! > 0.5 && f.srmr < 0.05, "and it really is a good fit");
});

test("S7: CFI stays a number across a sweep, and a real model is unchanged", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rng = new Rng(seed);
    const n = 100, v0: number[] = [], v1: number[] = [], v2: number[] = [];
    for (let i = 0; i < n; i++) { v0.push(rng.normal()); v1.push(rng.normal()); v2.push(rng.normal()); }
    const run = fitSem({ syntax: "v1 ~ v0\nv2 ~ v0", data: { v0, v1, v2 } });
    if (run.status !== "done" || !run.output) continue;
    const { cfi } = run.output.fit;
    assert.ok(cfi != null && Number.isFinite(cfi) && cfi >= 0 && cfi <= 1, `seed ${seed}: CFI = ${cfi}`);
  }
  // a model with a genuine misfit still gets a CFI below 1, so the fix is not a blanket 1
  const rng = new Rng(7);
  const n = 300, f: number[] = [];
  for (let i = 0; i < n; i++) f.push(rng.normal());
  const a = f.map((v) => v + 0.3 * rng.normal()), b = f.map((v) => v + 0.3 * rng.normal());
  const c = f.map(() => rng.normal()), d = f.map(() => rng.normal());
  const run = fitSem({ syntax: "F =~ a + b + c + d", data: { a, b, c, d } });
  if (run.status === "done" && run.output) {
    const { cfi, chisq, df } = run.output.fit;
    if (chisq - df > 0) assert.ok(cfi != null && cfi < 1, `a misfitting model should score below 1, got ${cfi} (χ² ${chisq}, df ${df})`);
  }
});

/* ============================================================ S15 — SEM runs a second start */

test("S15: a clean SEM model agrees with itself from a dispersed start", () => {
  /*
   * The damped retry inside `fitSem` runs only when the FIRST start fails to
   * converge, so a start that converged was published with no check at all
   * and a model sitting in a local optimum came out labelled converged with
   * fit indices attached. `lca.ts` has always run twenty random starts and
   * reported how many reached the best log-likelihood; SEM now runs one
   * dispersed start and keeps the better solution.
   *
   * The point of this test is that it must not cry wolf: a well-behaved
   * model has one optimum and the warning must stay silent.
   */
  const rng = new Rng(11);
  const n = 400, f: number[] = [];
  for (let i = 0; i < n; i++) f.push(rng.normal());
  const data = {
    a: f.map((v) => 0.9 * v + 0.4 * rng.normal()),
    b: f.map((v) => 0.8 * v + 0.4 * rng.normal()),
    c: f.map((v) => 0.85 * v + 0.4 * rng.normal()),
    d: f.map((v) => 0.75 * v + 0.4 * rng.normal()),
  };
  const run = fitSem({ syntax: "F =~ a + b + c + d", data });
  assert.equal(run.status, "done", JSON.stringify(run.diagnostics));
  assert.ok(!run.diagnostics.some((d) => d.code === "local_optimum"),
    `a single-optimum model must not be flagged: ${JSON.stringify(run.diagnostics)}`);
  // and the solution is the real one, not something a dispersed start wandered into
  assert.ok(run.output!.fit.chisq >= 0 && run.output!.fit.df === 2);
  for (const e of run.output!.estimates) if (e.se != null) assert.ok(Number.isFinite(e.se) && e.se >= 0);
});
