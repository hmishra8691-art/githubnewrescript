"use client";
import React from "react";
import { begin, portalApi, when } from "@/components/portal/api";
import { Scores, type Comparison, type Scorecard } from "@/components/portal/Scores";
import { Note, Shell } from "@/components/portal/Shell";

type Option = { code: string | number; label: string };
type Input = { kind: "single"; options: Option[]; value: string | number | null } | { kind: "multi"; options: Option[]; value: (string | number)[] } | { kind: "text"; long: boolean; value: string } | { kind: "number"; value: number | null };
interface Line { questionId: string; code: string; text: string; answer: string; edit: { allowed: boolean; reason?: string }; input: Input | null }
interface Attempt { id: string; status: string; startedAt: string | null; completedAt: string | null; revision: number; answers: Line[] | null; editableUntil: string | null; editable: boolean; editNote: string | null; scores: Scorecard | null; comparison: Comparison[] | null }
interface Detail { assessment: { id: string; title: string; state: string; canStart: boolean; canResume: boolean; reason: string | null; scoredTest: boolean }; attempts: Attempt[] }

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

  const shown = d?.attempts.find((a) => a.answers || a.scores);
  return (
    <Shell current="assessment">
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
            {d.assessment.canStart && <button type="button" className="pt-btn is-primary" onClick={() => begin(params.id, setError)} data-testid="pt-start">{d.attempts.length ? "Take it again" : "Start"}</button>}
            {shown && <button type="button" className="pt-btn" onClick={() => window.print()} data-testid="pt-print">Print or save as PDF</button>}
          </div>

          <h2>History</h2>
          <div className="pt-card">
            {d.attempts.length === 0 ? <p className="pt-empty">You have not taken this assessment yet.</p> : (
              <table className="pt-table" data-testid="pt-attempts">
                <thead><tr><th>Started</th><th>Finished</th><th>Status</th></tr></thead>
                <tbody>{d.attempts.map((a) => (<tr key={a.id}><td>{when(a.startedAt, true)}</td><td>{when(a.completedAt, true) || "—"}</td><td>{STATUS[a.status] ?? a.status}</td></tr>))}</tbody>
              </table>
            )}
          </div>

          {d.attempts.filter((a) => a.scores).map((a, i) => (
            <section key={`s-${a.id}`}>
              <h2>{i === 0 ? "My results" : `Results from ${when(a.completedAt)}`}</h2>
              <Scores scores={a.scores!} comparison={a.comparison} scoredTest={d.assessment.scoredTest} />
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
                            {l.edit.allowed && !l.input && <p className="pt-why pt-noprint">This kind of answer cannot be changed here. Ask the organiser if it needs correcting.</p>}
                          </>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
          {d.attempts.some((a) => a.status === "complete") && !d.attempts.some((a) => a.answers) && <p className="pt-why" style={{ marginTop: 16 }}>The organiser of this assessment has not made submitted answers available to view.</p>}
        </>
      )}
    </Shell>
  );
}
