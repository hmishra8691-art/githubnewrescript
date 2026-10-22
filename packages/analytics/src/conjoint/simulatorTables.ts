/**
 * The simulator as result tables — what every conjoint runner (CBC, ACBC, menu's CBC-like cousins,
 * CVA, HB) appends when `options.simulator` asks for it, or when the design carries saved scenarios
 * (`config.simulations`, written by the `simulate_conjoint` action). F4, 2026-10-22.
 *
 *   options.simulator = {
 *     products?: [{ name, levels: {attribute: level}, price?, cost? }],
 *     rule?: "logit" | "first_choice" | "rfc" | "btl", scale?, none?, rfc?: { draws, attributeSd, productScale, seed },
 *     marketSize?: number,
 *     segmentBy?: "<variable>"  | segments?: { "<respondent id or code>": "<label>" }   (e.g. LCA classes),
 *     wtp?: [{ product?, attribute, level }], demand?: true | { product?, points? },
 *     sensitivity?: true | { product? }, optimize?: { product?, objective?: "share"|"revenue"|"profit", fixed?: [] },
 *   }
 */
import type { ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, type Dataset } from "../dataset.js";
import { pct, round } from "../analyses/common.js";
import { demandCurve, optimiseProduct, productPrice, sensitivity, simulateShares, willingnessToPay, type SimOptions, type SimProduct, type UtilityModel } from "./simulator.js";

export interface SimulatorSpec {
  products?: SimProduct[];
  rule?: SimOptions["rule"]; scale?: number; none?: boolean; rfc?: SimOptions["rfc"]; marketSize?: number;
  segmentBy?: string; segments?: Record<string, string>;
  wtp?: { product?: number | string; attribute: string; level: string }[];
  demand?: boolean | { product?: number | string; points?: number };
  sensitivity?: boolean | { product?: number | string };
  optimize?: { product?: number | string; objective?: "share" | "revenue" | "profit"; fixed?: string[] };
  /** a saved scenario's name (shown in the titles) */
  name?: string;
}

const r3 = (x: number | null | undefined) => round(x, 3);
const money = (x: number | null | undefined) => (x == null ? null : round(x, 2));

/** the best and worst profiles of the model's mean utilities — the default market */
export function defaultProducts(m: UtilityModel): SimProduct[] {
  const mean = (a: string, k: number) => m.respondents.reduce((t, r) => t + (r.levels[a]?.[k] ?? 0) * (r.weight ?? 1), 0);
  const pick = (better: boolean) => Object.fromEntries(m.attributes.map((a) => { let b = 0; for (let k = 1; k < a.levels.length; k++) if (better ? mean(a.name, k) > mean(a.name, b) : mean(a.name, k) < mean(a.name, b)) b = k; return [a.name, a.levels[b]]; }));
  return [{ name: "Best profile", levels: pick(true) }, { name: "Worst profile", levels: pick(false) }];
}

/** respondent id → segment label, from a categorical variable or an explicit map (LCA classes) */
export function segmentMap(ds: Dataset, spec: SimulatorSpec): Map<string, string> | undefined {
  if (spec.segments && typeof spec.segments === "object") {
    const m = new Map<string, string>();
    for (const c of ds.cases) { const l = spec.segments[c.id] ?? (c.code ? spec.segments[c.code] : undefined); if (l != null) m.set(c.id, String(l)); }
    return m.size ? m : undefined;
  }
  if (!spec.segmentBy || !ds.byName.has(spec.segmentBy)) return undefined;
  const col = categoricalColumn(ds, spec.segmentBy), cats = categoriesOf(ds, spec.segmentBy);
  const m = new Map<string, string>();
  ds.cases.forEach((c, i) => { const x = col[i]; if (x == null || Array.isArray(x)) return; const cat = cats.find((k) => k.code === x); m.set(c.id, cat?.label ?? String(x)); });
  return m;
}

const productIndex = (products: SimProduct[], ref: number | string | undefined) => {
  if (ref == null) return 0;
  if (typeof ref === "number") return Math.max(0, Math.min(products.length - 1, ref));
  const k = products.findIndex((p) => p.name.toLowerCase() === String(ref).toLowerCase());
  return k >= 0 ? k : 0;
};

export function simulatorTables(m: UtilityModel, spec: SimulatorSpec, ds: Dataset | null, opts: { isLegal?: (levels: Record<string, string>) => boolean; idPrefix?: string } = {}): { tables: ResultTable[]; insights: string[]; warnings: string[] } {
  const pre = opts.idPrefix ?? "sim";
  const products = spec.products?.length ? spec.products : defaultProducts(m);
  const so: SimOptions = { rule: spec.rule, scale: spec.scale, none: spec.none, rfc: spec.rfc, marketSize: spec.marketSize, segments: ds ? segmentMap(ds, spec) : undefined };
  const res = simulateShares(m, products, so);
  const tables: ResultTable[] = [];
  const insights: string[] = [], warnings: string[] = [];
  const ruleWords: Record<string, string> = { logit: `share of preference (logit${so.scale && so.scale !== 1 ? `, scale ${so.scale}` : ""})`, first_choice: "first choice (maximum utility)", rfc: "randomized first choice (product and attribute-level error, seeded draws)", btl: "BTL (share proportional to predicted rating)" };
  const anyPrice = res.products.some((p) => p.price != null);
  const anyCost = products.some((p) => p.cost != null);
  const size = spec.marketSize ?? 1000;
  tables.push({
    id: `${pre}_shares`, title: `Market simulator${spec.name ? ` — ${spec.name}` : ""}: ${ruleWords[res.rule]}`,
    columns: [{ key: "product", label: "Product" }, { key: "levels", label: "Levels" }, { key: "share", label: "Share %", type: "pct", decimals: 1 },
      ...(anyPrice ? [{ key: "price", label: "Price", type: "number" as const, decimals: 2 }, { key: "revenue", label: `Revenue per ${size.toLocaleString()} people`, type: "number" as const, decimals: 0 }] : []),
      ...(anyCost ? [{ key: "profit", label: `Profit per ${size.toLocaleString()} people`, type: "number" as const, decimals: 0 }] : [])],
    rows: [
      ...res.products.map((p, j) => ({ product: p.name + (p.extrapolated ? " (price extrapolated)" : ""), levels: Object.entries(products[j].levels).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; "), share: pct(p.share * 100), ...(anyPrice ? { price: money(p.price), revenue: p.revenue == null ? null : round(p.revenue, 0) } : {}), ...(anyCost ? { profit: p.profit == null ? null : round(p.profit, 0) } : {}) })),
      ...(res.none != null ? [{ product: "None", levels: "No purchase", share: pct(res.none * 100) }] : []),
    ],
    notes: [
      `Utilities: ${m.source}${m.respondents.length > 1 ? ` (${m.respondents.length} respondents, each simulated on their own utilities and averaged)` : " (one set of utilities for the whole sample)"}.`,
      "Shares of preference, not market shares: they assume every product is known and available, and they carry no volume or timing. Calibrate to real shares before forecasting.",
      ...(res.products.some((p) => p.extrapolated) ? ["A price outside the tested range is an extrapolation of the price utility and is less reliable."] : []),
    ],
  });
  const top = res.products.reduce((b, p) => (p.share > b.share ? p : b), res.products[0]);
  if (top) insights.push(`In this scenario ${top.name} takes ${(top.share * 100).toFixed(1)}%${res.none != null ? `, and ${(res.none * 100).toFixed(1)}% choose none` : ""} (${ruleWords[res.rule]}).`);
  if (res.bySegment.length) {
    tables.push({ id: `${pre}_segments`, title: "Simulator by segment", columns: [{ key: "segment", label: "Segment" }, { key: "n", label: "Respondents", type: "number", decimals: 0 }, ...products.map((p, j) => ({ key: `p${j}`, label: `${p.name} %`, type: "pct" as const, decimals: 1 })), ...(res.none != null ? [{ key: "none", label: "None %", type: "pct" as const, decimals: 1 }] : [])],
      rows: res.bySegment.map((s) => ({ segment: s.segment, n: s.n, ...Object.fromEntries(s.shares.map((x, j) => [`p${j}`, pct(x * 100)])), ...(s.none != null ? { none: pct(s.none * 100) } : {}) })),
      notes: [m.respondents.length > 1 ? "Each segment's shares average its own respondents' simulated shares." : "The aggregate model has one set of utilities, so every segment gets the same shares — run the Hierarchical Bayes analysis (or CVA) for segment differences."] });
  }
  if (spec.demand) {
    const j = productIndex(products, typeof spec.demand === "object" ? spec.demand.product : undefined);
    const d = demandCurve(m, products, j, { ...so, points: typeof spec.demand === "object" ? spec.demand.points : undefined });
    if (d) {
      tables.push({ id: `${pre}_demand`, title: `Demand curve — ${products[j].name} across the tested price range`, columns: [{ key: "price", label: "Price", type: "number", decimals: 2 }, { key: "share", label: "Share %", type: "pct", decimals: 1 }, { key: "revenue", label: `Revenue per ${size.toLocaleString()} people`, type: "number", decimals: 0 }, { key: "elasticity", label: "Arc elasticity", type: "number", decimals: 2 }],
        rows: d.rows.map((r) => ({ price: money(r.price), share: pct(r.share * 100), revenue: round(r.revenue, 0), elasticity: r.elasticity == null ? null : round(r.elasticity, 2) })),
        notes: ["Other products keep their prices. Arc elasticity = % change in share ÷ % change in price between neighbouring points (below −1: demand is elastic there).", `Revenue is highest at ${d.revenueMaxPrice.toFixed(2)} within the tested range — not a recommendation by itself (costs, competitors' reactions and the share/volume gap are outside the model).`] });
      insights.push(`${products[j].name}: revenue is highest at a price of ${d.revenueMaxPrice.toFixed(2)} within the tested range.`);
    } else warnings.push("The demand curve needs a numeric price attribute (or a summed price) — none was found.");
  }
  if (spec.sensitivity) {
    const j = productIndex(products, typeof spec.sensitivity === "object" ? spec.sensitivity.product : undefined);
    const s = sensitivity(m, products, j, so);
    tables.push({ id: `${pre}_sensitivity`, title: `Sensitivity — ${products[j].name}, one attribute at a time`, columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "share", label: "Share %", type: "pct", decimals: 1 }, { key: "delta", label: "Change (points)", type: "number", decimals: 1 }],
      rows: s.rows.map((r) => ({ attribute: r.attribute, level: r.level + (r.current ? " (current)" : ""), share: pct(r.share * 100), delta: round(r.delta * 100, 1) })), notes: [`Base share ${(s.base * 100).toFixed(1)}%. Each row changes one attribute of ${products[j].name}; everything else in the market is held fixed.`] });
  }
  if (spec.wtp?.length) {
    const rows: Record<string, unknown>[] = [];
    for (const w of spec.wtp) {
      const j = productIndex(products, w.product);
      const r = willingnessToPay(m, products, j, w.attribute, w.level, so);
      if (!r) { warnings.push(`WTP for ${w.attribute} = ${w.level} needs a price (a numeric price attribute or a summed price) and that level to exist.`); continue; }
      rows.push({ product: products[j].name, change: `${w.attribute}: ${r.from ?? "—"} → ${r.to}`, market: r.beyondRange ? "beyond the tested range" : money(r.marketWtp), median: money(r.utilityWtpMedian), excluded: r.notPriceSensitive });
    }
    if (rows.length) tables.push({ id: `${pre}_wtp`, title: "Willingness to pay", columns: [{ key: "product", label: "Product" }, { key: "change", label: "Improvement" }, { key: "market", label: "Market WTP (price increase that keeps share)" }, { key: "median", label: "Utility-ratio WTP (median respondent)", type: "number", decimals: 2 }, { key: "excluded", label: "Respondents with no price sensitivity", type: "number", decimals: 0 }],
      rows, notes: ["Market WTP: how much the improved product's price can rise before its share falls back to where it was, competitors fixed — the form Sawtooth recommends. It depends on the competitive set.", "Utility-ratio WTP: the utility gained ÷ the utility lost per currency unit, per respondent. It ignores competition and overstates WTP when price sensitivity is weak; respondents whose price utility does not fall with price are left out and counted.", "Both are bounded by the tested price range and are estimates, not prices to charge."] });
  }
  if (spec.optimize) {
    const j = productIndex(products, spec.optimize.product);
    const o = optimiseProduct(m, products, j, { ...so, objective: spec.optimize.objective, fixed: spec.optimize.fixed, isLegal: opts.isLegal });
    const unit = o.objective === "share" ? "Share %" : o.objective === "revenue" ? `Revenue per ${size.toLocaleString()} people` : `Profit per ${size.toLocaleString()} people`;
    const fmt = (v: number) => (o.objective === "share" ? pct(v * 100) : round(v, 0));
    tables.push({ id: `${pre}_optimise`, title: `Product optimisation — ${products[j].name} (maximise ${o.objective})`, columns: [{ key: "rank", label: "Rank", type: "number", decimals: 0 }, { key: "levels", label: "Configuration" }, { key: "price", label: "Price", type: "number", decimals: 2 }, { key: "value", label: unit, type: o.objective === "share" ? "pct" : "number", decimals: o.objective === "share" ? 1 : 0 }],
      rows: o.top.map((t, k) => ({ rank: k + 1, levels: Object.entries(t.levels).filter(([, v]) => v).map(([a, v]) => `${a}: ${v}`).join("; "), price: money(t.price ?? productPrice(m, { ...products[j], levels: t.levels })), value: fmt(t.value) })),
      notes: [`${o.exhaustive ? "Every" : "A seeded search over"} configuration${o.exhaustive ? "" : "s"} (${o.evaluations.toLocaleString()} evaluated of ${o.space.toLocaleString()}); competitors fixed${spec.optimize.fixed?.length ? `; fixed: ${spec.optimize.fixed.join(", ")}` : ""}; prohibited combinations excluded. Current configuration: ${fmt(o.current)}.`, "An optimum against a fixed market — competitors would react; read it as which levels matter most, not as a launch plan."] });
    if (o.best) insights.push(`Best ${products[j].name} for ${o.objective}: ${Object.entries(o.best.levels).filter(([, v]) => v).map(([a, v]) => `${a} ${v}`).join(", ")}${o.best.price != null ? ` at ${o.best.price.toFixed(2)}` : ""}.`);
  }
  return { tables, insights, warnings };
}

/** the scenarios to simulate: the analysis's own, else every scenario saved on the design (simulate_conjoint) */
export function scenariosFor(options: Record<string, unknown> | undefined, designConfig: Record<string, unknown> | undefined): SimulatorSpec[] {
  const own = options?.simulator;
  if (own && typeof own === "object" && !Array.isArray(own)) return [own as SimulatorSpec];
  const saved = Array.isArray(designConfig?.simulations) ? (designConfig!.simulations as SimulatorSpec[]) : [];
  return saved.filter((s) => s && (Array.isArray(s.products) && s.products.length));
}
