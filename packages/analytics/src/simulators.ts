import type { AnalysisResult } from "./types.js";
import type { Dataset } from "./dataset.js";
import { numericColumn, weights, itemLabelOf } from "./dataset.js";
import { expandBattery } from "./analyses/basics.js";

/**
 * WHAT-IF SIMULATORS (Level 5 roadmap M3 — 2026-11-29).
 *
 * The conjoint simulator already exists (conjoint/simulator.ts: shares by logit / first choice / RFC, revenue,
 * willingness to pay, demand curves, sensitivity, optimisation, segments, with Excel and PowerPoint export). These
 * add the three that were missing, each reading the result or the data the existing engine already uses:
 *
 *   maxdiffShares   share of preference within any subset of MaxDiff items, from the item utilities of a MaxDiff
 *                   result (by default the rule of the result's own share column — with every item in the subset it
 *                   reproduces them — or the logit choice rule).
 *   turfPortfolio   reach and frequency of a line-up you choose, what each item adds that nothing else covers, the
 *                   gain from adding each candidate, and the best single swap — on the same "asked" base as TURF.
 *   priceWhatIf     at a price you type: the share who would buy and the revenue index (Gabor-Granger or
 *                   Newton-Miller-Smith), and where the price sits on the Van Westendorp curves — interpolated
 *                   between tested prices and refused outside them, never extrapolated.
 */

export interface SimNote { level: "info" | "caution"; text: string }

/* ---------------------------------------------------------------- MaxDiff */
export interface MaxdiffShareResult { items: { item: string; utility: number; share: number }[]; unknown: string[]; notes: SimNote[] }

/**
 * Two rules. "rescaled" (the default) is the one the MaxDiff result's own share column uses — Sawtooth's rescaled
 * probability score, e^u ÷ (e^u + k − 1) for sets of k items, normalised to 100 over the chosen items — so a subset of
 * every item reproduces the result. "logit" is e^u ÷ Σe^u, the chance each item is picked best when all of the chosen
 * items are shown at once. k is read from the result: the set size whose rescaled scores reproduce its shares.
 */
export function maxdiffShares(result: AnalysisResult, subset: string[], opts: { rule?: "rescaled" | "logit"; itemsPerSet?: number } = {}): MaxdiffShareResult | { error: string } {
  const t = result.tables.find((x) => x.id === "maxdiff");
  if (!t) return { error: "This is not a MaxDiff result (it has no item-score table)." };
  const rows = (t.rows as Record<string, unknown>[]).filter((r) => typeof r.utility === "number");
  const byItem = new Map(rows.map((r) => [String(r.item), r.utility as number]));
  const wanted = subset.length ? subset : [...byItem.keys()];
  const known = wanted.filter((i) => byItem.has(i)), unknown = wanted.filter((i) => !byItem.has(i));
  if (known.length < 2) return { error: `Choose at least two items the MaxDiff measured${unknown.length ? ` (not measured: ${unknown.join(", ")})` : ""}.` };
  const rule = opts.rule ?? "rescaled";
  const rescaled = (us: number[], k: number) => { const p = us.map((u) => Math.exp(u) / (Math.exp(u) + k - 1)); const s = p.reduce((a, b) => a + b, 0); return p.map((x) => (x / s) * 100); };
  let k = opts.itemsPerSet ?? 0;
  if (rule === "rescaled" && !k) {
    const allU = rows.map((r) => r.utility as number), allS = rows.map((r) => r.share as number);
    let bestErr = Infinity;
    for (let c = 2; c <= 12; c++) { const e = rescaled(allU, c).reduce((a, x, i) => a + Math.abs(x - (allS[i] ?? 0)), 0); if (e < bestErr) { bestErr = e; k = c; } }
  }
  const us = known.map((i) => byItem.get(i)!);
  let shares: number[];
  if (rule === "rescaled") shares = rescaled(us, k);
  else { const m = Math.max(...us); const ex = us.map((u) => Math.exp(u - m)); const sum = ex.reduce((a, b) => a + b, 0); shares = ex.map((e) => (e / sum) * 100); }
  const items = known.map((item, j) => ({ item, utility: us[j]!, share: Math.round(shares[j]! * 10) / 10 })).sort((a, b) => b.share - a.share);
  const notes: SimNote[] = [
    rule === "rescaled"
      ? { level: "info", text: `Rescaled probability scores for sets of ${k} items (the rule of the result's own share column), out of 100 over the ${known.length} chosen items.` }
      : { level: "info", text: "Shares of preference: the chance each item would be picked best if all the chosen items were shown together (logit rule)." },
    { level: "caution", text: "From the aggregate utilities, which assume items compete equally (IIA): two similar items each keep their share instead of splitting it." },
    { level: "info", text: "Utilities are relative: a high share means preferred over the others in the set, not important in absolute terms." },
  ];
  return { items, unknown, notes };
}

/* ---------------------------------------------------------------- TURF */
export interface PortfolioResult {
  base: number; reach: number; frequency: number;
  items: { item: string; reach: number; unique: number }[];
  add: { item: string; reach: number; gain: number }[];
  bestSwap: { out: string; in: string; reach: number; gain: number } | null;
  unknown: string[]; notes: SimNote[];
}

export function turfPortfolio(ds: Dataset, battery: string[], portfolio: string[]): PortfolioResult | { error: string } {
  const vars = expandBattery(ds, battery);
  if (vars.length < 2) return { error: "TURF needs a multi-select question or several 0/1 items." };
  const labels = vars.map((v) => itemLabelOf(ds, v));
  const idx = (x: string) => { const i = vars.indexOf(x); return i >= 0 ? i : labels.indexOf(x); };
  const chosen = [...new Set(portfolio.map(idx).filter((i) => i >= 0))];
  const unknown = portfolio.filter((x) => idx(x) < 0);
  const raw = vars.map((v) => numericColumn(ds, v));
  const cols = raw.map((c) => c.map((x) => (x != null && x > 0 ? 1 : 0)));
  const w = weights(ds);
  const asked: number[] = [];
  for (let i = 0; i < ds.cases.length; i++) if (raw.some((c) => c[i] != null)) asked.push(i);
  const W = w ? asked.reduce((a, i) => a + w[i]!, 0) : asked.length;
  const reachOf = (set: number[]) => { let r = 0, f = 0; for (const i of asked) { let hit = 0; for (const j of set) hit += cols[j]![i]!; if (hit) { r += w?.[i] ?? 1; f += hit * (w?.[i] ?? 1); } } return { reach: W ? (r / W) * 100 : 0, frequency: r ? f / r : 0 }; };
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const now = reachOf(chosen);
  const items = chosen.map((j) => ({ item: labels[j]!, reach: r1(reachOf([j]).reach), unique: r1(now.reach - reachOf(chosen.filter((k) => k !== j)).reach) })).sort((a, b) => b.unique - a.unique);
  const others = vars.map((_, j) => j).filter((j) => !chosen.includes(j));
  const add = others.map((j) => { const r = reachOf([...chosen, j]).reach; return { item: labels[j]!, reach: r1(r), gain: r1(r - now.reach) }; }).sort((a, b) => b.gain - a.gain);
  let bestSwap: PortfolioResult["bestSwap"] = null;
  for (const o of chosen) for (const n of others) {
    const r = reachOf([...chosen.filter((k) => k !== o), n]).reach;
    if (r - now.reach > 0.05 && (!bestSwap || r > bestSwap.reach)) bestSwap = { out: labels[o]!, in: labels[n]!, reach: r1(r), gain: r1(r - now.reach) };
  }
  const notes: SimNote[] = [];
  if (asked.length < ds.cases.length) notes.push({ level: "info", text: `Based on the ${asked.length} of ${ds.cases.length} respondents who were asked this battery.` });
  if (asked.length < 100) notes.push({ level: "caution", text: `Only ${asked.length} respondents: a point of reach is about ${Math.round(100 / Math.max(1, asked.length) * 10) / 10} respondents' worth.` });
  for (const it of items) if (it.unique <= 0) notes.push({ level: "info", text: `“${it.item}” reaches nobody the rest of the line-up does not already reach.` });
  return { base: asked.length, reach: r1(now.reach), frequency: Math.round(now.frequency * 100) / 100, items, add, bestSwap, unknown, notes };
}

/* ---------------------------------------------------------------- price */
export interface PriceWhatIf {
  price: number;
  demand?: { method: "Gabor-Granger" | "Newton-Miller-Smith"; wouldBuy: number; revenueIndex: number; buyers?: number; revenue?: number; between: [number, number] };
  vanWestendorp?: { tooCheap: number; tooExpensive: number; acceptable: number; inRange: string | null };
  notes: SimNote[];
}

function interp(points: { x: number; y: number }[], x: number): { y: number; between: [number, number] } | null {
  const p = [...points].sort((a, b) => a.x - b.x);
  if (!p.length || x < p[0]!.x || x > p[p.length - 1]!.x) return null;
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.x === x) return { y: p[i]!.y, between: [x, x] };
    if (i && p[i]!.x > x) { const a = p[i - 1]!, b = p[i]!; return { y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x), between: [a.x, b.x] }; }
  }
  return null;
}

export function priceWhatIf(result: AnalysisResult, price: number, opts: { marketSize?: number } = {}): PriceWhatIf | { error: string } {
  if (!Number.isFinite(price) || price < 0) return { error: "Type a price of zero or more." };
  const notes: SimNote[] = [];
  const out: PriceWhatIf = { price, notes };
  const gg = result.tables.find((t) => t.id === "gg"), nms = result.tables.find((t) => t.id === "nms");
  const demand = gg ?? nms;
  if (demand) {
    const key = gg ? "probability" : "trial";
    const pts = (demand.rows as Record<string, unknown>[]).filter((r) => typeof r.price === "number" && typeof r[key] === "number").map((r) => ({ x: r.price as number, y: r[key] as number }));
    const hit = interp(pts, price);
    const lo = Math.min(...pts.map((p) => p.x)), hi = Math.max(...pts.map((p) => p.x));
    if (!hit) notes.push({ level: "caution", text: `${price} is outside the tested prices (${lo}–${hi}); demand there is not estimated — the data says nothing about it.` });
    else {
      const wouldBuy = Math.round(hit.y * 10) / 10;
      const revenueIndex = Math.round(price * (hit.y / 100) * 1000) / 1000;
      out.demand = { method: gg ? "Gabor-Granger" : "Newton-Miller-Smith", wouldBuy, revenueIndex, between: hit.between, ...(opts.marketSize ? { buyers: Math.round((opts.marketSize * hit.y) / 100), revenue: Math.round(opts.marketSize * (hit.y / 100) * price) } : {}) };
      if (hit.between[0] !== hit.between[1]) notes.push({ level: "info", text: `Interpolated in a straight line between the tested prices ${hit.between[0]} and ${hit.between[1]}.` });
      notes.push({ level: "caution", text: gg ? "Stated purchase intent overstates real buying; use it to compare prices, not to forecast volume." : "Trial is calibrated stated intent; it assumes full awareness and availability." });
    }
  }
  const curves = result.tables.find((t) => t.id === "curves");
  if (curves) {
    const rows = curves.rows as Record<string, number>[];
    const at = (k: string) => interp(rows.filter((r) => typeof r.price === "number" && typeof r[k] === "number").map((r) => ({ x: r.price!, y: r[k]! })), price);
    const tc = at("tooCheap"), te = at("tooExpensive");
    if (tc && te) {
      const pts = Object.fromEntries((result.tables.find((t) => t.id === "vw")?.rows as Record<string, unknown>[] | undefined ?? []).map((r) => [String(r.m), r.v as number]));
      const pmc = Object.entries(pts).find(([k]) => /PMC|marginal cheapness/i.test(k))?.[1], pme = Object.entries(pts).find(([k]) => /PME|marginal expensiveness/i.test(k))?.[1];
      const inRange = pmc != null && pme != null ? (price < pmc ? "below the acceptable range" : price > pme ? "above the acceptable range" : "inside the acceptable range") : null;
      out.vanWestendorp = { tooCheap: Math.round(tc.y * 10) / 10, tooExpensive: Math.round(te.y * 10) / 10, acceptable: Math.round((100 - tc.y - te.y) * 10) / 10, inRange };
    } else notes.push({ level: "caution", text: `${price} is outside the prices respondents named; the Van Westendorp curves are not read there.` });
  }
  if (!demand && !curves) return { error: "This is not a pricing result (no demand table and no Van Westendorp curves)." };
  return out;
}
