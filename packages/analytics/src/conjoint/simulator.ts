/**
 * THE MARKET SIMULATOR — one simulator for every conjoint method (F4, 2026-10-22).
 *
 * It reads a UtilityModel: per-respondent part-worths (HB posterior means, per-respondent least
 * squares for CVA) or one "respondent" carrying the aggregate logit. Products are attribute → level
 * maps with an optional price (interpolated on a numeric price attribute, or a linear summed-price
 * term) and cost. Everything is deterministic: random draws (randomized first choice) are seeded.
 *
 *   shares        logit (share of preference, scale λ), first choice (max utility), randomized
 *                 first choice (RFC: product AND attribute-level error, which relieves the IIA
 *                 problem for similar products), BTL (ratings models)
 *   revenue       share × price × market size; profit with costs
 *   WTP           market-simulation WTP (the price increase that brings the improved product's share
 *                 back to where it was — Sawtooth's recommended form) and the utility-ratio WTP
 *                 (Δu ÷ price slope), both caveated
 *   demand        the product's share and revenue across its tested price range, arc elasticities
 *   sensitivity   one attribute at a time: the product's share at each level
 *   optimisation  the best configuration of one product against fixed competitors (share, revenue
 *                 or profit), under prohibitions and fixed attributes — exhaustive when small,
 *                 seeded coordinate ascent with restarts otherwise
 *   segments      every result per segment (a demographic or latent classes)
 *
 * WHAT IT IS NOT: a forecast. Shares of preference assume full awareness and distribution and say
 * nothing about volume; utilities outside the tested range are extrapolations and are flagged.
 */
import { Rng } from "../models/rng.js";

export interface SimAttribute {
  name: string;
  levels: string[];
  /** numeric value per level (a price attribute) — enables interpolation between levels */
  values?: (number | null)[];
}
export interface SimRespondent {
  id: string;
  weight?: number;
  /** part-worths per attribute in level order */
  levels: Record<string, number[]>;
  /** None / threshold constant (choice models) */
  none?: number;
  /** utility per currency unit of a linear (summed) price */
  priceCoef?: number;
  /** ratings models: the intercept (predicted rating = intercept + Σ part-worths) */
  intercept?: number;
}
export interface UtilityModel {
  kind: "choice" | "ratings";
  attributes: SimAttribute[];
  respondents: SimRespondent[];
  /** the attribute whose levels are prices (numeric `values`) */
  priceAttribute?: string;
  /** linear price: the price the coefficient is centred on and the range that was shown */
  linearPrice?: { reference: number; min: number; max: number; label?: string };
  /** ratings models: the scale (for BTL) */
  scale?: { min: number; max: number };
  /** "aggregate logit" | "hierarchical Bayes" | "least squares" … — said in every table note */
  source: string;
}
export interface SimProduct { name: string; levels: Record<string, string>; price?: number; cost?: number }
export type ShareRule = "logit" | "first_choice" | "rfc" | "btl";
export interface SimOptions {
  rule?: ShareRule;
  /** logit / RFC scale (exponent); default 1 */
  scale?: number;
  /** include the None alternative (choice models with a None constant); default true */
  none?: boolean;
  rfc?: { draws?: number; attributeSd?: number; productScale?: number; seed?: number };
  /** people in the market, for revenue / profit (default 1,000) */
  marketSize?: number;
  /** respondent id → segment label */
  segments?: Map<string, string>;
}
export interface ShareResult {
  products: { name: string; share: number; price: number | null; revenue: number | null; profit: number | null; extrapolated: boolean }[];
  none: number | null;
  bySegment: { segment: string; n: number; shares: number[]; none: number | null }[];
  rule: ShareRule;
  respondents: number;
}

const gumbel = (r: Rng) => -Math.log(-Math.log(r.open()));

/** a level label's number: "$1,299" → 1299, "₹49.5" → 49.5 */
export function levelNumber(label: string): number | null {
  const m = String(label ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
/** numeric values for a price-like attribute (every level has a number), else undefined */
export function numericValues(levels: string[]): number[] | undefined {
  const v = levels.map(levelNumber);
  return v.every((x) => x != null) && new Set(v).size === v.length ? (v as number[]) : undefined;
}

/**
 * The part-worth of a price on a numeric attribute by PIECEWISE-LINEAR interpolation between the
 * tested levels (Sawtooth's simulator default); outside the range the end segment is extended and
 * `extrapolated` is set.
 */
export function interpolate(values: number[], utils: number[], x: number): { u: number; extrapolated: boolean } {
  const pts = values.map((v, i) => ({ v, u: utils[i] })).sort((a, b) => a.v - b.v);
  if (pts.length === 1) return { u: pts[0].u, extrapolated: x !== pts[0].v };
  let k = pts.findIndex((p) => p.v >= x);
  const extrapolated = x < pts[0].v - 1e-9 || x > pts[pts.length - 1].v + 1e-9;
  if (k <= 0) k = 1; if (k < 0 || x > pts[pts.length - 1].v) k = pts.length - 1;
  const a = pts[k - 1], b = pts[k];
  const t = (x - a.v) / (b.v - a.v || 1);
  return { u: a.u + t * (b.u - a.u), extrapolated };
}

/** a product's utility for one respondent (and whether a price was extrapolated) */
export function productUtility(m: UtilityModel, r: SimRespondent, p: SimProduct): { u: number; extrapolated: boolean } {
  let u = m.kind === "ratings" ? r.intercept ?? 0 : 0, ex = false;
  for (const a of m.attributes) {
    const pw = r.levels[a.name];
    if (!pw) continue;
    if (a.name === m.priceAttribute && a.values && a.values.every((v) => v != null)) {
      /* a price on a numeric price attribute: the product's own price, else its level read as a number ("$249" between "$199" and "$299") */
      const pr = p.price ?? (p.levels[a.name] != null && p.levels[a.name] !== "" ? levelNumber(p.levels[a.name]) : null);
      if (pr != null) { const it = interpolate(a.values as number[], pw, pr); u += it.u; ex = ex || it.extrapolated; continue; }
    }
    const lv = p.levels[a.name];
    if (lv == null || lv === "") continue;   // not part of this product (brand-specific attribute) → no utility
    const k = a.levels.indexOf(lv);
    if (k >= 0) u += pw[k];
  }
  if (m.linearPrice && p.price != null && r.priceCoef != null) {
    u += r.priceCoef * (p.price - m.linearPrice.reference);
    ex = ex || p.price < m.linearPrice.min - 1e-9 || p.price > m.linearPrice.max + 1e-9;
  }
  return { u, extrapolated: ex };
}

/** the price a product is sold at: its own price, else its price attribute's level read as a number */
export function productPrice(m: UtilityModel, p: SimProduct): number | null {
  if (p.price != null && Number.isFinite(p.price)) return p.price;
  if (m.priceAttribute) { const v = p.levels[m.priceAttribute]; const n = v != null ? levelNumber(v) : null; if (n != null) return n; }
  return null;
}

function sharesFor(m: UtilityModel, r: SimRespondent, products: SimProduct[], o: Required<Pick<SimOptions, "rule" | "scale" | "none">> & { rfc: Required<NonNullable<SimOptions["rfc"]>> }, rng: Rng | null): { s: number[]; none: number } {
  const U = products.map((p) => productUtility(m, r, p).u);
  const hasNone = o.none && m.kind === "choice" && r.none != null;
  if (o.rule === "btl") {
    const lo = m.scale?.min ?? 0;
    const w = U.map((u) => Math.max(1e-9, u - lo) ** o.scale);
    const T = w.reduce((t, x) => t + x, 0);
    return { s: w.map((x) => x / T), none: 0 };
  }
  if (o.rule === "first_choice") {
    const all = hasNone ? [...U, r.none!] : U;
    const mx = Math.max(...all);
    const winners = all.map((u) => (Math.abs(u - mx) < 1e-12 ? 1 : 0));
    const k = winners.reduce<number>((t, x) => t + x, 0);
    return { s: U.map((_, j) => winners[j] / k), none: hasNone ? winners[U.length] / k : 0 };
  }
  if (o.rule === "rfc") {
    const R = o.rfc.draws, out = new Array(U.length).fill(0); let none = 0;
    for (let d = 0; d < R; d++) {
      // one attribute-level error per (attribute, level), shared by every product carrying that level
      const attrErr = new Map<string, number>();
      const ue = products.map((p, j) => {
        let e = U[j];
        for (const a of m.attributes) { const lv = p.levels[a.name]; if (lv == null || lv === "") continue; const k = `${a.name}\u0000${lv}`; if (!attrErr.has(k)) attrErr.set(k, o.rfc.attributeSd * rng!.normal()); e += attrErr.get(k)!; }
        return o.scale * e + o.rfc.productScale * gumbel(rng!);
      });
      if (hasNone) ue.push(o.scale * r.none! + o.rfc.productScale * gumbel(rng!));
      const mx = ue.indexOf(Math.max(...ue));
      if (mx === U.length) none++; else out[mx]++;
    }
    return { s: out.map((x) => x / R), none: hasNone ? none / R : 0 };
  }
  const all = hasNone ? [...U, r.none!] : U;
  const mx = Math.max(...all.map((u) => o.scale * u));
  const e = all.map((u) => Math.exp(o.scale * u - mx));
  const T = e.reduce((t, x) => t + x, 0);
  return { s: U.map((_, j) => e[j] / T), none: hasNone ? e[U.length] / T : 0 };
}

function resolve(o: SimOptions, m: UtilityModel) {
  const rule: ShareRule = o.rule ?? (m.kind === "ratings" ? "first_choice" : "logit");
  return {
    rule, scale: o.scale ?? 1, none: o.none !== false,
    rfc: { draws: Math.max(10, Math.min(5000, o.rfc?.draws ?? (m.respondents.length > 1 ? 200 : 4000))), attributeSd: o.rfc?.attributeSd ?? 0.5, productScale: o.rfc?.productScale ?? 1, seed: o.rfc?.seed ?? 1 },
  };
}

/** shares of preference (and revenue / profit) for a market scenario */
export function simulateShares(m: UtilityModel, products: SimProduct[], opts: SimOptions = {}): ShareResult {
  const o = resolve(opts, m);
  const rng = o.rule === "rfc" ? new Rng(o.rfc.seed) : null;
  const acc = new Array(products.length).fill(0); let none = 0, W = 0;
  const seg = new Map<string, { n: number; w: number; s: number[]; none: number }>();
  for (const r of m.respondents) {
    const w = r.weight ?? 1;
    const { s, none: nn } = sharesFor(m, r, products, o, rng);
    s.forEach((x, j) => { acc[j] += w * x; }); none += w * nn; W += w;
    const g = opts.segments?.get(r.id);
    if (g != null) { const e = seg.get(g) ?? seg.set(g, { n: 0, w: 0, s: new Array(products.length).fill(0), none: 0 }).get(g)!; e.n++; e.w += w; s.forEach((x, j) => { e.s[j] += w * x; }); e.none += w * nn; }
  }
  const size = opts.marketSize ?? 1000;
  const hasNone = o.none && m.kind === "choice" && m.respondents.some((r) => r.none != null) && o.rule !== "btl";
  return {
    products: products.map((p, j) => {
      const share = W ? acc[j] / W : 0;
      const price = productPrice(m, p);
      const extrapolated = m.respondents.length ? productUtility(m, m.respondents[0], p).extrapolated : false;
      return { name: p.name, share, price, revenue: price != null ? share * price * size : null, profit: price != null && p.cost != null ? share * (price - p.cost) * size : null, extrapolated };
    }),
    none: hasNone ? (W ? none / W : 0) : null,
    bySegment: [...seg.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([segment, e]) => ({ segment, n: e.n, shares: e.s.map((x) => (e.w ? x / e.w : 0)), none: hasNone ? (e.w ? e.none / e.w : 0) : null })),
    rule: o.rule, respondents: m.respondents.length,
  };
}

/** the price range a model can price a product over: the numeric price attribute's levels, or the linear price's shown range */
export function priceRange(m: UtilityModel): { min: number; max: number } | null {
  if (m.linearPrice) return { min: m.linearPrice.min, max: m.linearPrice.max };
  const a = m.attributes.find((x) => x.name === m.priceAttribute);
  const v = a?.values?.filter((x): x is number => x != null) ?? [];
  return v.length >= 2 ? { min: Math.min(...v), max: Math.max(...v) } : null;
}
/** a product with its price set (numeric attribute: the interpolated price; linear: the price) */
export function withPrice(m: UtilityModel, p: SimProduct, price: number): SimProduct {
  return { ...p, price };
}

/** DEMAND CURVE: the product's share and revenue at prices across the tested range, with arc elasticities */
export function demandCurve(m: UtilityModel, products: SimProduct[], j: number, opts: SimOptions & { points?: number } = {}) {
  const range = priceRange(m);
  if (!range) return null;
  const n = Math.max(3, Math.min(25, opts.points ?? 9));
  const grid = Array.from({ length: n }, (_, k) => range.min + ((range.max - range.min) * k) / (n - 1));
  const rows = grid.map((price) => {
    const scen = products.map((p, i) => (i === j ? withPrice(m, p, price) : p.price == null && m.priceAttribute ? withPrice(m, p, productPrice(m, p) ?? price) : p));
    const res = simulateShares(m, scen, opts);
    return { price, share: res.products[j].share, revenue: res.products[j].revenue ?? price * res.products[j].share * (opts.marketSize ?? 1000) };
  });
  const out = rows.map((r, k) => {
    if (k === 0) return { ...r, elasticity: null as number | null };
    const a = rows[k - 1];
    const dq = (r.share - a.share) / (((r.share + a.share) / 2) || 1e-12), dp = (r.price - a.price) / ((r.price + a.price) / 2);
    return { ...r, elasticity: dp ? dq / dp : null };
  });
  const best = out.reduce((b, r) => (r.revenue > b.revenue ? r : b), out[0]);
  return { rows: out, revenueMaxPrice: best.price, range };
}

/** SENSITIVITY: the product's share at each level of each attribute, the rest of the market fixed */
export function sensitivity(m: UtilityModel, products: SimProduct[], j: number, opts: SimOptions = {}) {
  const base = simulateShares(m, products, opts).products[j].share;
  const rows: { attribute: string; level: string; share: number; delta: number; current: boolean }[] = [];
  for (const a of m.attributes) {
    if (a.name === m.priceAttribute && products[j].price != null) continue;
    for (const l of a.levels) {
      const scen = products.map((p, i) => (i === j ? { ...p, levels: { ...p.levels, [a.name]: l } } : p));
      const s = simulateShares(m, scen, opts).products[j].share;
      rows.push({ attribute: a.name, level: l, share: s, delta: s - base, current: products[j].levels[a.name] === l });
    }
  }
  return { base, rows };
}

/**
 * WILLINGNESS TO PAY, two ways (both caveated in the tables):
 *  - market WTP: the price increase at which the product WITH the new level has the share it had
 *    WITHOUT it, competitors fixed (bisection; "beyond the tested range" when not reached);
 *  - utility-ratio WTP: Δu ÷ |price slope| per respondent, the median reported (respondents whose
 *    price slope is not negative are counted, not used — their WTP is undefined).
 */
export function willingnessToPay(m: UtilityModel, products: SimProduct[], j: number, attribute: string, level: string, opts: SimOptions = {}) {
  const range = priceRange(m);
  const p0 = productPrice(m, products[j]);
  const a = m.attributes.find((x) => x.name === attribute);
  if (!a || !a.levels.includes(level) || !range || p0 == null) return null;
  const from = products[j].levels[attribute];
  const target = simulateShares(m, products.map((p, i) => (i === j ? withPrice(m, p, p0) : p)), opts).products[j].share;
  const improved = (price: number) => products.map((p, i) => (i === j ? withPrice(m, { ...p, levels: { ...p.levels, [attribute]: level } }, price) : p));
  const shareAt = (price: number) => simulateShares(m, improved(price), opts).products[j].share;
  let lo = p0, hi = range.max, market: number | null = null, beyond = false;
  if (shareAt(hi) > target) beyond = true;
  else if (shareAt(lo) <= target) market = 0;
  else { for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (shareAt(mid) > target) lo = mid; else hi = mid; } market = (lo + hi) / 2 - p0; }
  // utility-ratio WTP per respondent
  const ratios: number[] = []; let notPriceSensitive = 0;
  for (const r of m.respondents) {
    const pw = r.levels[attribute]; if (!pw) continue;
    const du = pw[a.levels.indexOf(level)] - (from != null && a.levels.includes(from) ? pw[a.levels.indexOf(from)] : 0);
    let slope: number | null = null;
    if (m.linearPrice && r.priceCoef != null) slope = r.priceCoef;
    else if (m.priceAttribute) {
      const pa = m.attributes.find((x) => x.name === m.priceAttribute); const v = pa?.values as number[] | undefined; const u = r.levels[m.priceAttribute];
      if (v && u) { const mx = v.reduce((t, x) => t + x, 0) / v.length, mu = u.reduce((t, x) => t + x, 0) / u.length; slope = v.reduce((t, x, i) => t + (x - mx) * (u[i] - mu), 0) / (v.reduce((t, x) => t + (x - mx) ** 2, 0) || 1); }
    }
    if (slope == null || !(slope < 0)) { notPriceSensitive++; continue; }
    ratios.push(du / -slope);
  }
  ratios.sort((x, y) => x - y);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  return { attribute, from: from ?? null, to: level, basePrice: p0, marketWtp: market, beyondRange: beyond, utilityWtpMedian: median, utilityWtpMean: ratios.length ? ratios.reduce((t, x) => t + x, 0) / ratios.length : null, notPriceSensitive, respondents: m.respondents.length };
}

export type Objective = "share" | "revenue" | "profit";
/**
 * PRODUCT OPTIMISATION: the configuration of product j that maximises the objective against the
 * other products as they are. `fixed` attributes keep the product's level; `isLegal` enforces
 * prohibitions; a price on a numeric price attribute or linear price is searched over `prices`
 * (default: the tested levels, or 7 points over the shown range).
 */
export function optimiseProduct(m: UtilityModel, products: SimProduct[], j: number, opts: SimOptions & { objective?: Objective; fixed?: string[]; isLegal?: (levels: Record<string, string>) => boolean; prices?: number[]; seed?: number; maxEvaluations?: number } = {}) {
  const objective = opts.objective ?? "share";
  const fixed = new Set(opts.fixed ?? []);
  const priceAttr = m.priceAttribute;
  const range = priceRange(m);
  const usesPrice = objective !== "share" || products[j].price != null;
  const prices = opts.prices ?? (range && (m.linearPrice || priceAttr) ? (m.linearPrice ? Array.from({ length: 7 }, (_, k) => range.min + ((range.max - range.min) * k) / 6) : ((m.attributes.find((a) => a.name === priceAttr)?.values ?? []) as number[])) : []);
  const free = m.attributes.filter((a) => !fixed.has(a.name) && !(a.name === priceAttr && prices.length));
  /* price is searched only for revenue / profit — for share the cheapest price would always win, so it is held where it is */
  const searchPrice = objective !== "share" && prices.length > 0 && !fixed.has(priceAttr ?? "\u0000price") && (usesPrice || !!m.linearPrice);
  const value = (levels: Record<string, string>, price: number | undefined) => {
    const p: SimProduct = { ...products[j], levels, ...(price != null ? { price } : {}) };
    if (opts.isLegal && !opts.isLegal(levels)) return -Infinity;
    const res = simulateShares(m, products.map((x, i) => (i === j ? p : x)), opts).products[j];
    return objective === "share" ? res.share : objective === "revenue" ? res.revenue ?? -Infinity : res.profit ?? -Infinity;
  };
  const space = free.reduce((n, a) => n * a.levels.length, 1) * (searchPrice ? prices.length : 1);
  const maxEval = opts.maxEvaluations ?? 50_000;
  const seen: { levels: Record<string, string>; price?: number; value: number }[] = [];
  let evaluations = 0;
  if (space <= maxEval) {
    const rec = (k: number, lv: Record<string, string>) => {
      if (k === free.length) {
        for (const pr of searchPrice ? prices : [products[j].price]) { evaluations++; seen.push({ levels: { ...lv }, ...(pr != null ? { price: pr } : {}), value: value({ ...lv }, pr ?? undefined) }); }
        return;
      }
      for (const l of free[k].levels) rec(k + 1, { ...lv, [free[k].name]: l });
    };
    rec(0, { ...products[j].levels });
  } else {
    const rng = new Rng(opts.seed ?? 1);
    for (let restart = 0; restart < 10 && evaluations < maxEval; restart++) {
      const lv = { ...products[j].levels };
      if (restart) for (const a of free) lv[a.name] = a.levels[Math.floor(rng.next() * a.levels.length)];
      let pr = searchPrice ? prices[Math.floor(rng.next() * prices.length)] : products[j].price;
      let cur = value(lv, pr ?? undefined); evaluations++;
      for (let pass = 0, improved = true; improved && pass < 20; pass++) {
        improved = false;
        for (const a of free) for (const l of a.levels) { const t = { ...lv, [a.name]: l }; const v = value(t, pr ?? undefined); evaluations++; if (v > cur + 1e-12) { cur = v; lv[a.name] = l; improved = true; } }
        if (searchPrice) for (const x of prices) { const v = value(lv, x); evaluations++; if (v > cur + 1e-12) { cur = v; pr = x; improved = true; } }
      }
      seen.push({ levels: { ...lv }, ...(pr != null ? { price: pr } : {}), value: cur });
    }
  }
  const uniq = new Map<string, (typeof seen)[number]>();
  for (const s of seen) { const k = JSON.stringify([s.levels, s.price]); if (!uniq.has(k) || uniq.get(k)!.value < s.value) uniq.set(k, s); }
  const top = [...uniq.values()].filter((s) => Number.isFinite(s.value)).sort((a, b) => b.value - a.value).slice(0, 5);
  return { objective, exhaustive: space <= maxEval, space, evaluations, best: top[0] ?? null, top, current: value(products[j].levels, products[j].price) };
}
