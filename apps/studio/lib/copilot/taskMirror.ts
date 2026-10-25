/**
 * THE DUAL WRITE, IN ONE PLACE (consolidation, 2026-10-24).
 *
 * The durable task rows are written from the first deploy; what the next
 * request BELIEVES is built still comes from the browser's `done[]` until an
 * operator sets COPILOT_TASK_RESUME. That ordering is the whole safety of the
 * migration, and it only holds if the write side can never affect the turn.
 *
 * So every call here is best-effort: the store is reached through
 * `taskStoreFor`, every method swallows its own failure, logs it once, and
 * returns. A turn that would have succeeded before this module existed still
 * succeeds if the migration has not been applied, if Supabase is down, or if
 * anything in the task layer throws. Nothing here is awaited on the hot path
 * for its result — only for its ordering.
 *
 * It is deliberately thin: the route gains three lines (start, step, finish)
 * and keeps its own loop, its own gate, its own apply. This is a MIRROR of
 * the execution, not a second orchestrator.
 */
import type { ChangePlan } from "./changePlan.ts";
import type { SurveyDefinition } from "@rescript/schema";
import type { ExecTask, StepUsage } from "@rescript/engine";
import { loadOrCreatePlan } from "./planPersistence.ts";
import { taskStoreFor, type TaskStore } from "./taskStore.ts";
import { taskDualWriteEnabled } from "./resume.ts";
import { checkDeliverable, nextStatusFor } from "./deliverable.ts";

/*
 * A STALL IS NOT A REJECTION (audit H5, 2026-10-25).
 *
 * Every call here was wrapped in try/catch, which handles a store that
 * FAILS and does nothing at all about a store that simply never answers.
 * These calls are awaited on the turn's hot path, inside the 90 s stage cap,
 * so a Supabase that accepts a query and holds it blocked the generation
 * until the platform killed the function at 180 s — and the request returned
 * no JSON at all, which is the exact failure mode the durable rows were
 * added to prevent.
 *
 * The ceiling is deliberately mean. Nothing here is on the critical path for
 * correctness: the browser's checkpoint is still the source of truth, so a
 * mirror call that is slow is a mirror call worth abandoning.
 */
const START_MS = 3_000;
const STEP_MS = 2_000;

class MirrorTimeout extends Error {
  constructor(what: string, ms: number) { super(`the task store did not answer within ${ms} ms (${what})`); }
}

function withTimeout<T>(p: Promise<T>, what: string, ms = STEP_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MirrorTimeout(what, ms)), ms);
    /* unref so a pending ceiling never keeps a serverless invocation alive */
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** said once per process, so a log is not a wall of the same sentence */
let warned = false;
function quiet(where: string, e: unknown): null {
  if (!warned) {
    warned = true;
    console.warn("[rescript:copilot]", JSON.stringify({
      event: "the durable task mirror is not recording this turn (the turn itself is unaffected)",
      where, error: ((e as Error)?.message ?? String(e)).slice(0, 200),
    }));
  }
  return null;
}

export interface Mirror {
  readonly task: ExecTask;
  readonly store: TaskStore;
  /** true when the rows are in the database rather than this server's memory */
  readonly durable: boolean;
  /** what was reused and what is being redone, for the reply — empty on a fresh task */
  readonly reconciliation: { fresh: boolean; reused: string[]; redone: string[]; tombstoned: string[] };
  /** one built item, committed as it returns */
  step(itemId: string, raw: unknown, usage?: StepUsage): Promise<void>;
  /** the slice ended: the deliverable decides whether this is `completed` or still `running` */
  finish(def: SurveyDefinition | null): Promise<void>;
}

export interface MirrorStart {
  surveyId: string;
  request: string;
  plan: ChangePlan | null;
  mode?: string | null;
  definition?: SurveyDefinition | null;
  customerId?: string;
  createdBy?: string;
  planFirst?: boolean;
}

/**
 * Begin mirroring this turn. Returns null — and the route carries on exactly
 * as before — when the dual write is off, when the turn is too small to
 * deserve a task row (`loadOrCreatePlan` decides that, not this module), or
 * when anything at all goes wrong.
 */
export async function mirrorStart(input: MirrorStart): Promise<Mirror | null> {
  if (!taskDualWriteEnabled()) return null;
  try {
    const store = await withTimeout(taskStoreFor(input.surveyId), "open the store", START_MS);
    const loaded = await withTimeout(loadOrCreatePlan({
      surveyId: input.surveyId,
      request: input.request,
      plan: input.plan,
      mode: input.mode ?? null,
      definition: input.definition ?? null,
      customerId: input.customerId,
      createdBy: input.createdBy,
      planFirst: input.planFirst,
    }, store), "load or create the task", START_MS);
    if (!loaded) return null;
    const task = loaded.task;
    return {
      task, store, durable: store.durable,
      reconciliation: { fresh: loaded.fresh, reused: loaded.reused, redone: loaded.redone, tombstoned: loaded.tombstoned },
      async step(itemId, raw, usage) {
        try {
          /*
           * THE STEP'S OWN KEY, NOT ONE MADE UP HERE (audit H1).
           * The plan seeds each step with `idemOf(surveyId, item.id,
           * itemFingerprint(item))` — content-addressed, so the same item of
           * the same plan is the same delivery in any slice, in any process.
           * This used to compose `${task.id}:${planVersion}:${itemId}`
           * instead, which changed whenever a new task row was minted and so
           * could never collide with the earlier delivery it was supposed to
           * deduplicate.
           */
          const seeded = task.steps.find((x) => x.stepId === itemId)?.idempotencyKey;
          await withTimeout(store.commit(task.id, itemId, {
            output: raw, usage,
            idempotencyKey: seeded || `${task.surveyId}:${itemId}:${task.planVersion}`,
          }), "commit");
        } catch (e) { quiet("commit", e); }
      },
      async finish(def) {
        try {
          const fresh = await withTimeout(store.load(task.id), "reload the task");
          if (!fresh) return;
          /*
           * COMPLETION IS NOT DECLARED FROM THE REPLY. Every step may have
           * come back and the deliverable still be short — 64 questions of
           * 100 — in which case the task stays `running` and resumes at 65.
           * `checkDeliverable` is deterministic code; no model is asked.
           */
          const report = def ? checkDeliverable(fresh.deliverable, def) : undefined;
          const status = report ? nextStatusFor(fresh, report) : "running";
          await withTimeout(store.setStatus(task.id, status, report), "record the status");
        } catch (e) { quiet("finish", e); }
      },
    };
  } catch (e) { return quiet("start", e); }
}
