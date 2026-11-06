import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { interpretResult, namingContext, researchVariable, variableMetadata, type AnalysisDefinition, type AnalysisResult, type GatedInterpretation, type Interpretation } from "@rescript/analytics";
import { compute, type LoadedContext } from "./analytics";
import { modelInterpretation, type ModelStatus } from "./analyticsBuilder";
import type { AuthedUser } from "./guard";

/**
 * THE INTERPRETATION OF ONE RESULT, from the server (M5). The engine's two layers always (interpretResult: the
 * statistics as they are, the plain reading with the hypotheses the plan ties the analysis to and the objective);
 * the model's implications and recommendations when asked (`model`), through the same claim gate the report
 * builder uses (modelInterpretation) — marked as the model's, with how many sentences survived.
 */
export interface InterpretPayload {
  interpretation: Interpretation;
  model: { status: ModelStatus; detail: string; implications: string[]; recommendations: string[]; rejected: number } | null;
  /** the result's identity, so the client knows what it interprets */
  name: string; n: number; computedAt: string;
}

export function planContextFor(def: SurveyDefinition, d: AnalysisDefinition): { hypotheses: { label: string; text: string }[]; reason: string | null } {
  const planned = typeof d.options?.planned === "string" ? d.options.planned : null;
  const plan = def.research?.analysisPlan;
  if (!planned || !plan) return { hypotheses: [], reason: null };
  const item = [...plan.crosstabs, ...plan.tests].find((x) => x.id === planned);
  if (!item) return { hypotheses: [], reason: null };
  const all = def.research?.hypotheses ?? [];
  const hypotheses = item.hypotheses.map((label) => { const i = all.findIndex((_, k) => hypothesisLabel(k) === label); return { label, text: i >= 0 ? all[i] : label }; });
  return { hypotheses, reason: item.reason ?? null };
}

export async function interpretPayload(db: SupabaseClient, surveyId: string, ctx: LoadedContext, user: AuthedUser | null, input: { analysisId?: string; definition?: AnalysisDefinition; model?: boolean; fake?: unknown }): Promise<InterpretPayload | { error: string; status: number }> {
  const def = ctx.def as SurveyDefinition;
  let d = input.definition ?? null;
  let id = input.analysisId ?? null;
  if (!d && id) {
    const { data } = await db.from("analytics_analyses").select("id, name, definition").eq("id", id).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
    if (!data) return { error: "That analysis does not exist.", status: 404 };
    d = { ...(data.definition as AnalysisDefinition), name: String(data.name) };
  }
  if (!d) return { error: "An analysisId or a definition is needed.", status: 400 };
  if (!id) id = "adhoc";
  const result: AnalysisResult = await compute(db, surveyId, ctx, d);
  const naming = namingContext(def, variableMetadata(def).filter((v) => !v.hidden));
  const pc = planContextFor(def, d);
  const interpretation = interpretResult(d, result, { labelOf: (n) => researchVariable(n, naming).researchLabel, hypotheses: pc.hypotheses, reason: pc.reason, objective: def.research?.objective ?? null });
  let model: InterpretPayload["model"] = null;
  if (input.model) {
    const m = await modelInterpretation(user, surveyId, { objective: def.research?.objective ?? "", audience: "researcher", tone: "plain", keyQuestions: pc.hypotheses.map((h) => h.text) }, [{ id, name: d.name, definition: d, result }], { ask: true, fake: input.fake, db });
    const g: GatedInterpretation | null = m.interpretation;
    model = { status: m.status, detail: m.detail, implications: g?.implications ?? [], recommendations: g?.recommendations ?? [], rejected: g?.rejected.length ?? 0 };
  }
  return { interpretation, model, name: d.name, n: result.base.n, computedAt: result.computedAt };
}
