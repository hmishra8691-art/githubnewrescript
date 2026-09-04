import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SURVEY_STATUSES, isSurveyStatus } from "@/lib/status";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

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

/** Change the project's lifecycle status (see lib/status.ts). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const status = String(body.status ?? "");
  if (!isSurveyStatus(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${SURVEY_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  const db = supabaseAdmin();
  const { data: survey } = await db
    .from("surveys")
    .select("id, customer_id, status")
    .eq("id", params.id)
    .single();
  if (!survey) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { error } = await db
    .from("surveys")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", params.id);
  if (error) {
    // the check constraint rejects paused/archived until migration 0002 runs
    return NextResponse.json(
      {
        error: /violates check constraint/i.test(error.message)
          ? `“${status}” needs supabase/migrations/0002_dashboard_stats.sql applied first.`
          : error.message,
      },
      { status: 400 },
    );
  }
  await db.from("audit_logs").insert({
    customer_id: survey.customer_id,
    action: "survey.status",
    entity: "survey",
    entity_id: params.id,
    detail: { from: survey.status, to: status },
  });
  return NextResponse.json({ ok: true, status });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.delete");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  await db.from("surveys").update({ current_version_id: null }).eq("id", params.id);
  const { error } = await db.from("surveys").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
