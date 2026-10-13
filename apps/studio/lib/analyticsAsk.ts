import type { SupabaseClient } from "@supabase/supabase-js";
import { aiConfigured, aiProviderName, completeJson } from "@rescript/ai";
import {
  ASK_INSTRUCTIONS, askBrief, checkChartChoice, definitionFor, itemsFromModel, normalizeReportDefinition, proposeFromText, surveyKnownNames, validateAskOp, variableMetadata,
  type AnalysisDefinition, type AnalysisResult, type AskContext, type AskItem, type AskOp, type AskProposal, type ChartSpec, type UndoRecord, type DatasetSpec, type ReportDefinition,
} from "@rescript/analytics";
import type { SurveyDefinition } from "@rescript/schema";
import type { AuthedUser } from "@/lib/guard";
import { billingProjectFor, meteredAi } from "@/lib/metering";
import { compute, type LoadedContext } from "@/lib/analytics";
export { applyOps, undoRecords, type AppliedItem, type Undone } from "@/lib/analyticsAskApply";

/**
 * SERVER SIDE OF INTELLIGENT MODE FOR ANALYTICS.
 *
 *   propose  — read-only. Words → reviewable items. Nothing is written.
 *   apply    — each item is validated AGAIN against the live survey, saved
 *              analyses and results, then executed; every executed item says
 *              what it did and how to undo it. A blocked item is reported and
 *              left alone — one failure never stops the others.
 *   undo     — reverses what apply recorded, unless the thing was changed since.
 *
 * A report is never created from here: it goes through the report builder's
 * review step (included / left out / why), which is the one place that draft is
 * shown. No operation carries a statistic — the model, when there is one, only
 * picks operations from the closed vocabulary.
 */
const MAX_ANALYSES = 80;

export const datasetFrom = (raw: unknown): DatasetSpec => {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { environment: d.environment === "TEST" || d.environment === "ALL" ? d.environment : "LIVE", dataset: d.dataset === "clean" ? "clean" : "all" } as DatasetSpec;
};

export async function askContext(db: SupabaseClient, surveyId: string, loaded: LoadedContext, dataset: DatasetSpec, opts: { results: boolean }): Promise<AskContext> {
  const [{ data: a }, { data: r }] = await Promise.all([
    db.from("analytics_analyses").select("id, name, definition").eq("survey_id", surveyId).is("deleted_at", null).order("position", { ascending: true, nullsFirst: false }).limit(MAX_ANALYSES),
    db.from("analytics_reports").select("id, name, definition, kind").eq("survey_id", surveyId).is("deleted_at", null).eq("kind", "report").limit(40),
  ]);
  const analyses = ((a ?? []) as { id: string; name: string; definition: AnalysisDefinition }[]).map((x) => ({ id: x.id, name: x.name, definition: { ...x.definition, id: x.id, name: x.name } as AnalysisDefinition }));
  const reports = ((r ?? []) as { id: string; name: string; definition: ReportDefinition }[]).map((x) => ({ id: x.id, name: x.name, definition: x.definition }));
  const results: Record<string, AnalysisResult | undefined> = {};
  if (opts.results) {
    /* only the analyses a chart block reads — computing all of them to answer a question about charts would be waste */
    const wanted = new Set<string>();
    for (const rep of reports) for (const b of rep.definition.blocks ?? []) if (b.type === "chart" && b.analysisId) wanted.add(b.analysisId);
    for (const an of analyses) if (wanted.has(an.id)) {
      try { results[an.id] = (await compute(db, surveyId, loaded, an.definition)) as AnalysisResult; } catch (e) { console.error(`[analytics] ask: analysis ${an.id} failed:`, e); }
    }
  }
  const vmeta = variableMetadata(loaded.def as SurveyDefinition);
  return { variables: vmeta, known: surveyKnownNames(loaded.def as SurveyDefinition, vmeta), analyses, reports, results, dataset };
}

export type ModelAsk = "not_asked" | "no_model" | "nothing" | "used" | "ai_off";

/** Rules first; a model only for a request the rules could not read at all, answering in the same closed vocabulary. */
export async function propose(db: SupabaseClient, user: AuthedUser | null, surveyId: string, loaded: LoadedContext, request: string, dataset: DatasetSpec, opts: { model: boolean; fake?: unknown; focus?: { analysisId: string } }): Promise<AskProposal & { model: { status: ModelAsk; detail: string } }> {
  const ctx = { ...(await askContext(db, surveyId, loaded, dataset, { results: true })), ...(opts.focus ? { focus: opts.focus } : {}) };
  const p = proposeFromText(request, ctx);
  if (!opts.model || !p.unread.length) return { ...p, model: { status: "not_asked", detail: "" } };
  if (!aiConfigured()) return { ...p, model: { status: "no_model", detail: "No AI model is configured, so only the parts that could be read by rules were proposed." } };
  let raw: unknown = aiProviderName() === "fake" && opts.fake && typeof opts.fake === "object" ? opts.fake : null;
  if (!raw) {
    const billing = await billingProjectFor(user, surveyId, "analytics.edit");
    if ("response" in billing) return { ...p, model: { status: "nothing", detail: "The workspace could not be charged for the model call." } };
    const prompt = `${ASK_INSTRUCTIONS}\n\n${askBrief(p.unread.join("\n"), ctx.variables)}`;
    const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: prompt, maxTokens: 800, operation: "analytics_ask", tier: "small" }, () => completeJson("You translate analysis requests into a closed set of operations. Answer with JSON only.", prompt, 800, { timeoutMs: 30_000, tier: "small" })).catch(() => null);
    /* the project's AI switch said no: say so, and let the rules' proposal stand (audit A-2) */
    if (m && !m.ok && m.reason === "ai_off") return { ...p, model: { status: "ai_off", detail: m.message } };
    raw = m && m.ok ? m.value : null;
  }
  if (!raw) return { ...p, model: { status: "nothing", detail: "The model gave nothing usable for the parts that could not be read." } };
  const { items, rejected } = itemsFromModel(raw, ctx);
  const taken = new Set(p.items.map((i) => JSON.stringify({ ...i.op, name: undefined })));
  const fresh = items.filter((i) => !taken.has(JSON.stringify({ ...i.op, name: undefined })));
  return {
    ...p, items: [...p.items, ...fresh.map((i) => ({ ...i, why: `Suggested by the model: ${i.why}` }))],
    unread: fresh.length ? [] : p.unread,
    notes: [...p.notes, ...(rejected.length ? [`The model suggested ${rejected.length} operation${rejected.length === 1 ? "" : "s"} that were dropped: ${rejected.join("; ")}.`] : [])],
    model: { status: fresh.length ? "used" : "nothing", detail: fresh.length ? `${fresh.length} item${fresh.length === 1 ? "" : "s"} from the model — each checked like the rest.` : "The model had nothing to add." },
  };
}
