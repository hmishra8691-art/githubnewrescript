/**
 * ONE STEP ONCE (production intents, 2026-10-18).
 *
 * An open proposal collects steps: every request made while it is open joins it (a revision is part of the
 * same change), and its History record's prompt is the requests joined with " → ". Production evidence
 * (2026-10-17 10:11): "Plan the analysis → Plan the analysis → यही सारे question text … मराठी में कर दो" —
 * the "Plan the analysis" chip pressed twice added the same step twice (two propose_analysis_plan actions
 * in one change) and the record said it twice. A step identical to the one before it (same words, same
 * actions) is the same request, not a second one: it is not added again, to the proposal or to the record.
 */
import type { ProposalStep } from "./client.ts";
import { canRestore, type ClientOp } from "./history.ts";

const SEP = " → ";

/** the same request with the same actions as the step before it */
export function sameStep(a: Pick<ProposalStep, "request" | "actions"> | undefined, b: Pick<ProposalStep, "request" | "actions">): boolean {
  return !!a && a.request.trim() === b.request.trim() && JSON.stringify(a.actions) === JSON.stringify(b.actions);
}

/** the steps with one more — unless it repeats the last one */
export function withStep<T extends Pick<ProposalStep, "request" | "actions">>(steps: readonly T[], step: T): T[] {
  return sameStep(steps[steps.length - 1], step) ? [...steps] : [...steps, step];
}

/** a record's prompt with one more request — unless it repeats the last one */
export function foldPrompt(prompt: string, text: string, max = 4000): string {
  const parts = prompt.split(SEP);
  if (parts[parts.length - 1]?.trim() === text.trim()) return prompt.slice(0, max);
  return `${prompt}${SEP}${text}`.slice(0, max);
}

/** do the new actions repeat the tail of what the record already holds (the same request sent twice)? */
export function repeatsTail(held: readonly unknown[], actions: readonly unknown[]): boolean {
  if (!actions.length || held.length < actions.length) return false;
  return JSON.stringify(held.slice(held.length - actions.length)) === JSON.stringify(actions);
}

/**
 * WHICH CHANGE "UNDO" MEANS — the last Intelligent Mode change still standing: this page's newest one that
 * is not reverted (as the toolbar's "Undo AI change" picks it), else the newest standing change in the
 * survey's History that nothing was applied after (an earlier session's, which History can restore).
 */
export function lastUndoable(history: readonly { key?: string | null; reverted?: boolean }[], ops: readonly ClientOp[]): string | null {
  const mine = [...history].reverse().find((h) => !h.reverted && h.key);
  if (mine?.key) return mine.key;
  const hit = ops.find((o) => { const c = canRestore(o, ops); return c.offered && c.latest; });
  return hit?.key ?? null;
}
