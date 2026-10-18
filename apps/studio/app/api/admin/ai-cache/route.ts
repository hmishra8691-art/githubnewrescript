import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireAdmin } from "@/lib/guard";
import { getMeter } from "@/lib/metering";
import { buildCacheReport, supabaseCachePage } from "@/lib/aiCacheReport";

export const dynamic = "force-dynamic";

/**
 * AI COST AND CACHE — MEASURED FROM BILLING (platform administrator, 2026-10-18).
 *
 *   GET /api/admin/ai-cache?days=30[&excludeEval=1]
 *
 * Per day × operation × model: calls, the token split (uncached / cache read /
 * cache write / output), the hit rate, what the calls cost at the provider and
 * what the same calls would have cost with no caching — priced with the rates
 * and configuration the meter uses — and the warnings (prefix churn, prefixes
 * below the provider's minimum, operations never cached). Read-only; nothing
 * about a customer beyond aggregate token counts leaves the server.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "There is no database on this installation to read the usage from.", code: "no_database" }, { status: 501 });
  const sp = req.nextUrl.searchParams;
  const days = Number(sp.get("days") ?? 30);
  try {
    const meter = getMeter();
    const [rates, config] = await Promise.all([meter.rates(), meter.config()]);
    const report = await buildCacheReport(supabaseCachePage(supabaseAdmin()), { days: Number.isFinite(days) ? days : 30, excludeEval: sp.get("excludeEval") === "1" }, { rates, config });
    return NextResponse.json({ ok: true, report }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.warn("[rescript:ai-cache]", JSON.stringify({ error: ((e as Error)?.message ?? "").slice(0, 200) }));
    return NextResponse.json({ error: "The usage could not be read." }, { status: 500 });
  }
}
