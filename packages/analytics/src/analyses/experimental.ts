import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import { itemLabelOf, numericColumn, textColumn, type Dataset } from "../dataset.js";
import { describe } from "../stats/descriptive.js";
import { friedman, independentT, oneSampleT, pairedT, wilcoxonSignedRank, type TestResult } from "../stats/tests.js";
import { fmtNum, fmtP, makeResult, opt, refused, round } from "./common.js";

/* ============================================================ sequential monadic (S5c, SM-10) */

/** Holm–Bonferroni step-down adjusted p-values, in the input order */
export function holm(ps: readonly (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p != null).sort((a, b) => a.p - b.p);
  const m = idx.length;
  const out: (number | null)[] = ps.map(() => null);
  let run = 0;
  idx.forEach((x, r) => { run = Math.max(run, Math.min(1, (m - r) * x.p)); out[x.i] = run; });
  return out;
}

/**
 * THE POSITION OF EACH CONCEPT IN THE ORDER A RESPONDENT SAW. `order` is the stored ORDER_<RANDOMIZER> value (S4c:
 * the randomizer's child ids, comma-separated, as shown); `blocks[i]` is the child that holds concept i. Returns the
 * 0-based position among the concepts (children that are not concepts are skipped), or null when not shown / no order.
 */
export function conceptPositions(order: string | null, blocks: readonly string[]): (number | null)[] {
  if (!order) return blocks.map(() => null);
  const seen = order.split(",").map((s) => s.trim()).filter((s) => blocks.includes(s));
  return blocks.map((b) => { const i = seen.indexOf(b); return i < 0 ? null : i; });
}

/**
 * SEQUENTIAL MONADIC: every respondent rates every concept, in a rotated order.
 *   variables   one rating per concept (numeric / scale), concept i = variables[i]
 *   options     order: the ORDER_<RANDOMIZER> variable, blocks: the randomizer child id of each concept
 * Within-respondent comparison on the respondents who rated every concept: means, the omnibus test (paired t for
 * two concepts, Friedman for three or more), every pair by paired t (Holm-adjusted) and Wilcoxon. Order effect:
 * each concept rated first vs later (Welch t between respondents) and the pooled first-position effect (each
 * respondent's first-shown rating minus the mean of their later ones, one-sample t against 0 — concept quality
 * averages out under a balanced rotation, so a non-zero mean is the position).
 */
export function sequentialMonadic(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = def.variables.filter((v) => ds.byName.has(v));
  if (vars.length < 2) return refused(def, ds, totalCases, "A sequential monadic comparison needs one rating variable per concept — at least two concepts.", ["table"]);
  const cols = vars.map((v) => numericColumn(ds, v));
  const n = ds.cases.length;
  const complete = Array.from({ length: n }, (_, i) => i).filter((i) => cols.every((c) => c[i] != null && Number.isFinite(c[i]!)));
  const C = cols.map((c) => complete.map((i) => c[i] as number));
  const label = (j: number) => itemLabelOf(ds, vars[j]);
  const means = C.map((c) => describe(c));
  const tests: TestResult[] = [];
  const omnibus = vars.length === 2 ? pairedT(C[0], C[1]) : friedman(complete.map((_, r) => C.map((c) => c[r])));
  tests.push({ ...omnibus, note: `${vars.length === 2 ? "paired t" : "Friedman"} across the ${vars.length} concepts, n = ${complete.length} respondents who rated all` });
  const pairs: { a: number; b: number; t: TestResult; w: TestResult }[] = [];
  for (let a = 0; a < vars.length; a++) for (let b = a + 1; b < vars.length; b++) pairs.push({ a, b, t: pairedT(C[a], C[b]), w: wilcoxonSignedRank(C[a], C[b]) });
  const adj = holm(pairs.map((p) => p.t.p));
  const tables: ResultTable[] = [
    { id: "concepts", title: "Concept ratings (respondents who rated every concept)", columns: [{ key: "concept", label: "Concept" }, { key: "n", label: "n", type: "count" }, { key: "mean", label: "Mean", type: "number", decimals: 2 }, { key: "sd", label: "SD", type: "number", decimals: 2 }],
      rows: vars.map((_, j) => ({ concept: label(j), n: means[j].n, mean: round(means[j].mean), sd: round(means[j].sd) })), base: { n: complete.length } },
    { id: "pairs", title: "Within-respondent comparisons", columns: [{ key: "pair", label: "Pair" }, { key: "diff", label: "Mean difference", type: "number", decimals: 2 }, { key: "t", label: "Paired t", type: "number", decimals: 2 }, { key: "p", label: "p", type: "number", decimals: 4 }, { key: "pHolm", label: "p (Holm)", type: "number", decimals: 4 }, { key: "pW", label: "Wilcoxon p", type: "number", decimals: 4 }],
      rows: pairs.map((x, k) => ({ pair: `${label(x.a)} − ${label(x.b)}`, diff: round((means[x.a].mean ?? 0) - (means[x.b].mean ?? 0)), t: round(x.t.statistic), p: round(x.t.p, 4), pHolm: round(adj[k], 4), pW: round(x.w.p, 4) })),
      notes: ["Paired t on each pair of concepts, Holm-adjusted for the number of pairs; Wilcoxon signed-rank as the non-parametric check."] },
  ];
  const insights: string[] = [];
  const order = [...means.keys()].sort((a, b) => (means[b].mean ?? -Infinity) - (means[a].mean ?? -Infinity));
  insights.push(`Highest rated: ${label(order[0])} (${fmtNum(means[order[0]].mean, 2)}); lowest: ${label(order[order.length - 1])} (${fmtNum(means[order[order.length - 1]].mean, 2)}) — ${omnibus.test === "friedman" ? "Friedman" : "paired t"} ${fmtP(omnibus.p)}.`);
  const sig = pairs.filter((_, k) => adj[k] != null && adj[k]! < 0.05);
  if (sig.length) insights.push(`Significant after Holm: ${sig.map((x) => `${label(x.a)} vs ${label(x.b)}`).join("; ")}.`);
  const warnings: string[] = [];
  /* order effect */
  const orderVar = opt<string | null>(def, "order", null), blocks = (opt<unknown[]>(def, "blocks", []) ?? []).map(String);
  const variablesUsed = [...vars];
  if (orderVar && blocks.length === vars.length && ds.byName.has(orderVar)) {
    variablesUsed.push(orderVar);
    const ord = textColumn(ds, orderVar);
    const pos = complete.map((i) => conceptPositions(ord[i], blocks));
    const withOrder = pos.map((p, r) => (p.every((x) => x != null) ? r : -1)).filter((r) => r >= 0);
    const rows = vars.map((_, j) => {
      const first = withOrder.filter((r) => pos[r][j] === 0).map((r) => C[j][r]);
      const later = withOrder.filter((r) => (pos[r][j] ?? 0) > 0).map((r) => C[j][r]);
      const t = independentT(first, later);
      const df = describe(first), dl = describe(later);
      return { concept: label(j), nFirst: df.n, meanFirst: round(df.mean), nLater: dl.n, meanLater: round(dl.mean), diff: df.mean != null && dl.mean != null ? round(df.mean - dl.mean) : null, p: round(t.p, 4) };
    });
    /* pooled: first-shown rating minus the mean of the respondent's later ratings */
    const lift = withOrder.map((r) => { const f = pos[r].indexOf(0); const others = C.map((c, j) => (j === f ? null : c[r])).filter((x): x is number => x != null); return C[f][r] - others.reduce((a, b) => a + b, 0) / others.length; });
    const pooled = oneSampleT(lift, 0);
    const pd = describe(lift);
    tests.push({ ...pooled, test: "first_position_effect", note: `first-shown rating − mean of later ratings, n = ${lift.length}` });
    tables.push({ id: "order", title: "Order effect — rated first vs later", columns: [{ key: "concept", label: "Concept" }, { key: "nFirst", label: "n first", type: "count" }, { key: "meanFirst", label: "Mean when first", type: "number", decimals: 2 }, { key: "nLater", label: "n later", type: "count" }, { key: "meanLater", label: "Mean when later", type: "number", decimals: 2 }, { key: "diff", label: "First − later", type: "number", decimals: 2 }, { key: "p", label: "p (Welch)", type: "number", decimals: 4 }],
      rows, base: { n: withOrder.length }, notes: [`Pooled first-position effect: ${fmtNum(pd.mean, 2)} (t = ${fmtNum(pooled.statistic, 2)}, ${fmtP(pooled.p)}). Positions are read from ${orderVar} (the order each respondent saw).`] });
    insights.push(pooled.p != null && pooled.p < 0.05
      ? `Order effect: the concept shown first is rated ${fmtNum(pd.mean, 2)} points ${pd.mean! > 0 ? "higher" : "lower"} than the later ones (${fmtP(pooled.p)}) — compare concepts on all positions, or on first position only (monadic read).`
      : `No significant first-position effect (${fmtNum(pd.mean, 2)}, ${fmtP(pooled.p)}).`);
    if (withOrder.length < complete.length) warnings.push(`${complete.length - withOrder.length} respondents have no stored order and are left out of the order check.`);
  } else warnings.push(orderVar || blocks.length ? "The order check needs the stored order variable (ORDER_<randomizer>) and one randomizer block per concept (blocks) — not run." : "No order variable given — the order effect is not checked (options order and blocks).");
  if (complete.length < n && complete.length > 0) warnings.push(`Based on the ${complete.length} respondents who rated every concept.`);
  return makeResult(def, ds, {
    tables, tests, insights, warnings,
    chart: { categories: vars.map((_, j) => label(j)), series: [{ name: "Mean rating", values: means.map((m) => round(m.mean)) }] },
    recommendedCharts: ["bar_vertical", "dot_plot", "bar_horizontal"], variablesUsed, totalCases, validN: complete.length,
  });
}

/* ============================================================ IAT D-score (S5c, SM-18) */

/** the conventional reading bands of |D| (Project Implicit's): < .15 little or none, < .35 slight, < .65 moderate, else strong */
export function iatBand(d: number): "little or none" | "slight" | "moderate" | "strong" {
  const a = Math.abs(d);
  return a < 0.15 ? "little or none" : a < 0.35 ? "slight" : a < 0.65 ? "moderate" : "strong";
}

/**
 * THE IAT D-SCORES the engine computed per respondent (IAT_D, Greenwald et al. 2003 D600 — engine iatScore.ts):
 * the scored and excluded counts, mean D with its SD, a one-sample t against 0 (is there an association on
 * average?), Cohen's d = mean / SD, and the distribution over the reading bands by direction. options.variable
 * names another D variable; options.excluded its exclusion flag.
 */
export function iat(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const dv = opt<string>(def, "variable", def.variables[0] ?? "IAT_D"), ev = opt<string>(def, "excluded", "IAT_EXCLUDED");
  if (!ds.byName.has(dv) && !ds.cases.some((c) => c.vars[dv] != null)) return refused(def, ds, totalCases, `There is no D-score variable “${dv}” — tag the four combined reaction-time blocks (settings.iatBlock) so the engine computes IAT_D.`, ["table"]);
  const d = numericColumn(ds, dv), ex = numericColumn(ds, ev);
  const scored = d.filter((x): x is number => x != null && Number.isFinite(x));
  const excluded = ex.filter((x) => x === 1).length;
  const s = describe(scored);
  const t = oneSampleT(scored, 0);
  const bands = ["strong", "moderate", "slight", "little or none"] as const;
  const rows = [...bands.map((b) => ({ band: `${b === "little or none" ? b : `${b} — compatible faster`}`, n: scored.filter((x) => iatBand(x) === b && (b === "little or none" || x > 0)).length })),
    ...bands.slice(0, 3).map((b) => ({ band: `${b} — incompatible faster`, n: scored.filter((x) => iatBand(x) === b && x < 0).length }))];
  const tables: ResultTable[] = [
    { id: "iat", title: "IAT D-score", columns: [{ key: "m", label: "" }, { key: "v", label: "Value", type: "number", decimals: 3 }],
      rows: [{ m: "Respondents scored", v: scored.length }, { m: "Excluded (> 10 % of trials under 300 ms)", v: excluded }, { m: "Mean D", v: round(s.mean, 3) }, { m: "SD", v: round(s.sd, 3) }, { m: "t (mean D vs 0)", v: round(t.statistic, 3) }, { m: "Cohen's d (mean / SD)", v: s.mean != null && s.sd ? round(s.mean / s.sd, 3) : null }],
      base: { n: scored.length }, notes: ["D = (incompatible − compatible block latency) / inclusive SD, averaged over the practice and test pairs (Greenwald, Nosek & Banaji 2003; errors penalised +600 ms; trials > 10,000 ms dropped). Positive = faster on the compatible pairing."] },
    { id: "bands", title: "Strength of association (|D| < .15 / .35 / .65)", columns: [{ key: "band", label: "Band" }, { key: "n", label: "Respondents", type: "count" }, { key: "pct", label: "%", type: "pct", decimals: 1 }],
      rows: rows.map((r) => ({ ...r, pct: scored.length ? round((r.n / scored.length) * 100, 1) : null })) },
  ];
  const insights = scored.length ? [`Mean D = ${fmtNum(s.mean, 3)} (SD ${fmtNum(s.sd, 3)}, n = ${scored.length}${excluded ? `, ${excluded} excluded` : ""}) — ${s.mean != null ? iatBand(s.mean) : "—"} on average; t against 0 ${fmtP(t.p)}.`] : [];
  return makeResult(def, ds, {
    tables, tests: [{ ...t, test: "iat_mean_d", note: "one-sample t of D against 0" }], insights, warnings: excluded ? [`${excluded} respondents were excluded for answering more than 10 % of trials in under 300 ms.`] : [],
    chart: { categories: rows.map((r) => r.band), series: [{ name: "Respondents", values: rows.map((r) => r.n) }] },
    recommendedCharts: ["bar_horizontal", "histogram", "table"], variablesUsed: [dv, ...(ds.byName.has(ev) ? [ev] : [])], totalCases, validN: scored.length,
  });
}

/* ============================================================ shelf test (S5c, SM-16) */

/**
 * SHELF TEST (variant hotspot.shelf): share of first choice per product, the second choice when asked, how often
 * each product was examined before the pick, and the time to find (seconds to the pick) per product picked —
 * median and mean. variables[0] = the shelf question; options time / examined / pick2 name the paradata variables
 * (default SHELF_<VAR>_TIME / _EXAMINED / _PICK2). Shares are weighted when the study is; times are not.
 */
export function shelf(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const v = def.variables[0];
  const meta = v ? ds.byName.get(v) : undefined;
  if (!v || !meta) return refused(def, ds, totalCases, "The shelf analysis needs the shelf question (its variable).", ["table"]);
  const K = v.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  const tv = opt<string>(def, "time", `SHELF_${K}_TIME`), ev = opt<string>(def, "examined", `SHELF_${K}_EXAMINED`), sv = opt<string>(def, "pick2", `SHELF_${K}_PICK2`);
  const cats = (meta.categories ?? []).map((c) => ({ code: String(c.code), label: c.label }));
  const w = ds.weighted ? ds.cases.map((c) => c.weight) : null;
  const firstOf = (x: unknown): string | null => { const a = Array.isArray(x) ? x[0] : x; return a == null || a === "" ? null : String(a); };
  const picks = ds.cases.map((c) => firstOf(c.vars[v]));
  const times = numericColumn(ds, tv);
  const examined = textColumn(ds, ev).map((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : null));
  const second = textColumn(ds, sv);
  const base = picks.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const W = base.reduce((t, i) => t + (w?.[i] ?? 1), 0);
  const secondBase = base.filter((i) => second[i]);
  const W2 = secondBase.reduce((t, i) => t + (w?.[i] ?? 1), 0);
  const exBase = base.filter((i) => examined[i]);
  const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const codes = cats.length ? cats : [...new Set(base.map((i) => picks[i]!))].map((code) => ({ code, label: code }));
  const rows = codes.map((c) => {
    const mine = base.filter((i) => picks[i] === c.code);
    const t = mine.map((i) => times[i]).filter((x): x is number => x != null && Number.isFinite(x));
    return {
      product: c.label, code: c.code, n: mine.length,
      share: W ? round((mine.reduce((s, i) => s + (w?.[i] ?? 1), 0) / W) * 100, 1) : null,
      second: W2 ? round((secondBase.filter((i) => second[i] === c.code).reduce((s, i) => s + (w?.[i] ?? 1), 0) / W2) * 100, 1) : null,
      examined: exBase.length ? round((exBase.filter((i) => examined[i]!.includes(c.code)).length / exBase.length) * 100, 1) : null,
      medianTime: round(median(t), 1), meanTime: round(describe(t).mean, 1),
    };
  });
  const allT = base.map((i) => times[i]).filter((x): x is number => x != null && Number.isFinite(x));
  const top = [...rows].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  const insights = top ? [`${top.product} wins the shelf: ${top.share}% of first choices (n = ${base.length}); median time to find ${fmtNum(median(allT), 1)} s overall.`] : [];
  const slow = rows.filter((r) => r.n >= 5 && r.medianTime != null).sort((a, b) => (b.medianTime ?? 0) - (a.medianTime ?? 0))[0];
  if (slow) insights.push(`Slowest to find among products picked by 5+: ${slow.product} (median ${fmtNum(slow.medianTime, 1)} s).`);
  return makeResult(def, ds, {
    tables: [{ id: "shelf", title: "Shelf test — choice and findability", columns: [{ key: "product", label: "Product" }, { key: "n", label: "Picked (n)", type: "count" }, { key: "share", label: "Share of choice %", type: "pct", decimals: 1 }, ...(secondBase.length ? [{ key: "second", label: "Second choice %", type: "pct" as const, decimals: 1 }] : []), ...(exBase.length ? [{ key: "examined", label: "Examined before the pick %", type: "pct" as const, decimals: 1 }] : []), { key: "medianTime", label: "Median time to find (s)", type: "number", decimals: 1 }, { key: "meanTime", label: "Mean time to find (s)", type: "number", decimals: 1 }],
      rows: rows.map(({ code: _c, ...r }) => r), base: { n: base.length }, notes: ["Time to find and products examined are measured in the respondent's browser (hover or keyboard focus before the pick). Times are per product among the respondents who picked it."] }],
    chart: { categories: rows.map((r) => r.product), series: [{ name: "Share of choice %", values: rows.map((r) => r.share) }, { name: "Median time to find (s)", values: rows.map((r) => r.medianTime), meta: { axis: "secondary" } }], valueFormat: "pct" },
    insights, warnings: [], recommendedCharts: ["bar_horizontal", "bar_vertical", "table"], variablesUsed: [v, ...[tv, ev, sv].filter((x) => ds.byName.has(x))], totalCases, validN: base.length,
  });
}
