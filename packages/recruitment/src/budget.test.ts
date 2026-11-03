import test from "node:test";
import assert from "node:assert/strict";
import { budgetState, canCommit, thresholdCrossed } from "./budget.js";

const base = { budget: 40000, committed: 0, spent: 0, accepted: 0, required: 5000 };

test("headroom is budget minus COMMITTED, not budget minus spent", () => {
  // three orders placed for 26,000; only 4,000 of it delivered so far
  const s = budgetState({ ...base, committed: 26000, spent: 4000, accepted: 500 });
  assert.equal(s.headroom, 14000, "what can still be promised");
  assert.equal(s.unspent, 36000, "shown, but promising against it would double-spend 22,000");
  assert.notEqual(s.headroom, s.unspent);
});

test("committing against headroom is refused with the numbers, not just a no", () => {
  const s = budgetState({ ...base, committed: 26000, spent: 4000, accepted: 500 });
  assert.deepEqual(canCommit(s, 14000), { ok: true });
  const no = canCommit(s, 20000);
  assert.equal(no.ok, false);
  assert.match(no.reason!, /20,000/);
  assert.match(no.reason!, /14,000 of the 40,000 budget is uncommitted/);
  assert.equal(canCommit(s, -5).ok, false);
});

test("a threshold is a crossing, not a state — it fires once", () => {
  assert.equal(thresholdCrossed(12000, 34000, 40000), true, "30% → 85% crosses 80%");
  assert.equal(thresholdCrossed(34000, 36000, 40000), false, "already past it");
  assert.equal(thresholdCrossed(0, 12000, 40000), false, "30% is not past 80%");
  assert.equal(thresholdCrossed(0, 100, 0), false, "no budget, no threshold");
  assert.equal(thresholdCrossed(0, 24000, 40000, 5000), true, "a 50% threshold crosses at 60%");
});

test("the actual cost per valid complete is what was paid, not what was quoted", () => {
  // 8,000 spent on 800 accepted is 10.00 each, whatever the CPI said
  const s = budgetState({ ...base, committed: 16000, spent: 8000, accepted: 800 });
  assert.equal(s.actualCostPerValidComplete, 10);
  assert.equal(s.remaining, 4200);
});

test("nothing accepted yet means no rate to extrapolate from — the plan's figure is used instead", () => {
  const none = budgetState({ ...base, committed: 16000 });
  assert.equal(none.actualCostPerValidComplete, null);
  assert.equal(none.projectedFinalCost, null);
  assert.match(none.summary, /nothing delivered yet/);

  const planned = budgetState({ ...base, committed: 16000, plannedCostPerValidComplete: 7.5 });
  assert.equal(planned.projectedFinalCost, 37500, "5,000 × 7.50");
  assert.equal(planned.projectedOverrun, 0);
});

test("fifty completes is an anecdote, not a rate — the plan's figure still governs", () => {
  // paying 20.00 each over 50 completes would project a 100,000 project and cry wolf on every study's first hour
  const s = budgetState({ ...base, committed: 16000, spent: 1000, accepted: 50, plannedCostPerValidComplete: 7.5 });
  assert.equal(s.actualCostPerValidComplete, 20, "the observed rate is still reported");
  assert.equal(s.projectedFinalCost, 38125, "but the projection uses the planned 7.50 for the remaining 4,950");
  assert.equal(s.projectedOverrun, 0);
});

test("once there is enough of it, the rate actually being paid drives the projection", () => {
  // 1,000 accepted at 10.00 against a plan of 7.50: the project is heading for an overrun and should say so
  const s = budgetState({ ...base, committed: 30000, spent: 10000, accepted: 1000, plannedCostPerValidComplete: 7.5 });
  assert.equal(s.actualCostPerValidComplete, 10);
  assert.equal(s.projectedFinalCost, 50000, "10,000 spent + 4,000 remaining × 10.00");
  assert.equal(s.projectedOverrun, 10000);
  assert.match(s.summary, /about 50,000/);
  assert.match(s.summary, /10,000 over the 40,000 budget/);
});

test("the summary leads with the most serious true thing", () => {
  const overrun = budgetState({ ...base, committed: 34000, spent: 10000, accepted: 1000, plannedCostPerValidComplete: 7.5 });
  assert.match(overrun.summary, /over the 40,000 budget/, "a projected overrun outranks a threshold crossing");

  const threshold = budgetState({ ...base, committed: 34000, spent: 4000, accepted: 1000, plannedCostPerValidComplete: 4 });
  assert.equal(threshold.overThreshold, true);
  assert.match(threshold.summary, /85% of the 40,000 budget is committed/);

  const over = budgetState({ ...base, committed: 44000 });
  assert.equal(over.overCommitted, true);
  assert.match(over.summary, /4,000 more than was authorised/);
});

test("shares are basis points, and a zero budget never divides by zero", () => {
  const s = budgetState({ ...base, committed: 34000, spent: 10000, accepted: 1000 });
  assert.equal(s.committedBps, 8500);
  assert.equal(s.spentBps, 2500);
  assert.equal(s.overThreshold, true);

  const zero = budgetState({ ...base, budget: 0, committed: 100 });
  assert.equal(zero.committedBps, 0);
  assert.equal(zero.overThreshold, false);
  assert.equal(zero.headroom, -100);
});

test("a finished project is not reported as needing more", () => {
  const s = budgetState({ ...base, committed: 36000, spent: 36000, accepted: 5000 });
  assert.equal(s.remaining, 0);
  assert.equal(s.projectedFinalCost, 36000);
  assert.equal(s.projectedOverrun, 0);
});
