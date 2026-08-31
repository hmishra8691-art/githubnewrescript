import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data: survey, error } = await db
    .from("surveys")
    .select("id, code, title, status, current_version_id, created_at, updated_at")
    .eq("id", params.id)
    .single();
  if (error || !survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: version } = survey.current_version_id
    ? await db.from("survey_versions").select("id, version, definition, label, created_at")
        .eq("id", survey.current_version_id).single()
    : { data: null };

  const { data: deployments } = await db
    .from("deployments")
    .select("id, client_slug, study_slug, mode, active, version_id, created_at")
    .eq("survey_id", params.id);

  return NextResponse.json({ survey, version, deployments: deployments ?? [] });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  await db.from("surveys").update({ current_version_id: null }).eq("id", params.id);
  const { error } = await db.from("surveys").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
