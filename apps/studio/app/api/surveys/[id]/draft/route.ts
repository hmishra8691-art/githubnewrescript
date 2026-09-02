import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";

export const dynamic = "force-dynamic";

/**
 * The Studio's autosave endpoint.
 *
 * Every edit lands here within a second. It writes `surveys.draft_definition`
 * — never a `survey_versions` row — so the editor stops losing work without
 * turning every keystroke into a publishable version, and without making
 * versions mutable (a deployed version must never change under a respondent).
 *
 * PUT  save the draft            GET  read it back      DELETE  discard it
 */

/** Draft columns only exist after migration 0003. */
function migrationMissing(message: string): boolean {
  return /column .*draft_definition.* does not exist|could not find the 'draft/i.test(message);
}

const NEEDS_MIGRATION =
  "Autosave needs supabase/migrations/0003_draft_definitions.sql applied. Your work is safe — use Save version until then.";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null);
  if (!body?.definition) {
    return NextResponse.json({ error: "definition required" }, { status: 400 });
  }

  // Validate before storing. A draft that cannot be parsed is worse than no
  // draft at all: the editor would load it, fail, and fall back to a blank
  // survey — which is how a definition gets overwritten with nothing.
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

  const db = supabaseAdmin();
  const { error } = await db
    .from("surveys")
    .update({
      draft_definition: parsed.data,
      draft_updated_at: new Date().toISOString(),
      draft_base_version_id: body.baseVersionId ?? null,
      // keep the listing's title in step with the draft
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
  return NextResponse.json({ ok: true, savedAt: new Date().toISOString() });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
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
  return NextResponse.json(data);
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
