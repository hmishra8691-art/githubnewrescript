import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, nextVersion } from "@rescript/engine";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("survey_versions")
    .select("id, version, label, notes, created_at")
    .eq("survey_id", params.id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ versions: data });
}

/** Save a new version (requirement §12). Versions are immutable snapshots. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null);
  if (!body?.definition) return NextResponse.json({ error: "definition required" }, { status: 400 });

  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid definition", issues: parsed.error.issues.slice(0, 10) },
      { status: 422 },
    );
  }
  const def = parsed.data;
  // regenerate the dictionary so every saved version carries its exact variables
  def.variables = buildVariableDictionary(def);
  def.meta.updatedAt = new Date().toISOString();

  const db = supabaseAdmin();

  // The editor cannot know which versions exist (after restoring an older one
  // its number is behind), so the next version is resolved here, from storage.
  const { data: existingVersions } = await db
    .from("survey_versions")
    .select("version")
    .eq("survey_id", params.id);
  const taken = (existingVersions ?? []).map((r) => r.version as string);

  let version = nextVersion(taken, body.version ? String(body.version) : undefined);
  def.meta.version = version;

  // Retry on the unique constraint, in case a concurrent save took the number.
  // Matching on the constraint NAME rather than on the words in the message —
  // a driver that phrases "duplicate" differently used to turn a recoverable
  // collision into a 500 and silently drop the programmer's edit.
  const isVersionCollision = (msg?: string) =>
    !!msg && (/duplicate/i.test(msg) || /survey_versions_survey_id_version_key/i.test(msg) ||
              /unique constraint/i.test(msg) || /23505/.test(msg));

  let ver: { id: string; version: string } | null = null;
  for (let attempt = 0; attempt < 5 && !ver; attempt++) {
    const { data, error } = await db
      .from("survey_versions")
      .insert({
        survey_id: params.id,
        version,
        definition: def,
        label: body.label ?? null,
        notes: body.notes ?? null,
      })
      .select("id, version")
      .single();
    if (data) {
      ver = data;
      break;
    }
    if (!isVersionCollision(error?.message) || attempt === 4) {
      return NextResponse.json({ error: error?.message ?? "save failed" }, { status: 500 });
    }
    taken.push(version);
    version = nextVersion(taken);
    def.meta.version = version;
  }
  if (!ver) return NextResponse.json({ error: "save failed" }, { status: 500 });

  /**
   * Point the survey at the version just written, and CHECK IT.
   *
   * This update used to be fire-and-forget: if it failed, the version row
   * existed but the survey still pointed at the old one, the route returned
   * 200, and the Studio said "Saved". On reload the editor loaded the stale
   * pointer and the programmer's change had apparently vanished. Reporting the
   * failure is the difference between a visible error and lost work.
   *
   * The draft is cleared in the same breath: what was unsaved is now saved, so
   * leaving it behind would make the editor reopen on a draft identical to the
   * version while still showing "unsaved changes".
   */
  const { error: pointerError } = await db
    .from("surveys")
    .update({
      current_version_id: ver.id,
      title: def.meta.title,
      draft_definition: null,
      draft_updated_at: null,
      draft_base_version_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id);

  if (pointerError) {
    // Retry without the draft columns — they only exist after migration 0003,
    // and a missing column must not cost the programmer their save.
    const { error: retryError } = await db
      .from("surveys")
      .update({ current_version_id: ver.id, title: def.meta.title })
      .eq("id", params.id);
    if (retryError) {
      return NextResponse.json(
        {
          error: `Version ${ver.version} was written but the survey could not be pointed at it: ${retryError.message}`,
          versionId: ver.id,
          version: ver.version,
        },
        { status: 500 },
      );
    }
  }
  await db.from("audit_logs").insert({
    action: "survey.version.save", entity: "survey_version", entity_id: ver.id,
    detail: { survey_id: params.id, version, label: body.label ?? null },
  });
  return NextResponse.json({ id: ver.id, version: ver.version, variables: def.variables.length });
}
