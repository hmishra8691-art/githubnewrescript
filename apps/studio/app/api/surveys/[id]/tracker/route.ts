import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { WAVE_LIMITS } from "@rescript/analytics";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE WAVE TRACKER'S STORE (2026-11-09, Rapid Studio phase 3).
 *
 *   GET                                        the tracker configuration and every wave (columns + rows)
 *   POST { action: "add_wave", wave }          keep one wave as it arrived: { label, order, source, fileName, columns, rows, notes }
 *   POST { action: "remove_wave", waveId }     soft-delete a wave (deleted_at), audited
 *   POST { action: "save_config", config }     KPIs, composition checks, segment, alpha, manual mappings
 *
 * Every computation (mapping, harmonising, significance, composition adjustment) happens in packages/analytics from the
 * stored rows, so connecting a new wave is one add_wave. Waves live in tracker_waves (migration 0093), never in
 * `responses`: they cannot reach this survey's quotas, Data tab or exports. Without 0093 the routes answer 503 with
 * `migration: "0093"` and the panel keeps the waves for the session only, saying so.
 */
const MIGRATION = "The wave tracker keeps its waves in supabase/migrations/0093_wave_tracker.sql, which is not applied yet. Your waves stay in this session until it is.";
const missing = (m?: string) => !!m && /tracker_waves|wave_trackers|does not exist|schema cache/i.test(m);
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  const [w, c] = await Promise.all([
    db.from("tracker_waves").select("id, label, wave_order, source, file_name, columns, rows, row_count, notes, created_at").eq("survey_id", params.id).is("deleted_at", null).order("wave_order"),
    db.from("wave_trackers").select("config, updated_at").eq("survey_id", params.id).maybeSingle(),
  ]);
  const err = w.error ?? c.error;
  if (err) return missing(err.message) ? json({ error: MIGRATION, migration: "0093" }, 503) : json({ error: err.message }, 500);
  return json({ ok: true, config: c.data?.config ?? null, waves: (w.data ?? []).map((r) => ({ id: r.id, label: r.label, order: r.wave_order, source: r.source, fileName: r.file_name, columns: r.columns, rows: r.rows, notes: r.notes, createdAt: r.created_at })) });
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "analytics.edit");
  if (isFailure(gate)) return gate.response;
  let body: { action?: unknown; wave?: any; waveId?: unknown; config?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const db = supabaseAdmin();
  const who = { userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId };

  if (body.action === "add_wave") {
    const w = body.wave ?? {};
    const label = str(w.label, 80);
    const columns = Array.isArray(w.columns) ? w.columns.slice(0, WAVE_LIMITS.columns).filter((c: any) => c && typeof c.name === "string").map((c: any) => ({ name: String(c.name).slice(0, 120), ...(typeof c.label === "string" ? { label: c.label.slice(0, 500) } : {}), ...(Array.isArray(c.values) ? { values: c.values.slice(0, 200).map((v: any) => ({ code: String(v?.code ?? ""), label: String(v?.label ?? "").slice(0, 200) })) } : {}) })) : [];
    const rows = Array.isArray(w.rows) ? w.rows.slice(0, WAVE_LIMITS.rows).filter((r: unknown) => r && typeof r === "object" && !Array.isArray(r)) : [];
    if (!label || !columns.length || !rows.length) return json({ error: "A wave needs a label, columns and at least one row." }, 400);
    const names = new Set(columns.map((c: { name: string }) => c.name));
    const clean = rows.map((r: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const n of names) { const v = r[n as string]; o[n as string] = v === undefined ? null : typeof v === "object" && v !== null ? String(v) : v; } return o; });
    const order = Number.isFinite(Number(w.order)) ? Math.max(0, Math.min(1000, Math.round(Number(w.order)))) : 0;
    const { data, error } = await db.from("tracker_waves").insert({
      survey_id: params.id, label, wave_order: order, source: w.source === "survey" ? "survey" : "upload", file_name: str(w.fileName, 200),
      columns, rows: clean, row_count: clean.length, notes: Array.isArray(w.notes) ? w.notes.slice(0, 10).map(String) : [], created_by: gate.user.userId,
    }).select("id").single();
    if (error) return missing(error.message) ? json({ error: MIGRATION, migration: "0093" }, 503) : json({ error: error.message }, 500);
    await audit({ action: "analytics.analysis_created", ...who, entity: "tracker_wave", entityId: data.id, detail: { label, order, source: w.source === "survey" ? "survey" : "upload", rows: clean.length, columns: columns.length } });
    return json({ ok: true, id: data.id });
  }

  if (body.action === "remove_wave") {
    const id = typeof body.waveId === "string" && /^[0-9a-f-]{36}$/i.test(body.waveId) ? body.waveId : null;
    if (!id) return json({ error: "waveId" }, 400);
    const { data, error } = await db.from("tracker_waves").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("survey_id", params.id).is("deleted_at", null).select("label").maybeSingle();
    if (error) return missing(error.message) ? json({ error: MIGRATION, migration: "0093" }, 503) : json({ error: error.message }, 500);
    if (!data) return json({ error: "No such wave in this project." }, 404);
    await audit({ action: "analytics.analysis_deleted", ...who, entity: "tracker_wave", entityId: id, detail: { label: data.label } });
    return json({ ok: true });
  }

  if (body.action === "save_config") {
    const c = body.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) return json({ error: "config must be an object" }, 400);
    const text = JSON.stringify(c);
    if (text.length > 200_000) return json({ error: "The tracker configuration is too large." }, 413);
    const { error } = await db.from("wave_trackers").upsert({ survey_id: params.id, config: c, updated_by: gate.user.userId, updated_at: new Date().toISOString() });
    if (error) return missing(error.message) ? json({ error: MIGRATION, migration: "0093" }, 503) : json({ error: error.message }, 500);
    await audit({ action: "analytics.analysis_modified", ...who, entity: "wave_tracker", entityId: null, detail: { kpis: Array.isArray((c as { kpis?: unknown[] }).kpis) ? (c as { kpis: unknown[] }).kpis.length : 0 } });
    return json({ ok: true });
  }
  return json({ error: "action must be add_wave, remove_wave or save_config" }, 400);
}
