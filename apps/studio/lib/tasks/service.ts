import "server-only";
/**
 * THE TASK SERVICE (2026-10-29): what the routes, the turn route and the cron call — plan a request into a task,
 * advance it for a bounded time under a caller's meter, read it back redacted — with the engine's seams wired to
 * the real Studio: the base store for the project (`taskStoreFor`), the metered model door (`aiServer.ts`), the
 * survey's stored definition for a task with no snapshot, and the deliverable gate. There is no second runner
 * here: every slice is `runSlice` (lib/copilot/runner.ts) with `handlerBuildStep` (./engine.ts).
 *
 * Two ways a slice gets its meter, decided by WHO IS PRESENT and never mixed:
 *   page-driven   `/api/copilot/tasks/<id>/advance` (and the turn route's plan) — the request's own
 *                 `billingProjectFor` meter, context and one-time consent, i.e. the researcher's connection;
 *   background    the cron — `backgroundContextFor(task)`: the platform's key only, the author's right re-checked
 *                 on every slice, the wallet and the per-task ceiling; a refusal PAUSES the task with a sentence.
 */
import { randomBytes } from "node:crypto";
import type { SurveyDefinition } from "@rescript/schema";
import type { DeliverableReport, ExecTask } from "@rescript/engine";
import { runSlice, type BuildStep, type RunnerSink, type SliceResult } from "../copilot/runner.ts";
import { redactForClient, taskStoreFor, type ClientTask, type TaskStore } from "../copilot/taskStore.ts";
import { backgroundContextFor, isRefused, refusalMessage } from "../copilot/background.ts";
import { backgroundBuilderFor, loadDefinition } from "../copilot/backgroundBuild.ts";
import { makeTaskAi, type TaskAiScope } from "./aiServer.ts";
import { createPlannedTask, handlerBuildStep, taskCheck, taskResult, type PlanOutcome, type TaskEngineDeps, type TaskResult } from "./engine.ts";
import { registerAllTaskHandlers } from "./handlers/index.ts";
import { driveOf } from "../copilot/taskDrive.ts";

registerAllTaskHandlers();

/** this process's worker id, for the log */
const G = globalThis as unknown as { __rescriptTaskWorker?: string };
export const WORKER_ID = (G.__rescriptTaskWorker ??= `w-${randomBytes(4).toString("hex")}`);

const envInt = (name: string, dflt: number, min: number, max: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, Math.round(n))) : dflt; };
/** how long one page-driven advance runs for (the page calls again; the cron carries on when nobody watches). Never the route's whole budget: a slice is one or two steps. */
export const ADVANCE_BUDGET_MS = envInt("COPILOT_TASK_ADVANCE_MS", 60_000, 5_000, 90_000);
/** plan-first routing of non-trivial requests is on unless switched off */
export const tasksEnabled = (env: Record<string, string | undefined> = process.env): boolean => (env.COPILOT_TASKS ?? "").trim().toLowerCase() !== "off";

/** the survey a task with no snapshot was made against: the stored definition (null on the database-less sandbox) */
export async function baseFor(task: ExecTask): Promise<SurveyDefinition | null> {
  if (task.base) return task.base as SurveyDefinition;
  return loadDefinition(task.surveyId);
}

/** the engine deps for a slice run under the request's own meter and consent */
export function requestDeps(store: TaskStore, scope: TaskAiScope): TaskEngineDeps {
  return { store, aiFor: (a) => makeTaskAi(scope, a), baseFor };
}

/* ------------------------------------------------------------ planning */

export interface PlanForRequestInput {
  store: TaskStore; scope: TaskAiScope; surveyId: string; message: string; definition: SurveyDefinition;
  customerId?: string; createdBy?: string; deadline: number; signal?: AbortSignal; plannerId?: string;
}

/** plan the request with the best registered planner under the request's meter; the planner's one call is paid by the request */
export function planForRequest(i: PlanForRequestInput): Promise<PlanOutcome> {
  return createPlannedTask(requestDeps(i.store, i.scope), { surveyId: i.surveyId, message: i.message, definition: i.definition, ...(i.customerId ? { customerId: i.customerId } : {}), ...(i.createdBy ? { createdBy: i.createdBy } : {}), deadline: i.deadline, ...(i.signal ? { signal: i.signal } : {}), ...(i.plannerId ? { plannerId: i.plannerId } : {}) });
}

/* ------------------------------------------------------------ advancing */

export interface AdvanceInput { store: TaskStore; scope: TaskAiScope; task: ExecTask; budgetMs?: number; signal?: AbortSignal; sink?: RunnerSink; maxSteps?: number }

/**
 * One page-driven slice: the researcher is present, so a task paused for a reason only the background has
 * (`byok`, `wallet`, `ceiling`, `no_author`) is released first — their own connection and consent are exactly what
 * those refusals were waiting for. A task paused by a handler (`auth`, `config`, `user_input`) or by a lost right
 * waits for an explicit Resume.
 */
export async function advanceForRequest(i: AdvanceInput): Promise<SliceResult> {
  const deps = requestDeps(i.store, i.scope);
  let task = i.task;
  if (task.status === "needs_attention" && task.blocked && ["byok", "wallet", "ceiling", "no_author"].includes(task.blocked.reason)) {
    await i.store.pause(task.id, null);
    task = (await i.store.load(task.id)) ?? task;
  }
  const buildStep = builderFor(deps, task);
  return runSlice(task.id, {
    budgetMs: Math.max(5_000, Math.min(i.budgetMs ?? ADVANCE_BUDGET_MS, 90_000)), store: i.store, buildStep,
    check: (t) => taskCheck(deps, t), ...(i.signal ? { signal: i.signal } : {}), ...(i.sink ? { sink: i.sink } : {}), ...(i.maxSteps != null ? { maxSteps: i.maxSteps } : {}),
  });
}

/** a task planned by a registered planner is built by its handlers; a plan-item task (no planner) is the item path's and cannot be driven here */
export function isHandlerTask(task: Pick<ExecTask, "planner" | "steps">): boolean {
  return !!task.planner || (Array.isArray(task.steps) && task.steps.some((s) => !!s.kind));
}

function builderFor(deps: TaskEngineDeps, task: ExecTask): BuildStep {
  if (isHandlerTask(task)) return handlerBuildStep(deps, task);
  /* the existing survey_build item path has no page-driven slice: the turn route's execute stage builds it */
  return async () => ({ blocked: { reason: "user_input", message: "This task is built by the page's own plan loop (Resume in the copilot card), not by the execution panel." } });
}

/* ------------------------------------------------------------ the background (the cron) */

/**
 * The builder the cron registers through `setStepBuilder`: a handler task runs under `backgroundContextFor`'s
 * meter (platform key only, authority re-checked, wallet + ceiling), a plan-item task under the item path as
 * before. Returns null — having paused the task and said why — when it may not run unattended.
 */
export async function backgroundBuilderForTask(task: ExecTask, scope?: TaskAiScope): Promise<BuildStep | null> {
  if (!isHandlerTask(task)) return backgroundBuilderFor(task);
  if (scope) return handlerBuildStep(requestDeps(await taskStoreFor(task.surveyId), scope), task);
  const outcome = await backgroundContextFor(task);
  if (isRefused(outcome)) {
    if (!outcome.refused.unverified) {
      const store = await taskStoreFor(task.surveyId);
      await store.pause(task.id, { reason: outcome.refused.kind, message: refusalMessage(outcome.refused) }).catch(() => undefined);
    }
    return null;
  }
  const store = await taskStoreFor(task.surveyId);
  return handlerBuildStep(requestDeps(store, { meter: outcome.meter, ctx: outcome.ctx }), task);
}

/** the deliverable gate for the cron's slice of a handler task (the item path's tasks keep the route's `checkDeliverable`) */
export async function backgroundCheck(task: ExecTask): Promise<DeliverableReport> {
  return taskCheck({ baseFor }, task);
}

/* ------------------------------------------------------------ what a client sees */

export interface TaskClientView extends ClientTask {
  /** the result is ready to review: every step done, the deliverable check passed */
  resultReady: boolean;
  /** what the browser's drive loop does next, decided here so two pages agree */
  drive: "advance" | "wait" | "stop";
}

export function viewOf(task: ExecTask): TaskClientView {
  const c = redactForClient(task);
  /* "advance" only while a step can still be claimed — see driveOf (lib/copilot/taskDrive.ts) */
  return { ...c, resultReady: task.status === "completed", drive: driveOf(task) };
}

/** the proposal a completed task hands to the ordinary review: every completed step's actions in plan order */
export function resultOf(task: ExecTask): TaskResult | null {
  return task.status === "completed" ? taskResult(task) : null;
}

/** test seam, fake provider outside production only: the persisted step rows with their outputs (what the suites verify) */
export const stepsVisible = (): boolean => (process.env.AI_API_URL ?? "") === "fake:" && process.env.NODE_ENV !== "production";
