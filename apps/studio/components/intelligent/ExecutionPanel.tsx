"use client";
import React from "react";
import { Icon } from "../ui/Icon";
import { executionView, type ExecutionRow, type ExecutionView, type TaskView } from "../../lib/copilot/deliverable";

/**
 * THE EXECUTION PANEL — what the server is actually doing, read from the
 * PERSISTED TASK and from nothing else.
 *
 * Before the execution engine the only record of a long generation lived in
 * the browser, so the only thing this panel could have shown was a spinner
 * and a guess. It now shows rows: one line per step, with the step's own
 * status, its batch size, the item range it is working on, what its
 * deterministic check said, how many times it has been retried and what it
 * cost. Every number comes from `executionView`
 * (apps/studio/lib/copilot/deliverable.ts), which derives all of them from
 * `taskProgress` / `taskSpend` over the step rows — there is no counter here
 * that a row does not back, and no animation for work that is not happening.
 *
 * Three rules this panel is written to keep:
 *
 *   NO INVENTED TIME     a remaining-time estimate appears only once two
 *                        steps have actually finished and nothing is stuck.
 *                        Otherwise it says what is missing, the way the
 *                        fieldwork panel says "No pace yet" rather than
 *                        guessing a close date (packages/analytics/src/
 *                        fieldwork.ts:283).
 *   A FAILURE IS NEVER   a failed batch reads "recovering" while a retry is
 *   SUCCESS              possible and "needs attention" once it is not. The
 *                        progress bar never fills past the completed rows.
 *   SAY WHEN IT IS NOT   when the task tables are not in place the store
 *   DURABLE              falls back to this server's memory; the researcher
 *                        is told, because a restart loses the run.
 *
 * The task is a PROP: this component never reaches for a store. The page
 * fetches the task (redacted for the client) and passes it down, so the panel
 * works the same in the Studio, in a preview and in a test.
 */

const PHASE_ICON: Record<ExecutionView["phase"], "sparkle" | "play" | "check" | "warning" | "info" | "close"> = {
  planning: "sparkle",
  building: "play",
  validating: "info",
  recovering: "warning",
  "needs attention": "warning",
  done: "check",
  cancelled: "close",
};

const SEVERITY: Record<ExecutionView["phase"], "suggestion" | "warning" | "critical"> = {
  planning: "suggestion",
  building: "suggestion",
  validating: "suggestion",
  recovering: "warning",
  "needs attention": "critical",
  done: "suggestion",
  cancelled: "warning",
};

const STEP_WORD: Record<ExecutionRow["status"], string> = {
  pending: "waiting",
  running: "running",
  completed: "done",
  failed: "failed",
  retrying: "retrying",
  blocked: "blocked",
  tombstoned: "dropped",
};

const num = (n: number) => n.toLocaleString("en-GB");

export function ExecutionPanel({
  task,
  durable,
  onRetry,
  onCancel,
  busy,
}: {
  /**
   * The persisted task as the server redacted it for the client
   * (`redactForClient` → `ClientTask`, lib/copilot/taskStore.ts); null while
   * nothing is running. Never a store: this component is given its rows.
   */
  task: TaskView | null;
  /** false when the store fell back to this server's memory */
  durable?: boolean;
  onRetry?(): void;
  onCancel?(): void;
  busy?: boolean;
}) {
  const view = React.useMemo(() => (task ? executionView(task, { durable }) : null), [task, durable]);

  if (!view) {
    return (
      <div className="cp-analysis cp-execution" data-testid="cp-execution" data-phase="none">
        <p className="cp-empty" data-testid="ex-none">Nothing is running. A long build — a hundred questions, a language, a conjoint design — becomes a task here, with one row per step, so it survives this tab.</p>
      </div>
    );
  }

  const pct = view.total > 0 ? Math.round((view.completed / view.total) * 100) : 0;

  return (
    <div className="cp-analysis cp-execution" data-testid="cp-execution" data-phase={view.phase} data-status={view.status}>
      <section>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <div className="iq-label">Execution · {num(view.completed)} of {num(view.total)}</div>
          <span className={`cp-sev v-${SEVERITY[view.phase]}`} data-testid="ex-phase"><Icon name={PHASE_ICON[view.phase]} size={12} /> {view.phase}</span>
          <span className="grow" />
          {onRetry && (view.phase === "recovering" || view.phase === "needs attention") && (
            <button type="button" className="iq-btn" data-testid="ex-retry" disabled={busy} onClick={onRetry} title="Run the next slice now — completed steps are not run again">Continue now</button>
          )}
          {onCancel && view.status !== "completed" && view.status !== "cancelled" && (
            <button type="button" className="iq-btn" data-testid="ex-cancel" disabled={busy} onClick={onCancel} title="Stop after the step that is running; everything already built is kept">Stop</button>
          )}
        </div>
        <p data-testid="ex-headline">{view.headline}</p>

        {/*
          * The bar is the completed rows, the failed rows and nothing else. It
          * is drawn with the import card's `iqi-fid-bar` (three spans over a
          * track) rather than a new widget, and it has no transition: it moves
          * when a row moves and at no other time.
          */}
        <div className="iqi-fid-bar" data-testid="ex-progress" data-pct={pct} role="img" aria-label={`${view.completed} of ${view.total} steps done${view.failed ? `, ${view.failed} failed` : ""}`} title={`${view.completed} done · ${view.failed} failed · ${view.remaining} to go`}>
          <span className="imported" style={{ width: `${pct}%` }} />
          <span className="unsupported" style={{ width: `${view.total ? Math.round((view.failed / view.total) * 100) : 0}%` }} />
        </div>

        <div className="iqi-dim" data-testid="ex-counts">
          {num(view.completed)} done · {num(view.remaining)} to go
          {view.running ? ` · ${num(view.running)} running` : ""}
          {view.failed ? ` · ${num(view.failed)} failed` : ""}
          {view.blocked ? ` · ${num(view.blocked)} blocked by a re-plan` : ""}
          {view.itemRange ? ` · items ${num(view.itemRange.from)}–${num(view.itemRange.to)}` : ""}
        </div>

        <div className="iqi-dim" data-testid="ex-estimate" data-known={view.estimate.known}>{view.estimate.text}</div>

        {!view.durable && (
          <p className="iq-error" data-testid="ex-memory"><Icon name="warning" size={12} /> {view.durabilityNote}</p>
        )}
      </section>

      {view.recovery.message && (
        <section className="cp-block" data-testid="ex-recovery" data-attention={view.recovery.attention}>
          <div className="iq-label">{view.recovery.attention ? "Needs attention" : "Recovering"}</div>
          <p>{view.recovery.message}</p>
          {view.recovery.retrying > 0 && <div className="iqi-dim">{num(view.recovery.retrying)} step{view.recovery.retrying === 1 ? "" : "s"} waiting to be retried.</div>}
        </section>
      )}

      {view.report && !view.report.ok && (
        <section className="cp-block" data-testid="ex-deliverable">
          <div className="iq-label">Why this is not done yet · {view.report.problems.length}</div>
          <ul className="cp-review-list">
            {view.report.problems.slice(0, 12).map((p, k) => <li key={k} data-severity="warning"><span className="cp-sev v-warning">short</span> {p}</li>)}
            {view.report.problems.length > 12 && <li className="iqi-dim">… and {num(view.report.problems.length - 12)} more</li>}
          </ul>
          {view.resume && <div className="iqi-dim" data-testid="ex-resume">Resumes at {view.resume.unit} {view.resume.at} — {num(view.resume.remaining)} left. What is already built is kept.</div>}
        </section>
      )}

      {view.validation.invalid > 0 && (
        <section className="cp-block" data-testid="ex-validation">
          <div className="iq-label">Checks that failed · {view.validation.invalid} of {view.validation.checked}</div>
          <ul className="cp-review-list">
            {view.validation.problems.map((p, k) => <li key={k} data-severity="critical"><span className="cp-sev v-critical">invalid</span> {p}</li>)}
          </ul>
        </section>
      )}

      <section data-testid="ex-steps">
        <div className="iq-label">Steps · {num(view.rows.length)}</div>
        <table className="iqi-table"><tbody>
          {view.rows.map((r) => (
            <tr key={r.stepId} data-testid="ex-step" data-step-id={r.stepId} data-step-status={r.status}>
              <td>{r.title}{r.inputRef ? <span className="iqi-dim"> · {r.inputRef}</span> : null}</td>
              <td><span className={`cp-sev v-${r.status === "failed" ? "critical" : r.status === "completed" ? "suggestion" : "warning"}`}>{STEP_WORD[r.status]}</span></td>
              <td className="iqi-dim">{r.sizeUsed != null && r.size != null && r.sizeUsed !== r.size ? `${num(r.sizeUsed)} of ${num(r.size)}` : r.size != null ? num(r.size) : ""}</td>
              <td className="iqi-dim">{r.retryCount > 0 ? `retried ${num(r.retryCount)}×` : ""}</td>
              <td className="iqi-dim">{r.seconds != null ? `${r.seconds}s` : ""}</td>
              <td className="iqi-dim">{r.validation === "invalid" ? (r.problems[0] ?? "did not validate") : r.failureMessage ?? ""}</td>
            </tr>
          ))}
          {!view.rows.length && <tr><td className="iqi-dim">No steps yet — the plan has not been approved.</td></tr>}
        </tbody></table>
      </section>

      {view.spend.real && (
        <section className="cp-block" data-testid="ex-spend">
          <div className="iq-label">What this has cost so far</div>
          <div className="iqi-dim">
            {num(view.spend.tokensIn)} in{view.spend.tokensCached ? ` (${num(view.spend.tokensCached)} from the prompt cache)` : ""} · {num(view.spend.tokensOut)} out
            {view.spend.charge ? ` · ${view.spend.charge.toFixed(2)} credits` : ""}
          </div>
        </section>
      )}
    </div>
  );
}
