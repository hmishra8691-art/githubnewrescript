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
