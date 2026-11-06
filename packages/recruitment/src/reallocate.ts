import type { AllocationPlan } from "@rescript/schema";
import { allocate, type AllocationCandidate, type AllocationInput } from "./allocate.js";
import { round2, round4 } from "./pricing.js";
import { wilson } from "./quality.js";

/**
 * DYNAMIC REALLOCATION (0085) — noticing that the plan is wrong, and saying what to do instead.
 *
 * The brief's §25 asks the platform to "detect underdelivery and reallocate automatically". It gets the first
 * half. The second half it gets as a *proposal*, never as an action, for a reason worth writing down:
 * reallocating means cancelling part of one vendor's order and placing it with another, which is a commercial
 * act with a counterparty, a contract and a relationship behind it. A researcher who comes back from lunch to
 * find the platform has unilaterally cancelled half of Dynata's order has lost something more valuable than
 * the hour the automation saved.
 *
 * So: detection is automatic and continuous; the revised plan is computed in full and costed; applying it is a
 * button a human presses. The proposal carries enough reasoning that pressing it is an informed act.
 *
 * ## What counts as a deviation
 *
 * Two kinds, and they want different responses:
 *
 *   PACE      the vendor is behind the share of the elapsed field period it has delivered. A vendor at 20% of
 *             its order with 80% of the deadline gone will not finish, and the completes have to come from
 *             somewhere else. Judged against elapsed time, not against other vendors — "everyone is behind"
 *             is a project problem, not a vendor problem, and this reports it as one.
 *
 *   QUALITY   the vendor's rejection rate is materially above what was assumed when the plan was built. The
 *             test is on the *lower* Wilson bound, not the point estimate: a vendor must be bad with some
 *             confidence before the platform proposes taking money away from them. The pessimistic bound is
 *             right for choosing vendors; the optimistic bound is right for accusing them.
 */

export interface ObservedVendor {
  integrationId: string;
  market: string;
  /** what the plan said to buy */
  ordered: number;
  delivered: number;
  accepted: number;
  rejected: number;
  /** what the plan assumed the rejection rate would be, as a percentage */
  assumedRejectionRate?: number | null;
  cpi: number;
  currency: string;
  spend?: number | null;
}

export type DeviationKind = "pace" | "quality" | "stalled";
export type DeviationSeverity = "watch" | "act";

export interface Deviation {
  integrationId: string;
  market: string;
  kind: DeviationKind;
  severity: DeviationSeverity;
  /** completes this vendor is now not expected to deliver */
  shortfall: number;
  detail: string;
}

export interface ReallocationInput {
  /** 0..1 — how much of the field period has gone */
  elapsedFraction: number;
  observed: readonly ObservedVendor[];
  /**
   * Candidates available to pick up the slack, per market, including the incumbents — a vendor's price and
   * capacity are market-specific, so a flat list would price GB completes at the Indian rate.
   */
  candidates: readonly { market: string; candidates: AllocationCandidate[] }[];
  budget: number;
  /** already committed, so the revised plan is costed against what is actually left */
  committed: number;
  currency: string;
  strategy: AllocationInput["strategy"];
  weights?: AllocationInput["weights"];
  /** below this the vendor is behind, as a fraction of its pro-rata expectation */
  paceTolerance?: number;
  /** percentage points above the assumption before quality is called */
  qualityTolerance?: number;
}

export interface ReallocationProposal {
  deviations: Deviation[];
  /** completes that must be re-sourced, by market */
  reSource: { market: string; completes: number }[];
  /** null when nothing needs re-sourcing, or when there is nobody left to re-source to */
  revisedPlan: AllocationPlan | null;
  headroom: number;
  currency: string;
  /** what a human should understand before pressing the button */
  notes: string[];
  /** nothing here is applied; the caller decides */
  requiresApproval: true;
}

const DEFAULT_PACE_TOLERANCE = 0.7;
/**
 * Percentage POINTS above the plan's assumption, tested against the lower Wilson bound.
 *
 * Five, not ten. A vendor quoted at 8% that runs at 18% has doubled the rejection rate, and on a 10,000-complete
 * project that is a thousand completes paid for and thrown away. A tolerance that permits it is not a tolerance,
 * it is a blind spot. Five points is the smallest gap a 2,000-screen sample can actually establish, so the
 * threshold and the evidence requirement are matched rather than arbitrary.
 */
const DEFAULT_QUALITY_TOLERANCE = 5;

/**
 * Past this much of the field period, a shortfall is not "behind" — it is "not going to happen".
 *
 * Pace alone is the wrong test near a deadline. A vendor at 60% of pro-rata with half the period left may well
 * recover; the same vendor with a fifth of the period left would have to deliver at four times its own observed
 * rate, which nobody does. Severity therefore depends on the time remaining, not only on the ratio.
 */
const RECOVERY_WINDOW = 0.25;
const MATERIAL_SHORTFALL = 0.1;

/**
 * Find the deviations in one project's delivery.
 *
 * Note what is NOT a deviation: a vendor ahead of pace, a vendor with a high rejection rate over nine completes,
 * and a vendor behind pace in the first tenth of the field period. Each of those produces an alert in a naive
 * implementation and each of them trains the researcher to ignore alerts.
 */
/**
 * WHAT THE PLAN ASSUMED WOULD BE REJECTED, per allocation row (platform audit 2026-11-05, calculation defect 1).
 *
 * The optimiser writes the rate it planned with into `rationale.rejectionRate`, in percent, beside the
 * duplicate rate and the yield (allocate.ts). The Studio used to recover it instead by inverting the stored
 * pair, `(allocated − expectedValid) / allocated` — but `expectedValid` is
 * `floor(allocated × (1 − r) × (1 − d))`, so the inversion returns the COMBINED rejection-and-duplicate loss,
 * and `detectDeviations` then compared it against an observed rejection-ONLY rate. An order of 1,000 at 8%
 * rejection and 4% duplicates stored 883; the inversion said 11.7%, and with the 5-point tolerance a vendor had
 * to pass 16.7% before quality was called. A vendor running at 15% against an 8% quote was never flagged.
 *
 * The stored rate is read first. The inversion remains only for a row allocated before the rationale carried
 * one, and is then corrected for the duplicate rate when that is known.
 */
export function assumedRejectionOfAllocation(a: {
  rationale?: unknown;
  expected_valid_completes?: unknown;
  allocated_completes?: unknown;
}): number | null {
  const rationale = (a.rationale && typeof a.rationale === "object" ? a.rationale : {}) as Record<string, unknown>;
  const stored = Number(rationale.rejectionRate);
  if (Number.isFinite(stored) && stored >= 0) return Math.min(stored, 100);
  const expected = Number(a.expected_valid_completes ?? 0);
  const allocated = Number(a.allocated_completes ?? 0);
  if (!(allocated > 0 && expected > 0)) return null;
  const yieldTotal = expected / allocated; // (1 − r)(1 − d), floored
  const dup = Number(rationale.duplicateRate);
  const dupFraction = Number.isFinite(dup) && dup > 0 ? Math.min(dup, 100) / 100 : 0;
  const survive = dupFraction < 1 ? yieldTotal / (1 - dupFraction) : yieldTotal;
  return Math.max(0, Math.min(100, (1 - survive) * 100));
}

export function detectDeviations(input: ReallocationInput): Deviation[] {
  const elapsed = Math.min(1, Math.max(0, input.elapsedFraction));
  const paceTol = input.paceTolerance ?? DEFAULT_PACE_TOLERANCE;
  const qualTol = input.qualityTolerance ?? DEFAULT_QUALITY_TOLERANCE;
  const out: Deviation[] = [];

  // Too early to judge pace: 10% of the field period is a launch, not a trend.
  const pacejudgeable = elapsed >= 0.1;

  for (const v of [...input.observed].sort((a, b) =>
    a.market !== b.market ? a.market.localeCompare(b.market) : a.integrationId.localeCompare(b.integrationId))) {
    if (v.ordered <= 0) continue;

    const expected = v.ordered * elapsed;
    const ratio = expected > 0 ? v.accepted / expected : 1;

    if (pacejudgeable && v.accepted === 0 && elapsed >= 0.25) {
      out.push({
        integrationId: v.integrationId, market: v.market, kind: "stalled", severity: "act",
        shortfall: v.ordered,
        detail: `Nothing delivered against an order of ${v.ordered.toLocaleString()} with ${Math.round(elapsed * 100)}% of the field period gone. Treat the whole order as unsourced until they start.`,
      });
    } else if (pacejudgeable && ratio < paceTol) {
      /*
       * Project the finish at the current rate. The shortfall is what will still be missing at the deadline —
       * not the gap today, which would over-source every vendor that simply started slowly.
       */
      const projected = elapsed > 0 ? Math.floor(v.accepted / elapsed) : v.accepted;
      const shortfall = Math.max(0, v.ordered - projected);
      if (shortfall > 0) {
        const unrecoverable = 1 - elapsed < RECOVERY_WINDOW && shortfall > v.ordered * MATERIAL_SHORTFALL;
        out.push({
          integrationId: v.integrationId, market: v.market,
          kind: "pace", severity: ratio < paceTol / 2 || unrecoverable ? "act" : "watch",
          shortfall,
          detail: `${v.accepted.toLocaleString()} of ${v.ordered.toLocaleString()} with ${Math.round(elapsed * 100)}% of the field period gone — on track for about ${projected.toLocaleString()}, ${shortfall.toLocaleString()} short.${unrecoverable ? " Too little of the field period remains for them to recover it." : ""}`,
        });
      }
    }

    const screened = v.accepted + v.rejected;
    const interval = wilson(v.rejected, screened);
    const assumed = typeof v.assumedRejectionRate === "number" ? v.assumedRejectionRate : null;
    if (interval && assumed !== null && screened >= 30) {
      /*
       * The LOW bound against the assumption. The platform is about to tell a researcher that a supplier is
       * underperforming its quote; being wrong about that is expensive in a way that being slow to notice is not.
       */
      if (interval.low > assumed + qualTol) {
        const remaining = Math.max(0, v.ordered - v.accepted);
        out.push({
          integrationId: v.integrationId, market: v.market, kind: "quality",
          severity: interval.low > assumed + qualTol * 2 ? "act" : "watch",
          shortfall: remaining,
          detail: `Rejection running at ${interval.point.toFixed(1)}% (at least ${interval.low.toFixed(1)}% on ${screened.toLocaleString()} screened) against ${assumed.toFixed(1)}% assumed in the plan.`,
        });
      }
    }
  }

  return out;
}

/**
 * Detect, then propose.
 *
 * Only `act` deviations move completes. A `watch` is reported so a human can look, and deliberately does not
 * change the plan — an alert that silently rewrites the project is worse than no alert.
 */
export function proposeReallocation(input: ReallocationInput): ReallocationProposal {
  const deviations = detectDeviations(input);
  const notes: string[] = [];
  const headroom = round2(Math.max(0, input.budget - input.committed));

  const byMarket = new Map<string, number>();
  for (const d of deviations) {
    if (d.severity !== "act" || d.shortfall <= 0) continue;
    byMarket.set(d.market, (byMarket.get(d.market) ?? 0) + d.shortfall);
  }

  const reSource = [...byMarket.entries()]
    .map(([market, completes]) => ({ market, completes }))
    .sort((a, b) => a.market.localeCompare(b.market));

  if (!reSource.length) {
    if (deviations.length) notes.push("Deviations found, but none severe enough to move completes. Watch, do not act yet.");
    return { deviations, reSource, revisedPlan: null, headroom, currency: input.currency, notes, requiresApproval: true };
  }

  /*
   * Exclude the vendors that caused the shortfall from the replacement plan. Not as a punishment — as the only
   * coherent reading of the evidence: a vendor that cannot deliver its current order is not a candidate for more.
   */
  const failing = new Set(deviations.filter((d) => d.severity === "act").map((d) => d.integrationId));
  const replacementMarkets = reSource.map((r) => {
    const pool = input.candidates.find((c) => c.market === r.market)?.candidates ?? [];
    return { market: r.market, required: r.completes, candidates: pool.filter((c) => !failing.has(c.integrationId)) };
  });

  if (!replacementMarkets.some((m) => m.candidates.length)) {
    notes.push("There is no other vendor in this market able to take the shortfall. Extending the deadline or raising the incentive are the remaining options — this is not something the platform can route around.");
    return { deviations, reSource, revisedPlan: null, headroom, currency: input.currency, notes, requiresApproval: true };
  }

  const revisedPlan = allocate({
    markets: replacementMarkets,
    budget: headroom,
    currency: input.currency,
    strategy: input.strategy,
    weights: input.weights,
    excludeIntegrationIds: [...failing],
  });

  if (!revisedPlan.feasible) {
    notes.push(`The remaining ${input.currency} ${headroom.toLocaleString()} does not cover re-sourcing the shortfall at available rates. The plan below is what the remaining budget buys.`);
  }
  const spend = round2(revisedPlan.totalCost);
  notes.push(`Re-sourcing ${reSource.reduce((s, r) => s + r.completes, 0).toLocaleString()} completes would commit a further ${input.currency} ${spend.toLocaleString()} of the ${input.currency} ${headroom.toLocaleString()} still uncommitted.`);
  notes.push("Nothing has been ordered. Applying this cancels the unfulfilled part of the affected orders and places new ones.");

  return { deviations, reSource, revisedPlan, headroom, currency: input.currency, notes, requiresApproval: true };
}

/** Delivery against order, for the dashboard. Separate from deviation detection, which is a judgement. */
export function deliveryProgress(observed: readonly ObservedVendor[]) {
  const ordered = observed.reduce((s, v) => s + Math.max(0, v.ordered), 0);
  const accepted = observed.reduce((s, v) => s + Math.max(0, v.accepted), 0);
  const rejected = observed.reduce((s, v) => s + Math.max(0, v.rejected), 0);
  const spend = observed.reduce((s, v) => s + (typeof v.spend === "number" ? v.spend : 0), 0);
  return {
    ordered, accepted, rejected,
    fill: ordered > 0 ? round4(accepted / ordered) : 0,
    rejectionRate: accepted + rejected > 0 ? round2((rejected / (accepted + rejected)) * 100) : null,
    spend: round2(spend),
  };
}
