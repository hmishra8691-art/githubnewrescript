import { cacheReport, cacheRowFromDb, type BillingConfig, type CacheReport, type Rate } from "@rescript/billing";

/**
 * AI COST AND CACHE — MEASURED FROM BILLING (2026-10-18).
 *
 * Reads the AI usage events of a window from the ledger (`usage_events`,
 * category `ai`) and hands them to the billing package's `cacheReport` with the
 * rates and configuration the meter prices with. The admin panel on /platform
 * (`/api/admin/ai-cache`) and `scripts/ai-cache-report.mjs` both use it; the
 * arithmetic lives in `@rescript/billing` and is tested there.
 *
 * The reader is injected (`page(from, to)` → rows) so this is tested without a
 * database. Paged at 1,000 rows (PostgREST's default ceiling), at most `maxRows`.
 */
export const CACHE_REPORT_COLUMNS = "id, created_at, event_type, category, environment, provider, service, model, input_units, output_units, provider_cost, infra_cost, customer_charge, customer_id, survey_id, user_id, metadata";

export interface CacheWindow { days?: number; since?: string; until?: string; /** leave out the platform's own evaluation runs (metadata.source = "platform_eval") */ excludeEval?: boolean; maxRows?: number }

export function windowOf(w: CacheWindow, now = new Date()): { since: string; until: string } {
  const days = Math.max(1, Math.min(365, Math.round(w.days ?? 30)));
  const until = w.until && !Number.isNaN(Date.parse(w.until)) ? new Date(w.until).toISOString() : now.toISOString();
  const since = w.since && !Number.isNaN(Date.parse(w.since)) ? new Date(w.since).toISOString() : new Date(Date.parse(until) - days * 86_400_000).toISOString();
  return { since, until };
}

export async function buildCacheReport(
  page: (offset: number, limit: number, win: { since: string; until: string }) => Promise<Record<string, unknown>[]>,
  w: CacheWindow, priced: { rates?: Rate[]; config?: BillingConfig } = {},
): Promise<CacheReport & { window: { since: string; until: string }; truncated: boolean }> {
  const win = windowOf(w);
  const max = Math.max(1, Math.min(50_000, w.maxRows ?? 20_000));
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += 1000) {
    const batch = await page(offset, 1000, win);
    rows.push(...batch);
    if (batch.length < 1000) break;
    if (rows.length >= max) { truncated = true; break; }
  }
  const parsed = rows.map(cacheRowFromDb).filter((r) => !(w.excludeEval && r.metadata?.source === "platform_eval"));
  return { ...cacheReport(parsed, { rates: priced.rates, config: priced.config, now: win.until }), window: win, truncated };
}

/** the Supabase reader: AI events of the window, oldest first */
export function supabaseCachePage(db: { from(t: string): unknown }) {
  return async (offset: number, limit: number, win: { since: string; until: string }) => {
    const q = (db.from("usage_events") as { select(c: string): { eq(c: string, v: string): { gte(c: string, v: string): { lt(c: string, v: string): { order(c: string, o: { ascending: boolean }): { range(a: number, b: number): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> } } } } } })
      .select(CACHE_REPORT_COLUMNS).eq("category", "ai").gte("created_at", win.since).lt("created_at", win.until).order("created_at", { ascending: true }).range(offset, offset + limit - 1);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  };
}
