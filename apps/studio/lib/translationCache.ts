import "server-only";
import { supabaseAdmin } from "@/lib/admin";
import { sourceHash, memoryCache, type CacheEntry, type TranslationCache } from "@rescript/ai";

/**
 * THE DATABASE TRANSLATION CACHE (`public.translation_cache`, migration
 * 0022) — per customer, in front of the provider, behind the in-process
 * memory cache. Every failure here is swallowed into "cache miss": a cache
 * must never be the reason a translation fails.
 */
export class DatabaseTranslationCache implements TranslationCache {
  constructor(private customerId: string) {}

  async get(keys: string[]): Promise<Record<string, CacheEntry>> {
    if (!keys.length) return {};
    try {
      const db = supabaseAdmin();
      const { data, error } = await db.from("translation_cache").select("cache_key, provider, source_language, target_language, source_text, translated_text, approved").eq("customer_id", this.customerId).in("cache_key", keys);
      if (error || !data) return {};
      const out: Record<string, CacheEntry> = {};
      for (const r of data) {
        out[r.cache_key] = { key: r.cache_key, provider: r.provider, sourceLanguage: r.source_language, targetLanguage: r.target_language, sourceText: r.source_text, translatedText: r.translated_text, approved: r.approved };
      }
      return out;
    } catch { return {}; }
  }

  async set(entries: CacheEntry[]): Promise<void> {
    if (!entries.length) return;
    try {
      const db = supabaseAdmin();
      const keys = entries.map((e) => e.key);
      const existing = await db.from("translation_cache").select("cache_key, approved").eq("customer_id", this.customerId).in("cache_key", keys);
      const approvedKeys = new Set((existing.data ?? []).filter((r) => r.approved).map((r) => r.cache_key));
      const rows = entries
        .filter((e) => e.approved || !approvedKeys.has(e.key))
        .map((e) => ({
          customer_id: this.customerId, cache_key: e.key, provider: e.provider, source_language: e.sourceLanguage, target_language: e.targetLanguage,
          source_hash: sourceHash(e.sourceText), source_text: e.sourceText.slice(0, 8000), translated_text: e.translatedText.slice(0, 8000), approved: !!e.approved, updated_at: new Date().toISOString(),
        }));
      if (!rows.length) return;
      await db.from("translation_cache").upsert(rows, { onConflict: "customer_id,cache_key", ignoreDuplicates: false });
    } catch { /* a cache write that fails is a cache miss next time */ }
  }
}

/** The caches to consult, in order: memory (free), then the database when one is configured and the caller belongs to a customer. */
export function cachesFor(customerId: string | null | undefined): TranslationCache[] {
  const dbConfigured = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  return dbConfigured && customerId ? [memoryCache, new DatabaseTranslationCache(customerId)] : [memoryCache];
}
