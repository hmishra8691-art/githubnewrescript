import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "@rescript/engine";

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
  const version = String(body.version ?? def.meta.version ?? "1.0");
  def.meta.version = version;

  const { data: ver, error } = await db
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
  if (error) {
    const msg = error.message.includes("duplicate")
      ? `Version ${version} already exists — bump the version number.`
      : error.message;
    return NextResponse.json({ error: msg }, { status: 409 });
  }

  await db.from("surveys").update({ current_version_id: ver.id, title: def.meta.title }).eq("id", params.id);
  await db.from("audit_logs").insert({
    action: "survey.version.save", entity: "survey_version", entity_id: ver.id,
    detail: { survey_id: params.id, version, label: body.label ?? null },
  });
  return NextResponse.json({ id: ver.id, version: ver.version, variables: def.variables.length });
}
