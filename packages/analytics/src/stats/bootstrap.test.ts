import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapIndirect, indirectFromSums, phi, phiInv, quantile7 } from "./bootstrap.js";
import { mediation, ols } from "./regression.js";
import { Rng } from "../models/rng.js";
import { numericSurvey } from "../models/fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { findingsFor } from "../findings.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * The bootstrap of an indirect effect against scripts/stats-reference/bootstrap_reference.py: the same
 * respondents resampled (the generator re-implemented in Python), each replicate refitted with numpy least
 * squares, the BCa interval from scipy's normal — every quantity within 1e-9. scipy.stats.bootstrap's own
 * BCa interval (another random stream, 9,999 resamples) within Monte-Carlo error.
 */
type Ref = { seed: number; draws: number; level: number; n: number; data: { x: number[]; m: number[]; y: number[] }; a: number; b: number; indirect: number; se: number; bias: number; percentile: [number, number]; bca: [number, number]; z0: number; acceleration: number; first_replicates: number[]; scipy_bca_9999: [number, number] };
const REF = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "stats-reference", "fixtures", "bootstrap.json"), "utf8")) as Ref;

test("the normal CDF and its inverse are precise to ~1e-15 (the BCa levels are read through them)", () => {
  assert.ok(Math.abs(phi(1.96) - 0.9750021048517795) < 1e-15);
  assert.ok(Math.abs(phi(-5) - 2.866515718791939e-7) < 1e-20);
  assert.ok(Math.abs(phiInv(0.975) - 1.959963984540054) < 1e-12);
  for (const p of [1e-10, 0.001, 0.025, 0.3, 0.5, 0.77, 0.999]) assert.ok(Math.abs(phi(phiInv(p)) - p) < 1e-14 * Math.max(1, p / 1e-3), `round trip at ${p}`);
  assert.equal(quantile7(Float64Array.from([1, 2, 3, 4]), 0.5), 2.5);
  assert.equal(quantile7(Float64Array.from([1, 2, 3, 4]), 0.025), 1.075);
});

test("a, b and a·b from sufficient statistics equal the two least-squares fits (and Baron–Kenny's)", () => {
  const { x, m, y } = REF.data;
  const s = { n: 0, x: 0, m: 0, y: 0, xx: 0, mm: 0, xm: 0, xy: 0, my: 0 };
  x.forEach((xi, i) => { s.n++; s.x += xi; s.m += m[i]; s.y += y[i]; s.xx += xi * xi; s.mm += m[i] * m[i]; s.xm += xi * m[i]; s.xy += xi * y[i]; s.my += m[i] * y[i]; });
  const r = indirectFromSums(s)!;
  const fa = ols(m, { predictors: [{ name: "X", values: x }] }), fb = ols(y, { predictors: [{ name: "X", values: x }, { name: "M", values: m }] });
  assert.ok(!("error" in fa) && !("error" in fb));
  if ("error" in fa || "error" in fb) return;
  assert.ok(Math.abs(r.a - fa.coefficients[1].estimate) < 1e-10 && Math.abs(r.b - fb.coefficients[2].estimate) < 1e-10);
  const bk = mediation(x, m, y);
  assert.ok(!("error" in bk) && Math.abs(r.ab - bk.indirect) < 1e-10);
  assert.ok(Math.abs(r.a - REF.a) < 1e-10 && Math.abs(r.b - REF.b) < 1e-10, "numpy's a and b");
});

test("percentile and BCa intervals equal the Python reference (same resamples, numpy refits, scipy normal) within 1e-9", () => {
  const r = bootstrapIndirect(REF.data.x, REF.data.m, REF.data.y, { draws: REF.draws, seed: REF.seed, level: REF.level });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  close(r.indirect, REF.indirect, "estimate"); close(r.se, REF.se, "SE"); close(r.bias, REF.bias, "bias");
  close(r.percentile.low, REF.percentile[0], "percentile low"); close(r.percentile.high, REF.percentile[1], "percentile high");
  close(r.bca.low, REF.bca[0], "BCa low"); close(r.bca.high, REF.bca[1], "BCa high");
  close(r.bca.z0, REF.z0, "z0"); close(r.bca.acceleration, REF.acceleration, "acceleration");
  assert.equal(r.n, REF.n); assert.equal(r.failed, 0);
  assert.deepEqual(r.excludesZero, { percentile: true, bca: true });
  /* scipy's own BCa (another stream, 9,999 resamples): Monte-Carlo agreement */
  assert.ok(Math.abs(r.bca.low - REF.scipy_bca_9999[0]) < 0.01 && Math.abs(r.bca.high - REF.scipy_bca_9999[1]) < 0.01, `scipy ${REF.scipy_bca_9999}`);
});

test("seeded: the same seed gives the same interval, another seed another; the bootstrap SE sits near the Sobel SE", () => {
  const a = bootstrapIndirect(REF.data.x, REF.data.m, REF.data.y, { draws: 1000, seed: 3 });
  const b = bootstrapIndirect(REF.data.x, REF.data.m, REF.data.y, { draws: 1000, seed: 3 });
  const c = bootstrapIndirect(REF.data.x, REF.data.m, REF.data.y, { draws: 1000, seed: 4 });
  assert.ok(!("error" in a) && !("error" in b) && !("error" in c));
  if ("error" in a || "error" in b || "error" in c) return;
  assert.deepEqual(a, b);
  assert.notEqual(a.bca.low, c.bca.low);
  const bk = mediation(REF.data.x, REF.data.m, REF.data.y);
  if ("error" in bk) throw new Error(bk.error);
  const sobel = Math.abs(bk.indirect / (bk.sobelZ ?? 1));
  assert.ok(Math.abs(a.se - sobel) / sobel < 0.15, `boot SE ${a.se} vs Sobel ${sobel}`);
});

test("no indirect path: the interval includes zero; degenerate data is refused in words", () => {
  const rng = new Rng(11);
  const x = Array.from({ length: 400 }, () => rng.normal());
  const m = x.map(() => rng.normal());           // M unrelated to X: a ≈ 0
  const y = m.map((mi) => 0.5 * mi + rng.normal());
  const r = bootstrapIndirect(x, m, y, { draws: 1000, seed: 1 });
  assert.ok(!("error" in r) && !r.excludesZero.bca && !r.excludesZero.percentile);
  const flat = bootstrapIndirect(x.map(() => 1), m, y);
  assert.ok("error" in flat && /no variance|collinear/.test(flat.error));
  const few = bootstrapIndirect([1, 2, 3], [1, 2, 3], [3, 2, 1]);
  assert.ok("error" in few && /at least 10 complete cases/.test(few.error));
});

test("the mediation analysis with options.bootstrap: its own table, the BCa reading in the finding; without it, exactly as before", () => {
  const { ds } = numericSurvey({ X: REF.data.x, M: REF.data.m, Y: REF.data.y });
  const base: AnalysisDefinition = { name: "Trust mediation", kind: "regression", dataset: ds.spec, variables: ["Y", "X", "M"], options: { model: "mediation" } };
  const plain = runAnalysis(base, ds);
  assert.ok(!plain.tables.some((t) => t.id === "mediation_bootstrap"));
  const def = { ...base, options: { ...base.options, bootstrap: 2000, seed: 7 } };
  const r = runAnalysis(def, ds);
  const t = r.tables.find((x) => x.id === "mediation_bootstrap");
  assert.ok(t, "bootstrap table");
  assert.equal(t!.rows.find((x) => x.stat === "95% BCa CI")?.value, `[${REF.bca[0].toFixed(3)}, ${REF.bca[1].toFixed(3)}]`);
  assert.deepEqual(r.tables.map((x) => x.id).slice(0, plain.tables.length), plain.tables.map((x) => x.id), "the earlier tables keep their order");
  const f = findingsFor(def, r).find((x) => x.kind === "mediation");
  assert.ok(f && f.significant && f.evidence.test === "bootstrap_indirect" && /excludes zero/.test(f.headline), f?.headline);
});
