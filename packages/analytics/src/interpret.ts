/**
 * DUAL-LAYER INTERPRETATION (Analytics upgrade 2026-11-06, M5) — every result explained twice, from its own
 * numbers and nothing else:
 *
 *   STATISTICAL   the test, its statistic and degrees of freedom, the p-value against the alpha, the effect size
 *                 with its name, the base — as the result holds them
 *   PLAIN         what was analysed, why (the hypotheses it serves, the objective), what the result means, the
 *                 patterns the engine read in the tables, how it bears on the objective, what to consider next
 *
 * Association is never called causation; "significant" is said only when the test says so at its alpha; a small
 * base is said to be small. The engine writes this for every result; a model may add implications through the
 * claim gate elsewhere (modelInterpretation) — that text is marked as the model's, never mixed in here.
 */
import type { AnalysisDefinition, AnalysisResult } from "./types.js";
import type { TestResult } from "./stats/tests.js";

export interface InterpretationContext {
  /** the research label of a variable (catalogue naming) */
  labelOf?: (name: string) => string;
  /** the hypotheses this analysis serves, with their text */
  hypotheses?: readonly { label: string; text: string }[];
  objective?: string | null;
  /** the plan's reason for this analysis */
  reason?: string | null;
  alpha?: number;
}

export interface Interpretation {
  statistical: string[];
  plain: { what: string; why: string; meaning: string; patterns: string[]; objective: string | null; next: string[] };
  caveats: string[];
  /** the test's verdict, for a badge: significant / not significant / no test */
  verdict: "significant" | "not_significant" | "no_test";
}

const TEST_WORD: Record<string, string> = {
  chi_square: "chi-square test of association", fisher: "Fisher's exact test", t_independent: "independent-samples t-test", t_paired: "paired t-test", t_one_sample: "one-sample t-test", welch_t: "Welch's t-test",
  anova_one_way: "one-way ANOVA", mann_whitney: "Mann-Whitney U test", wilcoxon: "Wilcoxon signed-rank test", kruskal_wallis: "Kruskal-Wallis test", friedman: "Friedman test", proportion: "test of two proportions", proportion_one_sample: "one-sample test of a proportion",
  pearson: "Pearson correlation", spearman: "Spearman correlation", kendall: "Kendall correlation", linear: "linear regression", logistic: "logistic regression", multinomial: "multinomial regression", mediation: "mediation model",
};
const STAT_SYMBOL: Record<string, string> = { chi_square: "χ²", t_independent: "t", t_paired: "t", t_one_sample: "t", welch_t: "t", anova_one_way: "F", mann_whitney: "U", wilcoxon: "W", kruskal_wallis: "H", friedman: "χ²", pearson: "r", spearman: "ρ", kendall: "τ", proportion: "z" };

const fmtP = (p: number | null | undefined): string => (p == null ? "p not available" : p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);
const fmtDf = (df: TestResult["df"]) => (df == null ? "" : Array.isArray(df) ? `(${df.map((d) => Math.round(d * 10) / 10).join(", ")})` : `(${Math.round(df * 10) / 10})`);
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** the size of an effect in words, by the conventions of its measure */
export function effectWords(name: string, value: number): string {
  const v = Math.abs(value);
  const n = name.toLowerCase();
  const band = (small: number, medium: number, large: number) => (v < small ? "negligible" : v < medium ? "small" : v < large ? "medium" : "large");
  if (n.includes("cramér") || n.includes("cramer") || n === "phi") return band(0.1, 0.3, 0.5);
  if (n.includes("cohen's d") || n.includes("cohen's h")) return band(0.2, 0.5, 0.8);
  if (n === "r" || n.includes("biserial")) return band(0.1, 0.3, 0.5);
  if (n.includes("η²") || n.includes("eta") || n.includes("ε²") || n.includes("ω²")) return band(0.01, 0.06, 0.14);
  if (n.includes("kendall's w")) return band(0.1, 0.3, 0.5);
  if (n.includes("odds")) return v === 1 ? "none" : Math.max(v, 1 / v) < 1.5 ? "small" : Math.max(v, 1 / v) < 3 ? "medium" : "large";
  return v < 0.1 ? "small" : v < 0.3 ? "medium" : "large";
}

const KIND_WORD: Record<string, string> = {
  descriptive: "the distribution", topbox: "the top/bottom-box shares", crosstab: "a crosstab", test: "a statistical test", correlation: "a correlation", regression: "a regression", cluster: "a cluster analysis", factor: "a factor analysis", reliability: "a reliability analysis",
  segmentation: "a segment profile", trend: "a trend", nps: "the Net Promoter Score", csat: "the satisfaction score", turf: "a TURF analysis", gap: "an importance–performance analysis", pricing: "a pricing analysis", brand: "a brand funnel", ranking: "the ranking", allocation: "the allocation", text: "a text analysis", quality: "the data quality",
};

export function interpretResult(def: AnalysisDefinition, r: AnalysisResult, ctx: InterpretationContext = {}): Interpretation {
  const L = ctx.labelOf ?? ((n: string) => n);
  const alpha = ctx.alpha ?? (typeof def.options?.alpha === "number" ? (def.options.alpha as number) : 0.05);
  const vars = def.variables.map(L);
  const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const n = r.base.n;

  /* ---- statistical */
  const statistical: string[] = [];
  const tests = r.tests.filter((t) => t.p != null || t.statistic != null);
  for (const t of tests) {
    const sym = STAT_SYMBOL[t.test] ?? "statistic";
    const parts = [`${TEST_WORD[t.test] ?? t.test.replace(/_/g, " ")}: ${sym}${fmtDf(t.df)}${t.statistic == null ? "" : ` = ${fmt(t.statistic)}`}`, fmtP(t.p)];
    if (t.effectSize?.value != null) parts.push(`${t.effectSize.name} = ${fmt(t.effectSize.value)} (${effectWords(t.effectSize.name, t.effectSize.value)})`);
    statistical.push(parts.join(", ") + (t.note ? ` — ${t.note}` : ""));
  }
  statistical.push(`Base: n = ${n.toLocaleString("en-US")}${r.base.weightedN && Math.round(r.base.weightedN) !== n ? ` (weighted ${Math.round(r.base.weightedN).toLocaleString("en-US")})` : ""}${r.base.filtered !== r.base.total ? ` of ${r.base.total.toLocaleString("en-US")} after the filter` : ""}; α = ${alpha}.`);
  const ci = r.tables.flatMap((t) => t.columns).find((c) => /ci|confidence/i.test(c.label));
  if (ci) statistical.push("Confidence intervals are in the tables (95% unless stated).");

  /* ---- verdict */
  const primary = tests[0];
  const sig = primary?.p != null ? primary.p < alpha : null;
  const verdict: Interpretation["verdict"] = primary ? (sig ? "significant" : "not_significant") : "no_test";

  /* ---- plain */
  const what = (() => {
    const kind = KIND_WORD[def.kind] ?? `a ${def.kind} analysis`;
    if (def.kind === "crosstab") return `${L(def.rows?.[0] ?? def.variables[0] ?? "")} broken down by ${list((def.columns ?? def.variables.slice(1)).map(L))}${def.layers?.length ? `, within ${list(def.layers.map(L))}` : ""} — ${kind} with ${def.measure === "pct_row" ? "row" : def.measure === "pct_total" ? "total" : def.measure === "count" ? "counts" : def.measure === "mean" ? "means" : "column"} ${def.measure === "count" || def.measure === "mean" ? "" : "percentages"}, on ${n.toLocaleString("en-US")} respondents.`.replace(/\s+,/g, ",").replace(/ {2,}/g, " ");
    if (def.kind === "test") return `${vars[0]}${vars[1] ? ` compared across ${vars[1]}` : " against a reference value"} — ${primary ? TEST_WORD[primary.test] ?? "a statistical test" : kind}, on ${n.toLocaleString("en-US")} respondents.`;
    if (def.kind === "correlation") return `How ${list(vars)} move together — ${kind} (${String(def.options?.method ?? "pearson")}), on ${n.toLocaleString("en-US")} respondents.`;
    if (def.kind === "regression") return `Which of ${list(vars.slice(1))} predict ${vars[0]} — ${String(def.options?.model ?? "linear")} regression, on ${n.toLocaleString("en-US")} respondents.`;
    return `${list(vars) || r.name}: ${kind}, on ${n.toLocaleString("en-US")} respondents.`;
  })();

  const why = ctx.hypotheses?.length
    ? `It serves ${ctx.hypotheses.map((h) => `${h.label} (${h.text.replace(/[.]$/, "")})`).join("; ")}.${ctx.reason ? ` ${sentence(ctx.reason)}` : ""}`
    : ctx.reason ? sentence(ctx.reason)
    : ctx.objective ? `It was run to inform the objective: ${ctx.objective.replace(/[.]$/, "")}.`
    : "It was run as exploration — no hypothesis in the design asks for it.";

  const meaning = (() => {
    if (!primary) return r.error ? `The analysis could not be computed: ${r.error.message}` : def.kind === "descriptive" || def.kind === "topbox" ? "A description, not a test: it says how the answers are shared out, not whether a difference is more than chance." : "No statistical test is attached, so nothing here is said to be significant or not.";
    const e = primary.effectSize;
    const size = e?.value != null ? effectWords(e.name, e.value) : null;
    if (def.kind === "crosstab" || primary.test === "chi_square" || primary.test === "fisher") {
      return sig
        ? `The two are associated: the breakdown differs between the columns more than chance would produce (${fmtP(primary.p)})${size ? `, a ${size} association (${e!.name} = ${fmt(e!.value!)})` : ""}. This is an association in the data — it does not say that one causes the other.`
        : `No reliable association: the differences between the columns are within what chance would produce on this base (${fmtP(primary.p)}). It does not prove the two are unrelated; a larger base might show a small association.`;
    }
    if (def.kind === "correlation" || /pearson|spearman|kendall/.test(primary.test)) {
      const dir = primary.statistic != null ? (primary.statistic > 0 ? "rise together" : "move in opposite directions") : "move together";
      return sig
        ? `The two ${dir}: a ${size ?? "measurable"} correlation (${STAT_SYMBOL[primary.test] ?? "r"} = ${primary.statistic == null ? "?" : fmt(primary.statistic)}, ${fmtP(primary.p)}). Correlation is not causation: a third factor may move both.`
        : `No reliable correlation on this base (${fmtP(primary.p)}): the two do not move together in any clear way.`;
    }
    if (def.kind === "regression") {
      return sig
        ? `At least one predictor is associated with the outcome once the others are held constant (${fmtP(primary.p)})${size ? `; the model explains a ${size} share of the variation` : ""}. These are statistical drivers — associations with the other predictors controlled — not proven causes.`
        : `The predictors together do not explain the outcome better than chance on this base (${fmtP(primary.p)}).`;
    }
    /* a comparison of groups */
    return sig
      ? `The groups differ: the difference in ${vars[0]} between ${vars[1] ? `the ${vars[1]} groups` : "the groups"} is larger than chance would produce (${fmtP(primary.p)})${size ? `, a ${size} effect (${e!.name} = ${fmt(e!.value!)})` : ""}. The groups differ in the data; whether the grouping causes the difference is not something this test can say.`
      : `No reliable difference: ${vars[0]} is within chance between ${vars[1] ? `the ${vars[1]} groups` : "the groups"} on this base (${fmtP(primary.p)}). Absence of evidence is not evidence of absence; a larger base would detect a smaller difference.`;
  })();

  const patterns = r.insights.slice(0, 4);
  const objective = ctx.objective
    ? (sig === true ? `For the objective (${ctx.objective.replace(/[.]$/, "")}): this is evidence of a relation worth acting on, read together with the other results.` : sig === false ? `For the objective (${ctx.objective.replace(/[.]$/, "")}): this relation does not show on this base, so it should not be built on.` : `Part of the objective: ${ctx.objective.replace(/[.]$/, "")}.`)
    : null;

  const next: string[] = [];
  if (n < 30) next.push("The base is very small: treat every figure as indicative and re-run when more completes arrive.");
  else if (n < 100 && sig === false) next.push("With under 100 respondents only large differences show; a larger base or a wider grouping would give the test more power.");
  if (def.kind === "crosstab" && sig) next.push("Read the significance letters to see which columns differ from which, not only that they differ.");
  if (def.kind === "crosstab" && !def.layers?.length) next.push("Layer it by a demographic to check the pattern holds within each group.");
  if (def.kind === "correlation" && sig) next.push("A regression with controls would show whether the relation holds once other variables are accounted for.");
  if (def.kind === "test" && sig && primary && /anova|kruskal|friedman/.test(primary.test)) next.push("Pairwise comparisons (in the tables) show which groups differ; read them with their adjusted p-values.");
  if (def.kind === "regression" && sig) next.push("Check the coefficient table for which predictors matter and their direction; a predictor that is not significant adds nothing with the others present.");
  if (ctx.hypotheses?.length) next.push(sig ? "Record the verdict on the hypothesis with this evidence; the run's correction for multiple tests applies before it is final." : "A hypothesis this does not support is still a result: say so in the report rather than dropping it.");
  if (!next.length) next.push("Save it, add it to a report, or open the chart workbench to present it.");

  const caveats: string[] = [...r.warnings];
  if (r.base.filtered !== r.base.total) caveats.push(`A filter applies: ${r.base.filtered.toLocaleString("en-US")} of ${r.base.total.toLocaleString("en-US")} respondents are in scope.`);
  if (r.base.weightedN && Math.round(r.base.weightedN) !== n) caveats.push("Weighted: the percentages are weighted, the significance uses the effective base.");

  return { statistical, plain: { what, why, meaning, patterns, objective, next }, caveats, verdict };
}

const sentence = (s: string) => { const t = s.trim(); return t ? (t[0].toUpperCase() + t.slice(1)).replace(/[.]?$/, ".") : ""; };
