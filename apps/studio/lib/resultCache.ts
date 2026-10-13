import type { SupabaseClient } from "@supabase/supabase-js";
import { ANALYTICS_ENGINE_VERSION } from "@rescript/analytics";

/**
 * THE RESULT CACHE (audit S-14). A computed result is stored under the hash of its inputs (`provenance.inputHash`):
 * an in-process memo in front, the `analytics_result_cache` table behind it (migration 0052), so an analysis nobody has
 * changed is served after a restart too. The hash already contains the data version, the questionnaire version and the
 * engine version, so there is nothing to invalidate — a different input is a different key.
 *
 * Free of `server-only` so a test can drive it over a stub database. Every database call is allowed to fail: a missing
 * table, a timeout or a full disk means the result is computed, never that the request fails.
 */

const MEMO_MAX = 300;
const memo = new Map<string, unknown>();
/** the largest result worth keeping (a factor analysis with a score per respondent can be several MB) */
export const MAX_CACHED_BYTES = 1_500_000;

/** the questionnaire a result was read through: its version row (or number) and the draft revision */
export const surveyStamp = (ctx: { versionId?: string | null; version?: string | null; revision?: number | null; source?: string | null }): string =>
  `${ctx.versionId ?? ctx.version ?? ""}:${ctx.revision ?? ""}:${ctx.source ?? ""}`;

const memoKey = (surveyId: string, hash: string) => `${surveyId}:${hash}`;
export const memoSize = () => memo.size;
export const clearResultMemo = () => memo.clear();

export type CacheSource = "memory" | "store";

export async function cacheGet<T>(db: SupabaseClient, surveyId: string, inputHash: string, now = new Date()): Promise<{ payload: T; from: CacheSource } | null> {
  const k = memoKey(surveyId, inputHash);
  if (memo.has(k)) { const v = memo.get(k) as T; memo.delete(k); memo.set(k, v); return { payload: structuredClone(v), from: "memory" }; }
  try {
    const { data, error } = await db.from("analytics_result_cache").select("payload, engine_version, expires_at").eq("survey_id", surveyId).eq("input_hash", inputHash).maybeSingle();
    if (error || !data) return null;
    if (data.engine_version !== ANALYTICS_ENGINE_VERSION) return null;
    if (data.expires_at && String(data.expires_at) < now.toISOString()) return null;
    remember(k, data.payload);
    return { payload: structuredClone(data.payload as T), from: "store" };
  } catch { return null; }
}

function remember(k: string, payload: unknown) {
  memo.delete(k); memo.set(k, structuredClone(payload));
  while (memo.size > MEMO_MAX) { const oldest = memo.keys().next().value; if (oldest === undefined) break; memo.delete(oldest); }
}

export async function cachePut(db: SupabaseClient, surveyId: string, inputHash: string, payload: unknown, now = new Date()): Promise<"stored" | "memory_only" | "skipped"> {
  let text: string;
  try { text = JSON.stringify(payload); } catch { return "skipped"; }
  if (text.length > MAX_CACHED_BYTES) return "skipped";
  remember(memoKey(surveyId, inputHash), payload);
  try {
    const iso = now.toISOString();
    /* expired rows of this survey go first, so the table cannot grow without bound; then this result replaces any older one under the same hash */
    await db.from("analytics_result_cache").delete().eq("survey_id", surveyId).lt("expires_at", iso);
    await db.from("analytics_result_cache").delete().eq("survey_id", surveyId).eq("input_hash", inputHash);
    const { error } = await db.from("analytics_result_cache").insert({ survey_id: surveyId, input_hash: inputHash, engine_version: ANALYTICS_ENGINE_VERSION, payload, bytes: text.length, computed_at: iso, expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString() });
    return error ? "memory_only" : "stored";
  } catch { return "memory_only"; }
}

/**
 * Serve `key` from the cache, or compute it with `produce` and keep it. `relabel` puts the caller's own label (the name
 * of the analysis asking) on a result computed for another label — the label is not an input, so two names share one result.
 * Not kept when it failed, or when the hash it was computed under is not the one it was looked up under (the data moved).
 */
export async function withResultCache<T extends { error?: unknown; provenance?: { inputHash: string } }>(
  db: SupabaseClient, surveyId: string, key: string, produce: () => Promise<T>, relabel: (cached: T) => T = (x) => x,
): Promise<T & { fromCache?: CacheSource }> {
  const hit = await cacheGet<T>(db, surveyId, key);
  if (hit) return { ...relabel(hit.payload), fromCache: hit.from };
  const out = await produce();
  if (!out.error && out.provenance?.inputHash === key) await cachePut(db, surveyId, key, out);
  return out;
}
