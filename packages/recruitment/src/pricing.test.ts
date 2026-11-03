import test from "node:test";
import assert from "node:assert/strict";
import type { VendorPricingRow } from "@rescript/schema";
import {
  applyMarkup, blendedCpi, completesForBudget, costPerValidComplete, expectedValidCompletes,
  pricedMarkets, selectPricing, totalCost, validYield, weakestSource,
} from "./pricing.js";

const row = (p: Partial<VendorPricingRow> & { cpi: number }): VendorPricingRow => ({
  integrationId: "i1", market: "US", irMin: 0, irMax: 100, loiMin: 0, loiMax: 120,
  currency: "USD", source: "administrator", ...p,
});

test("the cheaper CPI is not the cheaper vendor — the brief's §25, as arithmetic", () => {
  // $6.50 with a fifth of its completes rejected and 8% duplicated
  const cheap = costPerValidComplete(6.5, 20, 8);
  // $8.00 with a 4% rejection rate and no duplicates
  const dearer = costPerValidComplete(8.0, 4, 0);
  assert.equal(cheap, 8.8315);
  assert.equal(dearer, 8.3333);
  assert.ok(dearer < cheap, "the $8.00 vendor costs less per complete that actually counts");
});

test("rates are percentages — 1 means one percent, not everything", () => {
  assert.equal(validYield(20, 8), 0.8 * 0.92);
  /*
   * The regression this exists for: `asFraction` used to guess the unit with `rate > 1 ? rate / 100 : rate`,
   * so a 1% duplicate rate was read as 100% and the vendor was scored as yielding nothing and dropped from
   * every allocation. A rate of exactly 1 is the one value no heuristic can disambiguate.
   */
  assert.equal(validYield(1, 0), 0.99);
  assert.equal(validYield(0, 1), 0.99);
  assert.equal(validYield(null, undefined), 1);
  assert.equal(validYield(-5, 0), 1);
  assert.equal(validYield(150, 0), 0, "clamped at 100%");
  assert.equal(costPerValidComplete(7.2, 3, 1), 7.4977);
});

test("a vendor that yields nothing has no finite cost per valid complete", () => {
  assert.equal(costPerValidComplete(5, 100, 0), Infinity);
  assert.equal(costPerValidComplete(5, 0, 100), Infinity);
  // and a negative or non-finite CPI cannot win a comparison by rounding to zero
  assert.equal(costPerValidComplete(-1, 0, 0), Infinity);
  assert.equal(costPerValidComplete(Number.NaN, 0, 0), Infinity);
});

test("expected valid completes floors — a part of a complete is not a complete", () => {
  assert.equal(expectedValidCompletes(1000, 20, 8), 736);
  assert.equal(expectedValidCompletes(10, 15, 0), 8); // 8.5 → 8
  assert.equal(expectedValidCompletes(0, 0, 0), 0);
  assert.equal(expectedValidCompletes(-5, 0, 0), 0);
});

test("markup is basis points on the vendor's CPI", () => {
  assert.equal(applyMarkup(10, 0), 10);
  assert.equal(applyMarkup(10, 1500), 11.5);
  assert.equal(applyMarkup(10, -5), 10);
});

test("blended CPI is weighted by completes, and an empty allocation is 0 rather than NaN", () => {
  assert.equal(blendedCpi([{ completes: 1500, cpi: 8 }, { completes: 1500, cpi: 6.5 }, { completes: 1000, cpi: 7 }, { completes: 1000, cpi: 7.5 }]), 7.25);
  assert.equal(blendedCpi([]), 0);
  assert.equal(blendedCpi([{ completes: 0, cpi: 9 }]), 0);
  assert.equal(totalCost([{ completes: 1500, cpi: 8 }, { completes: 1000, cpi: 7.5 }]), 19500);
});

test("a budget buys whole completes only", () => {
  assert.equal(completesForBudget(40000, 8), 5000);
  assert.equal(completesForBudget(40000, 7.3), 5479);
  assert.equal(completesForBudget(0, 8), 0);
  assert.equal(completesForBudget(100, 0), 0);
});

test("rate-card bands are half-open, so a boundary matches exactly one row", () => {
  const rows = [row({ cpi: 5, irMin: 10, irMax: 20 }), row({ cpi: 9, irMin: 20, irMax: 30 })];
  assert.equal(selectPricing(rows, { market: "US", ir: 19.9, loiMinutes: 15 })?.cpi, 5);
  assert.equal(selectPricing(rows, { market: "US", ir: 20, loiMinutes: 15 })?.cpi, 9);
  assert.equal(selectPricing(rows, { market: "US", ir: 30, loiMinutes: 15 }), null);
});

test("an uncovered market is null, never the nearest band", () => {
  const rows = [row({ cpi: 5, market: "US" })];
  assert.equal(selectPricing(rows, { market: "JP", ir: 30, loiMinutes: 15 }), null);
  assert.equal(selectPricing(rows, { market: "US", ir: 30, loiMinutes: 200 }), null);
  assert.equal(selectPricing([], { market: "US", ir: 30, loiMinutes: 15 }), null);
});

test("provenance wins ties, then recency, then the tighter band", () => {
  const rows = [
    row({ cpi: 9, source: "administrator" }),
    row({ cpi: 7, source: "vendor_reported" }),
    row({ cpi: 6, source: "historical" }),
  ];
  assert.equal(selectPricing(rows, { market: "US", ir: 30, loiMinutes: 15 })?.cpi, 7);

  const dated = [
    row({ cpi: 7, source: "vendor_reported", validFrom: "2026-01-01T00:00:00.000Z" }),
    row({ cpi: 8, source: "vendor_reported", validFrom: "2026-06-01T00:00:00.000Z" }),
  ];
  assert.equal(selectPricing(dated, { market: "US", ir: 30, loiMinutes: 15, at: "2026-11-03T00:00:00.000Z" })?.cpi, 8);

  const bands = [
    row({ cpi: 7, source: "vendor_reported" }),
    row({ cpi: 8, source: "vendor_reported", irMin: 25, irMax: 35 }),
  ];
  assert.equal(selectPricing(bands, { market: "US", ir: 30, loiMinutes: 15 })?.cpi, 8);
});

test("an expired rate card does not price anything", () => {
  const rows = [row({ cpi: 5, validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" })];
  assert.equal(selectPricing(rows, { market: "US", ir: 30, loiMinutes: 15, at: "2026-11-03T00:00:00.000Z" }), null);
  assert.equal(selectPricing(rows, { market: "US", ir: 30, loiMinutes: 15, at: "2026-01-15T00:00:00.000Z" })?.cpi, 5);
  assert.deepEqual(pricedMarkets(rows, "2026-11-03T00:00:00.000Z"), []);
  assert.deepEqual(pricedMarkets(rows, "2026-01-15T00:00:00.000Z"), ["US"]);
});

test("a total built from mixed provenance is only as strong as its weakest figure", () => {
  assert.equal(weakestSource(["live", "live", "administrator"]), "administrator");
  assert.equal(weakestSource(["live", "vendor_reported"]), "vendor_reported");
  assert.equal(weakestSource([]), "administrator");
});
