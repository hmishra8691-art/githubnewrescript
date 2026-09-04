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

  /*
   * The revision the editor is working on top of, when it can tell us.
   *
   * Cutting a version is explicit intent — but intent about the state THIS
   * editor is holding. It was never meant to overwrite work the editor has
   * not seen, and forcing past the revision guard unconditionally is how an
   * hours-old tab's definition became a survey's current version. So the
   * guard is applied when the client supplies a revision, and only falls back
   * to forcing (-1) when it cannot: the sandbox, or a build that predates
   * this field.
   */
  const baseRevision = Number.isFinite(body?.baseRevision) ? Number(body.baseRevision) : null;

  // cheap pre-check, so the common stale case does not create an orphan
  // snapshot at all; the RPC below is what actually guarantees it
  if (baseRevision !== null) {
    const { data: cur } = await db.from("surveys").select("revision").eq("id", params.id).maybeSingle();
    if (cur && typeof cur.revision === "number" && cur.revision !== baseRevision) {
      console.warn("[rescript:version] REFUSED stale cut", JSON.stringify({ surveyId: params.id, baseRevision, serverRevision: cur.revision }));
      return NextResponse.json({
        error:
          "This survey was changed elsewhere after your editor loaded it, so no version was cut — " +
          "saving would have replaced that newer work with this editor's older state.",
        conflict: true,
        revision: cur.revision,
      }, { status: 409 });
    }
  }

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
  /*
   * Prefer the guarded RPC (migration 0004): it points the survey at the new
   * version, clears the draft and bumps the revision in ONE statement, and
   * returns the new revision so the editor keeps writing on top of the right
   * one instead of conflicting with itself on its next keystroke.
   *
   * Cutting a version is explicit intent, so it forces past the revision
   * guard (-1) rather than failing on a draft written moments earlier.
   */
  let newRevision: number | null = null;
  const rpc = await db.rpc("rescript_finalize_version", {
    p_survey_id: params.id,
    p_version_id: ver.id,
    p_base_revision: baseRevision ?? -1,
  });
  if (!rpc.error) {
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    /*
     * The guarded call matched nothing: the revision moved between the
     * pre-check and now. The survey is NOT pointed at the row we just
     * inserted, so that row is an orphan snapshot — remove it rather than
     * leave a version in the panel that nothing ever used.
     */
    if (!row && baseRevision !== null) {
      await db.from("survey_versions").delete().eq("id", ver.id);
      const { data: cur } = await db.from("surveys").select("revision").eq("id", params.id).maybeSingle();
      console.warn("[rescript:version] REFUSED stale cut (race)", JSON.stringify({ surveyId: params.id, baseRevision, serverRevision: cur?.revision ?? null, discardedVersion: version }));
      return NextResponse.json({
        error:
          "This survey was changed elsewhere while your version was being written, so no version was cut. " +
          "Reload to pick up the newer work.",
        conflict: true,
        revision: cur?.revision ?? null,
      }, { status: 409 });
    }
    newRevision = row?.revision ?? null;
    console.info("[rescript:version] cut", JSON.stringify({ surveyId: params.id, versionId: ver.id, version, baseRevision, newRevision, questions: def.questions.length }));
    await db.from("surveys").update({ title: def.meta.title }).eq("id", params.id);
  }

  const { error: pointerError } = newRevision !== null
    ? { error: null }
    : await db
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
  return NextResponse.json({
    id: ver.id, version: ver.version, variables: def.variables.length, revision: newRevision,
  });
}
