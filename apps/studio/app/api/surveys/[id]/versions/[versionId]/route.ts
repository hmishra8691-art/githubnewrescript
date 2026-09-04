import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

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
    detail: { survey_id: params.id },
  });
  return NextResponse.json({ ok: true, revision });
}
