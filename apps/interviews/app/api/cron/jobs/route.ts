import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { drain } from "@/lib/runner";

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
  const report = await drain(["transcription"]);
  const ms = Date.now() - startedAt;

  /*
   * Logged as one line whatever happens, because the only way anybody learns
   * this ran is a log: there is no page, no user and nobody watching. A pass
   * that claimed nothing is still worth a line — a queue that is quiet and a
   * cron that is not firing look identical from the outside otherwise.
   */
  console.info("[rescript:interviews] cron drain", JSON.stringify({ ...report, ms }));

  return NextResponse.json({ ok: true, ...report, ms }, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = run;
export const POST = run;
