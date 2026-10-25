/**
 * THE RESUMABLE RUNNER. — Owner: R3.
 *
 * This REPLACES THE BROWSER AS THE DRIVER of the existing plan → items loop.
 * It does not replace the loop. How an item is built, gated, repaired and
 * applied is unchanged; what changes is who calls it and where its output
 * lands. The runner owns WHEN a step runs, never HOW: the build itself
 * arrives as the injected `buildStep`, and the rows arrive as an injected
 * `TaskStore`. That is the whole reason this file is not a second
 * orchestrator.
 *
 * Do not raise ROUTE_BUDGET_MS (165 s) and do not create a second
 * orchestrator. The 90 s stage cap stays.
 *
 * THE FIRST-STEP HOLE, AND WHY IT IS NOT HERE. The turn route caps a stage at
 * 90 s with `if (newlyBuilt.length && (… || Date.now() >= softStop)) break;`
 * — guarded by `newlyBuilt.length`, so the cap only engages AFTER one item
 * has been built in the request. A request whose FIRST item is slow is not
 * capped: it runs to the item deadline (150 s) and the request sits open and
 * silent to ~160 s. Here the stop checks are unguarded, and — the part that
 * actually fixes it — every step is given a deadline of its own that cannot
 * outlast the soft stop by more than one minimum step, with a watchdog that
 * abandons the call when it does. A slow first step therefore returns a
 * checkpoint with nothing built and everything remaining, instead of eating
 * the route's whole budget.
 */
import {
  classifyStepFailure, dependenciesMet, isOutstanding, isTerminalFailure, taskProgress, taskSpend,
  type ExecStep, type ExecTask, type StepFailureKind, type StepUsage, type TaskStatus, type DeliverableReport,
} from "@rescript/engine";
import type { TaskStore } from "./taskStore.ts";
import { waitBeforeRetry } from "./resume.ts";

/* --------------------------------------------------------- the clock */

/** the stage cap the turn route uses, and the longest any single step may hold the slice */
export const STAGE_SOFT_MS = 90_000;
/** the least time a step is worth starting with — the route's MIN_ITEM_MS */
export const MIN_STEP_MS = 30_000;
/** how many times one step is built again before it is left for a later slice — NEVER unbounded */
export const MAX_STEP_RETRIES = 3;
/** how many times a `context_limit` failure may halve a step's batch before the step is called too big to run */
export const MAX_SPLITS = 4;
/** a step claimed by a worker that never came back is claimable again after this */
export const RECLAIM_SECONDS = 180;

/* ----------------------------------------------------- the two seams */

/**
 * HOW a step is built. The turn route passes its existing item path through
 * here unchanged — the guides, the prompt-cache block order, the gate and the
 * repair all stay where they are. The runner only decides when to call this,
 * with what deadline, and what to do with what comes back.
 */
export type BuildStepResult =
  | { output: unknown; usage?: StepUsage; batchSizeUsed?: number; validation?: ExecStep["validation"] }
  | { error: unknown };

export interface BuildContext {
  /** aborted when the step outlives its own deadline, so an obedient build stops paying for itself */
  signal?: AbortSignal;
  /** absolute ms: this step must be finished by here, and it is never the route's whole budget */
  deadline: number;
  /** 0 on the first try; the jittered backoff between tries has already been waited out */
  attempt: number;
  /** how big this call may be, halved by the runner after a `context_limit` failure */
  batchSize?: number;
  /** #7: the PERSISTED TASK SUMMARY — what the model is told instead of the whole brief on every call */
  summary?: string;
  /** #7: a structuring step goes to AI_MODEL_SMALL; drafting keeps the large model */
  tier: "small" | "large";
}

export type BuildStep = (step: ExecStep, ctx: BuildContext) => Promise<BuildStepResult>;

/** a page is watching: checkpoints are streamed to it as well as committed */
export interface RunnerSink {
  progress(p: { stepId: string; index: number; of: number; label?: string }): void;
  checkpoint(stepId: string, raw: unknown): void;
  readonly cancelled?: boolean;
}

/* ----------------------------------------------------- what comes back */

export type SliceStop =
  | "drained"    // nothing left to claim
  | "soft_stop"  // the 90 s stage cap
  | "budget"     // not enough of this slice left for another step
  | "cancelled"  // the page went away, or the caller aborted
  | "terminal"   // a failure no later slice can fix
  | "backoff"    // the next try does not fit in this slice
  | "max_steps"  // the caller asked for a bounded number of steps
  | "done";      // the task was already finished

export interface SliceResult {
  taskId: string;
  /** step ids committed in this slice */
  built: string[];
  /** step ids still outstanding when the budget ran out */
  remaining: string[];
  failed: { id: string; kind: ExecStep["failureKind"]; message: string }[];
  /** the slice stopped because the budget was spent, not because the work is done */
  budgetSpent: boolean;
  /** why it stopped, for the log and for the panel */
  stoppedBy: SliceStop;
  status: TaskStatus;
  progress: ReturnType<typeof taskProgress>;
  /** what the WHOLE task has spent, summed from the step rows — a resumed task reports honestly */
  spend: ReturnType<typeof taskSpend>;
  /** a rate limit asked us to come back: the cron and the page both honour it */
  retryAfterMs?: number;
  /** the deliverable check, when one was supplied */
  report?: DeliverableReport;
}

export interface RunSliceOptions {
  budgetMs: number;
  /** R1's store, INJECTED — the runner never calls `taskStoreFor` itself, so it is testable without a database */
  store: TaskStore;
  /** the item path, INJECTED — the runner never builds anything itself */
  buildStep: BuildStep;
  sink?: RunnerSink;
  /** the caller's own abort (the request was cancelled) */
  signal?: AbortSignal;
  /** the deliverable gate (R4's checker); without one, every step done means done */
  check?: (task: ExecTask) => DeliverableReport | Promise<DeliverableReport>;
  /** at most this many steps in one slice */
  maxSteps?: number;
  /** test seams */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  softStopMs?: number;
  minStepMs?: number;
  maxRetries?: number;
  staleSeconds?: number;
}

/* --------------------------------------------------------- pure parts */

/**
 * The steps that may be claimed now: outstanding, dependencies met, in plan
 * order. Pure over the task graph, so it is tested without a database.
 *
 * `running` is left out on purpose — another worker holds its lease, and
 * taking it back is the store's reclaim window, not a decision made here.
 */
export function nextRunnableSteps(task: Pick<ExecTask, "steps">, limit?: number): ExecStep[] {
  const byId = new Map(task.steps.map((s) => [s.stepId, s]));
  const out: ExecStep[] = [];
  for (const s of task.steps) {
    if (!isOutstanding(s)) continue;
    if (s.status !== "pending" && s.status !== "retrying") continue;
    if (!dependenciesMet(s, byId)) continue;
    out.push(s);
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

/** every step still carrying work, in plan order — what a checkpoint calls "remaining" */
export function outstandingStepIds(task: Pick<ExecTask, "steps">): string[] {
  return task.steps.filter(isOutstanding).map((s) => s.stepId);
}

/** a structuring step is short and shaped; drafting is not. #7: the small model stays on the structuring ones. */
export function tierFor(step: Pick<ExecStep, "title" | "inputRef">): "small" | "large" {
  const t = `${step.title ?? ""} ${step.inputRef ?? ""}`.toLowerCase();
  return /\b(structur|classif|extract|normalis|normaliz|label|tag|map|inventor|summar|translat|validate)\w*/.test(t) ? "small" : "large";
}

/**
 * #7: WHAT THE MODEL IS TOLD ABOUT THE TASK, instead of the whole brief on
 * every call. Built from the persisted rows, bounded, and free of anything a
 * provider said — the titles are the researcher's own plan.
 */
export function taskSummary(task: Pick<ExecTask, "request" | "kind" | "deliverable" | "steps">, opts: { maxChars?: number; recent?: number } = {}): string {
  const maxChars = opts.maxChars ?? 1200;
  const recent = opts.recent ?? 8;
  const p = taskProgress(task);
  const done = task.steps.filter((s) => s.status === "completed");
  const lines: string[] = [];
  const request = task.request.replace(/\s+/g, " ").trim();
  lines.push(`Task (${task.kind}): ${request.length > 480 ? `${request.slice(0, 477)}…` : request}`);
  const d = task.deliverable ?? { kind: task.kind };
  const wants: string[] = [];
  if (d.questionCount) wants.push(`${d.questionCount} respondent-facing questions`);
  if (d.language) wants.push(`target language ${d.language}`);
  if (d.keyCoverage) wants.push(`an answer key covering ${d.keyCoverage} items`);
  if (d.designChecks?.length) wants.push(`design checks: ${d.designChecks.join(", ")}`);
  if (wants.length) lines.push(`Must deliver: ${wants.join("; ")}.`);
  lines.push(`Progress: ${p.completed} of ${p.total} steps complete${p.failed ? `, ${p.failed} failed` : ""}.`);
  const titles = done.slice(-recent).map((s) => s.title || s.stepId).filter(Boolean);
  if (titles.length) lines.push(`Already built${done.length > titles.length ? ` (last ${titles.length} of ${done.length})` : ""}: ${titles.join("; ")}.`);
  const out = lines.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

/* ------------------------------------------------- reading a failure */

/** what the runner needs to know about a thrown or returned error, without importing the provider layer */
export interface FailureFacts {
  kind: StepFailureKind;
  retryAfterMs?: number;
  retryable: boolean;
}

const SAFE_MESSAGE: Readonly<Record<StepFailureKind, string>> = {
  transient: "The AI provider was briefly unavailable for this step. It is kept and tried again.",
  rate_limited: "The AI provider is rate-limiting requests. This step waits and resumes — nothing is lost.",
  context_limit: "This step was too large for one call, so it is being split into smaller batches.",
  invalid_output: "The model's answer for this step did not pass the deterministic check, so it was not kept.",
  auth: "The AI provider refused the configured key. An administrator needs to check the API credentials; the task and everything built are kept.",
  config: "The AI configuration cannot run this step (model, region or quota). An administrator needs to check it; the task and everything built are kept.",
  permanent: "This step cannot be completed as written. Everything else in the task is kept — edit the plan item and run it again.",
};

/** one sentence, safe to show: never a provider's words */
export function stepFailureMessage(kind: StepFailureKind): string {
  return SAFE_MESSAGE[kind];
}

/**
 * Classify what `buildStep` handed back. Duck-typed on purpose: a
 * `ProviderError` (`kind`, `retryAfterMs`, `contextTooLong`), an AI reply
 * error, or a plain `Error` all read the same way, and the runner never
 * re-decides what `classifyStepFailure` already decided.
 */
export function readFailure(e: unknown): FailureFacts {
  const x = (e ?? {}) as { kind?: unknown; hint?: unknown; retryAfterMs?: unknown; contextTooLong?: unknown; code?: unknown; name?: unknown };
  const hint = x.contextTooLong === true ? "context_limit" as const
    : x.hint === "invalid_output" || x.hint === "context_limit" || x.hint === "permanent" ? x.hint
    : undefined;
  const providerKind = typeof x.kind === "string" ? x.kind : typeof x.code === "string" ? x.code : undefined;
  const kind = classifyStepFailure(providerKind, hint);
  const retryAfterMs = typeof x.retryAfterMs === "number" && x.retryAfterMs > 0 ? Math.round(x.retryAfterMs) : undefined;
  return { kind, retryAfterMs, retryable: !isTerminalFailure(kind) };
}

/* --------------------------------------------------------- the slice */

const OVERRUN = Symbol("step overran its deadline");

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((res) => { const t = setTimeout(res, Math.max(0, ms)); (t as unknown as { unref?: () => void }).unref?.(); });

/** run `p`, but never past `ms`: the build is abandoned (and told to stop) rather than eating the route's budget */
async function withDeadline<T>(p: Promise<T>, ms: number, sleep: (n: number) => Promise<void>): Promise<T | typeof OVERRUN> {
  p.catch(() => { /* a late rejection after the race is not an unhandled one */ });
  const guard: Promise<typeof OVERRUN> = sleep(Math.max(1, ms)).then(() => OVERRUN);
  return Promise.race([p, guard]);
}

/**
 * Claim the next runnable steps, build each through the injected
 * `buildStep`, COMMIT EACH TO THE STORE AS IT RETURNS, stop when the budget
 * is spent, and return what remains.
 *
 * Committing per step is the whole point: a worker killed mid-slice leaves
 * every step that returned durable, and the next slice — from the browser,
 * from another tab or from the cron — picks up at the earliest incomplete
 * step. No step is ever built twice, because a committed step is no longer
 * claimable and its `idempotencyKey` is the store's guard against the race.
 */
export async function runSlice(taskId: string, opts: RunSliceOptions): Promise<SliceResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const rand = opts.rand ?? Math.random;
  const { store, buildStep, sink } = opts;
  const softStopMs = opts.softStopMs ?? STAGE_SOFT_MS;
  const minStepMs = opts.minStepMs ?? MIN_STEP_MS;
  const maxRetries = opts.maxRetries ?? MAX_STEP_RETRIES;
  const staleSeconds = opts.staleSeconds ?? RECLAIM_SECONDS;

  const startedAt = now();
  const sliceDeadline = startedAt + opts.budgetMs;
  /* the 90 s stage cap — and unlike the turn route's, NOTHING guards it on "something was already built" */
  const softStop = startedAt + Math.min(softStopMs, opts.budgetMs);

  const built: string[] = [];
  const failed: { id: string; kind: ExecStep["failureKind"]; message: string }[] = [];
  let stoppedBy: SliceStop = "drained";
  let retryAfterMs: number | undefined;
  let slowest = 0;

  const task0 = await store.load(taskId);
  if (!task0) throw new Error(`runner: no task ${taskId}`);
  const finish = async (why: SliceStop): Promise<SliceResult> => {
    const task = (await store.load(taskId)) ?? task0;
    const outstanding = outstandingStepIds(task);
    let status: TaskStatus = task.status;
    let report: DeliverableReport | undefined = task.report;
    if (!outstanding.length && why !== "terminal" && status !== "failed" && status !== "cancelled") {
      /*
       * A MISSING CHECK IS NOT A PASS (audit H9, 2026-10-25).
       *
       * This read `opts.check ? await opts.check(task) : { ok: true }`, so a
       * caller that passed no deliverable gate — which is every production
       * caller today — completed the task unconditionally the moment its
       * steps had all run. That is a second completion gate, answering yes
       * without looking, directly against §9: completion is decided by one
       * deterministic check of the deliverable, or it is not decided.
       *
       * With no check the steps are done and the task stays `running`. It is
       * the honest answer: this runner has nothing left to build and no
       * standing to say the thing the researcher asked for exists.
       */
      if (opts.check) {
        report = await opts.check(task);
        status = report.ok ? "completed" : "running";
        await store.setStatus(taskId, status, report);
      } else {
        status = "running";
        await store.setStatus(taskId, status, task.report);
      }
    }
    return {
      taskId, built, remaining: outstanding, failed,
      budgetSpent: why === "budget" || why === "soft_stop" || why === "backoff",
      stoppedBy: why, status, progress: taskProgress(task), spend: taskSpend(task),
      ...(retryAfterMs ? { retryAfterMs } : {}), ...(report ? { report } : {}),
    };
  };

  if (task0.status === "completed" || task0.status === "failed" || task0.status === "cancelled") return finish("done");
  if (task0.status === "pending") await store.setStatus(taskId, "running");

  const total = task0.steps.length;
  let index = task0.steps.filter((s) => !isOutstanding(s)).length;

  for (;;) {
    if (sink?.cancelled || opts.signal?.aborted) { stoppedBy = "cancelled"; break; }
    /* the stage cap, checked before EVERY step including the first */
    if (now() >= softStop) { stoppedBy = "soft_stop"; break; }
    if (opts.maxSteps != null && built.length + failed.length >= opts.maxSteps) { stoppedBy = "max_steps"; break; }
    /*
     * Enough of this slice left for another step? After something has been
     * built we want room for a typical one; on the FIRST step of a slice we
     * take whatever the budget is, because refusing to start would mean a
     * short slice never makes progress at all. Either way the step below is
     * bounded, so "start it" never means "run to the route budget".
     */
    const need = built.length || failed.length ? Math.max(minStepMs, slowest * 1.5) : Math.min(minStepMs, opts.budgetMs);
    if (sliceDeadline - now() < need) { stoppedBy = "budget"; break; }

    const claimed = await store.claim(taskId, { staleSeconds, maxAttempts: maxRetries + 1 });
    if (!claimed) { stoppedBy = "drained"; break; }
    const step = claimed.step;
    /* a step the store handed back already finished is never rebuilt */
    if (step.status === "completed" || step.status === "tombstoned") continue;

    index++;
    sink?.progress({ stepId: step.stepId, index, of: total, label: step.title });

    let attempt = step.retryCount ?? 0;
    let batch = step.batchSize;
    let splits = 0;
    let stop: SliceStop | null = null;

    for (;;) {
      const t0 = now();
      /*
       * THE BOUND THAT CLOSES THE FIRST-STEP HOLE. A step never runs past the
       * soft stop by more than one minimum step, and never past the slice's
       * own deadline. A build that ignores it is abandoned by the watchdog
       * and the slice returns a checkpoint.
       */
      const stepDeadline = Math.min(sliceDeadline, Math.max(t0 + minStepMs, softStop));
      const ctrl = new AbortController();
      const r = await withDeadline(
        buildStep(step, { signal: ctrl.signal, deadline: stepDeadline, attempt, batchSize: batch, summary: taskSummary(task0), tier: tierFor(step) }),
        stepDeadline - t0, sleep,
      );
      slowest = Math.max(slowest, now() - t0);

      if (r === OVERRUN) {
        ctrl.abort();
        /* out of time, not broken: the row goes back to `retrying`, keeps its count, and a later slice runs it */
        await store.fail(taskId, step.stepId, { kind: "transient", message: stepFailureMessage("transient"), retryable: true });
        stop = now() >= softStop ? "soft_stop" : "budget";
        break;
      }

      if ("error" in r) {
        const f = readFailure(r.error);
        if (f.retryAfterMs) retryAfterMs = Math.max(retryAfterMs ?? 0, f.retryAfterMs);

        if (isTerminalFailure(f.kind)) {
          /* nothing a later slice can do: the STEP stops, the TASK and every output are preserved */
          await store.fail(taskId, step.stepId, { kind: f.kind, message: stepFailureMessage(f.kind), retryable: false });
          failed.push({ id: step.stepId, kind: f.kind, message: stepFailureMessage(f.kind) });
          await store.setStatus(taskId, "failed", { ok: false, problems: [stepFailureMessage(f.kind)] });
          stop = "terminal";
          break;
        }

        if (f.kind === "context_limit") {
          /* HALVE AND SPLIT, never retry the same call whole */
          const current = batch ?? step.batchSize;
          const next = current && current > 1 ? Math.max(1, Math.floor(current / 2)) : null;
          if (next && splits < MAX_SPLITS) { batch = next; splits++; continue; }
          await store.fail(taskId, step.stepId, { kind: "permanent", message: stepFailureMessage("permanent"), retryable: false });
          failed.push({ id: step.stepId, kind: "permanent", message: stepFailureMessage("permanent") });
          break;
        }

        /* BOUNDED retries: the count is on the row, so it survives the worker and a slice cannot reset it */
        attempt++;
        await store.fail(taskId, step.stepId, { kind: f.kind, message: stepFailureMessage(f.kind), retryable: true });
        if (attempt > maxRetries) {
          failed.push({ id: step.stepId, kind: f.kind, message: stepFailureMessage(f.kind) });
          break;
        }
        const wait = waitBeforeRetry({ retryAfterMs: f.retryAfterMs }, attempt - 1, rand);
        /* the next try has to fit in what is left of the slice, or it belongs to the next one */
        if (now() + wait + Math.min(minStepMs, opts.budgetMs) > Math.min(sliceDeadline, softStop)) { stop = "backoff"; break; }
        await sleep(wait);
        if (sink?.cancelled || opts.signal?.aborted) { stop = "cancelled"; break; }
        /*
         * RE-CLAIM BEFORE BUILDING AGAIN (audit H8, 2026-10-25).
         *
         * `fail(retryable)` moves the step to `retrying` and CLEARS its
         * lease — correct, because a worker that dies during the backoff
         * must not hold the step for a reclaim window. But this loop then
         * went straight back into `buildStep` without taking the lease
         * again, so for the whole backoff and the whole next attempt the
         * step was unleased and immediately claimable. The cron sweep is a
         * second runner by design, so two workers could build and bill the
         * same step: the unique index still kept one row, but both provider
         * calls had already been paid for.
         *
         * Losing the race is not a failure. Another worker has the step and
         * will commit it; this slice simply moves on.
         */
        const again = await store.claim(taskId, { staleSeconds, maxAttempts: maxRetries + 1 }).catch(() => null);
        if (!again || again.step.stepId !== step.stepId) {
          stop = again ? "drained" : stop;
          break;
        }
        continue;
      }

      /* committed the moment it returns: a worker killed here still leaves this step durable */
      await store.commit(taskId, step.stepId, {
        output: r.output, usage: r.usage, validation: r.validation,
        batchSizeUsed: r.batchSizeUsed ?? batch, idempotencyKey: step.idempotencyKey,
      });
      built.push(step.stepId);
      sink?.checkpoint(step.stepId, r.output);
      break;
    }

    if (stop) { stoppedBy = stop; break; }
  }

  return finish(stoppedBy);
}

/* -------------------------------------------- the cron's build seam */

type StepBuilderFactory = (task: ExecTask) => Promise<BuildStep | null>;
let STEP_BUILDER: StepBuilderFactory | null = null;

/**
 * THE CONTINUATION PATH THAT IS NOT THE BROWSER needs the same item path the
 * turn route uses, and the runner must not contain it. The module that owns
 * the item build registers it here; the cron asks for it and skips honestly
 * when nothing is registered. (The alternative — the cron importing the route
 * — is what turns a runner into a second orchestrator.)
 */
export function setStepBuilder(f: StepBuilderFactory | null): void { STEP_BUILDER = f; }
export function stepBuilderFor(task: ExecTask): Promise<BuildStep | null> {
  return STEP_BUILDER ? STEP_BUILDER(task) : Promise.resolve(null);
}
