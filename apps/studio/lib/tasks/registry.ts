/**
* THE REGISTRY (2026-10-29, ported from K1 onto the base engine). Step handlers and task planners register
 * here (generation here; translation — E2; assessments — E3); the runner (lib/copilot/runner.ts, `handlerBuildStep`)
 * looks a step's handler up by its `kind`, and the turn route (lib/tasks/turnTask.ts) picks the planner with the best
 * deterministic `matches()` score. Registration is idempotent by kind/id (last registration wins — safe under
 * Next.js hot reload).
 *
 * Durable task engine registry (K1). Step handlers and task planners register
 * here (K2 generation, K3 translation, K4 assessment); the engine looks them up
 * by `kind` / best `matches()` score. Registration is idempotent by kind/id
 * (last registration wins — safe under Next.js hot reload).
 */
import type { StepHandler, TaskPlanner } from "./types.ts";

const G = globalThis as unknown as { __rescriptTaskRegistry?: { handlers: Map<string, StepHandler>; planners: Map<string, TaskPlanner> } };
const reg = (G.__rescriptTaskRegistry ??= { handlers: new Map(), planners: new Map() });

export function registerStepHandler(h: StepHandler): void {
  if (!h || typeof h.kind !== "string" || !h.kind || typeof h.run !== "function") throw new Error("registerStepHandler: invalid handler");
  reg.handlers.set(h.kind, h);
}

export function registerTaskPlanner(p: TaskPlanner): void {
  if (!p || typeof p.id !== "string" || !p.id || typeof p.matches !== "function" || typeof p.plan !== "function") throw new Error("registerTaskPlanner: invalid planner");
  reg.planners.set(p.id, p);
}

export function getStepHandler(kind: string): StepHandler | undefined {
  return reg.handlers.get(kind);
}

export function getTaskPlanner(id: string): TaskPlanner | undefined {
  return reg.planners.get(id);
}

export function listStepHandlers(): StepHandler[] {
  return [...reg.handlers.values()];
}

export function listTaskPlanners(): TaskPlanner[] {
  return [...reg.planners.values()];
}

/** Best planner for a request (highest deterministic score > 0; ties → registration order). */
export function pickTaskPlanner(input: { message: string; survey: unknown; activeTask?: unknown }): { planner: TaskPlanner; score: number } | null {
  let best: { planner: TaskPlanner; score: number } | null = null;
  for (const p of reg.planners.values()) {
    let s = 0;
    try { s = Number(p.matches(input)) || 0; } catch { s = 0; }
    if (s > 0 && (!best || s > best.score)) best = { planner: p, score: s };
  }
  return best;
}

/** Test seam: clear all registrations. */
export function __resetTaskRegistry(): void {
  reg.handlers.clear();
  reg.planners.clear();
}

/* ------------------------------------------------------------ completion validators (additive, K1 2026-10-25) */

import type { StepValidation } from "./types.ts";
/**
 * A check of the FINAL draft before a task may be `completed` (K4's assessment validation, a translation
 * completeness check …). Return null when it does not apply to this task's completion criteria. A task completes only
 * when every applicable validator returns ok.
 */
export type CompletionValidator = (draft: unknown, completion: string[], task: { id: string; planner: string; summary: unknown }) => StepValidation | null;
const G2 = globalThis as unknown as { __rescriptCompletionValidators?: Map<string, CompletionValidator> };
const validators = (G2.__rescriptCompletionValidators ??= new Map());
export function registerCompletionValidator(id: string, fn: CompletionValidator): void { validators.set(id, fn); }
export function listCompletionValidators(): [string, CompletionValidator][] { return [...validators.entries()]; }
