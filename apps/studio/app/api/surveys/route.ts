import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { newSurveyDefinition } from "@/lib/defaults";
import { SurveyDefinition } from "@rescript/schema";

export const dynamic = "force-dynamic";

async function defaultCustomerId() {
  const db = supabaseAdmin();
  const { data } = await db.from("customers").select("id").eq("slug", "default").maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await db
    .from("customers")
    .insert({ slug: "default", name: "Default Workspace" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id;
}

export async function GET() {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("surveys")
    .select("id, code, title, status, created_at, updated_at, current_version_id")
    .order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ surveys: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "Untitled survey").slice(0, 200);
  const code = String(body.code ?? `SURVEY_${Date.now().toString(36).toUpperCase()}`).slice(0, 60);
  const db = supabaseAdmin();
  const customerId = await defaultCustomerId();

  const { data: survey, error } = await db
    .from("surveys")
    .insert({ customer_id: customerId, code, title })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // definition: from template payload or blank
  let definition = newSurveyDefinition(survey.id, code, title);
  if (body.definition) {
    const parsed = SurveyDefinition.safeParse({
      ...body.definition,
      meta: { ...body.definition.meta, id: survey.id, code, title, version: "1.0" },
    });
    if (parsed.success) definition = parsed.data;
  }

  // Derive a unique default URL slug from the survey code, so every new survey
  // gets its own /s/<client>/<study> and the Test button never collides.
  const slug =
    code.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "study";
  definition.deployment.studySlug = slug;

  const { data: ver, error: verr } = await db
    .from("survey_versions")
    .insert({ survey_id: survey.id, version: "1.0", definition, label: "Initial version" })
    .select("id")
    .single();
  if (verr) return NextResponse.json({ error: verr.message }, { status: 500 });

  await db.from("surveys").update({ current_version_id: ver.id }).eq("id", survey.id);
  await db.from("audit_logs").insert({
    customer_id: customerId, action: "survey.create", entity: "survey", entity_id: survey.id,
    detail: { code, title },
  });
  return NextResponse.json({ id: survey.id });
}
