import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { notifyDeps, notifyStore } from "@/lib/notify/server";
import { runDue } from "@/lib/notify/service";

/**
 * ALERT RETRIES AND DIGESTS (2026-10-22, G3) — every minute: deliveries whose backoff has passed are retried,
 * hourly / daily / quiet-hours digests that are due go out as one message per destination, and outbox events no
 * request delivered (a crash between "flagged" and "sent") are delivered. Authorised by CRON_SECRET like the other
 * jobs, and refuses everything when the variable is unset. A database without migration 0072 answers 200 with
 * `skipped`, so deploying the route before the migration is harmless.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  try {
    const deps = notifyDeps(notifyStore());
    const started = Date.now();
    const totals = { retried: 0, digests: 0, events: 0 };
    /* passes until nothing is due or the time budget is spent */
    for (let i = 0; i < 10 && Date.now() - started < 40_000; i++) {
      const r = await runDue(deps, { limit: 100 });
      totals.retried += r.retried; totals.digests += r.digests; totals.events += r.events;
      if (!r.retried && !r.digests && !r.events) break;
    }
    return NextResponse.json({ ok: true, ...totals, elapsedMs: Date.now() - started });
  } catch (e) {
    const m = (e as Error).message;
    if (/notify_|rescript_notify_claim|does not exist|schema cache/i.test(m)) return NextResponse.json({ ok: true, skipped: "migration 0072 not applied" });
    return NextResponse.json({ error: m.slice(0, 300) }, { status: 500 });
  }
}
