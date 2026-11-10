import { createHash } from "node:crypto";

/**
 * THE MODEL'S ANSWERS, REMEMBERED (2026-11-10). A Level 3 answer costs a model call; the same question asked again
 * over the same sources should not. The key is everything the answer was written from:
 *
 *   scope      the account (customer, else user) — an answer is never served to another account, even one written
 *              only from public guides, because its context may describe the asker's own survey;
 *   question   normalised (case, punctuation, spacing);
 *   mode, sources (the chunk ids handed to the model), and a hash of the context (the survey, the selected question,
 *              the diagnosis) — when any of them changes, the answer is written afresh.
 *
 * Only a first question is cached: a follow-up depends on the turns before it, which are not part of the key.
 * In memory, per server process, bounded (LRU) and expiring — a cache, not a store; a restart empties it.
 */
const MAX = 500;
const TTL_MS = 6 * 60 * 60 * 1000;

interface Entry<T> { at: number; value: T }
const store = new Map<string, Entry<unknown>>();
const stats = { hits: 0, misses: 0 };

export function normaliseQuestion(q: string): string {
  return q.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}{}.]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function cacheKey(o: { scope: string; question: string; mode: string; sources: string[]; context: string }): string {
  return createHash("sha256").update(JSON.stringify([o.scope, normaliseQuestion(o.question), o.mode, [...o.sources].sort(), o.context])).digest("hex");
}

export function cacheGet<T>(key: string, now = Date.now()): T | null {
  const e = store.get(key);
  if (!e) { stats.misses++; return null; }
  if (now - e.at > TTL_MS) { store.delete(key); stats.misses++; return null; }
  store.delete(key); store.set(key, e); // most recently used last
  stats.hits++;
  return e.value as T;
}

export function cachePut<T>(key: string, value: T, now = Date.now()): void {
  store.delete(key);
  store.set(key, { at: now, value });
  while (store.size > MAX) store.delete(store.keys().next().value as string);
}

export function cacheStats(): { size: number; hits: number; misses: number } { return { size: store.size, ...stats }; }
export function cacheClear(): void { store.clear(); stats.hits = 0; stats.misses = 0; }
