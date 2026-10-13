import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeDb as FakeDbBase } from "../../../scripts/lib/fakeSupabase.mjs";
import { ANALYTICS_ENGINE_VERSION, inputHashOf, runAnalysis, buildDataset, type AnalysisDefinition } from "@rescript/analytics";
import { cacheGet, cachePut, clearResultMemo, memoSize, surveyStamp, withResultCache, MAX_CACHED_BYTES } from "./resultCache.ts";

/*
 * S-14 — THE PERSISTED RESULT CACHE: a result is found by the hash of its inputs, survives a restart (the memo is
 * cleared, the table remains), is never found once any input moved, and its absence never fails a request.
 */
class FakeDb extends FakeDbBase { as(): SupabaseClient { return this as unknown as SupabaseClient; } }
const S = "11111111-1111-4111-8111-111111111111";
const def: AnalysisDefinition = { name: "Satisfaction", kind: "descriptive", dataset: { environment: "LIVE", dataset: "all" }, variables: ["SAT"] };
const key = inputHashOf(def, { dataVersion: "400:t1", surveyVersion: "1.0:3:draft" });
const payload = (extra = {}) => ({ name: "Satisfaction", tables: [], provenance: { inputHash: key }, ...extra });

test("a result put in the cache is found from memory, and — after a restart — from the table", async () => {
  clearResultMemo();
  const db = new FakeDb();
  assert.equal(await cachePut(db.as(), S, key, payload({ n: 1 })), "stored");
  assert.deepEqual((await cacheGet(db.as(), S, key))?.from, "memory");
  clearResultMemo(); assert.equal(memoSize(), 0, "a restart: the memo is gone");
  const again = await cacheGet<{ n: number }>(db.as(), S, key);
  assert.equal(again?.from, "store"); assert.equal(again?.payload.n, 1);
  assert.equal(memoSize(), 1, "and it is remembered again");
  assert.equal(await cacheGet(db.as(), S, "0000000000000000"), null, "another hash is not found");
  assert.equal(await cacheGet(db.as(), "22222222-2222-4222-8222-222222222222", key), null, "another survey's result is not found");
});

test("a result from another engine version, or past its expiry, is not served", async () => {
  clearResultMemo();
  const db = new FakeDb();
  await cachePut(db.as(), S, key, payload());
  clearResultMemo();
  db.tables.analytics_result_cache[0].engine_version = "2020.01.0";
  assert.equal(await cacheGet(db.as(), S, key), null, "computed by an older engine: recomputed");
  db.tables.analytics_result_cache[0].engine_version = ANALYTICS_ENGINE_VERSION;
  db.tables.analytics_result_cache[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await cacheGet(db.as(), S, key), null, "expired");
  /* writing again clears the expired row and replaces the one under the same hash */
  await cachePut(db.as(), S, key, payload({ n: 2 }));
  assert.equal(db.tables.analytics_result_cache.length, 1); assert.equal((db.tables.analytics_result_cache[0].payload as { n: number }).n, 2);
});

test("without the table, or with a result too large to keep, nothing fails", async () => {
  clearResultMemo();
  const bare = new FakeDb(); delete (bare.tables as Record<string, unknown>).analytics_result_cache;
  assert.equal(await cachePut(bare.as(), S, key, payload()), "memory_only", "no table: kept in memory only");
  assert.equal((await cacheGet(bare.as(), S, key))?.from, "memory");
  clearResultMemo();
  assert.equal(await cacheGet(bare.as(), S, key), null, "no table after a restart: a miss, not an error");
  assert.equal(await cachePut(new FakeDb().as(), S, key, payload({ big: "x".repeat(MAX_CACHED_BYTES + 1) })), "skipped");
  assert.equal(memoSize(), 0);
});

test("withResultCache computes once per set of inputs: a second ask — or a differently named one — is served, a changed input is computed again", async () => {
  clearResultMemo();
  const db = new FakeDb();
  let computed = 0;
  const produce = (name: string, k: string) => async () => { computed++; return { name, tables: [], provenance: { inputHash: k } }; };
  const a = await withResultCache(db.as(), S, key, produce("Satisfaction", key));
  assert.equal(computed, 1); assert.equal(a.fromCache, undefined);
  const b = await withResultCache(db.as(), S, key, produce("never", key), (c) => ({ ...c, name: "Renamed" }));
  assert.equal(computed, 1, "served"); assert.equal(b.fromCache, "memory"); assert.equal(b.name, "Renamed", "the asker's own label");
  clearResultMemo();
  const c = await withResultCache(db.as(), S, key, produce("never", key));
  assert.equal(computed, 1, "served after a restart"); assert.equal(c.fromCache, "store");
  /* new data → another hash → computed */
  const k2 = inputHashOf(def, { dataVersion: "401:t2", surveyVersion: "1.0:3:draft" });
  await withResultCache(db.as(), S, k2, produce("Satisfaction", k2));
  assert.equal(computed, 2);
  /* not kept: a failed result, and one whose hash is not the one asked for (the data moved while it ran) */
  const k3 = inputHashOf(def, { dataVersion: "402:t3", surveyVersion: "x" });
  await withResultCache(db.as(), S, k3, async () => { computed++; return { name: "f", error: { code: "not_computable" }, provenance: { inputHash: k3 } }; });
  await withResultCache(db.as(), S, k3, async () => { computed++; return { name: "m", provenance: { inputHash: "different" } }; });
  assert.equal(computed, 4); assert.equal(db.tables.analytics_result_cache.length, 2);
  assert.equal(surveyStamp({ versionId: "v1", revision: 4, source: "draft" }), "v1:4:draft");
});

test("a real result is cacheable end to end: its recorded hash is the key it is stored under", async () => {
  clearResultMemo();
  const { def: survey, synthRows } = await import("../../../packages/analytics/dist/analyses/fixture.js");
  const spec = { environment: "LIVE" as const, dataset: "all" as const };
  const ds = buildDataset(survey, synthRows(120), { spec }); ds.dataVersion = "120:t"; ds.surveyVersion = "1.0:1:draft";
  const d: AnalysisDefinition = { name: "SAT", kind: "descriptive", dataset: spec, variables: ["SAT"] };
  const k = inputHashOf(d, { dataVersion: "120:t", surveyVersion: "1.0:1:draft" });
  const db = new FakeDb(); let runs = 0;
  const go = () => withResultCache(db.as(), S, k, async () => { runs++; return runAnalysis(d, ds); });
  const first = await go(); const second = await go();
  assert.equal(runs, 1); assert.equal(second.fromCache, "memory"); assert.equal(first.provenance!.inputHash, k);
  assert.deepEqual(second.tables, first.tables);
});
