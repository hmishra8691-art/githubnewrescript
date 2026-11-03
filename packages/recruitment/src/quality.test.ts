import test from "node:test";
import assert from "node:assert/strict";
import { wilson, confidenceFor, vendorQuality, rankByQuality } from "./quality.js";

const outcomes = (over: Partial<Parameters<typeof vendorQuality>[0]> = {}) => ({
  integrationId: "v1", delivered: 1000, accepted: 900, rejected: 100, duplicates: 0, ...over,
});

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
    assert.ok(widths[k] < widths[k - 1], `width must fall with n: ${widths.join(" > ")}`);
  }
  assert.ok(widths[0] > 10, "10% over 20 completes is barely a measurement");
  assert.ok(widths[3] < 1, "10% over 20,000 is a measurement");
});

test("a vendor nobody has used is null, never zero", () => {
  const fresh = vendorQuality(outcomes({ delivered: 0, accepted: 0, rejected: 0 }));
  assert.equal(fresh.score, null, "unknown is not a score of zero");
  assert.equal(fresh.rejection, null);
  assert.equal(fresh.pessimisticRejection, null);
  assert.equal(fresh.confidence, "none");
  assert.match(fresh.caveat!, /unknown, not poor/);
});

test("no score below fifty accepted completes, and the caveat says why", () => {
  const thin = vendorQuality(outcomes({ delivered: 49, accepted: 45, rejected: 4 }));
  assert.equal(thin.score, null);
  assert.match(thin.caveat!, /too few to score/);

  const enough = vendorQuality(outcomes({ delivered: 60, accepted: 55, rejected: 5 }));
  assert.ok(enough.score !== null, "fifty-five completes is enough to say something");
  assert.match(enough.caveat!, /could be anywhere between/, "…but it says how little");
});

test("ranking uses the pessimistic bound, so a lucky week does not win the project", () => {
  // Same 4% point estimate. One vendor has 25 completes behind it, the other 5,000.
  const lucky = vendorQuality(outcomes({ integrationId: "lucky", delivered: 25, accepted: 24, rejected: 1 }));
  const proven = vendorQuality(outcomes({ integrationId: "proven", delivered: 5000, accepted: 4800, rejected: 200 }));
  assert.ok(Math.abs(lucky.rejection!.point - proven.rejection!.point) < 1, "both look the same on the point estimate");

  const ranked = rankByQuality([lucky, proven]);
  assert.equal(ranked[0].integrationId, "proven", "the evidenced vendor ranks first despite an identical headline rate");
  assert.ok(lucky.pessimisticRejection! > proven.pessimisticRejection! * 3, "the thin sample carries a real handicap");
});

test("a vendor with no history ranks LAST, not first", () => {
  // The bug this pins: null rejection read as 0 sorts the unknown vendor to the top of a cost-quality ranking
  // and hands a brand-new supplier the whole project on its first day.
  const unknown = vendorQuality(outcomes({ integrationId: "unknown", delivered: 0, accepted: 0, rejected: 0 }));
  const mediocre = vendorQuality(outcomes({ integrationId: "mediocre", delivered: 2000, accepted: 1600, rejected: 400 }));
  assert.deepEqual(rankByQuality([unknown, mediocre]).map((r) => r.integrationId), ["mediocre", "unknown"]);
});

test("confidence bands follow accepted completes, not delivered", () => {
  assert.equal(confidenceFor(0), "none");
  assert.equal(confidenceFor(49), "none");
  assert.equal(confidenceFor(50), "low");
  assert.equal(confidenceFor(300), "medium");
  assert.equal(confidenceFor(1000), "high");
  // 10,000 delivered but nearly all rejected is not a high-confidence vendor
  const churn = vendorQuality(outcomes({ delivered: 10000, accepted: 40, rejected: 9960 }));
  assert.equal(churn.confidence, "none", "confidence is in the completes you could use");
});

test("CPI drift is reported, not folded into the score", () => {
  const over = vendorQuality(outcomes({ accepted: 500, spend: 2750, quotedCpi: 5 }));
  assert.equal(over.actualCpi, 5.5);
  assert.equal(over.cpiDrift, 0.1, "ten percent over quote");
  const noSpend = vendorQuality(outcomes({ accepted: 500, spend: null, quotedCpi: 5 }));
  assert.equal(noSpend.actualCpi, null);
  assert.equal(noSpend.cpiDrift, null, "no invented drift from a missing number");
});

test("malformed outcomes do not produce malformed statistics", () => {
  assert.equal(wilson(10, 5), null, "more successes than trials is not a proportion");
  assert.equal(wilson(-1, 100), null);
  assert.equal(wilson(5, 0), null);
  assert.equal(wilson(5, Number.NaN), null);
  const clamped = vendorQuality(outcomes({ delivered: 100, accepted: -5, rejected: 500 }));
  assert.ok(clamped.rejection!.point <= 100, "rejections above delivered are clamped, not propagated");
});
