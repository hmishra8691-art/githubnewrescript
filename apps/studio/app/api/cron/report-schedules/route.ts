import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { nextRunAt } from "@rescript/analytics";
import { everyDatabase } from "@/lib/db";
import { isMissing0110, MISSING_0110, runSchedule, SCHEDULE_COLUMNS, studioPublicUrl, timingOf } from "@/lib/reportSchedules";

/**
 * SCHEDULED REPORTS AND METRIC ALERTS (Level 5 roadmap R5 + R6, migration 0110) — hourly: every enabled schedule whose
 * time has come is CLAIMED (its next time moved forward only where it still holds the time read, so two overlapping
 * runs of this job never run one schedule twice) and then run. Authorised by CRON_SECRET like the other jobs, refusing
 * everything when it is unset.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUDGET_MS = 240_000;

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

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const started = Date.now();
  const totals = { due: 0, ran: 0, failed: 0, delivered: 0, alerts: 0, partial: false };
  const studioUrl = studioPublicUrl(null);
  try {
    for (const target of everyDatabase()) {
      const { data: due, error } = await target.db.from("report_schedules").select(SCHEDULE_COLUMNS).eq("enabled", true).lte("next_run_at", new Date().toISOString()).order("next_run_at").limit(50);
      if (error) throw new Error(error.message);
      totals.due += due?.length ?? 0;
      for (const s of due ?? []) {
        if (Date.now() - started > BUDGET_MS) { totals.partial = true; break; }
        /* claim: move the next time forward only if nobody else did */
        const next = nextRunAt(timingOf(s), new Date()).toISOString();
        const { data: claimed } = await target.db.from("report_schedules").update({ next_run_at: next }).eq("id", String(s.id)).eq("next_run_at", String(s.next_run_at)).select("id");
        if (!claimed?.length) continue;
        const out = await runSchedule(target.db, { ...s, next_run_at: next }, { trigger: "schedule", studioUrl });
        totals.ran++; totals.delivered += out.delivered;
        if (out.status === "failed") totals.failed++;
        if (out.alertFired) totals.alerts++;
      }
    }
    return NextResponse.json({ ok: true, ...totals, elapsedMs: Date.now() - started });
  } catch (e) {
    const m = (e as Error).message;
    if (isMissing0110(m)) return NextResponse.json({ ok: true, skipped: MISSING_0110 });
    return NextResponse.json({ error: m.slice(0, 300) }, { status: 500 });
  }
}
