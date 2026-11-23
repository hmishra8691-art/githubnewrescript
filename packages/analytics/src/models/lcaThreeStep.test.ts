import { test } from "node:test";
import assert from "node:assert/strict";
import { latentClass } from "./lca.js";
import { Rng } from "./rng.js";
import { classificationErrors, bchWeights, bchDistal, mlThreeStep, modalCrosstab, oddsRatio, relativeEntropy } from "./lcaThreeStep.js";

/*
 * The three-step methods checked by SIMULATION: data generated from a known model — class membership depending on
 * a covariate with known logit coefficients, indicators with known response probabilities per class, a distal
 * outcome with known class means — then step 1 (latentClass) fitted, and steps 2–3 must recover the truth. The
 * naive assign-then-cross-tab is shown to understate the class difference when classes overlap, as the literature
 * says it does; BCH must remove that bias.
 */

function simulate(n: number, sep: number, seed: number) {
  const rng = new Rng(seed);
  const truth = { b0: -0.3, bAge: 0.9 };            // logit P(class B) = b0 + bAge·age (age standardised)
  const rhoA = [0.5 + sep / 2, 0.5 + sep / 2, 0.5 + sep / 2, 0.5 + sep / 2, 0.5 + sep / 2];   // P(yes | A)
  const rhoB = rhoA.map((p) => 1 - p);                                                          // P(yes | B)
  const age: number[] = [], cls: number[] = [], data: number[][] = [], spend: number[] = [], region: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.normal();
    const pB = 1 / (1 + Math.exp(-(truth.b0 + truth.bAge * a)));
    const c = rng.next() < pB ? 1 : 0;
    age.push(a); cls.push(c);
    data.push((c ? rhoB : rhoA).map((p) => (rng.next() < p ? 1 : 0)));
    spend.push((c ? 40 : 25) + 6 * rng.normal());                 // class means 25 (A) and 40 (B)
    region.push(rng.next() < (c ? 0.7 : 0.3) ? 1 : 0);            // P(north) 0.3 (A), 0.7 (B)
  }
  return { truth, age, cls, data, spend, region };
}

/** match the fitted classes to the true ones (the larger-by-size labelling is arbitrary relative to the truth) */
function fit(sim: ReturnType<typeof simulate>) {
  const run = latentClass({ data: sim.data, categories: [2, 2, 2, 2, 2] }, { minClasses: 2, maxClasses: 2, starts: 10, seed: 3 });
  const f = run.output!.fits[0];
  /* class 0 of the fit is A when its P(yes) on item 1 is high */
  const flip = f.itemProbs[0][0][1] < f.itemProbs[1][0][1];
  const post = flip ? f.posterior.map((p) => [p[1], p[0]]) : f.posterior;
  const modal = post.map((p) => (p[0] >= p[1] ? 0 : 1));
  return { post, modal, entropy: f.entropy! };
}

test("classification error: rows sum to 1; well-separated classes have a near-identity matrix and entropy near 1", () => {
  const s = fit(simulate(1500, 0.8, 11));
  const D = classificationErrors(s.post, s.modal, 2);
  for (const r of D) assert.ok(Math.abs(r[0] + r[1] - 1) < 1e-9);
  assert.ok(D[0][0] > 0.95 && D[1][1] > 0.95, JSON.stringify(D));
  assert.ok(s.entropy > 0.8);
  assert.ok(Math.abs(relativeEntropy(s.post)! - s.entropy) < 1e-9);
  const w = bchWeights(D, s.modal)!;
  assert.equal(w.length, s.post.length);
  assert.equal(bchWeights([[0.5, 0.5], [0.5, 0.5]], [0, 1]), null, "classes not separated at all: no correction possible");
});

test("ML three-step recovers the covariate's logit coefficient (within two standard errors), with odds ratios and a Wald test", () => {
  const sim = simulate(3000, 0.5, 7);
  const s = fit(sim);
  const r = mlThreeStep(s.post, s.modal, sim.age.map((a) => [1, a]));
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  if ("error" in r) return;
  assert.ok(r.converged);
  const b = r.coefficients[0][1], se = r.se[0][1];
  assert.ok(Math.abs(b - sim.truth.bAge) < 2 * se + 0.05, `b ${b.toFixed(3)} ± ${se.toFixed(3)} vs truth ${sim.truth.bAge}`);
  assert.ok(Math.abs(r.coefficients[0][0] - sim.truth.b0) < 2 * r.se[0][0] + 0.05, `intercept ${r.coefficients[0][0]}`);
  assert.ok(r.wald[0].p < 1e-6, "age clearly predicts the class");
  const or = oddsRatio(b, se);
  assert.ok(or.lower < Math.exp(sim.truth.bAge) && Math.exp(sim.truth.bAge) < or.upper * 1.1);
  /* a covariate that predicts nothing: its coefficient is near zero and not significant */
  const noise = new Rng(99); const r0 = mlThreeStep(s.post, s.modal, sim.age.map(() => [1, noise.normal()]));
  assert.ok(!("error" in r0) && r0.wald[0].p > 0.01, "pure noise is not found significant (at this seed)");
});

test("the naive ML on the assigned class is attenuated; the three-step is not", () => {
  const sim = simulate(3000, 0.4, 21);   // overlapping classes
  const s = fit(sim);
  assert.ok(s.entropy < 0.8, `entropy ${s.entropy}`);
  const three = mlThreeStep(s.post, s.modal, sim.age.map((a) => [1, a]));
  /* naive: D = identity (the assigned class taken as the truth) */
  const naive = mlThreeStep(s.modal.map((m) => (m === 0 ? [1, 0] : [0, 1])), s.modal, sim.age.map((a) => [1, a]));
  assert.ok(!("error" in three) && !("error" in naive));
  if ("error" in three || "error" in naive) return;
  assert.ok(Math.abs(naive.coefficients[0][1]) < Math.abs(three.coefficients[0][1]), `naive ${naive.coefficients[0][1]} vs three-step ${three.coefficients[0][1]}`);
  assert.ok(Math.abs(three.coefficients[0][1] - sim.truth.bAge) < Math.abs(naive.coefficients[0][1] - sim.truth.bAge), "the three-step is closer to the truth");
});

test("BCH distal outcomes: class means and proportions recovered; the cross-tab of the assigned class understates the difference", () => {
  const sim = simulate(3000, 0.4, 5);
  const s = fit(sim);
  const num = bchDistal(s.post, s.modal, { kind: "numeric", values: sim.spend }, { bootstrap: 100, seed: 2 });
  assert.ok(!("error" in num)); if ("error" in num) return;
  assert.ok(Math.abs(num.estimates[0][0] - 25) < 1.5 && Math.abs(num.estimates[1][0] - 40) < 1.5, JSON.stringify(num.estimates));
  assert.ok(num.lower[0][0] < num.estimates[0][0] && num.estimates[0][0] < num.upper[0][0]);
  assert.ok(num.test && num.test.p < 1e-6);
  const cat = { kind: "categorical" as const, values: sim.region, categories: [{ code: 0, label: "South" }, { code: 1, label: "North" }] };
  const bch = bchDistal(s.post, s.modal, cat, { bootstrap: 100, seed: 2 });
  assert.ok(!("error" in bch)); if ("error" in bch) return;
  assert.ok(Math.abs(bch.estimates[0][1] - 0.3) < 0.06 && Math.abs(bch.estimates[1][1] - 0.7) < 0.06, JSON.stringify(bch.estimates));
  const ct = modalCrosstab(s.post, s.modal, cat);
  const naiveGap = ct.percents[1][1] - ct.percents[0][1];
  const bchGap = (bch.estimates[1][1] - bch.estimates[0][1]) * 100;
  assert.ok(naiveGap < bchGap, `naive gap ${naiveGap.toFixed(1)} vs corrected ${bchGap.toFixed(1)} (truth 40)`);
  assert.equal(ct.status, s.entropy < 0.6 ? "refused" : s.entropy < 0.8 ? "caution" : "ok");
  assert.ok(ct.test && ct.test.p < 0.001);
});

test("assign-then-cross-tab is refused when classes are hardly separated; refusals carry the reason", () => {
  const sim = simulate(800, 0.3, 3);
  const s = fit(sim);
  const ct = modalCrosstab(s.post, s.modal, { kind: "categorical", values: sim.region, categories: [{ code: 0, label: "S" }, { code: 1, label: "N" }] });
  assert.equal(ct.status, "refused", `entropy ${ct.entropy}`);
  assert.match(ct.message, /three-step method/);
  const tooFew = mlThreeStep(s.post.slice(0, 20), s.modal.slice(0, 20), sim.age.slice(0, 20).map((a) => [1, a]));
  assert.ok("error" in tooFew && /five respondents per coefficient/.test(tooFew.error));
});
