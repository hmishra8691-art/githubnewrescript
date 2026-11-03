import { round2, round4 } from "./pricing.js";

/**
 * VENDOR QUALITY (0085) — what a vendor's traffic has actually been worth, with the uncertainty attached.
 *
 * The brief's §24 asks for a dynamic vendor quality score and then, in the same breath, for the thing that
 * makes such scores usable: "Do not unfairly penalise a vendor with insufficient data. Mark low-confidence
 * scores appropriately."
 *
 * A rejection rate of 20% over five completes and over five thousand are different claims. A column holding
 * only the point estimate cannot tell them apart, and an optimiser ranking on that column will hand 40% of a
 * project to whichever vendor had the luckiest week. So every rate here comes with a **Wilson interval**, and
 * the optimiser ranks on the pessimistic bound — the worst the evidence is consistent with — rather than on
 * the hopeful middle.
 *
 * And a vendor nobody has used is `null`, never zero. Unknown is not bad.
 */

/** 95%. Two-sided, so the bound used for ranking is genuinely the worst case at that level. */
const Z = 1.959964;

export interface Interval { point: number; low: number; high: number }

/**
 * The Wilson score interval for a proportion.
 *
 * Not the textbook normal approximation: that one produces bounds below zero and above one on small samples,
 * and reports a perfectly tight interval for 0 successes out of 5 — exactly the case where a new vendor looks
 * flawless. Wilson stays inside [0, 1] and stays wide when the sample is thin, which is the entire point.
 */
export function wilson(successes: number, trials: number, z = Z): Interval | null {
  if (!Number.isFinite(trials) || trials <= 0) return null;
  if (!Number.isFinite(successes) || successes < 0 || successes > trials) return null;
  const n = trials;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    point: round4(p * 100),
    low: round4(Math.max(0, centre - margin) * 100),
    high: round4(Math.min(1, centre + margin) * 100),
  };
}

export type QualityConfidence = "none" | "low" | "medium" | "high";

/** Blunt on purpose, and the same thresholds Phase 1 used, so one vocabulary covers both. */
export function confidenceFor(accepted: number): QualityConfidence {
  if (accepted >= 1000) return "high";
  if (accepted >= 300) return "medium";
  if (accepted >= 50) return "low";
  return "none";
}

export interface VendorOutcomes {
  integrationId: string;
  vendorName?: string;
  delivered: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  /** what the accepted completes actually cost, and what was quoted */
  spend?: number | null;
  quotedCpi?: number | null;
  medianDeliveryDays?: number | null;
  fraudCases?: number;
}

export interface VendorQuality {
  integrationId: string;
  vendorName: string | null;
  delivered: number;
  accepted: number;
  rejection: Interval | null;
  duplicate: Interval | null;
  /** 0–100, or null when there is not enough history to say anything at all */
  score: number | null;
  confidence: QualityConfidence;
  actualCpi: number | null;
  quotedCpi: number | null;
  /** what the quote missed by, as a share. Positive means it cost more than quoted. */
  cpiDrift: number | null;
  /**
   * The figure the optimiser should use: the PESSIMISTIC end of the rejection interval. On a thin sample that
   * is a long way above the point estimate, which is exactly the handicap a vendor with no track record
   * should carry — not a penalty on its score, but a refusal to bet the project on its best week.
   */
  pessimisticRejection: number | null;
  /** why the score is null or the confidence low, in words a researcher can act on */
  caveat?: string;
}

/**
 * A vendor's quality, from outcomes.
 *
 * The score is deliberately simple arithmetic over the rejection rate rather than a weighted blend of a dozen
 * factors: a composite nobody can reconstruct is a composite nobody should be asked to spend against. Delivery
 * speed and CPI drift are reported beside it rather than folded into it.
 */
export function vendorQuality(o: VendorOutcomes): VendorQuality {
  const delivered = Math.max(0, o.delivered ?? 0);
  const accepted = Math.max(0, o.accepted ?? 0);
  const rejected = Math.max(0, o.rejected ?? 0);
  const duplicates = Math.max(0, o.duplicates ?? 0);

  const rejection = wilson(Math.min(rejected, delivered), delivered);
  const duplicate = delivered + duplicates > 0 ? wilson(duplicates, delivered + duplicates) : null;
  const confidence = confidenceFor(accepted);

  const actualCpi = accepted > 0 && typeof o.spend === "number" ? round4(o.spend / accepted) : null;
  const quotedCpi = typeof o.quotedCpi === "number" ? round4(o.quotedCpi) : null;
  const cpiDrift = actualCpi !== null && quotedCpi !== null && quotedCpi > 0
    ? round4((actualCpi - quotedCpi) / quotedCpi)
    : null;

  /*
   * No score below 50 accepted completes. Null is not zero: rendering "unknown" as a bad score would bury
   * every new vendor relationship on its first day, which is how a marketplace ends up with one supplier.
   */
  const score = accepted < 50 || !rejection
    ? null
    : round2(Math.max(0, 100 - rejection.point * 2));

  const caveat = accepted < 50
    ? `Only ${accepted.toLocaleString()} accepted completes so far — too few to score. This is unknown, not poor.`
    : confidence === "low"
      ? `Based on ${accepted.toLocaleString()} completes; the rejection rate could be anywhere between ${rejection!.low.toFixed(1)}% and ${rejection!.high.toFixed(1)}%.`
      : undefined;

  return {
    integrationId: o.integrationId,
    vendorName: o.vendorName ?? null,
    delivered, accepted, rejection, duplicate, score, confidence,
    actualCpi, quotedCpi, cpiDrift,
    pessimisticRejection: rejection ? rejection.high : null,
    ...(caveat ? { caveat } : {}),
  };
}

/**
 * Rank vendors for the optimiser.
 *
 * On the pessimistic bound, and vendors with no history at all go LAST rather than first — the opposite of
 * what a naive sort on a null-as-zero rejection rate would do, and the difference between a marketplace that
 * tries new suppliers carefully and one that hands them the whole project.
 */
export function rankByQuality(rows: readonly VendorQuality[]): VendorQuality[] {
  return [...rows].sort((a, b) => {
    const ap = a.pessimisticRejection, bp = b.pessimisticRejection;
    if (ap === null && bp === null) return a.integrationId.localeCompare(b.integrationId);
    if (ap === null) return 1;
    if (bp === null) return -1;
    if (ap !== bp) return ap - bp;
    return a.integrationId.localeCompare(b.integrationId);
  });
}
