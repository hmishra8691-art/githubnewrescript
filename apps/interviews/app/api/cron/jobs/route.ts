import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { drain } from "@/lib/runner";
import { emptySweepReport, sweepAbandonedUploads, sweepRetention, sweepOrphansEverywhere } from "@/lib/sweeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * THE ONLY THING IN RESCRIPT INTERVIEWS THAT RUNS WITHOUT A BROWSER.
 *
 * Every other path in this product is driven by somebody: a candidate
 * recording, a researcher uploading, a reviewer watching. Transcription is
 * not — it happens after everyone has closed the tab, which is exactly why the
 * survey product's transcription has never been reliable (its own cron route
 * says so: it is driven by an open tab) and why `interview_jobs` was built as
 * a real queue rather than a browser callback.
 *
 * ## The secret is required, not optional
 *
 * `CRON_SECRET` unset means this route refuses everything. An unauthenticated
 * endpoint that drains a queue is an endpoint anybody can use to spend the
 * wallet — so the safe failure is to do nothing, not to run for whoever asks.
 *
 * `timingSafeEqual` rather than `===`, for the same reason the Studio's cron
 * uses it: the comparison is against a secret, and a comparison that returns
 * early leaks its length and then its contents to somebody patient.
 *
 * ## Both verbs
 *
 * Vercel's scheduler issues a GET. A human debugging issues whatever curl
 * defaults to. Accepting both saves an afternoon and costs nothing, since the
 * secret is what actually gates it.
 */

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "This deployment has no database configured, so there is no queue to drain." },
      { status: 501 },
    );
  }

  const startedAt = Date.now();
  /*
   * Transcription first: analysis depends on it, and a pass that analyses
   * before transcribing would read an interview that is not ready and queue
   * itself again.
   */
  const report = await drain(["transcription", "analysis"]);

  /*
   * The sweeps run AFTER the queue, and only with time left over. Deleting
   * things is not urgent — an interview a few minutes past its retention window
   * is not an incident — while a transcript nobody is waiting on is a
   * researcher staring at "transcribing".
   *
   * The orphan sweep runs last and only with time left: it is the one that
   * deletes objects the database does not know about, so it gets the least
   * budget and the most hedging (see `sweepOrphans`).
   */
  const sweeps = emptySweepReport();
  if (Date.now() - startedAt < 120_000) {
    await sweepAbandonedUploads(sweeps);
    await sweepRetention(sweeps);
    /*
     * Now scheduled. It had no caller anywhere, so a lost row meant an object
     * kept for ever. Still per organization, still refusing if more than half
     * of what it sees looks unclaimed, still a hundred objects per pass — and
     * it yields the window before the function's own deadline.
     */
    await sweepOrphansEverywhere(sweeps, () => Date.now() - startedAt < 200_000);
  } else {
    sweeps.warnings.push("the queue took the whole window, so the sweeps were skipped this pass");
  }

  const ms = Date.now() - startedAt;

  /*
   * Logged as one line whatever happens, because the only way anybody learns
   * this ran is a log: there is no page, no user and nobody watching. A pass
   * that claimed nothing is still worth a line — a queue that is quiet and a
   * cron that is not firing look identical from the outside otherwise.
   */
  console.info("[rescript:interviews] cron drain", JSON.stringify({ ...report, ...sweeps, warnings: [...report.warnings, ...sweeps.warnings], ms }));

  return NextResponse.json({ ok: true, ...report, sweeps, ms }, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = run;
export const POST = run;
