import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Retention: drop raw telemetry older than the survey's configured retention
 * (or the days given), keeping every computed assessment. Scores survive; the
 * behavioural detail behind them does not outlive its purpose.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  const configured = "def" in loaded ? loaded.def.quality.privacy.telemetryRetentionDays : 0;
  const days = Number.isFinite(Number(body?.days)) && Number(body?.days) >= 0 ? Number(body.days) : configured;
  if (!days) return NextResponse.json({ error: "No retention period set — set one under Survey settings → Quality checks → Privacy, or pass { days }." }, { status: 400 });
  const { data, error } = await db.rpc("rescript_purge_telemetry", { p_survey_id: params.id, p_days: days });
  if (error) {
    if (missingMigration(error.message)) return NextResponse.json({ error: "apply migration 0005", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  console.info("[rescript:quality] purge", { survey: params.id, days, purged: data });
  return NextResponse.json({ ok: true, days, purged: data ?? 0 });
}
