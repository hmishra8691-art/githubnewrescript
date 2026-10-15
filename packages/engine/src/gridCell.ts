import type { Condition, ConditionRule, Question } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";

/**
 * ONE MEANING FOR "ROW + ANSWER COLUMN" ON A CATEGORICAL GRID.
 *
 * A single- or multi-select matrix (Likert, rating, semantic differential,
 * multi-select grid …) stores one CODE per row — or a list of them. Its
 * columns are the answer scale, so "row A is answered Agree" has exactly one
 * answer-shaped coordinate: the scale point.
 *
 * The condition model has two fields that could hold it — `source.columnId`
 * and the rule's `value` — and the visual builder used to ask for both. The
 * evaluator, for a row that holds a code (or a list of codes), ignores
 * `columnId` and compares `value`. So the "column" control looked like it did
 * something and silently did not, and a rule whose two boxes disagreed
 * evaluated by the one nobody was looking at.
 *
 * The canonical form is therefore:
 *
 *   which answer is addressed   →  `source.rowCode` + `source.columnId`
 *                                  (the scale point's stable OPTION CODE — never
 *                                  its label), operator `selected` / `notSelected`,
 *                                  and NO `value`
 *   a comparison of the answer  →  `source.rowCode` + operator + `value`
 *                                  (ordinal: `>= 4`, `between 2 and 4`, `in [1,2]`)
 *                                  and NO `columnId`
 *
 * `value` therefore appears only when the operator actually needs one.
 */

/** A grid whose rows each hold a scale code (or list of codes): `columnId` is an OPTION CODE. */
export function isCategoricalGrid(q: Question | undefined | null): boolean {
  return !!q && effectiveResponseModel(q) === "per_row" && q.type !== "matrix_numeric" && q.type !== "matrix_text";
}

const SELECTION: ConditionRule["operator"][] = ["selected", "notSelected"];

export interface GridRuleNormalization {
  rule: ConditionRule;
  /** the rule was rewritten */
  changed: boolean;
  /** a stored rule whose column and value disagreed; the evaluator always followed `value`, so that is what is kept */
  conflict?: string;
}

/**
 * The canonical form of one rule on a categorical grid. Every other rule —
 * another source, another operator, a count, a flat question — is returned
 * untouched, so this is safe to run over a whole survey.
 */
export function normalizeGridRule(q: Question | undefined | null, rule: ConditionRule): GridRuleNormalization {
  const same = (): GridRuleNormalization => ({ rule, changed: false });
  const s = rule.source;
  if (!q || s.kind !== "question" || s.count || !isCategoricalGrid(q) || isDisplayOperator(rule.operator)) return same();
  /*
   * "Some row answered this scale point", written as `answered` — the same
   * question as `selected` on that column, since only rows that chose the
   * column contribute a cell. Rewritten so there is one way to say it.
   * (With a row named, `answered` has always meant "that row has an answer"
   * and ignored the column; that is left alone and the linter reports it.)
   */
  if (s.columnId != null && s.rowCode == null && s.rowPosition == null && (rule.operator === "answered" || rule.operator === "unanswered")) {
    return { rule: { ...rule, operator: rule.operator === "answered" ? "selected" : "notSelected" }, changed: true };
  }
  const hasValue = rule.value !== undefined && rule.value !== null && rule.value !== "" && typeof rule.value !== "object";

  if (SELECTION.includes(rule.operator)) {
    if (!hasValue) return same();
    const code = String(rule.value);
    const conflict = s.columnId != null && String(s.columnId) !== code
      ? `Row and column disagreed (column ${s.columnId}, value ${code}); the value is what was evaluated, so ${code} is kept.`
      : undefined;
    const { value: _v, value2: _v2, ...rest } = rule;
    return { rule: { ...rest, source: { ...s, columnId: code } } as ConditionRule, changed: true, conflict };
  }

  /*
   * A comparison of the row's answer. With a row named the evaluator never
   * looked at `columnId`, so it is redundant and goes. Without a row it means
   * "any row answered this scale point", which is a different, legitimate
   * question, and stays.
   */
  if (hasValue && s.columnId != null && s.rowCode != null) {
    const { columnId: _c, ...source } = s;
    const conflict = String(s.columnId) !== String(rule.value) && !Array.isArray(rule.value)
      ? `Row and column disagreed (column ${s.columnId}, value ${String(rule.value)}); the value is what was evaluated, so ${String(rule.value)} is kept.`
      : undefined;
    return { rule: { ...rule, source }, changed: true, conflict };
  }
  return same();
}

/** every rule of a condition tree, normalised for the grid it reads */
export function normalizeGridConditions(
  c: Condition,
  questionOf: (ref: string) => Question | undefined,
  report?: (message: string) => void,
): Condition {
  if (c.type === "group") {
    let changed = false;
    const children = c.children.map((k) => { const n = normalizeGridConditions(k, questionOf, report); if (n !== k) changed = true; return n; });
    return changed ? { ...c, children } : c;
  }
  const r = normalizeGridRule(questionOf(c.source?.ref ?? ""), c);
  if (r.conflict) report?.(`${c.source.ref}: ${r.conflict}`);
  return r.changed ? r.rule : c;
}

/**
 * THE OPERATORS A CATEGORICAL GRID OFFERS, in the order a person looks for them.
 *
 * `selected` / `notSelected` ARE the "row + answer column" question and take no
 * value; the comparisons take a value (a scale code or two) and no column.
 * `eq` / `ne` are left out on purpose — with a row named they say the same
 * thing as `selected` / `notSelected`, and a second way to say it is how a
 * column and a value ended up on the same row of the builder. A stored rule
 * that already uses them still evaluates, and still shows its own operator.
 */
/** "was this row displayed" — about what the respondent SAW, so it names a row and no answer column */
const DISPLAY_OPS: ConditionRule["operator"][] = ["displayed", "notDisplayed"];
export const isDisplayOperator = (op: ConditionRule["operator"]): boolean => op === "displayed" || op === "notDisplayed";

export function gridCellOperators(q: Question | undefined | null): ConditionRule["operator"][] {
  if (!q || !isCategoricalGrid(q)) return [];
  if (q.type === "matrix_multi") {
    return ["selected", "notSelected", "containsAny", "containsAll", "containsNone", "answered", "unanswered", ...DISPLAY_OPS];
  }
  return ["selected", "notSelected", "answered", "unanswered", "gt", "gte", "lt", "lte", "between", "notBetween", "in", "notIn", ...DISPLAY_OPS];
}

/** Does this operator, on a categorical grid, name an answer column (and nothing else)? */
export const isCellOperator = (op: ConditionRule["operator"]): boolean => SELECTION.includes(op);

/**
 * Re-point a rule at another operator without leaving the old one's fields
 * behind: the scale point moves between `columnId` and `value` when the
 * operator's own shape asks for it, so "is Good" becomes "≥ Good" with Good
 * still chosen — and never the two at once.
 */
export function withGridOperator(rule: ConditionRule, operator: ConditionRule["operator"]): ConditionRule {
  const s = rule.source;
  /* Display is about a row (or the question), not an answer: nothing of the old shape carries across in either direction */
  if (isDisplayOperator(rule.operator) !== isDisplayOperator(operator)) {
    const { columnId: _c, rowCode: _r, rowPosition: _rp, ...source } = s;
    return { ...rule, operator, source, value: undefined, value2: undefined } as ConditionRule;
  }
  const wasCell = SELECTION.includes(rule.operator);
  const toCell = SELECTION.includes(operator);
  if (wasCell === toCell) return { ...rule, operator };
  if (toCell) {
    /* a value-based rule becomes a cell: the first scale code it compared with is the column */
    const first = Array.isArray(rule.value) ? rule.value[0] : rule.value;
    const { value: _v, value2: _v2, ...rest } = rule;
    return { ...rest, operator, source: { ...s, ...(first != null && first !== "" && typeof first !== "object" ? { columnId: String(first) } : {}) } } as ConditionRule;
  }
  const { columnId, ...source } = s;
  const valueless = operator === "answered" || operator === "unanswered";
  return {
    ...rule, operator, source,
    ...(valueless ? { value: undefined, value2: undefined } : columnId != null ? { value: LIST_LIKE.has(operator) ? [String(columnId)] : String(columnId) } : {}),
  } as ConditionRule;
}
const LIST_LIKE = new Set<string>(["in", "notIn", "containsAny", "containsAll", "containsNone"]);
