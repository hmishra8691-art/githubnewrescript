import "server-only";
import { NextResponse } from "next/server";
import { platformDb, everyDatabase } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";
import { importSessionStore } from "@/lib/import/sessionsServer";

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
  /* tenancy: rescript_housekeeping clears platform rows (login attempts) and client rows (result caches, share access, interview telemetry) in one call; it runs on the primary until that is split per class (docs/TENANCY, step 4) */
  const db = platformDb();
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
  /* I4: import source files past their 90 days — the object goes, the key is cleared, the session stays as history */
  let importSources = 0; let importError: string | undefined;
  try {
    const store = importSessionStore();
    for (const s of await store.expired(200)) {
      if (Date.now() - startedAt > BUDGET_MS + 10_000) break;
      await store.dropSource(s); importSources++;
    }
  } catch (e) { importError = (e as Error).message; }
  const partitions = await ensureResponsePartitions();
  return NextResponse.json({ ok: true, passes, deleted: { ...totals, importSources }, more, partitions, elapsedMs: Date.now() - startedAt, ...(importError ? { importSourcesError: importError } : {}) });
}

/**
 * Migration 0111: `responses` is partitioned by month. Create the coming six months on every client database, so a
 * month never starts without its partition (0111 itself creates them through the end of next year; the default
 * partition catches anything that slips through, so a missed run never fails an insert). A database without 0111
 * answers `skipped`; a failure is reported, never thrown — housekeeping's own result stands.
 */
async function ensureResponsePartitions(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of everyDatabase()) {
    try {
      const { data, error } = await t.db.rpc("rescript_responses_ensure_partitions", { p_months_ahead: 6 });
      if (error) {
        out[t.id] = /rescript_responses_ensure_partitions|does not exist|schema cache/i.test(error.message)
          ? { skipped: "migration 0111 not applied" }
          : { error: error.message };
        continue;
      }
      out[t.id] = data;
      const stray = (data as { default_rows?: number } | null)?.default_rows ?? 0;
      if (stray > 0) console.warn("[rescript:partitions] rows in responses_default", JSON.stringify({ database: t.id, rows: stray }));
    } catch (e) {
      out[t.id] = { error: (e as Error).message };
    }
  }
  return out;
}
