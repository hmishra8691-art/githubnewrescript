import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { newSurveyDefinition } from "@/lib/defaults";
import { Studio } from "@/components/studio/Studio";

export const dynamic = "force-dynamic";

/**
 * Load the survey the programmer should see, in this order:
 *
 *   1. the autosaved DRAFT, if one exists — that is their unsaved work
 *   2. otherwise the current version's definition
 *   3. otherwise a blank survey, but only for a survey that genuinely has no
 *      version yet
 *
 * The third case used to swallow real failures: a stored definition that
 * failed schema validation silently opened as a BLANK survey, and the next
 * save overwrote the real questionnaire with nothing. Now a definition that
 * exists but cannot be parsed reports itself instead of pretending to be a new
 * survey.
 */
export default async function StudioPage({ params }: { params: { id: string } }) {
  const db = supabaseAdmin();

  // draft columns only exist after migration 0003 — ask for them, but survive
  // their absence
  let survey: Record<string, unknown> | null = null;
  const withDraft = await db
    .from("surveys")
    .select("id, code, title, current_version_id, draft_definition, draft_updated_at")
    .eq("id", params.id)
    .single();
  if (withDraft.data) survey = withDraft.data;
  else {
    const basic = await db
      .from("surveys")
      .select("id, code, title, current_version_id")
      .eq("id", params.id)
      .single();
    survey = basic.data;
  }

  if (!survey) {
    return <div className="dash"><h1>Survey not found</h1><a href="/">← back</a></div>;
  }

  const code = String(survey.code);
  const title = String(survey.title);
  let definition = newSurveyDefinition(String(survey.id), code, title);
  let versionId: string | null = null;
  let draftSavedAt: string | null = null;
  let loadError: string | null = null;

  if (survey.current_version_id) {
    const { data: ver } = await db
      .from("survey_versions")
      .select("id, definition")
      .eq("id", survey.current_version_id)
      .single();
    if (!ver) {
      loadError =
        "This survey points at a version that no longer exists. Restore one from Versions & Deploy before editing — saving now would replace the questionnaire.";
    } else {
      const parsed = SurveyDefinition.safeParse(ver.definition);
      if (parsed.success) {
        definition = parsed.data;
        versionId = ver.id;
      } else {
        loadError =
          `The saved definition for version ${survey.current_version_id} does not match the current schema and was not loaded: ` +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      }
    }
  }

  // a draft always wins over the version — it is the newer work
  if (survey.draft_definition) {
    const draft = SurveyDefinition.safeParse(survey.draft_definition);
    if (draft.success) {
      definition = draft.data;
      draftSavedAt = (survey.draft_updated_at as string) ?? null;
    }
  }

  if (loadError) {
    return (
      <div className="dash">
        <h1>This survey could not be opened safely</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{loadError}</div>
        <p className="muted" style={{ marginTop: 12 }}>
          Opening it as a blank survey would risk overwriting the stored questionnaire on the next
          save, so the editor has stopped instead.
        </p>
        <a className="btn" href="/">← back to surveys</a>
      </div>
    );
  }

  return (
    <Studio
      definition={definition}
      surveyDbId={String(survey.id)}
      versionId={versionId}
      draftSavedAt={draftSavedAt}
    />
  );
}
