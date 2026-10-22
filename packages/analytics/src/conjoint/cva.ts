/**
 * RATING-BASED CONJOINT (CVA) — per-respondent least squares. F4, 2026-10-22.
 *
 * Every respondent rates enough full profiles (or pairs) for their own regression, which is why
 * CVA needs no hierarchical model (Sawtooth CVA's OLS):
 *
 *   single profiles   rating = b0 + Σ_attributes u(level) + e          (dummy coding, then zero-centred)
 *   pairs             rating − midpoint = Σ u(level_right) − u(level_left) + e   (no intercept)
 *
 * MONOTONICITY (optional, per attribute: increasing / decreasing in level order): Sawtooth's
 * "tying" — after the fit, the adjacent pair of levels that breaks the order most is TIED (constrained
 * equal) and the model refitted, until no pair breaks it. The result is the least-squares fit under
 * the order constraints for a chain (pool-adjacent-violators on the design).
 *
 * FIT per respondent: R² (pairs: against the indifference point), adjusted R², degrees of freedom.
 * FLAGS: flat rater (every rating the same → no utilities), low variance (ratings span < 20% of the
 * scale), poor fit (R² < 0.3), too few ratings (df < 1). Flagged respondents are reported and, except
 * flat raters and too-few, kept — the researcher decides (option `excludeFlagged`).
 */
import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import { fmtNum, fmtPct, makeResult, opt, pct, refused, round } from "../analyses/common.js";
import { cholesky, cholInverse } from "../models/linalg.js";
import { scenariosFor, simulatorTables, type SimulatorSpec } from "./simulatorTables.js";
import { numericValues, type UtilityModel } from "./simulator.js";

export interface CvaAttribute { name: string; levels: string[] }
export interface CvaObservation { profiles: number[][]; y: number; holdout: boolean }
export interface CvaRespondentData { id: string; ci: number; obs: CvaObservation[] }
export type CvaFlag = "flat" | "low_variance" | "poor_fit" | "too_few";
export interface CvaFit {
  id: string;
  intercept: number | null;
  /** zero-centred part-worths per attribute (level order); null when not estimable */
  levels: Record<string, number[]> | null;
  r2: number | null; adjR2: number | null; n: number; df: number; sdY: number;
  ties: string[];
  flags: CvaFlag[];
  holdout: { predicted: number; actual: number }[];
}

/** "Price: decreasing" lines or {Price: "decreasing"} → attribute → direction */
export function monotoneOf(v: unknown, attrs: CvaAttribute[]): Record<string, "increasing" | "decreasing"> {
  const out: Record<string, "increasing" | "decreasing"> = {};
  const put = (k: string, d: string) => { const a = attrs.find((x) => x.name.toLowerCase() === k.trim().toLowerCase()); const dir = /^(?:inc|asc)/i.test(d.trim()) ? "increasing" : /^(?:dec|desc)/i.test(d.trim()) ? "decreasing" : null; if (a && dir) out[a.name] = dir; };
  if (Array.isArray(v)) for (const l of v) { const m = /^\s*([^:=]+?)\s*[:=]\s*(\w+)/.exec(String(l)); if (m) put(m[1], m[2]); }
  else if (v && typeof v === "object") for (const [k, d] of Object.entries(v as Record<string, unknown>)) put(k, String(d));
  return out;
}

/** least squares with a tiny ridge (a level a respondent never saw stays at 0, not NaN) */
function ols(X: number[][], y: number[], p: number): number[] | null {
  const XtX = new Array(p * p).fill(0), Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { const xa = X[i][a]; if (!xa) continue; Xty[a] += xa * y[i]; for (let b = 0; b < p; b++) XtX[a * p + b] += xa * X[i][b]; }
  for (let a = 0; a < p; a++) XtX[a * p + a] += 1e-8;
  const L = cholesky(XtX, p); if (!L) return null;
  const inv = cholInverse(L, p);
  return Array.from({ length: p }, (_, a) => Xty.reduce((t, v, b) => t + inv[a * p + b] * v, 0));
}

/**
 * One respondent's fit. `groups[a][level]` = the group a level belongs to (ties); group 0 is the
 * reference (utility 0 before centring).
 */
export function fitCva(attrs: CvaAttribute[], obs: CvaObservation[], mode: "single" | "paired", scale: { min: number; max: number }, monotone: Record<string, "increasing" | "decreasing"> = {}, id = ""): CvaFit {
  const est = obs.filter((o) => !o.holdout);
  const ys = est.map((o) => o.y);
  const mean = ys.reduce((t, v) => t + v, 0) / Math.max(1, ys.length);
  const sdY = Math.sqrt(ys.reduce((t, v) => t + (v - mean) ** 2, 0) / Math.max(1, ys.length - 1));
  const mid = (scale.min + scale.max) / 2;
  const groups = attrs.map((a) => a.levels.map((_, k) => k));
  const ties: string[] = [];
  const flags: CvaFlag[] = [];
  const params = () => attrs.reduce((t, _, q) => t + new Set(groups[q]).size - 1, 0) + (mode === "single" ? 1 : 0);
  const blank: CvaFit = { id, intercept: null, levels: null, r2: null, adjR2: null, n: est.length, df: est.length - params(), sdY, ties, flags, holdout: [] };
  if (est.length - params() < 1) { flags.push("too_few"); return blank; }
  if (mode === "single" && sdY < 1e-9) { flags.push("flat"); return blank; }
  if (mode === "paired" && est.every((o) => Math.abs(o.y - mid) < 1e-9)) { flags.push("flat"); return blank; }
  let utils: number[][] = [], b0 = 0, sse = 0;
  for (let iter = 0; iter < 64; iter++) {
    // columns: [intercept] + per attribute one per non-reference group (groups renumbered in level order)
    const colOf: number[][] = []; let p = mode === "single" ? 1 : 0;
    for (let q = 0; q < attrs.length; q++) {
      const ids = [...new Set(groups[q])].sort((a, b) => a - b);
      colOf.push(groups[q].map((g) => { const r = ids.indexOf(g); return r === 0 ? -1 : p + r - 1; }));
      p += ids.length - 1;
    }
    const row = (lv: number[]) => { const x = new Array(p).fill(0); attrs.forEach((_, q) => { const c = colOf[q][lv[q]]; if (c >= 0) x[c] = 1; }); return x; };
    const X = est.map((o) => { if (mode === "single") { const x = row(o.profiles[0]); x[0] = 1; return x; } const L = row(o.profiles[0]), R = row(o.profiles[1]); return R.map((v, k) => v - L[k]); });
    const yy = est.map((o) => (mode === "single" ? o.y : o.y - mid));
    const b = ols(X, yy, p);
    if (!b) { flags.push("too_few"); return blank; }
    b0 = mode === "single" ? b[0] : 0;
    utils = attrs.map((a, q) => a.levels.map((_, k) => { const c = colOf[q][k]; return c >= 0 ? b[c] : 0; }));
    sse = X.reduce((t, x, i) => t + (yy[i] - x.reduce((s, v, k) => s + v * b[k], 0)) ** 2, 0);
    // the worst order violation among the monotone attributes → tie it, refit
    let worst: { q: number; k: number; by: number } | null = null;
    attrs.forEach((a, q) => {
      const dir = monotone[a.name]; if (!dir) return;
      for (let k = 0; k + 1 < a.levels.length; k++) {
        const by = dir === "increasing" ? utils[q][k] - utils[q][k + 1] : utils[q][k + 1] - utils[q][k];
        if (by > 1e-9 && groups[q][k] !== groups[q][k + 1] && (!worst || by > worst.by)) worst = { q, k, by };
      }
    });
    if (!worst) break;
    const w = worst as { q: number; k: number; by: number };
    const from = groups[w.q][w.k + 1], to = groups[w.q][w.k];
    groups[w.q] = groups[w.q].map((g) => (g === from ? to : g));
    ties.push(`${attrs[w.q].name}: ${attrs[w.q].levels[w.k]} = ${attrs[w.q].levels[w.k + 1]}`);
  }
  const yy = est.map((o) => (mode === "single" ? o.y : o.y - mid));
  const sst = mode === "single" ? yy.reduce((t, v) => t + (v - mean) ** 2, 0) : yy.reduce((t, v) => t + v * v, 0);
  const n = est.length, k = params();
  const r2 = sst > 0 ? 1 - sse / sst : null;
  const adjR2 = r2 == null || n - k <= 0 ? null : 1 - (1 - r2) * ((n - (mode === "single" ? 1 : 0)) / (n - k));
  // centre per attribute; the intercept absorbs the means so predictions are unchanged
  const levels: Record<string, number[]> = {};
  let intercept = b0;
  attrs.forEach((a, q) => { const m = utils[q].reduce((t, v) => t + v, 0) / utils[q].length; levels[a.name] = utils[q].map((v) => v - m); if (mode === "single") intercept += m; });
  if (r2 != null && r2 < 0.3) flags.push("poor_fit");
  if (sdY < 0.2 * (scale.max - scale.min) / 2 && mode === "single") flags.push("low_variance");
  const predict = (o: CvaObservation) => mode === "single" ? intercept + attrs.reduce((t, a, q) => t + levels[a.name][o.profiles[0][q]], 0) : mid + attrs.reduce((t, a, q) => t + levels[a.name][o.profiles[1][q]] - levels[a.name][o.profiles[0][q]], 0);
  const holdout = obs.filter((o) => o.holdout).map((o) => ({ predicted: predict(o), actual: o.y }));
  return { id, intercept: mode === "single" ? intercept : null, levels, r2, adjR2, n, df: n - k, sdY, ties, flags, holdout };
}

/** the CVA design and every respondent's ratings, read the way the runtime stored them (version from the seed) */
export function cvaData(ds: Dataset, qid: string) {
  const q = ds.def.questions.find((x) => x.id === qid);
  const design = q ? ds.def.designs.find((d) => d.id === q.settings.designRef) : undefined;
  if (!q || !design || design.kind !== "cva" || !design.file?.rows?.length) return null;
  const rows = design.file.rows as Record<string, unknown>[];
  const cfg = (design.config ?? {}) as { attributes?: CvaAttribute[]; mode?: string; scaleMin?: number; scaleMax?: number; monotone?: unknown };
  const cols = (design.file.columns ?? []).filter((c) => !["version", "task", "alt", "is_holdout"].includes(c));
  const attrs: CvaAttribute[] = cols.map((name) => {
    const seen = [...new Set(rows.map((r) => String(r[name])))];
    const conf = cfg.attributes?.find((a) => a.name === name)?.levels?.map(String).filter((l) => seen.includes(l));
    return { name, levels: conf && conf.length === seen.length ? conf : seen };
  });
  const mode = cfg.mode === "paired" ? "paired" as const : "single" as const;
  const scale = { min: Number.isFinite(Number(cfg.scaleMin)) && cfg.scaleMin != null ? Number(cfg.scaleMin) : mode === "paired" ? 1 : 0, max: Number.isFinite(Number(cfg.scaleMax)) && cfg.scaleMax != null ? Number(cfg.scaleMax) : mode === "paired" ? 9 : 10 };
  const byVT = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) { const k = `${r.version ?? 1}\u0000${r.task}`; (byVT.get(k) ?? byVT.set(k, []).get(k)!).push(r); }
  const respondents: CvaRespondentData[] = [];
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== "object" || Array.isArray(ans)) return;
    const version = String(c.vars[`${q.variableName}_VERSION`] ?? "1");
    const obs: CvaObservation[] = [];
    for (const [t, v] of Object.entries(ans)) {
      const y = Number(v); if (v == null || v === "" || !Number.isFinite(y)) continue;
      const set = (byVT.get(`${version}\u0000${t}`) ?? []).sort((a, b) => Number(a.alt) - Number(b.alt));
      if (!set.length) continue;
      obs.push({ profiles: set.map((r) => attrs.map((a) => a.levels.indexOf(String(r[a.name])))), y, holdout: Number(set[0].is_holdout) === 1 });
    }
    if (obs.length) respondents.push({ id: c.id, ci, obs });
  });
  return { q, design, attrs, mode, scale, respondents, monotone: monotoneOf(cfg.monotone, attrs) };
}

/** per-respondent utilities as a simulator model (predicted ratings; first choice / BTL / logit) */
export function cvaUtilityModel(attrs: CvaAttribute[], fits: CvaFit[], scale: { min: number; max: number }): UtilityModel {
  const price = attrs.find((a) => /price|cost|fee/i.test(a.name) && numericValues(a.levels));
  return {
    kind: "ratings", source: "per-respondent least squares on the ratings (CVA)", scale,
    attributes: attrs.map((a) => ({ name: a.name, levels: a.levels, ...(a === price ? { values: numericValues(a.levels) } : {}) })),
    ...(price ? { priceAttribute: price.name } : {}),
    respondents: fits.filter((f) => f.levels).map((f) => ({ id: f.id, levels: f.levels!, intercept: f.intercept ?? (scale.min + scale.max) / 2 })),
  };
}

const r3 = (x: number | null | undefined) => round(x, 3);
const FLAG_WORDS: Record<CvaFlag, string> = { flat: "flat rater (every rating the same)", low_variance: "low variance (ratings span < 20% of the scale)", poor_fit: "poor fit (R² < 0.3)", too_few: "too few ratings to estimate" };

export function cvaAnalysis(def: AnalysisDefinition, ds: Dataset, totalCases: number, qid: string): AnalysisResult {
  const data = cvaData(ds, qid);
  if (!data) return refused(def, ds, totalCases, "The rating-based conjoint design has not been generated.", ["attribute_importance"]);
  const { attrs, mode, scale, respondents } = data;
  if (!respondents.length) return refused(def, ds, totalCases, "No ratings recorded yet for this rating-based conjoint.", ["attribute_importance"]);
  const monotone = { ...data.monotone, ...monotoneOf(opt(def, "monotone", null), attrs) };
  const useMonotone = opt(def, "monotoneConstraints", Object.keys(monotone).length > 0) as boolean;
  const fits = respondents.map((r) => fitCva(attrs, r.obs, mode, scale, useMonotone ? monotone : {}, r.id));
  const excludeFlagged = opt(def, "excludeFlagged", false) as boolean;
  const usable = fits.filter((f) => f.levels && (!excludeFlagged || !f.flags.length));
  if (!usable.length) return refused(def, ds, totalCases, "No respondent's ratings could be estimated (every respondent is a flat rater or has too few ratings).", ["attribute_importance"]);
  const flagCount = (f: CvaFlag) => fits.filter((x) => x.flags.includes(f)).length;
  // importances and normalised utilities per respondent
  const imp = usable.map((f) => { const ranges = attrs.map((a) => Math.max(...f.levels![a.name]) - Math.min(...f.levels![a.name])); const tot = ranges.reduce((t, v) => t + v, 0) || 1; return ranges.map((x) => (x / tot) * 100); });
  const norm = usable.map((f) => { const tot = attrs.reduce((t, a) => t + Math.max(...f.levels![a.name]) - Math.min(...f.levels![a.name]), 0) || 1; const k = (100 * attrs.length) / tot; return Object.fromEntries(attrs.map((a) => [a.name, f.levels![a.name].map((v) => v * k)])); });
  const meanOf = (xs: number[]) => xs.reduce((t, v) => t + v, 0) / Math.max(1, xs.length);
  const sdOf = (xs: number[]) => { const m = meanOf(xs); return Math.sqrt(xs.reduce((t, v) => t + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const impRows = attrs.map((a, q) => ({ attribute: a.name, mean: meanOf(imp.map((r) => r[q])), sd: sdOf(imp.map((r) => r[q])) })).sort((x, y) => y.mean - x.mean);
  const r2s = usable.map((f) => f.r2).filter((x): x is number => x != null).sort((a, b) => a - b);
  const tables: ResultTable[] = [
    { id: "importance", title: "Attribute importance — rating-based conjoint (mean of individual importances)", columns: [{ key: "attribute", label: "Attribute" }, { key: "importance", label: "Relative importance %", type: "pct", decimals: 1 }, { key: "sd", label: "SD across respondents", type: "number", decimals: 1 }], rows: impRows.map((x) => ({ attribute: x.attribute, importance: pct(x.mean), sd: round(x.sd, 1) })), base: { n: usable.length, label: `${usable.length} respondents with utilities` } },
    { id: "partworths", title: `Part-worth utilities — rating-based conjoint (per-respondent least squares, ${mode === "paired" ? "pairs" : "single profiles"})`, columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "mean", label: "Mean utility (rating points)", type: "number", decimals: 3 }, { key: "sd", label: "SD across respondents", type: "number", decimals: 3 }, { key: "normalised", label: "Mean normalised utility", type: "number", decimals: 1 }],
      rows: attrs.flatMap((a) => a.levels.map((l, k) => ({ attribute: a.name, level: l, mean: r3(meanOf(usable.map((f) => f.levels![a.name][k]))), sd: r3(sdOf(usable.map((f) => f.levels![a.name][k]))), normalised: round(meanOf(norm.map((x) => x[a.name][k])), 1) }))),
      notes: [`Each respondent's utilities come from their own regression of the ${mode === "paired" ? "pair ratings (against the scale midpoint)" : "ratings"} on the levels shown, zero-centred per attribute, in rating points. Normalised utilities rescale each respondent so the sum of their attribute ranges is 100 × the number of attributes, so respondents who use the scale differently compare.`, ...(useMonotone && Object.keys(monotone).length ? [`Order constraints: ${Object.entries(monotone).map(([a, d]) => `${a} ${d}`).join(", ")} — levels that broke the order were tied for ${fits.filter((f) => f.ties.length).length} respondents.`] : [])] },
    { id: "fit", title: "Fit — rating-based conjoint", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [
      { m: "Respondents with ratings", v: fits.length }, { m: "Respondents with utilities", v: usable.length },
      { m: "Median R²", v: r3(r2s[Math.floor(r2s.length / 2)]) }, { m: "Mean R²", v: r3(meanOf(r2s)) }, { m: "Lowest R² (10th percentile)", v: r3(r2s[Math.floor(r2s.length * 0.1)]) },
      { m: "Ratings per respondent (estimation)", v: round(meanOf(fits.map((f) => f.n)), 1) }, { m: "Degrees of freedom per respondent", v: round(meanOf(fits.map((f) => f.df)), 1) },
      ...(["flat", "low_variance", "poor_fit", "too_few"] as CvaFlag[]).map((f) => ({ m: `Flagged: ${FLAG_WORDS[f]}`, v: flagCount(f) })),
      { m: "Model", v: `${mode === "paired" ? "Pairs: rating − midpoint on the level differences (no intercept)" : "Single profiles: rating on dummy-coded levels with an intercept"}; ordinary least squares per respondent${excludeFlagged ? "; flagged respondents excluded" : ""}` },
    ] },
  ];
  // holdouts
  const hold = fits.flatMap((f) => f.holdout);
  if (hold.length) {
    const corr = (() => { const a = hold.map((h) => h.predicted), b = hold.map((h) => h.actual); const ma = meanOf(a), mb = meanOf(b); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return aa && bb ? ab / Math.sqrt(aa * bb) : null; })();
    const mae = meanOf(hold.map((h) => Math.abs(h.predicted - h.actual)));
    tables.push({ id: "holdout", title: "Holdout validation", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [{ m: "Holdout ratings", v: hold.length }, { m: "Correlation, predicted vs actual", v: r3(corr) }, { m: "Mean absolute error (rating points)", v: r3(mae) }, ...(mode === "paired" ? [{ m: "Side predicted correctly", v: fmtPct((100 * hold.filter((h) => Math.sign(h.predicted - (scale.min + scale.max) / 2) === Math.sign(h.actual - (scale.min + scale.max) / 2)).length) / hold.length, 1) }] : [])] });
  }
  const caseCode = (id: string) => ds.cases.find((c) => c.id === id)?.code ?? id;
  tables.push({ id: "individual", title: "Individual utilities and fit (one row per respondent)", columns: [{ key: "id", label: "Respondent" }, { key: "r2", label: "R²", type: "number", decimals: 3 }, { key: "flags", label: "Flags" }, ...(mode === "single" ? [{ key: "intercept", label: "Intercept", type: "number" as const, decimals: 3 }] : []), ...attrs.flatMap((a) => a.levels.map((l, k) => ({ key: `${a.name}\u0000${k}`, label: `${a.name}: ${l}`, type: "number" as const, decimals: 3 })))],
    rows: fits.map((f) => ({ id: caseCode(f.id), r2: r3(f.r2), flags: f.flags.map((x) => FLAG_WORDS[x]).join("; "), ...(mode === "single" ? { intercept: r3(f.intercept) } : {}), ...Object.fromEntries(attrs.flatMap((a) => a.levels.map((_, k) => [`${a.name}\u0000${k}`, f.levels ? r3(f.levels[a.name][k]) : null]))) })) });
  // simulator: saved scenarios / options, default best vs worst, first choice
  const model = cvaUtilityModel(attrs, usable, scale);
  const sims = scenariosFor(def.options, data.design.config as Record<string, unknown>);
  const warnings: string[] = [];
  const insights = [`${impRows[0].attribute} is the most important attribute (${fmtPct(impRows[0].mean, 0)} of each respondent's utility range on average); ${impRows[impRows.length - 1].attribute} the least (${fmtPct(impRows[impRows.length - 1].mean, 0)}).`, `Fit: median R² ${fmtNum(r2s[Math.floor(r2s.length / 2)], 2)} across ${usable.length} respondents${flagCount("flat") ? `; ${flagCount("flat")} flat raters have no utilities` : ""}.`];
  for (const [k, sp] of (sims.length ? sims : [{} as SimulatorSpec]).entries()) {
    const st = simulatorTables(model, { rule: "first_choice", ...sp }, ds, { idPrefix: k ? `sim${k + 1}` : "sim" });
    tables.push(...st.tables); insights.push(...st.insights); warnings.push(...st.warnings);
  }
  if (flagCount("flat")) warnings.push(`${flagCount("flat")} respondent${flagCount("flat") === 1 ? " gave" : "s gave"} every profile the same rating — no utilities can be estimated for them.`);
  if (flagCount("poor_fit") > fits.length * 0.25) warnings.push(`${flagCount("poor_fit")} of ${fits.length} respondents fit poorly (R² < 0.3) — check the task length and the scale's use.`);
  return makeResult(def, ds, {
    tables, chart: { categories: impRows.map((x) => x.attribute), series: [{ name: "Importance %", values: impRows.map((x) => pct(x.mean)) }], tree: attrs.map((a) => ({ name: a.name, children: a.levels.map((l, k) => ({ name: l, value: r3(meanOf(usable.map((f) => f.levels![a.name][k]))) ?? 0 })) })), kpis: [{ label: "Respondents", value: usable.length }, { label: "Median R²", value: r3(r2s[Math.floor(r2s.length / 2)]) ?? 0 }], valueFormat: "pct" },
    insights, warnings, recommendedCharts: ["attribute_importance", "part_worth", "utility_by_level", "preference_share"], variablesUsed: [data.q.variableName ?? qid], baseLabel: `${usable.length} respondents`, totalCases, validN: usable.length,
  });
}
