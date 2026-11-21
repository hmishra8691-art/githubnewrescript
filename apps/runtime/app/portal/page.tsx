"use client";
import React from "react";
import { begin, portalApi, when } from "@/components/portal/api";
import { Note, Shell } from "@/components/portal/Shell";

interface Card { id: string; title: string; state: string; canStart: boolean; canResume: boolean; attemptsLeft: number | null; reason: string | null; opensAt: string | null; closesAt: string | null; attempts: number; lastCompletedAt: string | null; canViewAnswers: boolean; canViewScores?: boolean; canViewTrends?: boolean; nextDue?: { at: string; overdue: boolean } | null; look: { template: string | null; name: string | null; words: { one: string; start: string; again: string }; accent: string } }
interface Me { account: { respondentId: string; name: string | null }; assessments: Card[]; consent?: { needed: boolean; version: string; title: string; paragraphs: string[] } }

const LABEL: Record<string, string> = { open: "To do", in_progress: "In progress", upcoming: "Opens soon", completed: "Completed", closed: "Closed", suspended: "Paused" };

function Tile({ c, onError }: { c: Card; onError: (m: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const go = async () => { setBusy(true); await begin(c.id, onError); setBusy(false); };
  return (
    <article className="pt-card pt-tile" data-testid={`pt-card-${c.state}`} style={{ "--pt-brand": c.look.accent } as React.CSSProperties}>
      <span className={`pt-chip is-${c.state}`}>{LABEL[c.state] ?? c.state}</span>
      {c.look.template && <span className="pt-kind" data-testid="pt-kind">{c.look.words.one}</span>}
      <h3>{c.title}</h3>
      <div className="pt-meta">
        {c.state === "upcoming" && c.opensAt && <div>Opens {when(c.opensAt, true)}</div>}
        {(c.state === "open" || c.state === "in_progress") && c.closesAt && <div>Open until {when(c.closesAt, true)}</div>}
        {c.lastCompletedAt && <div>Completed {when(c.lastCompletedAt)}</div>}
        {c.attempts > 1 && <div>{c.attempts} attempts</div>}
        {c.canStart && c.attempts > 0 && c.attemptsLeft !== null && <div>{c.attemptsLeft} {c.attemptsLeft === 1 ? "attempt" : "attempts"} left</div>}
        {c.nextDue && <div data-testid="pt-next-due">{c.nextDue.overdue ? "The next one is due now" : `Next one due ${when(c.nextDue.at)}`}</div>}
        {c.reason && <div>{c.reason}</div>}
      </div>
      <div className="pt-actions">
        {c.canResume && <button type="button" className="pt-btn is-primary" onClick={go} disabled={busy} data-testid="pt-resume">Continue</button>}
        {c.canStart && <button type="button" className="pt-btn is-primary" onClick={go} disabled={busy} data-testid="pt-start">{c.attempts > 0 ? c.look.words.again : c.look.words.start}</button>}
        {c.attempts > 0 && <a className="pt-btn" href={`/portal/assessments/${c.id}`} data-testid="pt-view">{c.canViewScores ? "View my results" : c.canViewAnswers ? "View my answers" : "Details"}</a>}
      </div>
    </article>
  );
}

export default function PortalOverview() {
  const [me, setMe] = React.useState<Me | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => portalApi<Me>("me").then((r) => (r.ok ? setMe(r.data) : r.error.status !== 401 && setError(r.error.error))), []);
  React.useEffect(() => { void load(); }, [load]);
  const [agreed, setAgreed] = React.useState(false);
  const agree = async () => { const r = await portalApi("me", { action: "consent", version: me!.consent!.version }); if (r.ok) await load(); else setError(r.error.error); };

  const todo = (me?.assessments ?? []).filter((c) => ["open", "in_progress", "upcoming"].includes(c.state));
  const done = (me?.assessments ?? []).filter((c) => !["open", "in_progress", "upcoming"].includes(c.state));
  return (
    <Shell current="overview" who={me?.account}>
      <h1>{me?.account.name ? `Welcome, ${me.account.name}` : "Welcome"}</h1>
      <p className="pt-lead">Your assessments, and what you have completed.</p>
      {me?.assessments.some((c) => c.canViewTrends) && <p><a className="pt-btn" href="/portal/progress" data-testid="pt-progress">My progress over time</a></p>}
      {error && <Note kind="bad">{error}</Note>}
      {!me && !error && <p className="pt-empty">Loading…</p>}
      {me?.consent?.needed && (
        <div className="pt-card pt-notice" data-testid="pt-consent">
          <p className="pt-q">{me.consent.title}</p>
          {me.consent.paragraphs.map((t, i) => <p key={i}>{t}</p>)}
          <label className="pt-check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="pt-agree" /> <span>I have read this and agree.</span></label>
          <p style={{ margin: "10px 0 0" }}><button type="button" className="pt-btn is-primary" disabled={!agreed} onClick={agree} data-testid="pt-consent-give">Continue</button></p>
        </div>
      )}
      {me && !me.assessments.length && !me.consent?.needed && <div className="pt-card pt-empty" data-testid="pt-none">You have no assessments at the moment. When one is assigned to you it will appear here.</div>}
      {todo.length > 0 && (<><h2>To do</h2><div className="pt-grid">{todo.map((c) => <Tile key={c.id} c={c} onError={setError} />)}</div></>)}
      {done.length > 0 && (<><h2>Completed and closed</h2><div className="pt-grid">{done.map((c) => <Tile key={c.id} c={c} onError={setError} />)}</div></>)}
    </Shell>
  );
}
