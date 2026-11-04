import { round2, round4 } from "./pricing.js";

/**
 * THE COMMERCIAL MARGIN ENGINE.
 *
 * ## Margin is not markup, and the difference is money
 *
 * A markup is a fraction of COST added to it. A margin is a fraction of the SELLING PRICE kept from it. They
 * are different arithmetic and they give different answers:
 *
 *      markup 30% on £7,000  =  7000 × 1.30            =  £9,100
 *      margin 30% on £7,000  =  7000 ÷ (1 − 0.30)      =  £10,000
 *
 * £900 a project, in the direction that loses money. `applyMarkup` in pricing.ts computes the first and has
 * always been named honestly; the commercial requirement is the second, so it lives here under its own name
 * rather than being bolted onto the old function. Both remain, because a markup is still the right model for
 * some agreements — what was wrong was using one and calling it the other.
 *
 * ## A margin cannot reach 100%
 *
 * As the margin approaches 1, the price approaches infinity: at a 100% margin there is no finite price that
 * keeps the whole of itself as profit. This is not a rounding concern — it is the shape of the formula, and a
 * configuration screen that accepts "100" produces either an infinity or, worse, a silent NaN that lands in an
 * invoice. `MAX_MARGIN_BPS` refuses it, and `sellingPrice` refuses it again.
 */

/** Basis points of the SELLING price. 3000 = 30% = cost ÷ 0.70. */
export type MarginBps = number;

/**
 * 9500 = 95%, a price twenty times cost. Far beyond any real agreement, and chosen as the point past which a
 * number is more likely a typo (95 meaning 0.95%? 9500 meaning 95%?) than an intention.
 */
export const MAX_MARGIN_BPS = 9500;

/** The brief's target band. The default is the top of it, which is the rate its own worked example uses. */
export const DEFAULT_MARGIN_BPS = 3000;
export const TARGET_MARGIN_BAND = Object.freeze({ lowBps: 2500, highBps: 3000 });

export class MarginError extends Error {
  constructor(message: string) { super(message); this.name = "MarginError"; }
}

/** Is this a margin that can produce a finite price? Returns the reason when not, for a usable message. */
export function validateMarginBps(bps: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(bps)) return { ok: false, reason: "A margin must be a number." };
  if (bps < 0) return { ok: false, reason: "A margin cannot be negative. To sell below cost, set it to zero and record the discount separately." };
  if (bps >= 10_000) {
    return { ok: false, reason: "A margin of 100% has no finite selling price — at 100% the whole price would be profit and none of it would cover the cost." };
  }
  if (bps > MAX_MARGIN_BPS) {
    return { ok: false, reason: `A margin above ${MAX_MARGIN_BPS / 100}% prices at more than twenty times cost. If that is intended, record it as an explicit override with a note.` };
  }
  return { ok: true };
}

/**
 * The selling price that keeps `marginBps` of ITSELF as profit.
 *
 *     price = cost / (1 − margin)
 *
 * Throws rather than returning a sentinel: a bad margin reaching this function means a configuration screen let
 * it through, and a NaN flowing on into a quotation is the failure this is here to prevent.
 */
export function sellingPrice(cost: number, marginBps: MarginBps): number {
  if (!Number.isFinite(cost) || cost < 0) throw new MarginError("Cost must be a non-negative number.");
  const check = validateMarginBps(marginBps);
  if (!check.ok) throw new MarginError(check.reason!);
  if (cost === 0) return 0;
  return round2(cost / (1 - marginBps / 10_000));
}

/** The profit at that price: `price − cost`, which is also `price × margin`. */
export function grossProfit(cost: number, marginBps: MarginBps): number {
  return round2(sellingPrice(cost, marginBps) - cost);
}

/**
 * The margin implied by a cost and a price — the inverse, so an administrator can check a quoted figure.
 *
 * Returns null when the price is at or below cost: there is no margin to report, and reporting a negative one
 * as though it were a setting would invite somebody to "fix" it by entering a negative margin.
 */
export function marginFromPrices(cost: number, price: number): MarginBps | null {
  if (!Number.isFinite(cost) || !Number.isFinite(price)) return null;
  if (price <= 0 || cost < 0 || price <= cost) return null;
  return Math.round(((price - cost) / price) * 10_000);
}

/** The markup that would produce the same price, for an agreement expressed the other way round. */
export function equivalentMarkupBps(marginBps: MarginBps): number | null {
  const check = validateMarginBps(marginBps);
  if (!check.ok || marginBps === 0) return check.ok ? 0 : null;
  const m = marginBps / 10_000;
  return Math.round((m / (1 - m)) * 10_000);
}

/* ------------------------------------------------------------ which margin applies */

export type MarginScope = "default" | "market" | "recruitment_type" | "project" | "override";

export interface MarginRule {
  id: string;
  scope: MarginScope;
  marginBps: MarginBps;
  /** set for scope "market" */
  market?: string | null;
  /** set for scope "project" and for an override aimed at one project */
  recruitmentProjectId?: string | null;
  /** set for scope "recruitment_type" */
  recruitmentType?: string | null;
  note?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface MarginQuery {
  market?: string | null;
  recruitmentProjectId?: string | null;
  recruitmentType?: string | null;
  at?: string;
}

export interface ResolvedMargin {
  marginBps: MarginBps;
  scope: MarginScope;
  ruleId: string | null;
  /** the sentence an administrator reads to understand why this rate and not another */
  because: string;
  /** true when no rule matched and the platform default was used */
  isDefault: boolean;
  withinTargetBand: boolean;
}

/** Most specific first. An override is deliberately above a project rule: it is the escape hatch. */
const PRECEDENCE: Record<MarginScope, number> = {
  override: 0, project: 1, recruitment_type: 2, market: 3, default: 4,
};

function active(rule: MarginRule, at: number): boolean {
  const from = rule.effectiveFrom ? Date.parse(rule.effectiveFrom) : null;
  const to = rule.effectiveTo ? Date.parse(rule.effectiveTo) : null;
  if (from !== null && !Number.isNaN(from) && at < from) return false;
  if (to !== null && !Number.isNaN(to) && at >= to) return false;
  return true;
}

function matches(rule: MarginRule, q: MarginQuery): boolean {
  switch (rule.scope) {
    case "default": return true;
    case "market": return !!q.market && rule.market === q.market;
    case "recruitment_type": return !!q.recruitmentType && rule.recruitmentType === q.recruitmentType;
    case "project":
    case "override": return !!q.recruitmentProjectId && rule.recruitmentProjectId === q.recruitmentProjectId;
    default: return false;
  }
}

/**
 * Which margin applies, and why.
 *
 * The `because` sentence is not decoration. A margin is the difference between a project being profitable and
 * not, and an administrator looking at 22% where they expected 30% needs to know which rule produced it — not
 * to go hunting through four tables. Ties inside one scope break on the rule id, so the answer is stable.
 */
export function resolveMargin(
  rules: readonly MarginRule[],
  query: MarginQuery = {},
  fallbackBps: MarginBps = DEFAULT_MARGIN_BPS,
): ResolvedMargin {
  const at = query.at ? Date.parse(query.at) : Date.now();
  const applicable = rules
    .filter((r) => validateMarginBps(r.marginBps).ok && active(r, at) && matches(r, query))
    .sort((a, b) => (PRECEDENCE[a.scope] - PRECEDENCE[b.scope]) || a.id.localeCompare(b.id));

  const winner = applicable[0];
  if (!winner) {
    return {
      marginBps: fallbackBps, scope: "default", ruleId: null, isDefault: true,
      because: `No margin rule matched, so the platform default of ${(fallbackBps / 100).toFixed(1)}% applies.`,
      withinTargetBand: fallbackBps >= TARGET_MARGIN_BAND.lowBps && fallbackBps <= TARGET_MARGIN_BAND.highBps,
    };
  }

  const where =
    winner.scope === "market" ? `the rate set for ${winner.market}`
    : winner.scope === "project" ? "the rate set for this project"
    : winner.scope === "override" ? `an administrator's override${winner.note ? ` (${winner.note})` : ""}`
    : winner.scope === "recruitment_type" ? `the rate set for ${winner.recruitmentType} recruitment`
    : "the organisation's default rate";

  return {
    marginBps: winner.marginBps,
    scope: winner.scope,
    ruleId: winner.id,
    isDefault: false,
    because: `${(winner.marginBps / 100).toFixed(1)}% from ${where}.`,
    withinTargetBand: winner.marginBps >= TARGET_MARGIN_BAND.lowBps && winner.marginBps <= TARGET_MARGIN_BAND.highBps,
  };
}

/* ------------------------------------------------------------ what gets recorded */

export interface PriceBreakdown {
  /** what the sample actually costs, before anything is added. ADMINISTRATORS ONLY. */
  cost: number;
  marginBps: MarginBps;
  marginScope: MarginScope;
  marginRuleId: string | null;
  /** what the researcher pays */
  price: number;
  /** price − cost. ADMINISTRATORS ONLY. */
  profit: number;
  pricePerComplete: number | null;
  costPerComplete: number | null;
  currency: string;
  because: string;
  withinTargetBand: boolean;
  completes: number;
}

/**
 * One priced plan, with every figure behind it.
 *
 * This whole object is the ADMINISTRATOR's view. The researcher gets `price`, `pricePerComplete` and
 * `currency` from it and nothing else — `lib/recruitment/abstraction.ts` is what enforces that, and the cost
 * and profit fields are named plainly here so that anyone spreading this object into a response can see what
 * they are about to leak.
 */
export function priceBreakdown(
  cost: number, completes: number, currency: string, resolved: ResolvedMargin,
): PriceBreakdown {
  const price = sellingPrice(cost, resolved.marginBps);
  return {
    cost: round2(cost),
    marginBps: resolved.marginBps,
    marginScope: resolved.scope,
    marginRuleId: resolved.ruleId,
    price,
    profit: round2(price - cost),
    pricePerComplete: completes > 0 ? round4(price / completes) : null,
    costPerComplete: completes > 0 ? round4(cost / completes) : null,
    currency,
    because: resolved.because,
    withinTargetBand: resolved.withinTargetBand,
    completes,
  };
}
