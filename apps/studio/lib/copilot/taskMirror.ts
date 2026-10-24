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
    const store = await taskStoreFor(input.surveyId);
    const loaded = await loadOrCreatePlan({
      surveyId: input.surveyId,
      request: input.request,
      plan: input.plan,
      mode: input.mode ?? null,
      definition: input.definition ?? null,
      customerId: input.customerId,
      createdBy: input.createdBy,
      planFirst: input.planFirst,
    }, store);
    if (!loaded) return null;
    const task = loaded.task;
    return {
      task, store, durable: store.durable,
      reconciliation: { fresh: loaded.fresh, reused: loaded.reused, redone: loaded.redone, tombstoned: loaded.tombstoned },
      async step(itemId, raw, usage) {
        try {
          await store.commit(task.id, itemId, {
            output: raw, usage,
            /* stable across retries and slices: the same item of the same plan version is one delivery */
            idempotencyKey: `${task.id}:${task.planVersion}:${itemId}`,
          });
        } catch (e) { quiet("commit", e); }
      },
      async finish(def) {
        try {
          const fresh = await store.load(task.id);
          if (!fresh) return;
          /*
           * COMPLETION IS NOT DECLARED FROM THE REPLY. Every step may have
           * come back and the deliverable still be short — 64 questions of
           * 100 — in which case the task stays `running` and resumes at 65.
           * `checkDeliverable` is deterministic code; no model is asked.
           */
          const report = def ? checkDeliverable(fresh.deliverable, def) : undefined;
          const status = report ? nextStatusFor(fresh, report) : "running";
          await store.setStatus(task.id, status, report);
        } catch (e) { quiet("finish", e); }
      },
    };
  } catch (e) { return quiet("start", e); }
}
