import { NextResponse } from "next/server";
import { runHealth, type HealthCheck } from "@rescript/storage/observe";
import { platformDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * HEALTH (audit 2026-11-17, P1-13) — for uptime monitors and the synthetic check (scripts/synthetic-check.mjs).
 * Public on purpose: it answers only check names, ok / not ok and timings, never data or configuration values.
 * 200 when ok or degraded, 503 when a critical check fails.
 */
export async function GET() {
  const dbConfigured = !!(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const checks: HealthCheck[] = [
    dbConfigured
      ? { name: "database", run: async () => { const { error } = await platformDb().from("surveys").select("id").limit(1); if (error) throw new Error(error.message); } }
      : { name: "database", critical: false, run: async () => "not configured (sandbox)" },
    { name: "error-alerts", critical: false, run: async () => { if (!process.env.ERROR_WEBHOOK_URL) throw new Error("ERROR_WEBHOOK_URL is not set: failures are logged but nobody is alerted"); } },
  ];
  const h = await runHealth(checks, { timeoutMs: 3000 });
  return NextResponse.json({ app: "studio", ...h }, { status: h.status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
