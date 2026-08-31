import "server-only";
import { supabaseAdmin } from "./admin";
import { SurveyDefinition } from "@rescript/schema";

export interface LoadedDeployment {
  deploymentId: string;
  surveyId: string;
  versionId: string;
  mode: "test" | "live";
  definition: SurveyDefinition;
}

export async function loadDeployment(
  clientSlug: string,
  studySlug: string,
  mode: "test" | "live",
): Promise<LoadedDeployment | null> {
  const db = supabaseAdmin();
  const { data: dep } = await db
    .from("deployments")
    .select("id, survey_id, version_id, mode, active")
    .eq("client_slug", clientSlug)
    .eq("study_slug", studySlug)
    .eq("mode", mode)
    .eq("active", true)
    .maybeSingle();
  if (!dep) return null;

  const { data: ver } = await db
    .from("survey_versions")
    .select("id, definition")
    .eq("id", dep.version_id)
    .single();
  if (!ver) return null;

  const parsed = SurveyDefinition.safeParse(ver.definition);
  if (!parsed.success) return null;

  return {
    deploymentId: dep.id,
    surveyId: dep.survey_id,
    versionId: dep.version_id,
    mode: dep.mode,
    definition: parsed.data,
  };
}
