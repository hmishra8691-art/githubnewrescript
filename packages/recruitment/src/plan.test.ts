import test from "node:test";
import assert from "node:assert/strict";
import { planRecruitment, budgetHeadroomAdvice, type PlanRequest } from "./plan.js";
import type { AllocationCandidate } from "./allocate.js";
import type { MarginRule } from "./margin.js";

const cand = (id: string, cpi: number, capacity: number | null = 10_000, deliveryDays = 5): AllocationCandidate => ({
  integrationId: id, vendorName: id, cpi, currency: "GBP", capacity,
  rejectionRate: 5, duplicateRate: 1, deliveryDays,
  qualityScore: 85, qualityConfidence: "high", source: "historical",
});

const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({
  requiredCompletes: 1000, budget: 10_000, currency: "GBP",
  loiMinutes: 15, expectedIr: 35,
  markets: [{ market: "GB", completes: 1000 }],
  timelineDays: 10, ...over,
});

const margin30: MarginRule[] = [{ id: "d", scope: "default", marginBps: 3000 }];

test("an affordable, available, timely plan reads as achievable", () => {
  const p = planRecruitment(
    req(), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.verdict, "achievable");
  assert.equal(p.markets[0].planned, 1000);
  assert.equal(p.markets[0].shortfall, 0);
  assert.match(p.summary, /1,000 completes across 1 market/);
  assert.deepEqual(p.blockers, []);
});

test("the budget is tested against the PRICE, not the acquisition cost", () => {
  /*
   * The bug this pins. 1,000 completes at £5 is £5,000 of cost, which fits a £6,000 budget — but at a 30%
   * margin it sells for £7,143, which does not. Testing the cost would approve a project that is then quoted
   * above the budget it was approved against.
   */
  const p = planRecruitment(
    req({ budget: 6000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.notEqual(p.verdict, "achievable", "a £5,000 cost does not make a £6,000 budget workable at 30% margin");
  assert.ok(p.pricing!.price <= 6000 + 0.01 || p.verdict === "over_budget");
});

test("…and the price the researcher sees carries the margin", () => {
  const p = planRecruitment(
    req({ budget: 20_000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.pricing!.cost, 5000, "1,000 × £5");
  assert.equal(p.pricing!.price, 7142.86, "£5,000 ÷ 0.70");
  assert.equal(p.pricing!.marginBps, 3000);
});

test("a market nobody has priced is 'cannot price', NOT infeasible", () => {
  const p = planRecruitment(
    req({ markets: [{ market: "ZZ", completes: 500 }] }), [], margin30);
  assert.equal(p.verdict, "cannot_price");
  assert.equal(p.pricing, null);
  assert.match(p.blockers[0], /no priced recruitment capacity/);
  assert.match(p.blockers[0], /administrator needs to configure a source/);
  assert.ok(!/impossible|infeasible/i.test(p.summary), "nobody has entered a price — that is not the same as impossible");
});

test("a partly priced project reports what IS planned and what cannot be costed", () => {
  const p = planRecruitment(
    req({ markets: [{ market: "GB", completes: 500 }, { market: "ZZ", completes: 500 }] }),
    [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.verdict, "cannot_price");
  const gb = p.markets.find((m) => m.market === "GB")!;
  const zz = p.markets.find((m) => m.market === "ZZ")!;
  assert.equal(gb.priced, true);
  assert.equal(gb.planned, 500, "the priced half is still planned");
  assert.equal(zz.priced, false);
  assert.equal(zz.planned, 0);
  assert.ok(p.pricing, "and the priced half is still costed");
});

test("not enough people is reported as capacity, not as money", () => {
  const p = planRecruitment(
    req({ budget: 100_000 }), [{ market: "GB", candidates: [cand("a", 5, 300)] }], margin30);
  assert.equal(p.verdict, "short_of_capacity");
  assert.equal(p.totalShortfall, 700);
  assert.match(p.blockers.join(" "), /at any price/, "more budget would not fix this, and it says so");
});

test("too little money is reported as money, with the figure", () => {
  const p = planRecruitment(
    req({ budget: 3000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.verdict, "over_budget");
  assert.match(p.blockers.join(" "), /over the approved budget/);
  assert.match(p.summary, /achievable but not within/);
});

test("a deadline shorter than delivery is its own verdict", () => {
  const p = planRecruitment(
    req({ budget: 50_000, timelineDays: 2 }),
    [{ market: "GB", candidates: [cand("a", 5, 10_000, 9)] }], margin30);
  assert.equal(p.verdict, "too_fast");
  const why = p.blockers.join(" ");
  assert.match(why, /2-day timeline/);
  assert.match(why, /sample exists/, "the distinction that matters: the people are there, the time is not");
  assert.ok(!/at any price/.test(why), "this is not a capacity problem and must not read as one");
});

test("short of capacity outranks over budget — raising the budget would not fix it", () => {
  const p = planRecruitment(
    req({ budget: 100 }), [{ market: "GB", candidates: [cand("a", 5, 50)] }], margin30);
  assert.equal(p.verdict, "short_of_capacity");
});

test("the timeline is the SLOWEST market, not an average", () => {
  const p = planRecruitment(
    req({ budget: 50_000, timelineDays: 30, markets: [{ market: "GB", completes: 500 }, { market: "US", completes: 500 }] }),
    [
      { market: "GB", candidates: [cand("a", 5, 10_000, 3)] },
      { market: "US", candidates: [cand("b", 5, 10_000, 12)] },
    ], margin30);
  assert.equal(p.expectedDeliveryDays, 12, "a project is as slow as its slowest market");
});

test("a market asked for with zero completes is ignored rather than blocking", () => {
  const p = planRecruitment(
    req({ markets: [{ market: "GB", completes: 1000 }, { market: "ZZ", completes: 0 }] }),
    [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.verdict, "achievable");
  assert.ok(!p.markets.some((m) => m.market === "ZZ"));
});

test("with no margin rule the platform default applies, and the price reflects it", () => {
  const p = planRecruitment(req({ budget: 20_000 }), [{ market: "GB", candidates: [cand("a", 5)] }], []);
  assert.equal(p.pricing!.marginBps, 3000, "the platform default");
  assert.match(p.pricing!.because, /No margin rule matched/);
});

test("a project-level margin beats the default and changes the verdict", () => {
  const rules: MarginRule[] = [
    { id: "d", scope: "default", marginBps: 3000 },
    { id: "p", scope: "override", marginBps: 1000, recruitmentProjectId: "proj1", note: "client deal" },
  ];
  const cheap = planRecruitment(
    req({ budget: 6000 }), [{ market: "GB", candidates: [cand("a", 5)] }], rules,
    { recruitmentProjectId: "proj1" });
  // at 10% margin £5,000 sells for £5,556 and fits; at 30% it would be £7,143 and would not
  assert.equal(cheap.verdict, "achievable");
  assert.equal(cheap.pricing!.marginBps, 1000);
});

test("the budget advice says what would help, and stays silent when nothing would", () => {
  const over = planRecruitment(req({ budget: 3000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  const advice = budgetHeadroomAdvice(over, req({ budget: 3000 }), margin30);
  assert.ok(advice, "an over-budget plan has advice");
  assert.ok(advice!.suggestedBudget > 3000);
  assert.match(advice!.because, /more budget/);

  const short = planRecruitment(req({ budget: 100_000 }), [{ market: "GB", candidates: [cand("a", 5, 300)] }], margin30);
  assert.equal(budgetHeadroomAdvice(short, req({ budget: 100_000 }), margin30), null,
    "a project short of PEOPLE cannot be fixed with money, so there is no advice to give");
});

test("the source count is reported for the abstraction layer, never a vendor name", () => {
  const p = planRecruitment(
    req({ budget: 50_000 }),
    [{ market: "GB", candidates: [cand("a", 5, 600), cand("b", 6, 600)] }], margin30);
  assert.ok(p.sourceCount >= 1);
  const text = JSON.stringify({ verdict: p.verdict, summary: p.summary, blockers: p.blockers, markets: p.markets });
  assert.ok(!text.includes("\"a\"") || !/vendorName/.test(text), "no supplier identity in the researcher-visible parts");
});

test("the three causes of a shortfall are told apart, not collapsed", () => {
  /*
   * The bug this pins. The optimiser produces a shortfall when the money runs out, when the deadline excludes
   * every fast-enough source, and when there are genuinely not enough people. All three looked identical, and
   * every one was reported as missing people — which would tell a researcher with a small budget that the
   * sample does not exist.
   */
  const money = planRecruitment(req({ budget: 3000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  const time = planRecruitment(
    req({ budget: 50_000, timelineDays: 2 }),
    [{ market: "GB", candidates: [cand("a", 5, 10_000, 9)] }], margin30);
  const people = planRecruitment(
    req({ budget: 100_000 }), [{ market: "GB", candidates: [cand("a", 5, 300)] }], margin30);

  assert.equal(money.verdict, "over_budget");
  assert.equal(time.verdict, "too_fast");
  assert.equal(people.verdict, "short_of_capacity");
  assert.equal(new Set([money.verdict, time.verdict, people.verdict]).size, 3, "three causes, three answers");
});

test("an over-budget plan reports the price of what was ASKED for, not of the trimmed plan", () => {
  /*
   * The optimiser trims to fit the ceiling, so the trimmed plan's price always fits the budget. Reporting that
   * figure would tell a researcher their over-budget project costs exactly their budget.
   */
  const p = planRecruitment(req({ budget: 3000 }), [{ market: "GB", candidates: [cand("a", 5)] }], margin30);
  assert.equal(p.verdict, "over_budget");
  assert.ok(p.fullPrice! > 3000, `the full sample costs ${p.fullPrice}, which is the number to show`);
  assert.equal(p.fullPrice, 7142.86, "1,000 × £5 ÷ 0.70");
  assert.ok(p.pricing!.price <= 3000.01, "…while the trimmed plan does fit, which is why it cannot be the figure reported");
});
