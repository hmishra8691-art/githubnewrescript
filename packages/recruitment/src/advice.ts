import { planRecruitment, type PlanRequest, type RecruitmentPlan } from "./plan.js";
import type { AllocationCandidate } from "./allocate.js";
import type { MarginRule } from "./margin.js";
import { round2 } from "./pricing.js";

/**
 * RECOMMENDATIONS.
 *
 * ## Every suggestion is re-planned, not written
 *
 * The easy version of this file is a table of sentences keyed on the verdict: over budget → "try raising your
 * budget". That is advice nobody can act on, and worse, it is sometimes wrong — raising the budget does
 * nothing for a project that is short of PEOPLE, and a researcher who follows it has spent a day and more
 * money to arrive at the same answer.
 *
 * So each candidate recommendation changes exactly one input, runs the planner again, and is kept only if the
 * verdict actually improves. A suggestion that does not survive its own re-plan is not shown. The figures in
 * the text are the figures that came back.
 *
 * ## The ones deliberately not made
 *
 * The brief asks for "your expected IRR may be too high for this target audience". To say that honestly needs
 * observed incidence for a comparable audience, and no project has fielded yet — so the only version available
 * is a guess dressed as an insight. What IS available is the rate-card band the price came from: if a
 * researcher states 35% and the applicable rate was banded for 10–25%, the price assumed a harder audience
 * than they described, and that is worth telling them because it is a fact about their quote.
 */

export type AdviceKind =
  | "raise_budget" | "extend_timeline" | "reduce_completes" | "drop_market" | "price_market" | "incidence_band";

export interface Recommendation {
  kind: AdviceKind;
  /** what it would achieve, in the researcher's own terms */
  headline: string;
  detail: string;
  /** the change itself, so the UI can offer "accept" and apply it rather than make the researcher retype */
  patch: Partial<Pick<PlanRequest, "budget" | "timelineDays" | "requiredCompletes" | "markets">>;
  /** the verdict this change produces — always better than the current one, or it would not be here */
  resultingVerdict: RecruitmentPlan["verdict"];
}

export interface AdviceContext {
  candidates: ReadonlyArray<{ market: string; candidates: AllocationCandidate[] }>;
  marginRules?: readonly MarginRule[];
  recruitmentProjectId?: string;
}

/** Better is fewer problems, in the order a researcher can act on them. */
const RANK: Record<RecruitmentPlan["verdict"], number> = {
  achievable: 0, cannot_price: 1, over_budget: 2, too_fast: 3, short_of_capacity: 4,
};

const improves = (next: RecruitmentPlan, now: RecruitmentPlan) =>
  RANK[next.verdict] < RANK[now.verdict]
  || (RANK[next.verdict] === RANK[now.verdict] && next.totalShortfall < now.totalShortfall);

const replan = (req: PlanRequest, ctx: AdviceContext) =>
  planRecruitment(req, ctx.candidates, ctx.marginRules ?? [], ctx.recruitmentProjectId ? { recruitmentProjectId: ctx.recruitmentProjectId } : {});

const money = (n: number, ccy: string) => `${ccy} ${round2(n).toLocaleString()}`;

/**
 * Find the smallest change of one input that makes the plan work.
 *
 * Bisection rather than a fixed ladder of guesses: "try 10% more" is a number somebody made up, and on a
 * project that needs 4% more it costs the researcher money they did not have to spend. Twenty iterations
 * resolve to within a fraction of a percent and are deterministic.
 */
function smallestWorkable(
  lowFails: number, highWorks: number, build: (v: number) => PlanRequest, ctx: AdviceContext,
): { value: number; plan: RecruitmentPlan } | null {
  const top = replan(build(highWorks), ctx);
  if (top.verdict !== "achievable") return null;

  let lo = lowFails, hi = highWorks, best = { value: highWorks, plan: top };
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const trial = replan(build(mid), ctx);
    if (trial.verdict === "achievable") { best = { value: mid, plan: trial }; hi = mid; } else { lo = mid; }
  }
  return best;
}

export function recommend(
  plan: RecruitmentPlan, req: PlanRequest, ctx: AdviceContext,
): Recommendation[] {
  const out: Recommendation[] = [];
  if (plan.verdict === "achievable") return out;

  /* ---------------------------------------------------------------- a market nobody has priced */

  const unpriced = plan.markets.filter((m) => !m.priced);
  if (unpriced.length) {
    const without = req.markets.filter((m) => !unpriced.some((u) => u.market === m.market));
    if (without.length) {
      const trial = replan({ ...req, markets: without, requiredCompletes: without.reduce((s, m) => s + m.completes, 0) }, ctx);
      out.push({
        kind: "drop_market",
        headline: `Run without ${unpriced.map((m) => m.market).join(", ")} for now`,
        detail: `${unpriced.map((m) => m.market).join(", ")} ${unpriced.length === 1 ? "has" : "have"} no priced capacity, so ${unpriced.length === 1 ? "it is" : "they are"} not in the plan either way. Removing ${unpriced.length === 1 ? "it" : "them"} leaves ${without.reduce((s, m) => s + m.completes, 0).toLocaleString()} completes that can be delivered.`,
        patch: { markets: without, requiredCompletes: without.reduce((s, m) => s + m.completes, 0) },
        resultingVerdict: trial.verdict,
      });
    }
    out.push({
      kind: "price_market",
      headline: `Ask an administrator to price ${unpriced.map((m) => m.market).join(", ")}`,
      detail: `Recruitment capacity exists for ${unpriced.length === 1 ? "this market" : "these markets"} in the partner network, but no rate has been configured, so nothing can be costed or ordered.`,
      patch: {},
      resultingVerdict: plan.verdict,
    });
  }

  /* ---------------------------------------------------------------- money */

  if (plan.verdict === "over_budget" && plan.fullPrice !== null) {
    /*
     * The upper bound is the full price, which by definition works. Bisecting down from it finds the least
     * the researcher must actually ask for — frequently well below the headline figure, because the optimiser
     * can reach the target with a different mix once the ceiling moves at all.
     */
    const found = smallestWorkable(req.budget, plan.fullPrice, (v) => ({ ...req, budget: round2(v) }), ctx);
    if (found) {
      const uplift = Math.round(((found.value - req.budget) / req.budget) * 100);
      out.push({
        kind: "raise_budget",
        headline: `${money(found.value, req.currency)} would cover it — about ${uplift}% more`,
        detail: `The full sample needs ${money(plan.fullPrice, req.currency)} at the quoted rates, but ${money(found.value, req.currency)} is enough to reach ${req.requiredCompletes.toLocaleString()} completes.`,
        patch: { budget: round2(found.value) },
        resultingVerdict: found.plan.verdict,
      });
    }

    /*
     * The other direction, for a budget that cannot move. What the money ALREADY approved will actually buy is
     * usually the more useful answer, and it is one the researcher can act on today.
     */
    const affordable = plan.markets.reduce((s, m) => s + m.planned, 0);
    if (affordable > 0 && affordable < req.requiredCompletes) {
      out.push({
        kind: "reduce_completes",
        headline: `${affordable.toLocaleString()} completes fit inside ${money(req.budget, req.currency)}`,
        detail: `If the budget cannot move, this is what it buys at the current rates — ${Math.round((affordable / req.requiredCompletes) * 100)}% of what was asked for.`,
        patch: { requiredCompletes: affordable, markets: plan.markets.filter((m) => m.planned > 0).map((m) => ({ market: m.market, completes: m.planned })) },
        resultingVerdict: "achievable",
      });
    }
  }

  /* ---------------------------------------------------------------- time */

  if (plan.verdict === "too_fast") {
    const found = smallestWorkable(req.timelineDays, Math.max(req.timelineDays * 6, 90), (v) => ({ ...req, timelineDays: Math.ceil(v) }), ctx);
    if (found) {
      const days = Math.ceil(found.value);
      out.push({
        kind: "extend_timeline",
        headline: `${days} days would be enough — ${days - req.timelineDays} more than planned`,
        detail: `The sample is available and affordable; only the deadline excludes it. Nothing else needs to change.`,
        patch: { timelineDays: days },
        resultingVerdict: found.plan.verdict,
      });
    }
  }

  /* ---------------------------------------------------------------- not enough people */

  if (plan.verdict === "short_of_capacity") {
    const available = plan.markets.reduce((s, m) => s + m.planned, 0);
    if (available > 0) {
      out.push({
        kind: "reduce_completes",
        headline: `${available.toLocaleString()} completes is what the network can supply`,
        detail: `More budget or a longer timeline will not change this — the people are not there at the criteria given. Loosening the targeting would widen the pool.`,
        patch: { requiredCompletes: available, markets: plan.markets.filter((m) => m.planned > 0).map((m) => ({ market: m.market, completes: m.planned })) },
        resultingVerdict: "achievable",
      });
    }
    /*
     * Deliberately NOT offered here: raising the budget. It is the obvious thing to suggest and it cannot
     * work, and a recommendation that cannot work costs a researcher a day to discover.
     */
  }

  return out;
}

/**
 * A note about the incidence the price was banded for.
 *
 * Not a recommendation — a fact about the quote. If the applicable rate card covers 10–25% incidence and the
 * researcher stated 35%, the price they are looking at assumed a harder audience than they described, and
 * either the rate or the expectation is wrong. Returns null when they agree, which is most of the time.
 */
export function incidenceNote(
  statedIr: number, bandedFor: { irMin: number; irMax: number } | null,
): string | null {
  if (!bandedFor || !Number.isFinite(statedIr)) return null;
  if (statedIr >= bandedFor.irMin && statedIr <= bandedFor.irMax) return null;
  return statedIr > bandedFor.irMax
    ? `The rate used was set for ${bandedFor.irMin}–${bandedFor.irMax}% incidence, but you expect ${statedIr}%. If you are right, this quote is priced for a harder audience than yours.`
    : `The rate used was set for ${bandedFor.irMin}–${bandedFor.irMax}% incidence, but you expect ${statedIr}%. A lower incidence than the rate assumes usually costs more per complete, not less.`;
}
