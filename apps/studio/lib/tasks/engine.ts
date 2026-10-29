/**
 * THE GLUE BETWEEN THE HANDLER CONTRACT AND THE BASE RUNNER (2026-10-29).
 *
 * This is NOT a second engine. The base runner (`lib/copilot/runner.ts` `runSlice`) owns WHEN a step runs — the
 * claim, the lease, the deadline, the retries, the halving, the commit, the plan revision on `split`/`repair`, the
 * pause on `blocked` — and the base store owns the rows. What K's `engine.ts` did on top of its own store is
 * re-expressed here as three pure pieces the runner is handed:
 *
 *   planTask / createPlannedTask   a registered planner's `TaskStepSpec[]` → `ExecStep` seeds → `store.create`,
 *                                  with the task's summary, completion criteria, planner id and base survey on the row
 *   handlerBuildStep               the `BuildStep` the runner calls: looks the step's handler up by `kind`, builds
 *                                  `StepContext` (`ctx.draft` from draft.ts, `ctx.ai` from the injected door), runs
 *                                  the handler, and maps its `StepResult` onto the runner's `BuildStepResult`
 *   taskCheck                      the deliverable gate the runner's `check` needs: the base's `checkDeliverable`
 *                                  on the replayed draft, the planner's completion criteria through
 *                                  `validateSurveyDeliverable`, every registered completion validator, and every
 *                                  step whose own validation failed and was not repaired
 *
 * Pure with respect to I/O: the store and the model door are injected, so `engine.test.ts` drives whole tasks on
 * the memory store with the fake responders.
 */
import { createHash } from "node:crypto";
import type { SurveyDefinition } from "@rescript/schema";
import {
  parseCompletionCriteria, readGenerationRequest, validateSurveyDeliverable,
  type DeliverableReport, type DeliverableSpec, type ExecStep, type ExecTask, type TaskBlocked, type TaskKind,
} from "@rescript/engine";
import type { BuildContext, BuildStep, BuildStepResult, StepSeed } from "../copilot/runner.ts";
import type { CreateTaskInput, TaskStore } from "../copilot/taskStore.ts";
import { checkDeliverable, specFromRequest } from "../copilot/deliverable.ts";
import { taskKindFor } from "../copilot/planPersistence.ts";
import { getStepHandler, getTaskPlanner, listCompletionValidators, pickTaskPlanner } from "./registry.ts";
import { buildDraft } from "./draft.ts";
import { resultForFailure, stepFailureKindOf } from "./failures.ts";
import { stepUsageOf, zeroAttemptUsage, type AttemptUsage } from "./attempt.ts";
import type { AiFn, FailureKind, StepContext, StepOutput, StepResult, TaskPlanner, TaskStepSpec, TaskSummary } from "./types.ts";

/* ------------------------------------------------------------ the deps */

export interface AiForArgs { task: Pick<ExecTask, "id" | "surveyId">; step: ExecStep | null; attempt: number; deadline: number; signal: AbortSignal; usage: AttemptUsage }

export interface TaskEngineDeps {
  store: TaskStore;
  /** the model door for one attempt of one step (null step: the planner's own call) — the request's meter or the background's */
  aiFor(a: AiForArgs): AiFn;
  /** the survey a task with no snapshot was made against (a plan-item task of the item path) */
  baseFor?(task: ExecTask): Promise<SurveyDefinition | null>;
  now?: () => number;
}

/* ------------------------------------------------------------ specs → seeds */

/** a stable hash of a step's input: the idempotency key's content half, so a changed input is new work */
export function hashInput(x: unknown): string { return createHash("sha256").update(stableJson(x)).digest("hex").slice(0, 24); }
export function stableJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  return `{${Object.keys(x as object).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** a planner's step → the row the store keeps (status pending; the key binds survey, step and input) */
export function specToSeed(surveyId: string, spec: TaskStepSpec, planVersion = 1): StepSeed {
  const units = typeof spec.input?.units === "number" && Number.isFinite(spec.input.units) ? Math.max(1, Math.round(spec.input.units as number)) : undefined;
  return {
    stepId: spec.id,
    planVersion,
    dependsOn: [...new Set(spec.dependsOn ?? [])],
    status: "pending",
    title: spec.title,
    kind: spec.kind,
    input: spec.input ?? {},
    ...(spec.parallelGroup ? { parallelGroup: spec.parallelGroup } : {}),
    ...(spec.modelTier ? { modelTier: spec.modelTier } : {}),
    ...(units !== undefined ? { batchSize: units } : {}),
    idempotencyKey: `${surveyId}:${spec.id}:${hashInput(spec.input ?? {})}`,
  };
}

/** the row back as the handler's spec */
export function specOf(s: ExecStep): TaskStepSpec & { status: ExecStep["status"] } {
  return {
    id: s.stepId, kind: s.kind ?? "", title: s.title ?? s.stepId, dependsOn: [...s.dependsOn], input: s.input ?? {},
    ...(s.parallelGroup ? { parallelGroup: s.parallelGroup } : {}), ...(s.modelTier ? { modelTier: s.modelTier } : {}), status: s.status,
  };
}

/** a plan the runner can run: unique ids, known dependencies, no cycle, a handler for every kind */
export function checkPlan(steps: TaskStepSpec[], hasHandler: (kind: string) => boolean): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s.id !== "string" || !s.id) { errs.push("a step without an id"); continue; }
    if (ids.has(s.id)) errs.push(`duplicate step id ${s.id}`);
    ids.add(s.id);
    if (!hasHandler(s.kind)) errs.push(`no handler is registered for step kind “${s.kind}” (${s.id})`);
  }
  for (const s of steps) for (const d of s.dependsOn ?? []) if (!ids.has(d)) errs.push(`${s.id} depends on unknown step ${d}`);
  const indeg = new Map(steps.map((s) => [s.id, (s.dependsOn ?? []).filter((d) => ids.has(d)).length]));
  const q = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let seen = 0;
  while (q.length) {
    const id = q.shift()!; seen++;
    for (const s of steps) if ((s.dependsOn ?? []).includes(id)) { const n = indeg.get(s.id)! - 1; indeg.set(s.id, n); if (n === 0) q.push(s.id); }
  }
  if (seen < steps.length && !errs.length) errs.push("the plan's dependencies form a cycle");
  return errs;
}

/* ------------------------------------------------------------ the task kind and its deliverable */

/** the base's TaskKind for a planner's task: the planner says what it builds; the request decides the rest */
export function taskKindOf(plannerId: string, request: string, survey: unknown): TaskKind {
  if (plannerId === "translation") return "translation";
  if (plannerId === "assessment") return "scored_exam";
  if (plannerId === "generation") {
    const req = readGenerationRequest(request, survey);
    if (req.kind === "methods") return req.method === "maxdiff" ? "maxdiff" : "conjoint";
    return "survey_build";
  }
  const k = taskKindFor(request);
  return k === "other" ? "survey_build" : k;
}

/**
 * What "done" means for a planned task: the base's spec reader with the planner's kind as the hint (an exam planned
 * by the generation planner is a survey build — the answer key is the assessment planner's to promise), and the
 * final count from the planner's own `questions>=N` / `questions=N` criterion, never from the request's words alone
 * (an "add 30 questions" on a 12-question survey must deliver 42, not 30).
 */
export function deliverableOf(kind: TaskKind, request: string, completion: readonly string[]): DeliverableSpec {
  const spec = specFromRequest(request, { kind });
  delete spec.questionCount;
  if (kind !== "translation") delete spec.language;
  for (const line of completion) {
    const m = /^questions\s*(>=|=)\s*(\d+)$/i.exec(String(line).trim());
    if (m) spec.questionCount = Number(m[2]);
  }
  return spec;
}

/* ------------------------------------------------------------ planning */

export interface PlanTaskInput {
  surveyId: string;
  message: string;
  definition: SurveyDefinition;
  /** a registered planner by id; otherwise the best deterministic match */
  plannerId?: string;
  customerId?: string;
  createdBy?: string;
  /** absolute ms: the planner's one call may not run past this */
  deadline: number;
  signal?: AbortSignal;
}

export type PlanOutcome =
  | { ok: true; task: ExecTask; planner: string; steps: number; usage: AttemptUsage }
  | { ok: false; reason: "no_planner" | "invalid_plan" | "planner_failed"; message: string; errors?: string[]; usage: AttemptUsage };

/**
 * Plan the request with a registered planner and create the task: the planner's one model call (an outline) runs
 * under the caller's door, and the plan is checked before a row exists. A planner that throws leaves nothing
 * behind. Pure over the store.
 */
export async function createPlannedTask(deps: TaskEngineDeps, input: PlanTaskInput): Promise<PlanOutcome> {
  const usage = zeroAttemptUsage();
  const planner: TaskPlanner | undefined = input.plannerId ? getTaskPlanner(input.plannerId) : pickTaskPlanner({ message: input.message, survey: input.definition })?.planner;
  if (!planner) return { ok: false, reason: "no_planner", message: "No registered planner claims this request.", usage };
  const ctrl = new AbortController();
  input.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const ai = deps.aiFor({ task: { id: "__plan", surveyId: input.surveyId }, step: null, attempt: 0, deadline: input.deadline, signal: ctrl.signal, usage });
  let plan: Awaited<ReturnType<TaskPlanner["plan"]>>;
  try {
    plan = await planner.plan({ message: input.message, survey: input.definition, ai });
  } catch (e) {
    return { ok: false, reason: "planner_failed", message: String((e as Error)?.message ?? e).slice(0, 300), usage };
  }
  const errs = checkPlan(plan.steps, (k) => !!getStepHandler(k));
  if (errs.length) return { ok: false, reason: "invalid_plan", message: `The plan could not be used: ${errs.slice(0, 3).join("; ")}.`, errors: errs, usage };
  const kind = taskKindOf(planner.id, input.message, input.definition);
  const create: CreateTaskInput = {
    surveyId: input.surveyId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    kind,
    request: input.message,
    deliverable: deliverableOf(kind, input.message, plan.completion),
    steps: plan.steps.map((s) => specToSeed(input.surveyId, s, 1)),
    summary: plan.summary,
    completion: plan.completion,
    planner: planner.id,
    base: input.definition,
  };
  const task = await deps.store.create(create);
  if (usage.charge > 0) await deps.store.addExtraCharge(task.id, usage.charge).catch(() => undefined);
  return { ok: true, task, planner: planner.id, steps: plan.steps.length, usage };
}

/* ------------------------------------------------------------ building one step */

/** the TaskSummary a plan-item task (no planner) is told: the request as recorded, nothing else */
export function summaryOf(task: Pick<ExecTask, "request" | "summary" | "deliverable">): TaskSummary {
  if (task.summary) return task.summary;
  return { goal: task.request.replace(/\s+/g, " ").trim().slice(0, 400), deliverables: [], constraints: [], decisions: [], sourceTurnIds: [] };
}

/** a TaskSummary from a request when the planner gives none */
export function summaryFromMessage(message: string, deliverables: string[] = [], language?: string): TaskSummary {
  return { goal: message.replace(/\s+/g, " ").trim().slice(0, 400), deliverables, constraints: [], decisions: [], ...(language ? { language } : {}), sourceTurnIds: [] };
}

/** a handler or planner that threw: what kind of failure that is */
export function classifyThrown(e: unknown): { kind: FailureKind; message: string; retryAfterMs?: number } {
  const x = (e ?? {}) as { failureKind?: unknown; message?: unknown; retryAfterMs?: unknown; name?: unknown };
  const kinds: FailureKind[] = ["network", "rate_limit", "provider_outage", "context_limit", "output_limit", "auth", "invalid_output", "validation", "config", "budget", "cancelled", "unknown"];
  const kind = kinds.includes(x.failureKind as FailureKind) ? (x.failureKind as FailureKind) : x.name === "AbortError" ? "cancelled" : "unknown";
  return { kind, message: String(x.message ?? e ?? "unknown error").slice(0, 500), ...(typeof x.retryAfterMs === "number" ? { retryAfterMs: x.retryAfterMs } : {}) };
}

const BLOCKED_REASON: Record<NonNullable<Extract<StepResult, { status: "blocked" }>["needs"]>, TaskBlocked> = { auth: "auth", config: "config", budget: "wallet", user_input: "user_input" };

/**
 * A handler's answer in the runner's terms. `completed` and `repair` carry the output (and the attempt's usage);
 * `split` carries the children; `blocked` the pause reason; `retry` and `failed` become an error the runner's
 * `readFailure` classifies — `rate_limited` with its Retry-After, `network` (transient, bounded), or a `permanent`
 * hint that stops the step and preserves the task.
 */
export function buildResultOf(r: StepResult, surveyId: string, planVersion: number, usage: AttemptUsage, stepId = ""): BuildStepResult {
  const u = stepUsageOf(usage);
  switch (r.status) {
    case "completed": {
      const v = validationOf(r.output);
      return { output: r.output, ...(u ? { usage: u } : {}), validation: { status: v.ok ? "valid" : "invalid", ...(v.errors.length ? { errors: v.errors } : {}) } };
    }
    case "repair": {
      const v = validationOf(r.output);
      /* the repair step records which step it repairs, so the completion gate judges that step by the repair's outcome and not twice */
      return { output: r.output, ...(u ? { usage: u } : {}), validation: { status: v.ok ? "valid" : "invalid", ...(v.errors.length ? { errors: v.errors } : {}) }, repair: specToSeed(surveyId, { ...r.repair, input: { ...r.repair.input, repairs: stepId } }, planVersion + 1) };
    }
    case "split":
      return { split: r.replaceWith.map((s) => specToSeed(surveyId, s, planVersion + 1)), reason: r.reason, ...(u ? { usage: u } : {}) };
    case "blocked":
      return { blocked: { reason: BLOCKED_REASON[r.needs ?? "user_input"], message: r.reason.slice(0, 500) }, ...(u ? { usage: u } : {}) };
    case "retry": {
      const rate = /^rate_limit\b/.test(r.reason) || !!r.retryAfterMs;
      return { error: { kind: rate ? "rate_limited" : "network", message: r.reason, ownWords: true, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) } };
    }
    case "failed":
      return { error: r.permanent ? { hint: "permanent", message: r.reason, ownWords: true } : { kind: "network", message: r.reason, ownWords: true } };
  }
}

function validationOf(o: StepOutput | undefined): { ok: boolean; errors: string[]; warnings: string[] } {
  const v = o?.validation;
  return { ok: !!v && v.ok !== false, errors: Array.isArray(v?.errors) ? v!.errors.map(String).slice(0, 50) : [], warnings: Array.isArray(v?.warnings) ? v!.warnings.map(String).slice(0, 50) : [] };
}

/**
 * THE `BuildStep` THE RUNNER IS HANDED for a task whose steps carry a `kind`. It reloads the task from the store on
 * every call (so `ctx.draft` and `ctx.deps` see every step committed by this or any other slice), builds the
 * context, runs the handler, and maps the answer. A step with no handler blocks the task (`config`) rather than
 * inventing a build; a handler that throws is classified like a failed model call.
 */
export function handlerBuildStep(deps: TaskEngineDeps, task0: ExecTask): BuildStep {
  return async function buildOne(step: ExecStep, build: BuildContext): Promise<BuildStepResult> {
    const usage = zeroAttemptUsage();
    try {
      const kind = step.kind ?? "";
      const handler = getStepHandler(kind);
      if (!handler) return { blocked: { reason: "config", message: `No handler is registered for step kind “${kind || "(none)"}” on this server.` } };
      const task = (await deps.store.load(task0.id)) ?? task0;
      const base = task.base ? null : await deps.baseFor?.(task) ?? null;
      const draft = buildDraft(task, base);
      const depOut: Record<string, StepOutput> = {};
      for (const d of step.dependsOn) {
        const ds = task.steps.find((x) => x.stepId === d);
        if (ds?.status === "completed" && ds.output && typeof ds.output === "object") depOut[d] = ds.output as StepOutput;
      }
      const ctrl = new AbortController();
      build.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
      const ai = deps.aiFor({ task, step, attempt: build.attempt, deadline: build.deadline, signal: ctrl.signal, usage });
      const ctx: StepContext = {
        taskId: task.id, planVersion: task.planVersion, surveyId: task.surveyId, attempt: build.attempt,
        step: specOf(step), deps: depOut, draft: draft.def, summary: summaryOf(task), ai, deadlineMs: build.deadline, signal: ctrl.signal,
      };
      let result: StepResult;
      try {
        result = await handler.run(ctx);
      } catch (e) {
        const f = classifyThrown(e);
        result = ctrl.signal.aborted ? { status: "retry", reason: "network: the step ran out of time" } : resultForFailure(f);
        if (result.status === "failed" && f.kind === "unknown") result = { status: "retry", reason: `unknown: ${f.message}` };
      }
      return buildResultOf(result, task.surveyId, task.planVersion, usage, step.stepId);
    } catch (e) {
      /* a throw here is this step's failure, never the slice's — runSlice classifies it */
      return { error: { kind: "network", message: String((e as Error)?.message ?? e).slice(0, 300) } };
    }
  };
}

/* ------------------------------------------------------------ completion */

/**
 * THE DELIVERABLE GATE for a planned task, the only thing that makes it `completed`: the draft replays without
 * refusal, every step's own validation passed (or a repair step after it did), the planner's completion criteria
 * hold on the draft, every registered completion validator passes, and the base's `checkDeliverable` agrees.
 */
export async function taskCheck(deps: Pick<TaskEngineDeps, "baseFor">, task: ExecTask): Promise<DeliverableReport> {
  const base = task.base ? null : await deps.baseFor?.(task) ?? null;
  const draft = buildDraft(task, base);
  const problems: string[] = [];
  for (const e of draft.errors.slice(0, 20)) problems.push(`${task.steps.find((s) => s.stepId === e.stepId)?.title ?? e.stepId}: ${e.error}`);
  /* a step whose own validation failed but that a later repair step covers is judged by the deliverable check, not twice */
  const repaired = new Set(task.steps.filter((s) => s.status === "completed" && (typeof s.input?.repairs === "string" || /repair/i.test(s.kind ?? ""))).flatMap((s) => (typeof s.input?.repairs === "string" ? [s.input.repairs as string] : s.dependsOn)));
  for (const s of task.steps) {
    if (s.status !== "completed" || s.validation?.status !== "invalid" || repaired.has(s.stepId)) continue;
    problems.push(...(s.validation.errors?.length ? s.validation.errors.map((e) => `${s.title ?? s.stepId}: ${e}`) : [`${s.title ?? s.stepId}: did not validate`]));
  }
  const measured: Record<string, number | string | boolean> = {};
  if (task.completion?.length) {
    try {
      const rep = validateSurveyDeliverable(draft.def, parseCompletionCriteria(task.completion));
      problems.push(...rep.errors.map((e) => e.message));
      measured.respondentQuestions = rep.stats.respondentQuestions;
    } catch (e) { problems.push(`the deliverable check failed: ${(e as Error).message}`); }
  }
  for (const [id, fn] of listCompletionValidators()) {
    try {
      const v = fn(draft.def, task.completion ?? [], { id: task.id, planner: task.planner ?? "", summary: task.summary });
      if (v && !v.ok) problems.push(...(v.errors.length ? v.errors : [`${id} did not pass`]));
    } catch (e) { problems.push(`${id} failed: ${(e as Error).message}`); }
  }
  const basic = checkDeliverable(task.deliverable, draft.def);
  problems.push(...basic.problems);
  return { ok: !problems.length, problems: [...new Set(problems)].slice(0, 60), measured: { ...basic.measured, ...measured, folded: draft.folded.length } };
}

/* ------------------------------------------------------------ the result the researcher applies */

export interface TaskResult { actions: unknown[]; data: Record<string, unknown>; steps: number; artifacts: { stepId: string; ref: string; title: string }[] }

/** every completed step's actions in plan order (one proposal), and the data the steps produced */
export function taskResult(task: Pick<ExecTask, "steps">): TaskResult {
  const done = task.steps.filter((s) => s.status === "completed");
  const actionsOf = (o: unknown): unknown[] => (Array.isArray(o) ? o : o && typeof o === "object" && Array.isArray((o as { actions?: unknown }).actions) ? (o as { actions: unknown[] }).actions : []);
  return {
    actions: done.flatMap((s) => actionsOf(s.output)),
    data: Object.fromEntries(done.filter((s) => s.output && typeof s.output === "object" && (s.output as { data?: unknown }).data !== undefined).map((s) => [s.stepId, (s.output as { data: unknown }).data])),
    steps: done.length,
    artifacts: done.filter((s) => typeof (s.output as { artifactRef?: unknown } | null)?.artifactRef === "string").map((s) => ({ stepId: s.stepId, ref: (s.output as { artifactRef: string }).artifactRef, title: s.title ?? s.stepId })),
  };
}
