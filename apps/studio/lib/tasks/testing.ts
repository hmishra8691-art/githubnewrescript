/**
 * WHOLE TASKS IN-PROCESS, for the unit tests of a handler family (2026-10-29). The memory store, the registered
 * fake responders as the model, the base runner's `runSlice` with `handlerBuildStep`, the deliverable gate — no
 * server, no provider, no clock tricks. A family's test plans a request, drives it to a stop and reads the rows.
 */
import type { SurveyDefinition } from "@rescript/schema";
import type { ExecTask } from "@rescript/engine";
import { runSlice, type RunSliceOptions, type SliceResult } from "../copilot/runner.ts";
import { isolatedTaskStore, type TaskStore } from "../copilot/taskStore.ts";
import { fakeTaskAi, zeroAttemptUsage, type AttemptUsage } from "./attempt.ts";
import { createPlannedTask, handlerBuildStep, taskCheck, type PlanOutcome, type TaskEngineDeps } from "./engine.ts";
import { registerAllTaskHandlers } from "./handlers/index.ts";

export interface InProcessOptions {
  message: string;
  definition: SurveyDefinition;
  plannerId?: string;
  store?: TaskStore;
  surveyId?: string;
  /** at most this many slices before giving up (a stuck task never loops forever in a test) */
  maxSlices?: number;
  /** each slice's budget (real ms; the fake answers in microseconds) */
  budgetMs?: number;
  /** extra runner options (a sink, a cancel signal, retry seams) */
  slice?: Partial<RunSliceOptions>;
  /** what every fake call is charged, to make spend assertions real */
  charge?: number;
}

export interface InProcessResult { task: ExecTask; plan: PlanOutcome; slices: SliceResult[]; calls: number; usage: AttemptUsage; store: TaskStore }

/** a backoff that keeps the event loop alive and never waits long: the runner's own sleep unrefs its timer, which is right for a server and fatal for a test */
export const quickSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, Math.min(5, Math.max(0, ms))));
/** the per-step deadline in a test: real, and unref'd so a guard that never fires does not hold the process open */
export const guardSleep = (ms: number): Promise<void> => new Promise((res) => { const t = setTimeout(res, Math.max(1, ms)); (t as unknown as { unref?: () => void }).unref?.(); });

/** the engine deps a test uses: the memory store and the fake door */
export function testDeps(store: TaskStore, usage: AttemptUsage = zeroAttemptUsage(), charge?: number): TaskEngineDeps & { usage: AttemptUsage } {
  return {
    store,
    usage,
    aiFor: (a) => {
      const door = fakeTaskAi(a.usage, charge !== undefined ? { charge } : {});
      return async (call) => { usage.calls++; const r = await door(call); if (!r.ok) usage.failedCalls++; return r; };
    },
  };
}

/** plan the request and run it to a stop */
export async function runTaskInProcess(o: InProcessOptions): Promise<InProcessResult> {
  registerAllTaskHandlers();
  const store = o.store ?? isolatedTaskStore();
  const deps = testDeps(store, zeroAttemptUsage(), o.charge);
  const surveyId = o.surveyId ?? "sandbox";
  const plan = await createPlannedTask(deps, { surveyId, message: o.message, definition: o.definition, ...(o.plannerId ? { plannerId: o.plannerId } : {}), deadline: Date.now() + 60_000 });
  if (!plan.ok) throw new Error(`plan failed: ${plan.reason} ${plan.message}`);
  const slices: SliceResult[] = [];
  const max = o.maxSlices ?? 60;
  let task = plan.task;
  for (let i = 0; i < max; i++) {
    const r = await runSlice(task.id, { budgetMs: o.budgetMs ?? 60_000, store, buildStep: handlerBuildStep(deps, task), check: (t) => taskCheck(deps, t), sleep: quickSleep, deadlineSleep: guardSleep, ...(o.slice ?? {}) });
    slices.push(r);
    task = (await store.load(task.id))!;
    if (task.status !== "running" && task.status !== "pending") break;
    if (r.stoppedBy === "drained" && !r.built.length && !r.failed.length) break;
    if (r.stoppedBy === "terminal" || r.stoppedBy === "blocked" || r.stoppedBy === "paused" || r.stoppedBy === "cancelled") break;
  }
  return { task, plan, slices, calls: deps.usage.calls, usage: deps.usage, store };
}

/** one more slice on an existing task (a resume, a second worker) */
export async function sliceInProcess(store: TaskStore, taskId: string, extra: Partial<RunSliceOptions> = {}, charge?: number): Promise<SliceResult> {
  registerAllTaskHandlers();
  const deps = testDeps(store, zeroAttemptUsage(), charge);
  const task = (await store.load(taskId))!;
  return runSlice(taskId, { budgetMs: 60_000, store, buildStep: handlerBuildStep(deps, task), check: (t) => taskCheck(deps, t), sleep: quickSleep, deadlineSleep: guardSleep, ...extra });
}
