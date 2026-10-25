/**
 * THE ONLY MODULE THAT READS OR WRITES THE TASK TABLES (migration 0074).
 *
 * Owner: R1. Nothing else may reach `intelligent_tasks` or
 * `intelligent_steps`; the runner, the plan stage and the execution panel all
 * come through here. That is what keeps the claim in one place and the row
 * shape in one place.
 *
 * ## DUAL-WRITE ONLY — this cannot break the existing path
 *
 * Today nothing READS these rows to decide what to do next. The browser
 * checkpoint (`done[]`, apps/studio/lib/copilot/resume.ts) is still the
 * authority for what has been built; this store is a shadow written beside
 * it. Every method is additive, every failure mode degrades to the memory
 * store rather than throwing into a turn, and no code here is on the path
 * that produces a reply. When R3's flag is turned on the reads start; until
 * then a broken row here costs nothing but the row.
 *
 * ## Durable / memory
 *
 * A feature ships with its migration and the operator applies it when they
 * choose. Between those two moments the code runs against a database without
 * the table, so — exactly as the research documents (0045) and the operation
 * history (0047) stores do — there is a DURABLE variant backed by Supabase
 * and a MEMORY variant for this server process, and the store says which one
 * answered (`durable`) so the panel can tell the researcher the truth.
 *
 * `memoryTaskStore()` is exported because it is the contract's reference
 * implementation: the runner's tests, the reconciliation's tests and the
 * panel's tests all run against it, so it implements the claim's exclusivity
 * and the idempotency guard honestly rather than approximately.
 *
 * ## What may leave the server
 *
 * `redactForClient()` is the only shape a client route may send. It drops the
 * request text, every step's raw model output and its input reference, and
 * scrubs anything credential-shaped out of the strings that remain. There is
 * a test that holds it to that.
 */
import {
  classifyStepFailure, dependenciesMet, earliestIncompleteStep, isTerminalFailure, taskProgress, taskSpend,
  type DeliverableSpec, type ExecStep, type ExecTask, type StepFailureKind, type StepStatus, type StepUsage,
  type TaskKind, type TaskStatus,
} from "@rescript/engine";
import { dbConfigured, memoryOf, storeWithFallback } from "./durable.ts";

/* ------------------------------------------------------------ the shape */

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

/**
 * How a step failed, as the runner knows it. `kind` is a `StepFailureKind`
 * when the caller has already classified it, or a raw `ProviderErrorKind`
 * when it has not — either way it goes through `classifyStepFailure`, so the
 * stored value is always one of the seven.
 */
export interface StepFailureInput {
  kind: StepFailureKind | string;
  message: string;
  retryable: boolean;
  /** what the provider layer cannot see: an answer that did not validate, an output that did not fit */
  hint?: "invalid_output" | "context_limit" | "permanent";
  /** the caller's own retry budget, so the store does not overrule it with MAX_ATTEMPTS (audit M4) */
  maxAttempts?: number;
}

export interface CommitInput {
  output: unknown;
  usage?: StepUsage;
  validation?: ExecStep["validation"];
  batchSizeUsed?: number;
  idempotencyKey: string;
}

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
  commit(taskId: string, stepId: string, out: CommitInput): Promise<ExecStep>;
  /** the step failed, classified; the runner decides whether to retry */
  fail(taskId: string, stepId: string, failure: StepFailureInput): Promise<ExecStep>;
  /** replace the step set for a new plan version, preserving completed steps (R2's reconciliation writes through this) */
  revise(taskId: string, planVersion: number, steps: Omit<ExecStep, "taskId" | "retryCount">[], tombstoned: string[]): Promise<ExecTask>;
  setStatus(taskId: string, status: TaskStatus, report?: ExecTask["report"]): Promise<void>;
  /** the earliest step that is not finished — where a resumed task picks up */
  earliestIncomplete(taskId: string): Promise<ExecStep | null>;
  /** tasks left running or pending past their reclaim window, for the cron continuation */
  stale(olderThanMs: number, limit?: number): Promise<{ id: string; surveyId: string }[]>;
  /** spend the turn made outside any step — the repair and coverage passes (audit M7) */
  addExtraCharge(taskId: string, amount: number): Promise<void>;
}

/** the default reclaim window, in seconds — longer than the 165s route budget, so a live slice is never stolen from */
export const STALE_SECONDS = 180;
/** how many times one step may be claimed before the claim stops offering it */
export const MAX_ATTEMPTS = 3;
/*
 * `fail()` decides `retrying` vs `failed` by comparing the row's count with a
 * bound. It used to use MAX_ATTEMPTS unconditionally, so a caller running
 * with its own `maxRetries` had the store overrule it: a step that was merely
 * slower than the stage cap burned one attempt per slice and was dead after
 * three, with nothing wrong with it, and `runSlice({maxRetries: 5})` had the
 * store mark a step `failed` at 3 while the runner carried on building it
 * (audit M4, 2026-10-25). The bound is now the caller's where it gives one.
 */

/* ------------------------------------------------- classification helper */

const STEP_FAILURE_KINDS: ReadonlySet<string> = new Set<StepFailureKind>([
  "transient", "rate_limited", "context_limit", "invalid_output", "auth", "config", "permanent",
]);

/**
 * One classification, wherever the failure came from. A caller that already
 * holds a `StepFailureKind` keeps it (re-running the provider map over
 * "config" would turn it into "permanent", because "config" is a conclusion
 * and not a provider error); anything else is a `ProviderErrorKind` and goes
 * through `classifyStepFailure`.
 */
export function classifyFailure(kind: string | undefined, hint?: StepFailureInput["hint"]): StepFailureKind {
  if (hint) return classifyStepFailure(undefined, hint);
  if (kind && STEP_FAILURE_KINDS.has(kind)) return kind as StepFailureKind;
  return classifyStepFailure(kind);
}

/* --------------------------------------------- the reconciliation, pure */

/**
 * WHAT A RE-PLAN DOES TO THE STEPS THAT EXIST (R2 writes through this).
 *
 *   · a step that already COMPLETED is kept exactly as it ran, at the plan
 *     version it ran under — the work is done and paid for, and a re-plan is
 *     not a reason to buy it again;
 *   · an id the re-plan deleted is TOMBSTONED, never run, so the reply can
 *     say what was dropped instead of losing it silently;
 *   · anything still outstanding that depends — directly or through another
 *     step — on a tombstone is BLOCKED, because its input will never arrive.
 *
 * Returns the whole new step list, in the new plan's order with the kept
 * completed steps that the new plan no longer mentions appended.
 */
export function planRevision(
  existing: ExecStep[],
  taskId: string,
  planVersion: number,
  steps: Omit<ExecStep, "taskId" | "retryCount">[],
  tombstoned: string[],
): ExecStep[] {
  const byId = new Map(existing.map((s) => [s.stepId, s]));
  const incoming = new Set(steps.map((s) => s.stepId));
  const dead = new Set(tombstoned);
  /* a row the new plan does not mention and that did not complete was deleted by the re-plan */
  for (const s of existing) if (!incoming.has(s.stepId) && s.status !== "completed") dead.add(s.stepId);

  const out: ExecStep[] = [];
  for (const s of steps) {
    const prev = byId.get(s.stepId);
    /*
     * A COMPLETED ROW IS NOT IMMUTABLE WHEN THE RE-PLAN INVALIDATED IT.
     * Reconciliation (planPersistence.ts) decides what a new instruction
     * invalidates; this records that decision. There are three ways it says
     * so, and an earlier version of this function understood only two:
     *
     *   `tombstoned` / in `tombstoned[]`  the instruction deleted the item;
     *   `blocked`                         the item is unchanged but something
     *                                     it depends on moved;
     *   A DIFFERENT IDEMPOTENCY KEY       THE ITEM ITSELF CHANGED (audit C3).
     *
     * The third is the primary case of §6 rule 2 and it was being missed.
     * Reconciliation marks a changed item by handing back `pending` — which
     * is also what an ordinary continuation hands for a step that simply has
     * not run — so `pending` cannot be the signal. The key can: it is
     * `idemOf(surveyId, item.id, itemFingerprint(item))`, so it changes when
     * and only when the item's content changes, and a reused step is handed
     * back carrying `prev.idempotencyKey` unchanged. Without this a changed
     * item kept its old `completed` row and was never rebuilt, the reply told
     * the researcher it was being rebuilt, and its dependents — correctly
     * `blocked` — became runnable again against the STALE output, because
     * `dependenciesMet` saw the parent as completed.
     *
     * An incoming `pending`, `retrying` or `running` with the SAME key is
     * still ignored, so an ordinary continuation cannot rebuild and re-bill
     * work that is already done. And the key is only read on a row that
     * COMPLETED: on any other row a differing key says nothing worth acting
     * on, and treating it as new work would throw away a retry count that
     * has genuinely been spent.
     */
    const contentChanged = prev?.status === "completed" && !!prev.idempotencyKey && !!s.idempotencyKey && prev.idempotencyKey !== s.idempotencyKey;
    const invalidated = s.status === "blocked" || s.status === "tombstoned" || dead.has(s.stepId) || contentChanged;
    if (prev?.status === "completed" && !invalidated) { out.push({ ...prev }); continue; }
    if (prev?.status === "completed" && s.status === "blocked" && !dead.has(s.stepId)) {
      out.push({ ...prev, planVersion, status: "blocked" });
      continue;
    }
    if (dead.has(s.stepId)) {
      out.push({ ...(prev ?? {}), ...s, taskId, planVersion, status: "tombstoned", retryCount: prev?.retryCount ?? 0 });
      continue;
    }
    out.push({
      ...s,
      taskId,
      planVersion,
      /*
       * A changed item takes the status reconciliation gave it (`pending`)
       * and starts clean; an incoming `blocked` survives; otherwise the row
       * keeps the status it had (a tombstone is revived as pending).
       */
      status: contentChanged ? s.status : s.status === "blocked" ? "blocked" : prev && prev.status !== "tombstoned" ? prev.status : "pending",
      /* new content is new work: it does not inherit the old row's attempts, output or verdict */
      retryCount: contentChanged ? 0 : prev?.retryCount ?? 0,
      ...(contentChanged ? {} : { output: prev?.output, usage: prev?.usage, validation: prev?.validation }),
    });
  }
  /* kept history: completed and tombstoned rows the new plan no longer lists */
  for (const s of existing) {
    if (incoming.has(s.stepId)) continue;
    out.push({ ...s, status: s.status === "completed" ? "completed" : "tombstoned" });
  }

  /* blocked: a fixpoint over the tombstones, because a chain of dependants all lose their input */
  const stopped = new Set<string>(out.filter((s) => s.status === "tombstoned").map((s) => s.stepId));
  for (let pass = 0; pass < out.length + 1; pass++) {
    let grew = false;
    for (const s of out) {
      if (s.status === "completed" || s.status === "tombstoned" || s.status === "blocked") continue;
      if (s.dependsOn.some((d) => stopped.has(d))) { s.status = "blocked"; stopped.add(s.stepId); grew = true; }
    }
    if (!grew) break;
  }
  return out;
}

/* ------------------------------------------------- what a client may see */

export interface ClientStep {
  stepId: string;
  planVersion: number;
  dependsOn: string[];
  status: StepStatus;
  title?: string;
  batchSize?: number;
  batchSizeUsed?: number;
  validation?: { status: "unchecked" | "valid" | "invalid"; errors?: string[] };
  failureKind?: StepFailureKind;
  failureMessage?: string;
  retryCount: number;
  usage?: StepUsage;
  startedAt?: number;
  finishedAt?: number;
}

export interface ClientTask {
  id: string;
  surveyId: string;
  kind: TaskKind;
  status: TaskStatus;
  planVersion: number;
  deliverable: DeliverableSpec;
  report?: ExecTask["report"];
  progress: ReturnType<typeof taskProgress>;
  spend: ReturnType<typeof taskSpend>;
  steps: ClientStep[];
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Anything shaped like a provider credential, whatever string it turned up
 * in. Deliberately broad: a false positive costs a researcher one unreadable
 * word in a failure message, a false negative puts a key in a page.
 */
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|(?:api[_-]?key|secret|bearer|authorization|password)\s*[:=]\s*(?:bearer\s+)?\S+)/gi;

/** redact anything credential-shaped out of a string that is about to leave the server */
export function scrubSecrets(s: string): string { return s.replace(SECRET_RE, "[redacted]"); }

/**
 * THE ONLY SHAPE A CLIENT ROUTE MAY RETURN. The request text, every step's
 * raw model output and its input reference never appear: the first is prompt
 * material, the other two are an unreviewed provider answer and the passage
 * that produced it. What is left is counts, statuses and our own sentences,
 * each scrubbed.
 */
export function redactForClient(task: ExecTask): ClientTask {
  return {
    id: task.id,
    surveyId: task.surveyId,
    kind: task.kind,
    status: task.status,
    planVersion: task.planVersion,
    deliverable: task.deliverable,
    report: task.report
      ? { ok: task.report.ok, problems: (task.report.problems ?? []).map(scrubSecrets), measured: task.report.measured }
      : undefined,
    progress: taskProgress(task),
    spend: taskSpend(task),
    steps: task.steps.map((s) => ({
      stepId: s.stepId,
      planVersion: s.planVersion,
      dependsOn: [...s.dependsOn],
      status: s.status,
      title: s.title === undefined ? undefined : scrubSecrets(s.title),
      batchSize: s.batchSize,
      batchSizeUsed: s.batchSizeUsed,
      validation: s.validation ? { status: s.validation.status, errors: s.validation.errors?.map(scrubSecrets) } : undefined,
      failureKind: s.failureKind,
      failureMessage: s.failureMessage === undefined ? undefined : scrubSecrets(s.failureMessage),
      retryCount: s.retryCount,
      usage: s.usage ? { ...s.usage } : undefined,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/* ------------------------------------------------------- the memory store */

export interface MemTask extends ExecTask {
  /** idempotency key → the step id it was committed for; the memory half of the unique index */
  committed: Map<string, string>;
  /** the lease clock, per step id */
  claimedAt: Map<string, number>;
  /** the turn's own spend that belongs to no step (audit M7) */
  extraCharge?: number;
}

let memSeq = 0;
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(memSeq++).toString(36)}`;

/**
 * The contract's reference implementation. Every mutation happens in one
 * synchronous run of the method body — no `await` between the read and the
 * write — so two callers that race `claim()` on one step behave the way the
 * SQL does: one wins, the other is offered the next runnable step or nothing.
 */
export class MemoryTaskStore implements TaskStore {
  readonly durable = false;
  private tasks: Map<string, MemTask>;
  constructor(tasks: Map<string, MemTask> = memoryOf<MemTask>("intelligentTasks")) { this.tasks = tasks; }

  private read(taskId: string): MemTask | null { return this.tasks.get(taskId) ?? null; }

  async create(input: CreateTaskInput): Promise<ExecTask> {
    const id = newId("task");
    const now = Date.now();
    const t: MemTask = {
      id, surveyId: input.surveyId, customerId: input.customerId, createdBy: input.createdBy,
      kind: input.kind, request: input.request, status: "pending", planVersion: 1,
      deliverable: input.deliverable,
      steps: input.steps.map((s) => ({ ...s, taskId: id, retryCount: 0, planVersion: s.planVersion ?? 1 })),
      createdAt: now, updatedAt: now,
      committed: new Map(), claimedAt: new Map(),
    };
    this.tasks.set(id, t);
    return snapshot(t);
  }

  async load(taskId: string): Promise<ExecTask | null> { const t = this.read(taskId); return t ? snapshot(t) : null; }

  async openFor(surveyId: string): Promise<ExecTask | null> {
    let best: MemTask | null = null;
    for (const t of this.tasks.values()) {
      if (t.surveyId !== surveyId) continue;
      if (t.status !== "pending" && t.status !== "running") continue;
      if (!best || (t.createdAt ?? 0) > (best.createdAt ?? 0)) best = t;
    }
    return best ? snapshot(best) : null;
  }

  async claim(taskId: string, opts?: { staleSeconds?: number; maxAttempts?: number }): Promise<ClaimedStep | null> {
    const t = this.read(taskId);
    if (!t) return null;
    const stale = (opts?.staleSeconds ?? STALE_SECONDS) * 1000;
    const maxAttempts = opts?.maxAttempts ?? MAX_ATTEMPTS;
    const now = Date.now();
    const byId = new Map(t.steps.map((s) => [s.stepId, s]));
    for (const s of t.steps) {
      if (s.retryCount >= maxAttempts) continue;
      /*
       * The same predicate as the SQL claim, deliberately (audit C4/M1).
       * Two things used to differ and both mattered:
       *   • a `running` row with NO lease was treated as stale here (a
       *     missing lease reads as epoch 0) and as unclaimable in SQL, which
       *     is the opposite answer to the same row;
       *   • neither counted a reclaim, so a step whose worker keeps dying
       *     was offered again for ever (the `retryCount >= maxAttempts` test
       *     above could never become true on that path).
       */
      const lease = t.claimedAt.get(s.stepId);
      const runnable =
        s.status === "pending" || s.status === "retrying" ||
        (s.status === "running" && lease !== undefined && lease < now - stale);
      if (!runnable) continue;
      if (!dependenciesMet(s, byId)) continue;
      /* the whole mutation, with no await in it: this is the skip-locked window */
      const reclaim = s.status === "running";
      s.status = "running";
      /* a reclaim costs an attempt; a first claim of a pending step does not — `fail()` counts the ones that failed and said so */
      if (reclaim) s.retryCount += 1;
      s.startedAt = s.startedAt ?? now;
      s.failureKind = undefined;
      s.failureMessage = undefined;
      t.claimedAt.set(s.stepId, now);
      t.status = "running";
      t.updatedAt = now;
      return { step: structuredClone(s), claimedAt: now };
    }
    return null;
  }

  async commit(taskId: string, stepId: string, out: CommitInput): Promise<ExecStep> {
    const t = this.read(taskId);
    if (!t) throw new Error("taskStore: no such task");
    const s = t.steps.find((x) => x.stepId === stepId);
    if (!s) throw new Error("taskStore: no such step");
    /*
     * THE DUPLICATE-DELIVERY GUARD, the memory half of the unique index on
     * (task_id, idempotency_key). A second commit of the same key returns the
     * row that is already stored and adds nothing to the spend.
     */
    const seen = t.committed.get(out.idempotencyKey);
    if (seen !== undefined) {
      const first = t.steps.find((x) => x.stepId === seen);
      return structuredClone(first ?? s);
    }
    /*
     * AND THE OTHER HALF OF THE SAME GUARD (audit M2, 2026-10-25). The SQL
     * update is `.neq("status","completed")`, so a second delivery of a step
     * that already finished — under a DIFFERENT key, which the key map above
     * cannot catch — changes nothing. Memory used to overwrite the output and
     * the usage, so the reference implementation every test runs against was
     * not the contract the database enforces.
     */
    if (s.status === "completed") {
      t.committed.set(out.idempotencyKey, stepId);
      return structuredClone(s);
    }
    t.committed.set(out.idempotencyKey, stepId);
    s.status = "completed";
    s.output = out.output;
    s.usage = out.usage ? { ...out.usage } : s.usage;
    s.validation = out.validation ?? s.validation;
    if (out.batchSizeUsed !== undefined) s.batchSizeUsed = out.batchSizeUsed;
    s.idempotencyKey = out.idempotencyKey;
    s.finishedAt = Date.now();
    s.failureKind = undefined;
    s.failureMessage = undefined;
    t.claimedAt.delete(stepId);
    t.updatedAt = Date.now();
    return structuredClone(s);
  }

  async fail(taskId: string, stepId: string, failure: StepFailureInput): Promise<ExecStep> {
    const t = this.read(taskId);
    if (!t) throw new Error("taskStore: no such task");
    const s = t.steps.find((x) => x.stepId === stepId);
    if (!s) throw new Error("taskStore: no such step");
    const kind = classifyFailure(failure.kind, failure.hint);
    s.retryCount += 1;
    s.failureKind = kind;
    s.failureMessage = scrubSecrets(failure.message);
    s.status = failure.retryable && !isTerminalFailure(kind) && s.retryCount < (failure.maxAttempts ?? MAX_ATTEMPTS) ? "retrying" : "failed";
    s.finishedAt = Date.now();
    t.claimedAt.delete(stepId);
    t.updatedAt = Date.now();
    return structuredClone(s);
  }

  async revise(taskId: string, planVersion: number, steps: Omit<ExecStep, "taskId" | "retryCount">[], tombstoned: string[]): Promise<ExecTask> {
    const t = this.read(taskId);
    if (!t) throw new Error("taskStore: no such task");
    t.steps = planRevision(t.steps, taskId, planVersion, steps, tombstoned);
    t.planVersion = planVersion;
    t.updatedAt = Date.now();
    return snapshot(t);
  }

  async setStatus(taskId: string, status: TaskStatus, report?: ExecTask["report"]): Promise<void> {
    const t = this.read(taskId);
    if (!t) return;
    t.status = status;
    if (report) t.report = report;
    t.updatedAt = Date.now();
  }

  async earliestIncomplete(taskId: string): Promise<ExecStep | null> {
    const t = this.read(taskId);
    if (!t) return null;
    const s = earliestIncompleteStep(t);
    return s ? structuredClone(s) : null;
  }

  async stale(olderThanMs: number, limit = 50): Promise<{ id: string; surveyId: string }[]> {
    const cutoff = Date.now() - olderThanMs;
    const out: { id: string; surveyId: string }[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== "pending" && t.status !== "running") continue;
      if ((t.updatedAt ?? 0) > cutoff) continue;
      out.push({ id: t.id, surveyId: t.surveyId });
      if (out.length >= limit) break;
    }
    return out;
  }

  async addExtraCharge(taskId: string, amount: number): Promise<void> {
    if (!(amount > 0)) return;
    const t = this.read(taskId);
    if (!t) return;
    t.extraCharge = (t.extraCharge ?? 0) + amount;
    t.updatedAt = Date.now();
  }
}

/** the task without the memory store's bookkeeping, deep-copied so a caller cannot reach into the store */
function snapshot(t: MemTask): ExecTask {
  const { committed: _c, claimedAt: _a, ...rest } = t;
  return structuredClone(rest) as ExecTask;
}

/**
 * The in-memory store, on its own. R2, R3 and R4 test against this: it is the
 * contract, not a stub.
 */
export function memoryTaskStore(tasks?: Map<string, MemTask>): TaskStore { return new MemoryTaskStore(tasks); }

/** a fresh, isolated store — for a test that must not see another test's rows */
export function isolatedTaskStore(): TaskStore { return new MemoryTaskStore(new Map()); }

/* ------------------------------------------------------ the durable store */

type Row = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : v == null ? undefined : Number(v));
const time = (v: unknown): number | undefined => (typeof v === "string" ? Date.parse(v) : undefined);

function stepFromRow(r: Row): ExecStep {
  const errs = Array.isArray(r.validation_errors) ? (r.validation_errors as string[]) : [];
  const usage: StepUsage = {
    tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), tokensCached: num(r.tokens_cached),
    charge: num(r.charge), model: (r.model as string | null) ?? undefined,
  };
  const anyUsage = Object.values(usage).some((v) => v !== undefined);
  return {
    taskId: String(r.task_id),
    stepId: String(r.step_id),
    planVersion: Number(r.plan_version ?? 1),
    dependsOn: Array.isArray(r.depends_on) ? (r.depends_on as string[]) : [],
    status: String(r.status) as StepStatus,
    title: (r.title as string | null) ?? undefined,
    batchSize: num(r.batch_size),
    batchSizeUsed: num(r.batch_size_used),
    inputRef: (r.input_ref as string | null) ?? undefined,
    output: r.output ?? undefined,
    validation: r.validation_status
      ? { status: String(r.validation_status) as "unchecked" | "valid" | "invalid", errors: errs.length ? errs : undefined }
      : undefined,
    failureKind: (r.failure_kind as StepFailureKind | null) ?? undefined,
    failureMessage: (r.failure_message as string | null) ?? undefined,
    retryCount: Number(r.retry_count ?? 0),
    idempotencyKey: String(r.idempotency_key ?? ""),
    usage: anyUsage ? usage : undefined,
    startedAt: time(r.started_at),
    finishedAt: time(r.finished_at),
  };
}

function stepToRow(taskId: string, s: Omit<ExecStep, "taskId" | "retryCount"> & { retryCount?: number }, ordinal: number): Row {
  return {
    task_id: taskId,
    step_id: s.stepId,
    plan_version: s.planVersion ?? 1,
    ordinal,
    depends_on: s.dependsOn ?? [],
    status: s.status ?? "pending",
    title: s.title ?? null,
    batch_size: s.batchSize ?? null,
    batch_size_used: s.batchSizeUsed ?? null,
    input_ref: s.inputRef ?? null,
    output: s.output ?? null,
    validation_status: s.validation?.status ?? "unchecked",
    validation_errors: s.validation?.errors ?? [],
    failure_kind: s.failureKind ?? null,
    failure_message: s.failureMessage ?? null,
    retry_count: s.retryCount ?? 0,
    idempotency_key: s.idempotencyKey,
    tokens_in: s.usage?.tokensIn ?? null,
    tokens_out: s.usage?.tokensOut ?? null,
    tokens_cached: s.usage?.tokensCached ?? null,
    charge: s.usage?.charge ?? null,
    model: s.usage?.model ?? null,
  };
}

function taskFromRow(r: Row, steps: ExecStep[]): ExecTask {
  return {
    id: String(r.id),
    surveyId: String(r.survey_id),
    customerId: (r.customer_id as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    kind: String(r.kind) as TaskKind,
    request: String(r.request ?? ""),
    status: String(r.status) as TaskStatus,
    planVersion: Number(r.plan_version ?? 1),
    deliverable: (r.deliverable as DeliverableSpec | null) ?? { kind: String(r.kind) as TaskKind },
    steps,
    report: (r.report as ExecTask["report"] | null) ?? undefined,
    createdAt: time(r.created_at),
    updatedAt: time(r.updated_at),
  };
}

const TASKS = "intelligent_tasks";
const STEPS = "intelligent_steps";

/**
 * The Supabase half. Written with the service role: the route has already
 * checked that the caller may edit the project, which is the only way these
 * rows are reachable — the tables' RLS denies everyone else outright.
 *
 * The admin client is imported lazily. This module is the contract R2, R3 and
 * R4 test against with `node --experimental-strip-types`, and a top-level
 * `server-only` import would stop them loading it at all; the import below
 * only runs on a server that is actually going to the database.
 */
class SupabaseTaskStore implements TaskStore {
  readonly durable = true;
  private client: { from: (t: string) => any; rpc: (f: string, a: Record<string, unknown>) => any } | null = null;

  private async db() {
    if (!this.client) {
      const { supabaseAdmin } = await import("@/lib/admin");
      this.client = supabaseAdmin() as unknown as typeof this.client;
    }
    return this.client!;
  }

  /** the probe: one id, which fails with 42P01 / PGRST205 when migration 0074 has not been applied */
  async probe(surveyId: string) {
    const db = await this.db();
    /*
     * THE SWEEP HAS NO SURVEY OF ITS OWN (audit H7, 2026-10-25).
     *
     * `survey_id` is a uuid column, so probing it with the cron's `""`
     * raised 22P02 ("invalid input syntax for type uuid"). That is neither
     * 42P01 nor PGRST205, so `tableMissing` said no and `storeWithFallback`
     * rethrew — into the cron route's outer catch, which answered 503. On
     * every single run, for the life of the job. An empty survey id means
     * "every survey", so the probe simply asks whether the table answers.
     */
    const q = db.from(TASKS).select("id").limit(1);
    const { error } = await (surveyId ? q.eq("survey_id", surveyId) : q);
    if (error) throw error;
  }

  private async steps(taskId: string): Promise<ExecStep[]> {
    const db = await this.db();
    const { data, error } = await db.from(STEPS).select("*").eq("task_id", taskId).order("ordinal", { ascending: true }).order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r: Row) => stepFromRow(r));
  }

  async create(input: CreateTaskInput): Promise<ExecTask> {
    const db = await this.db();
    const { data, error } = await db.from(TASKS).insert({
      survey_id: input.surveyId, customer_id: input.customerId ?? null, created_by: input.createdBy ?? null,
      kind: input.kind, request: input.request, deliverable: input.deliverable, plan_version: 1, status: "pending",
    }).select("*").single();
    if (error) throw new Error(error.message);
    const id = String((data as Row).id);
    if (input.steps.length) {
      const { error: e2 } = await db.from(STEPS).insert(input.steps.map((s, i) => stepToRow(id, s, i)));
      if (e2) throw new Error(e2.message);
    }
    return taskFromRow(data as Row, await this.steps(id));
  }

  async load(taskId: string): Promise<ExecTask | null> {
    const db = await this.db();
    const { data, error } = await db.from(TASKS).select("*").eq("id", taskId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return taskFromRow(data as Row, await this.steps(taskId));
  }

  async openFor(surveyId: string): Promise<ExecTask | null> {
    const db = await this.db();
    const { data, error } = await db.from(TASKS).select("*").eq("survey_id", surveyId).in("status", ["pending", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return taskFromRow(data as Row, await this.steps(String((data as Row).id)));
  }

  async claim(taskId: string, opts?: { staleSeconds?: number; maxAttempts?: number }): Promise<ClaimedStep | null> {
    const db = await this.db();
    const { data, error } = await db.rpc("rescript_claim_intelligent_step", {
      p_task: taskId,
      p_stale_seconds: opts?.staleSeconds ?? STALE_SECONDS,
      p_max_attempts: opts?.maxAttempts ?? MAX_ATTEMPTS,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? (data[0] as Row | undefined) : (data as Row | null) ?? undefined;
    if (!row) return null;
    /* the claim returns the claim's own columns; the output and usage are read back with the row */
    const full = (await this.steps(taskId)).find((s) => s.stepId === String(row.step_id));
    const step = full ?? stepFromRow(row);
    await db.from(TASKS).update({ status: "running", updated_at: new Date().toISOString() }).eq("id", taskId).eq("status", "pending");
    return { step, claimedAt: time(row.claimed_at) ?? Date.now() };
  }

  async commit(taskId: string, stepId: string, out: CommitInput): Promise<ExecStep> {
    const db = await this.db();
    /*
     * Guarded on `status <> completed` AND on the idempotency key: a second
     * delivery of the same key updates no row, so one output is stored. The
     * unique index on (task_id, idempotency_key) stops a second ROW with that
     * key ever existing, which is the other half of the same guard.
     */
    const patch = {
      status: "completed",
      output: out.output ?? null,
      validation_status: out.validation?.status ?? "unchecked",
      validation_errors: out.validation?.errors ?? [],
      batch_size_used: out.batchSizeUsed ?? null,
      idempotency_key: out.idempotencyKey,
      tokens_in: out.usage?.tokensIn ?? null,
      tokens_out: out.usage?.tokensOut ?? null,
      tokens_cached: out.usage?.tokensCached ?? null,
      charge: out.usage?.charge ?? null,
      model: out.usage?.model ?? null,
      failure_kind: null, failure_message: null, claimed_at: null,
      finished_at: new Date().toISOString(),
    };
    const { data, error } = await db.from(STEPS).update(patch).eq("task_id", taskId).eq("step_id", stepId).neq("status", "completed").select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      /* already committed: return what is stored, and do not touch the totals */
      const { data: cur, error: e2 } = await db.from(STEPS).select("*").eq("task_id", taskId).eq("step_id", stepId).maybeSingle();
      if (e2) throw new Error(e2.message);
      if (!cur) throw new Error("taskStore: no such step");
      return stepFromRow(cur as Row);
    }
    await this.retotal(taskId);
    return stepFromRow(data as Row);
  }

  /** the task's totals, recomputed from the step rows — idempotent by construction, so a replay cannot double-count */
  private async retotal(taskId: string) {
    const db = await this.db();
    const { data, error } = await db.from(STEPS).select("tokens_in, tokens_out, tokens_cached, charge").eq("task_id", taskId);
    if (error) return; /* dual-write only: a totals refresh that fails must not fail the turn */
    const t = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, charge: 0 };
    for (const r of (data ?? []) as Row[]) {
      t.tokens_in += num(r.tokens_in) ?? 0;
      t.tokens_out += num(r.tokens_out) ?? 0;
      t.tokens_cached += num(r.tokens_cached) ?? 0;
      t.charge += num(r.charge) ?? 0;
    }
    /*
     * The steps explain everything attributable; `extra_charge` is the turn's
     * own spend that belongs to no plan item — the repair and coverage passes
     * (audit M7). `charge` is the sum, so it reconciles against `api_calls`.
     */
    const { data: own } = await db.from(TASKS).select("extra_charge").eq("id", taskId).maybeSingle();
    const extra = num((own as Row | null)?.extra_charge) ?? 0;
    await db.from(TASKS).update({ ...t, charge: t.charge + extra }).eq("id", taskId);
  }

  /** record spend the turn made outside any step; `charge` is refreshed to include it */
  async addExtraCharge(taskId: string, amount: number): Promise<void> {
    if (!(amount > 0)) return;
    const db = await this.db();
    const { data } = await db.from(TASKS).select("extra_charge").eq("id", taskId).maybeSingle();
    const next = (num((data as Row | null)?.extra_charge) ?? 0) + amount;
    await db.from(TASKS).update({ extra_charge: next }).eq("id", taskId);
    await this.retotal(taskId);
  }

  async fail(taskId: string, stepId: string, failure: StepFailureInput): Promise<ExecStep> {
    const db = await this.db();
    const { data: cur, error: e1 } = await db.from(STEPS).select("retry_count").eq("task_id", taskId).eq("step_id", stepId).maybeSingle();
    if (e1) throw new Error(e1.message);
    if (!cur) throw new Error("taskStore: no such step");
    const kind = classifyFailure(failure.kind, failure.hint);
    const retryCount = Number((cur as Row).retry_count ?? 0) + 1;
    const status = failure.retryable && !isTerminalFailure(kind) && retryCount < (failure.maxAttempts ?? MAX_ATTEMPTS) ? "retrying" : "failed";
    const { data, error } = await db.from(STEPS).update({
      status, failure_kind: kind, failure_message: scrubSecrets(failure.message),
      retry_count: retryCount, claimed_at: null, finished_at: new Date().toISOString(),
    }).eq("task_id", taskId).eq("step_id", stepId).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("taskStore: no such step");
    return stepFromRow(data as Row);
  }

  async revise(taskId: string, planVersion: number, steps: Omit<ExecStep, "taskId" | "retryCount">[], tombstoned: string[]): Promise<ExecTask> {
    const db = await this.db();
    const next = planRevision(await this.steps(taskId), taskId, planVersion, steps, tombstoned);
    const rows = next.map((s, i) => stepToRow(taskId, s, i));
    const { error } = await db.from(STEPS).upsert(rows, { onConflict: "task_id,step_id" });
    if (error) throw new Error(error.message);
    const { error: e2 } = await db.from(TASKS).update({ plan_version: planVersion }).eq("id", taskId);
    if (e2) throw new Error(e2.message);
    const t = await this.load(taskId);
    if (!t) throw new Error("taskStore: no such task");
    return t;
  }

  async setStatus(taskId: string, status: TaskStatus, report?: ExecTask["report"]): Promise<void> {
    const db = await this.db();
    const patch: Row = { status };
    if (report) patch.report = report;
    const { error } = await db.from(TASKS).update(patch).eq("id", taskId);
    if (error) throw new Error(error.message);
  }

  async earliestIncomplete(taskId: string): Promise<ExecStep | null> {
    return earliestIncompleteStep({ steps: await this.steps(taskId) });
  }

  async stale(olderThanMs: number, limit = 50): Promise<{ id: string; surveyId: string }[]> {
    const db = await this.db();
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const { data, error } = await db.from(TASKS).select("id, survey_id").in("status", ["pending", "running"]).lt("updated_at", cutoff).order("updated_at", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), surveyId: String(r.survey_id) }));
  }
}

/**
 * The store for one survey's tasks. The sandbox has no survey row and
 * therefore no task table to be in, and a developer without Supabase gets
 * memory; everything else gets the table when it is there and says so.
 */
export async function taskStoreFor(surveyId: string): Promise<TaskStore> {
  return storeWithFallback<TaskStore>({
    memoryOnly: surveyId === "sandbox" || surveyId.startsWith("sandbox:") || !dbConfigured(),
    durable: () => new SupabaseTaskStore(),
    probe: (s) => (s as SupabaseTaskStore).probe(surveyId),
    memory: () => new MemoryTaskStore(),
    what: "the task tables intelligent_tasks / intelligent_steps (apply migration 0074)",
  });
}
