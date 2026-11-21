"use client";
import React from "react";
import { begin, portalApi, when } from "@/components/portal/api";
import { Insights, Scores, type Comparison, type InsightLine, type Scorecard } from "@/components/portal/Scores";
import { Note, Shell } from "@/components/portal/Shell";

type Option = { code: string | number; label: string };
type Input = { kind: "single"; options: Option[]; value: string | number | null } | { kind: "multi"; options: Option[]; value: (string | number)[] } | { kind: "text"; long: boolean; value: string } | { kind: "number"; value: number | null };
interface Line { questionId: string; code: string; text: string; answer: string; edit: { allowed: boolean; reason?: string }; input: Input | null }
interface Attempt { id: string; status: string; startedAt: string | null; completedAt: string | null; revision: number; answers: Line[] | null; editableUntil: string | null; editable: boolean; editNote: string | null; scores: Scorecard | null; comparison: Comparison[] | null; insights: InsightLine[] | null }
interface Rewards { points: number | null; level: { index: number; name: string } | null; nextLevel: { name: string; pointsToGo: number } | null; badges: { id: string; title: string; description: string | null; icon: string }[]; badgesAvailable: number; completions: number; streak: { current: number; best: number; every: number } | null }
interface Detail { assessment: { id: string; title: string; state: string; canStart: boolean; canResume: boolean; reason: string | null; resultNote: string | null; canExplain?: boolean; rewards?: Rewards | null; canViewTrends?: boolean; look: { words: { one: string; organiser: string; results: string; start: string; again: string }; accent: string } }; attempts: Attempt[] }

const STATUS: Record<string, string> = { complete: "Completed", in_progress: "In progress", screened: "Ended early", quota_full: "Ended early", terminated: "Ended early" };

function Editor({ line, onSave, onCancel, busy }: { line: Line; onSave: (v: unknown) => void; onCancel: () => void; busy: boolean }) {
  const input = line.input!;
  const [value, setValue] = React.useState<unknown>(input.value);
  const name = `pt-edit-${line.questionId}`;
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(value); }} data-testid="pt-editor">
      {input.kind === "single" && (
        <div className="pt-choices" role="radiogroup" aria-label={line.text}>
          {input.options.map((o) => (<label key={String(o.code)}><input type="radio" name={name} checked={value === o.code} onChange={() => setValue(o.code)} /> <span>{o.label}</span></label>))}
        </div>
      )}
      {input.kind === "multi" && (
        <div className="pt-choices" role="group" aria-label={line.text}>
          {input.options.map((o) => { const on = (value as (string | number)[]).includes(o.code); return (<label key={String(o.code)}><input type="checkbox" checked={on} onChange={() => setValue(on ? (value as (string | number)[]).filter((c) => c !== o.code) : [...(value as (string | number)[]), o.code])} /> <span>{o.label}</span></label>); })}
        </div>
      )}
      {input.kind === "text" && (input.long
        ? <textarea className="pt-input" aria-label={line.text} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
        : <input className="pt-input" aria-label={line.text} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />)}
      {input.kind === "number" && <input className="pt-input" type="number" inputMode="decimal" aria-label={line.text} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => setValue(e.target.value === "" ? null : Number(e.target.value))} />}
      <div className="pt-row" style={{ marginTop: 8 }}>
        <button className="pt-btn is-primary" type="submit" disabled={busy} data-testid="pt-save">{busy ? "Saving…" : "Save"}</button>
        <button className="pt-btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export default function PortalAssessment({ params }: { params: { id: string } }) {
  const [d, setD] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    const r = await portalApi<Detail>(`assessments/${params.id}`);
    if (r.ok) setD(r.data); else if (r.error.status !== 401) setError(r.error.error);
  }, [params.id]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async (a: Attempt, line: Line, value: unknown) => {
    setBusy(true); setError(null); setSaved(null);
    const r = await portalApi(`assessments/${params.id}`, { action: "answer", responseId: a.id, questionId: line.questionId, value, revision: a.revision });
    setBusy(false);
    if (!r.ok) { setError(r.error.error); if (r.error.code === "revision_conflict") { setEditing(null); await load(); } return; }
    setEditing(null); setSaved("Your answer has been saved.");
    await load();
  };

  /* the same report as a file, made by the server; when it cannot be made (a script the file cannot carry) the
     server says so and the print button beside it does the job */
  const download = async () => {
    setBusy(true); setError(null); setSaved(null);
    try {
      const r = await fetch(`/api/portal/assessments/${params.id}/report`, { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); if (r.status === 401) window.location.assign("/portal/login"); else setError(String(j.error ?? "The report could not be made. Please try again.")); return; }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url; a.download = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "personal-report.pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setError("You appear to be offline. Check your connection and try again."); }
    finally { setBusy(false); }
  };

  const shown = d?.attempts.find((a) => a.answers || a.scores);
  return (
    <Shell current="assessment" accent={d?.assessment.look.accent}>
      <p className="pt-noprint"><a href="/portal">← Overview</a></p>
      {error && <Note kind="bad">{error}</Note>}
      {saved && <Note kind="ok">{saved}</Note>}
      {!d && !error && <p className="pt-empty">Loading…</p>}
      {d && (
        <>
          <h1>{d.assessment.title}</h1>
          {d.assessment.reason && <p className="pt-lead">{d.assessment.reason}</p>}
          <div className="pt-row pt-noprint" style={{ margin: "12px 0 4px" }}>
            {d.assessment.canResume && <button type="button" className="pt-btn is-primary" onClick={() => begin(params.id, setError)} data-testid="pt-resume">Continue</button>}
            {d.assessment.canStart && <button type="button" className="pt-btn is-primary" onClick={() => begin(params.id, setError)} data-testid="pt-start">{d.attempts.length ? d.assessment.look.words.again : d.assessment.look.words.start}</button>}
            {d.assessment.canViewTrends && <a className="pt-btn" href="/portal/progress" data-testid="pt-progress">My progress over time</a>}
            {shown && <button type="button" className="pt-btn" onClick={download} disabled={busy} data-testid="pt-download">Download PDF</button>}
            {shown && <button type="button" className="pt-btn" onClick={() => window.print()} data-testid="pt-print">Print</button>}
          </div>

          {d.assessment.rewards && (d.assessment.rewards.completions > 0) && (() => { const r = d.assessment.rewards!; return (
            <section data-testid="pt-rewards">
              <h2>My achievements</h2>
              <div className="pt-card">
                <dl className="pt-facts">
                  {r.points !== null && <div><dt>Points</dt><dd>{r.points}</dd></div>}
                  {r.level && <div><dt>Level</dt><dd>{r.level.name}</dd></div>}
                  {r.streak && <div><dt>In a row, on time</dt><dd>{r.streak.current}</dd></div>}
                  {r.streak && r.streak.best > r.streak.current && <div><dt>Longest run</dt><dd>{r.streak.best}</dd></div>}
                  <div><dt>Completed</dt><dd>{r.completions}</dd></div>
                </dl>
                {r.nextLevel && <p className="pt-why">{r.nextLevel.pointsToGo} more point{r.nextLevel.pointsToGo === 1 ? "" : "s"} to reach {r.nextLevel.name}.</p>}
                {r.badgesAvailable > 0 && (
                  <>
                    <p className="pt-q" style={{ marginTop: 10 }}>Badges ({r.badges.length} of {r.badgesAvailable})</p>
                    {r.badges.length === 0 ? <p className="pt-why">None yet.</p> : (
                      <ul className="pt-badges">{r.badges.map((b) => (<li key={b.id}><span aria-hidden="true">{b.icon}</span> <strong>{b.title}</strong>{b.description ? <span className="pt-why"> {b.description}</span> : null}</li>))}</ul>
                    )}
                  </>
                )}
                <p className="pt-why">Achievements are recognition for taking part. They are not money and cannot be exchanged for anything.</p>
              </div>
            </section>
          ); })()}

          <h2>History</h2>
          <div className="pt-card">
            {d.attempts.length === 0 ? <p className="pt-empty">You have not started this {d.assessment.look.words.one} yet.</p> : (
              <table className="pt-table" data-testid="pt-attempts">
                <thead><tr><th>Started</th><th>Finished</th><th>Status</th></tr></thead>
                <tbody>{d.attempts.map((a) => (<tr key={a.id}><td>{when(a.startedAt, true)}</td><td>{when(a.completedAt, true) || "—"}</td><td>{STATUS[a.status] ?? a.status}</td></tr>))}</tbody>
              </table>
            )}
          </div>

          {d.attempts.filter((a) => a.scores).map((a, i) => (
            <section key={`s-${a.id}`}>
              <h2 data-testid={i === 0 ? "pt-results-title" : undefined}>{i === 0 ? d.assessment.look.words.results : `Results from ${when(a.completedAt)}`}</h2>
              <Scores scores={a.scores!} comparison={a.comparison} note={d.assessment.resultNote} />
              {a.insights && a.insights.length > 0 && <Insights lines={a.insights} onExplain={d.assessment.canExplain ? async () => { const r = await portalApi<{ text: string; source: "ai" | "rules" }>(`assessments/${params.id}`, { action: "explain" }); return r.ok ? r.data : r.error.error; } : undefined} />}
            </section>
          ))}

          {d.attempts.filter((a) => a.answers).map((a, i) => (
            <section key={a.id} data-testid="pt-answers">
              <h2>{i === 0 ? "My answers" : `Answers from ${when(a.completedAt)}`}</h2>
              {i === 0 && a.editable && <Note kind="info">You can change some of your answers{a.editableUntil ? ` until ${when(a.editableUntil, true)}` : ""}. Every change is recorded.</Note>}
              {i === 0 && a.editNote && <p className="pt-why">{a.editNote}</p>}
              <div className="pt-card">
                <ul className="pt-answers">
                  {a.answers!.map((l) => (
                    <li key={l.questionId}>
                      <p className="pt-q"><small>{l.code}</small>{l.text}</p>
                      {editing === `${a.id}:${l.questionId}` && l.input
                        ? <Editor line={l} busy={busy} onSave={(v) => save(a, l, v)} onCancel={() => setEditing(null)} />
                        : (
                          <>
                            <p className="pt-a">{l.answer}</p>
                            {l.edit.allowed && l.input && <button type="button" className="pt-btn is-quiet pt-noprint" onClick={() => { setEditing(`${a.id}:${l.questionId}`); setSaved(null); }} data-testid={`pt-change-${l.code}`}>Change</button>}
                            {l.edit.allowed && !l.input && <p className="pt-why pt-noprint">This kind of answer cannot be changed here. Ask {d.assessment.look.words.organiser} if it needs correcting.</p>}
                          </>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
          {d.attempts.some((a) => a.status === "complete") && !d.attempts.some((a) => a.answers) && <p className="pt-why" style={{ marginTop: 16 }}>Submitted answers are not available to view for this {d.assessment.look.words.one}.</p>}
        </>
      )}
    </Shell>
  );
}
