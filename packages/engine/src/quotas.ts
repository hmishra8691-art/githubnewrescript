import type { SurveyDefinition, Quota } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { evaluateCondition } from "./evaluate.js";

/** quotaId -> cellId -> current count (loaded from storage by the runtime). */
export type QuotaCounts = Record<string, Record<string, number>>;

export interface QuotaCellStatus {
  quotaId: string;
  quotaName: string;
  cellId: string;
  cellLabel: string;
  count: number;
  limit: number;
  limitType: "count" | "percent";
  effectiveLimit: number;
  full: boolean;
  mode: "hard" | "soft";
  matchesRespondent: boolean;
}

/**
 * A cell's limit in respondents. Exported because List Fill's quota-aware
 * allocation must read a cell's capacity exactly as `checkQuotas` does — one
 * definition of "full", not two that can drift.
 */
export function effectiveLimit(q: Quota, cellLimit: number, limitType: "count" | "percent"): number {
  if (limitType === "percent") {
    const total = q.targetTotal ?? 0;
    return Math.floor((cellLimit / 100) * total);
  }
  return cellLimit;
}

/** Which cells the current respondent falls into. */
export function matchingCells(
  def: SurveyDefinition,
  state: ResponseState,
  quota: Quota,
): string[] {
  return quota.cells
    .filter((c) => evaluateCondition(c.when, { def, state }))
    .map((c) => c.id);
}

/**
 * Returns the ids of quotas that are FULL for this respondent's cells.
 * Soft quotas never terminate — they only flag.
 */
export function checkQuotas(
  def: SurveyDefinition,
  state: ResponseState,
  counts: QuotaCounts,
  quotaIds?: string[],
): string[] {
  const full: string[] = [];
  const quotas = def.quotas.filter((q) => !quotaIds || quotaIds.includes(q.id));
  for (const quota of quotas) {
    for (const cellId of matchingCells(def, state, quota)) {
      const cell = quota.cells.find((c) => c.id === cellId)!;
      const count = counts[quota.id]?.[cellId] ?? 0;
      const limit = effectiveLimit(quota, cell.limit, cell.limitType);
      if (limit > 0 && count >= limit) {
        if (quota.mode === "hard") full.push(quota.id);
        else state.flags.push(`soft_quota:${quota.id}:${cellId}`);
      }
    }
  }
  return [...new Set(full)];
}

/** Full quota dashboard snapshot (requirement §15 / §25). */
export function quotaStatus(
  def: SurveyDefinition,
  state: ResponseState | null,
  counts: QuotaCounts,
): QuotaCellStatus[] {
  const out: QuotaCellStatus[] = [];
  for (const quota of def.quotas) {
    const matches = state ? matchingCells(def, state, quota) : [];
    for (const cell of quota.cells) {
      const count = counts[quota.id]?.[cell.id] ?? 0;
      const limit = effectiveLimit(quota, cell.limit, cell.limitType);
      out.push({
        quotaId: quota.id,
        quotaName: quota.name,
        cellId: cell.id,
        cellLabel: cell.label,
        count,
        limit: cell.limit,
        limitType: cell.limitType,
        effectiveLimit: limit,
        full: limit > 0 && count >= limit,
        mode: quota.mode,
        matchesRespondent: matches.includes(cell.id),
      });
    }
  }
  return out;
}

/** Increments to apply when a respondent completes (runtime persists these). */
export function quotaIncrements(
  def: SurveyDefinition,
  state: ResponseState,
): { quotaId: string; cellId: string }[] {
  const inc: { quotaId: string; cellId: string }[] = [];
  for (const quota of def.quotas) {
    for (const cellId of matchingCells(def, state, quota)) {
      inc.push({ quotaId: quota.id, cellId });
    }
  }
  return inc;
}

/**
 * Quota counts recomputed from a set of respondents — the batch form of
 * `quotaIncrements`, and the ONLY loop that turns respondents into cell
 * counts. The runtime increments one completion at a time with
 * `quotaIncrements`; the Studio's recount (`apps/studio/lib/quotaRecount.ts`)
 * feeds stored rows through `rowToState` into this. Both therefore decide
 * membership with `matchingCells` → `evaluateCondition`, so a recount can
 * never disagree with live counting about which cell a respondent fills.
 *
 * `into` accumulates across calls (the recount pages through responses).
 * Returns the number of respondents counted in this call.
 */
export function tallyQuotaCells(
  def: SurveyDefinition,
  states: Iterable<ResponseState>,
  into: QuotaCounts,
): number {
  let n = 0;
  for (const state of states) {
    n++;
    for (const { quotaId, cellId } of quotaIncrements(def, state)) {
      const byCell = (into[quotaId] ??= {});
      byCell[cellId] = (byCell[cellId] ?? 0) + 1;
    }
  }
  return n;
}
