import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { QualityConfig } from "@rescript/schema";
import { BUILTIN_PROFILES } from "@rescript/quality";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Quality profiles: the built-in presets plus the customer's saved ones.
 * Saving copies the survey's current config under a name; applying (in the
 * Studio) copies a profile's config into the survey — profiles never change a
 * survey after the fact.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  const customerId = "def" in loaded ? loaded.customerId : null;
  let saved: any[] = [];
  const q = db.from("quality_profiles").select("id, name, description, config, updated_at").order("name");
  const { data, error } = customerId ? await q.eq("customer_id", customerId) : await q.is("customer_id", null);
  if (error && !missingMigration(error.message)) return NextResponse.json({ error: error.message }, { status: 500 });
  saved = data ?? [];
  return NextResponse.json({
    builtin: BUILTIN_PROFILES,
    saved: saved.map((p) => ({ id: p.id, name: p.name, description: p.description, config: p.config, updatedAt: p.updated_at })),
    migrationMissing: !!error,
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const name = String(body?.name ?? "").trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const parsed = QualityConfig.safeParse(body?.config ?? {});
  if (!parsed.success) return NextResponse.json({ error: "config invalid", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  const customerId = "def" in loaded ? loaded.customerId : null;
  const { data, error } = await db.from("quality_profiles")
    .upsert({ customer_id: customerId, name, description: typeof body?.description === "string" ? body.description.slice(0, 500) : null, config: parsed.data }, { onConflict: "customer_id,name" })
    .select("id, name, description, config, updated_at").single();
  if (error) {
    if (missingMigration(error.message)) return NextResponse.json({ error: "apply migration 0005", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, profile: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  const id = req.nextUrl.searchParams.get("profileId");
  if (!id) return NextResponse.json({ error: "profileId required" }, { status: 400 });
  const db = supabaseAdmin();

  /*
   * Scoped to the caller's own workspace. This used to delete by id alone,
   * which — now that there are accounts — would let anyone with edit rights on
   * any project delete another company's saved profile by guessing its id. The
   * filter is the fix; a row outside the workspace simply is not found.
   */
  let q = db.from("quality_profiles").delete().eq("id", id);
  q = gate.user.customerId ? q.eq("customer_id", gate.user.customerId) : q.is("customer_id", null);
  const { data, error } = await q.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "Unknown profile." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
