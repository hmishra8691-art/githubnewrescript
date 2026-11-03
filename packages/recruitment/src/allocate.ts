import {
  STRATEGY_WEIGHTS, type AllocationMarketResult, type AllocationPlan, type AllocationRow,
  type AllocationStrategy, type PricingSource, type StrategyWeights,
} from "@rescript/schema";
import { costPerValidComplete, expectedValidCompletes, blendedCpi, round2, round4, validYield } from "./pricing.js";

/**
 * THE SAMPLE ALLOCATION OPTIMISER.
 *
 * Given what each vendor costs, how much it has and how well it has performed, decide how many completes to buy
 * from each, in each market, inside one budget and one deadline.
 *
 * Three properties matter more than squeezing out the last percent, because a human authorises the result and
 * then spends tens of thousands of pounds on it:
 *
 *   DETERMINISTIC   the same inputs always produce the same plan. No randomness, no map iteration order, no
 *                   floating-point tie-breaks — ties break on the vendor's integration id, which is stable.
 *   EXPLAINABLE     every row carries the arithmetic that produced it, and every excluded vendor carries the
 *                   reason it was excluded. A plan a researcher cannot interrogate is a plan they should not sign.
 *   HONEST          a vendor with no history is neither penalised nor trusted. It is scored on a PRIOR rather
 *                   than on its own thin numbers, and its share is capped. The brief's §24 asks for the first
 *                   half of that; the second half is what stops a vendor winning 40% of a project on one lucky week.
 *
 * ## The shape of the problem
 *
 * Per market: choose integer n(v) for each vendor v, minimising Σ score(v)·n(v), subject to Σ n(v) = required,
 * 0 ≤ n(v) ≤ capacity(v). That is a transportation problem with box constraints, and for a LINEAR objective the
 * greedy fill in ascending score order is exactly optimal — no search needed.
 *
 * What makes it interesting is the budget, which couples the markets: Σ over all markets of cost(v)·n(v) ≤ B.
 * With one coupling constraint the standard treatment is a Lagrangian: minimise score + λ·cost and raise λ until
 * the budget stops binding. Cost falls as λ rises, so the smallest feasible λ is found by bisection, and that λ
 * is reported as `costPressure` — because "we gave you cheaper vendors than your strategy asked for, in order to
 * fit your budget" is exactly the kind of thing a plan must say out loud.
 *
 * If even pure-cost ordering cannot buy the required completes, the plan comes back `feasible: false` with the
 * shortfall per market. It does not quietly buy fewer.
 */

export interface AllocationCandidate {
  integrationId: string;
  vendorName: string;
  /** the vendor's price per complete, markup already applied */
  cpi: number;
  currency: string;
  /** what this vendor can supply in this market; null = they did not say, which is NOT unlimited */
  capacity: number | null;
  /** 0–100; null when unknown */
  rejectionRate: number | null;
  duplicateRate: number | null;
  deliveryDays: number | null;
  /** 0–100; null when unknown */
  qualityScore: number | null;
  qualityConfidence: "none" | "low" | "medium" | "high";
  source: PricingSource;
}

export interface AllocationMarketInput {
  market: string;
  required: number;
  candidates: AllocationCandidate[];
}

export interface AllocationInput {
  markets: AllocationMarketInput[];
  budget: number;
  currency: string;
  strategy: AllocationStrategy;
  /** only read when strategy is "custom" */
  weights?: StrategyWeights;
  deadlineDays?: number;
  qualityFloor?: number;
  /** no vendor takes more than this share of a market. Concentration is its own risk. */
  maxVendorShare?: number;
  excludeIntegrationIds?: string[];
  /**
   * What to assume about a vendor whose rates are unknown. Using 0 would make an unknown vendor look flawless
   * and win every comparison, which is the single most dangerous default available here.
   */
  priors?: { rejectionRate?: number; duplicateRate?: number; qualityScore?: number };
}

const DEFAULT_PRIORS = { rejectionRate: 12, duplicateRate: 4, qualityScore: 60 } as const;

/** A vendor with thin history may not take more than this share of a market, whatever it scores. */
const CONFIDENCE_SHARE_CAP: Readonly<Record<AllocationCandidate["qualityConfidence"], number>> = Object.freeze({
  none: 0.25, low: 0.4, medium: 0.7, high: 1,
});

interface Prepared {
  c: AllocationCandidate;
  /** the figures actually used, after priors were substituted for unknowns */
  rejection: number;
  duplicate: number;
  quality: number;
  delivery: number | null;
  cpvac: number;
  cap: number;
  /** normalised 0..1, lower is better, within this market */
  costN: number; qualityN: number; speedN: number;
  substituted: string[];
}

function weightsFor(strategy: AllocationStrategy, custom?: StrategyWeights): StrategyWeights {
  if (strategy !== "custom") return STRATEGY_WEIGHTS[strategy];
  const w = custom ?? { cost: 1, quality: 0, speed: 0 };
  const sum = w.cost + w.quality + w.speed;
  // normalise so custom weights need not sum to 1; all-zero falls back to pure cost rather than dividing by zero
  if (sum <= 0) return { cost: 1, quality: 0, speed: 0 };
  return { cost: w.cost / sum, quality: w.quality / sum, speed: w.speed / sum };
}

/** Min-max to 0..1 with "lower is better" orientation. A single candidate, or an all-equal set, scores 0. */
function normalise(values: number[], higherIsBetter: boolean): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return values.map(() => 0);
  const lo = Math.min(...finite), hi = Math.max(...finite);
  if (hi === lo) return values.map(() => 0);
  return values.map((v) => {
    if (!Number.isFinite(v)) return 1;
    const t = (v - lo) / (hi - lo);
    return higherIsBetter ? 1 - t : t;
  });
}

function prepare(
  market: AllocationMarketInput,
  input: AllocationInput,
  /**
   * The confidence share cap protects a project from betting on a vendor with no track record. But a NEW
   * organisation has nothing but such vendors, and capping every one of them at 25% would make its first
   * project unbuyable — the protection would have become the obstacle. So the caller relaxes the caps when the
   * market cannot otherwise be filled, and the plan says it did.
   */
  relaxConfidenceCaps = false,
): { usable: Prepared[]; excluded: AllocationMarketResult["excluded"] } {
  const priors = { ...DEFAULT_PRIORS, ...(input.priors ?? {}) };
  const excluded: AllocationMarketResult["excluded"] = [];
  const kept: Omit<Prepared, "costN" | "qualityN" | "speedN">[] = [];

  for (const c of market.candidates) {
    const reject = (reason: string) => excluded.push({ integrationId: c.integrationId, vendorName: c.vendorName, reason });

    if (input.excludeIntegrationIds?.includes(c.integrationId)) { reject("excluded by the researcher"); continue; }
    if (!Number.isFinite(c.cpi) || c.cpi < 0) { reject("no price configured for this market"); continue; }
    if (c.capacity !== null && c.capacity <= 0) { reject("no sample available in this market"); continue; }
    if (input.qualityFloor !== undefined && c.qualityScore !== null && c.qualityScore < input.qualityFloor) {
      reject(`quality score ${c.qualityScore.toFixed(0)} is below the floor of ${input.qualityFloor}`); continue;
    }
    if (input.deadlineDays !== undefined && c.deliveryDays !== null && c.deliveryDays > input.deadlineDays) {
      reject(`needs ${c.deliveryDays} days, past the ${input.deadlineDays}-day deadline`); continue;
    }

    /*
     * Unknowns become priors, and the substitution is recorded. A vendor with no rejection history is not
     * assumed perfect — it is assumed typical, which is the only defensible thing to assume.
     */
    const substituted: string[] = [];
    let rejection = c.rejectionRate, duplicate = c.duplicateRate, quality = c.qualityScore;
    if (rejection === null || c.qualityConfidence === "none") { rejection = priors.rejectionRate; substituted.push("rejection rate"); }
    if (duplicate === null || c.qualityConfidence === "none") { duplicate = priors.duplicateRate; substituted.push("duplicate rate"); }
    if (quality === null || c.qualityConfidence === "none" || c.qualityConfidence === "low") { quality = priors.qualityScore; substituted.push("quality score"); }

    const cpvac = costPerValidComplete(c.cpi, rejection, duplicate);
    if (!Number.isFinite(cpvac)) { reject("every complete from this vendor is expected to be rejected or duplicated"); continue; }

    // capacity: what they said, capped by the confidence share cap and the researcher's own share limit
    const confidenceCap = relaxConfidenceCaps ? 1 : CONFIDENCE_SHARE_CAP[c.qualityConfidence];
    const shareCap = Math.min(confidenceCap, input.maxVendorShare ?? 1);
    const byShare = Math.floor(market.required * shareCap);
    const cap = c.capacity === null ? byShare : Math.min(c.capacity, byShare);
    if (cap <= 0) { reject(`share capped to zero (${Math.round(shareCap * 100)}% of ${market.required})`); continue; }

    kept.push({ c, rejection, duplicate, quality, delivery: c.deliveryDays, cpvac, cap, substituted });
  }

  const costN = normalise(kept.map((k) => k.cpvac), false);
  const qualityN = normalise(kept.map((k) => k.quality), true);
  // an unstated delivery time is treated as the slowest, so "they didn't say" never wins a speed-weighted race
  const speedN = normalise(kept.map((k) => (k.delivery === null ? Number.POSITIVE_INFINITY : k.delivery)), false);

  return {
    usable: kept.map((k, i) => ({ ...k, costN: costN[i]!, qualityN: qualityN[i]!, speedN: speedN[i]! })),
    excluded,
  };
}

/**
 * Fill one market greedily in ascending (score + λ·normalised cost) order.
 *
 * Optimal for the linear objective: with box constraints and one equality, taking the cheapest unit available at
 * every step is exactly the transportation optimum. Ties break on integration id so the result is stable.
 */
function fillMarket(usable: Prepared[], required: number, w: StrategyWeights, lambda: number) {
  const ranked = usable
    .map((p) => ({ p, key: w.cost * p.costN + w.quality * p.qualityN + w.speed * p.speedN + lambda * p.costN }))
    .sort((a, b) => (a.key !== b.key ? a.key - b.key : a.p.c.integrationId.localeCompare(b.p.c.integrationId)));

  const taken: { p: Prepared; n: number }[] = [];
  let left = required;
  for (const { p } of ranked) {
    if (left <= 0) break;
    const n = Math.min(p.cap, left);
    if (n <= 0) continue;
    taken.push({ p, n });
    left -= n;
  }
  const cost = taken.reduce((s, t) => s + t.n * t.p.c.cpi, 0);
  return { taken, shortfall: left, cost };
}

export function allocate(input: AllocationInput): AllocationPlan {
  const w = weightsFor(input.strategy, input.weights);
  const notes: string[] = [];

  const prepared = input.markets.map((m) => {
    const strict = prepare(m, input);
    const reachable = strict.usable.reduce((sum, p) => sum + p.cap, 0);
    if (reachable >= m.required) return { m, ...strict, relaxed: false };
    // would relaxing the confidence caps actually help? Only then is it worth giving up the protection.
    const relaxed = prepare(m, input, true);
    const reachableRelaxed = relaxed.usable.reduce((sum, p) => sum + p.cap, 0);
    if (reachableRelaxed <= reachable) return { m, ...strict, relaxed: false };
    notes.push(`${m.market}: the caps that limit how much an unproven vendor may take had to be relaxed to fill this market. Watch the first deliveries closely.`);
    return { m, ...relaxed, relaxed: true };
  });

  const solveAll = (lambda: number) =>
    prepared.map(({ m, usable, excluded }) => ({ m, usable, excluded, ...fillMarket(usable, m.required, w, lambda) }));

  /*
   * λ = 0 is the plan the strategy asks for. If it fits the budget, it is the answer and there is nothing to
   * trade off. Only when it does not do we raise the cost pressure.
   */
  let lambda = 0;
  let solved = solveAll(0);
  let cost = solved.reduce((s, x) => s + x.cost, 0);

  if (cost > input.budget) {
    // cost falls as λ rises; bisect for the smallest λ whose plan fits. Fixed iterations keep it deterministic.
    let lo = 0, hi = 1;
    const HI_MAX = 1024;
    while (hi < HI_MAX) {
      const trial = solveAll(hi);
      if (trial.reduce((s, x) => s + x.cost, 0) <= input.budget) break;
      hi *= 2;
    }
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const trial = solveAll(mid);
      if (trial.reduce((s, x) => s + x.cost, 0) <= input.budget) hi = mid; else lo = mid;
    }
    lambda = hi;
    solved = solveAll(lambda);
    cost = solved.reduce((s, x) => s + x.cost, 0);
    if (cost <= input.budget) {
      notes.push(`Cheaper vendors were preferred over better-scoring ones to fit the ${input.currency} ${round2(input.budget).toLocaleString()} budget.`);
    }
  }

  /*
   * Still over budget at full cost pressure: the project cannot be bought as specified. Trim, market by market,
   * from the most expensive allocation down, and report the shortfall — never silently deliver less.
   */
  if (cost > input.budget) {
    notes.push("Even the cheapest workable combination exceeds the budget; the plan below is what the budget buys.");
    for (const x of solved) {
      x.taken.sort((a, b) => (b.p.c.cpi !== a.p.c.cpi ? b.p.c.cpi - a.p.c.cpi : a.p.c.integrationId.localeCompare(b.p.c.integrationId)));
    }
    let over = cost - input.budget;
    for (const x of solved) {
      for (const t of x.taken) {
        if (over <= 0) break;
        const drop = Math.min(t.n, Math.ceil(over / t.p.c.cpi));
        t.n -= drop; x.shortfall += drop; over -= drop * t.p.c.cpi;
      }
      x.taken = x.taken.filter((t) => t.n > 0);
      x.cost = x.taken.reduce((s, t) => s + t.n * t.p.c.cpi, 0);
    }
    cost = solved.reduce((s, x) => s + x.cost, 0);
  }

  const rows: AllocationRow[] = [];
  const markets: AllocationMarketResult[] = [];

  for (const x of solved) {
    const ordered = x.taken.slice().sort((a, b) => (a.p.cpvac !== b.p.cpvac ? a.p.cpvac - b.p.cpvac : a.p.c.integrationId.localeCompare(b.p.c.integrationId)));
    let marketValid = 0;
    let slowest: number | null = null;

    for (const { p, n } of ordered) {
      const valid = expectedValidCompletes(n, p.rejection, p.duplicate);
      marketValid += valid;
      if (p.delivery !== null) slowest = slowest === null ? p.delivery : Math.max(slowest, p.delivery);
      rows.push({
        integrationId: p.c.integrationId, market: x.m.market, vendorName: p.c.vendorName,
        completes: n, cpi: p.c.cpi, currency: p.c.currency, cost: round2(n * p.c.cpi),
        expectedValidCompletes: valid, costPerValidComplete: p.cpvac,
        expectedDeliveryDays: p.delivery, source: p.c.source,
        rationale: {
          /* the arithmetic, so the row can be interrogated rather than trusted */
          yield: round4(validYield(p.rejection, p.duplicate)),
          rejectionRate: p.rejection, duplicateRate: p.duplicate, qualityScore: p.quality,
          qualityConfidence: p.c.qualityConfidence,
          capacityUsed: `${n} of ${p.cap}${p.c.capacity === null ? " (share cap; the vendor stated no availability)" : ""}`,
          ...(p.substituted.length ? { assumed: `${p.substituted.join(", ")} not known for this vendor — a typical value was used` } : {}),
        },
      });
    }

    markets.push({
      market: x.m.market, required: x.m.required,
      allocated: ordered.reduce((s, t) => s + t.n, 0),
      shortfall: x.shortfall,
      cost: round2(x.cost),
      blendedCpi: blendedCpi(ordered.map((t) => ({ completes: t.n, cpi: t.p.c.cpi }))),
      expectedValidCompletes: marketValid,
      expectedDeliveryDays: slowest,
      excluded: x.excluded,
    });
    if (x.shortfall > 0) {
      notes.push(`${x.m.market}: ${x.shortfall.toLocaleString()} of ${x.m.required.toLocaleString()} completes could not be allocated.`);
    }
  }

  const totalCompletes = markets.reduce((s, m) => s + m.allocated, 0);
  const shortfall = markets.reduce((s, m) => s + m.shortfall, 0);
  const deliveries = markets.map((m) => m.expectedDeliveryDays).filter((d): d is number => d !== null);

  return {
    strategy: input.strategy, weights: w, rows, markets,
    costPressure: round4(lambda),
    totalCompletes,
    totalCost: round2(cost),
    blendedCpi: blendedCpi(rows.map((r) => ({ completes: r.completes, cpi: r.cpi }))),
    expectedValidCompletes: markets.reduce((s, m) => s + m.expectedValidCompletes, 0),
    // the project is done when its SLOWEST market is done
    expectedDeliveryDays: deliveries.length ? Math.max(...deliveries) : null,
    feasible: shortfall === 0 && cost <= input.budget,
    shortfall,
    notes,
  };
}
