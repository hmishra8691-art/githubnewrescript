import test from "node:test";
import assert from "node:assert/strict";
import { recommend, incidenceNote, type AdviceContext } from "./advice.js";
import { planRecruitment, type PlanRequest } from "./plan.js";
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
const ctx = (candidates: AdviceContext["candidates"]): AdviceContext => ({ candidates, marginRules: margin30 });

const advise = (r: PlanRequest, c: AdviceContext) => recommend(planRecruitment(r, c.candidates, c.marginRules ?? []), r, c);

test("an achievable plan gets no recommendations — there is nothing to fix", () => {
  const r = req({ budget: 20_000 });
  assert.deepEqual(advise(r, ctx([{ market: "GB", candidates: [cand("a", 5)] }])), []);
});

test("an over-budget plan is told the SMALLEST budget that works, not a round guess", () => {
  const r = req({ budget: 3000 });
  const recs = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5)] }]));
  const raise = recs.find((x) => x.kind === "raise_budget")!;
  assert.ok(raise, "an over-budget plan gets budget advice");
  assert.equal(raise.resultingVerdict, "achievable", "the figure was re-planned, not written");
  assert.ok(raise.patch.budget! <= 7142.87, "and it is no more than the full price");
  assert.ok(raise.patch.budget! > 3000);
});

test("the suggested budget actually works when applied", () => {
  const r = req({ budget: 3000 });
  const c = ctx([{ market: "GB", candidates: [cand("a", 5)] }]);
  const raise = advise(r, c).find((x) => x.kind === "raise_budget")!;
  const after = planRecruitment({ ...r, ...raise.patch }, c.candidates, c.marginRules ?? []);
  assert.equal(after.verdict, "achievable", "accepting the advice must produce the promised result");
});

test("a project short of PEOPLE is never told to spend more", () => {
  /*
   * The recommendation that is obvious, wrong, and costs a researcher a day to discover. Capacity is 300 at
   * any price; more budget changes nothing.
   */
  const r = req({ budget: 100_000 });
  const recs = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5, 300)] }]));
  assert.equal(recs.find((x) => x.kind === "raise_budget"), undefined);
  assert.match(recs.find((x) => x.kind === "reduce_completes")!.detail, /will not change this/);
});

test("…and is told what the network can actually supply", () => {
  const r = req({ budget: 100_000 });
  const rec = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5, 300)] }]))
    .find((x) => x.kind === "reduce_completes")!;
  assert.equal(rec.patch.requiredCompletes, 300);
  assert.equal(rec.resultingVerdict, "achievable");
});

test("a deadline problem is told the shortest timeline that works", () => {
  const r = req({ budget: 50_000, timelineDays: 2 });
  const rec = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5, 10_000, 9)] }]))
    .find((x) => x.kind === "extend_timeline")!;
  assert.ok(rec, "a too-fast plan gets timeline advice");
  assert.ok(rec.patch.timelineDays! >= 9, "it must be at least as long as delivery takes");
  assert.ok(rec.patch.timelineDays! <= 12, `and close to it, not an arbitrary round number: ${rec.patch.timelineDays}`);
  assert.equal(rec.resultingVerdict, "achievable");
  assert.match(rec.detail, /Nothing else needs to change/);
});

test("an over-budget plan ALSO gets the answer for a budget that cannot move", () => {
  const r = req({ budget: 3000 });
  const rec = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5)] }]))
    .find((x) => x.kind === "reduce_completes")!;
  assert.ok(rec, "not every researcher can raise a budget");
  assert.ok(rec.patch.requiredCompletes! > 0 && rec.patch.requiredCompletes! < 1000);
  assert.match(rec.detail, /what it buys at the current rates/);
});

test("an unpriced market can be dropped, and the drop is costed", () => {
  const r = req({ markets: [{ market: "GB", completes: 500 }, { market: "ZZ", completes: 500 }], budget: 20_000 });
  const recs = advise(r, ctx([{ market: "GB", candidates: [cand("a", 5)] }]));
  const drop = recs.find((x) => x.kind === "drop_market")!;
  assert.deepEqual(drop.patch.markets, [{ market: "GB", completes: 500 }]);
  assert.equal(drop.patch.requiredCompletes, 500);
  assert.equal(drop.resultingVerdict, "achievable");
});

test("…and pricing it is offered as the alternative, without pretending to know the price", () => {
  const r = req({ markets: [{ market: "ZZ", completes: 500 }] });
  const rec = advise(r, ctx([])).find((x) => x.kind === "price_market")!;
  assert.ok(rec);
  assert.deepEqual(rec.patch, {}, "nothing the researcher can apply themselves — this needs an administrator");
  assert.match(rec.headline, /Ask an administrator/);
});

test("every recommendation carries a patch that can be applied without retyping", () => {
  const r = req({ budget: 3000 });
  for (const rec of advise(r, ctx([{ market: "GB", candidates: [cand("a", 5)] }]))) {
    assert.ok(typeof rec.patch === "object", "a recommendation with nothing to apply is advice, not a button");
    assert.ok(rec.headline.length > 10 && rec.detail.length > 20);
  }
});

test("no recommendation is offered whose own re-plan does not improve the verdict", () => {
  // nothing can fix this: one tiny source, no money, no time
  const r = req({ budget: 10, timelineDays: 1 });
  const recs = advise(r, ctx([{ market: "GB", candidates: [cand("a", 50, 5, 40)] }]));
  for (const rec of recs) {
    assert.notEqual(rec.resultingVerdict, undefined);
    if (rec.kind === "raise_budget" || rec.kind === "extend_timeline") {
      assert.equal(rec.resultingVerdict, "achievable", "a suggestion that does not work is not shown");
    }
  }
});

test("recommendations are deterministic", () => {
  const r = req({ budget: 3000 });
  const c = ctx([{ market: "GB", candidates: [cand("a", 5)] }]);
  assert.deepEqual(advise(r, c), advise(r, c));
});

/* ------------------------------------------------------------ the incidence note */

test("the incidence note is a FACT about the quote, not a guess about the audience", () => {
  assert.equal(incidenceNote(20, { irMin: 10, irMax: 25 }), null, "they agree — nothing to say");
  assert.match(incidenceNote(35, { irMin: 10, irMax: 25 })!, /priced for a harder audience than yours/);
  assert.match(incidenceNote(5, { irMin: 10, irMax: 25 })!, /usually costs more per complete, not less/);
  assert.equal(incidenceNote(35, null), null, "no band, no claim");
});
