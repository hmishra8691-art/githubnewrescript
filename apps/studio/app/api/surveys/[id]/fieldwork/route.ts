import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { parseEnvironment } from "@/lib/responseData";
import { isFailure, requireProject } from "@/lib/guard";
import { chooseBucket, fieldPace, summariseSeries } from "@rescript/analytics";
import type { BucketSize, FieldBucket } from "@rescript/analytics";

export const dynamic = "force-dynamic";

/**
 * FIELDWORK OVER TIME (§26) AND LIVE MONITORING (§27).
 *
 *   GET ?environment=LIVE&hours=48&tz=Europe/London     the dashboard
 *   GET ?environment=LIVE&only=pulse                    the polled read
 *
 * Everything about fieldwork in this platform was dimensioned by something
 * other than time — by supplier (§23), by list (§24), by quota cell, by
 * status. This is the time dimension: the curve, the pace against the close
 * date, and what is happening right now.
 *
 * ## WHY TWO SHAPES AT ONE ADDRESS
 *
 * `only=pulse` exists because §27 is POLLED. The full payload runs a
 * gapless series and a drop-off distribution; the pulse is one row from one
 * index scan. A monitor refreshing every thirty seconds must not re-run the
 * chart it is not looking at, and a separate route would have meant a second
 * guard, a second environment parser and two places to keep in step.
 *
 * ## ENVIRONMENT IS REQUIRED, AND `ALL` IS REFUSED HERE
 *
 * Every per-response read in the platform requires the environment (0006).
 * This one goes further and refuses `ALL`, which the other fieldwork reads
 * accept by running twice and tagging the rows. A curve cannot do that
 * honestly: two environments summed into one series would put a programmer's
 * test session in the same bar as delivered interviews, and the number a
 * fieldwork manager reads off a chart is the number they report to a client.
 * Tagging instead would mean two series, which is a chart with two meanings.
 *
 * ## THE TIME ZONE COMES FROM THE BROWSER
 *
 * A "day" is the field team's day. The client sends its own zone and the
 * database buckets in it (0019). Unset, this falls back to UTC — and says so
 * in the payload, so a chart is never silently five and a half hours out.
 */

/** How far back the dashboard looks by default: two days, hourly. */
const DEFAULT_HOURS = 48;
/** 0019 refuses more than 2 000 buckets; this is the caller-facing bound. */
const MAX_HOURS = 24 * 400;

const BUCKETS = new Set<BucketSize>(["hour", "day", "week"]);

/**
 * A time zone name, loosely.
 *
 * The database is the real validator — it raises on a zone it does not know,
 * and 0019 makes that check deliberately — but a value that travels into an
 * RPC argument gets a shape check first.
 */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

const num = (v: string | null, fallback: number): number => {
  if (v === null || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Every fieldwork read degrades to an explicitly unavailable panel. */
const NEEDS_0019 = /rescript_field_(timeline|pulse|positions)|does not exist|schema cache/i;
const unavailable = (environment: string) =>
  NextResponse.json({
    available: false,
    environment,
    note: "Fieldwork over time needs migration 0019.",
  }, { headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  /*
   * `responses.read`, the same capability the supplier table and the quota
   * dashboard use — and deliberately WITHOUT the edit lock: a fieldwork
   * manager watching delivery is reading response data, and making them take
   * the questionnaire away from a programmer to do it would be absurd.
   */
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const q = req.nextUrl.searchParams;
  const environment = parseEnvironment(q.get("environment") ?? "LIVE");
  if (!environment) {
    return NextResponse.json({ error: "environment must be TEST or LIVE" }, { status: 400 });
  }
  if (environment === "ALL") {
    return NextResponse.json({
      error: "a fieldwork curve is one environment at a time — ask for TEST or LIVE",
    }, { status: 400 });
  }
  const isTest = environment === "TEST";

  const tz = q.get("tz")?.trim() || "UTC";
  if (!TZ_RE.test(tz)) {
    return NextResponse.json({ error: "tz must be an IANA time zone name" }, { status: 400 });
  }

  const activeSeconds = Math.min(Math.max(Math.floor(num(q.get("activeSeconds"), 900)), 60), 86_400);
  const windowMinutes = Math.min(Math.max(Math.floor(num(q.get("windowMinutes"), 60)), 5), 1440);

  const db = supabaseAdmin();

  /* ------------------------------------------------------------ the pulse */

  const pulseRes = await db.rpc("rescript_field_pulse", {
    p_survey: params.id,
    p_is_test: isTest,
    p_active_seconds: activeSeconds,
    p_window_minutes: windowMinutes,
  });
  if (pulseRes.error) {
    if (NEEDS_0019.test(pulseRes.error.message)) return unavailable(environment);
    return NextResponse.json({ error: pulseRes.error.message }, { status: 500 });
  }
  /* a survey with no responses at all still returns one row of zeroes */
  const pr = ((pulseRes.data ?? []) as Record<string, unknown>[])[0] ?? {};
  const pulse = {
    inField: Number(pr.in_field ?? 0),
    stalled: Number(pr.stalled ?? 0),
    windowMinutes: Number(pr.window_minutes ?? windowMinutes),
    windowStarts: Number(pr.window_starts ?? 0),
    windowCompletes: Number(pr.window_completes ?? 0),
    windowScreened: Number(pr.window_screened ?? 0),
    windowQuotaFull: Number(pr.window_quota_full ?? 0),
    windowTerminated: Number(pr.window_terminated ?? 0),
    windowMedianSeconds: pr.window_median_seconds == null ? null : Number(pr.window_median_seconds),
    totalStarts: Number(pr.total_starts ?? 0),
    totalCompletes: Number(pr.total_completes ?? 0),
    totalPartials: Number(pr.total_partials ?? 0),
    lastStartAt: (pr.last_start_at as string) ?? null,
    lastCompleteAt: (pr.last_complete_at as string) ?? null,
    lastActivityAt: (pr.last_activity_at as string) ?? null,
    activeSeconds,
  };

  /* ------------------------------------------------------- where they are */

  const posRes = await db.rpc("rescript_field_positions", {
    p_survey: params.id,
    p_is_test: isTest,
    p_active_seconds: activeSeconds,
  });
  if (posRes.error) {
    if (NEEDS_0019.test(posRes.error.message)) return unavailable(environment);
    return NextResponse.json({ error: posRes.error.message }, { status: 500 });
  }
  const positions = ((posRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    stepIndex: Number(r.step_index ?? 0),
    inField: Number(r.in_field ?? 0),
    stalled: Number(r.stalled ?? 0),
    oldestAt: (r.oldest_at as string) ?? null,
    newestAt: (r.newest_at as string) ?? null,
  }));

  if (q.get("only") === "pulse") {
    return NextResponse.json(
      { available: true, environment, tz, pulse, positions, fetchedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  }

  /* -------------------------------------------------------- the project */

  /*
   * The pace needs the §60 field window and the contracted number. The target
   * is the project's own if it has one, and otherwise the sum of what the
   * suppliers were contracted for — which is the number the fieldwork manager
   * is working to when nobody filled in the project panel.
   */
  const proj = await db
    .from("surveys")
    .select("fieldwork_from, fieldwork_to, due_date, client_name, project_manager, status")
    .eq("id", params.id)
    .maybeSingle();

  const project = proj.error
    ? { fieldworkFrom: null, fieldworkTo: null, dueDate: null, clientName: null, projectManager: null, status: null }
    : {
        fieldworkFrom: (proj.data?.fieldwork_from as string) ?? null,
        fieldworkTo: (proj.data?.fieldwork_to as string) ?? null,
        dueDate: (proj.data?.due_date as string) ?? null,
        clientName: (proj.data?.client_name as string) ?? null,
        projectManager: (proj.data?.project_manager as string) ?? null,
        status: (proj.data?.status as string) ?? null,
      };

  const targets = await db
    .from("sample_sources")
    .select("target_completes")
    .eq("survey_id", params.id);
  const supplierTarget = (targets.data ?? [])
    .reduce((t, r) => t + (Number(r.target_completes) || 0), 0);

  const requested = q.get("target");
  const target =
    requested != null && requested.trim() !== "" && Number.isFinite(Number(requested))
      ? Math.max(0, Math.floor(Number(requested)))
      : supplierTarget > 0 ? supplierTarget : null;

  /* ------------------------------------------------------------ the curve */

  const now = new Date();
  const hours = Math.min(Math.max(num(q.get("hours"), DEFAULT_HOURS), 1), MAX_HOURS);
  const to = q.get("to") ? new Date(q.get("to")!) : now;
  const from = q.get("from")
    ? new Date(q.get("from")!)
    : new Date(to.getTime() - hours * 3_600_000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return NextResponse.json({ error: "the window must run forwards" }, { status: 400 });
  }

  const asked = q.get("bucket");
  const bucket: BucketSize =
    asked && BUCKETS.has(asked as BucketSize)
      ? (asked as BucketSize)
      : chooseBucket(from.toISOString(), to.toISOString());

  const tl = await db.rpc("rescript_field_timeline", {
    p_survey: params.id,
    p_is_test: isTest,
    p_bucket: bucket,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: tz,
  });
  if (tl.error) {
    if (NEEDS_0019.test(tl.error.message)) return unavailable(environment);
    /*
     * 0019 raises `invalid_parameter_value` for a window it will not draw — an
     * unknown bucket, a backwards range, an absurd number of buckets, a zone
     * that does not exist. Those are the caller's fault and its message names
     * the fix, so it travels back as a 400 rather than becoming a 500.
     */
    const code = (tl.error as { code?: string }).code;
    if (code === "22023" || /narrow it|unknown bucket|not recognized|run forwards/i.test(tl.error.message)) {
      return NextResponse.json({ error: tl.error.message }, { status: 400 });
    }
    return NextResponse.json({ error: tl.error.message }, { status: 500 });
  }

  const timeline: FieldBucket[] = ((tl.data ?? []) as Record<string, unknown>[]).map((r) => ({
    bucketStart: r.bucket_start as string,
    starts: Number(r.starts ?? 0),
    completes: Number(r.completes ?? 0),
    screened: Number(r.screened ?? 0),
    quotaFull: Number(r.quota_full ?? 0),
    terminated: Number(r.terminated ?? 0),
    medianSeconds: r.median_seconds == null ? null : Number(r.median_seconds),
  }));

  /* -------------------------------------------------------------- the pace */

  /*
   * The observed rate comes from the recent window, not the whole field —
   * `fieldPace` explains why at length. The window used here is the last 24
   * hours of the series, or the whole series when it is shorter, so a
   * dashboard showing 48 hours predicts from the most recent 24.
   */
  const RECENT_HOURS = 24;
  const recentFrom = to.getTime() - RECENT_HOURS * 3_600_000;
  const inRecent = timeline.filter((b) => Date.parse(b.bucketStart) >= recentFrom);
  const seriesHours = (to.getTime() - from.getTime()) / 3_600_000;
  const recentHours = Math.min(RECENT_HOURS, seriesHours);
  const recentCompletes = inRecent.reduce((t, b) => t + b.completes, 0);

  const pace = fieldPace({
    completes: pulse.totalCompletes,
    target,
    fieldFrom: project.fieldworkFrom,
    fieldTo: project.fieldworkTo,
    /*
     * Only when the series actually covers the recent window. A dashboard
     * asked for "last 6 hours" has no basis for a 24-hour rate, and inventing
     * one from six hours of data is how a quiet afternoon becomes a projected
     * two-week overrun.
     */
    recentCompletes: inRecent.length ? recentCompletes : null,
    recentHours: inRecent.length ? recentHours : null,
    lastCompleteAt: pulse.lastCompleteAt,
    now: now.toISOString(),
  });

  return NextResponse.json({
    available: true,
    environment,
    tz,
    /* stated rather than assumed: an unset zone is a UTC chart, and says so */
    tzAssumed: !q.get("tz"),
    bucket,
    from: from.toISOString(),
    to: to.toISOString(),
    project,
    target,
    targetSource: requested ? "requested" : supplierTarget > 0 ? "suppliers" : null,
    timeline,
    summary: summariseSeries(timeline),
    pace,
    pulse,
    positions,
    fetchedAt: now.toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
