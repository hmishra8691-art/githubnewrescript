/**
 * THE HANDLER CONTRACT — what a planner and a step handler see (2026-10-29).
 *
 * Ported from the unfinished K1 branch onto the base engine (`packages/engine/src/execPlan.ts`,
 * `lib/copilot/taskStore.ts`, `lib/copilot/runner.ts`). This file is the ONLY thing a handler family (generation
 * here, translation — E2, assessments — E3) imports besides `registry.ts`; it is extended additively and never
 * reshaped. The shapes are K's, verbatim where the base already agreed and mapped where it did not:
 *
 *   TaskStepSpec   what a planner emits — the runner stores it as an `ExecStep` (`stepId` = id, `kind`, `input`,
 *                  `dependsOn`, `parallelGroup`, `modelTier`; `title`; `batchSize` = `input.units` when numeric)
 *   StepResult     what a handler returns — the runner commits `completed`, revises the plan on `split` / `repair`
 *                  (tombstone + new steps, dependents rewired), pauses the task on `blocked`, backs off on `retry`,
 *                  and classifies `failed` (permanent → the step stops and the task is preserved; otherwise a
 *                  bounded retry)
 *   StepContext    `draft` is the task's base survey with every completed step's actions replayed in plan order
 *                  (deterministic ids); `deps` the outputs of the steps this one depends on; `summary` the task's
 *                  persisted summary; `ai` the ONE door to a model (metered, classified, never a provider call
 *                  from a handler)
 *
 * Statuses are the BASE's: `TaskStatus` / `StepStatus` from @rescript/engine (`needs_attention` is what K called
 * `blocked` / `paused`; `tombstoned` what it called `invalidated` / `skipped`).
 */
import type { StepStatus as EngineStepStatus, TaskStatus as EngineTaskStatus, TaskSummary as EngineTaskSummary } from "@rescript/engine";

export type TaskStatus = EngineTaskStatus;
export type StepStatus = EngineStepStatus;
export type TaskSummary = EngineTaskSummary;

export interface TaskStepSpec {
  id: string;
  kind: string;
  title: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  parallelGroup?: string;
  estimate?: { inputTokens: number; outputTokens: number; usd: number };
  modelTier?: "small" | "standard" | "strong";
}

export interface StepValidation { ok: boolean; errors: string[]; warnings: string[] }
export interface StepOutput { actions?: unknown[]; data?: unknown; artifactRef?: string; validation: StepValidation }

export type StepResult =
  | { status: "completed"; output: StepOutput }
  | { status: "split"; replaceWith: TaskStepSpec[]; reason: string }            // e.g. output-token limit → smaller batches
  | { status: "repair"; output: StepOutput; repair: TaskStepSpec }              // keep output, add a targeted repair step
  | { status: "retry"; reason: string; retryAfterMs?: number }                  // transient
  | { status: "failed"; reason: string; permanent: boolean }
  | { status: "blocked"; reason: string; needs?: "auth" | "budget" | "config" | "user_input" };

export type FailureKind = "network" | "rate_limit" | "provider_outage" | "context_limit" | "output_limit" | "auth" | "invalid_output" | "validation" | "config" | "budget" | "cancelled" | "unknown";

/** what one model call used — the shape `ctx.ai` reports (K's `StepUsage`; the engine's `StepUsage` is the per-row total) */
export interface AiCallUsage { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; usd: number; model: string; billable: boolean; /** what the customer is charged, in the platform's units */ charge?: number }
export type StepUsage = AiCallUsage;

export interface AiCall { purpose: string; system?: string; prompt: string; schema?: unknown; maxTokens: number; tier?: "small" | "standard" | "strong"; guides?: string[] }
export type AiAnswer = { ok: true; value: unknown; usage: AiCallUsage } | { ok: false; kind: FailureKind; message: string; retryAfterMs?: number };
export type AiFn = (call: AiCall) => Promise<AiAnswer>;

export interface StepContext {
  taskId: string; planVersion: number; surveyId: string; attempt: number;
  step: TaskStepSpec & { status: StepStatus };
  deps: Record<string, StepOutput>;           // outputs of completed dependencies
  draft: unknown;                              // SurveyDefinition with all completed steps' actions applied (deterministic replay)
  summary: TaskSummary;                         // concise persisted requirements/decisions — never the whole brief
  ai: AiFn;
  deadlineMs: number; signal: AbortSignal;
}

export interface StepHandler { kind: string; run(ctx: StepContext): Promise<StepResult> }

export interface TaskPlanner {
  id: string;
  /** 0..1: how well this planner fits; deterministic, no model call */
  matches(input: { message: string; survey: unknown; activeTask?: unknown }): number;
  /** the plan for this request: steps + summary + completion criteria; may call the model once through `ai` for a plan skeleton */
  plan(input: { message: string; survey: unknown; summary?: TaskSummary; ai: AiFn }): Promise<{ summary: TaskSummary; steps: TaskStepSpec[]; completion: string[] }>;
}
