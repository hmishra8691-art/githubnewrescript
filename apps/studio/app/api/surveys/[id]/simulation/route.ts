import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition } from "@/lib/qualityDef";
import { missingResponseMigration, RESPONSE_MIGRATION_MESSAGE } from "@/lib/responseData";
import { recountQuotas } from "@/lib/quotaRecount";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { runSimulation, simulationRows, type SimulationConfig } from "@rescript/templates";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SIMULATED TEST RESPONDENTS, KEPT AS TEST DATA (2026-11-09).
 *
 *   GET                         the simulation runs stored on this survey (TEST data only): run id, respondents, when
 *   POST { action: "store", config }   run the simulation on the SAVED version (the one the test link serves) — the same
 *                               engine walk as the preview in the Studio — and store every respondent as a TEST response
 *                               through the ordinary import transaction (`rescript_import_responses`, p_test = true):
 *                               respondent codes SIM-<run>-0001…, embedded SIMULATED_RUN / SIMULATED_PROFILE. TEST
 *                               quota counters are recounted. LIVE data, LIVE quotas, reports and deliverables never
 *                               see them (environment is a stored column — the separation is in the database).
 *   POST { action: "clear", runId? }   soft-delete one run's rows (or every SIM- row) from TEST data — restorable from
 *                               the recycle bin like any deletion; recount; audited.
 *
 * `responses.manage`, like an import.
 */
const MAX = 2000;
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  const { data, error } = await db.from("responses").select("respondent_code, status, created_at").eq("survey_id", params.id).eq("is_test", true).is("deleted_at", null).like("respondent_code", "SIM-%").limit(20000);
  if (error) return missingResponseMigration(error.message) ? json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, 503) : json({ error: error.message }, 500);
  const runs = new Map<string, { runId: string; respondents: number; complete: number; at: string | null }>();
  for (const r of data ?? []) {
    const runId = String(r.respondent_code).split("-")[1] ?? "?";
    const x = runs.get(runId) ?? { runId, respondents: 0, complete: 0, at: null };
    x.respondents++; if (r.status === "complete") x.complete++;
    if (!x.at || String(r.created_at) > x.at) x.at = String(r.created_at);
    runs.set(runId, x);
  }
  return json({ ok: true, runs: [...runs.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))) });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;
  let body: { action?: unknown; config?: unknown; runId?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const db = supabaseAdmin();
  const by = gate.user.fullName || gate.user.userCode;

  if (body.action === "clear") {
    const runId = typeof body.runId === "string" && /^[A-Z0-9]{1,12}$/.test(body.runId) ? body.runId : null;
    const { data, error } = await db.from("responses").select("id, respondent_code").eq("survey_id", params.id).eq("is_test", true).is("deleted_at", null).like("respondent_code", runId ? `SIM-${runId}-%` : "SIM-%").limit(50000);
    if (error) return json({ error: error.message }, 500);
    const ids = (data ?? []).map((r) => r.id);
    if (!ids.length) return json({ ok: true, cleared: 0 });
    const { error: e2 } = await db.rpc("rescript_soft_delete_responses", { p_survey: params.id, p_ids: ids, p_by: by, p_reason: `simulated test responses${runId ? ` (run ${runId})` : ""} cleared` });
    if (e2) return json({ error: e2.message }, 500);
    const quotas = await recountQuotas(db, undefined, params.id, true).catch(() => null);
    await audit({ action: "responses.deleted", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "responses", entityId: null, detail: { operation: "clear_simulation", environment: "TEST", runId, count: ids.length } });
    return json({ ok: true, cleared: ids.length, quotas });
  }

  if (body.action !== "store") return json({ error: "action is store or clear" }, 400);
  const raw = (body.config ?? {}) as SimulationConfig;
  const count = Math.round(Number(raw.count) || 0);
  if (count < 1 || count > MAX) return json({ error: `Simulate between 1 and ${MAX} respondents at a time.` }, 400);
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return json({ error: loaded.error }, loaded.status);
  if (!loaded.versionId) return json({ error: "Save a version first — simulated test responses are stored against the saved version the test link serves." }, 409);
  let report;
  try { report = runSimulation(loaded.def, { ...raw, count }); }
  catch (e) { return json({ error: `The simulation could not run: ${(e as Error).message}` }, 422); }
  const rows = simulationRows(report);
  const payload = rows.map((r) => ({ respondent_code: r.respondentCode, answers: r.answers, embedded: r.embedded, status: r.status, started_at: r.startedAt, completed_at: r.completedAt }));
  const { data, error } = await db.rpc("rescript_import_responses", { p_survey: params.id, p_version: loaded.versionId, p_test: true, p_mode: "create", p_rows: payload, p_by: `${by} (simulation ${report.runId})` });
  if (error) {
    if (missingResponseMigration(error.message)) return json({ error: RESPONSE_MIGRATION_MESSAGE, migration: "0006" }, 503);
    console.error("[rescript:simulation] store failed — nothing was committed", JSON.stringify({ surveyId: params.id, runId: report.runId, error: error.message }));
    return json({ error: error.message }, 500);
  }
  const quotas = await recountQuotas(db, loaded.def, params.id, true).catch(() => null);
  await audit({ action: "responses.imported", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "responses", entityId: null, detail: { operation: "simulation", environment: "TEST", runId: report.runId, count: rows.length, seed: raw.seed ?? null, verdict: report.verdict.ok ? "ok" : `${report.verdict.problems.length} problem(s)` } });
  return json({ ok: true, runId: report.runId, stored: rows.length, result: data ?? null, quotas, verdict: report.verdict, endings: report.endings });
}
