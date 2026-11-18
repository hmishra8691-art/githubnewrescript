import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { platformDb } from "@/lib/db";
import { loadDefinition } from "@/lib/analytics";
import { jobDepsFor } from "@/lib/modelJobs";
import { continueJob } from "@/lib/modelJobsCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MODEL RUNS (HB, latent class, SEM), FINISHED WITHOUT THE BROWSER (audit 2026-11-17, P2-14).
 *
 * `analytics_model_jobs` are chunked: each `continue` advances the chain ≤ 40 s from its saved state and takes a lease
 * on the row (optimistic, on `updated_at`). Until now only an open analysis page called `continue`, so an HB run of a
 * few thousand respondents stopped when the researcher closed the tab. This scheduler continues any `running` job with
 * no live lease that nobody has touched for STALE_MS — an open page keeps driving its own job and is never fought
 * (the lease makes a collision a no-op, not a double run). It is CPU only: no model provider is called.
 */
const BUDGET_MS = 48_000;
const STALE_MS = 60_000;
const SLICE_MS = 15_000;
const JOBS = 6;

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
  const db = platformDb();
  const now = new Date();
  const { data, error } = await db.from("analytics_model_jobs")
    .select("id, survey_id, created_by")
    .eq("status", "running")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .lt("updated_at", new Date(now.getTime() - STALE_MS).toISOString())
    .order("updated_at", { ascending: true })
    .limit(JOBS);
  if (error) return NextResponse.json({ ok: true, advanced: 0, note: `analytics_model_jobs not readable: ${error.message}` });
  let advanced = 0, finished = 0, failed = 0;
  const notes: string[] = [];
  for (const job of (data ?? []) as { id: string; survey_id: string; created_by: string | null }[]) {
    if (Date.now() - started > BUDGET_MS - SLICE_MS) break;
    try {
      const loaded = await loadDefinition(db as never, job.survey_id);
      if ("error" in loaded) { notes.push(`${job.id.slice(0, 8)}: ${loaded.error}`); continue; }
      const out = await continueJob(jobDepsFor(db as never, job.survey_id, loaded, job.created_by, { chunkMs: SLICE_MS }), job.id);
      advanced++;
      if (out.body.job?.status === "done") finished++;
      if (out.body.job?.status === "failed") failed++;
    } catch (e) {
      failed++;
      notes.push(`${job.id.slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return NextResponse.json({ ok: true, advanced, finished, failed, elapsedMs: Date.now() - started, notes });
}
