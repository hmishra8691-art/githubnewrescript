import type { SupabaseClient } from "@supabase/supabase-js";
import { modelJobStep, recommendCharts, MODELS_VERSION, type AnalysisDefinition, type AnalysisResult, type Dataset, type HbState } from "@rescript/analytics";
import { canContinue, CHUNK_MS, jobView, leaseUntil, stepUpdate, type ModelJobRow, type ModelJobView } from "./modelJobState.ts";

/**
 * CHUNKED MODEL JOBS — the service (advanced statistics, 2026-10-18). Starts,
 * continues, reads and cancels a long model run (HB-MNL) whose chain state is
 * persisted between requests in `analytics_model_jobs` (migration 0066).
 * Everything that touches the dataset or the cache is injected, so the same
 * code runs over the in-memory Supabase in tests and over the real one in the
 * route (`modelJobs.ts`).
 *
 *   start     same input hash already running → that job (a double click starts one run);
 *             already done → that job; otherwise a new row, and the first chunk runs now
 *   continue  takes the lease (optimistic: the update matches the row's updated_at), runs
 *             ≤ CHUNK_MS, stores the new state; when finished the result is written to the
 *             result cache under the hash `compute()` uses, so reports and exports find it
 *   cancel    a running job stops; its state is dropped
 */
export interface JobDeps {
  db: SupabaseClient;
  surveyId: string;
  /** the dataset the definition runs on (saved filters resolved) */
  dataset: (def: AnalysisDefinition) => Promise<Dataset>;
  /** the definition as compute() runs it, and the input hash it caches the result under */
  inputHash: (def: AnalysisDefinition) => Promise<{ def: AnalysisDefinition; key: string }>;
  cachePut: (key: string, payload: unknown) => Promise<unknown>;
  userId?: string | null;
  now?: () => Date;
  /** monotonic ms clock for the chunk budget */
  clock?: () => number;
  chunkMs?: number;
}

const TABLE = "analytics_model_jobs";
type Out = { status: number; body: { job?: ModelJobView; jobs?: ModelJobView[]; error?: string } };
const fail = (status: number, error: string): Out => ({ status, body: { error } });

const withRecommendations = (r: AnalysisResult) => ({ ...r, recommendations: (r.advice as { alternatives?: unknown } | undefined)?.alternatives ?? recommendCharts(r) });

async function runChunk(deps: JobDeps, row: ModelJobRow, def: AnalysisDefinition, key: string): Promise<Out> {
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  let update: Partial<ModelJobRow>;
  try {
    const ds = await deps.dataset(def);
    const step = modelJobStep(def, ds, (row.state as HbState | null) ?? null, deps.chunkMs ?? CHUNK_MS, clock);
    const result = step.result ? withRecommendations(step.result) : null;
    update = stepUpdate({ ...step, result }, now());
    if (step.status === "done" && result && !result.error) {
      try { await deps.cachePut(key, result); } catch (e) { console.error("[models] result cache write failed:", e); }
    }
  } catch (e) {
    console.error(`[models] job ${row.id} step failed:`, e);
    update = { status: "failed", state: null, error: "The model run failed. Start it again; if it keeps failing, reduce the burn-in and draws.", lease_until: null, updated_at: now().toISOString(), finished_at: now().toISOString() };
  }
  const { data, error } = await deps.db.from(TABLE).update(update).eq("id", row.id).select();
  if (error) return fail(500, error.message);
  const saved = (Array.isArray(data) ? data[0] : data) as ModelJobRow | undefined;
  return { status: 200, body: { job: jobView(saved ?? ({ ...row, ...update } as ModelJobRow)) } };
}

export async function startJob(deps: JobDeps, definition: AnalysisDefinition, analysisId?: string | null): Promise<Out> {
  const { def, key } = await deps.inputHash(definition);
  const { data: same } = await deps.db.from(TABLE).select("*").eq("survey_id", deps.surveyId).eq("input_hash", key).order("created_at", { ascending: false }).limit(5);
  const existing = ((same ?? []) as ModelJobRow[]).find((r) => r.status === "running" || r.status === "done");
  if (existing) return { status: 200, body: { job: jobView(existing) } };
  const now = (deps.now ?? (() => new Date()))();
  const { data, error } = await deps.db.from(TABLE).insert({
    survey_id: deps.surveyId, analysis_id: analysisId ?? null, kind: def.kind, status: "running", definition: def, input_hash: key, engine_version: MODELS_VERSION,
    seed: null, data_fingerprint: null, progress: { done: 0, total: 0, unit: "iterations" }, state: null, result: null, error: null, created_by: deps.userId ?? null, lease_until: leaseUntil(now),
  }).select().single();
  if (error || !data) return fail(500, error?.message ?? "The model job could not be created.");
  return runChunk(deps, data as ModelJobRow, def, key);
}

export async function continueJob(deps: JobDeps, jobId: string): Promise<Out> {
  const now = (deps.now ?? (() => new Date()))();
  const { data } = await deps.db.from(TABLE).select("*").eq("id", jobId).eq("survey_id", deps.surveyId).maybeSingle();
  const row = data as ModelJobRow | null;
  const verdict = canContinue(row, now);
  if (!verdict.ok) {
    if (row && verdict.status === 409) return { status: 200, body: { job: jobView(row) } };   // finished or busy: report where it is
    return fail(verdict.status, verdict.reason);
  }
  // take the lease: only if nobody updated the row since we read it
  const { data: leased } = await deps.db.from(TABLE).update({ lease_until: leaseUntil(now) }).eq("id", row!.id).eq("updated_at", row!.updated_at).select();
  if (!Array.isArray(leased) || !leased.length) return { status: 200, body: { job: jobView(row!) } };
  const def = row!.definition as AnalysisDefinition;
  return runChunk(deps, leased[0] as ModelJobRow, def, row!.input_hash);
}

export async function getJob(deps: JobDeps, jobId: string): Promise<Out> {
  const { data } = await deps.db.from(TABLE).select("*").eq("id", jobId).eq("survey_id", deps.surveyId).maybeSingle();
  return data ? { status: 200, body: { job: jobView(data as ModelJobRow) } } : fail(404, "Unknown model job.");
}

export async function listJobs(deps: JobDeps): Promise<Out> {
  const { data } = await deps.db.from(TABLE).select("*").eq("survey_id", deps.surveyId).order("created_at", { ascending: false }).limit(20);
  return { status: 200, body: { jobs: ((data ?? []) as ModelJobRow[]).map((r) => ({ ...jobView(r), result: null })) } };
}

export async function cancelJob(deps: JobDeps, jobId: string): Promise<Out> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { data } = await deps.db.from(TABLE).select("*").eq("id", jobId).eq("survey_id", deps.surveyId).maybeSingle();
  if (!data) return fail(404, "Unknown model job.");
  if ((data as ModelJobRow).status !== "running") return { status: 200, body: { job: jobView(data as ModelJobRow) } };
  const { data: upd } = await deps.db.from(TABLE).update({ status: "cancelled", state: null, lease_until: null, updated_at: now, finished_at: now }).eq("id", jobId).select();
  return { status: 200, body: { job: jobView(((Array.isArray(upd) ? upd[0] : upd) ?? { ...data, status: "cancelled" }) as ModelJobRow) } };
}
