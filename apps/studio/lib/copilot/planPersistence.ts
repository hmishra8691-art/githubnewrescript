/**
 * THE PLAN, KEPT. (scaffold, 2026-10-24) — Owner: R2.
 *
 * `loadOrCreatePlan` is the route's first act on a non-trivial turn: an open
 * task for this survey whose request the new instruction continues loads its
 * persisted plan; anything else mints a new task.
 *
 * "Non-trivial" is NOT a new classifier. It is the engine's existing
 * `interpretRequest` / request-scope work: an engine-resolved edit stays a
 * single turn and must not grow a task row.
 *
 * A user instruction that changes an existing task writes plan version n+1
 * and blocks only the dependent steps; unrelated completed steps keep their
 * outputs. A deleted step is tombstoned, never dropped silently.
 */
import type { ChangePlan } from "./changePlan.ts";
import type { ExecTask } from "@rescript/engine";

const TODO = (what: string): never => { throw new Error(`planPersistence: ${what} is not implemented yet (R2)`); };

/** what the route needs back: the task, the plan to run, and what to tell the researcher */
export interface LoadedPlan {
  task: ExecTask;
  plan: ChangePlan;
  /** true when this turn minted the task rather than continuing one */
  fresh: boolean;
  /** step ids whose completed output is being reused */
  reused: string[];
  /** step ids this instruction invalidated and will re-run */
  redone: string[];
  /** step ids this instruction deleted */
  tombstoned: string[];
}

export interface LoadOrCreateInput {
  surveyId: string;
  request: string;
  memory?: string;
  /** the plan this turn's plan stage produced, when it ran */
  plan?: ChangePlan | null;
  customerId?: string;
  createdBy?: string;
}

export async function loadOrCreatePlan(_input: LoadOrCreateInput): Promise<LoadedPlan | null> {
  return TODO("loadOrCreatePlan");
}

/** the honest-reply sentence describing what is reused and what is redone */
export function describeReconciliation(_r: Pick<LoadedPlan, "reused" | "redone" | "tombstoned">): string {
  return TODO("describeReconciliation");
}
