/**
 * MENU-BASED CONJOINT — the choice model and the menu simulator. F4, 2026-10-22.
 *
 * Sawtooth MBC's standard specification, as one parameter vector so the same sets feed the
 * aggregate logit and HB-MNL (models/hb.ts):
 *
 *   BUY ANYTHING (when the menu offers "buy nothing"): a binary logit, buy vs nothing, on a constant,
 *     each always-included item's price and the optional items' mean price — whether the respondent
 *     engages with the menu at all.
 *   EACH OPTIONAL ITEM (given they buy): a binary logit, take vs not, on a constant, the item's OWN
 *     price (linear, or part-worths per price point) and SELECTED CROSS prices — other items' prices
 *     that shift this item's take rate (substitutes, complements). "auto" keeps the cross effects
 *     significant at p < 0.01 in a model with all of them; a list names them; "none" drops them.
 *   EACH EXCLUSIVE SECTION ("Plan: Basic | Plus | Premium"): one multinomial logit over its items and
 *     "none of the section", with a constant and an own-price slope per item.
 *   Required (base) items are bought whenever anything is; their prices enter the buy model and are
 *     cross-price candidates.
 *
 * Prices are standardised per item, x = (price − mid) / half-range of the tested prices, so every
 * coefficient is on the same footing (reported per currency unit too). A binary logit is an MNL with
 * two alternatives (the take and an all-zero "not"), which is why HB needs nothing new.
 *
 * THE SIMULATOR: take rate per item = P(buy) × P(item | buy) (sections: the MNL), revenue per
 * respondent, what-if prices, price curves with the revenue-maximising price, and BUNDLES — a bundle
 * offered at one price is valued as the sum of its items' price-free utilities plus the bundle price
 * on the items' price-weighted slope, and each respondent (with seeded logistic errors, so the
 * à-la-carte choices match the logit) takes the bundle when it beats buying à la carte. That valuation
 * is an assumption (no bundle-specific effect is estimated) and every bundle table says so.
 */
import type { AnalysisDefinition, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import { conditionalLogit, type ChoiceSet } from "../stats/choice.js";
import { fmtPct, opt, pct, round } from "../analyses/common.js";
import { Rng } from "../models/rng.js";

export interface MenuItemSpec { item: string; label: string; required: boolean; group: string; prices: number[]; labels: string[]; mid: number; half: number }
export interface MenuBlock { kind: "buy" | "item" | "group"; key: string; label: string; offset: number; size: number; names: string[]; items: string[]; cross: string[]; /** per parameter: the item whose (standardised, linear) price it multiplies, else null */ priceOf: (string | null)[] }
export interface MenuLayout { items: MenuItemSpec[]; blocks: MenuBlock[]; P: number; buyModel: boolean; priceCoding: "linear" | "partworth" }
export interface MenuTask { prices: Record<string, number>; chosen: Set<string>; none: boolean }

const std = (it: MenuItemSpec, p: number) => (p - it.mid) / (it.half || 1);

/** the items of a menu design, with their tested prices */
export function menuItems(rows: Record<string, unknown>[]): MenuItemSpec[] {
  const m = new Map<string, MenuItemSpec>();
  for (const r of rows) {
    const id = String(r.item);
    const e = m.get(id) ?? m.set(id, { item: id, label: String(r.item_label ?? id), required: Number(r.required) === 1, group: r.group ? String(r.group) : "", prices: [], labels: [], mid: 0, half: 1 }).get(id)!;
    const v = Number(r.price_value);
    if (Number.isFinite(v) && !e.prices.includes(v)) { e.prices.push(v); e.labels.push(String(r.price ?? v)); }
  }
  for (const e of m.values()) {
    const order = e.prices.map((p, k) => ({ p, l: e.labels[k] })).sort((a, b) => a.p - b.p);
    e.prices = order.map((x) => x.p); e.labels = order.map((x) => x.l);
    const lo = Math.min(...e.prices), hi = Math.max(...e.prices);
    e.mid = (lo + hi) / 2; e.half = (hi - lo) / 2 || 1;
  }
  return [...m.values()].sort((a, b) => Number(a.item) - Number(b.item));
}

/** the parameter layout for a cross-effect choice (item → the items whose prices enter its model) */
export function menuLayout(items: MenuItemSpec[], buyModel: boolean, cross: Record<string, string[]>, priceCoding: "linear" | "partworth" = "linear"): MenuLayout {
  const blocks: MenuBlock[] = [];
  let P = 0;
  /*
   * The buy-anything model: a constant, each ALWAYS-INCLUDED item's price, and the mean standardised price of the
   * optional items — a menu-level price index, one parameter however long the menu (an item-by-item buy model left
   * the individual-level HB unidentified: one yes/no per menu cannot carry a slope per item).
   */
  if (buyModel) {
    const req = items.filter((i) => i.required), opt = items.filter((i) => !i.required);
    const names = ["Buy anything: constant", ...req.map((i) => `Buy anything: price of ${i.label}`), ...(opt.length ? ["Buy anything: optional prices (mean, standardised)"] : [])];
    blocks.push({ kind: "buy", key: "buy", label: "Buy anything from the menu", offset: P, size: names.length, names, items: items.map((i) => i.item), cross: [], priceOf: [null, ...req.map((i) => i.item), ...(opt.length ? [null] : [])] });
    P += names.length;
  }
  for (const it of items) {
    if (it.required || it.group) continue;
    const own = priceCoding === "partworth" ? it.labels.slice(1).map((l) => `${it.label}: price ${l} (vs ${it.labels[0]})`) : [`${it.label}: own price`];
    const cr = (cross[it.item] ?? []).filter((j) => j !== it.item && items.some((x) => x.item === j));
    const names = [`${it.label}: constant`, ...own, ...cr.map((j) => `${it.label}: price of ${items.find((x) => x.item === j)!.label}`)];
    blocks.push({ kind: "item", key: it.item, label: it.label, offset: P, size: names.length, names, items: [it.item], cross: cr, priceOf: [null, ...own.map(() => (priceCoding === "partworth" ? null : it.item)), ...cr] });
    P += names.length;
  }
  const groups = [...new Set(items.filter((i) => i.group && !i.required).map((i) => i.group))];
  for (const g of groups) {
    const its = items.filter((i) => i.group === g && !i.required);
    const names = [...its.map((i) => `${g}: ${i.label} constant`), ...its.map((i) => `${g}: ${i.label} own price`)];
    blocks.push({ kind: "group", key: `group:${g}`, label: g, offset: P, size: names.length, names, items: its.map((i) => i.item), cross: [], priceOf: [...its.map(() => null), ...its.map((i) => i.item)] });
    P += names.length;
  }
  return { items, blocks, P, buyModel, priceCoding };
}

/** the alternatives of one block for one task's prices (full-length vectors) */
export function blockAlternatives(L: MenuLayout, b: MenuBlock, prices: Record<string, number>): number[][] {
  const z = () => new Array(L.P).fill(0);
  const item = (id: string) => L.items.find((x) => x.item === id)!;
  if (b.kind === "buy") {
    const x = z(); x[b.offset] = 1;
    const req = L.items.filter((i) => i.required), opt = L.items.filter((i) => !i.required);
    req.forEach((it, k) => { const p = prices[it.item]; if (p != null) x[b.offset + 1 + k] = std(it, p); });
    if (opt.length) { const xs = opt.map((it) => (prices[it.item] != null ? std(it, prices[it.item]) : 0)); x[b.offset + 1 + req.length] = xs.reduce((t, v) => t + v, 0) / xs.length; }
    return [x, z()];
  }
  if (b.kind === "item") {
    const it = item(b.key); const x = z(); x[b.offset] = 1;
    const p = prices[it.item];
    if (L.priceCoding === "partworth") { const k = it.prices.indexOf(p); if (k === 0) for (let j = 1; j < it.prices.length; j++) x[b.offset + j] = -1; else if (k > 0) x[b.offset + k] = 1; }
    else if (p != null) x[b.offset + 1] = std(it, p);
    const ownSize = L.priceCoding === "partworth" ? it.prices.length - 1 : 1;
    b.cross.forEach((j, k) => { const pj = prices[j]; if (pj != null) x[b.offset + 1 + ownSize + k] = std(item(j), pj); });
    return [x, z()];
  }
  const m = b.items.length;
  return [...b.items.map((id, k) => { const x = z(); x[b.offset + k] = 1; const p = prices[id]; if (p != null) x[b.offset + m + k] = std(item(id), p); return x; }), z()];
}

/** one task → its choice sets, tagged by block */
export function menuTaskSets(L: MenuLayout, t: MenuTask): { set: ChoiceSet; block: number }[] {
  const out: { set: ChoiceSet; block: number }[] = [];
  L.blocks.forEach((b, bi) => {
    if (b.kind === "buy") { out.push({ set: { alternatives: blockAlternatives(L, b, t.prices), chosen: t.none ? 1 : 0 }, block: bi }); return; }
    if (t.none && L.buyModel) return;   // given they buy (the buy model carries the "nothing" answers)
    const alts = blockAlternatives(L, b, t.prices);
    if (b.kind === "item") out.push({ set: { alternatives: alts, chosen: t.chosen.has(b.key) && !t.none ? 0 : 1 }, block: bi });
    else { const k = b.items.findIndex((id) => t.chosen.has(id)); out.push({ set: { alternatives: alts, chosen: k >= 0 && !t.none ? k : b.items.length }, block: bi }); }
  });
  return out;
}

/** every respondent's menu tasks (prices they saw, items they took) */
export function menuTasks(ds: Dataset, qid: string) {
  const q = ds.def.questions.find((x) => x.id === qid);
  const design = q ? ds.def.designs.find((d) => d.id === q.settings.designRef) : undefined;
  if (!q || !design || design.kind !== "menu" || !design.file?.rows?.length) return null;
  const rows = design.file.rows as Record<string, unknown>[];
  const items = menuItems(rows);
  const byVT = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) { const k = `${r.version ?? 1}\u0000${r.task}`; (byVT.get(k) ?? byVT.set(k, []).get(k)!).push(r); }
  const respondents: { ci: number; id: string; tasks: MenuTask[] }[] = [];
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== "object" || Array.isArray(ans)) return;
    const version = String(c.vars[`${q.variableName}_VERSION`] ?? "1");
    const tasks: MenuTask[] = [];
    for (const [t, v] of Object.entries(ans)) {
      if (!Array.isArray(v)) continue;
      const shown = byVT.get(`${version}\u0000${t}`) ?? [];
      if (!shown.length) continue;
      const chosen = new Set(v.map(String).filter((x) => x !== "none"));
      tasks.push({ prices: Object.fromEntries(shown.map((r) => [String(r.item), Number(r.price_value)])), chosen, none: v.map(String).includes("none") });
    }
    if (tasks.length) respondents.push({ ci, id: c.id, tasks });
  });
  const noneOffered = (design.config as { noneOption?: boolean } | undefined)?.noneOption !== false;
  return { q, design, items, respondents, noneOffered };
}

export interface MenuFit { layout: MenuLayout; beta: number[]; se: number[]; p: number[]; blocks: { block: MenuBlock; logLik: number; nullLogLik: number; n: number; hitRate: number; converged: boolean }[] }

/** fit every block's logit (separable likelihood → block by block, same answer as one joint fit) */
export function fitMenuAggregate(L: MenuLayout, tasks: MenuTask[]): MenuFit {
  const beta = new Array(L.P).fill(0), se = new Array(L.P).fill(NaN), pv = new Array(L.P).fill(NaN);
  const per = L.blocks.map(() => [] as ChoiceSet[]);
  for (const t of tasks) for (const s of menuTaskSets(L, t)) per[s.block].push(s.set);
  const blocks = L.blocks.map((b, bi) => {
    const sub = per[bi].map((s) => ({ ...s, alternatives: s.alternatives.map((x) => x.slice(b.offset, b.offset + b.size)) }));
    const f = conditionalLogit(sub, b.size);
    for (let k = 0; k < b.size; k++) { beta[b.offset + k] = f.beta[k]; se[b.offset + k] = f.se[k]; pv[b.offset + k] = f.p[k]; }
    return { block: b, logLik: f.logLikelihood, nullLogLik: f.nullLogLikelihood, n: f.n, hitRate: f.hitRate, converged: f.converged };
  });
  return { layout: L, beta, se, p: pv, blocks };
}

/**
 * CROSS-EFFECT SELECTION: "auto" — every other item's price in each item's model, kept when |z| > 2.576
 * (p < 0.01, a strict bar because the candidates are many); an explicit list names effect pairs
 * [item, price-of-item] by label; "none" keeps own prices only.
 */
export function selectCrossEffects(items: MenuItemSpec[], tasks: MenuTask[], buyModel: boolean, spec: unknown, priceCoding: "linear" | "partworth"): { cross: Record<string, string[]>; tested: { item: string; of: string; z: number; kept: boolean }[] } {
  const byLabel = (x: string) => items.find((i) => i.label.toLowerCase() === String(x).toLowerCase() || i.item === String(x))?.item;
  if (Array.isArray(spec)) {
    const cross: Record<string, string[]> = {};
    for (const pair of spec) { const [a, b] = Array.isArray(pair) ? pair : []; const i = byLabel(a), j = byLabel(b); if (i && j && i !== j) (cross[i] ??= []).push(j); }
    return { cross, tested: [] };
  }
  if (spec === "none") return { cross: {}, tested: [] };
  const all: Record<string, string[]> = {};
  const candidates = (i: MenuItemSpec) => items.filter((j) => j.item !== i.item && j.prices.length > 1).map((j) => j.item);
  for (const it of items) if (!it.required && !it.group) all[it.item] = candidates(it);
  const full = menuLayout(items, buyModel, all, priceCoding);
  const fit = fitMenuAggregate(full, tasks);
  const cross: Record<string, string[]> = {}; const tested: { item: string; of: string; z: number; kept: boolean }[] = [];
  for (const b of full.blocks) {
    if (b.kind !== "item") continue;
    const ownSize = priceCoding === "partworth" ? items.find((x) => x.item === b.key)!.prices.length - 1 : 1;
    const n = fit.blocks.find((x) => x.block === b)!.n;
    b.cross.forEach((j, k) => {
      const c = b.offset + 1 + ownSize + k; const z = fit.beta[c] / fit.se[c];
      const kept = Number.isFinite(z) && Math.abs(z) > 2.576 && n >= 20 * b.size;
      tested.push({ item: b.key, of: j, z, kept });
      if (kept) (cross[b.key] ??= []).push(j);
    });
  }
  return { cross, tested };
}

/* ------------------------------------------------------------------ simulator */

export interface MenuScenario { name?: string; prices?: Record<string, number | string>; bundles?: { name: string; items: string[]; price: number | string }[] }
export interface MenuSimResult {
  items: { item: string; label: string; price: number; take: number; revenue: number; extrapolated: boolean }[];
  buyRate: number | null;
  bundles: { name: string; items: string[]; price: number; take: number; listPrice: number }[];
  revenuePerRespondent: number;
  respondents: number;
}
const logistic = (v: number) => 1 / (1 + Math.exp(-v));
const dot = (x: number[], b: ArrayLike<number>) => { let s = 0; for (let k = 0; k < x.length; k++) if (x[k]) s += x[k] * b[k]; return s; };

/** scenario prices: named items set (number or "₹499"), the rest at their middle tested price */
export function scenarioPrices(L: MenuLayout, sc: MenuScenario): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of L.items) {
    const key = Object.keys(sc.prices ?? {}).find((k) => k.toLowerCase() === it.label.toLowerCase() || k === it.item);
    const raw = key != null ? sc.prices![key] : undefined;
    const v = typeof raw === "number" ? raw : raw != null ? Number(String(raw).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]) : NaN;
    out[it.item] = Number.isFinite(v) ? v : it.prices[Math.floor((it.prices.length - 1) / 2)];
  }
  return out;
}

/** take rates and revenue for one respondent's β at given prices (exact, no bundles) */
function respondentTakes(L: MenuLayout, beta: ArrayLike<number>, prices: Record<string, number>) {
  const pBuy = L.buyModel ? (() => { const b = L.blocks.find((x) => x.kind === "buy")!; const [x] = blockAlternatives(L, b, prices); return logistic(dot(x, beta)); })() : 1;
  const take: Record<string, number> = {};
  for (const it of L.items) if (it.required) take[it.item] = pBuy;
  for (const b of L.blocks) {
    if (b.kind === "item") { const [x] = blockAlternatives(L, b, prices); take[b.key] = pBuy * logistic(dot(x, beta)); }
    if (b.kind === "group") { const alts = blockAlternatives(L, b, prices); const u = alts.map((x) => dot(x, beta)); const mx = Math.max(...u); const e = u.map((v) => Math.exp(v - mx)); const Z = e.reduce((t, v) => t + v, 0); b.items.forEach((id, k) => { take[id] = pBuy * (e[k] / Z); }); }
  }
  return { pBuy, take };
}

/**
 * The menu simulator over respondents' β (one aggregate β, or HB individual means). Bundles need
 * linear price coding; they are simulated with `draws` seeded logistic errors per respondent.
 */
export function simulateMenu(L: MenuLayout, betas: { id: string; beta: ArrayLike<number> }[], sc: MenuScenario, opts: { draws?: number; seed?: number } = {}): MenuSimResult {
  const prices = scenarioPrices(L, sc);
  const N = betas.length;
  const take: Record<string, number> = Object.fromEntries(L.items.map((i) => [i.item, 0]));
  let buy = 0, revenue = 0;
  const bundles = (sc.bundles ?? []).map((b) => {
    const ids = b.items.map((x) => L.items.find((i) => i.label.toLowerCase() === String(x).toLowerCase() || i.item === String(x))?.item).filter((x): x is string => !!x && !L.items.find((i) => i.item === x)!.required && !L.items.find((i) => i.item === x)!.group);
    const price = typeof b.price === "number" ? b.price : Number(String(b.price).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]);
    return { name: b.name, items: ids, price, take: 0, listPrice: ids.reduce((t, id) => t + prices[id], 0) };
  }).filter((b) => b.items.length >= 2 && Number.isFinite(b.price));
  const draws = Math.max(50, opts.draws ?? (N > 1 ? 300 : 20000));
  const rng = new Rng(opts.seed ?? 7);
  for (const { beta } of betas) {
    const r = respondentTakes(L, beta, prices);
    buy += r.pBuy / N;
    if (!bundles.length) {
      for (const [id, v] of Object.entries(r.take)) take[id] += v / N;
      revenue += L.items.reduce((t, it) => t + r.take[it.item] * prices[it.item], 0) / N;
      continue;
    }
    // bundles: utilities per item at scenario prices, price-free part A_i and slope b_i (per currency unit)
    const itemBlocks = L.blocks.filter((b) => b.kind === "item");
    const V: Record<string, number> = {}, slope: Record<string, number> = {};
    for (const b of itemBlocks) { const it = L.items.find((x) => x.item === b.key)!; const [x] = blockAlternatives(L, b, prices); V[b.key] = dot(x, beta); slope[b.key] = L.priceCoding === "linear" ? beta[b.offset + 1] / it.half : 0; }
    const groupBlocks = L.blocks.filter((b) => b.kind === "group");
    for (let d = 0; d < draws; d++) {
      const bought = new Set<string>();
      if (L.buyModel && rng.next() > r.pBuy) continue;
      for (const it of L.items) if (it.required) bought.add(it.item);
      const eps: Record<string, number> = {};
      for (const b of itemBlocks) { const u = rng.open(); eps[b.key] = Math.log(u / (1 - u)); }
      const surplus = (id: string) => V[id] + eps[id];
      const alc = itemBlocks.reduce((t, b) => t + Math.max(0, surplus(b.key)), 0);
      let best = { value: alc, bundle: -1 };
      bundles.forEach((B, bi) => {
        const wsum = B.items.reduce((t, id) => t + prices[id], 0) || 1;
        const bbar = B.items.reduce((t, id) => t + slope[id] * prices[id], 0) / wsum;
        const S = B.items.reduce((t, id) => t + surplus(id) - slope[id] * prices[id], 0) + bbar * B.price;
        const rest = itemBlocks.filter((b) => !B.items.includes(b.key)).reduce((t, b) => t + Math.max(0, surplus(b.key)), 0);
        if (S + rest > best.value && S > 0) best = { value: S + rest, bundle: bi };
      });
      let spend = 0;
      if (best.bundle >= 0) { const B = bundles[best.bundle]; B.take += 1 / (draws * N); for (const id of B.items) bought.add(id); spend += B.price; for (const b of itemBlocks) if (!B.items.includes(b.key) && surplus(b.key) > 0) { bought.add(b.key); spend += prices[b.key]; } }
      else for (const b of itemBlocks) if (surplus(b.key) > 0) { bought.add(b.key); spend += prices[b.key]; }
      for (const g of groupBlocks) { const alts = blockAlternatives(L, g, prices); const u = alts.map((x) => { const v = rng.open(); return dot(x, beta) - Math.log(-Math.log(v)); }); const k = u.indexOf(Math.max(...u)); if (k < g.items.length) { bought.add(g.items[k]); spend += prices[g.items[k]]; } }
      for (const it of L.items) if (it.required) spend += prices[it.item];
      for (const id of bought) take[id] += 1 / (draws * N);
      revenue += spend / (draws * N);
    }
  }
  return {
    items: L.items.map((it) => ({ item: it.item, label: it.label, price: prices[it.item], take: take[it.item], revenue: take[it.item] * prices[it.item], extrapolated: prices[it.item] < Math.min(...it.prices) - 1e-9 || prices[it.item] > Math.max(...it.prices) + 1e-9 })),
    buyRate: L.buyModel ? buy : null,
    bundles: bundles.map((b) => ({ name: b.name, items: b.items.map((id) => L.items.find((i) => i.item === id)!.label), price: b.price, take: b.take, listPrice: b.listPrice })),
    revenuePerRespondent: revenue, respondents: N,
  };
}

/** one item's price curve across its tested range: its take rate and revenue, and the menu's revenue */
export function menuPriceCurve(L: MenuLayout, betas: { id: string; beta: ArrayLike<number> }[], sc: MenuScenario, item: string, points = 7) {
  const it = L.items.find((i) => i.item === item || i.label.toLowerCase() === item.toLowerCase());
  if (!it) return null;
  const lo = Math.min(...it.prices), hi = Math.max(...it.prices);
  const base = scenarioPrices(L, sc);
  const rows = Array.from({ length: points }, (_, k) => lo + ((hi - lo) * k) / (points - 1)).map((p) => {
    const res = simulateMenu(L, betas, { prices: { ...base, [it.item]: p } });
    const r = res.items.find((x) => x.item === it.item)!;
    return { price: p, take: r.take, itemRevenue: r.revenue, menuRevenue: res.revenuePerRespondent };
  });
  return { item: it, rows, bestItemPrice: rows.reduce((b, r) => (r.itemRevenue > b.itemRevenue ? r : b)).price, bestMenuPrice: rows.reduce((b, r) => (r.menuRevenue > b.menuRevenue ? r : b)).price };
}

/* ------------------------------------------------------------------ the analysis */

const r3 = (x: number | null | undefined) => round(x, 3);

export function menuModelSpec(def: AnalysisDefinition, data: NonNullable<ReturnType<typeof menuTasks>>) {
  const priceCoding: "linear" | "partworth" = (opt(def, "menuPriceCoding", "linear") as string) === "partworth" ? "partworth" : "linear";
  const allTasks = data.respondents.flatMap((r) => r.tasks);
  const buyModel = data.noneOffered && allTasks.some((t) => t.none) && allTasks.some((t) => !t.none);
  const sel = selectCrossEffects(data.items, allTasks, buyModel, opt(def, "crossEffects", "auto"), priceCoding);
  return { layout: menuLayout(data.items, buyModel, sel.cross, priceCoding), tested: sel.tested, allTasks, buyModel };
}

/** the menu model's tables (appended after the counts table, which stays first and unchanged) */
export function menuModelTables(def: AnalysisDefinition, ds: Dataset, data: NonNullable<ReturnType<typeof menuTasks>>): { tables: ResultTable[]; insights: string[]; warnings: string[] } {
  const tables: ResultTable[] = [], insights: string[] = [], warnings: string[] = [];
  const optional = data.items.filter((i) => !i.required);
  if (!optional.length) return { tables, insights, warnings };
  const { layout: L, tested, allTasks, buyModel } = menuModelSpec(def, data);
  const minTasks = L.blocks.reduce((t, b) => Math.max(t, b.size), 0) * 10;
  if (allTasks.length < minTasks) { warnings.push(`Menu choice model not estimated: ${allTasks.length} answered menus are too few for ${L.P} parameters (at least ${minTasks}). The take-rate counts above are descriptive.`); return { tables, insights, warnings }; }
  const fit = fitMenuAggregate(L, allTasks);
  const perUnit = (b: MenuBlock, k: number): number | null => { const of = b.priceOf[k]; const it = of ? L.items.find((i) => i.item === of) : null; return it ? fit.beta[b.offset + k] / it.half : null; };
  tables.push({ id: "menu_model", title: "Menu-based conjoint — choice model (aggregate logits per item; multinomial per exclusive section)", columns: [{ key: "model", label: "Model" }, { key: "parameter", label: "Parameter" }, { key: "estimate", label: "Estimate", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }, { key: "p", label: "p-value", type: "number", decimals: 4 }, { key: "perUnit", label: "Per currency unit", type: "number", decimals: 5 }],
    rows: L.blocks.flatMap((b) => b.names.map((n, k) => ({ model: b.kind === "buy" ? "Buy anything" : b.kind === "group" ? `Section: ${b.label}` : `Item: ${b.label}`, parameter: n.replace(/^[^:]+:\s*/, ""), estimate: r3(fit.beta[b.offset + k]), se: r3(fit.se[b.offset + k]), p: round(fit.p[b.offset + k], 4), perUnit: round(perUnit(b, k), 5) }))),
    notes: [`Prices enter standardised per item ((price − middle) ÷ half the tested range); “per currency unit” undoes that. ${L.priceCoding === "partworth" ? "Own prices are part-worths per price point (effects-coded)." : "Own prices are linear."}`, buyModel ? "“Buy anything” is a binary logit on whether the respondent bought from the menu at all; the item models are fitted on the menus where they did (Sawtooth's two-stage MBC specification)." : "The menu had no “buy nothing” answers to model, so every menu enters the item models.", "Pooled across respondents — individual-level utilities: the Hierarchical Bayes analysis on this question uses the same specification."] });
  if (tested.length) tables.push({ id: "menu_cross", title: "Cross-price effects tested (kept at p < 0.01)", columns: [{ key: "item", label: "Item" }, { key: "of", label: "Price of" }, { key: "z", label: "z", type: "number", decimals: 2 }, { key: "kept", label: "In the model" }], rows: tested.map((t) => ({ item: L.items.find((i) => i.item === t.item)!.label, of: L.items.find((i) => i.item === t.of)!.label, z: round(t.z, 2), kept: t.kept ? "yes" : "no" })), notes: ["A positive cross effect: this item is taken MORE when the other item is dearer (a substitute); negative: a complement."] });
  // fit, and observed vs predicted take at the prices shown
  const pred: Record<string, number> = Object.fromEntries(L.items.map((i) => [i.item, 0])), obs: Record<string, number> = { ...pred };
  for (const t of allTasks) { const r = respondentTakes(L, fit.beta, t.prices); for (const it of L.items) { pred[it.item] += r.take[it.item] / allTasks.length; obs[it.item] += (!t.none && (it.required || t.chosen.has(it.item)) ? 1 : 0) / allTasks.length; } }
  tables.push({ id: "menu_fit", title: "Menu model fit — observed vs predicted take rates", columns: [{ key: "item", label: "Item" }, { key: "observed", label: "Observed take %", type: "pct", decimals: 1 }, { key: "predicted", label: "Predicted take %", type: "pct", decimals: 1 }, { key: "r2", label: "McFadden R² (its model)", type: "number", decimals: 3 }, { key: "hit", label: "Hit rate %", type: "pct", decimals: 1 }],
    rows: L.items.map((it) => { const b = fit.blocks.find((x) => x.block.items.includes(it.item) && x.block.kind !== "buy"); return { item: it.label + (it.required ? " (always included)" : ""), observed: pct(obs[it.item] * 100), predicted: pct(pred[it.item] * 100), r2: b ? r3(b.nullLogLik ? 1 - b.logLik / b.nullLogLik : null) : null, hit: b ? pct(b.hitRate * 100) : null }; }) });
  // simulator: the analysis's scenario, saved scenarios, else the middle prices
  const saved = Array.isArray((data.design.config as { simulations?: unknown[] } | undefined)?.simulations) ? ((data.design.config as { simulations: MenuScenario[] }).simulations) : [];
  const own = opt(def, "menuScenario", null) as MenuScenario | null;
  const scenarios: MenuScenario[] = own ? [own] : saved.length ? saved : [{ name: "Middle tested prices" }];
  scenarios.forEach((sc, k) => insights.push(...menuSimTables(L, [{ id: "aggregate", beta: fit.beta }], sc, tables, k ? `menu_sim${k + 1}` : "menu_sim", "aggregate logit").insights));
  for (const it of optional.filter((i) => !i.group)) {
    const c = menuPriceCurve(L, [{ id: "aggregate", beta: fit.beta }], scenarios[0], it.item);
    if (c) tables.push({ id: `menu_curve_${it.item}`, title: `Price curve — ${it.label}`, columns: [{ key: "price", label: "Price", type: "number", decimals: 2 }, { key: "take", label: "Take rate %", type: "pct", decimals: 1 }, { key: "item", label: "Item revenue per respondent", type: "number", decimals: 2 }, { key: "menu", label: "Menu revenue per respondent", type: "number", decimals: 2 }], rows: c.rows.map((r) => ({ price: round(r.price, 2), take: pct(r.take * 100), item: round(r.itemRevenue, 2), menu: round(r.menuRevenue, 2) })), notes: [`Within the tested range: item revenue peaks at ${round(c.bestItemPrice, 2)}, the whole menu's at ${round(c.bestMenuPrice, 2)} (cross effects included). Other prices as in “${scenarios[0].name ?? "the scenario"}”.`] });
  }
  return { tables, insights, warnings };
}

/** the simulator tables for one menu scenario */
export function menuSimTables(L: MenuLayout, betas: { id: string; beta: ArrayLike<number> }[], sc: MenuScenario, tables: ResultTable[], id: string, source: string) {
  const res = simulateMenu(L, betas, sc);
  tables.push({ id, title: `Menu simulator — ${sc.name ?? "scenario"}`, columns: [{ key: "item", label: "Item" }, { key: "price", label: "Price", type: "number", decimals: 2 }, { key: "take", label: "Take rate %", type: "pct", decimals: 1 }, { key: "revenue", label: "Revenue per respondent", type: "number", decimals: 2 }],
    rows: [...res.items.map((r) => ({ item: r.label + (r.extrapolated ? " (price outside tested range)" : ""), price: round(r.price, 2), take: pct(r.take * 100), revenue: round(r.revenue, 2) })), ...(res.buyRate != null ? [{ item: "Buys anything from the menu", price: null, take: pct(res.buyRate * 100), revenue: null }] : []), { item: "Total menu revenue per respondent", price: null, take: null, revenue: round(res.revenuePerRespondent, 2) }],
    notes: [`Utilities: ${source}${betas.length > 1 ? ` (${betas.length} respondents simulated on their own utilities)` : ""}. Take rate = P(buy anything) × P(item | buy). Revenue counts the prices of what is taken${res.bundles.length ? " (a bundle at its bundle price)" : ""}; always-included items count whenever something is bought.`] });
  if (res.bundles.length) tables.push({ id: `${id}_bundles`, title: `Bundles — ${sc.name ?? "scenario"}`, columns: [{ key: "bundle", label: "Bundle" }, { key: "items", label: "Items" }, { key: "price", label: "Bundle price", type: "number", decimals: 2 }, { key: "list", label: "À-la-carte total", type: "number", decimals: 2 }, { key: "take", label: "Take rate %", type: "pct", decimals: 1 }],
    rows: res.bundles.map((b) => ({ bundle: b.name, items: b.items.join(" + "), price: round(b.price, 2), list: round(b.listPrice, 2), take: pct(b.take * 100) })),
    notes: ["ASSUMPTION: a bundle is valued as the sum of its items' utilities without price, plus the bundle price on the items' price-weighted price slope; each simulated respondent takes it when that beats buying the items à la carte (seeded logistic errors, so à-la-carte choices match the logit). No bundle-specific effect was measured — a bundle that was never shown is an extrapolation of the item models.", ...(betas.length === 1 ? ["Simulated on the aggregate model: run the Hierarchical Bayes analysis for respondent-level heterogeneity, which matters for bundles."] : [])] });
  const insights: string[] = [];
  const top = res.items.filter((i) => L.items.find((x) => x.item === i.item && !x.required)).sort((a, b) => b.take - a.take)[0];
  if (top) insights.push(`${sc.name ?? "Scenario"}: ${top.label} has the highest take rate (${fmtPct(top.take * 100, 0)}); menu revenue ${round(res.revenuePerRespondent, 2)} per respondent${res.bundles.length ? `; bundle ${res.bundles.map((b) => `“${b.name}” ${fmtPct(b.take * 100, 0)}`).join(", ")}` : ""}.`);
  return { res, insights };
}

