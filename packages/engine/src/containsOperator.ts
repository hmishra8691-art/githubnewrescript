import type { ComparisonOperator, Question } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";

/**
 * WHERE "CONTAINS" BELONGS (2026-10-24, client items A46 / A48).
 *
 * `contains` is a TEXT operator: "any part of the typed answer". It is
 * offered on open-ended sources — text entry and its subtypes, Text List
 * fields, Text Matrix cells, text columns of a grid, Embedded Data strings —
 * and, under its own names, where a type has an explicit list meaning:
 * "is ranked" on a Ranking (the item appears in the ranked order) and
 * "contains text" beside "contains item" on an Embedded Data list.
 *
 * On a choice question it never meant anything of its own: on a single
 * select it was `equals`, on a multi-select or a grid it was `has selected`.
 * Those operators exist with their own words, so a stored `contains` on such
 * a question is reported as NEEDING UPDATE with the operator that says what it
 * does. It keeps evaluating exactly as before until the programmer chooses —
 * the linter WARNS (it does not block deployment, because nothing is broken),
 * the builder marks the rule and offers the replacement with one click.
 */
export interface ContainsReplacement {
  /** the operator that says what the stored `contains` does on this source */
  op: ComparisonOperator;
  /** its words in the operator menu */
  label: string;
}

/** Choice-like response models where `contains` has a clearer name. */
export function containsReplacementFor(q: Question | undefined, operator: ComparisonOperator, columnId?: string | null): ContainsReplacement | null {
  if (!q || (operator !== "contains" && operator !== "notContains")) return null;
  const negated = operator === "notContains";
  if ((q.type === "composite" || q.type === "custom_table") && columnId) {
    const col = (q.columns ?? []).find((c) => String(c.id) === String(columnId));
    switch (col?.responseType) {
      case "single": case "dropdown": case "checkbox": return negated ? { op: "ne", label: "does not equal" } : { op: "eq", label: "equals" };
      case "multi": case "multi_dropdown": return negated ? { op: "notSelected", label: "hasn't selected" } : { op: "selected", label: "has selected" };
      default: return null;
    }
  }
  switch (effectiveResponseModel(q)) {
    case "single_choice":
      return negated ? { op: "ne", label: "does not equal" } : { op: "eq", label: "equals" };
    case "multiple_choice":
      return negated ? { op: "notSelected", label: "hasn't selected" } : { op: "selected", label: "has selected" };
    case "per_row":
      if (q.type === "matrix_text" || q.type === "matrix_numeric") return null;
      return negated ? { op: "notSelected", label: "is not" } : { op: "selected", label: "is" };
    default:
      return null;
  }
}

/** Does this source offer `contains` as an operator of its own (text, or an explicit list meaning)? */
export function offersContains(q: Question | undefined, columnId?: string | null): boolean {
  if (!q) return true;
  if ((q.type === "composite" || q.type === "custom_table") && columnId) {
    const col = (q.columns ?? []).find((c) => String(c.id) === String(columnId));
    return !col || ["text", "longtext"].includes(String(col.responseType));
  }
  switch (effectiveResponseModel(q)) {
    case "text": return q.type !== "date" && q.type !== "time";
    case "interview": return true;
    case "fields": return q.type !== "numeric_list";
    case "per_row": return q.type === "matrix_text";
    case "rank_order": return true;
    default: return false;
  }
}
