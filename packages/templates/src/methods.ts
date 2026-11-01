/**
 * RESEARCH-METHOD STARTERS (S5c, 2026-11-01) — the "New survey" side of `add_method_template`.
 *
 * Each starter is a short screener-free study around ONE engine fragment (`methodTemplateFragment`), so the
 * survey opened from the picker and the block Intelligent Mode adds to an existing survey are the same
 * questions, variable names and analysis-plan items. The plan items are what the analysis reads: open the
 * Analysis tab and the method's analysis is already planned.
 */
import { SurveyDefinition } from "@rescript/schema";
import { methodTemplateFragment, type MethodTemplateAction } from "@rescript/engine";

/** deterministic ids per survey (the picker builds the same survey twice and the test compares them) */
function minter(surveyId: string) {
  const n: Record<string, number> = {};
  return (prefix: string) => { n[prefix] = (n[prefix] ?? 0) + 1; return `${prefix}_${surveyId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}_${n[prefix]}`; };
}

export function buildMethodSurvey(surveyId: string, meta: { code: string; title: string }, spec: Omit<MethodTemplateAction, "op">): SurveyDefinition {
  const ids = minter(surveyId);
  const frag = methodTemplateFragment(spec, ids);
  return SurveyDefinition.parse({
    meta: { id: surveyId, code: meta.code, title: meta.title, version: "1.0", status: "draft" },
    questions: frag.questions,
    flow: [frag.block, { type: "end", id: "end_complete", status: "complete", message: "Thank you — your answers have been recorded." }],
    research: { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], analysisPlan: { crosstabs: [], tests: frag.tests.map((t) => ({ id: ids("t"), ...t })), derived: [], segments: [] } },
    deployment: { clientSlug: "client", studySlug: meta.code.toLowerCase().replace(/[^a-z0-9]+/g, "-") },
  });
}

export const buildPricingPsmSurvey = (surveyId = "pricing-psm") =>
  buildMethodSurvey(surveyId, { code: "PSM", title: "Price sensitivity (Van Westendorp + NMS)" }, { template: "pricing_psm", product: "the product" });

export const buildPriceLadderSurvey = (surveyId = "price-ladder") =>
  buildMethodSurvey(surveyId, { code: "GGL", title: "Adaptive Gabor–Granger price ladder" }, { template: "price_ladder", product: "the product", prices: [5, 10, 15, 20, 25] });
