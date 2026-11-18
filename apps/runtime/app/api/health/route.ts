import { NextResponse } from "next/server";
import { runHealth, type HealthCheck } from "@rescript/storage/observe";
import { platformDb } from "@/lib/db";
import { iceServersFor, livekitConfig, turnStatus } from "@rescript/analytics/live/server";

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
    /*
     * P2-15: live sessions (group interviews, live rooms) behind corporate firewalls need a TURN relay; a large room
     * needs the SFU. Non-critical — surveys work without either — but a missing relay is the usual reason a live
     * session "connects" in the office and not at the client's. With Cloudflare TURN the credentials are minted
     * for real, so a revoked token shows here before a participant meets it.
     */
    { name: "live-turn", critical: false, run: async () => {
      const t = turnStatus(process.env);
      if (t.mode === "none") throw new Error("no TURN relay configured (WEBRTC_TURN_URLS or Cloudflare TURN): live sessions behind strict firewalls will not connect");
      if (t.mode === "cloudflare") { const ice = await iceServersFor(process.env, { identity: "health-check", timeoutMs: 2500 }); if (ice.warning) throw new Error(ice.warning); }
      return `${t.mode}, ${t.urls} relay URL${t.urls === 1 ? "" : "s"}`;
    } },
    { name: "live-sfu", critical: false, run: async () => { if (!livekitConfig(process.env)) throw new Error("no SFU (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET): live rooms run peer-to-peer, fine for a few participants"); return "LiveKit configured"; } },
  ];
  const h = await runHealth(checks, { timeoutMs: 3000 });
  return NextResponse.json({ app: "runtime", ...h }, { status: h.status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
