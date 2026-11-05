import test from "node:test";
import assert from "node:assert/strict";
import { AudienceSpecification, type VendorPricingRow } from "@rescript/schema";
import { compareVendors, comparisonSource, estimateForVendor, type FeasibilityInput } from "./feasibility.js";

const audience = (countries: string[] = ["US"]) =>
  AudienceSpecification.parse({ demographics: { countries, ageMin: 25, ageMax: 45 } });

const params = { audience: audience(), requiredCompletes: 5000, loiMinutes: 15, expectedIr: 30 };

const price = (cpi: number, p: Partial<VendorPricingRow> = {}): VendorPricingRow => ({
  integrationId: "i", market: "US", irMin: 0, irMax: 100, loiMin: 0, loiMax: 120,
  cpi, currency: "USD", source: "vendor_reported", ...p,
});

const vendor = (name: string, p: Partial<FeasibilityInput> = {}): FeasibilityInput => ({
  integrationId: name.toLowerCase(), vendorName: name, mode: "manual", markupBps: 0, currency: "USD",
  pricing: [price(8)], ...p,
});

test("a vendor with no integration says so, and offers no numbers to rank on", () => {
  const e = estimateForVendor(vendor("Bilendi", { mode: "awaiting" }), params);
  assert.equal(e.cpi, null);
  assert.equal(e.available, null);
  assert.match(e.unavailableReason!, /No integration configured/);
});

test("a redirect-only vendor is present in the answer, not missing from it", () => {
  const e = estimateForVendor(vendor("Toluna", { mode: "redirect_only" }), params);
  assert.equal(e.cpi, null);
  assert.match(e.unavailableReason!, /vendor's own dashboard/);
});

test("an uncovered market gives null and the reason — never a zero", () => {
  const e = estimateForVendor(vendor("Dynata", { pricing: [price(8, { market: "US" })] }), { ...params, audience: audience(["JP"]) });
  assert.equal(e.cpi, null);
  assert.notEqual(e.cpi, 0);
  assert.match(e.unavailableReason!, /No price configured for JP/);
});

test("an audience with no country cannot be priced", () => {
  const e = estimateForVendor(vendor("Cint"), { ...params, audience: audience([]) });
  assert.match(e.unavailableReason!, /names no country/);
});

test("the markup an administrator agreed is applied to the vendor's CPI, and the provenance survives it", () => {
  const e = estimateForVendor(vendor("Cint", { markupBps: 1250 }), params);
  assert.equal(e.cpi, 9); // 8.00 + 12.5%
  assert.equal(e.source, "vendor_reported");
});

test("confidence is carried from the hourly pass, not re-derived from the complete count", () => {
  /*
   * This file used to grade the evidence itself, from `completes`. That was one of four copies of the same
   * ladder, and the one that counts the orders is `rescript_vendor_quality_recompute`. A vendor whose history
   * arrives WITHOUT a graded confidence is unknown — which is the honest answer, because nothing has scored
   * it — rather than quietly graded again here on a number that happens to be to hand.
   */
  const graded = estimateForVendor(vendor("Scored", { history: { completes: 2000, rejectionRate: 5, qualityScore: 90, qualityConfidence: "high" } }), params);
  assert.equal(graded.qualityConfidence, "high");
  assert.equal(graded.qualityScore, 90);

  const ungraded = estimateForVendor(vendor("Unscored", { history: { completes: 2000, rejectionRate: 5 } }), params);
  assert.equal(ungraded.qualityConfidence, "none", "2000 completes nobody has scored is still unknown");
  assert.equal(ungraded.qualityScore, null);
});

test("the comparison ranks by cost per valid complete, so the cheapest CPI can lose", () => {
  const rows = compareVendors([
    vendor("Cheap", { pricing: [price(6.5)], history: { completes: 2000, rejectionRate: 20, duplicateRate: 8 } }),
    vendor("Dearer", { pricing: [price(8)], history: { completes: 2000, rejectionRate: 4, duplicateRate: 0 } }),
  ], params);
  assert.equal(rows[0]!.vendorName, "Dearer");
  assert.equal(rows[0]!.costPerValidComplete, 8.3333);
  assert.equal(rows[1]!.costPerValidComplete, 8.8315);
  // and the headline CPI still says what the vendor charges
  assert.equal(rows[0]!.cpi, 8);
  assert.equal(rows[1]!.cpi, 6.5);
});

test("a vendor that cannot be ranked goes to the bottom with its reason, and is not dropped", () => {
  const rows = compareVendors([
    vendor("Awaiting", { mode: "awaiting" }),
    vendor("Priced", { pricing: [price(7)], history: { completes: 2000, rejectionRate: 5, qualityConfidence: "high" } }),
  ], params);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.vendorName, "Priced");
  assert.equal(rows[1]!.rankable, false);
  assert.match(rows[1]!.caveat!, /No integration configured/);
});

test("a quality figure with no history behind it is flagged rather than ranked on silently", () => {
  const rows = compareVendors([vendor("New", { pricing: [price(7)], history: { completes: 3, rejectionRate: 0 } })], params);
  assert.equal(rows[0]!.qualityConfidence, "none");
  assert.match(rows[0]!.caveat!, /too little history/);
});

test("projected cost and expected valid completes are reported together, because one without the other misleads", () => {
  const rows = compareVendors([vendor("V", { pricing: [price(8)], history: { completes: 2000, rejectionRate: 10, duplicateRate: 5, qualityConfidence: "high" } })], params);
  assert.equal(rows[0]!.projectedCost, 40000);        // 5000 × $8.00, the whole budget
  assert.equal(rows[0]!.expectedValidCompletes, 4275); // of which 4,275 would actually count
});

test("a comparison is only as strong as its weakest priced vendor", () => {
  const rows = compareVendors([
    vendor("A", { pricing: [price(7, { source: "live" })] }),
    vendor("B", { pricing: [price(8, { source: "administrator" })] }),
  ], params);
  assert.equal(comparisonSource(rows), "administrator");
  assert.equal(comparisonSource(compareVendors([vendor("A", { pricing: [price(7, { source: "live" })] })], params)), "live");
});
