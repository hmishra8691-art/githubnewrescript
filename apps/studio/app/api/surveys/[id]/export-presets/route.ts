import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { DataExportPreset } from "@rescript/schema";
import { BUILT_IN_EXPORT_PRESETS } from "@rescript/exporters";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * DATA EXPORT PRESETS (§44, phase 4).
 *
 * The saved settings a team delivers with. Workspace-scoped, so a tracker's
 * wave 6 exports exactly as wave 1 did and a new study starts from the house
 * standard rather than from whatever was last clicked — which is why the
 * rows live in `public.data_export_presets` keyed by customer and not on the
 * survey.
 *
 * WORKS BEFORE MIGRATION 0042 IS APPLIED. Every branch that touches the
 * table treats a missing relation as "no saved presets" rather than an
 * error, and says which migration is needed. The built-in presets are served
 * either way, so the feature is useful on day one and simply gains saving
 * when the migration runs. This mirrors what the responses export already
 * does for columns added by later migrations: a researcher who cannot
 * download their data because a migration is pending has lost the study.
 */

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

const MISSING_TABLE = /data_export_presets|does not exist|schema cache|relation/i;

/** The stored shape, validated on the way out as well as in. */
function parseStored(row: { id: string; name: string; description: string | null; config: unknown }) {
  const parsed = DataExportPreset.safeParse({
    ...(typeof row.config === "object" && row.config ? row.config : {}),
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
  });
  /*
   * A row an older build wrote must not be able to make this one export
   * something it did not mean to — an unrecognised format quietly becoming
   * CSV is exactly the kind of thing nobody notices until the client opens
   * it. An unparseable row is dropped from the list instead.
   */
  return parsed.success ? parsed.data : null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_export_presets")
    .select("id, name, description, config")
    .eq("customer_id", gate.user.customerId ?? "")
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (error) {
    if (MISSING_TABLE.test(error.message)) {
      return json({
        presets: BUILT_IN_EXPORT_PRESETS,
        saveable: false,
        note: "Saving your own export presets needs migration 0042. The built-in ones work now.",
      });
    }
    return bad(error.message, 500);
  }

  const saved = (data ?? []).map(parseStored).filter((p): p is NonNullable<typeof p> => !!p);
  return json({ presets: [...BUILT_IN_EXPORT_PRESETS, ...saved], saveable: true });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.export");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return bad("Expected a preset.");

  const name = String((body as any).name ?? "").trim();
  if (!name) return bad("A preset needs a name.");

  const parsed = DataExportPreset.safeParse({ ...(body as object), id: "pending", name });
  if (!parsed.success) {
    return bad(`That is not a usable export preset: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const { id: _ignored, name: _n, description, ...config } = parsed.data;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_export_presets")
    .insert({
      customer_id: gate.user.customerId,
      name,
      description: description ?? null,
      config,
      source_survey_id: params.id,
      created_by: gate.user.userId,
    })
    .select("id, name, description, config")
    .single();

  if (error) {
    if (MISSING_TABLE.test(error.message)) {
      return bad("Saving export presets needs migration 0042.", 503);
    }
    if (/duplicate|unique/i.test(error.message)) {
      return bad(`This workspace already has an export preset called “${name}”.`, 409);
    }
    return bad(error.message, 500);
  }

  await audit({
    action: "responses.export_preset_created", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "data_export_preset", entityId: data.id,
    detail: { name, config },
  });
  return json({ preset: parseStored(data) }, 201);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.export");
  if (isFailure(gate)) return gate.response;

  const presetId = req.nextUrl.searchParams.get("preset");
  if (!presetId) return bad("Which preset?");
  if (BUILT_IN_EXPORT_PRESETS.some((p) => p.id === presetId)) {
    return bad("The built-in presets cannot be deleted. Save your own alongside them.", 400);
  }

  const db = supabaseAdmin();
  /*
   * Soft delete, matching every other workspace object here: a preset a
   * colleague was using should be recoverable, and the unique index on the
   * name is already scoped to `deleted_at is null` so the name frees up.
   */
  const { error } = await db
    .from("data_export_presets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", presetId)
    .eq("customer_id", gate.user.customerId ?? "");

  if (error) {
    if (MISSING_TABLE.test(error.message)) return bad("Export presets need migration 0042.", 503);
    return bad(error.message, 500);
  }
  await audit({
    action: "responses.export_preset_deleted", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "data_export_preset", entityId: presetId, detail: {},
  });
  return json({ ok: true });
}
