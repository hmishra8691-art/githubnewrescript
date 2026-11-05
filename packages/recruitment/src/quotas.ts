import type { AudienceQuotaCell } from "@rescript/schema";
import { round2 } from "./pricing.js";

/**
 * THE QUOTA ENGINE.
 *
 * ## The trap, and why a flat list of cells cannot be validated
 *
 * A researcher writes:
 *
 *      Male 50%      Female 50%
 *      18–34 40%     35–54 35%     55+ 25%
 *
 * That is a correct, ordinary specification. It is also five cells whose targets sum to 250%, and a validator
 * that adds up a flat list rejects it as impossible. The percentages are not competing for the same sample —
 * they describe the SAME respondents along two independent DIMENSIONS, and each dimension sums to 100.
 *
 * So a quota cell belongs to a dimension, taken from the criterion it constrains. `{gender: "male"}` is in the
 * `gender` dimension; `{ageBand: "18-34"}` is in `ageBand`. Each dimension is validated on its own.
 *
 * ## Interlocked cells are a third thing again
 *
 * `{gender: "male", ageBand: "18-34"}` constrains two criteria at once. It does not belong to either
 * dimension: it is a CELL OF THE CROSS, and the cross has its own total. Mixing it into the `gender` dimension
 * would make that dimension sum to more than 100 and look broken when it is not.
 *
 * ## What this refuses to do
 *
 * It does not clamp. A dimension summing to 120% is reported as impossible, with the figure, rather than
 * quietly scaled to fit — a researcher who meant 60/60 has made a mistake worth seeing, and one who meant
 * 60/40 needs to know which number the platform decided to change.
 */

export type QuotaMode = "count" | "percent";

export interface QuotaIssue {
  severity: "error" | "warning";
  /** the dimension or cross this is about; "*" when it concerns the specification as a whole */
  dimension: string;
  message: string;
  cellIds: string[];
}

export interface ExpandedQuotaCell {
  id: string;
  label: string;
  dimension: string;
  criteria: Record<string, unknown>;
  mode: QuotaMode;
  /** as written */
  target: number;
  /** in completes, whatever the mode */
  targetCompletes: number;
  interlocked: boolean;
}

export interface QuotaPlan {
  cells: ExpandedQuotaCell[];
  dimensions: Array<{ dimension: string; cells: number; percentTotal: number | null; countTotal: number }>;
  issues: QuotaIssue[];
  ok: boolean;
  /** one sentence for the researcher, naming the first thing to fix */
  statement: string;
}

/** Sorted so the dimension key is stable however the criteria object was built. */
export function dimensionOf(criteria: Record<string, unknown>): string {
  const keys = Object.keys(criteria ?? {}).filter((k) => criteria[k] !== undefined && criteria[k] !== null).sort();
  if (!keys.length) return "*";
  return keys.join("+");
}

const PERCENT_TOLERANCE = 0.5;   // half a point: a researcher typing 33/33/34 has not made an error

/**
 * Validate and expand a quota specification.
 *
 * `requiredCompletes` turns percentages into completes. Without it the percentages are still validated, but no
 * absolute target can be reported — and reporting one computed from a guessed total would be worse than
 * reporting none.
 */
export function planQuotas(
  cells: readonly AudienceQuotaCell[],
  requiredCompletes: number,
): QuotaPlan {
  const issues: QuotaIssue[] = [];

  const expanded: ExpandedQuotaCell[] = [...cells]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const criteria = (c.criteria ?? {}) as Record<string, unknown>;
      const dimension = dimensionOf(criteria);
      const mode = (c.mode ?? "count") as QuotaMode;
      const targetCompletes = mode === "percent"
        ? Math.round((c.target / 100) * Math.max(requiredCompletes, 0))
        : Math.round(c.target);
      return {
        id: c.id, label: c.label, dimension, criteria, mode,
        target: c.target, targetCompletes,
        interlocked: dimension.includes("+"),
      };
    });

  const byDimension = new Map<string, ExpandedQuotaCell[]>();
  for (const c of expanded) {
    const list = byDimension.get(c.dimension) ?? [];
    list.push(c);
    byDimension.set(c.dimension, list);
  }

  const dimensions = [...byDimension.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dimension, list]) => {
    const percentCells = list.filter((c) => c.mode === "percent");
    const countCells = list.filter((c) => c.mode === "count");
    const percentTotal = percentCells.length ? round2(percentCells.reduce((s, c) => s + c.target, 0)) : null;
    const countTotal = countCells.reduce((s, c) => s + c.target, 0);

    /*
     * A dimension mixing percentages and counts is ambiguous: 50% male and 300 female cannot both be checked
     * against the same total without knowing which one the researcher meant to be authoritative.
     */
    if (percentCells.length && countCells.length) {
      issues.push({
        severity: "error", dimension,
        message: `${dimension} mixes percentages and fixed counts. Use one or the other within a dimension, or the targets cannot be reconciled.`,
        cellIds: list.map((c) => c.id),
      });
    }

    if (percentTotal !== null && percentTotal > 100 + PERCENT_TOLERANCE) {
      issues.push({
        severity: "error", dimension,
        message: `${dimension} quotas add up to ${percentTotal}%, which cannot be filled. Reduce them to 100% or less.`,
        cellIds: percentCells.map((c) => c.id),
      });
    }
    if (percentTotal !== null && percentTotal < 100 - PERCENT_TOLERANCE) {
      /*
       * NOT an error. A researcher who wants 40% women and does not care about the rest has specified exactly
       * that, and the remainder is simply unconstrained. Saying so is useful; refusing it would be wrong.
       */
      issues.push({
        severity: "warning", dimension,
        message: `${dimension} quotas cover ${percentTotal}% of the sample; the remaining ${round2(100 - percentTotal)}% is unconstrained.`,
        cellIds: percentCells.map((c) => c.id),
      });
    }

    if (requiredCompletes > 0 && countTotal > requiredCompletes) {
      issues.push({
        severity: "error", dimension,
        message: `${dimension} quotas ask for ${countTotal.toLocaleString()} completes against a target of ${requiredCompletes.toLocaleString()}.`,
        cellIds: countCells.map((c) => c.id),
      });
    }

    return { dimension, cells: list.length, percentTotal, countTotal };
  });

  /*
   * An interlocked cell cannot exceed either of the single-criterion cells it sits inside. "Male 50%" and
   * "Male 18–34 60%" is a contradiction, and it is the kind that survives review because each number looks
   * reasonable on its own.
   */
  for (const cell of expanded.filter((c) => c.interlocked)) {
    for (const key of Object.keys(cell.criteria)) {
      const parent = expanded.find(
        (p) => !p.interlocked && p.dimension === key && p.criteria[key] === cell.criteria[key],
      );
      if (parent && cell.targetCompletes > parent.targetCompletes) {
        issues.push({
          severity: "error", dimension: cell.dimension,
          message: `“${cell.label}” asks for ${cell.targetCompletes.toLocaleString()} completes, more than the ${parent.targetCompletes.toLocaleString()} allowed by “${parent.label}” that contains it.`,
          cellIds: [cell.id, parent.id],
        });
      }
    }
  }

  const duplicates = new Map<string, string[]>();
  for (const c of expanded) {
    const key = JSON.stringify(Object.entries(c.criteria).sort());
    duplicates.set(key, [...(duplicates.get(key) ?? []), c.id]);
  }
  for (const [, ids] of duplicates) {
    if (ids.length > 1) {
      issues.push({
        severity: "error", dimension: "*",
        message: `Two quota cells constrain exactly the same group. One of them will never be used.`,
        cellIds: ids,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const ok = errors.length === 0;
  const statement = !cells.length
    ? "No quotas set — the sample will be filled in whatever composition arrives."
    : ok
      ? `${expanded.length} quota ${expanded.length === 1 ? "cell" : "cells"} across ${dimensions.length} ${dimensions.length === 1 ? "dimension" : "dimensions"}, all fillable.`
      : errors[0].message;

  return { cells: expanded, dimensions, issues, ok, statement };
}

/* ------------------------------------------------------------ what is still needed */

export interface QuotaProgress {
  cellId: string;
  label: string;
  dimension: string;
  target: number;
  accepted: number;
  remaining: number;
  /** 0-1 */
  fill: number;
  state: "open" | "nearly_full" | "full" | "over";
}

/**
 * How each cell is doing, for the monitor and for the allocator that has to favour the empty ones.
 *
 * `over` is reported rather than clamped. Over-recruitment happens — two respondents finish at the same
 * instant, a vendor delivers a batch late — and a monitor that cannot say so leaves somebody paying for
 * completes that were not needed.
 */
export function quotaProgress(
  plan: QuotaPlan,
  acceptedByCell: Readonly<Record<string, number>>,
): QuotaProgress[] {
  return plan.cells.map((c) => {
    const accepted = Math.max(0, acceptedByCell[c.id] ?? 0);
    const target = c.targetCompletes;
    const fill = target > 0 ? accepted / target : 0;
    return {
      cellId: c.id, label: c.label, dimension: c.dimension,
      target, accepted,
      remaining: Math.max(0, target - accepted),
      fill: round2(fill),
      state: accepted > target ? "over" : fill >= 1 ? "full" : fill >= 0.9 ? "nearly_full" : "open",
    };
  });
}

/**
 * Which cells recruitment should be steered towards.
 *
 * Ordered by how far behind they are, so the allocator fills the emptiest first. A full cell is excluded
 * entirely: continuing to recruit into it is how a project buys completes it cannot use.
 */
export function underfilledCells(progress: readonly QuotaProgress[]): QuotaProgress[] {
  return progress
    .filter((p) => p.state === "open" || p.state === "nearly_full")
    .sort((a, b) => a.fill - b.fill || b.remaining - a.remaining || a.cellId.localeCompare(b.cellId));
}
