import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { ExecTask } from "@rescript/engine";
import { supabaseService } from "@/lib/authServer";
import { backgroundContextFor, isRefused, refusalMessage } from "@/lib/copilot/background";
import { advanceJob } from "@/lib/qual/autoCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * QUALITATIVE JOBS, CONTINUED WITHOUT THE BROWSER (platform audit 2026-11-05, piping defect 8).
 *
 * `qual_jobs` rows carry `lease_until`, `status`, `progress` and `cursor` — the shape of resumable background
 * work, built that way in 0070 — and nothing advanced them except a Studio page polling the synthesis route.
 * Intelligent Mode got /api/cron/intelligent-tasks for exactly this and qualitative did not, so an auto-coding
 * run over a hundred transcripts stopped the moment the researcher closed the tab, and started again only when
 * somebody opened it.
 *
 * This is the same continuation path, under the same rules:
 *
 *   • a job is this job's business only when it is `queued` or `running` with no live lease and nobody has
 *     touched it for STALE_MS — the open page, when there is one, keeps driving its own job and is never fought;
 *   • the author's standing is decided by `backgroundContextFor`, exactly as for a durable Intelligent Mode task:
 *     an active account with edit rights on an unlocked project, the platform's own AI key (never a person's
 *     credential while they are asleep), and a wallet with room for one more slice. A refusal is written onto
 *     the job as its error so the panel says why it waits, and the job stays claimable for when it changes;
 *   • one bounded slice per job, a few jobs per run, a budget well inside the function's limit. `advanceJob`
 *     takes the lease, meters every model call, merges under the coding's version, and releases.
 *
 * Only `autocode` jobs are advanced here. A `transcribe_long` job needs the recording's bytes and the
 * speech-to-text precheck that only the upload request has; it is reported as skipped, not pretended at.
 */

const BUDGET_MS = 45_000;
/** a job nobody has touched for this long has no page driving it */
const STALE_MS = 2 * 60_000;
/** one job's slice, well inside BUDGET_MS so a second job gets a turn */
const SLICE_MS = 20_000;
const JOBS = 10;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

interface JobRow { id: string; survey_id: string; kind: string; status: string; created_by: string | null; lease_until: string | null; updated_at: string }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });

  const startedAt = Date.now();
  const db = supabaseService();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS).toISOString();

  const { data, error } = await db
    .from("qual_jobs")
    .select("id, survey_id, kind, status, created_by, lease_until, updated_at")
    .in("status", ["queued", "running"])
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .lt("updated_at", staleBefore)
    .order("created_at", { ascending: true })
    .limit(JOBS * 2);
  /* a database without 0070 has no such table: nothing to do, and said so rather than failed */
  if (error) return NextResponse.json({ ok: true, advanced: 0, paused: 0, skipped: 0, note: `qual_jobs not readable: ${error.message}` });

  let advanced = 0;
  let done = 0;
  let paused = 0;
  let skipped = 0;
  let failed = 0;
  const notes: string[] = [];

  for (const job of ((data ?? []) as JobRow[]).slice(0, JOBS)) {
    if (Date.now() - startedAt > BUDGET_MS - SLICE_MS) break;
    if (job.kind !== "autocode") { skipped++; continue; }
    if (!job.created_by) { skipped++; notes.push(`${job.id.slice(0, 8)}: no author to act for`); continue; }

    const pseudo = { id: job.id, surveyId: job.survey_id, createdBy: job.created_by, kind: "plan", request: "", status: "running", planVersion: 0, steps: [], deliverable: { kind: "none" } } as unknown as ExecTask;
    const bg = await backgroundContextFor(pseudo, { operation: "qual_coding" });
    if (isRefused(bg)) {
      paused++;
      const why = refusalMessage(bg.refused);
      await db.from("qual_jobs").update({ error: why.slice(0, 500) }).eq("id", job.id).eq("survey_id", job.survey_id);
      notes.push(`${job.id.slice(0, 8)}: ${bg.refused.kind}`);
      continue;
    }
    try {
      const r = await advanceJob(db, { userId: job.created_by, background: { ctx: bg.ctx, meter: bg.meter } }, job.survey_id, job.id, SLICE_MS);
      if (r.response) { paused++; continue; }
      advanced++;
      if (r.job?.status === "done") done++;
    } catch (e) {
      failed++;
      notes.push(`${job.id.slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  return NextResponse.json({ ok: true, advanced, done, paused, skipped, failed, elapsedMs: Date.now() - startedAt, notes: notes.slice(0, 20) });
}
