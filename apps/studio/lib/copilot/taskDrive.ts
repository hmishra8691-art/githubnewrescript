/**
 * HOW LONG A PAGE WAITS BEFORE IT ADVANCES A TASK AGAIN (2026-10-30).
 *
 * The execution panel's drive loop used a flat 250 ms between slices whenever
 * the server said "advance". A slice that built nothing — every claimable step
 * leased by another worker (the cron, a second tab) for its 180 s reclaim
 * window, or a step waiting on its retry — came back "drained" and was asked
 * again a quarter of a second later, four times a second, for minutes.
 *
 * `idle` is the number of slices in a row that completed no new step. The
 * first one is free (250 ms: a slice that just finished a step often hands the
 * next straight on); after that the wait doubles from 2 s to a 15 s ceiling,
 * and drops back to 250 ms the moment a step completes. A provider's
 * Retry-After and the runner's own backoff win when they are longer.
 */
export interface DriveWaitInput {
  /** the request returned a task view (false: the connection dropped or the server restarted) */
  viewed: boolean;
  /** consecutive requests without a view */
  fails: number;
  /** the page is advancing (false: it only polls) */
  drive: boolean;
  /** consecutive slices that completed no new step */
  idle: number;
  retryAfterMs?: number;
  stoppedBy?: string;
}

export const DRIVE_FAST_MS = 250;
export const DRIVE_IDLE_CAP_MS = 15_000;

export function driveWait(i: DriveWaitInput): number {
  if (!i.viewed) return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(i.fails, 0), 5));
  if (!i.drive) return 2500;
  const idleWait = i.idle <= 0 ? DRIVE_FAST_MS : Math.min(DRIVE_IDLE_CAP_MS, 1000 * 2 ** Math.min(i.idle, 4));
  const serverWait = i.retryAfterMs ? Math.min(60_000, i.retryAfterMs) : i.stoppedBy === "backoff" ? 3000 : 0;
  return Math.max(idleWait, serverWait);
}

/**
 * WHETHER A PAGE SHOULD KEEP ADVANCING A TASK — the server's half of the same fix.
 *
 * The task view said "advance" for every pending or running task. A running
 * task with nothing a slice could ever run — every step done but the
 * deliverable check not passed, or the only outstanding steps failed for good
 * — therefore told the page to advance again, the slice found nothing to claim
 * ("drained"), and the page asked again 250 ms later for as long as the tab
 * stayed open (seen on 2026-10-30 on the owner's Mac: four requests a second
 * on one task until the tab was closed). Now a page is told to advance only
 * while a step can still be claimed — pending, retrying, or running under a
 * lease that may lapse; otherwise it stops, and the panel shows the check's
 * problems under "Why this is not done yet". A pending task whose steps are
 * not written yet is still advanced.
 */
export function driveOf(task: { status: string; steps?: readonly { status: string }[] | null }): "advance" | "stop" {
  if (task.status !== "pending" && task.status !== "running") return "stop";
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (!steps.length) return task.status === "pending" ? "advance" : "stop";
  return steps.some((s) => s.status === "pending" || s.status === "retrying" || s.status === "running") ? "advance" : "stop";
}

/** the completed-step count a view reports, for telling progress from a slice that did nothing */
export function completedOf(view: { progress?: { completed?: number } } | null | undefined): number {
  const n = Number(view?.progress?.completed);
  return Number.isFinite(n) ? n : 0;
}
