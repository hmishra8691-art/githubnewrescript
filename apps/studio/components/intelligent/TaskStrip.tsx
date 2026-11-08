"use client";
import React from "react";
import { executionView, type TaskView } from "../../lib/copilot/deliverable";
import { ConflictCard } from "../agents/ConflictCard";
import type { StepConflict } from "../../lib/tasks/conflicts";

/**
 * THE PROGRAMMING PROGRESS STRIP (2026-11-07). The Intelligent mode's right panel is for REVIEW — Changes, Review,
 * Findings, the Inspector. The full execution panel (every row, every retry, every failure message) had been pushed
 * on top of it and buried those tabs; it now lives in the AI Agents workspace.
 *
 * What stays here is the step-by-step progress of the task the copilot is running, in a few lines: each real step
 * with its truthful outcome (lib/copilot/stepOutcome.ts), the buttons that act on it, and a link to the details.
 * It shows only while the task is running, waiting for the researcher, or finished and ready to review — a cancelled
 * or failed task leaves the panel to the review tabs and says what happened in its own chat card.
 */
export function TaskStrip({ task, surveyId, onPause, onResume, onContinue, onCancel, onReview, onDetails, onResolved, onRetry }: {
  task: TaskView & { id?: string; blocked?: { message?: string }; conflicts?: StepConflict[] };
  surveyId?: string; onResolved?: () => void; onRetry?: () => void;
  onPause?: () => void; onResume?: () => void; onContinue?: () => void; onCancel?: () => void; onReview?: () => void; onDetails?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const v = executionView(task);
  /* what is running right now, and for how long — from the row's own start time, ticking once a second */
  const running = (task.steps as readonly { stepId: string; status: string; title?: string; startedAt?: number; retryCount?: number }[]).filter((s) => s.status === "running");
  const [, tick] = React.useState(0);
  React.useEffect(() => { if (!running.length) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running.length]);
  const since = (ms?: number) => { if (!ms) return ""; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
  /*
   * A STOPPED TASK STILL HANDS OVER ITS WORK (2026-11-07 — partial apply). What finished can be reviewed and applied
   * now; what failed is named with its reason; Retry runs only the failed steps. A cancelled task with nothing done
   * leaves the panel to the review tabs.
   */
  if (task.status === "cancelled" || task.status === "failed") {
    const failedRows = (task.steps as readonly { stepId: string; status: string; title?: string; failureMessage?: string }[]).filter((s) => s.status === "failed" || s.status === "blocked");
    if (!v.completed) return null;
    return (
      <section className="cp-taskstrip stopped" data-testid="iq-taskstrip" data-status={task.status} aria-label="Programming result">
        <div className="cp-taskstrip-head"><b>{task.status === "cancelled" ? "Stopped" : "Partly done"}</b><span className="iqi-dim" data-testid="iq-taskstrip-line">{v.completed} of {v.total} steps done{failedRows.length ? ` · ${failedRows.length} failed` : ""}</span><span className="grow" />{onDetails && <button type="button" className="iq-btn" onClick={onDetails} data-testid="iq-taskstrip-details">Details</button>}</div>
        {failedRows.length > 0 && <ul className="cp-taskstrip-failed">{failedRows.slice(0, 3).map((f) => <li key={f.stepId}><b>{f.title ?? f.stepId}</b>{f.failureMessage ? ` — ${f.failureMessage}` : ""}</li>)}</ul>}
        <div className="cp-taskstrip-actions">
          {onReview && <button type="button" className="iq-btn primary" onClick={onReview} data-testid="iq-taskstrip-review-partial">Review &amp; apply what&apos;s done</button>}
          {failedRows.length > 0 && task.status === "failed" && onRetry && <button type="button" className="iq-btn" onClick={onRetry} data-testid="iq-taskstrip-retry" title="Runs only the failed steps again; everything finished is kept">Retry {failedRows.length === 1 ? "failed step" : `${failedRows.length} failed steps`}</button>}
        </div>
      </section>
    );
  }
  const rows = v.rows.filter((r) => r.status !== "tombstoned");
  const shown = open ? rows : rows.slice(0, 4);
  const icon = (tone: string) => (tone === "ok" ? "✓" : tone === "bad" ? "✕" : tone === "warn" ? "!" : tone === "busy" ? "●" : "○");
  return (
    <section className="cp-taskstrip" data-testid="iq-taskstrip" data-status={task.status} aria-label="Programming progress">
      <div className="cp-taskstrip-head">
        <b>{task.status === "completed" ? "Ready to review" : task.status === "needs_attention" ? "Waiting for you" : "Programming"}</b>
        <span className="iqi-dim" data-testid="iq-taskstrip-line">{v.completed} of {v.total} steps done{v.failed ? ` · ${v.failed} failed` : ""}</span>
        <span className="grow" />
        {onDetails && <button type="button" className="iq-btn" onClick={onDetails} data-testid="iq-taskstrip-details" title="Every step, attempt and message, in the AI Agents workspace">Details</button>}
      </div>
      {running.length > 0 && <div className="cp-taskstrip-now" data-testid="iq-taskstrip-now" aria-live="polite">Now: {running.map((r) => `${r.title ?? r.stepId}${r.retryCount ? ` (attempt ${r.retryCount + 1})` : ""}${r.startedAt ? ` · ${since(r.startedAt)}` : ""}`).join(" · ")}</div>}
      {!running.length && (task.status === "running" || task.status === "pending") && v.completed < v.total && <div className="cp-taskstrip-now">Starting the next step…</div>}
      <ol className="cp-taskstrip-steps">
        {shown.map((r, i) => (
          <li key={r.stepId} className={`t-${r.tone}`} data-testid="iq-taskstrip-step" data-status={r.status}>
            <span className="cp-taskstrip-ico" aria-hidden="true">{icon(r.tone)}</span>
            <span className="cp-taskstrip-n">Step {i + 1}</span>
            <span className="cp-taskstrip-title">{r.title}</span>
            <span className="cp-taskstrip-out">{r.outcome}</span>
          </li>
        ))}
      </ol>
      {rows.length > 4 && <button type="button" className="iq-btn cp-taskstrip-more" onClick={() => setOpen(!open)}>{open ? "Show fewer steps" : `Show all ${rows.length} steps`}</button>}
      {task.conflicts?.length && task.id && surveyId ? <ConflictCard compact taskId={task.id} surveyId={surveyId} conflicts={task.conflicts} onResolved={() => onResolved?.()} /> : task.status === "needs_attention" && task.blocked?.message && <p className="iqi-dim">{task.blocked.message}</p>}
      <div className="cp-taskstrip-actions">
        {task.status === "completed" && onReview && <button type="button" className="iq-btn primary" onClick={onReview} data-testid="iq-taskstrip-review">Review the result</button>}
        {(task.status === "running" || task.status === "pending") && onPause && <button type="button" className="iq-btn" onClick={onPause} data-testid="iq-taskstrip-pause">Pause</button>}
        {task.status === "needs_attention" && onResume && <button type="button" className="iq-btn primary" onClick={onResume} data-testid="iq-taskstrip-resume">Resume</button>}
        {(v.phase === "recovering" || v.phase === "needs attention") && task.status !== "needs_attention" && onContinue && <button type="button" className="iq-btn" onClick={onContinue}>Continue now</button>}
        {task.status !== "completed" && onCancel && <button type="button" className="iq-btn" onClick={onCancel} data-testid="iq-taskstrip-cancel" title="Stop after the step that is running; everything already built is kept">Stop</button>}
      </div>
    </section>
  );
}
