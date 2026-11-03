import { SOURCE_CONFIDENCE, type PricingSource, type VendorPricingRow } from "@rescript/schema";

/**
 * PRICING AND THE COST OF A VALID COMPLETE.
 *
 * Pure arithmetic over configured rate cards. Every function here is total and deterministic, and none of them
 * reaches a database or a vendor — the Studio renders from these, the Phase 2 optimiser will optimise over these,
 * and both get the same numbers.
 *
 * The one idea worth stating plainly, because the whole exchange turns on it (the brief's §25):
 *
 *     A cheaper vendor is not cheaper if more of its respondents are thrown away.
 *
 * A vendor quoting $6.50 whose completes are 20% rejected and 8% duplicated costs $8.83 for every complete that
 * actually counts, and loses to a vendor quoting $8.00 with a 4% rejection rate ($8.33). So nothing in this
 * subsystem ranks by CPI. `costPerValidComplete` is the number, and `blendedCpi` exists only because it is what a
 * finance team asks for afterwards.
 */

/**
 * A rate as a fraction. **Every rate in this subsystem is a PERCENTAGE, 0–100**, because that is what the columns
 * hold (`numeric(5,2)` checked between 0 and 100) and what every schema field documents.
 *
 * This used to guess — `rate > 1 ? rate / 100 : rate` — so that it would accept either convention. The guess is
 * wrong at exactly one value and that value is common: a duplicate rate of `1` means one percent, and the guess
 * read it as 1.0, i.e. every single complete duplicated. A vendor with a 1% duplicate rate was scored as
 * worthless and silently dropped from allocations. There is no heuristic that can tell 1% from 100% here, so
 * there is no heuristic: the unit is fixed, documented, and clamped.
 */
function asFraction(ratePercent: number | null | undefined): number {
  if (ratePercent === null || ratePercent === undefined || !Number.isFinite(ratePercent)) return 0;
  if (ratePercent <= 0) return 0;
  return Math.min(ratePercent, 100) / 100;
}

export function applyMarkup(cpi: number, markupBps: number): number {
  if (!Number.isFinite(cpi) || cpi < 0) return 0;
  const bps = Number.isFinite(markupBps) && markupBps > 0 ? markupBps : 0;
  return round2(cpi * (1 + bps / 10_000));
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * The share of ordered completes expected to survive rejection and deduplication.
 *
 * Rejection and duplication are treated as independent, which is a simplification and a mild overestimate of
 * yield when they correlate (a click farm produces both). The optimiser's pessimistic bound compensates; a
 * correlation term is not worth inventing before there is enough history to fit one.
 */
export function validYield(rejectionRate: number | null | undefined, duplicateRate: number | null | undefined): number {
  return (1 - asFraction(rejectionRate)) * (1 - asFraction(duplicateRate));
}

export function expectedValidCompletes(
  ordered: number, rejectionRate: number | null | undefined, duplicateRate: number | null | undefined,
): number {
  if (!Number.isFinite(ordered) || ordered <= 0) return 0;
  return Math.floor(ordered * validYield(rejectionRate, duplicateRate));
}

/**
 * The objective function: what one complete that actually counts costs at this vendor.
 *
 * Returns `Infinity` when the yield is zero — a vendor whose every complete is rejected has no finite cost per
 * valid complete, and returning a big number instead would let it win a comparison by rounding.
 */
export function costPerValidComplete(
  cpi: number, rejectionRate: number | null | undefined, duplicateRate: number | null | undefined,
): number {
  if (!Number.isFinite(cpi) || cpi < 0) return Infinity;
  const y = validYield(rejectionRate, duplicateRate);
  if (y <= 0) return Infinity;
  return round4(cpi / y);
}

/** How many completes a budget buys at a CPI, floored — a part of a complete is not a complete. */
export function completesForBudget(budget: number, cpi: number): number {
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(cpi) || cpi <= 0) return 0;
  return Math.floor(budget / cpi);
}

export interface BlendedLine { completes: number; cpi: number }

/** The weighted average CPI across an allocation. Zero completes gives zero, not NaN. */
export function blendedCpi(lines: readonly BlendedLine[]): number {
  let completes = 0, cost = 0;
  for (const l of lines) {
    if (!Number.isFinite(l.completes) || l.completes <= 0) continue;
    if (!Number.isFinite(l.cpi) || l.cpi < 0) continue;
    completes += l.completes;
    cost += l.completes * l.cpi;
  }
  return completes === 0 ? 0 : round4(cost / completes);
}

export function totalCost(lines: readonly BlendedLine[]): number {
  let cost = 0;
  for (const l of lines) {
    if (!Number.isFinite(l.completes) || l.completes <= 0) continue;
    if (!Number.isFinite(l.cpi) || l.cpi < 0) continue;
    cost += l.completes * l.cpi;
  }
  return round2(cost);
}

/* ------------------------------------------------------------ rate card lookup */

export interface PricingQuery {
  market: string;
  /** incidence as a percentage, 0–100 */
  ir: number;
  loiMinutes: number;
  /** ISO timestamp the price must be valid at; defaults to now */
  at?: string;
}

function withinWindow(row: VendorPricingRow, atMs: number): boolean {
  const from = row.validFrom ? Date.parse(row.validFrom) : Number.NEGATIVE_INFINITY;
  const to = row.validTo ? Date.parse(row.validTo) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return atMs >= from && atMs < to;
}

/**
 * Bands are half-open, [min, max) — so a rate card with 10–20 and 20–30 has exactly one row for an incidence of
 * 20 and no gap at the boundary, which is the mistake every hand-written rate card lookup makes once.
 */
function bandMatches(row: VendorPricingRow, q: PricingQuery): boolean {
  return row.market === q.market
    && q.ir >= row.irMin && q.ir < row.irMax
    && q.loiMinutes >= row.loiMin && q.loiMinutes < row.loiMax;
}

/**
 * The applicable price, or null when the rate card does not cover this request.
 *
 * Null is a real answer and must be rendered as "no price configured for this market", never as a zero and never
 * as the nearest band. Picking the nearest band is how a US price gets quoted for Japan.
 *
 * Ties are broken by provenance first (a live figure beats an administrator's), then by the most recently
 * effective row, then by the tighter incidence band — the more specific rate card line is the one an operator
 * added deliberately.
 */
export function selectPricing(rows: readonly VendorPricingRow[], q: PricingQuery): VendorPricingRow | null {
  const atMs = q.at ? Date.parse(q.at) : Date.now();
  if (Number.isNaN(atMs)) return null;
  const candidates = rows.filter((r) => bandMatches(r, q) && withinWindow(r, atMs));
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => {
    const conf = SOURCE_CONFIDENCE[b.source] - SOURCE_CONFIDENCE[a.source];
    if (conf !== 0) return conf;
    const af = a.validFrom ? Date.parse(a.validFrom) : 0;
    const bf = b.validFrom ? Date.parse(b.validFrom) : 0;
    if (bf !== af) return bf - af;
    return (a.irMax - a.irMin) - (b.irMax - b.irMin);
  })[0]!;
}

/** The markets a rate card covers at all, for the marketplace's coverage column. */
export function pricedMarkets(rows: readonly VendorPricingRow[], at?: string): string[] {
  const atMs = at ? Date.parse(at) : Date.now();
  const set = new Set<string>();
  for (const r of rows) if (withinWindow(r, atMs)) set.add(r.market);
  return [...set].sort();
}

/**
 * The weakest provenance among the figures a number was built from — because a total assembled from one live
 * quotation and three administrator guesses is an administrator's guess, and must say so.
 */
export function weakestSource(sources: readonly PricingSource[]): PricingSource {
  if (!sources.length) return "administrator";
  return sources.slice().sort((a, b) => SOURCE_CONFIDENCE[a] - SOURCE_CONFIDENCE[b])[0]!;
}
