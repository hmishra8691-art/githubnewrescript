"use client";
import React from "react";
import { executionView, type TaskView } from "../../lib/copilot/deliverable";

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
export function TaskStrip({ task, onPause, onResume, onContinue, onCancel, onReview, onDetails }: {
  task: TaskView & { id?: string; blocked?: { message?: string } };
  onPause?: () => void; onResume?: () => void; onContinue?: () => void; onCancel?: () => void; onReview?: () => void; onDetails?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const v = executionView(task);
  if (task.status === "cancelled" || task.status === "failed") return null;
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
      {task.status === "needs_attention" && task.blocked?.message && <p className="iqi-dim">{task.blocked.message}</p>}
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
