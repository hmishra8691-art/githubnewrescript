import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DatasetSpec } from "@rescript/analytics";
import { latestRun, reportFacts, runPlanFor, type LoadedContext } from "./analytics";
import { applyPlan as applyCore, planPayload as payloadCore, type ApplyPlanInput, type ApplyPlanOutcome, type PlanDeps, type EditPlanInput, type EditPlanOutcome, editPlan as editCore } from "./analysisPlanCore";

/**
 * THE ANALYSIS PLAN SERVICE — `analysisPlanCore` bound to the real analytics
 * module (the dataset builder, the run store, the report facts). Routes
 * import this; tests import the core with stubs.
 */
const deps: PlanDeps = { latestRun, runPlanFor, reportFacts };

export const planPayload = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, dataset: DatasetSpec) => payloadCore(db, surveyId, ctx, dataset, deps);
export const applyPlan = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: ApplyPlanInput): Promise<ApplyPlanOutcome> => applyCore(db, surveyId, ctx, input, deps);
export const editPlan = (db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: EditPlanInput): Promise<EditPlanOutcome> => editCore(db, surveyId, ctx, input);
export { latestApply, planHash, planOutputs } from "./analysisPlanCore";
export type { ApplyPlanInput, ApplyPlanOutcome, EditPlanInput, EditPlanOutcome, PlanPayload, PlanPayloadItem, StoredApply, HypothesisView } from "./analysisPlanCore";
