import "server-only";
import type { DatasetSpec } from "@rescript/analytics";
import type { SurveyDefinition } from "@rescript/schema";
import { supabaseAdmin } from "../admin";
import { latestRun, loadDefinition } from "../analytics";
import { applyPlan } from "../analysisPlanService";
import { dbConfigured } from "../copilot/durable.ts";
import type { ApplyLite, ResearchBackend, ResearchRunLite } from "./handlers/research.ts";

/**
 * THE RESEARCH AGENTS' DATA DOOR, ON THIS SERVER (2026-11-07). The same functions the Data Analytics routes call —
 * `loadDefinition`, `applyPlan`, `latestRun` — behind the narrow interface the handlers see. Null when there is no
 * database (the sandbox): the handlers then pause the task and say why, instead of inventing data.
 */
export function serverResearchBackend(): ResearchBackend | null {
  if (!dbConfigured()) return null;
  return {
    async definition(surveyId) {
      const r = await loadDefinition(supabaseAdmin(), surveyId);
      return "error" in r ? { error: r.error } : { def: r.def as SurveyDefinition };
    },
    async applyPlan(surveyId, dataset: DatasetSpec) {
      const db = supabaseAdmin();
      const loaded = await loadDefinition(db, surveyId);
      if ("error" in loaded) return { ok: false, status: loaded.status, error: loaded.error };
      return (await applyPlan(db, surveyId, loaded, { dataset, userId: null })) as unknown as ApplyLite;
    },
    async latestRun(surveyId, environment) {
      return (await latestRun(supabaseAdmin(), surveyId, environment)) as unknown as ResearchRunLite | null;
    },
  };
}
