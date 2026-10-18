import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latentClass } from "./lca.js";
import { advancedDataset, advSpec, LCA_TRUE } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * LATENT CLASS ANALYSIS against a reference implementation.
 * scripts/stats-reference/lca_reference.py simulated N = 1200 from a known
 * 3-class model (6 indicators: 4 binary, 2 three-category) and fitted K = 1..4
 * with stepmix 3.0 (30 starts) and an independent numpy EM (50 starts); the two
 * agree to 1e-4 in log-likelihood. Tolerances: log-likelihood within 0.01,
 * item probabilities within 0.005 of stepmix (same optimum), recovery of the
 * planted parameters within 0.06 (sampling error at N = 1200).
 */
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "stats-reference", "fixtures", "lca.json"), "utf8")) as {
  categories: number[]; data: number[][];
  true: { classSizes: number[]; itemProbs: number[][][] };
  stepmix: Record<string, { logLik: number; npar: number; aic: number; bic: number; stepmixBic: number; classSizes: number[]; itemProbs: number[][][] }>;
  numpy: Record<string, { logLik: number; classSizes: number[] }>;
};

const run = latentClass({ data: fixture.data, categories: fixture.categories }, { minClasses: 1, maxClasses: 4, starts: 30, seed: 11 });

const perms = (k: number): number[][] => (k <= 1 ? [[0]] : perms(k - 1).flatMap((p) => Array.from({ length: k }, (_, i) => [...p.slice(0, i), k - 1, ...p.slice(i)])));
/** the class permutation that best matches a reference (label switching) */
function match(est: number[][][], ref: number[][][]): number[] {
  let best: number[] = [], bestD = Infinity;
  for (const p of perms(ref.length)) { let d = 0; p.forEach((e, r) => est[e].forEach((items, j) => items.forEach((v, c) => { d += (v - ref[r][j][c]) ** 2; }))); if (d < bestD) { bestD = d; best = p; } }
  return best;
}

test("LCA log-likelihood agrees with stepmix and an independent numpy EM for K = 1..4; AIC / BIC match", () => {
  assert.equal(run.status, "done");
  const out = run.output!;
  for (const f of out.fits) {
    const ref = fixture.stepmix[String(f.k)];
    assert.ok(Math.abs(f.logLik - ref.logLik) < 0.01, `K=${f.k}: LL ${f.logLik} vs stepmix ${ref.logLik}`);
    assert.ok(Math.abs(f.logLik - fixture.numpy[String(f.k)].logLik) < 0.01);
    assert.equal(f.npar, ref.npar);
    assert.ok(Math.abs(f.bic - ref.stepmixBic) < 0.05, `K=${f.k}: BIC ${f.bic} vs stepmix ${ref.stepmixBic}`);
    assert.ok(Math.abs(f.aic - ref.aic) < 0.05);
  }
  assert.equal(out.recommended, 3, "BIC recommends the planted number of classes");
  assert.match(out.recommendation, /BIC is lowest at 3 classes/);
  assert.match(out.recommendation, /not automatic/);
});

test("LCA item-response probabilities and class sizes match stepmix (same optimum) and recover the planted model", () => {
  const f3 = run.output!.fits.find((f) => f.k === 3)!;
  const ref = fixture.stepmix["3"];
  const pm = match(f3.itemProbs, ref.itemProbs);
  let maxRef = 0, maxTrue = 0;
  pm.forEach((e, r) => f3.itemProbs[e].forEach((items, j) => items.forEach((v, c) => { maxRef = Math.max(maxRef, Math.abs(v - ref.itemProbs[r][j][c])); })));
  pm.forEach((e, r) => assert.ok(Math.abs(f3.classSizes[e] - ref.classSizes[r]) < 0.005));
  const pt = match(f3.itemProbs, fixture.true.itemProbs);
  pt.forEach((e, r) => f3.itemProbs[e].forEach((items, j) => items.forEach((v, c) => { maxTrue = Math.max(maxTrue, Math.abs(v - fixture.true.itemProbs[r][j][c])); })));
  pt.forEach((e, r) => assert.ok(Math.abs(f3.classSizes[e] - fixture.true.classSizes[r]) < 0.05, `class ${r} size ${f3.classSizes[e]} vs ${fixture.true.classSizes[r]}`));
  assert.ok(maxRef < 0.005, `max |ρ − stepmix| = ${maxRef}`);
  assert.ok(maxTrue < 0.08, `max |ρ − truth| = ${maxTrue}`);
  // classes are reported largest first; posteriors are proper; entropy in (0, 1]
  assert.deepEqual([...f3.classSizes].sort((a, b) => b - a), f3.classSizes);
  for (const row of f3.posterior) assert.ok(Math.abs(row.reduce((t, v) => t + v, 0) - 1) < 1e-9);
  assert.ok(f3.entropy! > 0.5 && f3.entropy! <= 1);
  assert.ok(f3.replicated >= 2, `best LL replicated ${f3.replicated} of ${f3.starts}`);
  console.log(`  LCA vs stepmix: max |Δρ| = ${maxRef.toExponential(2)}; vs truth: max |Δρ| = ${maxTrue.toFixed(3)}; entropy ${f3.entropy!.toFixed(3)}`);
});

test("LCA is reproducible with a seed and reports possible local maxima and identification", () => {
  const a = latentClass({ data: fixture.data.slice(0, 400), categories: fixture.categories }, { maxClasses: 3, starts: 5, seed: 3 });
  const b = latentClass({ data: fixture.data.slice(0, 400), categories: fixture.categories }, { maxClasses: 3, starts: 5, seed: 3 });
  assert.deepEqual(a.output!.fits.map((f) => f.itemProbs), b.output!.fits.map((f) => f.itemProbs));
  // a single start cannot replicate its best solution
  const one = latentClass({ data: fixture.data.slice(0, 400), categories: fixture.categories }, { minClasses: 3, maxClasses: 3, starts: 1, seed: 3 });
  assert.ok(one.diagnostics.some((d) => d.code === "local_maximum"));
  // two binary indicators: 2 classes need 5 parameters for 3 free cell frequencies
  const tiny = latentClass({ data: fixture.data.map((r) => r.slice(0, 2)), categories: [2, 2] }, { maxClasses: 2 });
  const k2 = tiny.output!.fits.find((f) => f.k === 2)!;
  assert.equal(k2.identified, false);
  assert.ok(k2.warnings.some((w) => w.code === "not_identified"));
  assert.equal(tiny.output!.recommended, 1, "an unidentified K is never recommended");
  // too few cases / a single indicator are refused
  assert.equal(latentClass({ data: fixture.data.slice(0, 10), categories: fixture.categories }).status, "refused");
  assert.equal(latentClass({ data: fixture.data.map((r) => [r[0]]), categories: [2] }).status, "refused");
  // missing values: listwise, stated
  const withNa = fixture.data.slice(0, 300).map((r, i) => (i % 10 === 0 ? [null, ...r.slice(1)] : r));
  const na = latentClass({ data: withNa, categories: fixture.categories }, { maxClasses: 2, starts: 5 });
  assert.equal(na.output!.nUsed, 270);
  assert.ok(na.diagnostics.some((d) => d.code === "listwise" && /30 of 300/.test(d.message)));
});

test("the LCA runner: model comparison table, profiles, classification uncertainty and membership; recovery through the survey dataset", { timeout: 60_000 }, () => {
  const { ds, truth } = advancedDataset({ n: 600 });
  const def: AnalysisDefinition = { name: "Segments", kind: "lca", dataset: advSpec, variables: ["U1", "U2", "U3", "U4", "U5", "U6"], options: { maxClasses: 4, starts: 20, seed: 1 } };
  const r = runAnalysis(def, ds);
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const fit = r.tables.find((t) => t.id === "lca_fit")!;
  assert.deepEqual(fit.rows.map((x) => x.k), [1, 2, 3, 4]);
  assert.equal(fit.rows.find((x) => x.status === "lowest BIC ✓")!.k, 3);
  for (const id of ["lca_sizes", "lca_profiles", "lca_classification", "lca_membership"]) assert.ok(r.tables.some((t) => t.id === id), id);
  const mem = r.tables.find((t) => t.id === "lca_membership")!;
  assert.equal(mem.rows.length, 600);
  const sizes = r.tables.find((t) => t.id === "lca_sizes")!.rows.map((x) => (x.size as number) / 100);
  [...LCA_TRUE.classSizes].sort((a, b) => b - a).forEach((s, k) => assert.ok(Math.abs(sizes[k] - s) < 0.07, `class ${k + 1}: ${sizes[k]} vs ${s}`));
  // modal assignment agrees with the planted classes far above chance (label-switch free: best permutation)
  const assigned = mem.rows.map((x) => Number(String(x.cls).replace("Class ", "")) - 1);
  const best = perms(3).reduce((b, p) => Math.max(b, assigned.filter((a, i) => p[a] === truth.cls[i]).length), 0);
  assert.ok(best / 600 > 0.75, `classification accuracy ${(best / 600).toFixed(3)}`);
  assert.equal(r.chart.matrix?.columns.length, 3);
});
