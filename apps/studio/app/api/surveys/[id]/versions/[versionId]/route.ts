import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; versionId: string } },
) {
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
  _req: NextRequest,
  { params }: { params: { id: string; versionId: string } },
) {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("survey_versions")
    .select("id")
    .eq("survey_id", params.id)
    .eq("id", params.versionId)
    .single();
  if (error || !data) return NextResponse.json({ error: "not found" }, { status: 404 });
  await db.from("surveys").update({ current_version_id: data.id }).eq("id", params.id);
  return NextResponse.json({ ok: true });
}
