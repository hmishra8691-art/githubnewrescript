import test from "node:test";
import assert from "node:assert/strict";
import { wilson } from "./quality.js";

/*
 * What was tested here and is not any more: `vendorQuality`, `confidenceFor` and `rankByQuality`. They were a
 * second implementation of `rescript_vendor_quality_recompute` (0085) — same Wilson arithmetic, same
 * 50-complete floor, same 1000/300/50 ladder — and the two had already begun to disagree about z. The scoring
 * has one owner now, in SQL, where the orders are; its behaviour is covered by the migration's own tests.
 *
 * The statistics stay here because they are not a duplicate: reallocate.ts needs a bound on a rate it computes
 * from live delivery in memory, which has no row in any table to read.
 */

test("Wilson stays inside [0,100] where the normal approximation does not", () => {
  // 0 of 5: the textbook interval is exactly [0, 0] — the case that makes a new vendor look flawless.
  const clean = wilson(0, 5)!;
  assert.equal(clean.point, 0);
  assert.equal(clean.low, 0, "cannot go below zero");
  assert.ok(clean.high > 40, `5 clean completes must not claim a low rejection rate; got high=${clean.high}`);

  const perfect = wilson(5, 5)!;
  assert.equal(perfect.point, 100);
  assert.ok(perfect.low < 60, "nor is 5/5 proof of a 100% rate");
  assert.equal(perfect.high, 100, "cannot go above one hundred");
});

test("the interval narrows as evidence accumulates — the whole reason it is here", () => {
  const widths = [20, 200, 2000, 20000].map((n) => {
    const i = wilson(Math.round(n * 0.1), n)!;
    return i.high - i.low;
  });
  for (let k = 1; k < widths.length; k++) {
    assert.ok(widths[k]! < widths[k - 1]!, `width must fall with n: ${widths.join(" > ")}`);
  }
  assert.ok(widths[0]! > 10, "10% over 20 completes is barely a measurement");
  assert.ok(widths[3]! < 1, "10% over 20,000 is a measurement");
});

test("malformed inputs produce no statistics rather than wrong ones", () => {
  assert.equal(wilson(10, 5), null, "more successes than trials is not a proportion");
  assert.equal(wilson(-1, 100), null);
  assert.equal(wilson(5, 0), null);
  assert.equal(wilson(5, Number.NaN), null);
  assert.equal(wilson(Number.NaN, 100), null);
});
