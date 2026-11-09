"use client";
import React from "react";
import type { StepConflict } from "../../lib/tasks/conflicts";

/**
 * A CONFLICT BETWEEN PARTS OF ONE TASK (agents working side by side internally), RAISED THE MOMENT IT HAPPENS (2026-11-07). Two steps running side by side changed the
 * same thing in ways that cannot both stand; the task is paused before anything builds on it. The researcher sees
 * what each part did (never which agent) and keeps one — the other step is redone on top of it, and the task carries on.
 */
export function ConflictCard({ taskId, surveyId, conflicts, onResolved, compact }: { taskId: string; surveyId: string; conflicts: StepConflict[]; onResolved: (task: unknown) => void; compact?: boolean }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const keep = async (key: string, stepId: string) => {
    setBusy(`${key}|${stepId}`); setErr(null);
    try {
      const r = await fetch(`/api/copilot/tasks/${encodeURIComponent(taskId)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId, key, keep: stepId }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(String((j as { error?: string }).error ?? `That did not work (${r.status}).`)); return; }
      onResolved((j as { task?: unknown }).task);
    } catch { setErr("That did not work — check your connection."); } finally { setBusy(null); }
  };
  if (!conflicts.length) return null;
  return (
    <section className={`agw-conflicts${compact ? " compact" : ""}`} data-testid="agw-conflicts" role="alert" aria-live="assertive">
      <b>{conflicts.length === 1 ? "Your decision is needed" : `${conflicts.length} decisions needed — two parts of the work changed the same things`}</b>
      {conflicts.map((c) => (
        <div key={c.key} className="agw-conflict" data-testid="agw-conflict" data-key={c.key}>
          <p>{c.question}</p>
          <ul>{c.steps.map((s) => <li key={s.stepId}><b>{s.title}</b> {s.did}</li>)}</ul>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {c.steps.map((s) => <button key={s.stepId} type="button" className="btn tiny primary" disabled={busy != null} onClick={() => void keep(c.key, s.stepId)} data-testid="agw-conflict-keep">{busy === `${c.key}|${s.stepId}` ? "Keeping…" : `Keep ${s.title}`}</button>)}
          </div>
        </div>
      ))}
      {err && <span className="agw-launch-err">{err}</span>}
      <span className="muted" style={{ fontSize: 12 }}>The other step is redone on top of the one you keep; nothing reaches the survey until you review and apply the result.</span>
    </section>
  );
}
