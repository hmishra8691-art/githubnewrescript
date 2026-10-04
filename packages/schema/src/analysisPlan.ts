import { z } from "zod";

/**
 * THE ANALYSIS FRAMEWORK, WRITTEN BEFORE A SINGLE RESPONSE EXISTS.
 *
 * A questionnaire is an instrument for an analysis, so what each question
 * is FOR — its role in the design, how it is measured, what it will be
 * tabulated against, which hypothesis it serves — belongs with the question,
 * and the tables and tests the study will run belong with the research
 * design. Both are planned here, in the definition, so that:
 *
 *   - the copilot and the engine can check the plan against the survey
 *     (an unmeasured construct, a test on the wrong measurement level, a
 *     crosstab against a deleted question) before fieldwork;
 *   - deleting or retyping a question can say what analysis it breaks;
 *   - after fieldwork the plan runs as it was written — every entry here is
 *     convertible into an `@rescript/analytics` AnalysisDefinition.
 *
 * Every field is optional. A survey without a plan is exactly the survey it
 * was before this existed; nothing here changes how a respondent is asked.
 */

export const ANALYSIS_ROLES = ["dependent", "independent", "mediator", "moderator", "control", "segmentation", "screening", "descriptive"] as const;
export type AnalysisRole = (typeof ANALYSIS_ROLES)[number];

/** the level a question measures at — inferred from its type unless the researcher overrides it */
export const MEASUREMENT_LEVELS = ["nominal", "ordinal", "interval", "ratio", "multi", "text", "rank", "allocation", "choice", "date"] as const;
export type MeasurementLevel = (typeof MEASUREMENT_LEVELS)[number];

/** what can be run — each one maps to an `@rescript/analytics` analysis kind */
export const ANALYSIS_METHODS = [
  "frequencies", "mean", "median", "top_box", "nps", "crosstab",
  "chi_square", "t_test", "anova", "mann_whitney", "kruskal_wallis",
  "correlation", "regression", "logistic_regression", "factor", "reliability", "cluster",
  "conjoint_utilities", "maxdiff_scores", "turf", "driver_analysis", "text_themes",
  "ranking_scores", "allocation_shares", "pricing", "brand_funnel",
] as const;
export type AnalysisMethod = (typeof ANALYSIS_METHODS)[number];

/** `question.analysis` — what this question is for */
export const QuestionAnalysis = z.object({
  role: z.enum(ANALYSIS_ROLES).optional(),
  /** override of the inferred level */
  measurement: z.enum(MEASUREMENT_LEVELS).optional(),
  /** how it is reported on its own: distribution, mean, top-2-box… */
  primary: z.array(z.enum(ANALYSIS_METHODS)).default([]),
  /** variables (names or codes) it is tabulated against */
  crosstabBy: z.array(z.string()).default([]),
  /** modelling it takes part in */
  modeling: z.array(z.enum(ANALYSIS_METHODS)).default([]),
  /** variables it is expected to relate to (an independent's dependent, and back) */
  relatedTo: z.array(z.string()).default([]),
  /** hypothesis labels — "H1", "H2" — the research design's hypotheses by position */
  hypotheses: z.array(z.string()).default([]),
  /** the research construct it measures, by name */
  construct: z.string().optional(),
  notes: z.string().optional(),
});
export type QuestionAnalysis = z.infer<typeof QuestionAnalysis>;

export const PlannedCrosstab = z.object({
  id: z.string(),
  /** variables down the side */
  rows: z.array(z.string()).min(1),
  /** variables across the top (a banner when several) */
  columns: z.array(z.string()).min(1),
  measure: z.enum(["pct_col", "pct_row", "count", "mean"]).optional(),
  /** 1 = answers a hypothesis or the objective directly; 2 = profiling; 3 = exploratory */
  priority: z.number().int().min(1).max(3).default(2),
  hypotheses: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
export type PlannedCrosstab = z.infer<typeof PlannedCrosstab>;

export const PlannedTest = z.object({
  id: z.string(),
  method: z.enum(ANALYSIS_METHODS),
  /** the outcome (dependent) variable, where the method has one */
  outcome: z.string().optional(),
  /** the other variables — predictors, the grouping variable, the items of a scale */
  variables: z.array(z.string()).default([]),
  /** a grouping variable for comparisons (t-test, ANOVA) */
  groupBy: z.string().optional(),
  /** a moderator whose interaction the model includes */
  moderator: z.string().optional(),
  /** a mediator the model routes through */
  mediator: z.string().optional(),
  priority: z.number().int().min(1).max(3).default(2),
  hypotheses: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
export type PlannedTest = z.infer<typeof PlannedTest>;

export const PlannedDerived = z.object({
  name: z.string(),
  kind: z.enum(["mean_score", "sum_score", "top_box", "bottom_box", "recode", "count", "flag", "index"]),
  /** the variables it is built from */
  from: z.array(z.string()).min(1),
  /** a calc expression, where the kind is not enough */
  expression: z.string().optional(),
  reason: z.string().optional(),
});
export type PlannedDerived = z.infer<typeof PlannedDerived>;

export const PlannedSegment = z.object({
  name: z.string(),
  /** the variables that define the segments */
  by: z.array(z.string()).min(1),
  reason: z.string().optional(),
});
export type PlannedSegment = z.infer<typeof PlannedSegment>;

export const AnalysisPlan = z.object({
  crosstabs: z.array(PlannedCrosstab).default([]),
  tests: z.array(PlannedTest).default([]),
  derived: z.array(PlannedDerived).default([]),
  segments: z.array(PlannedSegment).default([]),
  /** who last wrote it — the engine's proposal, the copilot, or the researcher by hand */
  source: z.enum(["engine", "copilot", "researcher"]).optional(),
  updatedAt: z.string().optional(),
});
export type AnalysisPlan = z.infer<typeof AnalysisPlan>;

/** "H1", "H2"… — a hypothesis is named by its position in the research design */
export const hypothesisLabel = (index: number): string => `H${index + 1}`;
