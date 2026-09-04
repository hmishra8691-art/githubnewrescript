import "server-only";
import { SurveyDefinition } from "@rescript/schema";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LoadedQualityDefinition {
  def: SurveyDefinition;
  /** where the settings came from: the autosaved draft or the current version */
  source: "draft" | "version";
  customerId: string | null;
  /** the survey row's revision (bumped by every autosave and every cut version) */
  revision: number | null;
  /** when the draft was last autosaved (draft source only) */
  draftUpdatedAt: string | null;
  /** the current version this survey points at, and its label */
  versionId: string | null;
  version: string | null;
}

/**
 * The definition the quality tools work from: the autosaved draft when there
 * is one (so a settings change is reflected on the dashboard and on recompute
 * immediately — "preview rule impact"), otherwise the current version. The
 * same rule the TEST link follows, so what the dashboard shows, what a
 * recompute uses and what a test session is graded with agree.
 *
 * A draft that does not parse is reported, not skipped: falling back to the
 * version would silently show older settings as if they were current.
 */
export async function loadQualityDefinition(db: SupabaseClient, surveyId: string, source: "draft" | "version" = "draft"): Promise<LoadedQualityDefinition | { error: string; status: number }> {
  const { data: survey } = await db.from("surveys").select("current_version_id, draft_definition, draft_updated_at, revision, customer_id").eq("id", surveyId).single();
  if (!survey) return { error: "survey not found", status: 404 };
  const revision = typeof survey.revision === "number" ? survey.revision : null;
  const base = { customerId: survey.customer_id ?? null, revision, versionId: (survey.current_version_id as string | null) ?? null };
  if (source === "draft" && survey.draft_definition) {
    const p = SurveyDefinition.safeParse(survey.draft_definition);
    if (p.success) return { ...base, def: p.data, source: "draft", draftUpdatedAt: (survey.draft_updated_at as string | null) ?? null, version: p.data.meta.version ?? null };
    return { error: `The autosaved draft does not match the current schema, so its quality settings could not be read: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, status: 422 };
  }
  if (!survey.current_version_id) return { error: "no saved version", status: 404 };
  const { data: ver } = await db.from("survey_versions").select("definition, version").eq("id", survey.current_version_id).single();
  const p = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  if (!p?.success) return { error: "definition invalid", status: 500 };
  return { ...base, def: p.data, source: "version", draftUpdatedAt: null, version: (ver?.version as string) ?? p.data.meta.version ?? null };
}

/** Migration 0005 not applied → a readable message instead of a stack. */
export function missingMigration(message: string | undefined): boolean {
  return !!message && /column .* does not exist|relation .* does not exist|does not exist|schema cache/i.test(message);
}
