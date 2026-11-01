/**
 * PRICING MODELS (S5c, 2026-11-01) — the arithmetic behind `pricing`, kept pure so every number is checked
 * against hand-computed reference values (pricingModels.test.ts).
 *
 * VAN WESTENDORP (PSM). Four open price answers per respondent: too cheap (TC), cheap / a bargain (C),
 * expensive (E), too expensive (TE). Cumulative curves on the grid of every price given:
 *   tooCheap(p)  = % with TC ≥ p      cheap(p)     = % with C ≥ p
 *   expensive(p) = % with E ≤ p       tooExp(p)    = % with TE ≤ p
 *   notCheap(p)  = 100 − cheap(p)     notExp(p)    = 100 − expensive(p)
 * Two definitions of the range end-points are in use, and the result says which one it shows:
 *   "proxy"     (the default, unchanged since the first release, common in practice):
 *               PMC = tooCheap ∩ expensive          PME = cheap ∩ tooExpensive
 *   "textbook"  (Van Westendorp 1976, with the "not" curves):
 *               PMC = tooCheap ∩ notCheap           PME = tooExpensive ∩ notExpensive
 * OPP = tooCheap ∩ tooExpensive and IPP = cheap ∩ expensive (= notCheap ∩ notExpensive) in both.
 * A crossing is the first sign change scanning up the grid, linearly interpolated between grid prices.
 *
 * NEWTON–MILLER–SMITH (NMS, 1993) EXTENSION. Two purchase-likelihood answers per respondent — at their own
 * "cheap" price and at their own "expensive" price — calibrated into probabilities (default 5-point
 * calibration, top box first: 0.7 / 0.5 / 0.3 / 0.1 / 0 — a commonly used calibration, not a law; set your own).
 * Each respondent's purchase probability as a function of price is piecewise linear through
 *   (TC, 0) → (C, pCheap) → (E, pExpensive) → (TE, 0), and 0 outside [TC, TE]
 * (at or below "too cheap" the quality is doubted; at or above "too expensive" nobody buys). The TRIAL curve is
 * the (weighted) mean probability; REVENUE(p) = p × trial(p). The trial optimum lies on a grid price (the mean of
 * piecewise-linear functions is piecewise linear on the union grid); the revenue optimum is found exactly on each
 * segment (p·T(p) is a parabola there).
 *
 * ADAPTIVE GABOR–GRANGER (the `price_ladder` question). Each respondent's answer is the highest price they
 * accepted on the ladder (0 = none). Under the method's monotonicity assumption (who buys at p buys at every lower
 * price) demand(p) = % with highest-accepted ≥ p, revenue(p) = p × demand(p) / 100.
 */

export type VwDefinition = "proxy" | "textbook";
export interface VwRow { tooCheap: number; cheap: number; expensive: number; tooExpensive: number; w?: number }
export interface VwCurvePoint { price: number; tooCheap: number; cheap: number; expensive: number; tooExpensive: number; notCheap: number; notExpensive: number }
export interface VwPoints { pmc: number | null; pme: number | null; opp: number | null; ipp: number | null }

export function vanWestendorpCurves(rows: readonly VwRow[]): VwCurvePoint[] {
  const W = rows.reduce((t, r) => t + (r.w ?? 1), 0) || 1;
  const grid = [...new Set(rows.flatMap((r) => [r.tooCheap, r.cheap, r.expensive, r.tooExpensive]))].sort((a, b) => a - b);
  const share = (pred: (r: VwRow) => boolean) => (rows.reduce((t, r) => t + (pred(r) ? (r.w ?? 1) : 0), 0) / W) * 100;
  return grid.map((p) => {
    const cheap = share((r) => r.cheap >= p), expensive = share((r) => r.expensive <= p);
    return { price: p, tooCheap: share((r) => r.tooCheap >= p), cheap, expensive, tooExpensive: share((r) => r.tooExpensive <= p), notCheap: 100 - cheap, notExpensive: 100 - expensive };
  });
}

/** the first price where curve a meets curve b, scanning up the grid, linearly interpolated */
export function crossing(curves: readonly VwCurvePoint[], a: (c: VwCurvePoint) => number, b: (c: VwCurvePoint) => number): number | null {
  for (let i = 1; i < curves.length; i++) {
    const d0 = a(curves[i - 1]) - b(curves[i - 1]), d1 = a(curves[i]) - b(curves[i]);
    if (d0 === 0) return curves[i - 1].price;
    if (d0 * d1 < 0) { const t = d0 / (d0 - d1); return curves[i - 1].price + t * (curves[i].price - curves[i - 1].price); }
  }
  if (curves.length && a(curves[curves.length - 1]) === b(curves[curves.length - 1])) return curves[curves.length - 1].price;
  return null;
}

export function vanWestendorpPoints(curves: readonly VwCurvePoint[], definition: VwDefinition = "proxy"): VwPoints {
  return {
    pmc: definition === "textbook" ? crossing(curves, (c) => c.tooCheap, (c) => c.notCheap) : crossing(curves, (c) => c.tooCheap, (c) => c.expensive),
    pme: definition === "textbook" ? crossing(curves, (c) => c.tooExpensive, (c) => c.notExpensive) : crossing(curves, (c) => c.cheap, (c) => c.tooExpensive),
    opp: crossing(curves, (c) => c.tooCheap, (c) => c.tooExpensive),
    ipp: crossing(curves, (c) => c.cheap, (c) => c.expensive),
  };
}

/* ------------------------------------------------------------ NMS */

/** a commonly used 5-point calibration, top box first (definitely → definitely not) */
export const NMS_DEFAULT_CALIBRATION: readonly number[] = [0.7, 0.5, 0.3, 0.1, 0];

export interface NmsRow extends VwRow { pCheap: number; pExpensive: number }

/** one respondent's purchase probability at a price: (TC,0) → (C,pCheap) → (E,pExpensive) → (TE,0), 0 outside */
export function nmsProbability(r: NmsRow, price: number): number {
  const knots: [number, number][] = [[r.tooCheap, 0], [r.cheap, r.pCheap], [r.expensive, r.pExpensive], [r.tooExpensive, 0]];
  if (price <= r.tooCheap || price >= r.tooExpensive) {
    /* a respondent whose "cheap" equals "too cheap" (or "expensive" equals "too expensive") keeps the stated probability at that price */
    if (price === r.cheap) return r.pCheap;
    if (price === r.expensive) return r.pExpensive;
    return 0;
  }
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    if (price === x1) return y1;
    if (price > x0 && price < x1) return y0 + ((price - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0;
}

export interface NmsPoint { price: number; trial: number; revenue: number }
export interface NmsResult { curve: NmsPoint[]; trialOptimum: NmsPoint | null; revenueOptimum: NmsPoint | null; n: number }

export function nmsAnalysis(rows: readonly NmsRow[]): NmsResult {
  const W = rows.reduce((t, r) => t + (r.w ?? 1), 0);
  if (!rows.length || !(W > 0)) return { curve: [], trialOptimum: null, revenueOptimum: null, n: 0 };
  const grid = [...new Set(rows.flatMap((r) => [r.tooCheap, r.cheap, r.expensive, r.tooExpensive]))].sort((a, b) => a - b);
  const trialAt = (p: number) => rows.reduce((t, r) => t + nmsProbability(r, p) * (r.w ?? 1), 0) / W;
  const curve = grid.map((p) => { const t = trialAt(p); return { price: p, trial: t, revenue: p * t }; });
  let trialOptimum: NmsPoint | null = null;
  for (const c of curve) if (!trialOptimum || c.trial > trialOptimum.trial) trialOptimum = c;
  /* revenue: the knots, plus the vertex of p·T(p) inside each segment where T falls */
  let revenueOptimum: NmsPoint | null = null;
  const consider = (c: NmsPoint) => { if (!revenueOptimum || c.revenue > revenueOptimum.revenue + 1e-12) revenueOptimum = c; };
  curve.forEach(consider);
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    const s = (b.trial - a.trial) / (b.price - a.price);
    if (!(s < 0)) continue;
    const v = (s * a.price - a.trial) / (2 * s);
    if (v > a.price && v < b.price) { const t = a.trial + s * (v - a.price); consider({ price: v, trial: t, revenue: v * t }); }
  }
  return { curve, trialOptimum, revenueOptimum, n: rows.length };
}

/** a calibration map from a likelihood scale's codes (highest code = most likely unless told otherwise) */
export function nmsCalibrationFor(codes: readonly number[], given?: Record<string, number> | readonly number[] | null, topIsHighest = true): Map<number, number> | string {
  const sorted = [...new Set(codes)].sort((a, b) => (topIsHighest ? b - a : a - b));
  if (given && !Array.isArray(given)) {
    const m = new Map<number, number>();
    for (const [k, v] of Object.entries(given)) { const p = Number(v); if (!(p >= 0 && p <= 1)) return `calibration for code ${k} must be a probability 0–1`; m.set(Number(k), p); }
    const missing = sorted.filter((c) => !m.has(c));
    return missing.length ? `calibration gives no probability for code${missing.length === 1 ? "" : "s"} ${missing.join(", ")}` : m;
  }
  const list = (given as readonly number[] | null | undefined) ?? (sorted.length === NMS_DEFAULT_CALIBRATION.length ? NMS_DEFAULT_CALIBRATION : null);
  if (!list) return `the likelihood scale has ${sorted.length} points; the default calibration is for 5 — give one probability per code (calibration)`;
  if (list.length !== sorted.length) return `calibration has ${list.length} probabilities for a ${sorted.length}-point scale`;
  if (list.some((p) => !(p >= 0 && p <= 1))) return "every calibration probability must be 0–1";
  return new Map(sorted.map((c, i) => [c, list[i]]));
}

/* ------------------------------------------------------------ adaptive Gabor–Granger */

export interface LadderPoint { price: number; demand: number; revenue: number }
/** demand at each ladder price from the highest price each respondent accepted (0 / below the ladder = none) */
export function ladderDemand(highest: readonly (number | null)[], prices: readonly number[], w?: readonly number[] | null): { rows: LadderPoint[]; n: number; weightedN: number } {
  const ladder = [...new Set(prices)].sort((a, b) => a - b);
  let W = 0, n = 0;
  const acc = ladder.map(() => 0);
  highest.forEach((h, i) => {
    if (h == null || !Number.isFinite(h)) return;
    const wt = w?.[i] ?? 1;
    if (!(wt > 0)) return;
    W += wt; n++;
    ladder.forEach((p, k) => { if (h >= p) acc[k] += wt; });
  });
  return { rows: ladder.map((p, k) => { const d = W ? (acc[k] / W) * 100 : 0; return { price: p, demand: d, revenue: (p * d) / 100 }; }), n, weightedN: W };
}
