/**
 * ONE STEP, ONE TRUTHFUL SENTENCE (2026-11-07).
 *
 * A step row carries several separate facts — its status, how many attempts it took, what its deterministic check
 * said — and the task around it has its own status. Showing them as one word lied in both directions: a step that
 * failed twice and then succeeded read "retried 2×" beside "failed" counts, a step that "completed" with nothing
 * usable read DONE, and the queued steps of a cancelled task read "waiting" forever.
 *
 * `stepOutcome` keeps the facts apart and says the one thing a researcher needs:
 *
 *   attempt history   a successful step that needed retries is "Done — retry successful"; the failed attempts stay in
 *                     the history (retryCount), they never make a finished step look unfinished
 *   final vs attempt  a failed step is "Failed attempt — will retry" only while the task is open and attempts remain;
 *                     after the last attempt, or once the task stopped, it is "Failed after N attempts"
 *   the check         a completed step whose own check failed is "Done — check failed", never plain Done
 *   the task          a step a cancelled task never ran is "Not run — task cancelled", not "Waiting"
 */
export type StepTone = "ok" | "warn" | "bad" | "busy" | "idle";
export interface StepOutcome { label: string; tone: StepTone; final: boolean }

/** automatic retries a step gets (lib/tasks/timing.ts STEP_RETRIES — one) — kept here so this file has no server imports */
export const ATTEMPTS = 1;

interface StepLike { status: string; retryCount?: number; validation?: { status?: string } | null | undefined }

export function stepOutcome(s: StepLike, taskStatus: string): StepOutcome {
  const tries = (s.retryCount ?? 0) + 1;
  const open = taskStatus === "pending" || taskStatus === "running";
  switch (s.status) {
    case "completed":
      if (s.validation?.status === "invalid") return { label: "Done — check failed", tone: "warn", final: true };
      return (s.retryCount ?? 0) > 0 ? { label: `Done — retry successful (${tries} attempts)`, tone: "ok", final: true } : { label: "Done", tone: "ok", final: true };
    case "failed": {
      /* a failed row counts its failed attempts in retryCount (the store increments it on every failure) */
      const failedTries = Math.max(1, s.retryCount ?? 0);
      if (open && failedTries <= ATTEMPTS && (s.retryCount ?? 0) === 0) return { label: "Failed attempt 1 — will retry", tone: "warn", final: false };
      return { label: `Failed after ${failedTries} attempt${failedTries === 1 ? "" : "s"}`, tone: "bad", final: true };
    }
    /* a retrying row has failed retryCount times; the next attempt is retryCount + 1 */
    case "retrying": return open ? { label: `Retrying — attempt ${(s.retryCount ?? 0) + 1}`, tone: "busy", final: false } : { label: `Stopped while retrying (${Math.max(1, s.retryCount ?? 0)} failed attempt${(s.retryCount ?? 0) === 1 ? "" : "s"})`, tone: "bad", final: true };
    case "running": return open ? { label: "Running", tone: "busy", final: false } : { label: "Stopped while running", tone: "bad", final: true };
    case "blocked": return { label: "Blocked — waiting for you", tone: "warn", final: false };
    case "tombstoned": return { label: "Replaced by a revised plan", tone: "idle", final: true };
    default:
      if (taskStatus === "cancelled") return { label: "Not run — task cancelled", tone: "idle", final: true };
      if (taskStatus === "failed") return { label: "Not run — task stopped", tone: "idle", final: true };
      if (taskStatus === "needs_attention") return { label: "Waiting for you", tone: "warn", final: false };
      return { label: "Waiting", tone: "idle", final: false };
  }
}

/** the task's own line: counts of each kind of outcome, never one status painted over all of them */
export function taskOutcome(t: { status: string; steps: readonly StepLike[] }): { label: string; tone: StepTone } {
  const steps = t.steps.filter((s) => s.status !== "tombstoned");
  const done = steps.filter((s) => s.status === "completed").length;
  const failedFinal = steps.filter((s) => { const o = stepOutcome(s, t.status); return o.tone === "bad"; }).length;
  const of = `${done} of ${steps.length} step${steps.length === 1 ? "" : "s"} done`;
  switch (t.status) {
    case "completed": return { label: `Completed — ${of}`, tone: "ok" };
    case "cancelled": return { label: `Cancelled — ${of}${failedFinal ? `, ${failedFinal} failed` : ""}; what the finished steps built is kept`, tone: "warn" };
    case "failed": return { label: `Stopped — ${of}, ${failedFinal} failed`, tone: "bad" };
    case "needs_attention": return { label: `Waiting for you — ${of}`, tone: "warn" };
    default: return { label: done && done < steps.length ? `Partially complete — ${of}` : of, tone: "busy" };
  }
}
