import type { AnalysisPlan, MeasurementLevel, PlannedCrosstab, PlannedTest, Question, SurveyDefinition } from "@rescript/schema";
import { expectedSample, isNonQuestionVariable, isScaleLike, measurementOf, requiredBase } from "./analysisFramework.js";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * METHOD SUITABILITY — is this analysis right for these variables? (Research
 * intelligence, 2026-10-17.)
 *
 * The analysis guide tells the model which test goes with which pair of
 * measurement levels; the plan review (`reviewAnalysisPlan`) already refuses
 * dead references, means of categories, two-group tests on three groups and
 * logistic models of non-binary outcomes. These are the selection rules it did
 * NOT check, made explicit and decided by the engine, so a plan the model
 * writes is held to them:
 *
 *   group_multi        a multi-select as the groups of a t-test / ANOVA (its options overlap) — blocking
 *   text_in_test       an open text in any method but text themes — blocking (nothing to compute)
 *   no_outcome         a regression / correlation / comparison with no outcome, or a comparison with no groups — blocking
 *   predictor_multi    a multi-select predictor in a regression / correlation — dummy-code it — warning
 *   method_type        text themes on a closed question, ranking scores on a non-ranking, allocation shares on a
 *                      non-allocation, NPS on a non-0–10, TURF without 0/1 items, Van Westendorp without four
 *                      prices, a funnel without two stages, clustering / factor / reliability on non-scales — warning
 *   expected_counts    a chi-square / crosstab when the study names no sample, so the expected counts (≥ 5 a cell)
 *                      cannot be checked — recommendation with the base it needs
 *   mean_of_categories the outcome of a means comparison is not a scale (the plan review says so too — `inReview`)
 *
 * Pure. Each issue names its rule, so the validator can leave out what the
 * plan review already says and the traceability can mark the item.
 */

export type SuitabilityLevel = "blocking" | "warning" | "recommendation";
export type SuitabilityRule = "group_multi" | "text_in_test" | "no_outcome" | "predictor_multi" | "method_type" | "expected_counts" | "mean_of_categories";
export interface SuitabilityIssue {
  rule: SuitabilityRule;
  level: SuitabilityLevel;
  message: string;
  questionIds: string[];
  itemId: string;
  suggestion?: string;
  /** the plan review (reviewSurvey) already reports this in its own words */
  inReview?: boolean;
}

const MEANS = new Set(["t_test", "anova", "mann_whitney", "kruskal_wallis"]);
const MODELS = new Set(["regression", "logistic_regression", "driver_analysis", "correlation"]);
const resolve = (def: SurveyDefinition, ref: string): Question | undefined => getQuestionByCodeOrVar(def, ref) ?? def.questions.find((q) => q.id === ref);
const words = (m: string) => m.replace(/_/g, " ");

/** one planned crosstab or test against the variables it reads */
export function planItemSuitability(def: SurveyDefinition, item: PlannedCrosstab | PlannedTest, plan: AnalysisPlan | undefined = def.research?.analysisPlan): SuitabilityIssue[] {
  const out: SuitabilityIssue[] = [];
  const add = (rule: SuitabilityRule, level: SuitabilityLevel, message: string, qs: (Question | undefined)[], suggestion?: string, inReview?: boolean) =>
    out.push({ rule, level, message, questionIds: [...new Set(qs.filter((q): q is Question => !!q).map((q) => q.id))], itemId: item.id, ...(suggestion ? { suggestion } : {}), ...(inReview ? { inReview } : {}) });
  const lvl = (q: Question | undefined): MeasurementLevel | undefined => (q ? measurementOf(q) : undefined);
  if ("rows" in item) {
    const qs = [...item.rows, ...item.columns].map((r) => resolve(def, r));
    if (!expectedSample(def) && item.measure !== "mean" && qs.every((q) => !!q && ["nominal", "ordinal", "multi"].includes(measurementOf(q)))) {
      const rb = requiredBase(def, item, { plan });
      add("expected_counts", "recommendation", `The crosstab ${[...item.rows, ...item.columns].map((r) => resolve(def, r)?.code ?? r).join(" × ")} needs about ${rb.minimum} completes (${rb.note}) for its chi-square's expected counts, but the study names no sample — the bases cannot be checked.`, qs, "Record the planned sample (set_research sampleSize) or the quotas' targets.");
    }
    return out;
  }
  const t = item;
  const outcome = t.outcome ? resolve(def, t.outcome) : undefined;
  const group = t.groupBy ? resolve(def, t.groupBy) ?? undefined : undefined;
  const preds = t.variables.map((v) => resolve(def, v));
  const all = [outcome, group, ...preds, t.moderator ? resolve(def, t.moderator) : undefined, t.mediator ? resolve(def, t.mediator) : undefined];
  const name = words(t.method);
  // nothing to compute from an open text, except for the method that reads text
  if (t.method !== "text_themes") {
    const texts = all.filter((q): q is Question => !!q && measurementOf(q) === "text");
    if (texts.length) add("text_in_test", "blocking", `The planned ${name} reads ${texts.map((q) => q.code).join(", ")}, open text — there are no values to compute it on.`, texts, "Use text themes on the open answers, or a closed question for the test.");
  }
  if (MEANS.has(t.method)) {
    // the runner reads [outcome, group ?? variables[0]]
    const g = group ?? preds[0];
    if (!t.outcome) add("no_outcome", "blocking", `The planned ${name} has no outcome to compare.`, [g], "Name the outcome (the scale whose means are compared).");
    if (!t.groupBy && !t.variables.length) add("no_outcome", "blocking", `The planned ${name}${outcome ? ` of ${outcome.code}` : ""} has no grouping variable.`, [outcome], "Name the groups (groupBy).");
    if (g && lvl(g) === "multi") add("group_multi", "blocking", `${g.code} is a multi-select: its options overlap, so it cannot be the groups of a ${name}.`, [g], `Compare ${outcome?.code ?? "the outcome"} in a crosstab with each option of ${g.code} as a column, or group by a single-choice question.`);
    if (outcome && lvl(outcome) !== "text" && !isScaleLike(lvl(outcome)!)) add("mean_of_categories", "warning", `A ${name} compares means, but ${outcome.code} is ${lvl(outcome)}.`, [outcome], "Use a chi-square, or treat it as a scale deliberately.", true);
  }
  if (MODELS.has(t.method)) {
    if (!t.outcome && t.method !== "correlation") add("no_outcome", "blocking", `The planned ${name} has no outcome.`, preds, "Name the outcome the predictors explain.");
    if (t.method === "correlation" && (t.outcome ? 1 : 0) + t.variables.length < 2) add("no_outcome", "blocking", "A correlation needs two variables.", [outcome, ...preds]);
    const multi = [...preds, t.method === "correlation" ? outcome : undefined].filter((q): q is Question => !!q && measurementOf(q) === "multi");
    if (multi.length) add("predictor_multi", "warning", `${multi.map((q) => q.code).join(", ")} ${multi.length === 1 ? "is a multi-select" : "are multi-selects"}: a ${name} needs numbers, and a multi-select is several yes/no variables, not one.`, multi, "Dummy-code it — a flag (derived variable) per option that matters — and enter the flags.");
  }
  const types = (pred: (q: Question) => boolean) => [outcome, ...preds].filter((q): q is Question => !!q).every(pred);
  const has = [outcome, ...preds].some((q) => !!q);
  switch (t.method) {
    case "text_themes": if (has && !types((q) => measurementOf(q) === "text")) add("method_type", "warning", `Text themes read open answers; ${[outcome, ...preds].filter((q): q is Question => !!q && measurementOf(q) !== "text").map((q) => q.code).join(", ")} is not open text.`, [outcome, ...preds], "Plan text themes on the open-ended questions."); break;
    case "ranking_scores": if (has && !types((q) => measurementOf(q) === "rank")) add("method_type", "warning", `Ranking scores need a ranking question; ${(outcome ?? preds.find(Boolean))?.code} is not one.`, [outcome, ...preds]); break;
    case "allocation_shares": if (has && !types((q) => measurementOf(q) === "allocation")) add("method_type", "warning", `Allocation shares need a constant-sum question; ${(outcome ?? preds.find(Boolean))?.code} is not one.`, [outcome, ...preds]); break;
    case "nps": if (has && !types((q) => q.type === "nps" || (q.options?.length === 11))) add("method_type", "warning", `NPS reads a 0–10 likelihood-to-recommend question; ${(outcome ?? preds.find(Boolean))?.code} is not one.`, [outcome, ...preds]); break;
    case "turf": {
      const qs = [outcome, ...preds].filter((q): q is Question => !!q);
      if (qs.length && !(qs.some((q) => measurementOf(q) === "multi") || qs.length >= 2)) add("method_type", "warning", "TURF needs a multi-select (one 0/1 per item) or several yes/no items.", qs, "Ask the reach question as a multi-select of the items.");
      break;
    }
    case "pricing": {
      const qs = [outcome, ...preds].filter((q): q is Question => !!q);
      const numeric = qs.filter((q) => lvl(q) === "ratio" || lvl(q) === "interval");
      if (qs.length !== 4 || numeric.length !== 4) add("method_type", "warning", `A planned pricing item runs Van Westendorp: four numeric price questions in the order too cheap, cheap, expensive, too expensive — this one reads ${qs.length} variable${qs.length === 1 ? "" : "s"}${numeric.length !== qs.length ? `, ${qs.length - numeric.length} not numeric` : ""}.`, qs, "Plan the four price questions in that order; run Gabor–Granger from the Analytics workspace.");
      break;
    }
    case "brand_funnel": {
      const qs = [outcome, ...preds].filter((q): q is Question => !!q);
      const sig = (q: Question) => (q.options ?? []).map((o) => String(o.code)).join(",");
      if (qs.length < 2 || new Set(qs.map(sig)).size > 1) add("method_type", "warning", "A brand funnel needs two or more stages (awareness, consideration, usage …) asked over the same brand list.", qs, "Ask each stage as a multi-select of the same brands, in funnel order.");
      break;
    }
    case "cluster": case "factor": case "reliability": {
      const qs = preds.filter((q): q is Question => !!q);
      const bad = qs.filter((q) => !isScaleLike(measurementOf(q)) && measurementOf(q) !== "text");
      if (bad.length) add("method_type", "warning", `${t.method === "reliability" ? "Reliability" : t.method === "factor" ? "A factor analysis" : "Clustering"} needs scale items; ${bad.map((q) => q.code).join(", ")} ${bad.length === 1 ? "is not one" : "are not"}.`, bad, "Use the rating items of the battery.");
      if (!isNonQuestionVariable(def, t.variables[0] ?? "", plan) && qs.length < 2) add("method_type", "warning", `${t.method === "cluster" ? "Clustering" : t.method === "factor" ? "A factor analysis" : "Reliability"} needs at least two items.`, qs);
      break;
    }
    case "chi_square": {
      if (!expectedSample(def)) {
        const rb = requiredBase(def, t, { plan });
        add("expected_counts", "recommendation", `The chi-square needs about ${rb.minimum} completes (${rb.note}) for its expected counts, but the study names no sample.`, [outcome, ...preds, group], "Record the planned sample (set_research sampleSize) or the quotas' targets.");
      }
      break;
    }
  }
  return out;
}

/** every planned item of the study, checked */
export function planSuitability(def: SurveyDefinition): SuitabilityIssue[] {
  const plan = def.research?.analysisPlan;
  if (!plan) return [];
  return [...plan.crosstabs, ...plan.tests].flatMap((x) => planItemSuitability(def, x, plan));
}
