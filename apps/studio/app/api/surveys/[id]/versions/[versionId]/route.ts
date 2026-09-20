import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { nextVersion } from "@rescript/engine";
import { shouldSnapshotDraft } from "@/lib/draftSnapshot";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; versionId: string } },
) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("survey_versions")
    .select("id, version, definition, label, notes, created_at")
    .eq("survey_id", params.id)
    .eq("id", params.versionId)
    .single();
  if (error || !data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ version: data });
}

/** Restore: make this version the current one (definition returned for editing). */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; versionId: string } },
) {
  const gate = await requireEditRight(req, params.id, "survey.save_version");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("survey_versions")
    .select("id")
    .eq("survey_id", params.id)
    .eq("id", params.versionId)
    .single();
  if (error || !data) return NextResponse.json({ error: "not found" }, { status: 404 });

  /*
   * R6 — THE DRAFT IS SNAPSHOTTED BEFORE IT IS DESTROYED.
   *
   * Clearing the draft is correct (see below) and it is also, for whoever
   * wrote that draft, the irreversible destruction of an afternoon's work
   * behind a button labelled "restore". The two facts are both true, and the
   * resolution is not to stop clearing it — it is to make sure it still
   * exists somewhere afterwards.
   *
   * So an unsaved draft is cut as a version of its own first, labelled for
   * what it is. That turns "your work is gone" into "your work is version
   * 3.4, called 'Autosaved before restore'", which is a support conversation
   * instead of an incident.
   *
   * Only when there IS a draft, and only when it differs from the version
   * being restored — otherwise every restore would litter the version list
   * with snapshots of nothing.
   */
  let savedDraftAs: string | null = null;
  const { data: survey } = await db
    .from("surveys")
    .select("draft_definition, current_version_id")
    .eq("id", params.id)
    .maybeSingle();

  const draft = survey?.draft_definition ?? null;
  if (draft && typeof draft === "object") {
    try {
      const { data: target } = await db
        .from("survey_versions").select("definition").eq("id", data.id).single();
      if (shouldSnapshotDraft(draft, target?.definition ?? null)) {
        const { data: taken } = await db
          .from("survey_versions").select("version").eq("survey_id", params.id);
        const version = nextVersion((taken ?? []).map((r) => r.version as string));
        const snapshot = { ...(draft as Record<string, unknown>) };
        if (snapshot.meta && typeof snapshot.meta === "object") {
          snapshot.meta = { ...(snapshot.meta as Record<string, unknown>), version };
        }
        const { error: snapErr } = await db.from("survey_versions").insert({
          survey_id: params.id,
          version,
          definition: snapshot,
          label: "Autosaved before restore",
          notes:
            "Cut automatically because restoring a version clears the working draft. "
            + "This is what the draft held at that moment; restore this version to get it back.",
          created_by: gate.user.userId,
        });
        /*
         * A failed snapshot must STOP the restore. Carrying on would clear
         * the draft having failed to preserve it, which is the exact
         * outcome this block exists to prevent — and the programmer would
         * have been told the restore succeeded.
         */
        if (snapErr) {
          return NextResponse.json({
            error:
              "Your unsaved draft could not be saved first, so nothing was restored — "
              + "restoring would have discarded it. Save a version manually, then restore. "
              + `(${snapErr.message})`,
          }, { status: 409 });
        }
        savedDraftAs = version;
      }
    } catch (e) {
      return NextResponse.json({
        error:
          "Your unsaved draft could not be saved first, so nothing was restored. "
          + `(${e instanceof Error ? e.message : String(e)})`,
      }, { status: 409 });
    }
  }

  /*
   * Restoring MUST clear the draft.
   *
   * A draft always wins over the current version when the editor loads. So
   * pointing the survey at an older version while leaving a newer draft in
   * place made restore look like it had done nothing: the page reopened on
   * the draft, and the restored version was nowhere. Clearing it is what
   * makes "Restore version 25" mean version 25.
   *
   * This is the one place that deliberately forces past the revision guard
   * (-1): the programmer explicitly asked for this version.
   */
  let revision: number | null = null;
  const rpc = await db.rpc("rescript_finalize_version", {
    p_survey_id: params.id,
    p_version_id: data.id,
    p_base_revision: -1,
  });
  if (!rpc.error) {
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    revision = row?.revision ?? null;
  } else {
    // migration 0004 not applied — do the same thing in two writes
    const cleared = await db
      .from("surveys")
      .update({
        current_version_id: data.id,
        draft_definition: null,
        draft_updated_at: null,
        draft_base_version_id: null,
      })
      .eq("id", params.id);
    if (cleared.error) {
      await db.from("surveys").update({ current_version_id: data.id }).eq("id", params.id);
    }
  }
  await db.from("audit_logs").insert({
    action: "survey.version.restore", entity: "survey_version", entity_id: data.id,
    detail: { survey_id: params.id, ...(savedDraftAs ? { draftSavedAsVersion: savedDraftAs } : {}) },
  });
  return NextResponse.json({ ok: true, revision, savedDraftAs });
}
