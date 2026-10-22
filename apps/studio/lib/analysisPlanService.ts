import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DatasetSpec } from "@rescript/analytics";
import { latestRun, reportFacts, runPlanFor, type LoadedContext } from "./analytics";
import { jobDepsFor } from "./modelJobs";
import { startJob } from "./modelJobsCore.ts";
import { applyPlan as applyCore, planPayload as payloadCore, type ApplyPlanInput, type ApplyPlanOutcome, type PlanDeps, type EditPlanInput, type EditPlanOutcome, editPlan as editCore } from "./analysisPlanCore";

/**
 * THE ANALYSIS PLAN SERVICE — `analysisPlanCore` bound to the real analytics
 * module (the dataset builder, the run store, the report facts). Routes
 * import this; tests import the core with stubs.
 */
const deps: PlanDeps = {
  latestRun, runPlanFor, reportFacts,
  /* HB from the plan (2026-10-22): the apply starts the chunked job with a short first chunk (the apply request has its own work); the page continues it */
  startModelJob: async (db, surveyId, ctx, definition, analysisId, userId) => {
    const out = await startJob(jobDepsFor(db, surveyId, ctx, userId, { chunkMs: APPLY_FIRST_CHUNK_MS }), definition, analysisId);
    return out.body.job ? { job: out.body.job } : { error: out.body.error ?? "The model job could not be started." };
  },
};
/** how long the apply itself advances an HB job before handing it to the page (the rest of the apply must fit in the request) */
const APPLY_FIRST_CHUNK_MS = 5_000;

export const planPayload = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, dataset: DatasetSpec) => payloadCore(db, surveyId, ctx, dataset, deps);
export const applyPlan = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: ApplyPlanInput): Promise<ApplyPlanOutcome> => applyCore(db, surveyId, ctx, input, deps);
export const editPlan = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: EditPlanInput): Promise<EditPlanOutcome> => editCore(db, surveyId, ctx, input);
export { latestApply, planHash, planOutputs } from "./analysisPlanCore";
export type { ApplyPlanInput, ApplyPlanOutcome, EditPlanInput, EditPlanOutcome, PlanPayload, PlanPayloadItem, StoredApply, HypothesisView } from "./analysisPlanCore";
