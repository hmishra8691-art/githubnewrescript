import test from "node:test";
import assert from "node:assert/strict";
import { detectDeviations, proposeReallocation, deliveryProgress, assumedRejectionOfAllocation, type ObservedVendor, type ReallocationInput } from "./reallocate.js";
import type { AllocationCandidate } from "./allocate.js";

const cand = (id: string, cpi: number, capacity: number | null = 5000): AllocationCandidate => ({
  integrationId: id, vendorName: id, cpi, currency: "GBP", capacity,
  rejectionRate: 8, duplicateRate: 1, deliveryDays: 3,
  qualityScore: 80, qualityConfidence: "high", source: "historical",
});

const obs = (over: Partial<ObservedVendor> = {}): ObservedVendor => ({
  integrationId: "slow", market: "GB", ordered: 1000, delivered: 0, accepted: 0, rejected: 0,
  assumedRejectionRate: 8, cpi: 5, currency: "GBP", ...over,
});

const input = (over: Partial<ReallocationInput> = {}): ReallocationInput => ({
  elapsedFraction: 0.8,
  observed: [],
  candidates: [{ market: "GB", candidates: [cand("alt", 6)] }],
  budget: 20000, committed: 5000, currency: "GBP", strategy: "balanced",
  ...over,
});

test("a vendor behind pace is caught, and the shortfall is the PROJECTED gap not today's", () => {
  // 300 of 1,000 with 80% of the field gone ⇒ on track for ~375, so 625 short — not the 500 gap against pro-rata.
  const d = detectDeviations(input({ observed: [obs({ accepted: 300 })] }));
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "pace");
  assert.equal(d[0].shortfall, 625);
  assert.match(d[0].detail, /on track for about 375/);
});

test("a vendor ahead of pace, or inside tolerance, raises nothing", () => {
  assert.deepEqual(detectDeviations(input({ observed: [obs({ accepted: 900 })] })), []);
  // 600 of 1,000 at 80% elapsed is 75% of pro-rata — behind, but inside the 70% tolerance.
  assert.deepEqual(detectDeviations(input({ observed: [obs({ accepted: 600 })] })), []);
});

test("behind with time left is a watch; the same gap with no time left is an act", () => {
  // 300 of 1,000 at the halfway mark: 60% of pro-rata, and half the field period still to run.
  const early = detectDeviations(input({ elapsedFraction: 0.5, observed: [obs({ accepted: 300 })] }));
  assert.equal(early.length, 1);
  assert.equal(early[0].severity, "watch", "they can still pick up");
  assert.equal(early[0].shortfall, 400);

  // The same 60% of pro-rata, but only a fifth of the period remains: recovering 400 would need four times
  // their own observed rate. That is not a vendor running late, it is a vendor that will not finish.
  const late = detectDeviations(input({ elapsedFraction: 0.9, observed: [obs({ accepted: 540 })] }));
  assert.equal(late[0].severity, "act");
  assert.match(late[0].detail, /Too little of the field period remains/);
});

test("the first tenth of the field period is a launch, not a trend", () => {
  // 0 of 1,000 at 5% elapsed would be 'stalled' on a naive reading. It is simply early.
  assert.deepEqual(detectDeviations(input({ elapsedFraction: 0.05, observed: [obs({ accepted: 0 })] })), []);
  const later = detectDeviations(input({ elapsedFraction: 0.3, observed: [obs({ accepted: 0 })] }));
  assert.equal(later[0].kind, "stalled", "a quarter of the way in with nothing delivered is a different claim");
  assert.equal(later[0].shortfall, 1000, "the whole order is unsourced");
});

test("quality is judged on the OPTIMISTIC bound — be sure before accusing a supplier", () => {
  // 6 rejections in 40 screened is 15% against 8% assumed, but the interval runs from ~7% to ~29%.
  // The point estimate alone would call this; the low bound does not.
  const soft = detectDeviations(input({
    elapsedFraction: 0.5, observed: [obs({ accepted: 34, rejected: 6, ordered: 100 })],
  })).filter((x) => x.kind === "quality");
  assert.deepEqual(soft, [], "a 40-complete sample cannot establish a 7-point deterioration");
  // 6/40 and 300/2,000 are the SAME 15% point estimate. Only the second is evidence.

  // The same rate over 2,000 screened can.
  const hard = detectDeviations(input({
    elapsedFraction: 0.5, observed: [obs({ accepted: 1700, rejected: 300, ordered: 2000 })],
  })).filter((x) => x.kind === "quality");
  assert.equal(hard.length, 1);
  assert.match(hard[0].detail, /at least 13\.\d%|at least 1[3-4]/);
});

test("fewer than thirty screened never raises a quality deviation at all", () => {
  const d = detectDeviations(input({
    elapsedFraction: 0.5, observed: [obs({ accepted: 10, rejected: 19, ordered: 100 })],
  })).filter((x) => x.kind === "quality");
  assert.deepEqual(d, [], "a 65% rejection rate over 29 screened is still 29 screened");
});

test("a 'watch' is reported but moves nothing — an alert that rewrites the plan is worse than no alert", () => {
  const p = proposeReallocation(input({ elapsedFraction: 0.5, observed: [obs({ accepted: 300 })] }));
  assert.equal(p.deviations.length, 1);
  assert.equal(p.deviations[0].severity, "watch");
  assert.deepEqual(p.reSource, []);
  assert.equal(p.revisedPlan, null);
  assert.match(p.notes[0], /Watch, do not act yet/);
});

test("an 'act' deviation produces a costed plan that excludes the failing vendor", () => {
  const p = proposeReallocation(input({
    elapsedFraction: 0.8,
    observed: [obs({ integrationId: "slow", accepted: 100 })],
    candidates: [{ market: "GB", candidates: [cand("slow", 5), cand("alt", 6)] }],
  }));
  assert.equal(p.deviations[0].severity, "act");
  assert.deepEqual(p.reSource, [{ market: "GB", completes: 875 }]);
  assert.ok(p.revisedPlan);
  const ids = p.revisedPlan!.rows.map((r) => r.integrationId);
  assert.ok(!ids.includes("slow"), "a vendor that cannot deliver its order is not a candidate for more of it");
  assert.deepEqual(ids, ["alt"]);
});

test("the revised plan is costed against HEADROOM, never against the whole budget", () => {
  const p = proposeReallocation(input({
    budget: 20000, committed: 18000,
    elapsedFraction: 0.8, observed: [obs({ accepted: 100 })],
  }));
  assert.equal(p.headroom, 2000);
  assert.ok(p.revisedPlan);
  assert.ok(p.revisedPlan!.totalCost <= 2000, `spent ${p.revisedPlan!.totalCost} of 2,000 uncommitted`);
  assert.equal(p.revisedPlan!.feasible, false, "875 completes at £6 does not fit £2,000, and it says so");
  assert.match(p.notes.join(" "), /does not cover re-sourcing/);
});

test("nowhere to move the work to is said plainly, not routed around", () => {
  const p = proposeReallocation(input({
    elapsedFraction: 0.8, observed: [obs({ integrationId: "only", accepted: 100 })],
    candidates: [{ market: "GB", candidates: [cand("only", 5)] }],
  }));
  assert.equal(p.revisedPlan, null);
  assert.match(p.notes[0], /Extending the deadline or raising the incentive/);
});

test("nothing is ever applied — the proposal says so in its type and in words", () => {
  const p = proposeReallocation(input({ elapsedFraction: 0.8, observed: [obs({ accepted: 100 })] }));
  assert.equal(p.requiresApproval, true);
  assert.match(p.notes.join(" "), /Nothing has been ordered/);
});

test("deviations are ordered deterministically", () => {
  const observed = [
    obs({ integrationId: "zz", market: "US", accepted: 50 }),
    obs({ integrationId: "aa", market: "US", accepted: 50 }),
    obs({ integrationId: "mm", market: "GB", accepted: 50 }),
  ];
  const once = detectDeviations(input({ observed })).map((d) => `${d.market}:${d.integrationId}`);
  const twice = detectDeviations(input({ observed: [...observed].reverse() })).map((d) => `${d.market}:${d.integrationId}`);
  assert.deepEqual(once, ["GB:mm", "US:aa", "US:zz"]);
  assert.deepEqual(once, twice, "input order must not change the output");
});

test("delivery progress is arithmetic, kept separate from judgement", () => {
  const p = deliveryProgress([
    obs({ ordered: 600, accepted: 300, rejected: 30, spend: 1500 }),
    obs({ ordered: 400, accepted: 100, rejected: 20, spend: 500 }),
  ]);
  assert.deepEqual(p, { ordered: 1000, accepted: 400, rejected: 50, fill: 0.4, rejectionRate: 11.11, spend: 2000 });
  assert.equal(deliveryProgress([]).rejectionRate, null, "nothing screened is not a rate of zero");
});

/* ---------------------------------------------------------------- the assumed rate (audit 2026-11-05, calculation defect 1) */

test("the assumed rejection rate is read from the allocation's rationale, not inverted out of the yield", () => {
  // 1,000 at 8% rejection, 4% duplicates → expectedValid = floor(1000 × .92 × .96) = 883
  const row = { allocated_completes: 1000, expected_valid_completes: 883, rationale: { rejectionRate: 8, duplicateRate: 4, yield: 0.8832 } };
  assert.equal(assumedRejectionOfAllocation(row), 8);
});

test("a vendor running at 15% against an 8% quote is now flagged (the inversion put the bar at 16.7%)", () => {
  const row = { allocated_completes: 1000, expected_valid_completes: 883, rationale: { rejectionRate: 8, duplicateRate: 4 } };
  const inverted = ((1000 - 883) / 1000) * 100; // what the Studio used to derive: 11.7
  assert.ok(inverted > 11 && inverted < 12);
  const v = (assumed: number): ObservedVendor => ({ integrationId: "v", market: "GB", ordered: 2000, delivered: 2000, accepted: 1700, rejected: 300, assumedRejectionRate: assumed, cpi: 3, currency: "GBP" });
  const input = (assumed: number): ReallocationInput => ({ observed: [v(assumed)], candidates: [], elapsedFraction: 0.5, qualityTolerance: 5, budget: 10000, committed: 3000, currency: "GBP", strategy: "balanced" });
  assert.ok(!detectDeviations(input(inverted)).some((d) => d.kind === "quality"), "the lossy derivation missed it");
  assert.ok(detectDeviations(input(assumedRejectionOfAllocation(row)!)).some((d) => d.kind === "quality"), "the stored rate catches it");
});

test("a row allocated before the rationale carried the rate falls back to the inversion, corrected for duplicates when known", () => {
  assert.equal(assumedRejectionOfAllocation({ allocated_completes: 1000, expected_valid_completes: 883, rationale: {} })?.toFixed(1), "11.7");
  assert.equal(assumedRejectionOfAllocation({ allocated_completes: 1000, expected_valid_completes: 883, rationale: { duplicateRate: 4 } })?.toFixed(1), "8.0");
  assert.equal(assumedRejectionOfAllocation({ allocated_completes: 0, expected_valid_completes: 0, rationale: {} }), null);
});
