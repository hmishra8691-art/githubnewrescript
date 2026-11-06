import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { assessAndStore, resolveRunDefinition, RESPONSE_COLUMNS } from "@rescript/quality/server";
import { supabaseService } from "@/lib/authServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * EVERY FINISHED RESPONSE ASSESSED (Intelligent Mode IM1, 2026-11-06).
 *
 * The runtime's save route assesses a response when it finishes — but inside a try/catch that keeps the answers
 * when the assessment fails, so a timeout, a peer read that failed or a deploy mid-request left the row with
 * `quality` null and nothing came back for it. The audit counted 57 such rows. This sweep picks them up:
 *
 *   • a row is this sweep's business when it is finished (not `in_progress`), not deleted, has no `quality`, and
 *     finished more than GRACE_MS ago — the save route's own assessment is never raced;
 *   • the definition is the one the session ran (`resolveRunDefinition`, exactly as the save route resolves it:
 *     the draft for a test session, the version otherwise); a definition with quality checks off is left alone and
 *     counted, never assessed against settings the researcher switched off;
 *   • `assessAndStore` is the same call the save route makes — peers, history, the stored assessment — so a row
 *     assessed here is indistinguishable from one assessed on arrival;
 *   • bounded: ROWS a run, inside BUDGET_MS, oldest first; what is left is the next run's.
 */

const BUDGET_MS = 45_000;
const GRACE_MS = 2 * 60_000;
const ROWS = 100;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route)
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(); }

async function run(): Promise<NextResponse> {
  const started = Date.now();
  const db = supabaseService();
  const before = new Date(Date.now() - GRACE_MS).toISOString();
  const { data, error } = await db
    .from("responses")
    .select(RESPONSE_COLUMNS + ", survey_id, version_id")
    .is("quality", null)
    .is("deleted_at", null)
    .neq("status", "in_progress")
    .lt("updated_at", before)
    .order("updated_at", { ascending: true })
    .limit(ROWS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as any[];
  const out = { found: rows.length, assessed: 0, off: 0, noDefinition: 0, failed: 0, left: 0, byClass: {} as Record<string, number> };
  const defs = new Map<string, Awaited<ReturnType<typeof resolveRunDefinition>> | null>();
  for (const row of rows) {
    if (Date.now() - started > BUDGET_MS) { out.left++; continue; }
    const key = `${row.survey_id}:${row.version_id}:${row.is_test ? 1 : 0}`;
    try {
      if (!defs.has(key)) defs.set(key, row.version_id ? await resolveRunDefinition(db, { survey_id: row.survey_id, version_id: row.version_id, is_test: !!row.is_test }, null) : null);
      const run = defs.get(key);
      if (!run?.def) { out.noDefinition++; continue; }
      if (!run.def.quality?.enabled) { out.off++; continue; }
      const a = await assessAndStore(db, run.def, row);
      out.assessed++;
      out.byClass[a.classification] = (out.byClass[a.classification] ?? 0) + 1;
    } catch (e) {
      out.failed++;
      console.error("[rescript:quality] sweep could not assess", { sessionId: String(row.session_id ?? "").slice(0, 8), error: (e as Error).message });
    }
  }
  console.info("[rescript:quality] sweep", JSON.stringify({ ...out, ms: Date.now() - started }));
  return NextResponse.json({ ok: true, ...out });
}
