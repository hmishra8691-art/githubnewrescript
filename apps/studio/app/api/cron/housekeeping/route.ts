import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseService } from "@/lib/authServer";

/**
 * WEEKLY HOUSEKEEPING (audit SCHEMA-09).
 *
 * Calls `rescript_housekeeping()` (migration 0058): deletes expired
 * `analytics_result_cache` rows, sign-in attempts older than 90 days, share
 * access log rows and interview telemetry older than 180 days, and sweeps
 * spent auth hand-off codes. The function trims each table in batches; while
 * a batch came back full (`more`) it is called again, inside a time budget —
 * whatever is left waits for next week.
 *
 * Authorised by CRON_SECRET like the other jobs, and refuses everything when
 * the variable is unset. A database without migration 0058 answers 200 with
 * `skipped`, so deploying the route before the migration is harmless.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;
const MAX_PASSES = 20;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

type Pass = Record<string, number | boolean>;

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const db = supabaseService();
  const startedAt = Date.now();
  const totals: Record<string, number> = {};
  let passes = 0;
  let more = true;
  while (more && passes < MAX_PASSES && Date.now() - startedAt < BUDGET_MS) {
    const { data, error } = await db.rpc("rescript_housekeeping");
    if (error) {
      if (/rescript_housekeeping|does not exist|schema cache/i.test(error.message) && passes === 0) {
        return NextResponse.json({ ok: true, skipped: "migration 0058 not applied" });
      }
      return NextResponse.json({ error: error.message, passes, deleted: totals }, { status: 500 });
    }
    passes++;
    const pass = (data ?? {}) as Pass;
    for (const [k, v] of Object.entries(pass)) {
      if (k === "batch" || k === "more" || typeof v !== "number") continue;
      totals[k] = (totals[k] ?? 0) + v;
    }
    more = pass.more === true;
  }
  return NextResponse.json({ ok: true, passes, deleted: totals, more, elapsedMs: Date.now() - startedAt });
}
