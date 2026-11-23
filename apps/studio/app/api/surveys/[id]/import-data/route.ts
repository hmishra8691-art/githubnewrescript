import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { legacyTableFrom, planDataMigration, migrateResponses, migrationRows } from "@rescript/import";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { getMeter, projectContext } from "@/lib/metering";
import { parseEnvironment } from "@/lib/responseData";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * DATA MIGRATION (I4): legacy responses from another platform, into this survey.
 *
 * POST multipart { file, environment?: TEST | LIVE }                       PREVIEW — writes nothing
 *   the variable map onto this survey's current version, the value recoding, the columns and values that matched
 *   nothing, the weight column, a sample of the migrated answers, the reconciliation of every mapped variable, the
 *   price, and a batch id for the commit.
 *
 * POST multipart { file, environment, commit: "1", batch, expectedRows }   COMMIT
 *   the same file mapped again (never the client's copy of the rows), checked against the preview's row count,
 *   charged and stored in one transaction (rescript_migrate_responses, migration 0116). A batch id can be stored
 *   once, so a retried request does not store the file twice or charge twice.
 *
 * Decision (2026-11-23): a migrated response is data, not an interview — billed per response
 * (SURVEY_RESPONSE_IMPORTED, $0.002 by default), never as a complete, and left out of quota counts. TEST follows the
 * billing configuration's TEST policy (free by default).
 */
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MISSING_0116 = "Storing migrated responses needs migration 0116 (rescript_migrate_responses), which has not been applied to this database.";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Expected a multipart form with a file." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach the legacy data file as “file”." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `The file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB.` }, { status: 413 });
  const commit = form.get("commit") === "1";
  const environment = parseEnvironment(String(form.get("environment") ?? "LIVE"));
  if (environment !== "TEST" && environment !== "LIVE") return NextResponse.json({ error: "environment must be TEST or LIVE — migrated responses land in one dataset" }, { status: 400 });

  /* the current version: migrated rows are stamped with it and read through it, so they are mapped onto it too */
  const loaded = await loadQualityDefinition(gate.db, params.id, "version");
  if (!("def" in loaded)) {
    return NextResponse.json({ error: loaded.status === 404 ? "Save a version of the questionnaire first: migrated responses are mapped onto, and stored under, the current version." : loaded.error }, { status: loaded.status === 404 ? 409 : loaded.status });
  }
  const table = await legacyTableFrom(new Uint8Array(await file.arrayBuffer()), file.name);
  if ("error" in table) return NextResponse.json({ error: table.error }, { status: 422 });
  if (table.rows.length > MAX_ROWS) return NextResponse.json({ error: `The file has ${table.rows.length.toLocaleString("en")} rows — at most ${MAX_ROWS.toLocaleString("en")} per batch. Split it and migrate each part.` }, { status: 413 });
  const plan = planDataMigration(loaded.def, table);
  const result = migrateResponses(loaded.def, table, plan);
  const rows = migrationRows(result);

  const meter = getMeter();
  const ctx = projectContext(gate, environment);
  const spec = { eventType: "SURVEY_RESPONSE_IMPORTED", provider: "rescript", service: "runtime", model: "response_imported", quantity: rows.length, unit: "response", metadata: { operation: "data_migration", file: file.name.slice(0, 120), rows: rows.length } };
  const quote = await meter.estimate(ctx, spec).then((b) => ({ amount: b.customerCharge, perResponse: rows.length ? Math.round((b.customerCharge / rows.length) * 1e6) / 1e6 : 0, environment, testAdjustment: b.testAdjustment })).catch(() => null);

  if (!commit) {
    return NextResponse.json({
      plan, summary: result.summary, reconciliation: result.reconciliation,
      sample: result.rows.slice(0, 20), rowsWithLostValues: result.rows.filter((r) => r.lost.length).slice(0, 50).map((r) => ({ externalId: r.externalId, lost: r.lost })),
      version: loaded.version, rows: rows.length, quote,
      batch: randomBytes(12).toString("base64url"),
      writes: "none — a preview. Commit with the same file, this batch id and expectedRows to store the responses.",
    }, { headers: { "cache-control": "no-store" } });
  }

  /* ------------------------------------------------------------------ commit */
  const batch = String(form.get("batch") ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(batch)) return NextResponse.json({ error: "Commit with the batch id the preview returned." }, { status: 400 });
  const expected = Number(form.get("expectedRows"));
  if (!Number.isFinite(expected) || expected !== rows.length) return NextResponse.json({ error: `The preview had ${Number.isFinite(expected) ? expected : "?"} rows and this file maps to ${rows.length}. Preview the file again.`, code: "rows_changed" }, { status: 409 });
  if (!rows.length) return NextResponse.json({ error: "The file has no rows to migrate." }, { status: 400 });
  if (!plan.columns.length) return NextResponse.json({ error: "No column of the file matched a question of this survey — nothing would be stored." }, { status: 422 });
  if (!loaded.versionId) return NextResponse.json({ error: "Save a version of the questionnaire first." }, { status: 409 });

  const hold = await meter.reserve(ctx, spec).catch((e) => ({ ok: false as const, reason: "store_error", message: (e as Error).message }));
  if (!hold.ok) return NextResponse.json({ error: hold.message, code: hold.reason === "insufficient_balance" ? "insufficient_balance" : "billing_refused" }, { status: 402 });
  const { data, error } = await gate.db.rpc("rescript_migrate_responses", {
    p_survey: params.id, p_version: loaded.versionId, p_test: environment === "TEST", p_batch: batch, p_rows: rows, p_by: gate.user.userId,
  });
  if (error) {
    await meter.release(hold).catch(() => {});
    if (/MIGRATION_BATCH_EXISTS/.test(error.message)) return NextResponse.json({ error: "This batch is already stored (the request was sent twice). Nothing was charged again.", code: "batch_exists" }, { status: 409 });
    if (/rescript_migrate_responses|does not exist|schema cache|responses_source_check/i.test(error.message)) return NextResponse.json({ error: MISSING_0116, code: "migration_required" }, { status: 503 });
    return NextResponse.json({ error: `Nothing was stored: ${error.message}` }, { status: 500 });
  }
  const event = await meter.settle(hold, { quantity: rows.length, metadata: { batch } }).catch((e) => { console.error("[rescript:billing] migration stored but not settled", JSON.stringify({ surveyId: params.id, batch, error: (e as Error).message })); return null; });
  await audit({
    action: "responses.imported", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId,
    entity: "survey", entityId: params.id,
    detail: { kind: "migration", batch, rows: rows.length, environment, file: file.name.slice(0, 120), version: loaded.version, charged: event?.customerCharge ?? null },
  });
  return NextResponse.json({ ok: true, stored: (data as { created?: number } | null)?.created ?? rows.length, batch, environment, charged: event ? { amount: event.customerCharge } : null, quotas: "not counted — migrated responses are left out of quota counts" });
}
