import { describe as suite, it } from "node:test";
import assert from "node:assert/strict";
import { describe as summarise, quantile, effectiveN, weightedValues } from "./descriptive.js";
import { npsOf } from "../analyses/business.js";

/**
 * WEIGHTED INFERENCE.
 *
 * Four bugs shared one root cause: the package computed Kish's effective
 * sample size in exactly one file (crosstab.ts, for its significance letters)
 * and every other weighted denominator used the raw case count. A weighted
 * confidence interval was therefore too narrow — by 13% on ordinary rim
 * weights and by a factor of five on dispersed ones — always in the direction
 * that makes a null result look like a finding.
 *
 * These tests pin the arithmetic against values derived here from the
 * definitions rather than from the implementation, so they fail if someone
 * reintroduces a raw-count denominator. The unweighted cases are equally
 * important: they assert that the fix is a no-op when weights are absent.
 */

/** Kish's n_eff, written out longhand so the test does not depend on the code it checks. */
const kish = (w: number[]) => w.reduce((a, b) => a + b, 0) ** 2 / w.reduce((a, b) => a + b * b, 0);

suite("effective sample size", () => {
  it("equals the count when the weights are equal, at any scale", () => {
    assert.equal(effectiveN(weightedValues([1, 2, 3, 4, 5])), 5);
    assert.equal(effectiveN(weightedValues([1, 2, 3, 4, 5], [3, 3, 3, 3, 3])), 5);
  });

  it("falls as the weights spread out", () => {
    const n = effectiveN(weightedValues([1, 2, 3, 4, 5], [1, 1, 1, 1, 10]));
    assert.ok(Math.abs(n - kish([1, 1, 1, 1, 10])) < 1e-12);
    assert.ok(n > 1.88 && n < 1.89, `expected ≈1.885, got ${n}`);
  });
});

suite("describe(): weighted dispersion uses the effective base", () => {
  it("is unchanged on unweighted data", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, sample variance 32/7, sd 2.13808993…
    const d = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(d.mean, 5);
    assert.ok(Math.abs((d.variance ?? 0) - 32 / 7) < 1e-12);
    assert.ok(Math.abs((d.se ?? 0) - Math.sqrt(32 / 7) / Math.sqrt(8)) < 1e-12);
  });

  it("uniform weights of any size change nothing", () => {
    const plain = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
    const scaled = summarise([2, 4, 4, 4, 5, 5, 7, 9], Array(8).fill(7));
    assert.ok(Math.abs((plain.se ?? 0) - (scaled.se ?? 0)) < 1e-12);
    assert.ok(Math.abs((plain.variance ?? 0) - (scaled.variance ?? 0)) < 1e-12);
  });

  it("divides the standard error by the effective base, not the count", () => {
    const v = [1, 2, 3, 4, 5], w = [1, 1, 1, 1, 10];
    const d = summarise(v, w);
    const nEff = kish(w);
    assert.ok(Math.abs((d.se ?? 0) - Math.sqrt(d.variance ?? 0) / Math.sqrt(nEff)) < 1e-12);
    // the old code divided by sqrt(5); the effective base is ~1.885, so the
    // interval must be substantially WIDER than it used to be, never narrower
    const old = Math.sqrt(d.variance ?? 0) / Math.sqrt(v.length);
    assert.ok((d.se ?? 0) > old * 1.6, `se ${d.se} should be far above the raw-count ${old}`);
  });

  it("corrects the variance on the effective base too", () => {
    const v = [1, 2, 3, 4, 5], w = [1, 1, 1, 1, 10];
    const W = w.reduce((a, b) => a + b, 0);
    const mean = v.reduce((t, x, i) => t + x * w[i], 0) / W;
    const ss = v.reduce((t, x, i) => t + w[i] * (x - mean) ** 2, 0);
    const nEff = kish(w);
    const expected = ss / (W * (nEff - 1) / nEff);
    assert.ok(Math.abs((summarise(v, w).variance ?? 0) - expected) < 1e-12);
  });
});

suite("quantile(): type 7 for any weights", () => {
  it("matches type 7 exactly when unweighted", () => {
    const q = (p: number) => quantile(weightedValues([1, 2, 3, 4, 5]), p);
    assert.equal(q(0.5), 3);
    assert.ok(Math.abs((q(0.9) ?? 0) - 4.6) < 1e-12);
    assert.ok(Math.abs((q(0.25) ?? 0) - 2) < 1e-12);
    const even = weightedValues([1, 2, 3, 4]);
    assert.equal(quantile(even, 0.5), 2.5);
    assert.ok(Math.abs((quantile(even, 0.75) ?? 0) - 3.25) < 1e-12);
  });

  it("is scale invariant — doubling every weight is a no-op", () => {
    const v = [1, 2, 3, 4, 5];
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const a = quantile(weightedValues(v, [1, 1, 1, 1, 1]), p);
      const b = quantile(weightedValues(v, [2, 2, 2, 2, 2]), p);
      const c = quantile(weightedValues(v, [0.5, 0.5, 0.5, 0.5, 0.5]), p);
      assert.ok(Math.abs((a ?? 0) - (b ?? 0)) < 1e-12, `p${p}: ${a} vs ${b}`);
      assert.ok(Math.abs((a ?? 0) - (c ?? 0)) < 1e-12, `p${p}: ${a} vs ${c}`);
    }
  });

  it("is continuous as a weight crosses 1.0", () => {
    // the old exact `w === 1` guard made this jump from 4.6 to 5
    const a = quantile(weightedValues([1, 2, 3, 4, 5], [1, 1, 1, 1, 1]), 0.9) ?? 0;
    const b = quantile(weightedValues([1, 2, 3, 4, 5], [1, 1, 1, 1, 1.0001]), 0.9) ?? 0;
    assert.ok(Math.abs(a - b) < 1e-3, `${a} vs ${b} — estimator switched`);
  });

  it("still moves the median when a weight genuinely dominates", () => {
    const m = quantile(weightedValues([1, 2, 3, 4, 5], [1, 1, 1, 1, 20]), 0.5) ?? 0;
    assert.ok(m > 4, `a heavy last case should pull the median up, got ${m}`);
  });
});

suite("npsOf()", () => {
  it("does not count an unparseable score as a detractor", () => {
    const r = npsOf([10, 9, NaN, 8, 7]);
    assert.equal(r.n, 4, "NaN must not enter the base");
    assert.equal(r.detractors, 0, "NaN must not be scored −100");
    assert.equal(r.promoters, 50);
    assert.equal(r.mean, 8.5);
  });

  it("weights the interval it reports, not a different sample", () => {
    const v = [10, 10, 9, 8, 7, 6, 5, 4, 3, 2];
    const w = [1, 1, 1, 1, 1, 1, 1, 1, 1, 40];
    const r = npsOf(v, w);
    const unweighted = npsOf(v);
    const width = (r.ci as [number, number])[1] - (r.ci as [number, number])[0];
    const flat = (unweighted.ci as [number, number])[1] - (unweighted.ci as [number, number])[0];
    // Σw=49, Σw²=1609, so n_eff ≈ 1.49 against a raw count of 10: the interval
    // must widen substantially rather than stay put. It comes out ~2.5× wider;
    // the assertion is set below that so it pins the behaviour, not the digits.
    assert.ok(width > flat * 2, `weighted CI ${width} should dwarf the unweighted ${flat}`);
  });

  it("is unchanged when every weight is the same", () => {
    const v = [10, 9, 8, 7, 6, 5];
    const a = npsOf(v), b = npsOf(v, Array(6).fill(4));
    assert.equal(a.nps, b.nps);
    assert.ok(Math.abs((a.ci as number[])[0] - (b.ci as number[])[0]) < 1e-9);
  });
});
