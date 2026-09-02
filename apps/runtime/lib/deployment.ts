import "server-only";
import { supabaseAdmin } from "./admin";
import { SurveyDefinition } from "@rescript/schema";

export interface LoadedDeployment {
  deploymentId: string;
  surveyId: string;
  versionId: string;
  mode: "test" | "live";
  definition: SurveyDefinition;
  /** the project's lifecycle status, so the page can refuse politely */
  surveyStatus: string;
}

/**
 * Statuses that stop a LIVE link accepting respondents. Paused is reversible
 * — the study is on hold, not finished — so it gets its own message. Test
 * links keep working throughout, which is the point of having them.
 */
export const BLOCKING_STATUSES: Record<string, { title: string; body: string }> = {
  paused: {
    title: "This survey is paused",
    body: "It is temporarily not accepting responses. Please try again later.",
  },
  closed: {
    title: "This survey is closed",
    body: "Thank you for your interest — data collection has finished.",
  },
  archived: {
    title: "This survey is no longer available",
    body: "This study has been archived.",
  },
};

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

  const { data: survey } = await db
    .from("surveys")
    .select("status")
    .eq("id", dep.survey_id)
    .maybeSingle();

  const parsed = SurveyDefinition.safeParse(ver.definition);
  if (!parsed.success) return null;

  return {
    deploymentId: dep.id,
    surveyId: dep.survey_id,
    versionId: dep.version_id,
    mode: dep.mode,
    definition: parsed.data,
    surveyStatus: (survey?.status as string) ?? "live",
  };
}
