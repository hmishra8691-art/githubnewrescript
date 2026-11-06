/** the evidence of a finding in one line, exactly as the run holds it — shared by the Overview, the catalogue and the exports */
import type { Finding } from "./findings.js";

const TEST_WORD: Record<string, string> = {
  chi_square: "chi-square", fisher: "Fisher's exact", t_independent: "t-test", t_paired: "paired t-test", t_one_sample: "one-sample t-test", anova_one_way: "one-way ANOVA", mann_whitney: "Mann-Whitney U", wilcoxon: "Wilcoxon", kruskal_wallis: "Kruskal-Wallis", friedman: "Friedman", proportion: "test of proportions", pearson: "Pearson correlation", spearman: "Spearman correlation", kendall: "Kendall correlation", regression: "regression", logistic: "logistic regression",
};
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);
const fmtN = (n: number) => n.toLocaleString("en-US");

/** the evidence of a finding in one line, exactly as the run holds it */
export function evidenceLine(f: Finding): string {
  const e = f.evidence;
  const parts: string[] = [];
  if (e.test) parts.push(TEST_WORD[e.test] ?? e.test.replace(/_/g, " "));
  if (e.statistic != null && Number.isFinite(e.statistic)) parts.push(`statistic ${Math.abs(e.statistic) >= 100 ? e.statistic.toFixed(0) : e.statistic.toFixed(2)}${e.df != null ? ` (df ${Array.isArray(e.df) ? e.df.join(", ") : e.df})` : ""}`);
  const p = fmtP(e.p); if (p) parts.push(p);
  if (e.adjusted) parts.push(`adjusted ${fmtP(e.adjusted.p)} (${e.adjusted.method})`);
  if (e.effect) parts.push(`${e.effect.name} = ${Math.abs(e.effect.value) < 10 ? e.effect.value.toFixed(2) : e.effect.value.toFixed(1)}`);
  parts.push(`n = ${fmtN(e.n)}`);
  return parts.join(" · ");
}

