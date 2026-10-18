/**
 * CHUNKED MODEL JOBS — the pure part (no I/O), so the rules are unit-tested:
 * what a client may see of a job, whether a continuation may run now, and the
 * row update a step produces. The server half is `modelJobs.ts`.
 *
 * A job row (migration 0066) holds the serialised chain state between
 * requests. A continuation takes a LEASE (so two tabs, or a double click,
 * never advance the same chains twice), runs ≤ CHUNK_MS, stores the new state
 * and releases the lease. The chain state never leaves the server.
 */

/** time one request spends advancing the chains — maxDuration is 60 s, the rest is loading the dataset and saving */
export const CHUNK_MS = 40_000;
/** a lease outlives one request, so a crashed request's lease expires on its own */
export const LEASE_MS = 65_000;

export type ModelJobStatus = "running" | "done" | "failed" | "refused" | "cancelled";

export interface ModelJobRow {
  id: string;
  survey_id: string;
  analysis_id?: string | null;
  kind: string;
  status: ModelJobStatus;
  definition: unknown;
  input_hash: string;
  engine_version: string;
  seed: number | null;
  data_fingerprint: string | null;
  progress: { done?: number; total?: number; unit?: string; projectedMs?: number | null } | null;
  state: unknown;
  result: unknown;
  error: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ModelJobView {
  id: string;
  kind: string;
  status: ModelJobStatus;
  progress: { done: number; total: number; unit: string; pct: number; projectedMs: number | null };
  result: unknown | null;
  error: string | null;
  seed: number | null;
  dataFingerprint: string | null;
  engineVersion: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** what the client sees: never the chain state */
export function jobView(row: ModelJobRow): ModelJobView {
  const done = Number(row.progress?.done ?? 0), total = Number(row.progress?.total ?? 0);
  return {
    id: row.id, kind: row.kind, status: row.status,
    progress: { done, total, unit: String(row.progress?.unit ?? "iterations"), pct: total ? Math.min(100, Math.round((done / total) * 1000) / 10) : row.status === "done" ? 100 : 0, projectedMs: row.progress?.projectedMs ?? null },
    result: row.status === "done" || row.status === "refused" ? row.result ?? null : null,
    error: row.error, seed: row.seed, dataFingerprint: row.data_fingerprint, engineVersion: row.engine_version,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}

export type ContinueVerdict = { ok: true } | { ok: false; status: number; reason: string };

/** may this job be advanced now? */
export function canContinue(row: ModelJobRow | null, now: Date): ContinueVerdict {
  if (!row) return { ok: false, status: 404, reason: "Unknown model job." };
  if (row.status !== "running") return { ok: false, status: 409, reason: row.status === "done" ? "This run has finished." : `This run is ${row.status}.` };
  if (!row.state) return { ok: false, status: 409, reason: "This run has no saved chain state to continue from — start it again." };
  if (row.lease_until && new Date(row.lease_until).getTime() > now.getTime()) return { ok: false, status: 409, reason: "This run is being advanced by another request — wait for it to finish." };
  return { ok: true };
}

export interface StepLike {
  status: "running" | "done" | "refused";
  progress: { done: number; total: number; unit: string };
  state: unknown;
  result: unknown;
  projectedMs: number | null;
  dataFingerprint: string | null;
  seed: number | null;
}

/** the row update after a step: state kept only while running, the lease released, the finish stamped */
export function stepUpdate(step: StepLike, now: Date): Partial<ModelJobRow> {
  const finished = step.status !== "running";
  const refusedMsg = step.status === "refused" ? ((step.result as { error?: { message?: string } } | null)?.error?.message ?? "The model could not be run.") : null;
  return {
    status: step.status,
    progress: { ...step.progress, projectedMs: step.projectedMs },
    state: finished ? null : step.state,
    result: finished ? step.result : null,
    error: refusedMsg,
    ...(step.dataFingerprint ? { data_fingerprint: step.dataFingerprint } : {}),
    ...(step.seed != null ? { seed: step.seed } : {}),
    lease_until: null,
    updated_at: now.toISOString(),
    ...(finished ? { finished_at: now.toISOString() } : {}),
  };
}

export const leaseUntil = (now: Date): string => new Date(now.getTime() + LEASE_MS).toISOString();
