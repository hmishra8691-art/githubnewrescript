import "server-only";
import { NextResponse } from "next/server";
import type { Db } from "@/lib/db";
import { perDatabase } from "@/lib/perDatabase";
import { timingSafeEqual } from "node:crypto";
import { buildMediaStores } from "@rescript/media/server";
import { sweepVersionDefinitions } from "@/lib/definitionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * PUBLISHED VERSIONS → OBJECT STORAGE (scale readiness step 4, phase A; migration 0112).
 *
 * Every ten minutes, on every client database, copies the versions not yet in the definition store (gzipped,
 * content-addressed: lib/definitionStore.ts, @rescript/media definitions) and records each copy's hash. The first runs
 * after 0112 work through every existing version, a few at a time inside a time budget; after that each run finds
 * the handful cut since the last one. Nothing reads the copies yet (phase B), so a slow or failed run costs nothing
 * but time. A database without 0112 answers `skipped`.
 */
const BUDGET_MS = 40_000;

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

/* tenancy: once per client database (lib/perDatabase.ts), each with its own store */
async function run(req: Request): Promise<NextResponse> {
  return perDatabase((db) => runOn(db, req));
}

async function runOn(db: Db, req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  const store = buildMediaStores(db.storage as never).primary;
  const report = await sweepVersionDefinitions(db, store, { budgetMs: BUDGET_MS });
  if (report.failed.length) console.warn("[rescript:definitions] copies failed", JSON.stringify({ store: store.name, failed: report.failed.slice(0, 10) }));
  return NextResponse.json({ ok: report.failed.length === 0, store: store.name, ...report, failed: report.failed.slice(0, 20) }, { status: report.failed.some((f) => f.id === "*") ? 500 : 200 });
}
