import type { Dataset } from "./dataset.js";
import { categoricalColumn, categoriesOf, numericColumn, labelOf } from "./dataset.js";
import { independentT, mannWhitney } from "./stats/tests.js";

/**
 * POST-HOC CORRECTIONS (Research Engine audit, Phase 4).
 *
 * A plan runs many tests; at α = .05 one in twenty null results comes out
 * "significant" by chance, and a hypothesis served by six tests is judged
 * on six draws. Two things were missing: the p-values of a FAMILY of tests
 * adjusted for how many were made, and — when a difference across three or
 * more groups is significant — WHICH pairs differ, each pair's p adjusted
 * too. Both are here, deterministic, on the statistics the run already has.
 *
 * Holm's step-down is the default: it controls the family-wise error rate
 * like Bonferroni and is uniformly more powerful. Benjamini–Hochberg (false
 * discovery rate) is offered for exploratory families. Nothing here changes
 * a raw p or a raw verdict: the adjusted values sit beside them.
 */
export type CorrectionMethod = "holm" | "bonferroni" | "bh";

export const CORRECTION_WORDS: Record<CorrectionMethod, string> = { holm: "Holm", bonferroni: "Bonferroni", bh: "Benjamini–Hochberg" };

/** adjusted p-values, in the input's order; a null stays null and does not count toward the family */
export function adjustP(ps: (number | null | undefined)[], method: CorrectionMethod = "holm"): (number | null)[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => typeof x.p === "number" && Number.isFinite(x.p));
  const m = idx.length;
  const out: (number | null)[] = ps.map(() => null);
  if (!m) return out;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  if (method === "bonferroni") { for (const x of idx) out[x.i] = clamp(x.p * m); return out; }
  const sorted = [...idx].sort((a, b) => a.p - b.p);
  if (method === "holm") {
    let running = 0;
    sorted.forEach((x, k) => { running = Math.max(running, (m - k) * x.p); out[x.i] = clamp(running); });
    return out;
  }
  /* Benjamini–Hochberg: step-up from the largest p */
  let running = 1;
  for (let k = m - 1; k >= 0; k--) { running = Math.min(running, (sorted[k].p * m) / (k + 1)); out[sorted[k].i] = clamp(running); }
  return out;
}

/* ------------------------------------------------------------ pairwise comparisons */

export interface PairComparison {
  a: string; b: string;
  meanA: number | null; meanB: number | null; nA: number; nB: number;
  /** meanA − meanB */
  diff: number | null;
  test: "t_welch" | "mann_whitney";
  p: number | null;
  /** the pair's p adjusted within the family of all pairs */
  pAdj: number | null;
  significant: boolean;
}
export interface PairwiseResult { outcome: string; group: string; method: CorrectionMethod; test: "t_welch" | "mann_whitney"; alpha: number; pairs: PairComparison[]; significant: PairComparison[]; summary: string }

const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
export const fmtPAdj = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);

/**
 * Every pair of groups compared on the outcome — Welch's t by default,
 * Mann–Whitney when asked (a skewed or ordinal outcome) — with the pairs'
 * p-values adjusted as one family. Groups with fewer than two values are
 * left out.
 */
export function pairwiseComparisons(ds: Dataset, outcome: string, group: string, opts: { alpha?: number; method?: CorrectionMethod; nonparametric?: boolean } = {}): PairwiseResult {
  const alpha = opts.alpha ?? 0.05, method = opts.method ?? "holm";
  const test = opts.nonparametric ? "mann_whitney" : "t_welch";
  const cats = categoriesOf(ds, group);
  const yv = numericColumn(ds, outcome), gv = categoricalColumn(ds, group);
  const values = new Map<string, number[]>(cats.map((c) => [c.code, []]));
  yv.forEach((v, i) => { const c = gv[i]; if (v == null || c == null || Array.isArray(c)) return; values.get(c)?.push(v); });
  const groups = cats.map((c) => ({ label: c.label, xs: values.get(c.code) ?? [] })).filter((g) => g.xs.length >= 2);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pairs: PairComparison[] = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const A = groups[i], B = groups[j];
    const r = opts.nonparametric ? mannWhitney(A.xs, B.xs) : independentT(A.xs, B.xs, false);
    const ma = mean(A.xs), mb = mean(B.xs);
    pairs.push({ a: A.label, b: B.label, meanA: ma, meanB: mb, nA: A.xs.length, nB: B.xs.length, diff: ma != null && mb != null ? ma - mb : null, test, p: r.p, pAdj: null, significant: false });
  }
  const adj = adjustP(pairs.map((p) => p.p), method);
  pairs.forEach((p, i) => { p.pAdj = adj[i]; p.significant = adj[i] != null && adj[i]! < alpha; });
  const significant = pairs.filter((p) => p.significant).sort((x, y) => (x.pAdj ?? 1) - (y.pAdj ?? 1));
  const say = (p: PairComparison) => (p.diff != null && p.diff < 0 ? `${p.b} > ${p.a}` : `${p.a} > ${p.b}`) + ` (${fmt(Math.max(p.meanA ?? 0, p.meanB ?? 0))} vs ${fmt(Math.min(p.meanA ?? 0, p.meanB ?? 0))}, ${fmtPAdj(p.pAdj)})`;
  const summary = !pairs.length ? `Too few groups with data on ${labelOf(ds, outcome)} by ${labelOf(ds, group)} to compare pairs.`
    : significant.length ? `Pairwise (${CORRECTION_WORDS[method]}-adjusted, ${pairs.length} pairs): ${significant.map(say).join("; ")}${significant.length < pairs.length ? `; the other ${pairs.length - significant.length} pair${pairs.length - significant.length === 1 ? "" : "s"} do${pairs.length - significant.length === 1 ? "es" : ""} not differ` : ""}.`
    : `Pairwise (${CORRECTION_WORDS[method]}-adjusted, ${pairs.length} pairs): no pair differs once the comparisons are corrected.`;
  return { outcome, group, method, test, alpha, pairs, significant, summary };
}
