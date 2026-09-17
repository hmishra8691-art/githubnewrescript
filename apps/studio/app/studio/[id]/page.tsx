import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { newSurveyDefinition } from "@/lib/defaults";
import { Studio } from "@/components/studio/Studio";
import { ensureElementIds, migrateRetiredVariants } from "@rescript/engine";
import { projectPageGate } from "@/lib/guard";
import { SESSION_COOKIE_NAME } from "@/lib/authServer";

export const dynamic = "force-dynamic";

/**
 * AUTHORIZE FIRST. This page is the only server component in the Studio that
 * reads data, and it used to read it with the service-role client and no gate
 * at all — so any signed-in user, from any workspace, could open
 * `/studio/<uuid>` and be served the whole questionnaire, logic, quotas and
 * unsaved draft of a project they hold no role on. The middleware cannot
 * cover this: at the edge there is no database, so it can only see that a
 * cookie exists.
 *
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
  const gate = await projectPageGate(
    cookies().get(SESSION_COOKIE_NAME)?.value ?? null,
    params.id,
    "project.read",
  );
  if (!gate.ok) {
    if (gate.kind === "signed_out") {
      redirect(`/login?next=${encodeURIComponent(`/studio/${params.id}`)}`);
    }
    /*
     * "Not found" and "not yours" read identically on purpose — the same
     * answer `requireProject` gives an outsider over the API. On an
     * installation shared by several agencies, the existence of a study is
     * itself confidential.
     */
    return (
      <div className="dash">
        <h1>{gate.kind === "unknown" ? "Survey not found" : "You cannot open this project"}</h1>
        {gate.kind === "forbidden" && (
          <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{gate.message}</div>
        )}
        <a className="btn" href="/">← back to surveys</a>
      </div>
    );
  }

  const db = supabaseAdmin();

  // draft columns only exist after migration 0003 — ask for them, but survive
  // their absence
  let survey: Record<string, unknown> | null = null;
  const withDraft = await db
    .from("surveys")
    .select("id, code, title, current_version_id, draft_definition, draft_updated_at, revision")
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
        /*
         * Element ids presented on read, for the same reason as the runtime:
         * a version cut before ids existed is frozen and can never be
         * rewritten. Deterministic, so the editor and the runtime agree about
         * what every element is called.
         */
        definition = migrateRetiredVariants(ensureElementIds(parsed.data).def).def;
        versionId = ver.id;
      } else {
        loadError =
          `The saved definition for version ${survey.current_version_id} does not match the current schema and was not loaded: ` +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      }
    }
  }

  /*
   * A draft always wins over the version — it is the newer work.
   *
   * If it will not parse, the editor STOPS. It used to fall through to the
   * older version without a word, which is the single worst thing this code
   * could do: the programmer sees their recent work missing, edits on top of
   * the older structure, and the next autosave writes that older structure
   * over the draft that still held the real thing. Refusing to open is
   * recoverable; silently reverting is not.
   */
  if (survey.draft_definition) {
    const draft = SurveyDefinition.safeParse(survey.draft_definition);
    if (draft.success) {
      /*
       * `migrateRetiredVariants` on the way in, beside the element-id
       * backfill and for the same reason: a definition written before a
       * variant was retired keeps resolving through `supersededBy`, and this
       * is where the stored id catches up with it. A survey holding none is
       * untouched.
       */
      definition = migrateRetiredVariants(ensureElementIds(draft.data).def).def;
      draftSavedAt = (survey.draft_updated_at as string) ?? null;
    } else {
      loadError =
        "This survey has autosaved work that does not match the current schema, so it was NOT loaded — " +
        "and the editor has stopped rather than showing you the older saved version as if it were current. " +
        "The draft is still in the database, untouched. " +
        draft.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }
  }

  if (loadError) {
    return (
      <div className="dash">
        <h1>This survey could not be opened safely</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{loadError}</div>
        <p className="muted" style={{ marginTop: 12 }}>
          Opening it anyway would risk overwriting the stored questionnaire on the next
          autosave, so the editor has stopped instead. Nothing has been changed or deleted.
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
      revision={typeof survey.revision === "number" ? survey.revision : null}
    />
  );
}
