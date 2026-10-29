/**
 * `ctx.draft` — THE SURVEY A STEP SEES (2026-10-29, the replay ported from K1's engine, not its engine).
 *
 * A task planned by a registered planner keeps the survey it was planned against on its row (`task.base`, the
 * SurveyDefinition snapshot). A step is given that base with every COMPLETED step's actions applied in plan order,
 * through the engine's own gate (`applySurveyActions`, `lite`: the same validation and schema check, without the
 * warning-only reviews nobody reads in a replay) and with DETERMINISTIC ids (`seededIds(taskId:stepId)`), so the
 * same task produces the same bytes on this server, on another, or in the cron with the page closed — and the
 * result the researcher finally applies is exactly what every step was judged against.
 *
 * A step's output is a `StepOutput` ({ actions, data, validation }) when a handler built it, or the raw copilot
 * reply ({ kind, actions, … }) when the existing item path did; both carry `actions`, and both go through
 * `coerceSurveyActions` first, so a malformed action is a counted error, never a throw.
 *
 * Pure: no store, no clock, no provider. A small per-process memo keeps the last draft of each task so a plan of
 * fifty batches does not replay fifty times fifty; a miss is just a full replay.
 */
import { createHash } from "node:crypto";
import { applySurveyActions, coerceSurveyActions, seededIds, type ExecStep, type ExecTask } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/** a replay never depends on the clock: the same `now` on every replay */
export const REPLAY_NOW = "2026-01-01T00:00:00.000Z";

export interface DraftResult { def: SurveyDefinition; errors: { stepId: string; error: string }[]; folded: string[] }

/** the actions a step's stored output carries, whichever shape wrote it */
export function actionsOfOutput(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  if (output && typeof output === "object" && Array.isArray((output as { actions?: unknown }).actions)) return (output as { actions: unknown[] }).actions;
  return [];
}

/** apply one step's actions to a draft with ids derived from the step (the same ids on every replay) */
export function replayActions(def: SurveyDefinition, actions: unknown[], seed: string): { def: SurveyDefinition; errors: string[] } {
  const { actions: acts, rejected } = coerceSurveyActions(actions, 5000);
  if (!acts.length) return { def, errors: rejected.map((x) => `an action the Studio could not read: ${x.reason}`) };
  const r = applySurveyActions(def, acts, { ids: seededIds(seed), now: REPLAY_NOW, lite: true });
  return { def: r.valid ? r.def : def, errors: [...rejected.map((x) => `an action the Studio could not read: ${x.reason}`), ...r.errors] };
}

/** the completed steps whose actions the draft folds in, in plan order (tombstones and failures carry nothing) */
export function foldedSteps(task: Pick<ExecTask, "steps">): ExecStep[] {
  return task.steps.filter((s) => s.status === "completed" && actionsOfOutput(s.output).length > 0);
}

interface Memo { base: string; folded: string[]; def: SurveyDefinition; errors: { stepId: string; error: string }[] }
const G = globalThis as unknown as { __rescriptTaskDrafts?: Map<string, Memo> };
const MEMO = (G.__rescriptTaskDrafts ??= new Map<string, Memo>());
const MEMO_SIZE = 20;
const foldId = (s: ExecStep) => `${s.stepId}@${s.idempotencyKey}:${s.finishedAt ?? ""}`;
const fingerprint = (x: unknown) => createHash("sha256").update(JSON.stringify(x ?? null)).digest("hex").slice(0, 24);

/**
 * The base survey with every completed step's actions applied, in plan order. `base` is the task's snapshot, or
 * the survey the caller read when the task has none (a plan-item task of the item path).
 */
export function buildDraft(task: Pick<ExecTask, "id" | "steps" | "base">, base?: SurveyDefinition | null): DraftResult {
  const root = (task.base ?? base ?? { questions: [], flow: [] }) as SurveyDefinition;
  const done = foldedSteps(task);
  const ids = done.map(foldId);
  const baseFp = fingerprint(root);
  const memo = MEMO.get(task.id);
  let def = root;
  let errors: { stepId: string; error: string }[] = [];
  let from = 0;
  if (memo && memo.base === baseFp && memo.folded.length <= ids.length && memo.folded.every((f, i) => ids[i] === f)) {
    def = memo.def; errors = [...memo.errors]; from = memo.folded.length;
  }
  for (const s of done.slice(from)) {
    const r = replayActions(def, actionsOfOutput(s.output), `${task.id}:${s.stepId}`);
    def = r.def;
    for (const e of r.errors) errors.push({ stepId: s.stepId, error: e });
  }
  MEMO.delete(task.id);
  MEMO.set(task.id, { base: baseFp, folded: ids, def, errors });
  if (MEMO.size > MEMO_SIZE) MEMO.delete(MEMO.keys().next().value!);
  /* a deep copy: a handler may mutate what it is given, and the memo must not see that */
  return { def: structuredClone(def), errors, folded: done.map((s) => s.stepId) };
}

/** test seam */
export function __resetDraftMemo(): void { MEMO.clear(); }
