import test from "node:test";
import assert from "node:assert/strict";
import { sampleSizeProportion, sampleSizeTwoProportions, sampleSizeTwoMeans, sampleSizeCorrelation, startsNeeded } from "./sampleSize.js";

/* reference values: the textbook ±5 % / 95 % = 385; Fleiss two proportions 0.5 vs 0.6 = 388 per group;
   Cohen d = 0.5 at 80 % power = 64 per group; r = 0.3 at 80 % power = 85 (G*Power and standard tables) */
test("a share to ± 5 % at 95 %: 385; with a population of 2,000: 323; ± 3 %: 1,068", () => {
  assert.equal(sampleSizeProportion({ margin: 0.05 }).n, 385);
  assert.equal(sampleSizeProportion({ margin: 0.05, population: 2000 }).n, 323);
  assert.equal(sampleSizeProportion({ margin: 0.03 }).n, 1068);
  assert.equal(sampleSizeProportion({ margin: 0.05, designEffect: 1.5 }).n, 577);
  assert.match(sampleSizeProportion({ margin: 0.05 }).working, /384\.1/);
});
test("two proportions 50 % vs 60 %, α 0.05, power 80 %: 388 per group", () => {
  const r = sampleSizeTwoProportions({ p1: 0.5, p2: 0.6 });
  assert.equal(r.perGroup, 388); assert.equal(r.n, 776);
});
test("a medium effect d = 0.5: 64 per group; d = 0.2: 394", () => {
  assert.equal(sampleSizeTwoMeans({ d: 0.5 }).perGroup, 64);
  assert.equal(sampleSizeTwoMeans({ d: 0.2 }).perGroup, 394);
});
test("a correlation of 0.3: 85; of 0.1: 783", () => {
  assert.equal(sampleSizeCorrelation({ r: 0.3 }).n, 85);
  assert.equal(sampleSizeCorrelation({ r: 0.1 }).n, 783);
});
test("starts from completes, incidence and completion; bad inputs are refused", () => {
  assert.equal(startsNeeded(400, 0.25, 0.8), 2000);
  assert.throws(() => sampleSizeProportion({ margin: 0 }));
  assert.throws(() => sampleSizeTwoProportions({ p1: 0.4, p2: 0.4 }));
});
