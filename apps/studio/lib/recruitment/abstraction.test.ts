import test from "node:test";
import assert from "node:assert/strict";
import { researcherPlan, findVendorIdentity, findVendorNames, type InternalMarketRow } from "./abstraction.ts";

const market = (over: Partial<InternalMarketRow> = {}): InternalMarketRow => ({
  market: "GB", required: 500, allocated: 500, delivered: 120, accepted: 110, cost: 2500,
  expectedDeliveryDays: 4, ...over,
});

const plan = (over: Partial<Parameters<typeof researcherPlan>[0]> = {}) => researcherPlan({
  currency: "GBP", requiredCompletes: 1000, markets: [market()], sourceCount: 3,
  price: 8000, feasible: true, shortfall: 0, expectedDeliveryDays: 6,
  qualityScore: 82, qualityConfidence: "high", ...over,
});

test("the researcher plan carries no vendor identity at all", () => {
  const p = plan({
    markets: [market({ market: "GB" }), market({ market: "US", cost: 4000 })],
  });
  const leak = findVendorIdentity(p);
  assert.deepEqual(leak.found, [], `forbidden keys reached the researcher: ${leak.found.join(", ")}`);
  assert.equal(leak.ok, true);
});

test("internal acquisition cost is dropped, not renamed", () => {
  const p = plan({ markets: [market({ cost: 2500 })], price: 8000 });
  const text = JSON.stringify(p);
  assert.ok(!text.includes("2500"), "the pre-margin cost must not survive anywhere in the payload");
  assert.equal(p.price, 8000, "the price the researcher pays is reported in full");
});

test("markets are reported; sources are not", () => {
  const p = plan({ markets: [market({ market: "US" }), market({ market: "GB" })] });
  assert.deepEqual(p.markets.map((m) => m.market), ["GB", "US"], "sorted, so the order carries no meaning");
  assert.ok(!("sources" in p) && !("sourceCount" in p), "the number of suppliers describes the supply chain");
});

test("capacity is a word, never a count — a number would disclose the supply chain", () => {
  assert.equal(plan({ sourceCount: 5 }).capacity, "broad");
  assert.equal(plan({ sourceCount: 2 }).capacity, "adequate");
  assert.equal(plan({ sourceCount: 1 }).capacity, "limited");
  assert.equal(plan({ sourceCount: 0 }).capacity, "unknown");
  const text = JSON.stringify(plan({ sourceCount: 7 }));
  assert.ok(!/"capacity":\s*7/.test(text));
});

test("an infeasible plan reads as limited capacity however many sources there are", () => {
  assert.equal(plan({ sourceCount: 9, feasible: false, shortfall: 300 }).capacity, "limited");
});

test("quality is passed through with its confidence, including 'not enough history'", () => {
  const thin = plan({ qualityScore: null, qualityConfidence: "none" });
  assert.equal(thin.quality.score, null, "unknown stays null — never rendered as a zero score");
  assert.equal(thin.quality.confidence, "none");
});

test("price per complete is derived, and a zero target does not divide by zero", () => {
  assert.equal(plan({ price: 8000, requiredCompletes: 1000 }).pricePerComplete, 8);
  assert.equal(plan({ requiredCompletes: 0 }).pricePerComplete, null);
});

test("findVendorIdentity catches a forbidden key at any depth", () => {
  assert.deepEqual(findVendorIdentity({ a: { b: { c: { vendorName: "Prolific" } } } }).found, ["$.a.b.c.vendorName"]);
  assert.deepEqual(findVendorIdentity({ rows: [{ ok: 1 }, { integrationId: "x" }] }).found, ["$.rows[1].integrationId"]);
  assert.deepEqual(findVendorIdentity({ plan: { cpi: 4.5 } }).found, ["$.plan.cpi"]);
  assert.equal(findVendorIdentity({ market: "GB", accepted: 10 }).ok, true);
});

test("…and it is case-insensitive, because a rename is how a field comes back", () => {
  assert.equal(findVendorIdentity({ VendorName: "x" }).ok, false);
  assert.equal(findVendorIdentity({ CPI: 1 }).ok, false);
});

test("vendor NAMES are caught as values too, not only as keys", () => {
  const names = ["Prolific", "Cint (Lucid)", "Dynata"];
  assert.equal(findVendorNames(plan(), names).ok, true);
  assert.deepEqual(findVendorNames({ notes: ["Delivered by Prolific"] }, names).found, ["Prolific"]);
  assert.equal(findVendorNames({ notes: ["all good"] }, names).ok, true);
});

test("a note that names a supplier is caught before it reaches a researcher", () => {
  // the realistic leak: an internal note written for an operator, passed through to the plan
  const p = plan({ notes: ["Prolific could not express income targeting"] });
  assert.equal(findVendorNames(p, ["Prolific"]).ok, false, "notes are the easiest place for a name to survive");
});

test("the guard tolerates cycles and odd input rather than throwing", () => {
  assert.equal(findVendorIdentity(null).ok, true);
  assert.equal(findVendorIdentity("a string").ok, true);
  const deep: Record<string, unknown> = {};
  let node = deep;
  for (let i = 0; i < 40; i++) { const next = {}; node.next = next; node = next as Record<string, unknown>; }
  assert.equal(findVendorIdentity(deep).ok, true, "depth is capped rather than recursing forever");
});

test("a cost field is caught whatever it has been named", () => {
  /*
   * The leak this pins, which the first version of the guard missed: totals.blendedCpi is the average price
   * paid to suppliers. It reached every researcher, and an exact-match list containing "cpi" did not see it
   * because the key is "blendedCpi".
   */
  assert.equal(findVendorIdentity({ totals: { blendedCpi: 4.2 } }).ok, false);
  assert.equal(findVendorIdentity({ totals: { committed: 9000 } }).ok, false);
  assert.equal(findVendorIdentity({ totals: { spend: 4100 } }).ok, false);
  assert.equal(findVendorIdentity({ costPerValidComplete: 7 }).ok, false);
  assert.equal(findVendorIdentity({ acquisitionCost: 1 }).ok, false);
});

test("what the researcher PAYS is not a leak — only what it cost us is", () => {
  const ok = findVendorIdentity({ price: 10000, pricePerComplete: 10, budget: 12000, currency: "GBP" });
  assert.deepEqual(ok.found, [], "price and budget are the researcher's own figures");
});

test("the counts a researcher needs survive the guard", () => {
  const counts = { required: 1000, accepted: 400, delivered: 450, rejected: 30, duplicates: 20, remaining: 600 };
  assert.equal(findVendorIdentity({ totals: counts }).ok, true);
});

/*
 * The reallocation answer (Phase 5) is assembled in the route rather than by `researcherPlan`, so the guard
 * that covers the plan does not cover it. Its shape is pinned here instead, because what makes it safe is
 * which fields were BUILT into it — a filter only removes what somebody remembered to list, and `{ ...row }`
 * is how a field comes back.
 */
const reallocationForResearcher = (deviations: Array<Record<string, unknown>>) => ({
  ok: true,
  deviations: deviations.map((d) => ({
    market: d.market, kind: d.kind, severity: d.severity, shortfall: d.shortfall, detail: d.detail,
  })),
  reSource: [{ market: "GB", completes: 400 }],
  requiresApproval: true,
  statement: "400 completes need re-sourcing. Nothing has been changed — this is a proposal.",
});

test("a reallocation tells a researcher a market is behind, never which supplier", () => {
  const payload = reallocationForResearcher([{
    integrationId: "int-1", market: "GB", kind: "pace", severity: "act", shortfall: 400,
    detail: "600 of 1,000 with 70% of the field period gone — on track for about 857, 143 short.",
  }]);
  assert.deepEqual(findVendorIdentity(payload).found, []);
  assert.deepEqual(findVendorNames(payload, ["Cint", "Prolific"]).found, []);
  assert.equal((payload.deviations[0] as Record<string, unknown>).integrationId, undefined,
    "the integration id is the supply chain; the fact that something is behind is not");
});

test("the deviation sentences are counts and percentages, which is why they can be shown at all", () => {
  /*
   * If `detectDeviations` ever started naming the vendor in its `detail`, this payload would carry it
   * straight through — the sentence is passed along whole. This is the test that would catch it.
   */
  const payload = reallocationForResearcher([{
    integrationId: "int-2", market: "US", kind: "quality", severity: "watch", shortfall: 0,
    detail: "Rejection running at 18.0% (at least 14.2% on 2,000 screened) against 8.0% assumed in the plan.",
  }]);
  assert.deepEqual(findVendorNames(payload, ["Cint", "Prolific", "Dynata"]).found, []);
  assert.deepEqual(findVendorIdentity(payload).found, []);
});

test("the commercial half of a reallocation is caught if it is ever sent to a researcher", () => {
  /*
   * The guard earns its keep only by failing on the payload it exists to refuse. The administrator's half
   * carries the deviations WITH their integration ids and a revised plan naming each supplier — so a route
   * that dropped the `canSeeVendors` check, or spread the proposal in whole, fails here.
   */
  const leaked = {
    ...reallocationForResearcher([]),
    supplyChain: {
      deviations: [{ integrationId: "int-1", market: "GB", kind: "pace", severity: "act", shortfall: 400, detail: "…" }],
      revisedPlan: { rows: [{ integrationId: "int-9", vendorName: "Cint", cpi: 4.2 }] },
      headroom: 4000, currency: "GBP", notes: ["…"],
    },
  };
  const leak = findVendorIdentity(leaked);
  assert.equal(leak.ok, false, "a supplyChain block reaching a researcher must be caught");
  assert.ok(leak.found.some((f) => f.includes("integrationId")));
  assert.ok(leak.found.some((f) => f.includes("cpi")));
  assert.equal(findVendorNames(leaked, ["Cint"]).ok, false, "and the supplier is named in it");
});
