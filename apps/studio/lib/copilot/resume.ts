import type { ChangePlan } from "./changePlan.ts";
import { describeFailure, failureFromTransport, isTurnFailure, type TurnFailure } from "./failure.ts";

/**
 * KEEPING THE RESEARCHER'S WORK THROUGH A BAD MOMENT.
 *
 * A survey brief becomes a change plan, and each approved item is a call to
 * the model. When the provider is busy, a key is refused, the platform cuts a
 * request off or the page is reloaded, the prompt and every item already
 * built are a CHECKPOINT: kept here (in the browser, per survey), sent back
 * with the next request so a built item is never asked for again, and offered
 * on the card as Resume / Review what's ready. Nothing is generated twice,
 * paid for twice or lost.
 *
 * The functions are pure (storage and clock are passed in) so the rules are
 * tested without a browser.
 */

export interface BuiltItem { id: string; raw: unknown }
export interface Checkpoint {
  v: 1;
  entryId: string;
  surveyId: string;
  /** what the researcher asked, verbatim */
  text: string;
  mode?: "generate" | "review";
  /** "turn": one request (the plan, or a single reply); "build": the approved items of a plan, one call each */
  kind: "turn" | "build";
  plan?: ChangePlan;
  /** the plan items asked for, in order (a build) */
  items?: string[];
  /** the items already built, with the model's reply for each */
  built: BuiltItem[];
  /** items built into the open proposal by an earlier request — told to the model as context, never merged again */
  applied?: BuiltItem[];
  failed: { id: string; failure: TurnFailure }[];
  at: number;
}

/** a checkpoint is a day's courtesy, not an archive */
export const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const keyOf = (surveyId: string) => `rescript.copilot.checkpoint.${surveyId}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Write the checkpoint. A full or blocked storage is not an error: the page still holds it in memory. Returns whether it was stored. */
export function saveCheckpoint(store: Store | null, cp: Checkpoint): boolean {
  if (!store) return false;
  try { store.setItem(keyOf(cp.surveyId), JSON.stringify(cp)); return true; }
  catch {
    /* too big for the storage: keep what matters most — the prompt and the plan, and the ids built (their replies are lost, so they will be built again) */
    try { store.setItem(keyOf(cp.surveyId), JSON.stringify({ ...cp, built: [], applied: [] })); return false; } catch { return false; }
  }
}

export function loadCheckpoint(store: Store | null, surveyId: string, now = Date.now()): Checkpoint | null {
  if (!store) return null;
  try {
    const raw = store.getItem(keyOf(surveyId));
    if (!raw) return null;
    const cp = JSON.parse(raw) as Checkpoint;
    if (!cp || cp.v !== 1 || cp.surveyId !== surveyId || typeof cp.text !== "string" || typeof cp.entryId !== "string" || !Array.isArray(cp.built)) return null;
    if (now - cp.at > CHECKPOINT_TTL_MS) { store.removeItem(keyOf(surveyId)); return null; }
    return cp;
  } catch { return null; }
}

export function clearCheckpoint(store: Store | null, surveyId: string): void {
  try { store?.removeItem(keyOf(surveyId)); } catch { /* nothing to clear */ }
}

/** the built items, each id once — a later reply for an id replaces an earlier one, so a retried item never appears twice */
export function mergeBuilt(prev: BuiltItem[], next: BuiltItem[]): BuiltItem[] {
  const byId = new Map<string, BuiltItem>();
  for (const b of prev) byId.set(b.id, b);
  for (const b of next) byId.set(b.id, b);
  return [...byId.values()];
}

/** the ids still to build: asked for, not built, not failed */
export function pendingIds(items: string[], built: BuiltItem[], failed: { id: string }[]): string[] {
  const have = new Set([...built.map((b) => b.id), ...failed.map((f) => f.id)]);
  return items.filter((id) => !have.has(id));
}

/** how long to wait before trying again: what the provider asked for, else a growing pause — never longer than two minutes, never an instant hammering */
export function waitBeforeRetry(failure: TurnFailure | { retryAfterMs?: number }, attempt: number, rand: () => number = Math.random): number {
  const asked = (failure as { retryAfterMs?: number }).retryAfterMs;
  if (asked && asked > 0) return Math.min(120_000, Math.max(1500, Math.round(asked)));
  const window = Math.min(60_000, 3000 * 2 ** attempt);
  return Math.round(window / 2 + rand() * (window / 2));
}

/** The most automatic tries a single request gets before the card hands the decision back to the researcher (the work stays saved) */
export const MAX_AUTO_RETRIES = 5;
/** Rounds of an unfinished build that bring no new item before the card stops resuming by itself */
export const MAX_STALLED_ROUNDS = 3;

export interface TurnResponse { status: number; ok: boolean; d: Record<string, unknown> | null }

/**
 * What a failed round trip means. The server always answers in JSON; when it
 * did not — the platform cut the request off (504), a gateway error page, a
 * dropped connection (status 0) — that is a temporary failure with the work
 * safe in the browser, never "the provider refused the request".
 */
export function failureOfResponse(res: TurnResponse): TurnFailure | null {
  if (res.status === 0) return failureFromTransport(0);
  const d = res.d;
  if (isTurnFailure(d?.failure)) return d.failure;
  if (!res.ok || d?.ok === false) return res.d ? null : failureFromTransport(res.status);
  return res.d ? null : failureFromTransport(res.status);
}

/** a retry can help: the server said so (retryable), or no JSON answer reached us at all */
export function isTemporary(res: TurnResponse): boolean {
  if (res.ok && res.d?.ok !== false) return false;
  if (res.status === 0) return true;
  const f = res.d?.failure;
  if (isTurnFailure(f)) return !!f.retryable;
  return !res.d && res.status >= 500;
}

/* ---------------------------------------------------- what the card says */

/** the researcher-facing line for each moment of a generation — no status codes, no provider text */
export const STATUS = {
  planning: "Planning your survey…",
  generating: "Generating your survey…",
  building: (done: number, total: number) => (done > 0 ? `Processing the remaining questions… ${done} of ${total} items built.` : "Generating your survey…"),
  waiting: "Temporarily waiting for AI capacity. Your work has been saved.",
  resuming: "Resuming survey generation…",
  ready: "Your survey draft is ready for review.",
  partial: (done: number, total: number) => `Your survey draft is partly ready: ${done} of ${total} items built. Review what is ready, or build the rest.`,
} as const;

/** the card's failed state for a build that kept its work */
export function pausedFailure(base: TurnFailure, built: number, total: number): TurnFailure {
  if (!built) return base;
  return { ...base, next: [`${built} of ${total} items are built and kept — Resume builds the rest, or Review what's ready opens what exists.`, ...base.next.filter((n) => !/^Anything already generated|^Then press Resume/.test(n))] };
}

/** the failure a restored checkpoint shows: the page was closed or reloaded in the middle of it */
export function interruptedFailure(cp: Checkpoint): TurnFailure {
  const total = cp.items?.length ?? 0;
  const base = describeFailure("interrupted");
  return {
    ...base,
    message: cp.kind === "build" && total
      ? `The page was closed or reloaded while your survey was being built. Your request is saved with ${cp.built.length} of ${total} items already built.`
      : "The page was closed or reloaded while your request was being answered. Your request is saved.",
    next: ["Resume continues from where it stopped — nothing is generated twice and nothing needs to be typed again.", ...(cp.built.length ? ["Or review what is already built."] : [])],
  };
}
