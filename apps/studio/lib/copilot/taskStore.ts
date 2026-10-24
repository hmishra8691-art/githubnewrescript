/**
 * THE ONLY MODULE THAT READS OR WRITES THE TASK TABLES. (scaffold, 2026-10-24)
 *
 * Owner: R1. Nothing else may import `@supabase/*` for `intelligent_tasks` or
 * `intelligent_steps`; the runner, the plan stage and the panel all come
 * through here. That is what keeps the claim in one place and the row shape
 * in one place.
 *
 * Durable / memory: use `storeWithFallback` from ./durable.ts, as the research
 * documents (0045) and the operation history (0047) stores do, so the feature
 * works between the deploy and the moment the operator applies the migration.
 *
 * Nothing in a record this reaches a client route may be provider-credential
 * shaped, and prompt text does not leave the server.
 */
import type { DeliverableSpec, ExecStep, ExecTask, StepFailureKind, StepUsage, TaskKind, TaskStatus } from "@rescript/engine";

const TODO = (what: string): never => { throw new Error(`taskStore: ${what} is not implemented yet (R1)`); };

export interface CreateTaskInput {
  surveyId: string;
  customerId?: string;
  createdBy?: string;
  kind: TaskKind;
  request: string;
  deliverable: DeliverableSpec;
  steps: Omit<ExecStep, "taskId" | "retryCount">[];
}

/** a step claimed for this slice: the row, and the lease that makes it ours */
export interface ClaimedStep { step: ExecStep; claimedAt: number }

export interface TaskStore {
  /** `durable` false means this server's memory only — the UI must say so */
  readonly durable: boolean;
  create(input: CreateTaskInput): Promise<ExecTask>;
  /** the task with its steps, ordered */
  load(taskId: string): Promise<ExecTask | null>;
  /** the newest task for this survey that is not finished, if any */
  openFor(surveyId: string): Promise<ExecTask | null>;
  /**
   * Move one runnable step to `running` and return it — in SQL, with
   * `for update skip locked` and a reclaim window, so two runners racing one
   * step do not both bill it. Shape copied from
   * `rescript_claim_transcription` (migration 0027).
   */
  claim(taskId: string, opts?: { staleSeconds?: number; maxAttempts?: number }): Promise<ClaimedStep | null>;
  /** the step succeeded: its output, what it cost, and what the deterministic check said */
  commit(taskId: string, stepId: string, out: { output: unknown; usage?: StepUsage; validation?: ExecStep["validation"]; batchSizeUsed?: number; idempotencyKey: string }): Promise<ExecStep>;
  /** the step failed, classified; the runner decides whether to retry */
  fail(taskId: string, stepId: string, failure: { kind: StepFailureKind; message: string; retryable: boolean }): Promise<ExecStep>;
  /** replace the step set for a new plan version, preserving completed steps (R2's reconciliation writes through this) */
  revise(taskId: string, planVersion: number, steps: Omit<ExecStep, "taskId" | "retryCount">[], tombstoned: string[]): Promise<ExecTask>;
  setStatus(taskId: string, status: TaskStatus, report?: ExecTask["report"]): Promise<void>;
  /** the earliest step that is not finished — where a resumed task picks up */
  earliestIncomplete(taskId: string): Promise<ExecStep | null>;
  /** tasks left running or pending past their reclaim window, for the cron continuation */
  stale(olderThanMs: number, limit?: number): Promise<{ id: string; surveyId: string }[]>;
}

export async function taskStoreFor(_surveyId: string): Promise<TaskStore> {
  return TODO("taskStoreFor");
}
