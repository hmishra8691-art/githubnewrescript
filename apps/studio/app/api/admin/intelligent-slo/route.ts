import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireAdmin } from "@/lib/guard";
import { intelligentSlo, type OperationRow } from "@/lib/intelligentSlo";

export const dynamic = "force-dynamic";

/**
 * INTELLIGENT MODE SERVICE LEVELS (IM10, 2026-11-06) — GET ?days=7 (1–90), platform administrators only.
 * Reads the operation history of every project for the period and judges it against the stated objectives
 * (lib/intelligentSlo.ts). Read-only.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "There is no database on this installation to read the operations from.", code: "no_database" }, { status: 501 });
  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get("days") ?? 7) || 7));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: OperationRow[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabaseAdmin().from("intelligent_operations").select("source, status, created_at, intent").gte("created_at", since).order("created_at", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows.push(...((data ?? []) as OperationRow[]));
    if (!data || data.length < 1000) break;
  }
  return NextResponse.json({ days, ...intelligentSlo(rows) }, { headers: { "cache-control": "no-store" } });
}
