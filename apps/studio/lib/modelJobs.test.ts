import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeDb as FakeDbBase } from "../../../scripts/lib/fakeSupabase.mjs";
import { inputHashOf, runAnalysis, type AnalysisDefinition, type AnalysisResult } from "@rescript/analytics";
import { advancedDataset } from "../../../packages/analytics/dist/models/fixture.js";
import { canContinue, jobView, stepUpdate, LEASE_MS, type ModelJobRow } from "./modelJobState.ts";
import { cancelJob, continueJob, getJob, listJobs, startJob, type JobDeps } from "./modelJobsCore.ts";

/*
 * CHUNKED MODEL JOBS (migration 0066): an HB run advanced across several "requests" over the in-memory Supabase,
 * with the REAL analytics engine. The finished result equals a synchronous run, is written to the result cache
 * under the input hash compute() uses, a double start does not start two runs, a busy lease is respected, the
 * chain state never reaches the client, and cancel stops a run.
 */
class FakeDb extends FakeDbBase { as(): SupabaseClient { return this as unknown as SupabaseClient; } }

const study = advancedDataset({ n: 60 });
const DEF: AnalysisDefinition = { name: "HB", kind: "hb", dataset: { environment: "LIVE", dataset: "all" }, variables: ["CBC"], options: { burnIn: 300, draws: 300, thin: 3, seed: 4 } };

function deps(db: FakeDb, cache: Map<string, unknown>, chunkMs = 3): JobDeps {
  let clock = 0;
  return {
    db: db.as(), surveyId: "11111111-1111-4111-8111-111111111111", userId: "u1",
    dataset: async () => study.ds,
    inputHash: async (def) => ({ def, key: inputHashOf(def, { dataVersion: study.ds.dataVersion ?? null, surveyVersion: study.ds.surveyVersion ?? null }) }),
    cachePut: async (key, payload) => { cache.set(key, payload); },
    clock: () => (clock += 1),   // every budget check advances 1 ms: ≈ 10 iterations per ms → a few dozen chunks
    chunkMs,
  };
}

test("an HB run advances in chunks across requests, finishes with the synchronous result, and lands in the result cache", { timeout: 120_000 }, async () => {
  const db = new FakeDb(); (db.tables as Record<string, unknown[]>).analytics_model_jobs = [];
  const cache = new Map<string, unknown>();
  const d = deps(db, cache);
  const first = await startJob(d, DEF);
  assert.equal(first.status, 200);
  let job = first.body.job!;
  assert.equal(job.status, "running");
  assert.ok(job.progress.total === 600 && job.progress.done > 0 && job.progress.done < 600, JSON.stringify(job.progress));
  assert.equal((job as unknown as Record<string, unknown>).state, undefined, "the chain state never reaches the client");
  // a second start of the same definition returns the same run
  const again = await startJob(d, DEF);
  assert.equal(again.body.job!.id, job.id);
  assert.equal((db.tables as Record<string, unknown[]>).analytics_model_jobs.length, 1);
  let requests = 1;
  while (job.status === "running") { job = (await continueJob(d, job.id)).body.job!; requests++; assert.ok(requests < 500); }
  assert.equal(job.status, "done");
  assert.ok(requests > 3, `${requests} requests`);
  const row = (db.tables as unknown as Record<string, ModelJobRow[]>).analytics_model_jobs[0];
  assert.equal(row.state, null, "state dropped when done");
  assert.ok(row.data_fingerprint && row.seed === 4 && row.finished_at);
  const result = job.result as AnalysisResult & { recommendations: unknown[] };
  const sync = runAnalysis({ ...DEF, options: { ...DEF.options, timeBudgetMs: 600_000 } }, study.ds);
  assert.deepEqual(result.tables.find((t) => t.id === "hb_trace")!.rows, sync.tables.find((t) => t.id === "hb_trace")!.rows, "same draws as one uninterrupted run");
  assert.ok(Array.isArray(result.recommendations) && result.provenance?.inputHash);
  // cached under the very key compute() would look up
  const key = inputHashOf(DEF, { dataVersion: study.ds.dataVersion ?? null, surveyVersion: study.ds.surveyVersion ?? null });
  assert.equal(result.provenance!.inputHash, key);
  assert.ok(cache.has(key));
  // a finished run is not continued; reading it returns the result; a new start of the same hash returns it
  assert.equal((await continueJob(d, job.id)).body.job!.status, "done");
  assert.equal(((await getJob(d, job.id)).body.job!.result as AnalysisResult).kind, "hb");
  assert.equal((await startJob(d, DEF)).body.job!.id, job.id);
  const list = await listJobs(d);
  assert.equal(list.body.jobs!.length, 1); assert.equal(list.body.jobs![0].result, null, "the list carries no results");
});

test("a busy lease is respected, a refused definition is stored as refused, and cancel stops a run", { timeout: 60_000 }, async () => {
  const db = new FakeDb(); (db.tables as Record<string, unknown[]>).analytics_model_jobs = [];
  const d = deps(db, new Map(), 2);
  const job = (await startJob(d, { ...DEF, options: { ...DEF.options, seed: 5 } })).body.job!;
  const row = (db.tables as unknown as Record<string, ModelJobRow[]>).analytics_model_jobs[0];
  row.lease_until = new Date(Date.now() + 30_000).toISOString();
  const busy = await continueJob(d, job.id);
  assert.equal(busy.body.job!.progress.done, job.progress.done, "not advanced while another request holds the lease");
  row.lease_until = null;
  const cancelled = await cancelJob(d, job.id);
  assert.equal(cancelled.body.job!.status, "cancelled");
  assert.equal(row.state, null);
  assert.equal((await continueJob(d, job.id)).body.job!.status, "cancelled");
  // a question HB cannot model: refused, with the reason, no chain state
  const refused = await startJob(d, { ...DEF, variables: ["U1"] });
  assert.equal(refused.body.job!.status, "refused");
  assert.match(refused.body.job!.error ?? "", /CBC or MaxDiff/);
  assert.equal((await getJob(d, "nope")).status, 404);
});

test("job state rules: view, continuation verdicts, the update after a step", () => {
  const now = new Date("2026-10-18T10:00:00Z");
  const base: ModelJobRow = { id: "j", survey_id: "s", kind: "hb", status: "running", definition: {}, input_hash: "h", engine_version: "v", seed: 1, data_fingerprint: "f", progress: { done: 250, total: 1000, unit: "iterations", projectedMs: 8000 }, state: { x: 1 }, result: null, error: null, lease_until: null, created_at: "a", updated_at: "b", finished_at: null };
  const v = jobView(base);
  assert.equal(v.progress.pct, 25); assert.equal(v.result, null); assert.ok(!("state" in v));
  assert.deepEqual(canContinue(base, now), { ok: true });
  assert.equal(canContinue(null, now).ok, false);
  assert.equal((canContinue({ ...base, lease_until: new Date(now.getTime() + 1000).toISOString() }, now) as { status: number }).status, 409);
  assert.deepEqual(canContinue({ ...base, lease_until: new Date(now.getTime() - 1).toISOString() }, now), { ok: true }, "an expired lease (a crashed request) does not block");
  assert.equal(canContinue({ ...base, status: "done" }, now).ok, false);
  assert.equal(canContinue({ ...base, state: null }, now).ok, false);
  const run = stepUpdate({ status: "running", progress: { done: 400, total: 1000, unit: "iterations" }, state: { y: 2 }, result: null, projectedMs: 9000, dataFingerprint: "f", seed: 1 }, now);
  assert.deepEqual(run.state, { y: 2 }); assert.equal(run.lease_until, null); assert.equal(run.finished_at, undefined);
  const done = stepUpdate({ status: "done", progress: { done: 1000, total: 1000, unit: "iterations" }, state: { y: 2 }, result: { kind: "hb" }, projectedMs: 9000, dataFingerprint: "f", seed: 1 }, now);
  assert.equal(done.state, null); assert.deepEqual(done.result, { kind: "hb" }); assert.equal(done.finished_at, now.toISOString());
  assert.ok(LEASE_MS > 60_000, "a lease outlives one 60 s request");
});
