import type { AudienceSpecification, FeasibilityEstimate, PricingSource, VendorMode, VendorPricingRow } from "@rescript/schema";
import { costPerValidComplete, expectedValidCompletes, selectPricing, applyMarkup, round2 } from "./pricing.js";

/**
 * FEASIBILITY — assembling one vendor's answer out of what the organisation has configured.
 *
 * In Phase 1 nothing is asked of a vendor: an estimate is built from the rate card an operator entered and from
 * this platform's own history of that vendor. That is a weaker answer than a live quotation and it is labelled
 * as such, in `source`, on every figure, all the way to the screen.
 *
 * The honesty rules, which are the point of this module:
 *
 *   - A missing number is `null`, never 0. "We do not know how much sample they have" and "they have none" lead
 *     to opposite decisions, and a dashboard that renders both as 0 destroys the difference.
 *   - A quality score with too little history behind it is returned with `qualityConfidence: "low"` or `"none"`
 *     and the caller must not rank on it. The brief's §24: do not unfairly penalise a vendor with no data.
 *   - Targeting this vendor cannot express is listed in `unmapped` rather than dropped. An estimate for a
 *     broader audience than the one asked for is not an estimate for this project.
 */

/** What the platform knows about how a vendor has actually performed. All optional: a new vendor has none of it. */
export interface VendorHistory {
  /** completed interviews this platform has accepted from this vendor */
  completes?: number;
  rejectionRate?: number | null;
  duplicateRate?: number | null;
  medianDeliveryDays?: number | null;
  /** 0–100, from `vendor_quality_metrics`; null until there is enough history */
  qualityScore?: number | null;
}

export interface FeasibilityInput {
  integrationId: string;
  vendorName: string;
  mode: VendorMode;
  markupBps: number;
  currency: string;
  pricing: readonly VendorPricingRow[];
  history?: VendorHistory;
  /** the vendor's stated available sample for this audience, when an operator recorded one */
  statedAvailable?: number | null;
  /** targeting criteria this vendor cannot express, named by the operator or the adapter's mapping */
  unmapped?: readonly string[];
}

export interface FeasibilityParams {
  audience: AudienceSpecification;
  requiredCompletes: number;
  loiMinutes: number;
  expectedIr: number;
  at?: string;
}

/**
 * How much history a quality score needs before it may be ranked on. The thresholds are deliberately blunt and
 * deliberately high: a vendor's rejection rate over 40 interviews is noise, and the cost of treating noise as
 * signal is sending 40% of a project to a vendor that had one good week.
 */
export function qualityConfidence(completes: number | undefined): FeasibilityEstimate["qualityConfidence"] {
  const n = completes ?? 0;
  if (n >= 1000) return "high";
  if (n >= 300) return "medium";
  if (n >= 50) return "low";
  return "none";
}

/**
 * The incidence to price at. The researcher's expectation is the default; a vendor's own observed incidence for
 * this organisation, when there is enough of it, is better. Phase 2 replaces this with a fitted estimate.
 */
function pricingIr(params: FeasibilityParams): number {
  const ir = params.expectedIr;
  return Number.isFinite(ir) && ir > 0 && ir <= 100 ? ir : 100;
}

/** The primary market: the first country in the audience. A multi-country project is priced per market. */
export function primaryMarket(audience: AudienceSpecification): string | null {
  return audience.demographics.countries[0] ?? null;
}

export function estimateForVendor(input: FeasibilityInput, params: FeasibilityParams): FeasibilityEstimate {
  const market = primaryMarket(params.audience);
  const base: FeasibilityEstimate = {
    integrationId: input.integrationId,
    vendorName: input.vendorName,
    mode: input.mode,
    available: input.statedAvailable ?? null,
    expectedIr: null, cpi: null, currency: input.currency, loiMinutes: params.loiMinutes,
    expectedRejectionRate: input.history?.rejectionRate ?? null,
    expectedDuplicateRate: input.history?.duplicateRate ?? null,
    deliveryDays: input.history?.medianDeliveryDays ?? null,
    qualityScore: input.history?.qualityScore ?? null,
    qualityConfidence: qualityConfidence(input.history?.completes),
    source: "administrator",
    unmapped: [...(input.unmapped ?? [])],
  };

  if (input.mode === "awaiting" || input.mode === "inactive") {
    return { ...base, unavailableReason: input.mode === "awaiting" ? "No integration configured yet" : "Integration is inactive" };
  }
  if (input.mode === "redirect_only") {
    return { ...base, unavailableReason: "Recruitment links only — feasibility is handled in the vendor's own dashboard" };
  }
  if (!market) {
    return { ...base, unavailableReason: "The audience names no country, so no rate card applies" };
  }

  const ir = pricingIr(params);
  const row = selectPricing(input.pricing, { market, ir, loiMinutes: params.loiMinutes, at: params.at });
  if (!row) {
    return { ...base, unavailableReason: `No price configured for ${market} at ${ir}% incidence and ${params.loiMinutes} minutes` };
  }

  return {
    ...base,
    expectedIr: ir,
    cpi: applyMarkup(row.cpi, input.markupBps),
    currency: row.currency,
    source: row.source,
  };
}

export interface ComparisonRow extends FeasibilityEstimate {
  /** the objective: what one complete that actually counts costs here. Infinity when the vendor yields nothing. */
  costPerValidComplete: number;
  /** what `requiredCompletes` would cost at this vendor alone, when it could supply them */
  projectedCost: number | null;
  expectedValidCompletes: number | null;
  /** true when this vendor cannot be ranked: no price, or not enough history to trust its quality */
  rankable: boolean;
  /** why it cannot be ranked, for the comparison table's own footnote */
  caveat?: string;
}

/**
 * The vendor comparison. Ranks by cost per valid accepted complete — never by CPI — and puts every vendor it
 * could not rank at the bottom with the reason, rather than dropping it. A vendor missing from a comparison
 * reads as "not available"; a vendor present with "no price configured" reads as "somebody needs to enter a rate
 * card", which is the true and actionable version.
 */
export function compareVendors(inputs: readonly FeasibilityInput[], params: FeasibilityParams): ComparisonRow[] {
  const rows: ComparisonRow[] = inputs.map((input) => {
    const est = estimateForVendor(input, params);
    const cpvac = est.cpi === null ? Infinity : costPerValidComplete(est.cpi, est.expectedRejectionRate, est.expectedDuplicateRate);
    const valid = est.cpi === null ? null : expectedValidCompletes(params.requiredCompletes, est.expectedRejectionRate, est.expectedDuplicateRate);
    const caveat = est.unavailableReason
      ?? (est.qualityConfidence === "none" && (est.expectedRejectionRate !== null || est.qualityScore !== null)
        ? "too little history here to trust the quality figures"
        : undefined);
    return {
      ...est,
      costPerValidComplete: cpvac,
      projectedCost: est.cpi === null ? null : round2(est.cpi * params.requiredCompletes),
      expectedValidCompletes: valid,
      rankable: est.cpi !== null && Number.isFinite(cpvac),
      ...(caveat ? { caveat } : {}),
    };
  });

  return rows.sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    if (!a.rankable) return a.vendorName.localeCompare(b.vendorName);
    if (a.costPerValidComplete !== b.costPerValidComplete) return a.costPerValidComplete - b.costPerValidComplete;
    return a.vendorName.localeCompare(b.vendorName);
  });
}

/** The provenance of a whole comparison: the weakest figure in it, so a summary line can say what it rests on. */
export function comparisonSource(rows: readonly ComparisonRow[]): PricingSource {
  const ranked = rows.filter((r) => r.rankable);
  if (!ranked.length) return "administrator";
  const order: PricingSource[] = ["administrator", "historical", "vendor_reported", "live"];
  let weakest = 3;
  for (const r of ranked) weakest = Math.min(weakest, order.indexOf(r.source));
  return order[weakest] ?? "administrator";
}
