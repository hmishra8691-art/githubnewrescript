import { test } from "node:test";
import assert from "node:assert/strict";
import { latentClassChoice } from "./lcMnl.js";
import { Rng } from "./rng.js";
import type { ChoiceSet } from "../stats/choice.js";

/*
 * The latent-class choice model checked by SIMULATION: two segments that choose differently (one buys on price, one
 * on quality), 60% / 40%, choices drawn from their logit models. BIC must prefer two classes, the shares and both
 * segments' part-worths must be recovered, and respondents must be assigned to their true segment.
 */
const TRUE = [[-1.6, 0.3, 0.8, 0.0], [-0.2, 1.5, -0.4, 0.6]];
function simulate(n: number, tasks: number, seed: number) {
  const rng = new Rng(seed);
  const resp: ChoiceSet[][] = [], cls: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = rng.next() < 0.6 ? 0 : 1; cls.push(c);
    const sets: ChoiceSet[] = [];
    for (let t = 0; t < tasks; t++) {
      const alts = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => rng.normal()));
      const u = alts.map((x) => x.reduce((a, v, j) => a + v * TRUE[c][j], 0) - Math.log(-Math.log(rng.open())));
      sets.push({ alternatives: alts, chosen: u.indexOf(Math.max(...u)) });
    }
    resp.push(sets);
  }
  return { resp, cls };
}

test("LC-MNL: BIC picks the two true segments; shares, part-worths and memberships recovered", { timeout: 120_000 }, () => {
  const { resp, cls } = simulate(400, 12, 5);
  const r = latentClassChoice(resp, 4, { minClasses: 1, maxClasses: 3, starts: 4, seed: 2 });
  assert.ok(!("error" in r), "error" in r ? r.error : ""); if ("error" in r) return;
  assert.equal(r.recommended, 2, r.recommendation);
  const f = r.fits.find((x) => x.k === 2)!;
  assert.ok(Math.abs(f.shares[0] - 0.6) < 0.08, `shares ${f.shares}`);
  /* class 0 (largest) is the price-sensitive segment */
  for (let k = 0; k < 2; k++) for (let j = 0; j < 4; j++) assert.ok(Math.abs(f.betas[k][j] - TRUE[k][j]) < 3 * f.se[k][j] + 0.15, `class ${k} β${j}: ${f.betas[k][j].toFixed(2)} ± ${f.se[k][j].toFixed(2)} vs ${TRUE[k][j]}`);
  const agree = f.modal.filter((m, i) => m === cls[i]).length / cls.length;
  assert.ok(agree > 0.85, `assigned to the true segment: ${(agree * 100).toFixed(1)}%`);
  assert.ok(f.entropy! > 0.6);
  const one = r.fits.find((x) => x.k === 1)!;
  assert.ok(one.bic > f.bic, "one aggregate segment fits worse");
});

test("LC-MNL refuses too little data, in words", () => {
  const { resp } = simulate(30, 5, 1);
  const r = latentClassChoice(resp, 4, { maxClasses: 2 });
  assert.ok("error" in r && /at least 50/.test(r.error));
  const { resp: r2 } = simulate(60, 1, 1);
  const t = latentClassChoice(r2, 4, { maxClasses: 4 });
  assert.ok("error" in t && /too few for 4 classes/.test(t.error));
});
