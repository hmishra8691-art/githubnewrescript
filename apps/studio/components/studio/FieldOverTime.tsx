"use client";
import React from "react";
import type { FieldBucket, Pace } from "@rescript/analytics";
import { describePace } from "@rescript/analytics";

type Env = "TEST" | "LIVE";
type Bucket = "hour" | "day" | "week";

interface Pulse {
  inField: number;
  stalled: number;
  windowMinutes: number;
  windowStarts: number;
  windowCompletes: number;
  windowScreened: number;
  windowQuotaFull: number;
  windowTerminated: number;
  windowMedianSeconds: number | null;
  totalStarts: number;
  totalCompletes: number;
  totalPartials: number;
  lastStartAt: string | null;
  lastCompleteAt: string | null;
  lastActivityAt: string | null;
  activeSeconds: number;
}

interface Position {
  stepIndex: number;
  inField: number;
  stalled: number;
  oldestAt: string | null;
  newestAt: string | null;
}

interface Payload {
  available: boolean;
  environment: Env;
  tz: string;
  tzAssumed?: boolean;
  bucket: Bucket;
  from: string;
  to: string;
  project: {
    fieldworkFrom: string | null;
    fieldworkTo: string | null;
    dueDate: string | null;
    clientName: string | null;
    projectManager: string | null;
    status: string | null;
  };
  target: number | null;
  targetSource: "requested" | "suppliers" | null;
  timeline: FieldBucket[];
  summary: {
    starts: number; completes: number; screened: number; quotaFull: number;
    terminated: number; incidence: number | null; peak: FieldBucket | null; quietBuckets: number;
  };
  pace: Pace;
  pulse: Pulse;
  positions: Position[];
  note?: string;
}

/** The dashboard's own refresh, matching the quota dashboard's cadence. */
const REFRESH_MS = 30_000;

const RANGES: { label: string; hours: number }[] = [
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "90d", hours: 24 * 90 },
];

/**
 * FIELDWORK OVER TIME (§26) AND LIVE MONITORING (§27).
 *
 * Every fieldwork figure in this platform was dimensioned by something other
 * than time. This is the missing dimension, and it is two questions, not one:
 *
 *   §26  ARE WE GOING TO MAKE IT?   the curve, and the pace against the close
 *                                   date — a planning question, answered by
 *                                   a chart somebody looks at once a day
 *   §27  IS IT WORKING RIGHT NOW?   who is in field this minute, what has
 *                                   arrived in the last hour, where people
 *                                   are stopping — an operations question,
 *                                   answered by numbers that must be current
 *
 * They share a screen because a fieldwork manager holds both at once, and
 * they share a route (`/api/surveys/[id]/fieldwork`) because they read the
 * same rows. But only the second is POLLED: `only=pulse` re-reads the live
 * half every thirty seconds while the tab is visible, and the chart is left
 * alone until somebody changes the window. Re-running a gapless 90-day series
 * twice a minute to update a counter would be indefensible.
 *
 * ## WHAT THIS COMPONENT REFUSES TO DO
 *
 * It does not smooth the curve, and it does not draw a trend line through it.
 * A fieldwork curve is lumpy because fieldwork is lumpy — a supplier sends a
 * batch, a quota closes, a soft launch is held back — and every one of those
 * lumps is a thing that happened, which somebody may need to explain to a
 * client. A smoothed line hides exactly the shape it is being read for.
 *
 * It also does not name the step a respondent is sitting on with any
 * confidence. See the note by the drop-off table.
 */
export function FieldOverTime({
  surveyId, env, pageLabels,
}: {
  surveyId: string | null;
  env: Env;
  /** page labels from the CURRENT draft, in flow order — indicative only */
  pageLabels: string[];
}) {
  const [data, setData] = React.useState<Payload | null>(null);
  const [hours, setHours] = React.useState(48);
  const [bucket, setBucket] = React.useState<Bucket | "auto">("auto");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  /*
   * The browser's own zone, so "today" means the field team's today. Read
   * once — it cannot change while the tab is open, and reading it during
   * render would make the first server-rendered pass disagree with the
   * client's.
   */
  const tz = React.useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  }, []);

  const url = React.useCallback((only?: "pulse") => {
    const p = new URLSearchParams({ environment: env, tz });
    if (only) p.set("only", only);
    else {
      p.set("hours", String(hours));
      if (bucket !== "auto") p.set("bucket", bucket);
    }
    return `/api/surveys/${surveyId}/fieldwork?${p.toString()}`;
  }, [surveyId, env, tz, hours, bucket]);

  /** The whole payload: chart, pace, project, live half. */
  const refreshAll = React.useCallback(() => {
    if (!surveyId) return;
    setLoading(true);
    fetch(url(), { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!ok) { setError(body?.error ?? "Fieldwork could not be read."); return; }
        setError(null);
        setData(body as Payload);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [surveyId, url]);

  /**
   * The live half only.
   *
   * Merged into whatever payload is already on screen, so the chart does not
   * flicker and the pace sentence does not change under the reader every
   * thirty seconds — the numbers that are supposed to move, move.
   */
  const refreshPulse = React.useCallback(() => {
    if (!surveyId) return;
    fetch(url("pulse"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body?.available) return;
        setData((d) => (d ? { ...d, pulse: body.pulse, positions: body.positions } : d));
      })
      .catch(() => { /* a failed poll is not worth a banner; the next one will say */ });
  }, [surveyId, url]);

  React.useEffect(refreshAll, [refreshAll]);

  React.useEffect(() => {
    /*
     * Visibility-gated, like the quota dashboard: a tab left open overnight
     * must not spend the night polling, and must be current the moment
     * somebody looks at it again.
     */
    const tick = () => { if (document.visibilityState === "visible") refreshPulse(); };
    const t = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [refreshPulse]);

  if (!data && !error) {
    return <div className="muted" style={{ fontSize: 13, margin: "6px 0 14px" }} data-testid="fw-time-loading">Reading fieldwork…</div>;
  }
  if (error) {
    return <div className="chip warn qd-note" data-testid="fw-time-error">{error}</div>;
  }
  if (data && !data.available) {
    return (
      <div className="chip warn qd-note" data-testid="fw-time-migration">
        {data.note ?? "Fieldwork over time needs migration 0019."}
      </div>
    );
  }
  const d = data!;
  const p = d.pace;

  return (
    <div data-testid="fw-over-time">
      {/* ============================================ §27 — right now */}
      <LiveHalf pulse={d.pulse} positions={d.positions} pageLabels={pageLabels} env={env} />

      {/* ============================================ §26 — the pace */}
      <div className="row" style={{ margin: "16px 0 8px", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--subtle)" }}>
          Progress
        </h3>
        <span className={`qd-state ${verdictClass(p.verdict)}`} data-testid="fw-verdict">{verdictLabel(p.verdict)}</span>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="fw-range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              className={`btn small ${hours === r.hours ? "primary" : ""}`}
              data-testid={`fw-range-${r.label}`}
              onClick={() => setHours(r.hours)}
            >{r.label}</button>
          ))}
        </div>
        <select
          className="select small" value={bucket} data-testid="fw-bucket"
          onChange={(e) => setBucket(e.target.value as Bucket | "auto")}
          aria-label="Bucket size"
        >
          <option value="auto">Auto ({d.bucket})</option>
          <option value="hour">Hourly</option>
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
        </select>
        <button className="btn small" onClick={refreshAll} disabled={loading} data-testid="fw-time-refresh">↻</button>
      </div>

      <p style={{ margin: "0 0 10px", fontSize: 14 }} data-testid="fw-pace-sentence">{describePace(p)}</p>

      {p.target !== null && (
        <div className="qd-total" data-testid="fw-target-bar">
          <span className="muted">Delivered</span>
          <div className="qbar qd-bar" role="progressbar"
            aria-valuenow={Math.round((p.delivered ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={p.verdict === "behind" || p.verdict === "stalled" ? "near" : ""}
              style={{ width: `${Math.min(100, (p.delivered ?? 0) * 100)}%` }} />
          </div>
          <strong>{p.completes.toLocaleString()}</strong>
          <span className="muted">/ {p.target.toLocaleString()}</span>
          <span className="muted">
            {d.targetSource === "suppliers" ? "target from supplier contracts" : "target"}
          </span>
        </div>
      )}

      {/*
        * The field window, stated. A pace verdict is meaningless without the
        * dates it was computed against, and a project with no dates gets told
        * so rather than getting a confident-looking chip.
        */}
      <div className="row qd-config-facts" style={{ marginBottom: 10 }} data-testid="fw-window">
        {d.project.fieldworkFrom || d.project.fieldworkTo ? (
          <span className="chip">
            In field {d.project.fieldworkFrom ?? "—"} → {d.project.fieldworkTo ?? "—"}
            {p.elapsed !== null && ` · ${Math.round(p.elapsed * 100)}% elapsed`}
          </span>
        ) : (
          <span className="chip warn" data-testid="fw-no-window">
            No fieldwork dates on this project — pace cannot be judged. Set them under Project.
          </span>
        )}
        {p.projectedFinish && (
          <span className="chip" data-testid="fw-projection">
            At the last 24 hours&apos; rate, finishing {new Date(p.projectedFinish).toLocaleDateString()}
          </span>
        )}
        {d.project.dueDate && <span className="chip">Due {d.project.dueDate}</span>}
      </div>

      {/* ============================================ §26 — the curve */}
      <Curve
        buckets={d.timeline}
        bucket={d.bucket}
        tz={d.tz}
        requiredPerBucket={requiredPerBucket(p.requiredPerDay, d.bucket)}
      />

      <div className="row qd-config-facts" style={{ marginTop: 6, marginBottom: 4 }} data-testid="fw-series-summary">
        <span className="chip">{d.summary.starts.toLocaleString()} started</span>
        <span className="chip">{d.summary.completes.toLocaleString()} completed</span>
        <span className="chip">{d.summary.screened.toLocaleString()} screened out</span>
        {d.summary.incidence !== null && <span className="chip">{d.summary.incidence}% incidence</span>}
        {d.summary.peak && (
          <span className="chip">
            Best {d.bucket}: {d.summary.peak.completes.toLocaleString()} ({bucketLabel(d.summary.peak.bucketStart, d.bucket)})
          </span>
        )}
        {d.summary.quietBuckets > 0 && (
          <span className="chip">{d.summary.quietBuckets} quiet {d.bucket}{d.summary.quietBuckets === 1 ? "" : "s"}</span>
        )}
      </div>

      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px", lineHeight: 1.5 }}>
        Bucketed in <strong>{d.tz}</strong>{d.tzAssumed ? " (assumed — your browser did not report a zone)" : ""}.
        A start is counted when the respondent arrived and an outcome when they finished, so the two columns do not
        add up to each other — somebody who started at 10:58 and finished at 11:03 is a start in one bucket and a
        complete in the next. Buckets with no activity are shown as gaps rather than skipped, because a dead hour is
        the thing worth seeing.
      </p>
    </div>
  );
}

/* ==================================================================== §27 */

function LiveHalf({
  pulse, positions, pageLabels, env,
}: { pulse: Pulse; positions: Position[]; pageLabels: string[]; env: Env }) {
  const quiet = pulse.lastCompleteAt
    ? (Date.now() - Date.parse(pulse.lastCompleteAt)) / 3_600_000
    : null;
  const activeMinutes = Math.round(pulse.activeSeconds / 60);
  const totalStalled = positions.reduce((t, r) => t + r.stalled, 0);

  return (
    <div data-testid="fw-live">
      <div className="row" style={{ margin: "4px 0 8px", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--subtle)" }}>
          Right now
        </h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {env === "TEST" ? "test" : "live"} · refreshes every 30 seconds while this tab is visible
        </span>
      </div>

      <div className="qd-summary" data-testid="fw-live-tiles">
        <div className="qd-stat">
          <span className="qd-stat-n" data-testid="fw-in-field">{pulse.inField}</span>
          <span className="qd-stat-l">In field now</span>
        </div>
        <div className="qd-stat">
          <span className="qd-stat-n" data-testid="fw-window-completes">{pulse.windowCompletes}</span>
          <span className="qd-stat-l">Completes / {pulse.windowMinutes}m</span>
        </div>
        <div className="qd-stat">
          <span className="qd-stat-n">{pulse.windowStarts}</span>
          <span className="qd-stat-l">Starts / {pulse.windowMinutes}m</span>
        </div>
        <div className="qd-stat">
          <span className={`qd-stat-n ${pulse.windowScreened > pulse.windowCompletes ? "near" : ""}`}>{pulse.windowScreened}</span>
          <span className="qd-stat-l">Screened / {pulse.windowMinutes}m</span>
        </div>
        <div className="qd-stat">
          <span className="qd-stat-n muted">{fmtDuration(pulse.windowMedianSeconds)}</span>
          <span className="qd-stat-l">Median length</span>
        </div>
        <div className="qd-stat">
          <span className="qd-stat-n muted" data-testid="fw-stalled">{pulse.stalled}</span>
          <span className="qd-stat-l">Stalled partials</span>
        </div>
      </div>

      {/*
        * The one alarm on this page. It fires on the LAST COMPLETE rather than
        * on the last activity, because a hundred people arriving and nobody
        * finishing is the failure mode that looks healthy on an activity
        * counter — a broken question on page three keeps every session very
        * busy indeed.
        */}
      {quiet !== null && quiet >= 6 && (
        <div className="chip warn qd-note" data-testid="fw-stall-warning">
          No completes for {quiet.toFixed(1)} hours, and {pulse.inField} respondent{pulse.inField === 1 ? "" : "s"} in
          field. That pattern usually means a question is failing rather than that sample has run out — check the
          drop-off below before asking for more sample.
        </div>
      )}

      <div className="row qd-config-facts" style={{ marginBottom: 4 }} data-testid="fw-live-facts">
        <span className="chip">Last complete {fmtAgo(pulse.lastCompleteAt)}</span>
        <span className="chip">Last start {fmtAgo(pulse.lastStartAt)}</span>
        <span className="chip">{pulse.totalCompletes.toLocaleString()} completes all told</span>
        <span className="chip">{pulse.totalPartials.toLocaleString()} partials</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          &ldquo;In field&rdquo; means a partial touched in the last {activeMinutes} minutes.
        </span>
      </div>

      {/* --------------------------------------------------- the drop-off */}
      {positions.length > 0 && (
        <details className="card" style={{ padding: "8px 12px", marginTop: 6 }} data-testid="fw-dropoff">
          <summary style={{ cursor: "pointer", fontSize: 13.5 }}>
            Where the {(pulse.inField + totalStalled).toLocaleString()} open sessions are sitting
          </summary>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Step</th><th className="num">In field</th><th className="num">Stalled</th><th>Oldest</th></tr>
            </thead>
            <tbody>
              {positions
                .slice()
                .sort((a, b) => (b.inField + b.stalled) - (a.inField + a.stalled))
                .map((r) => (
                  <tr key={r.stepIndex} data-testid="fw-dropoff-row" data-step={r.stepIndex}>
                    <td>
                      Step {r.stepIndex + 1}
                      {pageLabels[r.stepIndex] && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 12.5 }}>
                          {pageLabels[r.stepIndex]}
                        </span>
                      )}
                    </td>
                    <td className="num">{r.inField || "—"}</td>
                    <td className="num">{r.stalled || "—"}</td>
                    <td className="muted">{fmtAgo(r.oldestAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {/*
            * Stated, not hidden. A step index is a position in the flow that
            * was COMPILED for that respondent, against the version they were
            * served: page randomisation, skipped pages and an older published
            * version all move it. The name beside it is this draft's page at
            * the same position — useful, and not a promise.
            */}
          <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 2px", lineHeight: 1.5 }}>
            The page names are this draft&apos;s pages at the same position, shown as a hint. A respondent&apos;s step
            number comes from the flow compiled for them against the version they were served, so randomised or skipped
            pages — and anyone still in an older version — can sit at the same number on a different page.
          </p>
        </details>
      )}
    </div>
  );
}

/* ================================================================== curve */

/**
 * The curve, as an inline SVG.
 *
 * Deliberately hand-drawn rather than routed through the analytics chart
 * renderers: those take an `AnalysisResult` over a dataset, and this is a
 * server-computed series with a fixed shape. Borrowing that machinery would
 * mean inventing a dataset to hold six columns of counts.
 *
 * Stacked, in the order somebody reads them: completes at the bottom because
 * that is the number being counted, then screen-outs, then the other
 * terminals. Starts are drawn as an outline over the stack rather than as
 * another bar — they are the population the outcomes came from, not a
 * seventh category, and a grouped chart of seven series at 90 buckets is
 * unreadable.
 */
function Curve({
  buckets, bucket, tz, requiredPerBucket,
}: { buckets: FieldBucket[]; bucket: Bucket; tz: string; requiredPerBucket: number | null }) {
  if (!buckets.length) {
    return <div className="card muted" style={{ padding: 14, fontSize: 13 }} data-testid="fw-curve-empty">
      Nothing in this window yet.
    </div>;
  }

  const W = 900, H = 180, PAD_L = 34, PAD_B = 22, PAD_T = 8;
  const plotW = W - PAD_L - 6;
  const plotH = H - PAD_B - PAD_T;

  const totalOf = (b: FieldBucket) => b.completes + b.screened + b.quotaFull + b.terminated;
  const max = Math.max(
    1,
    ...buckets.map((b) => Math.max(totalOf(b), b.starts)),
    requiredPerBucket && Number.isFinite(requiredPerBucket) ? Math.ceil(requiredPerBucket) : 0,
  );
  const bw = plotW / buckets.length;
  const barW = Math.max(1, Math.min(28, bw * 0.72));
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const x = (i: number) => PAD_L + i * bw + (bw - barW) / 2;

  /* six ticks at most, always including the first and last bucket */
  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = buckets.map((b, i) => ({ b, i })).filter(({ i }) => i % step === 0 || i === buckets.length - 1);

  const segments = (b: FieldBucket) => [
    { n: b.completes, fill: "var(--green)", name: "completed" },
    { n: b.screened, fill: "var(--amber)", name: "screened out" },
    { n: b.quotaFull, fill: "var(--accent2)", name: "quota full" },
    { n: b.terminated, fill: "var(--red)", name: "terminated" },
  ];

  return (
    <div className="card" style={{ padding: "6px 8px", overflowX: "auto" }} data-testid="fw-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
        role="img"
        aria-label={`Completes per ${bucket}, ${buckets.length} buckets, peak ${max} in the busiest`}
      >
        {/* y axis: nothing but zero and the maximum. A fieldwork curve is read
            for its shape and its peak; four intermediate gridlines are noise. */}
        <line x1={PAD_L} y1={y(0)} x2={W - 4} y2={y(0)} stroke="var(--border)" />
        <text x={4} y={y(max) + 4} fontSize="10" fill="var(--subtle)">{max}</text>
        <text x={4} y={y(0) + 4} fontSize="10" fill="var(--subtle)">0</text>

        {requiredPerBucket !== null && Number.isFinite(requiredPerBucket) && requiredPerBucket > 0 && (
          <>
            <line
              x1={PAD_L} y1={y(requiredPerBucket)} x2={W - 4} y2={y(requiredPerBucket)}
              stroke="var(--accent)" strokeDasharray="4 3" strokeWidth="1"
            />
            <text x={W - 6} y={y(requiredPerBucket) - 3} fontSize="10" textAnchor="end" fill="var(--accent)">
              {Math.round(requiredPerBucket * 10) / 10} needed / {bucket}
            </text>
          </>
        )}

        {buckets.map((b, i) => {
          let acc = 0;
          const total = totalOf(b);
          return (
            <g key={b.bucketStart} data-testid="fw-curve-bucket" data-bucket={b.bucketStart}>
              <title>
                {`${bucketLabel(b.bucketStart, bucket)} — ${b.starts} started, ${b.completes} completed`
                  + `${b.screened ? `, ${b.screened} screened` : ""}`
                  + `${b.quotaFull ? `, ${b.quotaFull} quota full` : ""}`
                  + `${b.terminated ? `, ${b.terminated} terminated` : ""}`}
              </title>
              {segments(b).map((sg) => {
                if (sg.n <= 0) return null;
                const h = (sg.n / max) * plotH;
                acc += sg.n;
                return (
                  <rect
                    key={sg.name} x={x(i)} width={barW}
                    y={y(acc)} height={Math.max(0.5, h)} fill={sg.fill}
                  />
                );
              })}
              {/* the starts outline: the population, not a category */}
              {b.starts > 0 && (
                <rect
                  x={x(i) - 1.5} width={barW + 3} y={y(b.starts)} height={Math.max(0.5, (b.starts / max) * plotH)}
                  fill="none" stroke="var(--subtle)" strokeWidth="1" strokeDasharray="2 2" opacity="0.7"
                />
              )}
              {total === 0 && b.starts === 0 && (
                /* a visible gap, so a dead bucket reads as dead rather than as
                   the axis it is sitting on */
                <rect x={x(i)} width={barW} y={y(0) - 1} height={1} fill="var(--border)" />
              )}
            </g>
          );
        })}

        {ticks.map(({ b, i }) => (
          <text
            key={b.bucketStart} x={PAD_L + i * bw + bw / 2} y={H - 6}
            fontSize="10" textAnchor="middle" fill="var(--subtle)"
          >{bucketLabel(b.bucketStart, bucket)}</text>
        ))}
      </svg>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", fontSize: 12, padding: "2px 4px 4px" }}>
        <Key fill="var(--green)" label="completed" />
        <Key fill="var(--amber)" label="screened out" />
        <Key fill="var(--accent2)" label="quota full" />
        <Key fill="var(--red)" label="terminated" />
        <span className="muted">dashed outline = started · times in {tz}</span>
      </div>
    </div>
  );
}

const Key = ({ fill, label }: { fill: string; label: string }) => (
  <span className="row" style={{ gap: 4, alignItems: "center" }}>
    <span style={{ width: 10, height: 10, background: fill, borderRadius: 2, display: "inline-block" }} />
    <span className="muted">{label}</span>
  </span>
);

/* ================================================================ helpers */

/** The required daily rate, expressed per bucket, so the line is comparable. */
function requiredPerBucket(perDay: number | null, bucket: Bucket): number | null {
  if (perDay === null || !Number.isFinite(perDay)) return null;
  if (bucket === "hour") return perDay / 24;
  if (bucket === "week") return perDay * 7;
  return perDay;
}

function bucketLabel(iso: string, bucket: Bucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (bucket === "hour") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  return m >= 1 ? `${m}m` : `${Math.round(secs)}s`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = (Date.now() - t) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const h = mins / 60;
  if (h < 24) return `${h.toFixed(1)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function verdictLabel(v: Pace["verdict"]): string {
  return { done: "Target met", ahead: "Ahead", on_track: "On track", behind: "Behind", stalled: "Stalled", unknown: "No pace yet" }[v];
}
function verdictClass(v: Pace["verdict"]): string {
  return { done: "active", ahead: "active", on_track: "active", behind: "near", stalled: "full", unknown: "inactive" }[v];
}
