import { NextRequest } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability, qualRefusal } from "@/lib/qual/qualAccess";
import { json, recordEvents, refuse, saveSettings, storeFailure, UUID, loadSettings } from "@/lib/qual/qualStore";
import { parseAutoCodeSettings } from "@/lib/qual/synthesisWorkspace";
import { listJobs, saveJob } from "@/lib/qual/synthesisStore";
import { advanceJob, autoCodeSettingsOf, enqueueAutoCode, enqueuePending } from "@/lib/qual/autoCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * THE AUTOMATIC CODING PIPELINE (2026-10-22). Data view + Analytics edit.
 *
 *   GET                                       the jobs and the study's auto-coding settings; with auto-coding on, any
 *                                             source not yet coded (an AI interview's transcript, an import, a closed
 *                                             group session) is queued — idempotently, one job per source revision
 *   POST { action: "settings", autoCode }     on / off, inductive / deductive / auto, batches per source, regenerate
 *                                             summaries — Data edit as well (it changes what is spent automatically)
 *   POST { action: "enqueue", sourceIds }     queue these sources now
 *   POST { action: "continue", jobId? }       advance a job (the oldest open one) under its lease, until done or ~200 s
 *   POST { action: "cancel", jobId }
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  try {
    const db = supabaseService();
    const cod = await db.from("qual_codings").select("settings").eq("survey_id", params.id).maybeSingle();
    const settings = autoCodeSettingsOf((cod.data as { settings?: unknown } | null)?.settings);
    const queued = settings.enabled ? await enqueuePending(db, params.id, gate.user.userId) : 0;
    return json({ ok: true, settings, queued, jobs: await listJobs(db, params.id) });
  } catch (e) { return storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("code"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "code");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "expected a JSON body" }, 400);
  const action = String(body.action ?? "");
  const db = supabaseService();
  try {
    if (action === "settings") {
      if (qualRefusal(gate.grant, "manage")) return json({ error: "Turning automatic coding on or off needs Data: Edit as well — it decides what is spent on new sources.", code: "insufficient_role" }, 403);
      const s = parseAutoCodeSettings(body.autoCode ?? body);
      const cur = await db.from("qual_codings").select("settings").eq("survey_id", params.id).maybeSingle();
      const was = autoCodeSettingsOf((cur.data as { settings?: unknown } | null)?.settings);
      /* `since`: sources that existed before auto-coding was turned on are not coded automatically (queue them by hand) */
      const since = s.enabled ? (was.enabled && was.since ? was.since : new Date().toISOString()) : undefined;
      const names = await loadSettings(db, params.id);
      await saveSettings(db, params.id, { ...names, autoCode: { ...s, ...(since ? { since } : {}) } }, gate.user.userId);
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "settings.autocode", detail: s.enabled ? `Turned automatic coding on (${s.mode}, at most ${s.maxBatchesPerSource} model calls per source${s.updateSummaries ? ", summaries regenerated" : ""})` : "Turned automatic coding off", ids: [] }]);
      return json({ ok: true, settings: { ...s, ...(since ? { since } : {}) } });
    }
    if (action === "enqueue") {
      const ids = Array.isArray(body.sourceIds) ? body.sourceIds.map(String).filter((x) => UUID.test(x)).slice(0, 50) : [];
      if (!ids.length) return json({ error: "choose sources to code" }, 400);
      const jobs = [];
      for (const id of ids) { const j = await enqueueAutoCode(db, params.id, id, gate.user.userId, { force: true }); if (j) jobs.push(j); }
      return json({ ok: true, queued: jobs.length, jobs: await listJobs(db, params.id) });
    }
    if (action === "continue") {
      const all = await listJobs(db, params.id);
      const id = typeof body.jobId === "string" && UUID.test(body.jobId) ? body.jobId : [...all].reverse().find((j) => j.status === "queued" || j.status === "running")?.id;
      if (!id) return json({ ok: true, idle: true, jobs: all });
      const r = await advanceJob(db, gate.user, params.id, id);
      if (r.response) return r.response;
      return json({ ok: true, job: r.job, jobs: await listJobs(db, params.id) });
    }
    if (action === "cancel") {
      const id = String(body.jobId ?? "");
      if (!UUID.test(id)) return json({ error: "which job" }, 400);
      await saveJob(db, params.id, id, { status: "cancelled", release: true, finished: true });
      await recordEvents(db, gate, [{ actor: gate.user.userId, action: "ai_coding.cancelled", detail: "Cancelled an automatic coding job (what it coded stays, as AI suggestions)", ids: [id] }]);
      return json({ ok: true, jobs: await listJobs(db, params.id) });
    }
    return json({ error: "action is settings, enqueue, continue or cancel" }, 400);
  } catch (e) { return storeFailure(e); }
}
