import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runReminders } from "@/lib/portalNotify";

/**
 * RESPONDENT PORTAL REMINDERS (phase 6, 2026-11-20) — hourly: for every live survey with a portal, the people whose
 * next assessment is due, or whose assessment closes within two days and is not done, are told once: a portal
 * notification, and an email when they have an address. Authorised by CRON_SECRET like the other jobs, and refuses
 * everything when the variable is unset. A database without migration 0106 answers 200 with `skipped`.
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
  const started = Date.now();
  try {
    return NextResponse.json({ ok: true, ...(await runReminders()), elapsedMs: Date.now() - started });
  } catch (e) {
    const m = (e as Error).message;
    if (/portal_notifications|account_id|does not exist|schema cache/i.test(m)) return NextResponse.json({ ok: true, skipped: "migrations 0103 / 0106 not applied" });
    return NextResponse.json({ error: m.slice(0, 300) }, { status: 500 });
  }
}
