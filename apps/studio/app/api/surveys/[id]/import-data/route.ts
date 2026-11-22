import { NextRequest, NextResponse } from "next/server";
import { legacyTableFrom, planDataMigration, migrateResponses } from "@rescript/import";
import { isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition } from "@/lib/qualityDef";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DATA MIGRATION PREVIEW (I4, 2026-11-29).
 *
 * POST multipart { file } — a legacy CSV / Excel of responses (optionally with a codebook sheet). Answers with the
 * variable map onto this survey's draft, the value recoding, the columns and values that matched nothing, the
 * weight column, a sample of the migrated answers, and the reconciliation of every mapped variable.
 *
 * It writes nothing. Storing migrated responses waits on one decision that is not the code's to make: whether a
 * migrated response counts as a complete for billing and quotas. Until then the preview is the deliverable.
 */
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Expected a multipart form with a file." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach the legacy data file as “file”." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `The file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB.` }, { status: 413 });
  const loaded = await loadQualityDefinition(gate.db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const table = await legacyTableFrom(new Uint8Array(await file.arrayBuffer()), file.name);
  if ("error" in table) return NextResponse.json({ error: table.error }, { status: 422 });
  const plan = planDataMigration(loaded.def, table);
  const result = migrateResponses(loaded.def, table, plan);
  return NextResponse.json({
    plan, summary: result.summary, reconciliation: result.reconciliation,
    sample: result.rows.slice(0, 20), rowsWithLostValues: result.rows.filter((r) => r.lost.length).slice(0, 50).map((r) => ({ externalId: r.externalId, lost: r.lost })),
    writes: "none — a preview; storing migrated responses waits on the billing decision for migrated completes",
  }, { headers: { "cache-control": "no-store" } });
}
