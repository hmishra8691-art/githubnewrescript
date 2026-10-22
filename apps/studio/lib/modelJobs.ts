import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analysisReadiness, CHUNKED_KINDS, type AnalysisDefinition } from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { isFailure, requireProject } from "@/lib/guard";
import { buildFor, loadDefinition, modelInputKey, resolveSaved, type LoadedContext } from "@/lib/analytics";
import { cachePut } from "@/lib/resultCache";
import { cancelJob, continueJob, getJob, listJobs, startJob, type JobDeps } from "./modelJobsCore.ts";

/**
 * THE MODEL JOB ENDPOINTS, dispatched from the analytics route (`POST|GET analytics/models/...`):
 *
 *   POST models                { definition, analysisId? }  start a chunked run (HB) — runs the first chunk now
 *   POST models/<id>/continue                               advance ≤ 40 s from the saved chain state
 *   POST models/<id>/cancel
 *   GET  models/<id>                                        status, progress, the result when done
 *   GET  models                                             this survey's recent runs (no results)
 *
 * The member needs analytics.read (the same as `POST run`); the one readiness rule refuses an incomplete
 * definition with 422 before anything runs. Only kinds in CHUNKED_KINDS run here; the rest use `POST run`.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** the job service's dependencies for an already-authorised caller (the routes below; the plan's Apply, which starts HB jobs — 2026-10-22) */
export function jobDepsFor(db: SupabaseClient, surveyId: string, loaded: LoadedContext, userId: string | null, opts: { chunkMs?: number } = {}): JobDeps {
  return {
    db, surveyId, userId,
    dataset: async (def) => buildFor(db, surveyId, loaded, await resolveSaved(db, surveyId, def)),
    /* the very key compute() caches under, so a finished run is what reports, exports and the plan's run are served */
    inputHash: (definition) => modelInputKey(db, surveyId, loaded, definition),
    cachePut: (key, payload) => cachePut(db, surveyId, key, payload),
    ...(opts.chunkMs ? { chunkMs: opts.chunkMs } : {}),
  };
}

async function depsFor(req: NextRequest, surveyId: string): Promise<{ deps: JobDeps } | { response: NextResponse }> {
  const ctx = await requireProject(req, surveyId, "analytics.read");
  if (isFailure(ctx)) return { response: ctx.response as NextResponse };
  const db = supabaseService();
  const loaded = await loadDefinition(db, surveyId);
  if ("error" in loaded) return { response: json({ error: loaded.error }, loaded.status) };
  return { deps: jobDepsFor(db, surveyId, loaded, ctx.user.userId) };
}

export async function modelJobsGET(req: NextRequest, surveyId: string, jobId?: string): Promise<NextResponse> {
  const d = await depsFor(req, surveyId); if ("response" in d) return d.response;
  const out = jobId ? await getJob(d.deps, jobId) : await listJobs(d.deps);
  return json(out.body, out.status);
}

export async function modelJobsPOST(req: NextRequest, surveyId: string, jobId: string | undefined, action: string | undefined, body: Record<string, unknown>): Promise<NextResponse> {
  if (!jobId) {
    const def = body.definition as AnalysisDefinition | undefined;
    if (!def || !def.kind || !def.dataset) return json({ error: "A definition with kind and dataset is required." }, 400);
    if (!CHUNKED_KINDS.has(def.kind)) return json({ error: `${def.kind} runs directly — use POST run.` }, 400);
    if (!["TEST", "LIVE", "ALL"].includes(def.dataset.environment)) return json({ error: "dataset.environment must be TEST, LIVE or ALL." }, 400);
    const ready = analysisReadiness({ ...def, variables: Array.isArray(def.variables) ? def.variables : [] });
    if (!ready.ready) return json({ error: ready.missing.join(" "), code: "incomplete_definition", missing: ready.missing }, 422);
    const d = await depsFor(req, surveyId); if ("response" in d) return d.response;
    const out = await startJob(d.deps, { ...def, name: def.name || def.kind }, typeof body.analysisId === "string" ? body.analysisId : null);
    return json(out.body, out.status);
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: "Unknown model job." }, 404);
  const d = await depsFor(req, surveyId); if ("response" in d) return d.response;
  const out = action === "continue" ? await continueJob(d.deps, jobId) : action === "cancel" ? await cancelJob(d.deps, jobId) : { status: 404, body: { error: "Unknown model job action." } };
  return json(out.body, out.status);
}
