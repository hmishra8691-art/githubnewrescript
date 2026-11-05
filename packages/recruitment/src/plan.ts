import type { AllocationCandidate } from "./allocate.js";
import { allocate } from "./allocate.js";
import { resolveMargin, sellingPrice, priceBreakdown, type MarginRule, type PriceBreakdown } from "./margin.js";
import { round2 } from "./pricing.js";

/**
 * THE RECRUITMENT PLANNING ENGINE.
 *
 * Six answers in — how many completes, what budget, how long the survey is, what incidence is expected, which
 * markets, and by when — and one answer out: can this be done, and what does it cost.
 *
 * It composes rather than replaces. The optimiser decides who supplies what; the margin engine turns an
 * acquisition cost into a price; this file asks the three questions a researcher actually has and refuses to
 * answer any of them from a guess.
 *
 * ## The budget test is against the PRICE, not the cost
 *
 * The researcher's budget is what THEY will pay, which includes the margin. Testing the acquisition cost
 * against it passes projects that are then quoted above the budget they were approved against — a £7,000 cost
 * fits a £8,000 budget, and at a 30% margin it is sold for £10,000. The test here is `price ≤ budget`, and the
 * optimiser is given the cost ceiling that corresponds to it.
 *
 * ## Four verdicts, and an honest fifth
 *
 *   achievable        the plan fills every market inside budget and inside the deadline
 *   over_budget       capacity exists; the money does not reach
 *   too_fast          the money reaches; the deadline does not
 *   short_of_capacity no combination of sources can supply the completes at all
 *   cannot_price      nobody has a rate for a market asked for — NOT the same as infeasible, and the only
 *                     honest answer when the inputs have never been priced
 *
 * `cannot_price` is the one that matters most today, because most markets have no rate card. Reporting them as
 * infeasible would tell a researcher their project is impossible when the truth is that nobody has entered a
 * price yet.
 */

export type PlanVerdict = "achievable" | "over_budget" | "too_fast" | "short_of_capacity" | "cannot_price";

export interface PlanRequest {
  requiredCompletes: number;
  /** what the researcher is approved to spend — the PRICE ceiling, margin included */
  budget: number;
  currency: string;
  loiMinutes: number;
  expectedIr: number;
  /** ISO alpha-2, with the completes split between them */
  markets: ReadonlyArray<{ market: string; completes: number }>;
  timelineDays: number;
}

export interface PlanMarketView {
  market: string;
  required: number;
  planned: number;
  shortfall: number;
  expectedDeliveryDays: number | null;
  priced: boolean;
}

export interface RecruitmentPlan {
  verdict: PlanVerdict;
  /** one sentence a researcher can act on */
  summary: string;
  /** the specific things standing in the way, each naming what would fix it */
  blockers: string[];
  markets: PlanMarketView[];
  /** null when nothing could be priced */
  pricing: PriceBreakdown | null;
  /**
   * What the sample ASKED FOR would cost, unconstrained by budget — the figure an over-budget plan needs to
   * report. `pricing.price` is the price of the trimmed plan, which by construction always fits the budget.
   */
  fullPrice: number | null;
  /** the longest market, which is what the project actually takes */
  expectedDeliveryDays: number | null;
  totalShortfall: number;
  /** how many distinct sources stand behind it — for the abstraction layer's capacity word, never shown raw */
  sourceCount: number;
}

const pounds = (n: number, ccy: string) => `${ccy} ${round2(n).toLocaleString()}`;

/**
 * Plan one project.
 *
 * `candidates` is per market; a market absent from it has no priced source, which is `cannot_price` rather
 * than a zero-capacity market. The two look identical in a naive implementation and mean opposite things to
 * the person reading the answer.
 */
export function planRecruitment(
  req: PlanRequest,
  candidates: ReadonlyArray<{ market: string; candidates: AllocationCandidate[] }>,
  marginRules: readonly MarginRule[] = [],
  opts: { recruitmentProjectId?: string; recruitmentType?: string; at?: string } = {},
): RecruitmentPlan {
  const byMarket = new Map(candidates.map((c) => [c.market, c.candidates]));
  const asked = req.markets.filter((m) => m.completes > 0);

  const unpriced = asked.filter((m) => (byMarket.get(m.market) ?? []).length === 0).map((m) => m.market);
  const priceable = asked.filter((m) => (byMarket.get(m.market) ?? []).length > 0);

  if (!priceable.length) {
    return {
      verdict: "cannot_price",
      summary: unpriced.length
        ? `No recruitment capacity has been priced for ${unpriced.join(", ")}, so this cannot be costed yet.`
        : "No markets were specified, so there is nothing to plan.",
      blockers: unpriced.map((m) => `${m} has no priced recruitment capacity. An administrator needs to configure a source for it.`),
      markets: asked.map((m) => ({
        market: m.market, required: m.completes, planned: 0, shortfall: m.completes,
        expectedDeliveryDays: null, priced: false,
      })),
      pricing: null, fullPrice: null, expectedDeliveryDays: null,
      totalShortfall: asked.reduce((s, m) => s + m.completes, 0),
      sourceCount: 0,
    };
  }

  /*
   * The margin is resolved ONCE, for the project, and the cost ceiling derived from it. Resolving per market
   * would be more precise and would also mean the budget could not be checked at all until after allocation —
   * the ceiling depends on the rate, and the rate would depend on which markets were filled.
   */
  const resolved = resolveMargin(marginRules, {
    recruitmentProjectId: opts.recruitmentProjectId ?? null,
    recruitmentType: opts.recruitmentType ?? null,
    at: opts.at,
  });
  const costCeiling = round2(req.budget * (1 - resolved.marginBps / 10_000));

  /*
   * WHICH CONSTRAINT ACTUALLY BINDS.
   *
   * A shortfall on its own says nothing: the optimiser produces one when the money runs out, when the deadline
   * excludes every fast-enough source, AND when there are simply not enough people — three different problems
   * with three different fixes, and identical output. The first version of this file read every shortfall as
   * missing people, which would have told a researcher with a £3,000 budget that the sample does not exist.
   *
   * So the plan is solved three times, relaxing one constraint at a time. Each solve is deterministic and
   * cheap, and the answer is a diagnosis rather than a guess at one.
   */
  const marketInputs = priceable.map((m) => ({
    market: m.market, required: m.completes, candidates: byMarket.get(m.market) ?? [],
  }));
  const UNLIMITED = Number.MAX_SAFE_INTEGER / 1024;

  // 1. no budget, no deadline: is the sample there at all?
  const uncapped = allocate({
    markets: marketInputs, budget: UNLIMITED, currency: req.currency, strategy: "balanced",
  });
  // 2. no budget, real deadline: does the deadline alone exclude what is needed?
  const timed = allocate({
    markets: marketInputs, budget: UNLIMITED, currency: req.currency, strategy: "balanced",
    deadlineDays: req.timelineDays,
  });
  // 3. the real plan
  const result = allocate({
    markets: marketInputs, budget: costCeiling, currency: req.currency, strategy: "balanced",
    deadlineDays: req.timelineDays,
  });

  const peopleShort = uncapped.shortfall > 0;
  const deadlineShort = !peopleShort && timed.shortfall > 0;
  const moneyShort = !peopleShort && !deadlineShort && result.shortfall > 0;

  const marketViews: PlanMarketView[] = [
    ...result.markets.map((m) => ({
      market: m.market, required: m.required, planned: m.allocated, shortfall: m.shortfall,
      expectedDeliveryDays: m.expectedDeliveryDays, priced: true,
    })),
    ...unpriced.map((code) => {
      const ask = asked.find((a) => a.market === code)!;
      return {
        market: code, required: ask.completes, planned: 0, shortfall: ask.completes,
        expectedDeliveryDays: null, priced: false,
      };
    }),
  ].sort((a, b) => a.market.localeCompare(b.market));

  const pricing = priceBreakdown(result.totalCost, result.totalCompletes, req.currency, resolved);
  const slowest = marketViews.reduce<number | null>(
    (worst, m) => (m.expectedDeliveryDays === null ? worst : worst === null ? m.expectedDeliveryDays : Math.max(worst, m.expectedDeliveryDays)),
    null,
  );
  const totalShortfall = marketViews.reduce((s, m) => s + m.shortfall, 0);
  const blockers: string[] = [];

  for (const code of unpriced) {
    blockers.push(`${code} has no priced recruitment capacity, so none of its ${asked.find((a) => a.market === code)!.completes.toLocaleString()} completes are in this plan.`);
  }

  /*
   * Over budget is tested on the PRICE. The optimiser was already held to the cost ceiling, so reaching here
   * with a shortfall and a full ceiling means the money ran out rather than the supply.
   */
  /*
   * Over budget is reported from the DIAGNOSIS, not from comparing the trimmed plan's price to the budget —
   * the optimiser has already trimmed it to fit, so that comparison always passes and never reports anything.
   * What the researcher needs is the price of the plan they asked for.
   */
  const fullPrice = sellingPrice(uncapped.totalCost, resolved.marginBps);

  if (moneyShort) {
    blockers.push(`Filling this needs ${pounds(fullPrice, req.currency)}, which is ${pounds(fullPrice - req.budget, req.currency)} over the approved budget.`);
  }
  if (deadlineShort) {
    const fastest = timed.markets.find((m) => m.shortfall > 0)?.market ?? "one of the markets";
    blockers.push(`A ${req.timelineDays}-day timeline excludes the capacity needed in ${fastest}. The sample exists; it cannot arrive that quickly.`);
  }
  if (peopleShort) {
    blockers.push(`${uncapped.shortfall.toLocaleString()} completes cannot be supplied by the sources available, at any price or timeline.`);
  }
  if (slowest !== null && slowest > req.timelineDays && !deadlineShort && !peopleShort && !moneyShort) {
    blockers.push(`The slowest market takes about ${slowest.toFixed(0)} days, against a ${req.timelineDays}-day timeline.`);
  }

  /*
   * One verdict, ordered by which lever the researcher would have to pull. Capacity first: no amount of money
   * or time fixes people who are not there. Then the deadline, then the money.
   */
  const verdict: PlanVerdict =
    peopleShort ? "short_of_capacity"
    : deadlineShort || (slowest !== null && slowest > req.timelineDays) ? "too_fast"
    : moneyShort ? "over_budget"
    : unpriced.length ? "cannot_price"
    : "achievable";

  const summary =
    verdict === "achievable"
      ? `${result.totalCompletes.toLocaleString()} completes across ${result.markets.length} ${result.markets.length === 1 ? "market" : "markets"} for ${pounds(pricing.price, req.currency)}, in about ${slowest === null ? "an unknown number of" : slowest.toFixed(0)} days.`
      : verdict === "over_budget"
        ? `This is achievable but not within ${pounds(req.budget, req.currency)} — it needs ${pounds(fullPrice, req.currency)}.`
        : verdict === "too_fast"
          ? `The sample is available and affordable, but not within ${req.timelineDays} days.`
          : verdict === "short_of_capacity"
            ? `The sources available cannot supply ${uncapped.shortfall.toLocaleString()} of the ${req.requiredCompletes.toLocaleString()} completes asked for.`
            : `Part of this cannot be costed yet: ${unpriced.join(", ")} ${unpriced.length === 1 ? "has" : "have"} no priced capacity.`;

  return {
    verdict, summary, blockers, markets: marketViews,
    pricing, fullPrice: round2(fullPrice), expectedDeliveryDays: slowest, totalShortfall,
    sourceCount: new Set(result.rows.map((r) => r.integrationId)).size,
  };
}

/**
 * What raising the budget would buy, for the §9 recommendation engine.
 *
 * Returns null when more money would not help — a project short of capacity is short of PEOPLE, and telling a
 * researcher to spend more would be advice that cannot work.
 */
export function budgetHeadroomAdvice(
  plan: RecruitmentPlan, req: PlanRequest, marginRules: readonly MarginRule[] = [],
): { suggestedBudget: number; because: string } | null {
  if (plan.verdict !== "over_budget" || plan.fullPrice === null) return null;
  const needed = plan.fullPrice;
  if (!(needed > req.budget)) return null;
  const uplift = Math.ceil(((needed - req.budget) / req.budget) * 100);
  return {
    suggestedBudget: round2(needed),
    because: `About ${uplift}% more budget — ${pounds(needed, req.currency)} — would cover the full sample.`,
  };
}
