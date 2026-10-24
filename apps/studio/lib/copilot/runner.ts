/**
 * THE RESUMABLE RUNNER. (scaffold, 2026-10-24) — Owner: R3.
 *
 * This REPLACES THE BROWSER AS THE DRIVER of the existing plan → items loop.
 * It does not replace the loop. How an item is built, gated, repaired and
 * applied is unchanged; what changes is who calls it and where its output
 * lands.
 *
 * Do not raise ROUTE_BUDGET_MS (165 s) and do not create a second
 * orchestrator. The 90 s stage cap stays.
 */
import type { ExecStep, ExecTask } from "@rescript/engine";

const TODO = (what: string): never => { throw new Error(`runner: ${what} is not implemented yet (R3)`); };

export interface SliceResult {
  taskId: string;
  /** step ids committed in this slice */
  built: string[];
  /** step ids still outstanding when the budget ran out */
  remaining: string[];
  failed: { id: string; kind: ExecStep["failureKind"]; message: string }[];
  /** the slice stopped because the budget was spent, not because the work is done */
  budgetSpent: boolean;
}

export interface RunSliceOptions {
  budgetMs: number;
  /** a page is watching: checkpoints are streamed to it as well as committed */
  sink?: { progress(p: { stepId: string; index: number; of: number; label?: string }): void; checkpoint(stepId: string, raw: unknown): void; readonly cancelled?: boolean };
}

export async function runSlice(_taskId: string, _opts: RunSliceOptions): Promise<SliceResult> {
  return TODO("runSlice");
}

/**
 * The steps that may be claimed now: outstanding, dependencies met, in plan
 * order. Pure over the task graph, so it is tested without a database.
 */
export function nextRunnableSteps(_task: Pick<ExecTask, "steps">, _limit?: number): ExecStep[] {
  return TODO("nextRunnableSteps");
}
