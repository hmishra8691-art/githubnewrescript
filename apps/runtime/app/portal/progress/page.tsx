"use client";
import React from "react";
import { begin, portalApi, when } from "@/components/portal/api";
import { Note, Shell } from "@/components/portal/Shell";
import { TrendCard, type Trend } from "@/components/portal/Trend";
import { NOTE_NOT_ADVICE } from "@/lib/portal/words";

interface Track { title: string; series: boolean; assessments: { id: string; title: string; period: string | null }[]; results: number; trends: Trend[]; nextDue: { at: string; overdue: boolean; assessmentId: string } | null }

/** MY PROGRESS (phase 3): the signed-in person's own results over time. */
export default function PortalProgress() {
  const [tracks, setTracks] = React.useState<Track[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { void portalApi<{ tracks: Track[] }>("progress").then((r) => (r.ok ? setTracks(r.data.tracks) : r.error.status !== 401 && setError(r.error.error))); }, []);
  return (
    <Shell current="overview">
      <p className="pt-noprint"><a href="/portal">← Overview</a></p>
      <h1>My progress</h1>
      <p className="pt-lead">How your results have changed over time.</p>
      {error && <Note kind="bad">{error}</Note>}
      {!tracks && !error && <p className="pt-empty">Loading…</p>}
      {tracks && !tracks.length && <div className="pt-card pt-empty" data-testid="pt-no-progress">There is nothing to show over time yet. Results appear here when an assessment you have completed shares them.</div>}
      {tracks?.map((t) => (
        <section key={t.title + t.assessments.map((a) => a.id).join()} data-testid="pt-track">
          <h2>{t.title}</h2>
          <p className="pt-why" style={{ margin: "0 0 10px" }}>
            {t.results} result{t.results === 1 ? "" : "s"}{t.series && t.assessments.length > 1 ? ` across ${t.assessments.length} assessments` : ""}.
            {t.nextDue && <> {t.nextDue.overdue ? "The next one is due now." : `The next one is due ${when(t.nextDue.at)}.`}</>}
          </p>
          {t.nextDue?.overdue && <p className="pt-noprint"><button type="button" className="pt-btn is-primary" onClick={() => begin(t.nextDue!.assessmentId, setError)} data-testid="pt-due-start">Take it now</button></p>}
          <div className="pt-card"><ul className="pt-answers pt-scores">{t.trends.map((x) => <TrendCard key={x.id} t={x} />)}</ul></div>
        </section>
      ))}
      {tracks && tracks.length > 0 && (
        <>
          <p className="pt-why" style={{ marginTop: 14 }}>A change is shown only between results that were scored the same way. It describes your own answers at two points in time and says nothing about the cause. {NOTE_NOT_ADVICE}</p>
          <p className="pt-noprint"><button type="button" className="pt-btn" onClick={() => window.print()}>Print</button></p>
        </>
      )}
    </Shell>
  );
}
