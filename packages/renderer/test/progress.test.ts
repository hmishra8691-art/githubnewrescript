/**
 * D20 / AQ-11 — the progress model behind "steps" / "bar" / "percent" (src/progress.ts).
 *   node --experimental-strip-types --no-warnings --test packages/renderer/test/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressModel, STEP_DOTS_MAX } from "../src/progress.ts";

test("D20: percent keeps the runtime's formula (the end screen is the +1)", () => {
  assert.equal(progressModel(1, 4).percent, 20);
  assert.equal(progressModel(4, 4).percent, 80);
  assert.equal(progressModel(2, 4, true).percent, 100);
});

test("D20: steps — Page n of N, n clamped into 1..N", () => {
  assert.deepEqual([progressModel(3, 5).current, progressModel(3, 5).total], [3, 5]);
  assert.equal(progressModel(0, 5).current, 1);
  assert.equal(progressModel(9, 5).current, 5);
  assert.equal(progressModel(1, 0).total, 1);
  assert.equal(progressModel(Number.NaN, Number.NaN).total, 1);
});

test("D20: dots up to the cap, then the text alone", () => {
  assert.equal(STEP_DOTS_MAX, 12);
  assert.equal(progressModel(1, 12).dots, true);
  assert.equal(progressModel(1, 13).dots, false);
});
