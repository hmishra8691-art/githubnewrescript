/**
 * DURABLE EXECUTION STATE — the shape of a long task and its steps.
 *
 * Why this exists. A plan-first generation is a plan plus one model call per
 * item. Until now the only record of what had been built lived in the
 * browser: a checkpoint in `localStorage`, sent back as `done[]` with every
 * continuation (apps/studio/lib/copilot/resume.ts). A new tab, another
 * device, cleared storage or a closed laptop lost it, and the next execution
 * started over. These types are the server's own record of the same thing, so
 * the work survives the page.
 *
 * This module is TYPES AND PURE PREDICATES ONLY. It names no table, imports
 * no database client and reads no environment: the engine stays env-free
 * (archBoundaries). The store that persists these rows is
 * apps/studio/lib/copilot/taskStore.ts; the runner that advances them is
 * apps/studio/lib/copilot/runner.ts.
 *
 * Nothing here replaces the plan → items mechanism. A task is a durable
 * SHADOW of a ChangePlan: one step per approved plan item, plus whatever
 * extra steps a task kind needs (a translation batch, a validation pass).
 */

/* ------------------------------------------------------------ the task */

/**
 * What kind of thing this task delivers. The kind picks the deliverable spec
 * that decides when the task is complete — a question count means nothing for
 * a conjoint design, and a translation is done only when its mandatory keys
 * are mapped.
 */
export type TaskKind =
  | "survey_build"   // questions, blocks, logic — the ordinary generation
  | "translation"    // one target language, inventory-driven
  | "conjoint"       // a CBC/ACBC design: structure validators, not a count
  | "maxdiff"        // a MaxDiff design: likewise
  | "scored_exam"    // a question set with an answer key and a scoring rule
  | "analysis"       // an analysis plan executed into results
  | "other";

export type TaskStatus =
  | "pending"          // rows exist, nothing claimed yet
  | "running"          // at least one slice has run
  | "completed"        // every step completed AND the deliverable spec passed
  | "needs_attention"  // nothing is wrong with the work; something outside it stops a slice running
  | "failed"           // a permanent failure stopped it; steps are preserved
  | "cancelled";

/**
 * WHY A TASK IS WAITING FOR A PERSON RATHER THAN A WORKER (2026-10-25).
 *
 * A background slice runs with nobody present, so it has to answer three
 * questions before it spends anything: may this task's author still edit
 * this project, is this the platform's key rather than someone's own, and
 * can the wallet cover another slice. A no to any of them is NOT a failure
 * of the work — every step already built is intact and the task will finish
 * the moment the obstacle is removed — so it pauses here instead.
 *
 * `failed` would be a lie: it says the generation could not be done. These
 * say it could, and something outside it is in the way.
 */
export type TaskBlocked =
  | "no_author"   // the task has no recorded author to act for
  | "no_right"    // the author no longer holds the edit right on this project
  | "locked"      // the project is frozen
  | "byok"        // the turn ran on the researcher's own provider key
  | "wallet"      // the wallet cannot cover another slice
  | "ceiling"     // the task has spent the allowance its plan justifies
  /*
   * WHAT A STEP HANDLER CAN SAY (2026-10-29, the ported K contract). A
   * handler's `blocked` result names what it needs — a key an administrator
   * must fix, a setting, credit with the provider, or an answer from the
   * researcher — and the runner PAUSES the task with it. Same rule as the
   * six above: nothing is wrong with the work, something outside it is in
   * the way. `budget` from a handler maps to `wallet`.
   */
  | "auth"        // the AI provider refused the configured key
  | "config"      // a model name, a setting, provider credit
  | "user_input"; // the handler needs an answer from the researcher before it can go on

/**
 * A step's life. `blocked` is a step whose inputs a re-plan invalidated;
 * `tombstoned` is one a re-plan deleted — kept, never run, so the reply can
 * say what was dropped instead of losing it silently.
 */
export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "blocked"
  | "tombstoned";

/**
 * Why a step failed, in the terms the runner acts on. Mapped from
 * `ProviderErrorKind` (packages/ai/src/provider.ts) plus the two the provider
 * layer cannot see: an output that did not validate, and a step that is
 * simply too big for one call.
 */
export type StepFailureKind =
  | "transient"      // network, server, overloaded, timeout, busy — retry with backoff
  | "rate_limited"   // 429 — retry, honouring Retry-After
  | "context_limit"  // the prompt or the output did not fit — SPLIT, do not retry whole
  | "invalid_output" // the model answered, the answer did not validate — bounded retry
  | "auth"           // a key problem — stop, tell an administrator
  | "config"         // a model name, a region, a missing setting — stop
  | "permanent";     // this step cannot succeed as written — stop, preserve the task

/** every kind the provider layer can raise, mapped once so the runner never re-decides */
const PROVIDER_FAILURE: Readonly<Record<string, StepFailureKind>> = {
  rate_limited: "rate_limited",
  quota_exhausted: "config",
  overloaded: "transient",
  server: "transient",
  network: "transient",
  timeout: "transient",
  busy: "transient",
  auth: "auth",
  forbidden: "auth",
  not_found: "config",
  bad_request: "context_limit",
};

/**
 * Classify a failure for a step row. `kind` is a `ProviderErrorKind` when the
 * provider raised it; `hint` lets the caller say what the provider could not
 * ("the reply did not validate", "the output was truncated").
 */
export function classifyStepFailure(kind: string | undefined, hint?: "invalid_output" | "context_limit" | "permanent"): StepFailureKind {
  if (hint) return hint;
  if (!kind) return "transient";
  return PROVIDER_FAILURE[kind] ?? "permanent";
}

/** a classified failure stops the task rather than waiting for another slice */
export function isTerminalFailure(k: StepFailureKind): boolean {
  return k === "auth" || k === "config" || k === "permanent";
}

/* ------------------------------------------------------------ the steps */

/** what a step cost, attributed to the step and not only to the request */
export interface StepUsage {
  tokensIn?: number;
  tokensOut?: number;
  /** of `tokensIn`, how many were served from the provider's prompt cache */
  tokensCached?: number;
  /** what the customer is charged for this step, in the platform's own units */
  charge?: number;
  /** which model actually answered (a fallback provider may differ from the first choice) */
  model?: string;
}

/** the deterministic check a step's own output must pass before it counts as done */
export interface StepValidation {
  status: "unchecked" | "valid" | "invalid";
  /** stable, human-readable reasons — never a provider's words */
  errors?: string[];
}

export interface ExecStep {
  taskId: string;
  /** the plan item's id where there is one, so a step and its item are the same thing */
  stepId: string;
  /** the plan version this step belongs to */
  planVersion: number;
  /** step ids that must be `completed` before this one may run */
  dependsOn: string[];
  status: StepStatus;
  /** for the panel and the prompt: the plan item's title */
  title?: string;
  /**
   * HOW BIG THIS STEP IS, in the task kind's own unit (questions, translation
   * keys, profiles). The runner HALVES it on a `context_limit` failure and
   * splits the step rather than retrying it whole, and records what was
   * actually used — so a resumed task can show why a step was cut up.
   */
  batchSize?: number;
  batchSizeUsed?: number;
  /** where the input came from: a plan item id, a brief passage, a translation key range */
  inputRef?: string;
  /*
   * THE HANDLER CONTRACT (2026-10-29, ported from K1/K2 onto this engine). A
   * step planned by a registered `TaskPlanner` carries the `kind` of the
   * `StepHandler` that builds it and the handler's own `input` (a batch's
   * slots, a range of codes, a repair's errors). A step without a `kind` is
   * a plan item of the existing survey_build path and is built by the item
   * path (`backgroundBuild`). Additive: every row written before this field
   * existed reads as `kind` undefined.
   */
  kind?: string;
  input?: Record<string, unknown>;
  /** steps in one group may run side by side (they depend on nothing in the group) */
  parallelGroup?: string;
  /** which model tier the handler asks for; the runner's `tierFor` decides when absent */
  modelTier?: "small" | "standard" | "strong";
  /** the model's reply for this step; large outputs may be a storage reference instead */
  output?: unknown;
  validation?: StepValidation;
  failureKind?: StepFailureKind;
  /** one sentence, safe to show: never a provider's raw response */
  failureMessage?: string;
  retryCount: number;
  /**
   * THE GUARD AGAINST DOUBLE DELIVERY AND DOUBLE BILLING. Stable across
   * retries and across slices: two runners that both claim this step still
   * commit one row and bill one call.
   */
  idempotencyKey: string;
  usage?: StepUsage;
  startedAt?: number;
  finishedAt?: number;
}

/* ------------------------------------------------- the deliverable spec */

/**
 * WHAT "DONE" MEANS, decided by deterministic code and never by a model. The
 * spec is stored on the task when it is created, so a resumed task is held to
 * the same bar as the original request, and so a task that generated 64 of
 * 100 questions is `running`, not `completed`.
 *
 * Every field is optional: a spec asserts only what the request actually
 * promised. An empty spec still requires that every step completed.
 */
export interface DeliverableSpec {
  kind: TaskKind;
  /** respondent-facing questions the finished survey must have */
  questionCount?: number;
  /** the target language of a translation task */
  language?: string;
  /** a scored exam: the key must cover this many items, and must not reach the respondent */
  keyCoverage?: number;
  /** a scored exam: marks for right, wrong and skipped */
  scoring?: { correct: number; incorrect: number; skipped: number };
  /** conjoint / MaxDiff: checked by the design-structure validators, not by counting */
  designChecks?: string[];
  /** extra invariants by name, resolved by the checker (ids unique, logic resolves, …) */
  invariants?: string[];
}

/** what a deliverable check answers — the single gate on `completed` */
export interface DeliverableReport {
  ok: boolean;
  /** one line per unmet requirement, in the researcher's terms */
  problems: string[];
  /** what was measured, for the panel: { questions: 64, required: 100 } */
  measured?: Record<string, number | string | boolean>;
}

/* ------------------------------------------------------------- the task */

export interface ExecTask {
  id: string;
  surveyId: string;
  /** the workspace the task belongs to, for RLS and for billing attribution */
  customerId?: string;
  createdBy?: string;
  kind: TaskKind;
  /** what the researcher asked, verbatim */
  request: string;
  status: TaskStatus;
  /** bumped by a re-plan; steps carry the version they were planned under */
  planVersion: number;
  deliverable: DeliverableSpec;
  steps: ExecStep[];
  /** the last deliverable check, so the panel can show WHY a task is not done */
  report?: DeliverableReport;
  /*
   * WHAT A PLANNED TASK KEEPS BESIDE ITS STEPS (2026-10-29). `summary` is
   * the concise persisted requirements and decisions a step is told instead
   * of the whole brief (K's `TaskSummary`); `completion` the planner's
   * criteria strings the deliverable check reads (`parseCompletionCriteria`);
   * `planner` which registered planner made the plan; `base` the survey the
   * plan was made against, so `ctx.draft` is a deterministic replay of the
   * completed steps' actions over it — on this server, on another, or in the
   * cron with the page closed. All optional: a plan-item task has none.
   */
  summary?: TaskSummary;
  completion?: string[];
  planner?: string;
  base?: unknown;
  /** set with `needs_attention`: what is in the way, and one sentence for the researcher */
  blocked?: { reason: TaskBlocked; message: string; at?: number };
  createdAt?: number;
  updatedAt?: number;
}

/** concise persisted requirements/decisions — never the whole brief (K's TaskSummary, kept verbatim for the handlers) */
export interface TaskSummary {
  goal: string;
  deliverables: string[];
  constraints: string[];
  decisions: string[];
  language?: string;
  sourceTurnIds: string[];
}

/* --------------------------------------------------------- pure helpers */

export const STEP_DONE: ReadonlySet<StepStatus> = new Set<StepStatus>(["completed", "tombstoned"]);

/** a step that still has work in it (a tombstone and a completed step do not) */
export function isOutstanding(s: ExecStep): boolean {
  return !STEP_DONE.has(s.status);
}

/** the earliest step that is not finished — where a resumed task picks up */
export function earliestIncompleteStep(task: Pick<ExecTask, "steps">): ExecStep | null {
  for (const s of task.steps) if (isOutstanding(s)) return s;
  return null;
}

/** every dependency of `step` is completed, so it may be claimed */
export function dependenciesMet(step: ExecStep, byId: ReadonlyMap<string, ExecStep>): boolean {
  return step.dependsOn.every((id) => byId.get(id)?.status === "completed" || byId.get(id)?.status === "tombstoned");
}

/** counts for the execution panel — real rows, never an animation */
/*
 * A TOMBSTONE IS NOT WORK (audit M5, 2026-10-25).
 *
 * `total` was `steps.length`, which counts rows a re-plan DELETED. A task
 * with two completed steps and one tombstone read as 2 of 3: the panel's
 * headline said every step was done, the bar sat at 66 %, the counter said
 * "1 to go", and the time estimate multiplied the per-step average by work
 * that will never run — all at once, on the §6 mechanism that creates
 * tombstones in the first place. `phase: "validating"` also requires
 * `completed === total` and so became unreachable after any re-plan.
 *
 * A tombstone is kept as a row so the reply can say what was dropped. It is
 * not counted here, and `tombstoned` is reported separately for anything
 * that wants to mention it.
 */
export function taskProgress(task: Pick<ExecTask, "steps">): { total: number; completed: number; failed: number; pending: number; running: number; blocked: number; tombstoned: number } {
  let completed = 0, failed = 0, pending = 0, running = 0, blocked = 0, tombstoned = 0;
  for (const s of task.steps) {
    if (s.status === "completed") completed++;
    else if (s.status === "tombstoned") tombstoned++;
    else if (s.status === "failed") failed++;
    else if (s.status === "running") running++;
    else if (s.status === "blocked") blocked++;
    else if (s.status === "pending" || s.status === "retrying") pending++;
  }
  return { total: task.steps.length - tombstoned, completed, failed, pending, running, blocked, tombstoned };
}

/** what a resumed task has spent so far, summed from the step rows */
export function taskSpend(task: Pick<ExecTask, "steps">): Required<Pick<StepUsage, "tokensIn" | "tokensOut" | "tokensCached" | "charge">> {
  const t = { tokensIn: 0, tokensOut: 0, tokensCached: 0, charge: 0 };
  for (const s of task.steps) {
    t.tokensIn += s.usage?.tokensIn ?? 0;
    t.tokensOut += s.usage?.tokensOut ?? 0;
    t.tokensCached += s.usage?.tokensCached ?? 0;
    t.charge += s.usage?.charge ?? 0;
  }
  return t;
}
