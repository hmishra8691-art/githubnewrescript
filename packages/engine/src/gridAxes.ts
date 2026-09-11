import type { Option, Question, QuestionColumn, QuestionRow, SurveyDefinition } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";
import { authoringQuestionView } from "./carryforward.js";

/**
 * ROWS, COLUMNS, CELLS — WHAT A LOGIC REFERENCE IS ACTUALLY NAMING.
 *
 * A matrix has two axes and the model has always had two fields for them —
 * `rowCode` and `columnId` — but what lives on each axis depends on the
 * question, and only the evaluator knew it:
 *
 *   matrix_single / multi / dropdown   (per_row)
 *       rows      = the statements                      → `rowCode`
 *       columns   = THE SCALE, held in `q.options`      → `columnId` is an
 *                   OPTION CODE, not a column id
 *       a cell    = one row's answer
 *
 *   composite / custom_table           (cells)
 *       rows      = the statements                      → `rowCode`
 *       columns   = real `QuestionColumn`s, each with
 *                   its own `responseType` and options   → `columnId` is a
 *                   COLUMN ID
 *       a cell    = row × column
 *
 * `evaluate.ts` resolves both spellings correctly and always has. Everything
 * AROUND it assumed the second one:
 *
 *   · the lint validated `columnId` against `q.columns`, so the supported,
 *     tested matrix form (`columnId: "5"` = "any row rated 5") always
 *     reported "M1 has no column '5'";
 *   · the Logic Builder only drew a column picker when `q.columns.length > 0`,
 *     so on a Likert grid — the commonest grid there is — "any row rated
 *     Excellent" could not be authored at all, only hand-written;
 *   · the value picker always listed `q.options`, so a composite cell (whose
 *     scale lives on the column) fell through to a free-text box.
 *
 * This module is the one answer to "what are this question's axes, and what
 * does a reference to each one mean", so the evaluator, the lint, the builder
 * and the count editor cannot each hold a different opinion. It reads the
 * response model rather than a hand-written list of base types, because such
 * lists drift — `variants.ts` documents two bugs already caused by that.
 */

export type GridModel = "flat" | "per_row" | "cells";

export interface AxisItem {
  /** what goes in `rowCode` / `columnId` */
  ref: string;
  label: string;
}

export interface GridAxes {
  model: GridModel;
  /** true for anything with rows: a reference may name a row */
  isGrid: boolean;
  /** the statements — addressed by `rowCode` */
  rows: AxisItem[];
  /** the other axis — addressed by `columnId` */
  columns: AxisItem[];
  /**
   * WHAT `columnId` MEANS on this question. The single fact everything around
   * the evaluator was missing.
   */
  columnMeaning: "option_code" | "column_id" | "none";
  /** how to talk about the axes on screen */
  rowLabel: string;
  columnLabel: string;
}

const strip = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, "").trim();
const fromOptions = (os: Option[] | undefined): AxisItem[] => (os ?? []).map((o) => ({ ref: String(o.code), label: strip(o.label) || String(o.code) }));
const fromRows = (rs: QuestionRow[] | undefined): AxisItem[] => (rs ?? []).map((r) => ({ ref: String(r.code), label: strip(r.label) || String(r.code) }));
const fromColumns = (cs: QuestionColumn[] | undefined): AxisItem[] => (cs ?? []).map((c) => ({ ref: String(c.id), label: strip(c.label) || String(c.id) }));

/**
 * The scale of a `per_row` grid. Normally `q.options`; the renderer also
 * accepts it on `columns[0].options`, and a question written that way used to
 * show an empty value picker because nothing but the renderer knew.
 */
export function gridScaleOptions(q: Question): Option[] {
  if (q.options?.length) return q.options;
  const first = q.columns?.[0];
  return first?.options?.length ? first.options : [];
}

/** This question's axes, and what a reference to each one addresses. */
export function gridAxes(q: Question | undefined | null): GridAxes {
  if (!q) return { model: "flat", isGrid: false, rows: [], columns: [], columnMeaning: "none", rowLabel: "row", columnLabel: "column" };
  const model: GridModel =
    effectiveResponseModel(q) === "cells" ? "cells"
    : effectiveResponseModel(q) === "per_row" ? "per_row"
    : (q.rows?.length ?? 0) > 0 ? "per_row"
    : "flat";

  if (model === "cells") {
    return {
      model, isGrid: true,
      rows: fromRows(q.rows),
      columns: fromColumns(q.columns),
      columnMeaning: (q.columns?.length ?? 0) > 0 ? "column_id" : "none",
      rowLabel: "row", columnLabel: "column",
    };
  }
  if (model === "per_row") {
    const scale = gridScaleOptions(q);
    return {
      model, isGrid: true,
      rows: fromRows(q.rows),
      /* the scale IS the column axis here — and `columnId` holds one of its codes */
      columns: fromOptions(scale),
      columnMeaning: scale.length ? "option_code" : "none",
      rowLabel: "row", columnLabel: "column (scale point)",
    };
  }
  return { model, isGrid: false, rows: [], columns: [], columnMeaning: "none", rowLabel: "row", columnLabel: "column" };
}

/**
 * The values a reference may compare against, given which axes it names.
 *
 * On a flat question: the options. On a per-row grid: the scale (whichever
 * row was named — every row shares it). On a composite: the named column's
 * own options, because each column carries its own answer type and list; with
 * no column named there is no single vocabulary, so the caller gets nothing
 * and should ask for a column first.
 */
export function valueChoicesFor(
  q: Question | undefined | null,
  ref: { rowCode?: string | null; columnId?: string | null } = {},
): AxisItem[] {
  if (!q) return [];
  const axes = gridAxes(q);
  if (axes.model === "cells") {
    const col = q.columns?.find((c) => String(c.id) === String(ref.columnId));
    return fromOptions(col?.options);
  }
  if (axes.model === "per_row") return fromOptions(gridScaleOptions(q));
  return fromOptions(q.options);
}

/**
 * The same, with the design-time pipeline applied (carry-forward, list ops),
 * so the builder offers what the question will actually hold rather than only
 * what was typed into it.
 */
export function authoringValueChoicesFor(
  q: Question | undefined | null,
  def: SurveyDefinition,
  ref: { rowCode?: string | null; columnId?: string | null } = {},
): AxisItem[] {
  if (!q) return [];
  let view = q;
  try { view = authoringQuestionView(q, def) as Question; } catch { /* an unresolvable source is not a reason to offer nothing */ }
  const direct = valueChoicesFor(view, ref);
  return direct.length ? direct : valueChoicesFor(q, ref);
}

/** Is this reference addressing a cell, one axis, or the whole answer? */
export function referenceShape(
  q: Question | undefined | null,
  ref: { rowCode?: string | null; columnId?: string | null },
): "cell" | "row" | "column" | "whole" {
  const hasRow = !!(ref.rowCode && String(ref.rowCode).length);
  const hasCol = !!(ref.columnId && String(ref.columnId).length);
  void q;
  if (hasRow && hasCol) return "cell";
  if (hasRow) return "row";
  if (hasCol) return "column";
  return "whole";
}

/**
 * How a reference reads on screen: `Q5`, `Q5[Product A]`, `Q5.Excellent`,
 * `Q5[Product A].Excellent` — the unambiguous spelling the brief asks for,
 * built from the axes rather than from whichever field happened to be set.
 */
export function describeReference(
  q: Question | undefined | null,
  ref: { rowCode?: string | null; columnId?: string | null },
): string {
  if (!q) return "";
  const axes = gridAxes(q);
  const row = ref.rowCode ? axes.rows.find((r) => r.ref === String(ref.rowCode)) : null;
  const col = ref.columnId ? axes.columns.find((c) => c.ref === String(ref.columnId)) : null;
  let out = q.code;
  if (ref.rowCode) out += `[${row?.label ?? ref.rowCode}]`;
  if (ref.columnId) out += `.${col?.label ?? ref.columnId}`;
  return out;
}
