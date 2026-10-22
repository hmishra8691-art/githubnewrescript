import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { advancedNarrative, failedResult, narrativeMarkdown, plannedAnalyses, plannedIdOf, semPathDiagramSvg, type AnalysisDefinition, type AnalysisResult, type DatasetSpec, type ReportBrief } from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject } from "@/lib/guard";
import { compute, latestRun, loadDefinition, modelInputKey, runPlanFor, type LoadedContext } from "@/lib/analytics";
import { cacheGet } from "@/lib/resultCache";
import { modelInterpretation } from "@/lib/analyticsBuilder";
import { jobDepsFor } from "@/lib/modelJobs";
import { continueJob, startJob } from "./modelJobsCore.ts";
import type { ModelJobView } from "./modelJobState.ts";
import { advancedStatus, isAdvancedDefinition, rerunTargets, type AdvancedItemStatus, type AdvancedPlanItem } from "./advancedModelsCore.ts";

/**
 * THE ADVANCED MODELS OF THE PLAN — their live state, their reading, their re-run (2026-10-22).
 * Dispatched from the analytics route:
 *
 *   GET  advanced                     each advanced plan item: fresh / stale (with the completes since) /
 *                                     never run / running (with the job's progress), and the plan's policy
 *   POST advanced/narrative           { planned | analysisId, environment, dataset, interpretation?, language?, fake? }
 *                                     the engine's plain-language reading (facts, diagnostics, caveats — numbers
 *                                     only from the result), the SEM path diagram as SVG, and — asked for, with a
 *                                     model configured — the model's interpretation through the claim gate
 *   POST advanced/rerun               { environment, dataset } — HB jobs (re)started for stale or missing results,
 *                                     the plan run again for the others; nothing is overwritten until it finishes
 *
 * The cron (`/api/cron/analysis-runs`) calls `advancedTick` for a plan whose policy is "threshold".
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const specOf = (env: unknown, ds: unknown): DatasetSpec => ({ environment: env === "TEST" || env === "ALL" ? env : "LIVE", dataset: ds === "clean" ? "clean" : "all" });

/** the plan's advanced items, as their saved analyses where the apply made them */
export async function advancedPlanItems(db: SupabaseClient, surveyId: string, loaded: LoadedContext, spec: DatasetSpec): Promise<AdvancedPlanItem[]> {
  const def = loaded.def as SurveyDefinition;
  if (!def.research?.analysisPlan) return [];
  const planned = plannedAnalyses(def, spec).filter((p) => isAdvancedDefinition(p.definition));
  if (!planned.length) return [];
  const { data: saved } = await db.from("analytics_analyses").select("id, definition").eq("survey_id", surveyId).is("deleted_at", null);
  return planned.map((p) => {
    const id = plannedIdOf(p.definition)!;
    const row = (saved ?? []).find((r) => plannedIdOf(r.definition as AnalysisDefinition) === id);
    return { planned: id, title: p.definition.name, definition: row ? { ...(row.definition as AnalysisDefinition), id: String(row.id), dataset: spec } : p.definition, analysisId: row ? String(row.id) : null };
  });
}

export async function advancedStatusFor(db: SupabaseClient, surveyId: string, loaded: LoadedContext, spec: DatasetSpec): Promise<AdvancedItemStatus[]> {
  const items = await advancedPlanItems(db, surveyId, loaded, spec);
  if (!items.length) return [];
  const run = await latestRun(db, surveyId, spec.environment);
  return advancedStatus(db, surveyId, { items, run: run ? { computedAt: run.computedAt, n: run.n, items: run.items } : null, environment: spec.environment, policy: (loaded.def as SurveyDefinition).research?.analysisPlan?.advancedRerun });
}

/** an advanced item's result: HB from its finished job (the result cache), the others computed or served from the cache */
async function resultOf(db: SupabaseClient, surveyId: string, loaded: LoadedContext, def: AnalysisDefinition): Promise<AnalysisResult> {
  if (def.kind === "hb") {
    const { key } = await modelInputKey(db, surveyId, loaded, def);
    const hit = await cacheGet<AnalysisResult>(db, surveyId, key);
    return hit?.payload ?? failedResult(def.name, "hb", "Hierarchical Bayes has no finished run on the data as it is now — apply the plan (or re-run) to start it as a background job.", "job_pending");
  }
  return (await compute(db, surveyId, loaded, def)) as AnalysisResult;
}

export interface RerunOutcome { status: AdvancedItemStatus[]; jobs: { planned: string; title: string; analysisId: string | null; job: ModelJobView }[]; continued: number; runId: string | null }

/**
 * RE-RUN THE ADVANCED MODELS. HB items whose result is stale or missing are (re)started as jobs (a new input hash
 * for new data — the old result stays until the new one is done); running jobs are advanced one chunk when asked
 * (`advance`, the cron); the plan is run again when another advanced item is stale, or an HB job has finished since
 * the latest run (so its result joins the findings). `onlyAuto`: only what the plan's threshold policy asks for.
 */
export async function rerunAdvanced(db: SupabaseClient, surveyId: string, loaded: LoadedContext, spec: DatasetSpec, userId: string | null, opts: { onlyAuto?: boolean; chunkMs?: number; advance?: boolean; budgetEnds?: number } = {}): Promise<RerunOutcome> {
  const items = await advancedPlanItems(db, surveyId, loaded, spec);
  const status = await advancedStatusFor(db, surveyId, loaded, spec);
  const t = rerunTargets(status, { onlyAuto: opts.onlyAuto });
  const deps = jobDepsFor(db, surveyId, loaded, userId, { chunkMs: opts.chunkMs ?? 5_000 });
  const jobs: RerunOutcome["jobs"] = [];
  const timeLeft = () => (opts.budgetEnds ? opts.budgetEnds - Date.now() > (opts.chunkMs ?? 5_000) + 3_000 : true);
  for (const planned of t.hb) {
    const it = items.find((i) => i.planned === planned);
    if (!it || !timeLeft()) continue;
    const out = await startJob(deps, it.definition, it.analysisId);
    if (out.body.job) jobs.push({ planned, title: it.title, analysisId: it.analysisId, job: out.body.job });
  }
  let continued = 0;
  if (opts.advance) for (const s of status) if (s.job?.status === "running" && timeLeft()) { await continueJob(deps, s.job.id); continued++; }
  const latest = await latestRun(db, surveyId, spec.environment);
  const after = opts.advance || jobs.length ? await advancedStatusFor(db, surveyId, loaded, spec) : status;
  const hbJoined = after.some((s) => s.kind === "hb" && s.job?.status === "done" && !!s.job.finishedAt && (!latest || s.job.finishedAt > latest.computedAt));
  let runId: string | null = null;
  if ((t.runPlan || hbJoined) && timeLeft()) {
    const r = await runPlanFor(db, surveyId, loaded, { environment: spec.environment, dataset: spec.dataset === "clean" ? "clean" : "all", trigger: "advanced_rerun", userId, skipEmpty: true });
    runId = r.stored?.id ?? null;
  }
  return { status: after, jobs, continued, runId };
}

/** the cron's step for a plan with the threshold policy: re-run what the policy asks for, advance running jobs, bring finished ones into a run */
export async function advancedTick(db: SupabaseClient, surveyId: string, loaded: LoadedContext, budgetEnds: number): Promise<RerunOutcome | null> {
  const policy = (loaded.def as SurveyDefinition).research?.analysisPlan?.advancedRerun;
  if (policy?.mode !== "threshold") return null;
  return rerunAdvanced(db, surveyId, loaded, { environment: "LIVE", dataset: "clean" }, null, { onlyAuto: true, advance: true, chunkMs: 10_000, budgetEnds });
}

/** at most this many advanced results get their own model interpretation in a drafted report (each is a metered call) */
export const REPORT_ADVANCED_MAX = 3;

/**
 * For the report builder: one gated interpretation per advanced result (HB, latent class, SEM, bootstrapped
 * mediation, ω, Gabor–Granger), each built from that result's facts alone so its claims check against its own
 * numbers. Asked only when the draft asks for interpretation; nothing when no model is configured.
 */
export async function advancedInterpretationsFor(user: Parameters<typeof modelInterpretation>[0], surveyId: string, brief: ReportBrief, items: readonly { id: string; name: string; definition: AnalysisDefinition; result: AnalysisResult }[], opts: { ask: boolean; fake?: unknown; db: SupabaseClient }): Promise<Record<string, { implications: string[]; recommendations: string[] }>> {
  const out: Record<string, { implications: string[]; recommendations: string[] }> = {};
  if (!opts.ask) return out;
  const advanced = items.filter((i) => isAdvancedDefinition(i.definition) && !i.result.error).slice(0, REPORT_ADVANCED_MAX);
  for (const it of advanced) {
    const m = await modelInterpretation(user, surveyId, brief, [it], { ask: true, fake: opts.fake, db: opts.db });
    if (m.status === "no_model") break;
    if (m.interpretation && (m.interpretation.implications.length || m.interpretation.recommendations.length)) out[it.id] = { implications: m.interpretation.implications, recommendations: m.interpretation.recommendations };
  }
  return out;
}

export async function advancedGET(req: NextRequest, surveyId: string): Promise<NextResponse> {
  const ctx = await requireProject(req, surveyId, "analytics.read");
  if (isFailure(ctx)) return ctx.response as NextResponse;
  const db = supabaseService();
  const loaded = await loadDefinition(db, surveyId);
  if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
  const spec = specOf(req.nextUrl.searchParams.get("environment"), req.nextUrl.searchParams.get("dataset"));
  return json({ items: await advancedStatusFor(db, surveyId, loaded, spec), policy: (loaded.def as SurveyDefinition).research?.analysisPlan?.advancedRerun ?? { mode: "manual" } });
}

export async function advancedPOST(req: NextRequest, surveyId: string, sub: string | undefined, body: Record<string, unknown>): Promise<NextResponse> {
  if (sub === "narrative") {
    const wantModel = body.interpretation === true;
    /* the model's part is metered and needs the right to write analytics (as the report builder's interpretation does) */
    const ctx = await requireProject(req, surveyId, wantModel ? "analytics.edit" : "analytics.read");
    if (isFailure(ctx)) return ctx.response as NextResponse;
    const db = supabaseService();
    const loaded = await loadDefinition(db, surveyId);
    if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
    const spec = specOf(body.environment, body.dataset);
    const items = await advancedPlanItems(db, surveyId, loaded, spec);
    const it = items.find((i) => (typeof body.planned === "string" && i.planned === body.planned) || (typeof body.analysisId === "string" && i.analysisId === body.analysisId));
    if (!it) return json({ error: "That is not an advanced model of this survey's analysis plan." }, 404);
    const def = loaded.def as SurveyDefinition;
    const result = await resultOf(db, surveyId, loaded, it.definition);
    const run = await latestRun(db, surveyId, spec.environment);
    const hypotheses = (def.research?.hypotheses ?? []).map((text, i) => ({ label: `H${i + 1}`, text }));
    const narrative = advancedNarrative(it.definition, result, { objective: def.research?.objective, hypotheses, verdicts: run?.verdicts });
    if (!narrative) return json({ error: "This analysis has no advanced reading." }, 422);
    const svg = it.definition.kind === "sem" && !result.error ? semPathDiagramSvg(result) : null;
    let interpretation: { implications: string[]; recommendations: string[]; rejected: { text: string; reason: string }[] } | null = null;
    let model = { status: "not_asked", detail: "Interpretation was not requested." };
    if (wantModel && narrative.valid) {
      const language = typeof body.language === "string" && body.language.trim() ? body.language.trim().slice(0, 40) : def.localization?.sourceLanguage ?? undefined;
      const brief: ReportBrief = { objective: def.research?.objective ?? "", audience: "researcher", tone: "plain", keyQuestions: narrative.hypotheses.map((h) => `${h.label}: ${h.text ?? ""}`), ...(language ? { language } : {}) };
      const m = await modelInterpretation(ctx.user, surveyId, brief, [{ id: it.analysisId ?? it.planned, name: it.title, definition: it.definition, result }], { ask: true, fake: body.fake, db });
      interpretation = m.interpretation ? { implications: m.interpretation.implications, recommendations: m.interpretation.recommendations, rejected: m.interpretation.rejected } : null;
      model = { status: m.status, detail: m.detail };
    }
    return json({ planned: it.planned, title: it.title, narrative, markdown: narrativeMarkdown(narrative, interpretation), svg, interpretation, model, pending: result.error?.code === "job_pending" });
  }
  if (sub === "rerun") {
    const ctx = await requireProject(req, surveyId, "analytics.edit");
    if (isFailure(ctx)) return ctx.response as NextResponse;
    const db = supabaseService();
    const loaded = await loadDefinition(db, surveyId);
    if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
    const r = await rerunAdvanced(db, surveyId, loaded, specOf(body.environment, body.dataset), ctx.user.userId);
    return json(r);
  }
  return json({ error: "Unknown advanced-models endpoint." }, 404);
}
