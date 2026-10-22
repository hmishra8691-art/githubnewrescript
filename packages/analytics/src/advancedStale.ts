/**
 * LIVE UPDATING OF THE ADVANCED MODELS (2026-10-22) — quantilope's dashboards
 * update as responses arrive; a model here is never overwritten silently.
 * When completes arrive after an HB / latent class / SEM result was computed,
 * the result is STALE: it is flagged, the number of new completes is said, and
 * a re-run is offered. Only when the plan opts in (`advancedRerun.mode =
 * "threshold"`) does the fieldwork cron re-run it by itself, and only once the
 * stated number of new completes is in. Pure: the server counts, this decides.
 */

export const ADVANCED_ANALYSIS_KINDS: ReadonlySet<string> = new Set(["hb", "lca", "sem"]);

export type StaleState = "never_run" | "running" | "fresh" | "stale";
export interface StalenessInput {
  /** when the latest valid result was computed (a finished job, a cached run); null = never */
  computedAt: string | null;
  /** completes the result was computed on, when known */
  nAtRun?: number | null;
  /** completes that arrived after `computedAt` */
  newSince: number;
  /** a job is advancing right now */
  running?: boolean;
  policy?: { mode?: "manual" | "threshold"; newResponses?: number } | null;
}
export interface Staleness {
  state: StaleState;
  newResponses: number;
  /** the cron should re-run it now (threshold policy reached) */
  autoRerun: boolean;
  message: string;
}

export function advancedStaleness(x: StalenessInput): Staleness {
  const n = Math.max(0, Math.floor(x.newSince || 0));
  if (x.running) return { state: "running", newResponses: n, autoRerun: false, message: "Running now — the result will replace nothing until it finishes." };
  if (!x.computedAt) return { state: "never_run", newResponses: n, autoRerun: false, message: "Not run yet." };
  if (!n) return { state: "fresh", newResponses: 0, autoRerun: false, message: `Up to date${x.nAtRun ? ` (computed on ${x.nAtRun} completes)` : ""}.` };
  const threshold = x.policy?.mode === "threshold" ? Math.max(1, x.policy.newResponses ?? 50) : null;
  const autoRerun = threshold != null && n >= threshold;
  return {
    state: "stale", newResponses: n, autoRerun,
    message: `${n} new complete${n === 1 ? "" : "s"} since this was computed${x.nAtRun ? ` on ${x.nAtRun}` : ""} — the result shown is the earlier one. ${autoRerun ? "It is re-run automatically (the plan's threshold is reached)." : threshold != null ? `It re-runs automatically at ${threshold} new completes, or re-run it now.` : "Re-run it to include them."}`,
  };
}
