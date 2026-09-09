import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";
import { isOptionValueRef, isQuestionValueRef } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import { findLoopScope, getQuestionByCodeOrVar, lookupAnswer, loopValue } from "./state.js";
import { evaluateCount } from "./countCondition.js";
import { safeExpression } from "./calcContext.js";
import { findNamedExpression } from "./namedExpressions.js";
import { getEffectiveListsResolver } from "./piping.js";

/**
 * The option currently under evaluation. Present whenever a condition is
 * evaluated per option — option-level logic, `filter` list operations,
 * carry-forward `where` clauses. It makes option-to-option rules possible
 * without any per-question hard-coding (reqs §8–9, §28).
 */
export interface OptionEvalContext {
  code: string | number;
  label: string;
  /**
   * Usually the option's own code/value. For a per-row `where` inside a
   * COUNT (`countCondition.ts`'s `matches`), this is the row's whole stored
   * answer instead — an object for a multi-column matrix cell — so a
   * `kind: "option", ref: "value"` source can drill into one named column
   * via `columnId` (see `resolveSourceValue`'s `case "option"`).
   */
  value: unknown;
  index: number;
}

export interface EvalContext {
  def: SurveyDefinition;
  state: ResponseState;
  loop?: LoopContext | null;
  /** the option being evaluated, for per-option conditions */
  option?: OptionEvalContext | null;
  /** live quota counts: quotaId -> cellId -> count */
  quotaCounts?: Record<string, Record<string, number>>;
  /** trace collector for the inspector */
  trace?: EvalTrace[];
}

export interface EvalTrace {
  rule: string;
  result: boolean;
  left: unknown;
  operator: string;
  right: unknown;
}

/** The code at a FIRST / LAST / 0-based-index position, or undefined past either end. */
function codeAtPosition(
  items: { code: string | number }[],
  position: "first" | "last" | number,
): string | number | undefined {
  if (!items.length) return undefined;
  if (position === "first") return items[0].code;
  if (position === "last") return items[items.length - 1].code;
  return items[position]?.code;
}

/** Resolve the raw value a condition source points at. */
export function resolveSourceValue(rule: ConditionRule, ctx: EvalContext): unknown {
  const { source } = rule;
  const { state } = ctx;

  /*
   * A COUNT IS A SOURCE, NOT AN OPERATOR.
   *
   * This one line is the whole integration. Because the count resolves to the
   * rule's LEFT-HAND VALUE, every comparison operator already applies to it
   * (eq / ne / gt / gte / lt / lte / between), every AND-OR-NOT group already
   * nests it, and every caller of `evaluateCondition` already supports it —
   * display and skip logic, masking, option / row / column logic, eligibility,
   * auto select, auto punch, list logic, list operations, branching, loop
   * conditions, quota cells and validation `when` clauses. None of them needed
   * a change, which is the point: one count engine, not twelve.
   *
   * `evaluateCount` returns null rather than 0 for a question it cannot
   * resolve, so a count against a deleted question FAILS its comparison
   * instead of quietly satisfying `<= 5`.
   */
  if (source.count) return evaluateCount(source, ctx);

  switch (source.kind) {
    /*
     * A CALC EXPRESSION AS THE LEFT-HAND VALUE.
     *
     * `(Q5 + Q6 + Q7) > 100` is one rule whose left side is arithmetic. The
     * arithmetic is run by the calculation engine — the same one that runs
     * `Calculation.expression` — through the same resolver, so a name means
     * the same thing in a condition as it does in a calculation.
     *
     * Never throws: a broken expression is `null`, and null fails every
     * comparison below, so the rule is false rather than the page being blank.
     */
    case "expr":
      return safeExpression(source.ref, ctx.def, ctx.state);
    case "option": {
      const o = ctx.option;
      if (!o) return null;
      /*
       * Column drill-down for a per-row condition. `matches()` in
       * `countCondition.ts` puts the ROW'S OWN ANSWER in `o.value` when
       * counting rows/columns (not the option's own value), so on a
       * multi-column matrix that answer is an object keyed by column id —
       * `columnId` picks out one named column of it, exactly the way
       * `source.rowCode` + `source.columnId` already drill into a stored
       * matrix answer for a `kind: "question"` source. Without this, a
       * `where` could only read a single-response grid row's whole cell,
       * never one column of a real multi-column matrix.
       */
      if (
        source.ref === "value" &&
        source.columnId != null &&
        o.value != null &&
        typeof o.value === "object" &&
        !Array.isArray(o.value)
      ) {
        return (o.value as Record<string, unknown>)[source.columnId] ?? null;
      }
      return source.ref === "label"
        ? o.label
        : source.ref === "value"
          ? o.value
          : source.ref === "index"
            ? o.index
            : o.code;
    }
    case "embedded":
      return state.embedded[source.ref] ?? null;
    case "calculation":
      return state.calculated[source.ref] ?? null;
    case "loop": {
      /*
       * `scope` names an enclosing loop by its loopVar when loops nest; absent
       * means the innermost, which is what every rule written inside a single
       * loop has always meant. `ref` is code/label/index/count or the name of
       * one of THAT loop's reference columns — `loop.Category = "Smartphone"`
       * reads the item's own row of the loop's own table and nothing else.
       */
      const l = findLoopScope(ctx.loop, source.scope);
      if (!l) return null;
      return loopValue(l, source.ref || "code");
    }
    case "quota": {
      const counts = ctx.quotaCounts?.[source.ref];
      if (!counts) return null;
      return Object.values(counts).reduce((a, b) => a + b, 0);
    }
    case "variable":
    case "question":
    default: {
      const q = getQuestionByCodeOrVar(ctx.def, source.ref);
      const baseId = q?.id ?? source.ref;
      // loop-local answer takes precedence, then each enclosing iteration's,
      // then the survey-level one — see answerLookupKeys
      let val =
        lookupAnswer(state.answers, baseId, ctx.loop) ??
        state.calculated[source.ref] ??
        state.embedded[source.ref] ??
        null;
      /*
       * FIRST / LAST / Nth addressing. An explicit `rowCode` always wins —
       * it says exactly what it means — so position is only resolved when
       * no code was given. Resolved against the EFFECTIVE (carry-forward
       * resolved) list, lazily, so an ordinary condition that never uses
       * positions pays nothing extra.
       */
      let rowCode = source.rowCode;
      const listsResolver = getEffectiveListsResolver();
      if (rowCode == null && source.rowPosition != null && q && listsResolver) {
        const c = codeAtPosition(listsResolver(q, ctx).rows, source.rowPosition);
        if (c != null) rowCode = String(c);
      }
      /*
       * `optionPosition` fills the same slot `columnId` does when there is
       * no row to drill through first — the flat-object key of a carry-
       * forward-driven answer keyed by option code (an allocation question
       * is the clear case: `{ code: amount }`). Only tried when `rowCode`
       * (explicit or position-resolved) is absent, mirroring the existing
       * mutual exclusivity between the two branches below.
       */
      let columnId = source.columnId;
      if (columnId == null && rowCode == null && source.optionPosition != null && q && listsResolver) {
        const c = codeAtPosition(listsResolver(q, ctx).options, source.optionPosition);
        if (c != null) columnId = String(c);
      }

      // drill into a matrix / composite cell
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (rowCode != null) {
          const row = (val as Record<string, unknown>)[String(rowCode)];
          if (row !== undefined) {
            val =
              columnId != null && row && typeof row === "object" && !Array.isArray(row)
                ? ((row as Record<string, unknown>)[columnId] as any) ?? null
                : (row as any);
          } else {
            val = null;
          }
        } else if (columnId != null) {
          /*
           * A column with no row named: the condition means "this column,
           * across every row" — the natural reading of "any row rated
           * Excellent", and the only reading available once no row is fixed.
           *
           * The answer map is keyed by ROW, so indexing it by a column id
           * finds nothing; that is what this used to do, which made every
           * column-only condition silently false while the builder happily
           * offered a column picker. Collect the column's cell from each row
           * instead and hand back an array, which the operators already treat
           * existentially (`contains`/`selected`/`eq` against an array match
           * if any member matches). A grid whose rows hold scalars rather
           * than per-column objects has no column dimension to drill into, so
           * its row values are returned as they are.
           */
          const cells: unknown[] = [];
          for (const row of Object.values(val as Record<string, unknown>)) {
            if (row && typeof row === "object" && !Array.isArray(row)) {
              /*
               * A composite/table row stores one value per column, so the
               * column is a KEY: take that cell.
               */
              const cell = (row as Record<string, unknown>)[columnId];
              if (cell !== undefined && cell !== null && cell !== "") cells.push(cell);
            } else if (Array.isArray(row)) {
              // matrix_multi: the row holds the column codes it selected
              if (row.some((x) => looseEq(x, columnId))) cells.push(columnId);
            } else if (row !== undefined && row !== null && row !== "") {
              /*
               * A single-response matrix row stores the column it CHOSE, so
               * the column is a VALUE, not a key. Only rows that picked this
               * column count — otherwise every answered row would match every
               * column, and "any row rated Excellent" would be true the moment
               * any row was rated at all.
               */
              if (looseEq(row, columnId)) cells.push(row);
            }
          }
          val = (cells.length > 0 ? cells : null) as any;
        }
      }
      return val ?? null;
    }
  }
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Put the operands of an ordering comparison on one comparable scale.
 *
 * Numbers first, because that is what most comparisons are. When they are not
 * all numeric but ALL of them are dates or clock times, they compare as
 * instants instead — so `>`, `<`, `>=`, `<=` and `between` work on a date or
 * `time` question the way anyone writing "between 09:00 and 17:00" expects,
 * rather than silently yielding false because `Number("09:00")` is NaN.
 *
 * All-or-nothing on purpose: a mixed pair (a date against a plain number) is
 * not a meaningful ordering, and coercing one side to a timestamp would make
 * `date > 5` true for every date ever entered. Mixed stays null, and a null
 * fails every comparison — the same fail-closed rule used everywhere else.
 */
function comparableOperands(values: unknown[]): number[] | null {
  const nums = values.map(num);
  if (nums.every((n) => n !== null)) return nums as number[];
  /*
   * The temporal path is only taken when NOT ONE operand is a number. A
   * partly-numeric comparison is the mixed case, and must stay null: `Date`
   * happily reads a bare "5" as a date, so allowing it would make
   * `someDate > 5` true for every date ever entered.
   */
  if (nums.some((n) => n !== null)) return null;
  const times = values.map(toTime);
  if (times.every((t) => t !== null)) return times as number[];
  return null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Parse a date-ish value to epoch ms; day-only strings compare by day.
 *
 * A bare clock time ("09:00", "17:30:00") is what a `time` question stores,
 * and `Date.parse` rejects it outright — so every time-of-day comparison and
 * every "between 09:00 and 17:00" range silently evaluated to false, on a
 * question type whose only purpose is to be compared this way. Such a value
 * is resolved against a fixed epoch day, which makes clock times comparable
 * with each other while leaving real dates untouched.
 */
function toTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (clock) {
    const h = Number(clock[1]), m = Number(clock[2]), sec = Number(clock[3] ?? 0);
    if (h > 23 || m > 59 || sec > 59) return null;
    return Date.UTC(1970, 0, 1, h, m, sec);
  }
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * 1-based rank of `code` inside a ranking answer (ordered array of codes).
 * Returns null when the value was not ranked.
 */
function rankOf(left: unknown, code: unknown): number | null {
  const list = asArray(left);
  const i = list.findIndex((x) => looseEq(x, code));
  return i < 0 ? null : i + 1;
}

/**
 * Resolve a comparison value. `{ $option: "code" }` resolves against the
 * option currently being evaluated, which is what makes option-to-option and
 * cross-question option matching expressible as ordinary rules (req §8–9).
 * `{ $question: "Q6" }` resolves against another question's answer, which is
 * what makes a cross-question comparison expressible at all.
 */
export function resolveComparisonValue(v: unknown, ctx: EvalContext): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveComparisonValue(x, ctx));
  if (isQuestionValueRef(v)) {
    /*
     * Resolved through `resolveSourceValue` rather than by reading answers
     * directly, so the right-hand side of a rule understands exactly what the
     * left-hand side does: loop scoping, grid rows and cells, and the same
     * code/variable/id spellings. A rule comparing two questions must not have
     * two different ideas of what naming a question means.
     */
    const value = resolveSourceValue(
      {
        type: "rule",
        source: { kind: "question", ref: v.$question, rowCode: v.rowCode, columnId: v.columnId },
        operator: "eq",
      } as ConditionRule,
      ctx,
    );
    if (v.read === "count") return asArray(value).filter((x) => !isEmpty(x)).length;
    return value;
  }
  if (!isOptionValueRef(v)) return v;
  const o = ctx.option;
  if (!o) return null;
  switch (v.$option) {
    case "label":
      return o.label;
    case "value":
      return o.value;
    case "index":
      return o.index;
    case "code":
    default:
      return o.code;
  }
}

export function evaluateRule(rule: ConditionRule, ctx: EvalContext): boolean {
  /*
   * A NAMED EXPRESSION IS A CONDITION, NOT A VALUE (§34, §35).
   *
   * It is resolved here rather than in `resolveSourceValue` because what it
   * produces is a yes/no answer, not something to compare — `IF IS_HIGH_VALUE`
   * has no operator and needs none. An operator, if one is written, still
   * applies: `IS_HIGH_VALUE = false` is a legitimate way to spell NOT.
   */
  if (rule.source.kind === "rule") {
    const target = findNamedExpression(ctx.def, rule.source.ref);
    /*
     * A reference to an expression that has been deleted is FALSE, and false
     * is the safe direction: a display rule that shows a question stops
     * showing it, rather than showing it to everybody. `lintNamedExpressions`
     * reports the dangling reference so it does not stay quietly false.
     */
    if (!target) return false;
    if (resolving.includes(target.id)) {
      /*
       * Already inside this expression — a cycle. Returning false breaks it
       * at the point of re-entry rather than recursing; the linter names the
       * whole chain before deployment.
       */
      return false;
    }
    resolving.push(target.id);
    let held: boolean;
    try {
      held = evaluateCondition(target.when, ctx);
    } finally {
      resolving.pop();
    }
    if (rule.operator === "eq" || rule.operator === "ne") {
      const want = rule.value !== false && rule.value !== "false" && rule.value !== 0;
      return rule.operator === "eq" ? held === want : held !== want;
    }
    return held;
  }

  const left = resolveSourceValue(rule, ctx);
  const { operator } = rule;
  const right = resolveComparisonValue(rule.value, ctx);
  const right2 = resolveComparisonValue(rule.value2, ctx);
  let result: boolean;

  switch (operator) {
    case "answered":
      result = !isEmpty(left);
      break;
    case "unanswered":
      result = isEmpty(left);
      break;
    case "eq":
      result = looseEq(left, right);
      break;
    case "ne":
      result = !looseEq(left, right);
      break;
    case "gt": {
      const c = comparableOperands([left, right]);
      result = c !== null && c[0] > c[1];
      break;
    }
    case "lt": {
      const c = comparableOperands([left, right]);
      result = c !== null && c[0] < c[1];
      break;
    }
    case "gte": {
      const c = comparableOperands([left, right]);
      result = c !== null && c[0] >= c[1];
      break;
    }
    case "lte": {
      const c = comparableOperands([left, right]);
      result = c !== null && c[0] <= c[1];
      break;
    }
    case "between": {
      const c = comparableOperands([left, right, right2]);
      result = c !== null && c[0] >= c[1] && c[0] <= c[2];
      break;
    }
    case "notBetween": {
      const c = comparableOperands([left, right, right2]);
      result = c === null ? false : c[0] < c[1] || c[0] > c[2];
      break;
    }
    case "in":
      result = asArray(right).some((r) => looseEq(left, r));
      break;
    case "notIn":
      result = !asArray(right).some((r) => looseEq(left, r));
      break;
    case "contains":
      result = Array.isArray(left)
        ? left.some((l) => looseEq(l, right))
        : typeof left === "string"
          ? left.toLowerCase().includes(String(right ?? "").toLowerCase())
          : looseEq(left, right);
      break;
    case "notContains":
      result = !(Array.isArray(left)
        ? left.some((l) => looseEq(l, right))
        : typeof left === "string"
          ? left.toLowerCase().includes(String(right ?? "").toLowerCase())
          : looseEq(left, right));
      break;
    case "selected":
      result = asArray(left).some((l) => looseEq(l, right ?? true));
      break;
    case "notSelected":
      result = !asArray(left).some((l) => looseEq(l, right ?? true));
      break;
    case "matches":
      try {
        result = new RegExp(String(right)).test(String(left ?? ""));
      } catch {
        result = false;
      }
      break;

    /* ------------------------------------------------------------- text */
    case "startsWith":
      result = str(left).toLowerCase().startsWith(str(right).toLowerCase());
      break;
    case "endsWith":
      result = str(left).toLowerCase().endsWith(str(right).toLowerCase());
      break;
    case "isEmpty":
      result = isEmpty(left);
      break;
    case "isNotEmpty":
      result = !isEmpty(left);
      break;

    /* ------------------------------------------------------------- list */
    case "containsAny": {
      const l = asArray(left);
      result = asArray(right).some((r) => l.some((x) => looseEq(x, r)));
      break;
    }
    case "containsAll": {
      const l = asArray(left);
      const wanted = asArray(right);
      result = wanted.length > 0 && wanted.every((r) => l.some((x) => looseEq(x, r)));
      break;
    }
    case "containsNone": {
      const l = asArray(left);
      result = !asArray(right).some((r) => l.some((x) => looseEq(x, r)));
      break;
    }

    /* ---------------------------------------------------------- ranking */
    case "rankedFirst":
      result = rankOf(left, right) === 1;
      break;
    case "rankedLast": {
      const list = asArray(left);
      result = list.length > 0 && looseEq(list[list.length - 1], right);
      break;
    }
    case "rankedTopN": {
      const r = rankOf(left, right);
      const n = num(right2);
      result = r !== null && n !== null && r <= n;
      break;
    }
    case "rankEquals": {
      const r = rankOf(left, right);
      const n = num(right2);
      result = r !== null && n !== null && r === n;
      break;
    }
    case "rankGreaterThan": {
      const r = rankOf(left, right);
      const n = num(right2);
      result = r !== null && n !== null && r > n;
      break;
    }
    case "rankLessThan": {
      const r = rankOf(left, right);
      const n = num(right2);
      result = r !== null && n !== null && r < n;
      break;
    }
    case "notRanked":
      result = rankOf(left, right) === null;
      break;

    /* ------------------------------------------------------------- date */
    case "dateBefore": {
      const l = toTime(left), r = toTime(right);
      result = l !== null && r !== null && l < r;
      break;
    }
    case "dateAfter": {
      const l = toTime(left), r = toTime(right);
      result = l !== null && r !== null && l > r;
      break;
    }
    case "dateEquals": {
      const l = toTime(left), r = toTime(right);
      result = l !== null && r !== null && l === r;
      break;
    }
    case "dateBetween": {
      const l = toTime(left), a = toTime(right), b = toTime(right2);
      result = l !== null && a !== null && b !== null && l >= a && l <= b;
      break;
    }

    default:
      result = false;
  }

  ctx.trace?.push({
    rule: `${rule.source.ref}${rule.source.rowCode ? `[${rule.source.rowCode}]` : ""}${rule.source.columnId ? `.${rule.source.columnId}` : ""}`,
    result,
    left,
    operator,
    right,
  });
  return result;
}

/**
 * Derive an evaluation context scoped to one option.
 *
 * The loop context is left exactly as it was. That matters: `resolveSourceValue`
 * reads loop-local answers as `"<questionId>@<loop.code>"`, so injecting a
 * pseudo-loop keyed on the option code would silently redirect every answer
 * lookup inside the condition.
 */
export function withOption(
  ctx: EvalContext,
  o: { code: string | number; label?: string; value?: unknown; index?: number },
): EvalContext {
  return {
    ...ctx,
    option: {
      code: o.code,
      label: o.label ?? String(o.code),
      value: o.value ?? o.code,
      index: o.index ?? 0,
    },
  };
}

/**
 * The pre-existing carry-forward `where` context: options were exposed through
 * a synthetic loop (`{{loop.code}}`, `{{loop.label}}`, index always 0) rather
 * than through `option`. Surveys written against that shape must keep
 * evaluating identically, so it stays available — but only where it was.
 */
export function withLegacyOptionLoop(
  ctx: EvalContext,
  o: { code: string | number; label?: string; value?: string | number },
): EvalContext {
  const label = o.label ?? String(o.code);
  return {
    ...withOption(ctx, { ...o, label, index: 0 }),
    loop: { loopVar: "option", code: String(o.code), label, index: 0 },
  };
}

/**
 * Named expressions currently being resolved, innermost last.
 *
 * A macro that references itself, or two that reference each other, is not a
 * wrong answer — it is an unbounded recursion that takes the page with it. The
 * stack is module-scoped rather than threaded through `EvalContext` because
 * evaluation is synchronous and single-threaded: there is exactly one
 * evaluation in flight at any moment, and a context parameter would have to be
 * passed through fourteen call sites that have no reason to know about it.
 *
 * It is cleared in a `finally`, so an exception thrown inside a macro cannot
 * leave the stack poisoned for the next evaluation.
 */
const resolving: string[] = [];

/** Evaluate any condition tree — arbitrary AND/OR/NOT nesting (req. §6). */
export function evaluateCondition(
  condition: Condition | undefined | null,
  ctx: EvalContext,
): boolean {
  if (!condition) return true;
  if (condition.type === "rule") return evaluateRule(condition, ctx);
  const { op, children } = condition;
  if (op === "and") return children.every((c) => evaluateCondition(c, ctx));
  if (op === "or") return children.some((c) => evaluateCondition(c, ctx));
  /*
   * "not" means NONE of these are true.
   *
   * It used to compute NOT(a AND b) — a NAND, true whenever any child was
   * false — while every label in the editor said "None of these is true".
   * A programmer selecting it got the opposite of what they read on two
   * children out of three. The evaluator now matches what the editor
   * promises; with a single child the two readings are identical, so only a
   * multi-child NOR group behaves differently from before.
   */
  return !children.some((c) => evaluateCondition(c, ctx));
}
