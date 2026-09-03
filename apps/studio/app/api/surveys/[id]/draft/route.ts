import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { droppedFieldPaths } from "@rescript/engine";

export const dynamic = "force-dynamic";

/**
 * The Studio's autosave endpoint.
 *
 * Every edit lands here within a second. It writes `surveys.draft_definition`
 * — never a `survey_versions` row — so the editor stops losing work without
 * turning every keystroke into a publishable version, and without making
 * versions mutable (a deployed version must never change under a respondent).
 *
 * WRITES ARE CONDITIONAL. The client sends the revision it last saw; the write
 * only lands while the row is still at that revision. An older request that
 * arrives after a newer one finds nothing to update and is REFUSED with 409,
 * carrying the server's current state so the client can reconcile. Before
 * this, the update was unconditional and the last request to reach the
 * database won — which is precisely how a slow save could bury newer work.
 *
 * PUT  save the draft            GET  read it back      DELETE  discard it
 */

/** Draft columns only exist after migration 0003. */
function migrationMissing(message: string): boolean {
  return /column .*draft_definition.* does not exist|could not find the 'draft/i.test(message);
}
/** The revision guard only exists after migration 0004. */
function guardMissing(message: string): boolean {
  return /rescript_save_draft|function .*does not exist|schema cache/i.test(message);
}

const NEEDS_MIGRATION =
  "Autosave needs supabase/migrations/0003_draft_definitions.sql applied. Your work is safe — use Save version until then.";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null);
  if (!body?.definition) {
    return NextResponse.json({ error: "definition required" }, { status: 400 });
  }

  // Validate before storing. A draft that cannot be parsed is worse than no
  // draft at all: the editor would load it, fail, and fall back to an older
  // definition — which is how newer work disappears.
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "draft failed validation and was not saved",
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 422 },
    );
  }

  /*
   * Zod strips keys it does not know. If the client is running a newer build
   * than this server, storing the parsed copy would silently drop the fields
   * the server has not learned about yet — a save that reports success while
   * losing data. Say so instead.
   *
   * This asks the question in one direction only — did anything we were sent
   * fail to survive — because comparing the two JSON strings flags a default
   * the schema ADDED (an editor one build behind is missing exactly those
   * keys) and flags a key the editor's spread put in a different position.
   * Both were reported as data loss while the data was being stored fine.
   * See droppedFieldPaths.
   */
  const dropped = droppedFieldPaths(body.definition, parsed.data);
  const droppedFields = dropped.length > 0 ? dropped : undefined;

  const db = supabaseAdmin();
  const baseRevision = Number.isFinite(body?.baseRevision) ? Number(body.baseRevision) : null;

  if (baseRevision !== null) {
    const { data, error } = await db.rpc("rescript_save_draft", {
      p_survey_id: params.id,
      p_definition: parsed.data,
      p_base_revision: baseRevision,
      p_base_version_id: body.baseVersionId ?? null,
      p_title: parsed.data.meta.title,
    });

    if (error && !guardMissing(error.message)) {
      return NextResponse.json(
        { error: migrationMissing(error.message) ? NEEDS_MIGRATION : error.message },
        { status: migrationMissing(error.message) ? 501 : 500 },
      );
    }

    if (!error) {
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        // No row matched: the survey moved on since this client last read it.
        // Hand back what the server actually holds so the editor can decide,
        // rather than letting either side guess.
        const { data: cur } = await db
          .from("surveys")
          .select("revision, draft_definition, draft_updated_at, current_version_id")
          .eq("id", params.id)
          .single();
        console.warn("[rescript:draft] REFUSED stale write", JSON.stringify({ surveyId: params.id, baseRevision, serverRevision: cur?.revision ?? null }));
        return NextResponse.json(
          {
            error:
              "This survey was changed somewhere else after your editor last loaded it, " +
              "so this save was refused rather than overwriting that work.",
            conflict: true,
            revision: cur?.revision ?? null,
            serverDraft: cur?.draft_definition ?? null,
            serverSavedAt: cur?.draft_updated_at ?? null,
            currentVersionId: cur?.current_version_id ?? null,
          },
          { status: 409 },
        );
      }
      console.info("[rescript:draft] saved", JSON.stringify({ surveyId: params.id, baseRevision, newRevision: row.revision, dropped: dropped.length }));
      return NextResponse.json({
        ok: true,
        savedAt: row.draft_updated_at ?? new Date().toISOString(),
        revision: row.revision,
        droppedFields,
      });
    }
    // fall through: migration 0004 is not applied yet
  }

  /*
   * Unguarded path — only reached when migration 0004 has not been applied, or
   * the client did not send a revision. It behaves as before, and says
   * plainly that stale-write protection is off rather than implying safety.
   */
  const { error } = await db
    .from("surveys")
    .update({
      draft_definition: parsed.data,
      draft_updated_at: new Date().toISOString(),
      draft_base_version_id: body.baseVersionId ?? null,
      title: parsed.data.meta.title,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (error) {
    return NextResponse.json(
      { error: migrationMissing(error.message) ? NEEDS_MIGRATION : error.message },
      { status: migrationMissing(error.message) ? 501 : 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    savedAt: new Date().toISOString(),
    revision: null,
    unguarded: true,
    droppedFields,
  });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const full = await db
    .from("surveys")
    .select("draft_definition, draft_updated_at, draft_base_version_id, current_version_id, revision")
    .eq("id", params.id)
    .single();
  if (!full.error) return NextResponse.json(full.data);

  // migration 0004 not applied: answer without the revision rather than 500
  const { data, error } = await db
    .from("surveys")
    .select("draft_definition, draft_updated_at, draft_base_version_id, current_version_id")
    .eq("id", params.id)
    .single();
  if (error) {
    return NextResponse.json(
      { error: migrationMissing(error.message) ? NEEDS_MIGRATION : error.message },
      { status: migrationMissing(error.message) ? 501 : 500 },
    );
  }
  return NextResponse.json({ ...data, revision: null });
}

/** Discard the draft and fall back to the current version. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { error } = await db
    .from("surveys")
    .update({ draft_definition: null, draft_updated_at: null, draft_base_version_id: null })
    .eq("id", params.id);
  if (error) {
    return NextResponse.json(
      { error: migrationMissing(error.message) ? NEEDS_MIGRATION : error.message },
      { status: migrationMissing(error.message) ? 501 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
