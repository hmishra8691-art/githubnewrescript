import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { flattenVariables, rowToState, validateQuestion } from "@rescript/engine";
import { missingResponseMigration, RESPONSE_MIGRATION_MESSAGE } from "@/lib/responseData";
import { recountQuotas } from "@/lib/quotaRecount";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * One response: read it, edit it, delete it.
 *
 *   GET     the response, its exported variables, and its audit trail
 *   PATCH   { answers: {...}, expectedRevision, by?, reason? } — a validated
 *           edit, refused when the row moved on (optimistic concurrency)
 *   DELETE  ?reason=  — SOFT delete: the row leaves every dataset, the audit
 *           trail keeps it, and it can be restored. Permanent removal is a
 *           separate administrative action (`?purge=1` on an already-deleted
 *           row).
 *
 * Every answer is validated against the survey's own question schema before
 * it is stored — the same `validateQuestion` the runtime uses, so an edit can
 * never put a value in the database that the survey itself would reject.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string; responseId: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });

  const { data: row, error } = await db
    .from("responses")
    .select("id, session_id, respondent_code, respondent_id, status, is_test, environment, revision, source, answers, calculated, embedded, flags, seed, started_at, completed_at, updated_at, deleted_at, deleted_by, deletion_reason, quality, review_status")
    .eq("survey_id", params.id)
    .eq("id", params.responseId)
    .maybeSingle();
  if (error) {
    if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: edits } = await db
    .from("response_edits")
    .select("action, changes, reason, edited_by, edited_at, revision_before, revision_after")
    .eq("response_id", row.id)
    .order("edited_at", { ascending: false })
    .limit(100);

  return NextResponse.json({
    response: {
      id: row.id, respondentCode: row.respondent_code, sessionId: row.session_id, respondentId: row.respondent_id,
      status: row.status, environment: row.environment ?? (row.is_test ? "TEST" : "LIVE"),
      revision: row.revision ?? 0, source: row.source ?? "runtime",
      startedAt: row.started_at, completedAt: row.completed_at, updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? null, deletedBy: row.deleted_by ?? null, deletionReason: row.deletion_reason ?? null,
      answers: row.answers ?? {}, calculated: row.calculated ?? {}, embedded: row.embedded ?? {}, flags: row.flags ?? [],
      vars: flattenVariables(loaded.def, rowToState(loaded.def, row as never)),
      quality: row.quality ? { classification: row.quality.classification, qualityScore: row.quality.qualityScore, riskScore: row.quality.riskScore } : null,
      reviewStatus: row.review_status ?? null,
    },
    edits: edits ?? [],
  }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; responseId: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!body?.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
    return NextResponse.json({ error: "answers must be an object keyed by question id" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const def = loaded.def;

  const { data: row } = await db
    .from("responses")
    .select("id, session_id, respondent_code, respondent_id, status, is_test, revision, answers, calculated, embedded, flags, seed, started_at, deleted_at")
    .eq("survey_id", params.id).eq("id", params.responseId).maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.deleted_at) return NextResponse.json({ error: "this response is deleted — restore it before editing" }, { status: 409 });

  /*
   * Validate against the survey's own schema.
   *
   * The editor sends only the keys it changed, so the answers map is merged
   * onto the stored one and the MERGED state is validated: a rule that reads
   * another question (an exclusive option, a sum, a required-if) sees the
   * whole response as it will be stored, not the fragment.
   */
  const merged: Record<string, unknown> = { ...(row.answers ?? {}) };
  for (const [k, v] of Object.entries(body.answers)) {
    if (v === undefined || v === null || v === "") delete merged[k];
    else merged[k] = v;
  }
  const state = rowToState(def, { ...row, answers: merged } as never);
  const errors: { questionId: string; code: string; message: string }[] = [];
  const touched = new Set(Object.keys(body.answers).map((k) => k.split("@")[0].replace(/__(other|correct|passed|timeout|rt)$/, "")));
  for (const qid of touched) {
    const q = def.questions.find((x) => x.id === qid);
    if (!q) { errors.push({ questionId: qid, code: qid, message: "This question is not in the current survey definition." }); continue; }
    /*
     * `required` is a rule about ASKING, not about stored data: a legitimately
     * skipped or screened-out response has empty answers, and an editor that
     * refused to clear a value would make bad data uneditable. Everything
     * else — valid option codes, numeric ranges, list lengths, dates, grid
     * shape — is enforced exactly as the runtime enforces it.
     */
    const forEdit = { ...q, required: false } as typeof q;
    const errs = validateQuestion(def, forEdit, merged[qid], { def, state, loop: null });
    for (const e of errs) errors.push({ questionId: qid, code: q.code, message: e.message });
  }
  if (errors.length) return NextResponse.json({ error: "the edit was not saved because it is not valid for this survey", issues: errors }, { status: 422 });

  // what changed, for the audit trail
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(body.answers)) {
    const before = (row.answers ?? {})[k];
    const after = merged[k];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changes[k] = { from: before ?? null, to: after ?? null };
  }
  if (!Object.keys(changes).length) {
    return NextResponse.json({ ok: true, unchanged: true, revision: row.revision ?? 0 });
  }

  const expected = Number.isFinite(body?.expectedRevision) ? Number(body.expectedRevision) : null;
  const { data: res, error } = await db.rpc("rescript_update_response", {
    p_id: row.id,
    p_expected_revision: expected,
    p_answers: merged,
    p_calculated: null,
    p_changes: changes,
    p_by: gate.user.fullName || gate.user.userCode,
    p_reason: typeof body?.reason === "string" ? body.reason.slice(0, 1000) : null,
  });
  if (error) {
    if (/REVISION_CONFLICT/.test(error.message)) {
      const { data: cur } = await db.from("responses").select("revision, answers, updated_at").eq("id", row.id).maybeSingle();
      return NextResponse.json({
        error: "This response changed after your editor loaded it, so the edit was refused rather than overwriting that change.",
        conflict: true, revision: cur?.revision ?? null, answers: cur?.answers ?? null, updatedAt: cur?.updated_at ?? null,
      }, { status: 409 });
    }
    if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const out = Array.isArray(res) ? res[0] : res;

  // the dataset changed, so the quota counts for THIS environment are stale
  const quotas = await recountQuotas(db, def, params.id, !!row.is_test).catch(() => null);
  console.info("[rescript:data] edit", JSON.stringify({ surveyId: params.id, respondentCode: row.respondent_code, environment: row.is_test ? "TEST" : "LIVE", changed: Object.keys(changes), revision: out?.new_revision, quotasRecounted: !!quotas }));
  return NextResponse.json({
    ok: true, revision: out?.new_revision ?? null, updatedAt: out?.new_updated_at ?? null,
    changed: Object.keys(changes), vars: flattenVariables(def, state), quotas,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; responseId: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const purge = req.nextUrl.searchParams.get("purge") === "1";
  const restore = req.nextUrl.searchParams.get("restore") === "1";
  const reason = req.nextUrl.searchParams.get("reason");
  const by = gate.user.fullName || gate.user.userCode;

  const { data: row } = await db.from("responses").select("id, respondent_code, is_test, deleted_at").eq("survey_id", params.id).eq("id", params.responseId).maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fn = purge ? "rescript_purge_responses" : restore ? "rescript_restore_responses" : "rescript_soft_delete_responses";
  const args: Record<string, unknown> = { p_survey: params.id, p_ids: [row.id], p_by: by };
  if (!purge && !restore) args.p_reason = reason;
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (missingResponseMigration(error.message)) return NextResponse.json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const quotas = await recountQuotas(db, undefined, params.id, !!row.is_test).catch(() => null);
  console.info(`[rescript:data] ${purge ? "purge" : restore ? "restore" : "delete"}`, JSON.stringify({ surveyId: params.id, respondentCode: row.respondent_code, environment: row.is_test ? "TEST" : "LIVE", reason, by, affected: data }));
  return NextResponse.json({ ok: true, affected: typeof data === "number" ? data : 1, action: purge ? "purge" : restore ? "restore" : "delete", quotas });
}
