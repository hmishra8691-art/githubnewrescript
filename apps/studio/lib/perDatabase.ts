import "server-only";
import { NextResponse } from "next/server";
import { everyDatabase, type Db } from "./db";

/**
 * A CRON ON EVERY CLIENT DATABASE (tenancy step 5, 2026-11-20).
 *
 * A sweep that used to read "the database" now runs once per client database (`everyDatabase()`: the primary alone
 * today, so the reply is exactly the one the sweep always gave). With several databases the replies are gathered
 * under `databases`, and the status is the worst one seen — a sweep that failed somewhere is not reported as fine.
 */
export async function perDatabase(run: (db: Db) => Promise<NextResponse>): Promise<NextResponse> {
  const targets = everyDatabase();
  if (targets.length === 1) return run(targets[0]!.db);
  const databases: Record<string, unknown>[] = [];
  let status = 200;
  for (const t of targets) {
    const r = await run(t.db);
    status = Math.max(status, r.status);
    databases.push({ database: t.id, status: r.status, ...((await r.json().catch(() => ({}))) as Record<string, unknown>) });
  }
  return NextResponse.json({ ok: status < 400, databases }, { status });
}
