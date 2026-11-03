import test from "node:test";
import assert from "node:assert/strict";
import { allocate, type AllocationCandidate, type AllocationInput } from "./allocate.js";

const v = (id: string, cpi: number, p: Partial<AllocationCandidate> = {}): AllocationCandidate => ({
  integrationId: id, vendorName: id.toUpperCase(), cpi, currency: "USD",
  capacity: 100000, rejectionRate: 5, duplicateRate: 0, deliveryDays: 5,
  qualityScore: 80, qualityConfidence: "high", source: "vendor_reported", ...p,
});

const plan = (markets: AllocationInput["markets"], o: Partial<AllocationInput> = {}) =>
  allocate({ markets, budget: 1_000_000, currency: "USD", strategy: "lowest_cost", ...o });

const forVendor = (p: ReturnType<typeof plan>, id: string) => p.rows.find((r) => r.integrationId === id);

test("ranks on cost per valid complete, so the cheapest CPI can lose the allocation", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [
    v("cheap", 6.5, { rejectionRate: 20, duplicateRate: 8 }),
    v("dearer", 8.0, { rejectionRate: 4, duplicateRate: 0 }),
  ] }]);
  assert.equal(p.rows[0]!.integrationId, "dearer", "the $8.00 vendor yields more usable completes per pound");
  assert.equal(p.rows[0]!.completes, 1000);
  assert.equal(forVendor(p, "cheap"), undefined);
  assert.ok(p.feasible);
});

test("capacity is respected and the remainder spills to the next vendor", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [
    v("a", 5, { capacity: 600 }), v("b", 9, { capacity: 10000 }),
  ] }]);
  assert.equal(forVendor(p, "a")!.completes, 600);
  assert.equal(forVendor(p, "b")!.completes, 400);
  assert.equal(p.totalCost, 600 * 5 + 400 * 9);
  assert.equal(p.shortfall, 0);
});

test("a vendor with no history is given typical rates, not perfect ones", () => {
  /*
   * `new` is the cheaper quote. If its unknown rejection and duplicate rates were read as zero it would show a
   * perfect yield, a cost per valid complete of exactly $7.00, and would take the whole market from a proven
   * vendor quoting more. Assuming typical rates instead, it does not: 7.00 / (0.88 x 0.96) = $8.29 against
   * 7.20 / (0.97 x 0.99) = $7.50.
   */
  const p = plan([{ market: "US", required: 500, candidates: [
    v("new", 7.0, { rejectionRate: null, duplicateRate: null, qualityScore: null, qualityConfidence: "none" }),
    v("known", 7.2, { rejectionRate: 3, duplicateRate: 1, qualityConfidence: "high" }),
  ] }]);
  assert.equal(p.rows[0]!.integrationId, "known", "the cheaper quote did not win on an assumption of perfection");
  assert.equal(p.rows[0]!.completes, 500);
  assert.equal(p.rows[0]!.costPerValidComplete, 7.4977);
  assert.equal(forVendor(p, "new"), undefined);
});

test("when an unproven vendor is cheap enough to win anyway, the rationale says what was assumed", () => {
  const p = plan([{ market: "US", required: 500, candidates: [
    v("new", 4.0, { rejectionRate: null, duplicateRate: null, qualityScore: null, qualityConfidence: "none" }),
    v("known", 9.0, { rejectionRate: 3, duplicateRate: 1, qualityConfidence: "high" }),
  ] }]);
  const row = forVendor(p, "new");
  assert.ok(row, "the unproven vendor is used — not trusted is not the same as not used");
  assert.equal(row!.rationale.rejectionRate, 12, "the prior, not zero");
  assert.equal(row!.rationale.duplicateRate, 4);
  assert.match(String(row!.rationale.assumed), /not known for this vendor/);
  assert.equal(row!.completes, 125, "and it is still held to a quarter of the market");
  assert.equal(forVendor(p, "known")!.completes, 375);
});

test("an unproven vendor's share is capped, and the cap says so in the rationale", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [
    v("unproven", 4, { qualityConfidence: "none" }),
    v("proven", 9, { qualityConfidence: "high" }),
  ] }]);
  assert.equal(forVendor(p, "unproven")!.completes, 250, "25% of the market, despite being much cheaper");
  assert.equal(forVendor(p, "proven")!.completes, 750);
  assert.match(String(forVendor(p, "unproven")!.rationale.capacityUsed), /250 of 250/);
});

test("but the caps relax rather than making a new organisation's first project unbuyable", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [
    v("a", 5, { qualityConfidence: "none" }), v("b", 6, { qualityConfidence: "none" }),
  ] }]);
  assert.equal(p.totalCompletes, 1000, "two 25%-capped vendors would otherwise reach only 500");
  assert.equal(p.shortfall, 0);
  assert.match(p.notes.join(" "), /had to be relaxed/);
});

test("a vendor stating no availability is bounded by its share, never treated as unlimited", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [v("silent", 5, { capacity: null })] }], { maxVendorShare: 0.5 });
  assert.equal(forVendor(p, "silent")!.completes, 500);
  assert.equal(p.shortfall, 500);
  assert.equal(p.feasible, false);
  assert.match(String(forVendor(p, "silent")!.rationale.capacityUsed), /stated no availability/);
});

test("the quality floor and the deadline exclude with a reason, and the vendor is not silently dropped", () => {
  const p = plan([{ market: "US", required: 100, candidates: [
    v("poor", 3, { qualityScore: 40 }), v("slow", 3, { deliveryDays: 30 }), v("ok", 8),
  ] }], { qualityFloor: 60, deadlineDays: 7 });
  assert.equal(p.rows.length, 1);
  const reasons = p.markets[0]!.excluded;
  assert.equal(reasons.length, 2);
  assert.match(reasons.find((r) => r.integrationId === "poor")!.reason, /below the floor of 60/);
  assert.match(reasons.find((r) => r.integrationId === "slow")!.reason, /past the 7-day deadline/);
});

test("when the budget binds, cheaper vendors are preferred and the plan says it had to", () => {
  const candidates = [
    v("best", 10, { qualityScore: 95, rejectionRate: 2 }),
    v("cheap", 5, { qualityScore: 65, rejectionRate: 6 }),
  ];
  const free = plan([{ market: "US", required: 1000, candidates }], { strategy: "highest_quality", budget: 1_000_000 });
  assert.equal(forVendor(free, "best")!.completes, 1000, "with room, quality wins");
  assert.equal(free.costPressure, 0);

  const tight = plan([{ market: "US", required: 1000, candidates }], { strategy: "highest_quality", budget: 6000 });
  assert.ok(tight.costPressure > 0, "the budget bound, so cost pressure was applied");
  assert.ok(tight.totalCost <= 6000, `cost ${tight.totalCost} must fit the budget`);
  assert.match(tight.notes.join(" "), /to fit the .* budget/);
});

test("an unaffordable project reports a shortfall rather than quietly buying fewer", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [v("only", 10)] }], { budget: 4000 });
  assert.equal(p.feasible, false);
  assert.ok(p.totalCost <= 4000);
  assert.ok(p.shortfall > 0, "the gap is reported");
  assert.equal(p.totalCompletes + p.shortfall, 1000, "the arithmetic still adds up to what was asked for");
  assert.match(p.notes.join(" "), /exceeds the budget/);
});

test("each market is solved against its own vendors and its own target", () => {
  const p = plan([
    { market: "US", required: 600, candidates: [v("us1", 7), v("us2", 9)] },
    { market: "GB", required: 400, candidates: [v("gb1", 12)] },
  ]);
  assert.equal(p.markets.length, 2);
  assert.equal(p.markets.find((m) => m.market === "US")!.allocated, 600);
  assert.equal(p.markets.find((m) => m.market === "GB")!.allocated, 400);
  assert.equal(forVendor(p, "us1")!.market, "US");
  assert.equal(forVendor(p, "gb1")!.market, "GB");
  // the blended CPI spans both markets; each market also reports its own
  assert.equal(p.markets.find((m) => m.market === "GB")!.blendedCpi, 12);
  assert.equal(p.totalCost, 600 * 7 + 400 * 12);
});

test("the project is done when its slowest market is done", () => {
  const p = plan([
    { market: "US", required: 10, candidates: [v("a", 5, { deliveryDays: 3 })] },
    { market: "DE", required: 10, candidates: [v("b", 5, { deliveryDays: 11 })] },
  ]);
  assert.equal(p.expectedDeliveryDays, 11);
});

test("strategies change the answer, and custom weights need not sum to 1", () => {
  const candidates = [
    v("cheapest", 5, { qualityScore: 60, deliveryDays: 20 }),
    v("fastest", 9, { qualityScore: 70, deliveryDays: 2 }),
    v("finest", 8, { qualityScore: 99, deliveryDays: 10 }),
  ];
  const m = [{ market: "US", required: 300, candidates }];
  assert.equal(plan(m, { strategy: "lowest_cost" }).rows[0]!.integrationId, "cheapest");
  assert.equal(plan(m, { strategy: "fastest_delivery" }).rows[0]!.integrationId, "fastest");
  assert.equal(plan(m, { strategy: "highest_quality" }).rows[0]!.integrationId, "finest");
  const custom = plan(m, { strategy: "custom", weights: { cost: 0, quality: 10, speed: 0 } });
  assert.equal(custom.rows[0]!.integrationId, "finest");
  assert.deepEqual(custom.weights, { cost: 0, quality: 1, speed: 0 });
});

test("the same inputs always give the same plan — a researcher authorises this", () => {
  const markets = [{ market: "US", required: 777, candidates: [v("b", 7), v("a", 7), v("c", 7)] }];
  const a = JSON.stringify(plan(markets));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(plan(markets)), a);
  // equal scores break on integration id, not on input order
  assert.equal(plan(markets).rows[0]!.integrationId, "a");
});

test("expected valid completes are reported beside the raw ones, and never exceed them", () => {
  const p = plan([{ market: "US", required: 1000, candidates: [v("a", 8, { rejectionRate: 10, duplicateRate: 5 })] }]);
  assert.equal(p.totalCompletes, 1000);
  assert.equal(p.expectedValidCompletes, 855);
  assert.ok(p.expectedValidCompletes < p.totalCompletes);
  assert.equal(p.rows[0]!.rationale.yield, 0.855);
});

test("a vendor whose every complete would be thrown away is excluded, not ranked last", () => {
  const p = plan([{ market: "US", required: 100, candidates: [
    v("hopeless", 1, { rejectionRate: 100 }), v("fine", 9),
  ] }]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0]!.integrationId, "fine");
  assert.match(p.markets[0]!.excluded[0]!.reason, /rejected or duplicated/);
});

test("a market with no usable vendor produces a shortfall and an explanation, not an empty success", () => {
  const p = plan([{ market: "JP", required: 500, candidates: [v("x", 5, { capacity: 0 })] }]);
  assert.equal(p.feasible, false);
  assert.equal(p.shortfall, 500);
  assert.equal(p.rows.length, 0);
  assert.match(p.markets[0]!.excluded[0]!.reason, /no sample available/);
  assert.match(p.notes.join(" "), /500 of 500 completes could not be allocated/);
});
