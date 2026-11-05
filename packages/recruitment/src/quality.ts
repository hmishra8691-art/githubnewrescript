import { round4 } from "./pricing.js";

/**
 * UNCERTAINTY, AS A PRIMITIVE.
 *
 * A rejection rate of 20% over five completes and over five thousand are different claims. A column holding
 * only the point estimate cannot tell them apart, and anything ranking on that column will hand 40% of a
 * project to whichever vendor had the luckiest week.
 *
 * ## What used to be here, and where it went
 *
 * This file also scored vendors: `vendorQuality` turned outcomes into a 0–100 score, `confidenceFor` graded
 * the evidence behind it, and `rankByQuality` ordered them. All three were a second implementation of
 * `rescript_vendor_quality_recompute` (0085) — the same Wilson arithmetic, the same 50-complete floor, the
 * same 1000/300/50 ladder — and they had already started to disagree: the SQL used z = 1.96 and this file
 * z = 1.959964.
 *
 * There were in fact four copies of the confidence ladder: here, in feasibility.ts, and twice inline in the
 * Studio's candidate builder, where it sat beside a hardcoded `qualityScore: null` that made the project's
 * quality floor unable to ever bite. The scoring now has one owner — the hourly pass, writing
 * `vendor_quality_metrics`, which is where the orders are and which is read rather than recomputed.
 *
 * What is left here is the statistics, which is not a duplicate of anything: `reallocate.ts` needs a bound on
 * a rate it is computing from live delivery, in memory, before deciding whether to accuse a vendor of
 * under-performing. That calculation has no row in any table.
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

/**
 * How much evidence stands behind a vendor's score.
 *
 * The vocabulary only — the ladder that produces it lives in `rescript_vendor_quality_recompute`, which has
 * the orders to count. This type exists so the planner and the optimiser can speak about confidence without
 * importing a second opinion about how to compute it.
 */
export type QualityConfidence = "none" | "low" | "medium" | "high";
