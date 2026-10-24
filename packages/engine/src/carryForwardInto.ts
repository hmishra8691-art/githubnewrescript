import type { Question, CarryForward } from "@rescript/schema";
import { shapeOf, type QuestionAxis } from "./questionShape.js";

/**
 * WHERE A CARRY-FORWARD CAN LAND, BY QUESTION TYPE (client review
 * 23/10/2026, items B47–B55).
 *
 * The Studio offered "into options / into rows / into columns" whatever the
 * target question was, so a single-select showed three destinations of which
 * two meant nothing for it, and a grid offered "options" — a list a grid does
 * not read. The review asks for the destinations to follow the type:
 *
 *   single / multi select (any shape with an option list and nothing else):
 *     ONE destination — the answer list, which researchers call the ROWS of
 *     the question. It is chosen automatically; there is nothing to pick.
 *   grid / matrix (rows and columns):
 *     Rows and Columns, nothing else.
 *   a list of fields (text list, numeric list):
 *     ONE destination — its rows (the fields).
 *
 * "Options" is no longer a visible choice anywhere. The STORED value is
 * unchanged — `carryForward.into` is still `"options" | "rows" | "columns"`,
 * every existing survey keeps working, and anything that writes the old
 * values (the JSON editor, imports, copilot actions) is normalised by
 * `normalizeCarryForwardInto` to a destination the type actually has.
 *
 * The decision is made from the SHAPE (`shapeOf`), never from how many rows
 * or options the question happens to hold right now: a grid with no rows yet
 * is still a grid, which is exactly when a programmer sets up a carry-forward
 * to fill them.
 *
 * WHAT "COLUMNS" MEANS ON A GRID. The engine applies a question-level
 * carry-forward to exactly two lists: `options` and `rows`
 * (`carrySourceOptions` / `carrySourceRows`). On a per-row grid (`matrix_*`)
 * the columns the respondent sees ARE the scale — the `options` list — so
 * "→ into columns" stores `options` there (the brand-tracker template's
 * "which brands describe each attribute" grid is exactly that). A stored
 * `into: "columns"` has never been applied by the engine at question level —
 * a column grid carries per column (`columns[].carryForward`) — so it is
 * not offered, and a survey that saved it is flagged rather than silently
 * re-routed.
 */

export type CarryForwardInto = CarryForward["into"];

export interface CarryForwardDestination {
  /** the stored value */
  value: CarryForwardInto;
  /** what the researcher reads — `→ into the answer list (rows)` for a choice question */
  label: string;
  /** one line under the control */
  hint: string;
}

const ANSWER_LIST: CarryForwardDestination = {
  value: "options",
  label: "→ into the answer list (rows)",
  hint: "The carried items become this question's answer choices — what the respondent picks from.",
};
const GRID_ROWS: CarryForwardDestination = {
  value: "rows",
  label: "→ into rows",
  hint: "The carried items become the rows (statements) of this grid.",
};
const GRID_COLUMNS: CarryForwardDestination = {
  value: "options",
  label: "→ into columns",
  hint: "The carried items become the columns of this grid — the choices offered on every row.",
};
const FIELDS: CarryForwardDestination = {
  value: "rows",
  label: "→ into the fields (rows)",
  hint: "The carried items become this question's fields — one answer box per item.",
};
const TABLE_ROWS: CarryForwardDestination = {
  value: "rows",
  label: "→ into rows",
  hint: "The carried items become the rows of this table. A table's columns each carry forward on their own (column settings).",
};

/** The destinations this question's type can take, in display order. Empty = carry-forward has nowhere to land here. */
export function carryForwardDestinations(q: Pick<Question, "type" | "variant">): CarryForwardDestination[] {
  const axes = shapeOf(q).axes as readonly QuestionAxis[];
  const hasRows = axes.includes("rows");
  const hasCols = axes.includes("columns");
  const hasOpts = axes.includes("options");
  /* a per-row grid: rows, and the scale shown as its columns (B53, B55) */
  if (hasRows && hasOpts) return [GRID_ROWS, GRID_COLUMNS];
  /* a column table (composite / custom table): rows; its columns carry per column */
  if (hasRows && hasCols) return [TABLE_ROWS];
  /* a list of fields: its rows */
  if (hasRows) return [FIELDS];
  /* a choice question: the one answer list, called rows by researchers (B51) */
  if (hasOpts) return [ANSWER_LIST];
  return [];
}

/**
 * A stored or requested `into`, made valid for this question's type — what
 * the Studio's control shows and what its one-click fix saves. A value the
 * type takes is kept as is (so every template and existing survey reads
 * exactly as before). Otherwise: "rows" asked of a choice question means its
 * answer list; "columns" asked of a per-row grid means its column choices
 * (`options`); "options" asked of a list of fields or a table means its rows.
 * With no destination at all the stored value is left alone.
 */
export function normalizeCarryForwardInto(q: Pick<Question, "type" | "variant">, into: string | undefined | null): CarryForwardInto {
  const allowed = carryForwardDestinations(q).map((d) => d.value);
  if (allowed.length === 0) return (into === "rows" || into === "columns" ? into : "options");
  if (into && (allowed as string[]).includes(into)) return into as CarryForwardInto;
  if (into === "columns" && allowed.includes("options")) return "options";
  if (into === "options" && allowed.includes("rows")) return "rows";
  if (into === "rows" && allowed.includes("options")) return "options";
  return allowed[0];
}

/** The label of the destination a stored value is read as — "→ into columns" for a grid's `options`. */
export function carryForwardDestinationLabel(q: Pick<Question, "type" | "variant">, into: string | undefined | null): string | undefined {
  const v = normalizeCarryForwardInto(q, into);
  return carryForwardDestinations(q).find((d) => d.value === v)?.label;
}

/** `true` when the type has exactly one destination, so the Studio shows it as a label instead of a dropdown. */
export function carryForwardDestinationIsFixed(q: Pick<Question, "type" | "variant">): boolean {
  return carryForwardDestinations(q).length === 1;
}
