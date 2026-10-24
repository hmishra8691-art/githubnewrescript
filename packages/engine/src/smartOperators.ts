import type {
  ComparisonOperator, Condition, ConditionRule, ConditionSource, Question, SurveyDefinition,
} from "@rescript/schema";
import { effectiveResponseModel, isOptionValueRef, isPipedValueRef, isQuestionValueRef } from "@rescript/schema";
import { operatorsForQuestion, sourceKindForColumn } from "./lintLogic.js";
import { gridCellOperators, isCategoricalGrid } from "./gridCell.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { allEmbeddedFields, embeddedCatalog, embeddedFieldName, effectiveEmbeddedType } from "./embedded.js";
import { detectValueType, isListText, listItems } from "./listValue.js";
import { evaluateCondition, type EvalTrace } from "./evaluate.js";
import { createResponseState } from "./state.js";
import { forEachRule } from "./conditionWalk.js";
import { stripHtmlText } from "./html.js";
import { containsReplacementFor } from "./containsOperator.js";

/**
 * SMART OPERATORS — one operator menu for every place a condition is built
 * (October 2026, document 16/10).
 *
 * The builder used to offer the same ~20 operators whatever the source was, so
 * a Single Select could be asked "contains" or "between", and an Embedded Data
 * list of ZIP codes could only be searched as text. This module answers, for
 * any condition source:
 *
 *   · WHAT it is (`operandTypeOf`) — single / multi select, numeric, text,
 *     rating (scored or label-only), single / multi / numeric / text grid,
 *     constant sum, ranking, MaxDiff, date, time, duration, file upload,
 *     boolean, list, count …;
 *   · WHICH operators fit, GROUPED (primary · count · shown · response
 *     status · list items), with the words a researcher uses for that type
 *     ("has selected any of", "is ranked at position", "is on or before"),
 *     the DEFAULT one, and what kind of comparison value each needs
 *     (`operatorMenu`);
 *   · whether a stored rule still fits its source (`operatorStatus`): a rule
 *     whose source changed type is "needs update" — never silently rewritten
 *     — and the linter refuses to deploy it;
 *   · a plain sentence for one rule (`ruleSentence`) and a way to TRY a
 *     condition against a typed test response with the real evaluator
 *     (`conditionTestInputs` / `evaluateWithTestInputs`).
 *
 * MAPPED ONTO THE EXISTING CONDITION MODEL. Almost every entry is an existing
 * operator with type-specific words: "is before" is `dateBefore`, "is on or
 * after" is `gte` on a date, "has selected any of" is `containsAny`, "number
 * selected ≥" is a COUNT source with `gte`, "row is" is the grid-cell form,
 * "chosen as most preferred in any task" is `eq` on a MaxDiff answer's `best`
 * column. New operators exist only where nothing could say it faithfully:
 * whole-item list matching and "has selected exactly" (see conditions.ts).
 *
 * VALIDITY IS STILL THE LINTER'S. An entry is shown only when its operator
 * is one `operatorsForQuestion` (or the grid-cell vocabulary) accepts, so a
 * rule built from this menu can never be a lint error; an operator the
 * linter accepts but this menu does not curate (`Q1 > 3` on a single select
 * with numeric codes) keeps evaluating exactly as before and is shown as
 * "other — still valid", not as broken.
 */

export type OperandType =
  | "single" | "multi" | "numeric" | "text" | "rating_numeric" | "rating_label"
  | "grid_single" | "grid_multi" | "grid_numeric" | "grid_text"
  | "constant_sum" | "ranking" | "maxdiff" | "date" | "time" | "duration" | "file"
  | "boolean" | "list" | "count" | "named" | "any";

/** What the comparison-value control is for an operator. */
export type ValueKind =
  | "none"        // answered / is empty / is true …
  | "option"      // one option (a dropdown of the source's options when it has some)
  | "options"     // several options (a multi-option selector)
  | "cell"        // a grid answer column (row + column, no value)
  | "number" | "numberRange"
  | "numberList"  // several numbers, separated by commas ("is in list" on a numeric source)
  | "text" | "textList"
  | "items"       // list items: one, or several separated by commas
  | "date" | "dateRange" | "time" | "timeRange"
  | "rank";       // an item and a rank position

export type OperatorGroupId = "primary" | "count" | "items" | "display" | "status" | "other";

export const OPERATOR_GROUP_LABEL: Record<OperatorGroupId, string> = {
  primary: "Operators",
  count: "Count",
  items: "List items",
  display: "Shown to the respondent",
  status: "Response status",
  other: "Other — still valid",
};

export interface OperatorEntry {
  /** the value of the menu choice: the operator itself, or `count:gte`, `isTrue`, `best:eq` … */
  id: string;
  op: ComparisonOperator;
  label: string;
  group: OperatorGroupId;
  value: ValueKind;
  hint?: string;
  /** what choosing this entry writes besides the operator */
  preset?: {
    value?: unknown;
    /** a COUNT source (`count:*` entries) */
    count?: { of: "selected"; scope: "options" | "rows" };
    /** MaxDiff: which column of a task is read */
    columnId?: string;
  };
}

export interface OperatorMenu {
  type: OperandType;
  /** "Single select", "Embedded data — list" … */
  typeLabel: string;
  entries: OperatorEntry[];
  groups: { id: OperatorGroupId; label: string; entries: OperatorEntry[] }[];
  defaultEntry: OperatorEntry | undefined;
  /** the second axis to pick: a grid row, a constant-sum field, a MaxDiff task */
  rowSelector: false | "row" | "field" | "task";
}

const TYPE_LABEL: Record<OperandType, string> = {
  single: "Single select", multi: "Multi select", numeric: "Number", text: "Text",
  rating_numeric: "Rating (scored)", rating_label: "Rating (labels)",
  grid_single: "Single-select grid", grid_multi: "Multi-select grid", grid_numeric: "Numeric grid", grid_text: "Text grid",
  constant_sum: "Constant sum", ranking: "Ranking", maxdiff: "MaxDiff", date: "Date", time: "Time",
  duration: "Duration", file: "File upload", boolean: "True / false", list: "List", count: "Count",
  named: "Named expression", any: "Value",
};

const RATING_VARIANT = /(?:^|\.)(?:stars|emoji|likelihood|nps|heart_rating|rating|likert|semantic|star_matrix|discrete_slider|discrete)$/;
const isNumericCode = (c: unknown) => /^-?\d+(?:\.\d+)?$/.test(String(c ?? "").trim());

/** A rating question: a star / emoji / NPS / Likert scale, scored or label-only. */
function ratingKind(q: Question): "rating_numeric" | "rating_label" | null {
  const isRating = q.type === "nps" || RATING_VARIANT.test(String(q.variant ?? ""));
  if (!isRating) return null;
  const codes = (q.options ?? []).map((o) => o.code);
  return codes.length === 0 || codes.every(isNumericCode) ? "rating_numeric" : "rating_label";
}

/** The static value an embedded field is given in the flow (fixed value or default), if any. */
function embeddedAuthoredValue(def: SurveyDefinition, name: string): string | undefined {
  for (const f of allEmbeddedFields(def)) {
    if (embeddedFieldName(f) !== name) continue;
    const v = f.source === "static" ? f.value : f.defaultValue;
    if (v != null && String(v).trim() !== "") return String(v);
  }
  const reg = def.embeddedData.find((e) => embeddedFieldName(e) === name);
  return reg?.defaultValue ?? undefined;
}

/** What kind of value an embedded field holds: its declared type, or a list when its authored value is one. */
export function embeddedOperandType(def: SurveyDefinition, name: string): OperandType {
  let declared = embeddedCatalog(def).find((e) => e.name === name)?.dataType as string | undefined;
  if (declared === "list") return "list";
  if (declared === "auto") {
    /* Auto: read for what its authored value is (FLOW's detection) */
    const v = embeddedAuthoredValue(def, name);
    const d = v === undefined ? "string" : detectValueType(v);
    declared = d === "integer" || d === "decimal" ? "integer" : d === "list" ? "list" : d === "boolean" ? "boolean" : d === "date" || d === "datetime" ? "date" : "string";
    if (declared === "list") return "list";
  }
  if (declared === "integer" || declared === "decimal") return "numeric";
  if (declared === "boolean") return "boolean";
  if (declared === "date" || declared === "datetime") return "date";
  const authored = embeddedAuthoredValue(def, name);
  if (authored !== undefined && isListText(authored)) return "list";
  return "text";
}

/**
 * Does `contains` on this source match whole ITEMS? True for an Embedded Data
 * field whose type is LIST (declared "list", or "auto" holding a list) — see
 * evaluate.ts. Every other source keeps `contains` as text / membership.
 */
export function containsMatchesItems(def: SurveyDefinition, source: ConditionSource): boolean {
  if (source.count) return false;
  const name = source.kind === "embedded" ? source.ref
    : (source.kind === "question" || source.kind === "variable") && !getQuestionByCodeOrVar(def, source.ref) ? source.ref : null;
  if (!name || !embeddedCatalog(def).some((e) => e.name === name)) return false;
  return effectiveEmbeddedType(def, name, embeddedAuthoredValue(def, name)) === "list";
}

/** The type of the value a condition source reads. */
export function operandTypeOf(def: SurveyDefinition, source: ConditionSource): OperandType {
  if (source.count) return "count";
  switch (source.kind) {
    case "rule": return "named";
    case "embedded": return embeddedOperandType(def, source.ref);
    case "quota": return "numeric";
    case "expr": return "any";
    case "calculation": return "any";
    case "option": return source.ref === "index" ? "numeric" : source.ref === "value" ? "any" : "text";
    case "loop": {
      const r = source.ref || "code";
      if (r === "index" || r === "count") return "numeric";
      if (r === "first" || r === "last") return "boolean";
      return "text";
    }
    default: break;
  }
  const q = getQuestionByCodeOrVar(def, source.ref);
  if (!q) {
    /* a bare name the evaluator also resolves against embedded data */
    if (embeddedCatalog(def).some((e) => e.name === source.ref)) return embeddedOperandType(def, source.ref);
    return "any";
  }
  return questionOperandType(q, source.columnId);
}

export function questionOperandType(q: Question, columnId?: string | null): OperandType {
  if (columnId && (q.type === "composite" || q.type === "custom_table")) {
    const col = q.columns?.find((c) => String(c.id) === String(columnId));
    if (col) {
      switch (sourceKindForColumn(col)) {
        case "choice": return "single";
        case "list": return "multi";
        case "numeric": return "numeric";
        case "date": return "date";
        case "text": return "text";
        case "ranking": return "ranking";
        default: return "any";
      }
    }
  }
  const model = effectiveResponseModel(q);
  const variant = String(q.variant ?? "");
  switch (model) {
    case "single_choice": return ratingKind(q) ?? "single";
    case "multiple_choice": return "multi";
    case "rank_order": return "ranking";
    case "numeric":
      if (/duration/.test(variant)) return "duration";
      return ratingKind(q) ?? "numeric";
    case "allocation": return "constant_sum";
    case "text":
      if (q.type === "date") return "date";
      if (q.type === "time") return "time";
      return "text";
    case "interview": return "text";
    case "fields": return q.type === "numeric_list" ? "grid_numeric" : "grid_text";
    case "per_row":
      if (q.type === "matrix_multi") return "grid_multi";
      if (q.type === "matrix_numeric") return "grid_numeric";
      if (q.type === "matrix_text") return "grid_text";
      return "grid_single";
    case "tasks": return q.type === "maxdiff_task" ? "maxdiff" : "any";
    case "media": return q.type === "upload" ? "file" : "any";
    default: return "any";
  }
}

/* ------------------------------------------------------------------ menus */

type E = OperatorEntry;
const e = (op: ComparisonOperator, label: string, group: OperatorGroupId, value: ValueKind, extra: Partial<E> = {}): E =>
  ({ id: extra.id ?? op, op, label, group, value, ...extra });

const STATUS: E[] = [
  e("answered", "is answered", "status", "none"),
  e("unanswered", "is unanswered", "status", "none"),
];
const DISPLAY: E[] = [
  /* the exact words the builder has always used — the browser suites read them */
  e("displayed", "option is displayed", "display", "option", { hint: "The option was on the respondent's screen, selected or not" }),
  e("notDisplayed", "option is not displayed", "display", "option"),
];
const MULTI_VALUE_NOTE = "Several values separated by commas (\"25, 26, 27\") are read one by one: every value must satisfy it.";
const NUMERIC = (v: ValueKind = "number", r: ValueKind = "numberRange"): E[] => [
  e("eq", "= equals", "primary", v),
  e("ne", "≠ does not equal", "primary", v),
  e("gt", "> is greater than", "primary", v),
  e("gte", "≥ is at least", "primary", v),
  e("lt", "< is less than", "primary", v),
  e("lte", "≤ is at most", "primary", v),
  e("between", "is between", "primary", r, { hint: `Inclusive: both ends count. ${MULTI_VALUE_NOTE}` }),
  e("notBetween", "is not between", "primary", r, { hint: "Outside the range, both ends excluded. A comma-separated answer must have NO value in the range." }),
];
/*
 * "IS IN LIST" ON A NUMBER (2026-10-24, client item A48 §3C): a list of
 * individual allowed values — 1, 5, 10, 25, 50, 100 — distinct from a range.
 * `in` has always been valid on a numeric source; it was offered nowhere.
 */
const NUMBER_LIST: E[] = [
  e("in", "is in list", "primary", "numberList", { hint: `The answer is one of these values, exactly — 25 matches "1, 5, 10, 25", 26 does not. ${MULTI_VALUE_NOTE}` }),
  e("notIn", "is not in list", "primary", "numberList", { hint: "None of these values. A comma-separated answer must have NO value in the list." }),
];
const TEXT: E[] = [
  e("eq", "equals", "primary", "text"),
  e("ne", "does not equal", "primary", "text"),
  e("contains", "contains text", "primary", "text", { hint: "Contains TEXT: any part of the answer, ignoring case — \"blue\" matches \"Light blue\". For a number or a range use “is in list” or “is between”." }),
  e("notContains", "does not contain text", "primary", "text"),
  e("startsWith", "starts with", "primary", "text"),
  e("endsWith", "ends with", "primary", "text"),
  e("in", "is in list", "primary", "textList", { hint: `The whole answer equals one of the values — a typed ZIP in a list of ZIPs; 26 is not in "1, 5, 10, 25". ${MULTI_VALUE_NOTE}` }),
  e("notIn", "is not in list", "primary", "textList", { hint: "The answer is none of these values. A comma-separated answer must have NO value in the list." }),
  /*
   * A TYPED NUMBER'S RANGE (2026-10-24, client item A48): "Enter a number
   * between 1 and 100" is usually a text box, and the range test belongs on
   * it. The comparison is numeric, inclusive, value by value.
   */
  e("between", "is between (numbers)", "primary", "numberRange", { hint: `Reads the answer as a number: inclusive, both ends count — 100 is between 1 and 100, 150 is not, and text that is not a number never is. ${MULTI_VALUE_NOTE}` }),
  e("notBetween", "is not between (numbers)", "primary", "numberRange", { hint: "Reads the answer as a number, outside the range. A comma-separated answer must have NO value in the range." }),
  e("matches", "matches pattern (regex)", "primary", "text"),
];
const ITEMS_HINT = "Contains ITEM: whole items of a comma-separated list, ignoring spaces and case — 10001 never matches 110001. A list of items matches when ANY of them is in the list.";
const ITEMS: E[] = [
  e("containsItem", "contains item", "items", "items", { hint: ITEMS_HINT }),
  e("notContainsItem", "does not contain item", "items", "items", { hint: "None of the items is in the list" }),
  e("containsAllItems", "contains all of", "items", "items", { hint: "Every item is in the list" }),
];
const COUNT_ENTRIES = (scope: "options" | "rows", noun: string): E[] => (
  [["eq", "="], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"]] as [ComparisonOperator, string][]
).map(([op, sym]) => e(op, `${noun} ${sym}`, "count", "number", { id: `count:${op}`, preset: { count: { of: "selected", scope } } }));

/** The curated entries for an operand type, before validity filtering. */
function entriesFor(type: OperandType, q: Question | undefined): { entries: E[]; defaultId: string; rowSelector: OperatorMenu["rowSelector"] } {
  const numericScale = !!q && (q.options ?? []).length > 0 && (q.options ?? []).every((o) => isNumericCode(o.code));
  switch (type) {
    case "single":
    case "rating_label":
      return {
        entries: [
          e("eq", "equals", "primary", "option"),
          e("ne", "does not equal", "primary", "option"),
          e("in", "is any of", "primary", "options"),
          e("notIn", "is none of", "primary", "options"),
          ...DISPLAY, ...STATUS,
        ],
        defaultId: "eq", rowSelector: false,
      };
    case "rating_numeric": {
      const v: ValueKind = (q?.options ?? []).length ? "option" : "number";
      return {
        entries: [...NUMERIC(v, "numberRange"), e("in", "is any of", "primary", (q?.options ?? []).length ? "options" : "textList"), e("notIn", "is none of", "primary", (q?.options ?? []).length ? "options" : "textList"), ...STATUS],
        defaultId: "eq", rowSelector: false,
      };
    }
    case "multi":
      return {
        entries: [
          e("selected", "has selected", "primary", "option"),
          e("notSelected", "hasn't selected", "primary", "option"),
          e("containsAny", "has selected any of", "primary", "options"),
          e("containsAll", "has selected all of", "primary", "options"),
          e("containsNone", "has selected none of", "primary", "options"),
          e("containsExactly", "has selected exactly", "primary", "options", { hint: "These options and no others, in any order" }),
          ...COUNT_ENTRIES("options", "number selected"),
          ...DISPLAY, ...STATUS,
        ],
        defaultId: "selected", rowSelector: false,
      };
    case "numeric":
      return { entries: [...NUMERIC(), ...NUMBER_LIST, ...STATUS], defaultId: "eq", rowSelector: false };
    case "duration":
      return { entries: [...NUMERIC(), ...STATUS], defaultId: "eq", rowSelector: false };
    case "text":
      return { entries: [...TEXT, ...STATUS], defaultId: "eq", rowSelector: false };
    case "grid_single":
      return {
        entries: [
          /* "is / is not" are the words the grid builder has always used (the matrix browser suite reads them) */
          e("selected", "is", "primary", "cell", { hint: "Pick a row and an answer; \"any row\" means at least one row has that answer" }),
          e("notSelected", "is not", "primary", "cell"),
          e("in", "is any of", "primary", "options"),
          e("notIn", "is none of", "primary", "options"),
          ...(numericScale ? NUMERIC("option", "numberRange").filter((x) => x.op !== "eq" && x.op !== "ne") : []),
          e("displayed", "row is displayed", "display", "option"),
          e("notDisplayed", "row is not displayed", "display", "option"),
          ...STATUS,
        ],
        defaultId: "selected", rowSelector: "row",
      };
    case "grid_multi":
      return {
        entries: [
          e("selected", "has selected", "primary", "cell"),
          e("notSelected", "hasn't selected", "primary", "cell"),
          e("containsAny", "has selected any of", "primary", "options"),
          e("containsAll", "has selected all of", "primary", "options"),
          e("containsNone", "has selected none of", "primary", "options"),
          e("displayed", "row is displayed", "display", "option"),
          e("notDisplayed", "row is not displayed", "display", "option"),
          ...STATUS,
        ],
        defaultId: "selected", rowSelector: "row",
      };
    case "grid_numeric":
      return { entries: [...NUMERIC(), ...NUMBER_LIST, ...STATUS], defaultId: "eq", rowSelector: "row" };
    case "grid_text":
      return { entries: [...TEXT, ...STATUS], defaultId: "eq", rowSelector: "row" };
    case "constant_sum":
      return {
        entries: [...NUMERIC(), ...NUMBER_LIST, ...STATUS],
        defaultId: "eq", rowSelector: "field",
      };
    case "ranking":
      return {
        entries: [
          e("rankEquals", "is ranked at position", "primary", "rank"),
          e("rankLessThan", "is ranked above position", "primary", "rank", { hint: "A better (smaller) rank than the position" }),
          e("rankGreaterThan", "is ranked below position", "primary", "rank"),
          e("rankedFirst", "is ranked first", "primary", "option"),
          e("rankedLast", "is ranked last", "primary", "option"),
          e("rankedTopN", "is in the top", "primary", "rank"),
          e("contains", "is ranked", "primary", "option", { hint: "The item was ranked at all" }),
          e("notRanked", "is not ranked", "primary", "option"),
          ...DISPLAY, ...STATUS,
        ],
        defaultId: "rankEquals", rowSelector: false,
      };
    case "maxdiff":
      return {
        entries: [
          e("eq", "was chosen as most preferred", "primary", "option", { id: "best:eq", preset: { columnId: "best" } }),
          e("ne", "was not chosen as most preferred", "primary", "option", { id: "best:ne", preset: { columnId: "best" } }),
          e("eq", "was chosen as least preferred", "primary", "option", { id: "worst:eq", preset: { columnId: "worst" } }),
          e("ne", "was not chosen as least preferred", "primary", "option", { id: "worst:ne", preset: { columnId: "worst" } }),
          ...STATUS,
        ],
        defaultId: "best:eq", rowSelector: "task",
      };
    case "date":
      return {
        entries: [
          e("dateEquals", "is on", "primary", "date"),
          e("ne", "is not on", "primary", "date"),
          e("dateBefore", "is before", "primary", "date"),
          e("dateAfter", "is after", "primary", "date"),
          e("lte", "is on or before", "primary", "date"),
          e("gte", "is on or after", "primary", "date"),
          e("dateBetween", "is between", "primary", "dateRange"),
          e("notBetween", "is not between", "primary", "dateRange"),
          ...STATUS,
        ],
        defaultId: "dateEquals", rowSelector: false,
      };
    case "time":
      return {
        entries: [
          e("eq", "is at", "primary", "time"),
          e("ne", "is not at", "primary", "time"),
          e("lt", "is before", "primary", "time"),
          e("gt", "is after", "primary", "time"),
          e("between", "is between", "primary", "timeRange"),
          e("notBetween", "is not between", "primary", "timeRange"),
          ...STATUS,
        ],
        defaultId: "eq", rowSelector: false,
      };
    case "file":
      return {
        entries: [
          e("answered", "has uploaded a file", "primary", "none"),
          e("unanswered", "has not uploaded a file", "primary", "none"),
        ],
        defaultId: "answered", rowSelector: false,
      };
    case "boolean":
      return {
        entries: [
          e("eq", "is true", "primary", "none", { id: "isTrue", preset: { value: true } }),
          e("eq", "is false", "primary", "none", { id: "isFalse", preset: { value: false } }),
          e("answered", "is set", "status", "none"),
          e("unanswered", "is not set", "status", "none"),
        ],
        defaultId: "isTrue", rowSelector: false,
      };
    case "list":
      return {
        entries: [
          ...ITEMS.map((x) => ({ ...x, group: "primary" as const })),
          e("containsExactly", "is exactly", "primary", "items", { hint: "The same items and no others, in any order" }),
          e("isEmpty", "is empty", "status", "none"),
          e("isNotEmpty", "is not empty", "status", "none"),
          e("contains", "contains text", "items", "text", { hint: "Contains TEXT: any part of the stored text — \"1000\" matches \"10001\". Use “contains item” for list entries." }),
          e("notContains", "does not contain text", "items", "text"),
          e("eq", "equals (the whole list)", "items", "text"),
          e("ne", "does not equal (the whole list)", "items", "text"),
        ],
        defaultId: "containsItem", rowSelector: false,
      };
    case "count":
      return {
        entries: (["eq", "ne", "gt", "gte", "lt", "lte", "between"] as ComparisonOperator[]).map((op) =>
          e(op, op === "between" ? "is between" : NUMERIC().find((x) => x.op === op)!.label, "primary", op === "between" ? "numberRange" : "number")),
        defaultId: "gte", rowSelector: false,
      };
    case "named":
      return { entries: [e("eq", "is true", "primary", "none", { id: "isTrue", preset: { value: true } }), e("eq", "is false", "primary", "none", { id: "isFalse", preset: { value: false } })], defaultId: "isTrue", rowSelector: false };
    case "any":
    default:
      return {
        entries: [
          ...NUMERIC("text", "numberRange").map((x) => (x.op === "eq" || x.op === "ne" ? { ...x, label: x.op === "eq" ? "= equals" : "≠ does not equal" } : x)),
          ...TEXT.filter((x) => !["eq", "ne", "between", "notBetween"].includes(x.op)),
          ...ITEMS,
          e("isEmpty", "is empty", "status", "none"),
          e("isNotEmpty", "is not empty", "status", "none"),
          ...STATUS,
        ],
        defaultId: "eq", rowSelector: false,
      };
  }
}

/** Operators the linter accepts for this source — the validity the menu is filtered by. */
export function validOperatorsFor(def: SurveyDefinition, source: ConditionSource): Set<ComparisonOperator> | null {
  if (source.count) return new Set(["eq", "ne", "gt", "gte", "lt", "lte", "between", "notBetween", "in", "notIn"]);
  if (source.kind !== "question" && source.kind !== "variable") return null;
  const q = getQuestionByCodeOrVar(def, source.ref);
  if (!q) return null;
  return new Set<ComparisonOperator>([...operatorsForQuestion(q, source.columnId), ...gridCellOperators(q)]);
}

/** Operators that mean nothing for an embedded field — a field is never ranked, and is never "displayed". */
export const EMBEDDED_MEANINGLESS: ComparisonOperator[] = [
  "rankedFirst", "rankedLast", "rankedTopN", "rankEquals", "rankGreaterThan", "rankLessThan", "notRanked",
  "displayed", "notDisplayed",
];

/**
 * THE operator menu for a condition source. Every builder calls this — display,
 * skip, branch, flow, quota, validation, auto-punch, masking `when`, option
 * logic, loops, piping conditions — so the same source offers the same
 * operators everywhere. `exclude` lets one feature narrow it further.
 */
export function operatorMenu(
  def: SurveyDefinition,
  source: ConditionSource,
  opts: { exclude?: ComparisonOperator[] } = {},
): OperatorMenu {
  const type = operandTypeOf(def, source);
  const q = source.kind === "question" || source.kind === "variable" ? getQuestionByCodeOrVar(def, source.ref) : undefined;
  const base = entriesFor(type, q);
  const valid = validOperatorsFor(def, source);
  /* on a LIST-typed field `contains` already means "contains item": not offered twice under a wrong name */
  const itemContains = type === "list" && containsMatchesItems(def, source);
  const entries = base.entries.filter((x) =>
    !(itemContains && (x.op === "contains" || x.op === "notContains"))
    && (x.group === "count" || !valid || valid.has(x.op))
    && !(opts.exclude ?? []).includes(x.op)
    && !(source.kind === "embedded" && EMBEDDED_MEANINGLESS.includes(x.op)));
  const order: OperatorGroupId[] = ["primary", "items", "count", "display", "status", "other"];
  const groups = order
    .map((id) => ({ id, label: OPERATOR_GROUP_LABEL[id], entries: entries.filter((x) => x.group === id) }))
    .filter((g) => g.entries.length > 0);
  const defaultEntry = entries.find((x) => x.id === base.defaultId) ?? entries[0];
  let typeLabel = TYPE_LABEL[type];
  if (source.kind === "embedded") typeLabel = `Embedded data — ${typeLabel.toLowerCase()}`;
  return { type, typeLabel, entries, groups, defaultEntry, rowSelector: base.rowSelector };
}

/** Which menu entry a stored rule is — by operator, plus what the entry presets. */
export function entryForRule(menu: OperatorMenu, rule: ConditionRule): OperatorEntry | undefined {
  const counting = !!rule.source.count;
  return menu.entries.find((x) => {
    if (x.op !== rule.operator) return false;
    if (x.preset?.count) return counting;
    if (menu.type !== "count" && counting) return false;
    if (x.preset?.columnId !== undefined) return String(rule.source.columnId ?? "") === x.preset.columnId;
    if (x.preset && "value" in x.preset) return rule.value === x.preset.value || String(rule.value) === String(x.preset.value);
    return true;
  });
}

const VALUELESS_KINDS: ValueKind[] = ["none", "cell"];

/**
 * The rule with this entry chosen. The comparison value is kept when the new
 * entry takes the same kind of value (switching = to ≠ keeps "Tea"), and
 * cleared when it does not (a single option is not a list, a date is not a
 * rank) — the builder then shows the control the new operator needs.
 */
export function applyOperatorEntry(rule: ConditionRule, entry: OperatorEntry, prev?: OperatorEntry): ConditionRule {
  let source: ConditionSource = { ...rule.source };
  if (entry.preset?.count) source = { ...source, count: { ...entry.preset.count } as never };
  else if (source.count && entry.group !== "count" && prev?.group === "count") {
    const { count: _c, ...rest } = source; source = rest as ConditionSource;
  }
  if (entry.preset?.columnId !== undefined) source = { ...source, columnId: entry.preset.columnId };
  const sameKind = !!prev && prev.value === entry.value && !VALUELESS_KINDS.includes(entry.value);
  const next: ConditionRule = { ...rule, source, operator: entry.op };
  if (entry.preset && "value" in entry.preset) { next.value = entry.preset.value; next.value2 = undefined; return next; }
  if (VALUELESS_KINDS.includes(entry.value)) { next.value = undefined; next.value2 = undefined; return next; }
  if (!sameKind) {
    next.value = entry.value === "options" || entry.value === "textList" || entry.value === "numberList" ? [] : entry.value === "number" && entry.group === "count" ? 1 : "";
    next.value2 = undefined;
  }
  return next;
}

/**
 * The rule with its `contains` replaced by the operator that names what it
 * does (`operatorStatus().replacement`). The source and the value are kept —
 * `contains "2"` on a single select becomes `eq "2"`, `contains "a"` on a
 * multi-select `selected "a"` — so the rule evaluates exactly as it did.
 */
export function applyContainsReplacement(rule: ConditionRule, replacement: OperatorEntry): ConditionRule {
  return { ...rule, operator: replacement.op };
}

export interface OperatorStatus {
  /** ok: offered for this source · other: not offered but still valid, evaluates as before · needsUpdate: cannot be evaluated against this source any more, or (with `replacement`) has an operator that says what it does */
  status: "ok" | "other" | "needsUpdate";
  message?: string;
  /**
   * `contains` on a choice source (2026-10-24): the rule still evaluates as it
   * always did, and this menu entry is the operator that names it — "equals"
   * on a single select, "has selected" on a multi-select or grid. The builder
   * applies it on one click, keeping the value; the linter warns rather than
   * blocks, because nothing is broken.
   */
  replacement?: OperatorEntry;
}

/** Does this stored rule still fit its source? Never changes the rule. */
export function operatorStatus(def: SurveyDefinition, rule: ConditionRule): OperatorStatus {
  if (rule.source.kind === "rule") return { status: "ok" };
  const menu = operatorMenu(def, rule.source);
  const valid = validOperatorsFor(def, rule.source);
  const meaningless = rule.source.kind === "embedded" && EMBEDDED_MEANINGLESS.includes(rule.operator);
  if ((valid && !valid.has(rule.operator)) || meaningless) {
    return {
      status: "needsUpdate",
      message: `“${rule.operator}” cannot be used with this ${menu.typeLabel.toLowerCase()} source — its type changed. Choose one of the operators it offers.`,
    };
  }
  const entry = entryForRule(menu, rule);
  if (!entry && (rule.operator === "contains" || rule.operator === "notContains") && (rule.source.kind === "question" || rule.source.kind === "variable")) {
    const q = getQuestionByCodeOrVar(def, rule.source.ref);
    const rep = containsReplacementFor(q, rule.operator, rule.source.columnId);
    const replacement = rep ? menu.entries.find((x) => x.op === rep.op && !x.preset?.count && x.value !== "cell") ?? menu.entries.find((x) => x.op === rep.op) : undefined;
    if (rep) {
      return {
        status: "needsUpdate",
        replacement,
        message: `“${rule.operator === "contains" ? "contains" : "does not contain"}” is a text operator — on this ${menu.typeLabel.toLowerCase()} it means “${rep.label}”. It still evaluates as before; choose “${rep.label}” to say so.`,
      };
    }
  }
  return entry ? { status: "ok" } : { status: "other" };
}

/* ------------------------------------------------------------ sentences */

const strip = (s: unknown) => stripHtmlText(String(s ?? ""));

function sourceName(def: SurveyDefinition, source: ConditionSource): string {
  if (source.kind === "embedded") return source.ref;
  if (source.kind === "calculation") return source.ref;
  if (source.kind === "loop") return `loop ${source.ref}`;
  if (source.kind === "option") return `this option's ${source.ref || "code"}`;
  if (source.kind === "quota") return `quota ${source.ref}`;
  if (source.kind === "expr") return source.ref;
  const q = getQuestionByCodeOrVar(def, source.ref);
  let name = q?.code ?? source.ref ?? "?";
  if (source.rowCode != null && q) {
    const row = (q.rows ?? []).find((r) => String(r.code) === String(source.rowCode)) ?? (q.options ?? []).find((o) => String(o.code) === String(source.rowCode));
    name += q.type === "maxdiff_task" ? ` task ${source.rowCode}` : ` “${strip(row?.label) || source.rowCode}”`;
  } else if (source.rowCode == null && q && ["grid_single", "grid_multi", "grid_numeric", "grid_text"].includes(questionOperandType(q)) && !source.count) {
    name += " (any row)";
  }
  return name;
}

function valueWords(def: SurveyDefinition, source: ConditionSource, v: unknown, joiner = "or"): string {
  if (isOptionValueRef(v)) return "this option";
  if (isPipedValueRef(v)) return `the piped value ${v.$pipe}`;
  if (isQuestionValueRef(v)) {
    const rq = getQuestionByCodeOrVar(def, v.$question);
    return `the answer to ${rq?.code ?? (v.$question || "…")}`;
  }
  const q = source.kind === "question" || source.kind === "variable" ? getQuestionByCodeOrVar(def, source.ref) : undefined;
  const one = (x: unknown) => {
    const o = q ? [...(q.options ?? []), ...(q.rows ?? [])].find((y) => String(y.code) === String(x)) : undefined;
    return `“${o ? strip(o.label) || String(x) : String(x)}”`;
  };
  const list = Array.isArray(v) ? v.filter((x) => x !== "" && x != null) : typeof v === "string" && isListText(v) ? listItems(v) : v === "" || v == null ? [] : [v];
  if (!list.length) return "…";
  if (list.length === 1) return one(list[0]);
  return `${list.slice(0, -1).map(one).join(", ")} ${joiner} ${one(list[list.length - 1])}`;
}

/**
 * One rule in plain words, as the builder prints it under the rule:
 * "the respondent selects “Tea” or “Coffee” at Q1",
 * "ZIP_Code_DMA contains the item “10005”".
 */
export function ruleSentence(def: SurveyDefinition, rule: ConditionRule): string {
  const s = rule.source;
  if (s.kind === "rule") return `${s.ref} is ${rule.value === false ? "false" : "true"}`;
  const menu = operatorMenu(def, s);
  const entry = entryForRule(menu, rule);
  const name = sourceName(def, s);
  const v = rule.value;
  const choice = ["single", "rating_label", "multi"].includes(menu.type) && !s.count;
  if (choice) {
    switch (rule.operator) {
      case "eq": case "selected": return `the respondent selects ${valueWords(def, s, v)} at ${name}`;
      case "ne": case "notSelected": return `the respondent does not select ${valueWords(def, s, v)} at ${name}`;
      case "in": case "containsAny": return `the respondent selects ${valueWords(def, s, v)} at ${name}`;
      case "notIn": case "containsNone": return `the respondent selects none of ${valueWords(def, s, v)} at ${name}`;
      case "containsAll": return `the respondent selects all of ${valueWords(def, s, v, "and")} at ${name}`;
      case "containsExactly": return `the respondent selects exactly ${valueWords(def, s, v, "and")} at ${name}`;
      default: break;
    }
  }
  if (s.count) return `the number selected at ${name} ${(entry?.label ?? rule.operator).replace(/^[=≠><≥≤] /, "")}${rule.operator === "between" ? ` ${String(v ?? "…")} and ${String(rule.value2 ?? "…")}` : ` ${String(v ?? "…")}`}`;
  const label = entry?.label.replace(/^[=≠><≥≤] /, "") ?? rule.operator;
  if (!entry || entry.value === "none") return `${name} ${label}`;
  if (entry.value === "cell") {
    const q = getQuestionByCodeOrVar(def, s.ref);
    const col = (q?.options ?? []).find((o) => String(o.code) === String(s.columnId));
    return `${name} ${label} “${col ? strip(col.label) : s.columnId ?? "…"}”`;
  }
  if (entry.value === "numberRange" || entry.value === "dateRange" || entry.value === "timeRange") {
    return `${name} ${label} ${String(v ?? "…")} and ${String(rule.value2 ?? "…")}`;
  }
  if (entry.value === "rank") return rule.operator === "rankedTopN"
    ? `${valueWords(def, s, v)} ${label} ${String(rule.value2 ?? "N")} at ${name}`
    : `${valueWords(def, s, v)} ${label} ${String(rule.value2 ?? "…")} at ${name}`;
  if (["number", "date", "time"].includes(entry.value) && !isQuestionValueRef(v) && !isPipedValueRef(v) && !(menu.type === "rating_numeric" && (getQuestionByCodeOrVar(def, s.ref)?.options ?? []).length)) {
    return `${name} ${label} ${v === "" || v == null ? "…" : String(v)}`;
  }
  if (menu.type === "ranking") return `${valueWords(def, s, v)} ${label} at ${name}`;
  if (menu.type === "maxdiff") return `${valueWords(def, s, v)} ${label} in ${s.rowCode != null ? `task ${s.rowCode}` : "any task"} of ${getQuestionByCodeOrVar(def, s.ref)?.code ?? s.ref}`;
  const joiner = rule.operator === "containsAllItems" || rule.operator === "containsExactly" ? "and" : "or";
  const words = rule.operator === "containsItem" && listItems(Array.isArray(v) ? v.join(",") : v).length > 1
    ? `any of the items ${valueWords(def, s, v, joiner)}`
    : rule.operator === "containsItem" || rule.operator === "notContainsItem" ? `the item${listItems(Array.isArray(v) ? v.join(",") : v).length > 1 ? "s" : ""} ${valueWords(def, s, v, joiner)}`
      : valueWords(def, s, v, joiner);
  return `${name} ${label.replace(/ item$/, "")} ${words}`;
}

/**
 * A whole condition as one sentence, from `ruleSentence`:
 * "the respondent selects “Tea” or “Coffee” at Q1 and Q3 is at least 18".
 * With `purpose` it reads as the rule it is: "Display Q4 if the respondent
 * selects “Tea” or “Coffee” at Q1."
 */
export function conditionSentence(def: SurveyDefinition, c: Condition | undefined | null, purpose?: string): string {
  const walk = (n: Condition, top: boolean): string => {
    if (n.type === "rule") return ruleSentence(def, n);
    const kids = (n.children ?? []).filter((k) => k.type === "rule" || (k.children ?? []).length > 0).map((k) => walk(k, false));
    if (!kids.length) return "";
    if (n.op === "not") return kids.length === 1 ? `it is not true that ${kids[0]}` : `none of these hold: ${kids.join("; ")}`;
    const s = kids.join(n.op === "and" ? " and " : " or ");
    return top || kids.length === 1 ? s : `(${s})`;
  };
  if (!c) return "";
  const body = walk(c, true);
  if (!body) return "";
  return purpose ? `${purpose} ${body}.` : body;
}

/* ------------------------------------------------------- test a condition */

export interface ConditionTestInput {
  /** stable key for the input: `q:<id>`, `q:<id>[<row>]`, `embedded:<name>`, `calculation:<name>` */
  key: string;
  label: string;
  type: OperandType;
  /** how to type the answer */
  hint: string;
  /** codes the answer can hold, for a choice question */
  choices?: { code: string; label: string }[];
}

function inputKey(def: SurveyDefinition, s: ConditionSource): string | null {
  if (s.kind === "embedded" || s.kind === "calculation") return `${s.kind}:${s.ref}`;
  if (s.kind === "question" || s.kind === "variable") {
    const q = getQuestionByCodeOrVar(def, s.ref);
    if (!q) return embeddedCatalog(def).some((x) => x.name === s.ref) ? `embedded:${s.ref}` : null;
    if (s.count) return `q:${q.id}`;
    const type = questionOperandType(q);
    if (s.rowCode != null && (type.startsWith("grid_") || type === "constant_sum" || type === "maxdiff")) return `q:${q.id}[${s.rowCode}]`;
    return `q:${q.id}`;
  }
  return null;
}

const HINTS: Partial<Record<OperandType, string>> = {
  single: "an option code", rating_label: "an option code", rating_numeric: "a score",
  multi: "option codes, separated by commas", ranking: "option codes in rank order, separated by commas",
  numeric: "a number", duration: "a number", text: "the typed answer", list: "items separated by commas",
  date: "YYYY-MM-DD", time: "HH:MM", boolean: "true or false", file: "any text = a file was uploaded",
  grid_single: "row=code, row=code (or the code for the chosen row)", grid_multi: "row=code code, …",
  grid_numeric: "row=number, …", grid_text: "row=text, …", constant_sum: "code=amount, …",
  maxdiff: "JSON, e.g. {\"1\":{\"best\":\"2\",\"worst\":\"5\"}}", any: "a value",
};

/** The answers a person must type to try this condition: one per distinct source the condition reads. */
export function conditionTestInputs(def: SurveyDefinition, condition: Condition | undefined | null): ConditionTestInput[] {
  const out = new Map<string, ConditionTestInput>();
  if (!condition) return [];
  forEachRule(condition, (r) => {
    const key = inputKey(def, r.source);
    if (!key || out.has(key)) return;
    const q = key.startsWith("q:") ? getQuestionByCodeOrVar(def, r.source.ref) : undefined;
    const type: OperandType = q ? questionOperandType(q) : r.source.kind === "embedded" || key.startsWith("embedded:") ? embeddedOperandType(def, r.source.ref) : "any";
    const rowNote = key.includes("[") ? ` ${sourceName(def, { ...r.source, count: undefined })}` : "";
    const rowAnswer = key.includes("[");
    out.set(key, {
      key,
      label: q ? `${q.code}${rowAnswer ? rowNote.replace(q.code, "") : ""} — ${strip(q.text).slice(0, 50)}` : r.source.ref,
      type,
      hint: rowAnswer ? (type === "grid_multi" ? "codes, separated by commas" : type === "maxdiff" ? "JSON, e.g. {\"best\":\"2\"}" : "the answer for this row") : HINTS[type] ?? "a value",
      choices: q && (q.options ?? []).length ? q.options.map((o) => ({ code: String(o.code), label: strip(o.label) })) : undefined,
    });
  });
  return [...out.values()];
}

const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);

function typed(type: OperandType, raw: string): unknown {
  const t = raw.trim();
  if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { /* fall through: text */ } }
  switch (type) {
    case "multi": case "ranking": return listItems(t);
    case "numeric": case "duration": case "rating_numeric": case "count": return /^-?\d+(?:\.\d+)?$/.test(t) && !/^-?0\d/.test(t) ? Number(t) : t;
    case "boolean": return TRUE_WORDS.has(t.toLowerCase());
    case "grid_single": case "grid_multi": case "grid_numeric": case "grid_text": case "constant_sum": {
      if (!/=/.test(t)) return t;
      const map: Record<string, unknown> = {};
      for (const part of t.split(/\s*[,;]\s*(?=[^,;=]+=)/)) {
        const [k, ...rest] = part.split("=");
        const v = rest.join("=").trim();
        map[k.trim()] = type === "grid_multi" ? v.split(/[\s,]+/).filter(Boolean)
          : type === "grid_numeric" || type === "constant_sum" ? (Number.isFinite(Number(v)) ? Number(v) : v) : v;
      }
      return map;
    }
    default: return t;
  }
}

/**
 * Evaluate a condition against a typed test response with the REAL evaluator.
 * `values` is keyed as `conditionTestInputs` keys them; an empty value leaves
 * that source unanswered. Embedded values stay text, exactly as captured.
 */
export function evaluateWithTestInputs(
  def: SurveyDefinition,
  condition: Condition | undefined | null,
  values: Record<string, string>,
): { result: boolean; trace: EvalTrace[] } {
  const state = createResponseState(def, { seed: 1, sessionId: "condition-test" });
  for (const input of conditionTestInputs(def, condition)) {
    const raw = values[input.key];
    if (raw === undefined || raw.trim() === "") continue;
    const m = /^(q|embedded|calculation):([^[]+)(?:\[(.+)\])?$/.exec(input.key);
    if (!m) continue;
    const [, kind, ref, row] = m;
    if (kind === "embedded") {
      const t = embeddedOperandType(def, ref);
      state.embedded[ref] = (t === "numeric" ? (Number.isFinite(Number(raw.trim())) ? Number(raw.trim()) : raw) : t === "boolean" ? TRUE_WORDS.has(raw.trim().toLowerCase()) : raw) as never;
    } else if (kind === "calculation") {
      state.calculated[ref] = (Number.isFinite(Number(raw.trim())) && raw.trim() !== "" && !/^-?0\d/.test(raw.trim()) ? Number(raw.trim()) : raw) as never;
    } else if (row !== undefined) {
      const q = def.questions.find((x) => x.id === ref);
      const type = q ? questionOperandType(q) : "any";
      const cur = (state.answers[ref] && typeof state.answers[ref] === "object" ? state.answers[ref] : {}) as Record<string, unknown>;
      cur[row] = type === "grid_multi" ? listItems(raw) : type === "grid_numeric" || type === "constant_sum" ? typed("numeric", raw)
        : type === "maxdiff" ? typed("any", raw) : raw.trim();
      state.answers[ref] = cur as never;
    } else {
      const q = def.questions.find((x) => x.id === ref);
      state.answers[ref] = typed(q ? questionOperandType(q) : "any", raw) as never;
    }
  }
  const trace: EvalTrace[] = [];
  const result = evaluateCondition(condition, { def, state, loop: null, quotaCounts: {}, trace });
  return { result, trace };
}
