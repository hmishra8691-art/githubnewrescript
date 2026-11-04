import test from "node:test";
import assert from "node:assert/strict";
import {
  sellingPrice, grossProfit, marginFromPrices, equivalentMarkupBps, validateMarginBps,
  resolveMargin, priceBreakdown, MarginError, DEFAULT_MARGIN_BPS, MAX_MARGIN_BPS,
  type MarginRule,
} from "./margin.js";
import { applyMarkup } from "./pricing.js";

test("the brief's own worked example: £7,000 cost at 30% margin is £10,000", () => {
  assert.equal(sellingPrice(7000, 3000), 10000);
  assert.equal(grossProfit(7000, 3000), 3000);
});

test("…and a 30% MARKUP on the same cost is £9,100 — the bug this engine replaces", () => {
  assert.equal(applyMarkup(7000, 3000), 9100);
  assert.notEqual(applyMarkup(7000, 3000), sellingPrice(7000, 3000));
  assert.equal(sellingPrice(7000, 3000) - applyMarkup(7000, 3000), 900, "£900 a project, in the wrong direction");
});

test("the margin really is a share of the SELLING price, not of cost", () => {
  const price = sellingPrice(7000, 3000);
  assert.equal(Math.round((price - 7000) / price * 100), 30, "profit is 30% of the price");
  assert.notEqual(Math.round((price - 7000) / 7000 * 100), 30, "…and is NOT 30% of the cost");
});

test("a 100% margin has no finite price and is refused, not rounded", () => {
  assert.equal(validateMarginBps(10_000).ok, false);
  assert.match(validateMarginBps(10_000).reason!, /no finite selling price/);
  assert.throws(() => sellingPrice(1000, 10_000), MarginError);
  // the failure this prevents: Infinity or NaN flowing on into a quotation
  assert.ok(Number.isFinite(sellingPrice(1000, MAX_MARGIN_BPS)));
});

test("an implausibly high margin is refused as a likely typo, with a way to mean it", () => {
  const v = validateMarginBps(9900);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /explicit override with a note/);
});

test("a negative margin is refused, and says what to do instead", () => {
  assert.equal(validateMarginBps(-1).ok, false);
  assert.match(validateMarginBps(-1).reason!, /record the discount separately/);
});

test("zero margin sells at cost; zero cost sells at nothing", () => {
  assert.equal(sellingPrice(5000, 0), 5000);
  assert.equal(grossProfit(5000, 0), 0);
  assert.equal(sellingPrice(0, 3000), 0);
});

test("the inverse recovers the margin, so a quoted price can be checked", () => {
  assert.equal(marginFromPrices(7000, 10000), 3000);
  assert.equal(marginFromPrices(7500, 10000), 2500);
  for (const bps of [500, 1500, 2500, 3000, 4000]) {
    assert.equal(marginFromPrices(7000, sellingPrice(7000, bps)), bps, `round-trips at ${bps}`);
  }
});

test("a price at or below cost reports NO margin rather than a negative one", () => {
  assert.equal(marginFromPrices(7000, 7000), null);
  assert.equal(marginFromPrices(7000, 6000), null, "a loss is not a margin setting somebody should 'fix'");
  assert.equal(marginFromPrices(7000, 0), null);
});

test("the equivalent markup is reported for agreements written the other way round", () => {
  // 30% margin is a 42.86% markup — the same price, stated differently
  assert.equal(equivalentMarkupBps(3000), 4286);
  assert.equal(equivalentMarkupBps(0), 0);
  /*
   * The two routes reach the same price, to within one basis point of rounding on the markup. Asserting an
   * exact equality here would be asserting the rounding, not the relationship.
   */
  for (const [cost, bps] of [[7000, 3000], [1234.56, 2500], [99, 1000]] as const) {
    const viaMargin = sellingPrice(cost, bps);
    const viaMarkup = applyMarkup(cost, equivalentMarkupBps(bps)!);
    assert.ok(Math.abs(viaMargin - viaMarkup) <= viaMargin * 0.0001 + 0.01,
      `£${cost} at ${bps}bps: margin gives ${viaMargin}, the equivalent markup gives ${viaMarkup}`);
  }
});

/* ------------------------------------------------------------ resolution */

const rule = (over: Partial<MarginRule> & { id: string; scope: MarginRule["scope"]; marginBps: number }): MarginRule => over;

test("with no rules at all, the platform default applies and says so", () => {
  const r = resolveMargin([]);
  assert.equal(r.marginBps, DEFAULT_MARGIN_BPS);
  assert.equal(r.isDefault, true);
  assert.equal(r.ruleId, null);
  assert.match(r.because, /No margin rule matched/);
});

test("more specific wins: override > project > type > market > default", () => {
  const rules = [
    rule({ id: "d", scope: "default", marginBps: 2500 }),
    rule({ id: "m", scope: "market", marginBps: 2600, market: "GB" }),
    rule({ id: "t", scope: "recruitment_type", marginBps: 2700, recruitmentType: "b2b" }),
    rule({ id: "p", scope: "project", marginBps: 2800, recruitmentProjectId: "proj1" }),
    rule({ id: "o", scope: "override", marginBps: 1500, recruitmentProjectId: "proj1", note: "agreed with the client" }),
  ];
  const q = { market: "GB", recruitmentType: "b2b", recruitmentProjectId: "proj1" };
  assert.equal(resolveMargin(rules, q).ruleId, "o");
  assert.equal(resolveMargin(rules.filter((r) => r.id !== "o"), q).ruleId, "p");
  assert.equal(resolveMargin(rules.filter((r) => !"op".includes(r.id)), q).ruleId, "t");
  assert.equal(resolveMargin(rules.filter((r) => "dm".includes(r.id)), q).ruleId, "m");
  assert.equal(resolveMargin(rules.filter((r) => r.id === "d"), q).ruleId, "d");
});

test("a rule for another market or another project does not apply", () => {
  const rules = [
    rule({ id: "d", scope: "default", marginBps: 3000 }),
    rule({ id: "us", scope: "market", marginBps: 1000, market: "US" }),
    rule({ id: "other", scope: "project", marginBps: 500, recruitmentProjectId: "someone-else" }),
  ];
  const r = resolveMargin(rules, { market: "GB", recruitmentProjectId: "mine" });
  assert.equal(r.ruleId, "d");
  assert.equal(r.marginBps, 3000);
});

test("the answer says WHY, naming the rule that produced it", () => {
  const r = resolveMargin([rule({ id: "m", scope: "market", marginBps: 2200, market: "IN" })], { market: "IN" });
  assert.match(r.because, /22\.0% from the rate set for IN/);

  const o = resolveMargin(
    [rule({ id: "o", scope: "override", marginBps: 1500, recruitmentProjectId: "p1", note: "volume deal" })],
    { recruitmentProjectId: "p1" });
  assert.match(o.because, /override \(volume deal\)/, "an override without its reason is unauditable");
});

test("an expired rule does not apply, and a future one does not apply yet", () => {
  const rules = [
    rule({ id: "d", scope: "default", marginBps: 3000 }),
    rule({ id: "old", scope: "market", marginBps: 1000, market: "GB", effectiveTo: "2026-01-01T00:00:00Z" }),
    rule({ id: "new", scope: "market", marginBps: 2000, market: "GB", effectiveFrom: "2027-01-01T00:00:00Z" }),
  ];
  const at = "2026-06-01T00:00:00Z";
  assert.equal(resolveMargin(rules, { market: "GB", at }).ruleId, "d");
  assert.equal(resolveMargin(rules, { market: "GB", at: "2025-06-01T00:00:00Z" }).ruleId, "old");
  assert.equal(resolveMargin(rules, { market: "GB", at: "2027-06-01T00:00:00Z" }).ruleId, "new");
});

test("an invalid rule is ignored rather than crashing the quote", () => {
  const rules = [
    rule({ id: "bad", scope: "market", marginBps: 10_000, market: "GB" }),
    rule({ id: "d", scope: "default", marginBps: 3000 }),
  ];
  assert.equal(resolveMargin(rules, { market: "GB" }).ruleId, "d");
});

test("resolution is deterministic regardless of input order", () => {
  const rules = [
    rule({ id: "b", scope: "market", marginBps: 2000, market: "GB" }),
    rule({ id: "a", scope: "market", marginBps: 2500, market: "GB" }),
  ];
  assert.equal(resolveMargin(rules, { market: "GB" }).ruleId, "a");
  assert.equal(resolveMargin([...rules].reverse(), { market: "GB" }).ruleId, "a");
});

test("a rate outside the target band is flagged, not refused", () => {
  assert.equal(resolveMargin([rule({ id: "x", scope: "default", marginBps: 2750 })]).withinTargetBand, true);
  assert.equal(resolveMargin([rule({ id: "x", scope: "default", marginBps: 1200 })]).withinTargetBand, false);
  assert.equal(resolveMargin([rule({ id: "x", scope: "default", marginBps: 4500 })]).withinTargetBand, false);
});

/* ------------------------------------------------------------ the breakdown */

test("the breakdown carries both sides, and names the ones a researcher must never see", () => {
  const b = priceBreakdown(7000, 1000, "GBP", resolveMargin([]));
  assert.equal(b.cost, 7000);
  assert.equal(b.price, 10000);
  assert.equal(b.profit, 3000);
  assert.equal(b.pricePerComplete, 10);
  assert.equal(b.costPerComplete, 7);
  // the fields that must be stripped are plainly named, so a careless spread is visible in review
  assert.ok("cost" in b && "profit" in b && "costPerComplete" in b);
});

test("zero completes does not divide by zero", () => {
  const b = priceBreakdown(0, 0, "GBP", resolveMargin([]));
  assert.equal(b.pricePerComplete, null);
  assert.equal(b.costPerComplete, null);
  assert.equal(b.price, 0);
});
