import "server-only";
import { SurveyDefinition } from "@rescript/schema";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The definition the quality tools work from: the autosaved draft when there
 * is one (so a settings change is reflected on recompute immediately —
 * "preview rule impact"), otherwise the current version.
 */
export async function loadQualityDefinition(db: SupabaseClient, surveyId: string, source: "draft" | "version" = "draft"): Promise<{ def: SurveyDefinition; source: "draft" | "version"; customerId: string | null } | { error: string; status: number }> {
  const { data: survey } = await db.from("surveys").select("current_version_id, draft_definition, customer_id").eq("id", surveyId).single();
  if (!survey) return { error: "survey not found", status: 404 };
  if (source === "draft" && survey.draft_definition) {
    const p = SurveyDefinition.safeParse(survey.draft_definition);
    if (p.success) return { def: p.data, source: "draft", customerId: survey.customer_id ?? null };
  }
  if (!survey.current_version_id) return { error: "no saved version", status: 404 };
  const { data: ver } = await db.from("survey_versions").select("definition").eq("id", survey.current_version_id).single();
  const p = ver ? SurveyDefinition.safeParse(ver.definition) : null;
  if (!p?.success) return { error: "definition invalid", status: 500 };
  return { def: p.data, source: "version", customerId: survey.customer_id ?? null };
}

/** Migration 0005 not applied → a readable message instead of a stack. */
export function missingMigration(message: string | undefined): boolean {
  return !!message && /column .* does not exist|relation .* does not exist|does not exist|schema cache/i.test(message);
}
