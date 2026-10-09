import type { AnalysisMethod, AnalysisPlan, PlannedCrosstab, PlannedTest, SurveyDefinition } from "@rescript/schema";
import { buildAnalysisFramework, inferQuestionAnalysis, measurementOf } from "@rescript/engine";
import type { AnalysisDefinition, AnalysisKind, DatasetSpec } from "./types.js";

/**
 * THE PLAN BECOMES THE ANALYSES.
 *
 * The analysis framework is written in the definition before fieldwork
 * (`research.analysisPlan`, `question.analysis`). This is the one place
 * that turns it into the `AnalysisDefinition`s this package runs — so what
 * was planned is what is executed, every planned item names the hypothesis
 * it serves, and the Analytics workspace can create the whole set in one
 * step once responses exist. Nothing here reads data: it is a translation,
 * checked by the same `runAnalysis` every hand-built analysis goes through.
 * The plan's derived variables and segments are not analyses of their own:
 * `withPlannedVariables` (plannedVariables.ts) computes them as columns of the
 * run's dataset, so the crosstabs and tests here that name them run on them.
 */

export interface PlannedAnalysis {
  definition: AnalysisDefinition;
  /** where it came from: a planned crosstab or test by id, or a question's primary analysis */
  source: { kind: "crosstab" | "test"; id: string } | { kind: "primary"; questionId: string };
  priority: number;
  hypotheses: string[];
  reason?: string;
}

const METHOD_KIND: Record<AnalysisMethod, AnalysisKind> = {
  frequencies: "descriptive", mean: "descriptive", median: "descriptive", top_box: "topbox", nps: "nps", crosstab: "crosstab",
  chi_square: "test", t_test: "test", anova: "test", mann_whitney: "test", kruskal_wallis: "test",
  correlation: "correlation", regression: "regression", logistic_regression: "regression", factor: "factor", reliability: "reliability", cluster: "cluster",
  conjoint_utilities: "conjoint", maxdiff_scores: "maxdiff", turf: "turf", driver_analysis: "regression", text_themes: "text",
  ranking_scores: "ranking", allocation_shares: "allocation", pricing: "pricing", brand_funnel: "brand",
};
const TEST_NAME: Partial<Record<AnalysisMethod, string>> = { chi_square: "chi_square", t_test: "t_independent", anova: "anova_one_way", mann_whitney: "mann_whitney", kruskal_wallis: "kruskal_wallis" };
const words = (m: string) => m.replace(/_/g, " ");

/** One planned crosstab as a crosstab analysis. */
export function crosstabDefinition(x: PlannedCrosstab, dataset: DatasetSpec, def?: SurveyDefinition): AnalysisDefinition {
  const label = (v: string) => def?.questions.find((q) => q.variableName === v || q.code === v)?.code ?? v;
  return {
    name: x.reason ?? `${x.rows.map(label).join(", ")} by ${x.columns.map(label).join(", ")}`,
    kind: "crosstab", dataset, variables: [...x.rows, ...x.columns], rows: x.rows, columns: x.columns,
    measure: x.measure ?? "pct_col",
    options: { layout: x.columns.length > 1 ? "banner" : "separate", significance: true, planned: x.id, ...(x.hypotheses.length ? { hypotheses: x.hypotheses } : {}) },
    ...(x.reason ? { notes: x.reason } : {}),
  };
}

/** One planned test as the analysis that runs it — variables in the order each runner expects. */
export function testDefinition(t: PlannedTest, dataset: DatasetSpec): AnalysisDefinition {
  const kind = METHOD_KIND[t.method];
  const base = { dataset, options: { planned: t.id, ...(t.hypotheses.length ? { hypotheses: t.hypotheses } : {}) } as Record<string, unknown>, ...(t.reason ? { notes: t.reason } : {}) };
  const name = t.reason ?? `${words(t.method)}${t.outcome ? ` — ${t.outcome}` : ""}`;
  switch (kind) {
    case "test": {
      // the runner reads [measured, grouping]: the outcome first, then the group or the second variable
      // a test planned by sentence (Phase 4) lists the outcome in `variables` too: the same variable once, never "SAT across GENDER and SAT"
      const variables = [...new Set([t.outcome, t.groupBy ?? t.variables[0], ...(t.groupBy ? t.variables : t.variables.slice(1))].filter((v): v is string => !!v))];
      return { ...base, name, kind, variables, options: { ...base.options, test: TEST_NAME[t.method] ?? "auto" } };
    }
    case "regression": {
      if (t.mediator && t.variables.length) return { ...base, name, kind, variables: [t.outcome!, t.variables[0], t.mediator], options: { ...base.options, model: "mediation" } };
      const xs = [...t.variables, ...(t.moderator ? [t.moderator] : [])];
      return { ...base, name, kind, variables: [t.outcome!, ...xs], options: { ...base.options, model: t.method === "logistic_regression" ? "logistic" : "linear", ...(t.moderator && xs.length >= 2 ? { moderation: true, interactions: [[xs[0], t.moderator]] } : {}) } };
    }
    case "correlation": return { ...base, name, kind, variables: [...(t.outcome ? [t.outcome] : []), ...t.variables], options: { ...base.options, method: "pearson" } };
    case "topbox": return { ...base, name, kind, variables: [...(t.outcome ? [t.outcome] : []), ...t.variables], options: { ...base.options, primaryBox: 2 } };
    case "maxdiff": case "conjoint": case "nps": case "turf": case "text": case "ranking": case "allocation": case "pricing": case "brand": case "reliability": case "factor": case "cluster": case "descriptive": case "crosstab":
    default:
      return { ...base, name, kind, variables: [...(t.outcome ? [t.outcome] : []), ...t.variables, ...(t.groupBy ? [t.groupBy] : [])] };
  }
}

/**
 * Everything the plan says to run, as analyses — the planned crosstabs and
 * tests, and (when asked) each question's primary analysis. Ordered by
 * priority, hypothesis-linked first, so "create the planned analyses" lands
 * the important ones at the top of the rail.
 */
export function plannedAnalyses(def: SurveyDefinition, dataset: DatasetSpec, opts: { primaries?: boolean; plan?: AnalysisPlan } = {}): PlannedAnalysis[] {
  const plan = opts.plan ?? def.research?.analysisPlan ?? buildAnalysisFramework(def);
  const out: PlannedAnalysis[] = [];
  for (const x of plan.crosstabs) out.push({ definition: crosstabDefinition(x, dataset, def), source: { kind: "crosstab", id: x.id }, priority: x.priority, hypotheses: x.hypotheses, ...(x.reason ? { reason: x.reason } : {}) });
  for (const t of plan.tests) out.push({ definition: testDefinition(t, dataset), source: { kind: "test", id: t.id }, priority: t.priority, hypotheses: t.hypotheses, ...(t.reason ? { reason: t.reason } : {}) });
  if (opts.primaries) {
    for (const q of def.questions) {
      if (["html", "custom_component", "media_timeline"].includes(q.type)) continue;
      const a = inferQuestionAnalysis(def, q);
      if (a.role === "screening") continue;
      const m = a.primary[0];
      if (!m) continue;
      const kind = METHOD_KIND[m];
      if (kind === "crosstab") continue;
      out.push({ definition: { name: `${q.code} — ${words(m)}`, kind, dataset, variables: [q.variableName], options: { planned: `primary:${q.id}`, ...(kind === "topbox" ? { primaryBox: 2 } : {}), ...(kind === "descriptive" && measurementOf(q) !== "nominal" ? { statistics: ["mean", "median"] } : {}) } }, source: { kind: "primary", questionId: q.id }, priority: a.role === "dependent" ? 1 : 2, hypotheses: a.hypotheses });
    }
  }
  return out.sort((a, b) => (b.hypotheses.length ? 1 : 0) - (a.hypotheses.length ? 1 : 0) || a.priority - b.priority);
}
