import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SURVEY_STATUSES, isSurveyStatus } from "@/lib/status";
import { audit, isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { purgeSurveyUploads, type StorageDb } from "@/lib/surveyUploads";

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
  /*
   * Read the name BEFORE the row goes: after the delete there is nothing left
   * to describe it with, and "someone deleted project 4f2c…" is not an audit
   * entry anybody can act on. `project.deleted` has been in the event
   * vocabulary since the collaboration wave; this is the first thing to emit
   * it — a hard delete of an entire project left no trace at all.
   */
  const { data: doomed } = await db
    .from("surveys").select("code, title").eq("id", params.id).maybeSingle();

  /*
   * Respondent-uploaded files (file/photo/signature/audio answers) live in
   * object storage keyed by response session id, not a `survey_id`-FK'd
   * table, so ON DELETE CASCADE below cannot reach them (see
   * lib/surveyUploads.ts). This must run BEFORE the RPC, while
   * `responses.session_id` still exists to key the bucket paths — and is
   * deliberately best-effort: storage cannot join the same transaction as
   * the database delete, so a storage hiccup is recorded for the audit log
   * but never blocks or fails the authoritative delete below.
   */
  /*
   * `db` (the real, fully-generic Supabase client) is cast through `unknown`
   * rather than passed directly: comparing its type — dozens of overloaded,
   * conditionally-typed methods — structurally against the small hand-written
   * `StorageDb` interface blows past TypeScript's instantiation depth limit
   * (TS2589). The unit tests in surveyUploads.test.ts already exercise this
   * exact shape against the real function, so the cast is a formality, not a
   * loss of safety.
   */
  const { warnings: storageWarnings } = await purgeSurveyUploads(db as unknown as StorageDb, params.id);

  /*
   * One RPC, one statement from here: clearing the self-referencing
   * current_version_id and deleting the row now commit or fail together
   * (supabase/migrations/0020_delete_project_transaction.sql), rather than
   * being two independent calls with the first one's error discarded.
   */
  const { data: deleted, error } = await db.rpc("rescript_delete_project", { p_survey_id: params.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  await audit({
    action: "project.deleted", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: null, customerId: gate.user.customerId,
    entity: "survey", entityId: params.id,
    detail: {
      code: doomed?.code ?? null, title: doomed?.title ?? null,
      ...(storageWarnings.length ? { storageWarnings } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}
