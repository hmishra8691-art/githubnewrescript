import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseService } from "@/lib/authServer";
import { storyDeps } from "@/lib/storyService";
import { pendingRenders, stepRender } from "@/lib/storyEngine";

/**
 * STORY VIDEOS KEEP RENDERING WITHOUT THE PANEL OPEN.
 *
 * Every minute: queued exports, and running ones whose lease has lapsed (a
 * closed tab, a timed-out function), are advanced — scenes rendered and
 * stored by content hash, so nothing done is done twice — until they are
 * checked and completed, or have failed three times. Authorised by
 * CRON_SECRET like the other jobs, and bounded in time.
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

async function run(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const db = supabaseService();
  const t0 = Date.now();
  const ids = await pendingRenders(db, 3);
  const done: { id: string; status: string }[] = [];
  for (const id of ids) {
    const left = 45_000 - (Date.now() - t0);
    if (left < 8_000) break;
    const r = await stepRender(db, id, storyDeps(db), Math.min(35_000, left - 5_000));
    done.push({ id, status: r.ok ? r.render.status : "error" });
  }
  return NextResponse.json({ advanced: done });
}

export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  return run(req);
}
export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  return run(req);
}
