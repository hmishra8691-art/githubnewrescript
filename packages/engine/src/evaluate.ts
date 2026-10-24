import { displayedCodesFor, hasDisplayedResolver } from "./displayedRegistry.js";
import type { Condition, ConditionRule, Question, SurveyDefinition } from "@rescript/schema";
import { isOptionValueRef, isQuestionValueRef, isPipedValueRef, effectiveResponseModel, OPEN_ENDED_MULTI_VALUE_OPERATORS } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import { interviewText, isInterviewAnswer } from "./interview.js";
import { findLoopScope, getQuestionByCodeOrVar, lookupAnswer, loopValue } from "./state.js";
import { evaluateCount } from "./countCondition.js";
import { safeExpression } from "./calcContext.js";
import { findNamedExpression } from "./namedExpressions.js";
import { getEffectiveListsResolver, resolvePipingText } from "./piping.js";
import { isEmptyAnswer } from "./answers.js";
import { isCategoricalGrid } from "./gridCell.js";
import { isListText, listItems } from "./listValue.js";
import { effectiveEmbeddedType, embeddedCatalog } from "./embedded.js";

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
  /**
   * The question a validation rule belongs to, when there is one. A format
   * check may need the question's own configuration — a Phone rule reads
   * `settings.phoneCountry`, a ZIP rule reads `settings.postalCountry` —
   * and a rule evaluated outside a question (a grid cell's own rules, a
   * count condition) simply has none, and falls back to the region-agnostic
   * check.
   */
  question?: Question | null;
  /** live quota counts: quotaId -> cellId -> count */
  quotaCounts?: Record<string, Record<string, number>>;
  /** trace collector for the inspector */
  trace?: EvalTrace[];
  /**
   * The respondent's language: interface / validation strings (`ui`, a
   * language's translated catalogue — see localization.ts `uiText`) and the
   * locale for number and date formatting. Absent = English defaults.
   */
  ui?: Record<string, string>;
  locale?: string;
}

export interface EvalTrace {
  rule: string;
  result: boolean;
  left: unknown;
  operator: string;
  right: unknown;
}

/* ------------------------------------------------------------ cell sets
 *
 * A GRID READ WITHOUT ONE CELL IS A SET OF CELLS.
 *
 * "Q2 row Item 1, any column, > 23" on a numeric matrix reads that row's
 * `{ c1: 30, c2: 4 }`; "Q2 column Amount" with no row reads that column down
 * every row; "Q8 > 6" on a constant sum reads `{ 1: 10, 2: 5, … }`. Each of
 * those is several values, and every one of them used to reach the
 * comparison as a single thing — an object, or an array — so `> 23` was
 * `Number({…}) > 23`, false for every respondent, and the builder offered the
 * rule anyway (the 30-09 report: "Row > 25 does not work unless I select a
 * column").
 *
 * The rule now reads the way it is written and the way the builder words it
 * ("any col"): a value comparison holds when ANY cell satisfies it, and its
 * negation (≠, not in, not contains, not between) holds when NO cell does —
 * the same existential reading `selected` / `contains` always had on lists.
 * Only reads that really are several cells are marked, so a multi-select's
 * own answer array and every scalar answer behave exactly as before.
 */
/**
 * WHAT THE RESPONDENT WAS SHOWN — registered, not imported.
 *
 * "Was this question / this option displayed" needs the option pipeline
 * (eligibility, exclusion, carry-forward), which lives in `carryforward.ts`,
 * which imports this file. Importing it back would close the cycle, so it
 * registers itself here — the same arrangement `piping.ts` has with
 * `getEffectiveListsResolver`. Returns the codes (rows, for a grid) that were
 * shown, or `null` when the question itself is not shown.
 */
export { registerDisplayedCodesResolver, type DisplayedCodesResolver } from "./displayedRegistry.js";

const CELL_SETS = new WeakSet<object>();
const GRID_RECORDS = new WeakSet<object>();
const cellSet = (cells: unknown[]): unknown[] => { CELL_SETS.add(cells); return cells; };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** every non-empty leaf of a grid answer: rows → cells, a multi-select cell → its codes */
function flattenCells(v: unknown, out: unknown[] = []): unknown[] {
  if (v === null || v === undefined || v === "") return out;
  if (Array.isArray(v)) { for (const x of v) flattenCells(x, out); return out; }
  if (isRecord(v)) { for (const x of Object.values(v)) flattenCells(x, out); return out; }
  out.push(v);
  return out;
}
/** response models whose answer is a map of cells (grids, constant sum, field lists) */
const GRID_MODELS = new Set(["per_row", "cells", "allocation", "fields"]);

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
     *
     * ONE DELIBERATE DIVERGENCE, worth knowing about. Inside the expression,
     * an unanswered numeric reads as 0, because that is what a CALCULATION
     * means by it — `avg(Q5, Q6, Q7)` has to total what is there. An ordinary
     * rule is fail-closed instead: `Q5 < 10` is false when Q5 is unanswered,
     * because a comparison against nothing has no answer. So `expr("Q5 < 10")`
     * and the plain rule `Q5 < 10` disagree on an unanswered Q5, by design:
     * the first is arithmetic, the second is a question about an answer.
     * Write `Q5 isNotEmpty AND Q5 < 10` when the distinction matters. This is
     * not unified here because `toNum` is shared with every calculation and
     * every live quota built on one.
     */
    case "expr":
      return safeExpression(source.ref, ctx.def, ctx.state, ctx.loop);
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
            if (columnId != null && isRecord(row)) {
              val = ((row as Record<string, unknown>)[columnId] as any) ?? null;
            } else if (columnId == null && isRecord(row)) {
              /* a row of a multi-column grid with no column named: that row's cells */
              const cells = flattenCells(row);
              val = (cells.length ? cellSet(cells) : null) as any;
            } else {
              val = row as any;
            }
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
          val = (cells.length > 0 ? cellSet(cells) : null) as any;
        }
      }
      /* the whole map of a grid-like answer, read without a cell: marked so a value comparison reads its cells */
      if (isRecord(val) && q && GRID_MODELS.has(effectiveResponseModel(q))) GRID_RECORDS.add(val);
      /*
       * AN INTERVIEW'S COMPARABLE VALUE IS ITS TRANSCRIPT.
       *
       * The logic builder has always offered this type the TEXT operators —
       * `lintLogic` says so explicitly — and the evaluator was handing those
       * operators the whole `{watch, audio, transcript}` object. `contains`
       * fell through to an equality check and was always false; `matches`
       * tested a regex against the string "[object Object]"; and `isNotEmpty`
       * was true the moment a respondent pressed play, before they had said
       * a word. The builder promised one thing and the evaluator did another,
       * which is the worst of the three possible states.
       *
       * Resolved here, once, where the value is read — so every operator,
       * every rule and every quota sees the same text the export column and
       * the piping token already show.
       */
      if (q?.type === "video_interview" && isInterviewAnswer(val)) return interviewText(val);
      return val ?? null;
    }
  }
}

/* The one definition — see `isEmptyAnswer`. This file used to carry its own,
 * which counted whitespace as an answer and a grid of nulls as answered. */
const isEmpty = isEmptyAnswer;

function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

/** `looseEq`, ignoring case — the membership test `contains` uses. */
function looseEqCI(a: unknown, b: unknown): boolean {
  if (looseEq(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The ITEMS of a list value, for the whole-item operators (`containsItem` …).
 * A delimited string ("10001, 10002") is split, an array is taken member by
 * member (a member that is itself delimited text is split too, so a list typed
 * into one box and a list picked item by item read the same), and a scalar is
 * a one-item list. Trimmed, never re-typed: "02108" stays "02108".
 */
function itemsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (Array.isArray(x) ? itemsOf(x) : listItems(x)));
  return listItems(v);
}
const sameItem = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `contains`, in one place, so `notContains` cannot drift from it. */
function containsValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return left.some((l) => looseEqCI(l, right));
  if (typeof left === "string") return left.toLowerCase().includes(String(right ?? "").toLowerCase());
  return looseEqCI(left, right);
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
  /*
   * PIPED TEXT as the comparison value — `{{Q1.ZIP_Code}}`, `{{ed.REGION}}` —
   * resolved by the same piping engine the page uses, as plain text (see
   * `resolvePipingText`). Only a `{ $pipe }` reference is resolved, so a
   * literal value that happens to contain braces keeps its stored meaning.
   */
  if (isPipedValueRef(v)) {
    try { return resolvePipingText(v.$pipe, ctx); } catch { return null; }
  }
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

/**
 * Value comparisons that read a set of cells existentially (see CELL_SETS):
 * the operator to apply to each cell, and whether the rule is its negation.
 */
const EXISTENTIAL: Partial<Record<ConditionRule["operator"], { op: ConditionRule["operator"]; negated: boolean }>> = {
  eq: { op: "eq", negated: false }, ne: { op: "eq", negated: true },
  gt: { op: "gt", negated: false }, gte: { op: "gte", negated: false },
  lt: { op: "lt", negated: false }, lte: { op: "lte", negated: false },
  between: { op: "between", negated: false }, notBetween: { op: "between", negated: true },
  in: { op: "in", negated: false }, notIn: { op: "in", negated: true },
  contains: { op: "contains", negated: false }, notContains: { op: "contains", negated: true },
  startsWith: { op: "startsWith", negated: false }, endsWith: { op: "endsWith", negated: false },
  matches: { op: "matches", negated: false },
  dateBefore: { op: "dateBefore", negated: false }, dateAfter: { op: "dateAfter", negated: false },
  dateEquals: { op: "dateEquals", negated: false }, dateBetween: { op: "dateBetween", negated: false },
};

/** One operator against one resolved left-hand value — the whole comparison vocabulary, in one place. */
function applyOperator(operator: ConditionRule["operator"], left: unknown, right: unknown, right2: unknown): boolean {
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
    /*
     * ONE CASE POLICY FOR `contains`.
     *
     * It had two, chosen by the ANSWER'S RUNTIME SHAPE rather than by the
     * programmer: a multi-select (array) matched its members case-SENSITIVELY
     * through `looseEq`, while an open end (string) matched its substring
     * case-INSENSITIVELY. The same rule against the same question therefore
     * changed meaning when the respondent selected one option instead of two,
     * because a single selection can arrive as a scalar — which is how a
     * condition passes on one page and fails on the next with nothing about
     * the survey having changed.
     *
     * Case-insensitive throughout, which is what the string branch already
     * promised and what a researcher writing `contains "blue"` means. What is
     * matched still depends on the shape — membership in a list, substring in
     * text — because those are genuinely different questions; only the casing
     * is now the same question everywhere.
     */
    case "contains":
      result = containsValue(left, right);
      break;
    case "notContains":
      result = !containsValue(left, right);
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

    /* ------------------------------------------------------- list items
     * WHOLE ITEMS, not text (documents 15/10, 16/10). "10001, 10002, …" holds
     * the item "10005"; it does not hold "1000", and "110001" never matches
     * "10001". A value that is itself a list matches when ANY of its items is
     * held (containsItem), when NONE is (notContainsItem), or when ALL are
     * (containsAllItems). New operators, so no stored `contains` changes.
     */
    case "containsItem":
    case "notContainsItem": {
      const l = itemsOf(left);
      const wanted = itemsOf(right);
      const any = wanted.some((w) => l.some((x) => sameItem(x, w)));
      result = operator === "containsItem" ? any : !any;
      break;
    }
    case "containsAllItems": {
      const l = itemsOf(left);
      const wanted = itemsOf(right);
      result = wanted.length > 0 && wanted.every((w) => l.some((x) => sameItem(x, w)));
      break;
    }
    case "containsExactly": {
      /* "has selected exactly A and C": the same set, in any order — `eq` on two arrays compared their order */
      const l = [...new Set(itemsOf(left).map((x) => x.toLowerCase()))];
      const wanted = [...new Set(itemsOf(right).map((x) => x.toLowerCase()))];
      result = wanted.length > 0 && l.length === wanted.length && wanted.every((w) => l.includes(w));
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

  return result;
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

  /*
   * DISPLAYED / NOT DISPLAYED — was the question, or this option of it, on the
   * respondent's screen, whatever they answered. Not `selected`: an option
   * can be shown and not chosen, and that is exactly the case this exists for.
   * With no option named the question itself is asked about. A question that
   * cannot be found, or a survey with nothing registered to answer, reads as
   * "not shown" — the safe direction for a rule that gates an option.
   */
  if (rule.operator === "displayed" || rule.operator === "notDisplayed") {
    const src = rule.source;
    let held = false;
    if ((src.kind === "question" || src.kind === "variable") && src.ref && hasDisplayedResolver()) {
      const shown = displayedCodesFor(src.ref, ctx) ?? null;
      const wanted = resolveComparisonValue(rule.value, ctx);
      const list = Array.isArray(wanted) ? wanted : wanted === undefined || wanted === null || wanted === "" ? [] : [wanted];
      held = shown !== null && (list.length === 0 ? true : list.some((w) => shown.some((c) => String(c) === String(w))));
    }
    const out = rule.operator === "displayed" ? held : !held;
    ctx.trace?.push({ rule: `${rule.source.ref}${rule.value != null && typeof rule.value !== "object" ? `.${String(rule.value)}` : ""}`, result: out, left: held, operator: rule.operator, right: rule.value });
    return out;
  }
  const left = resolveSourceValue(rule, ctx);
  const { operator } = rule;
  let right = resolveComparisonValue(rule.value, ctx);
  const right2 = resolveComparisonValue(rule.value2, ctx);
  /*
   * A CATEGORICAL GRID CELL: row + answer column, and no value (see gridCell.ts).
   * The scale point lives in `columnId`, so it is what the row's answer is
   * tested for. With no row named the cells are the rows that chose that
   * column (see `resolveSourceValue`), and `selected` asks whether there are any.
   * A rule that still carries its own `value` is read exactly as it always was.
   */
  if (
    (operator === "selected" || operator === "notSelected") &&
    (rule.value === undefined || rule.value === null || rule.value === "") &&
    rule.source.columnId != null && rule.source.kind === "question" && !rule.source.count &&
    isCategoricalGrid(getQuestionByCodeOrVar(ctx.def, rule.source.ref))
  ) {
    right = rule.source.columnId;
  }
  /*
   * `contains` ON AN EMBEDDED DATA LIST MATCHES WHOLE ITEMS (document 15/10).
   * Only for a field whose type is LIST — declared "list", or "auto" holding
   * a list. Both types are new, so no stored survey's `contains` changes:
   * an untyped or "string" field keeps its substring meaning, and offers
   * "contains item" for whole items.
   */
  if ((operator === "contains" || operator === "notContains") && isEmbeddedListSource(rule, ctx, left)) {
    const result = applyOperator(operator === "contains" ? "containsItem" : "notContainsItem", left, right, right2);
    ctx.trace?.push({ rule: rule.source.ref, result, left, operator, right });
    return result;
  }
  let result: boolean;
  const ex = EXISTENTIAL[operator];
  const cells = ex
    ? Array.isArray(left) && CELL_SETS.has(left) ? left
      : isRecord(left) && GRID_RECORDS.has(left) ? flattenCells(left)
      : null
    : null;
  /*
   * AN OPEN-ENDED ANSWER WITH SEVERAL VALUES (2026-10-24, client items A46 /
   * A48). "Enter a number between 1 and 100, separated by commas" → the
   * respondent types "25, 26, 27, 45" into a text box, and `between 1 and 100`
   * compared `Number("25, 26, 27, 45")` — NaN, false for every respondent.
   * For a question whose answer is TYPED, the numeric comparisons and
   * `in` / `notIn` now read such an answer value by value: every value must
   * satisfy them. See `applyOpenEnded` and OPEN_ENDED_MULTI_VALUE_OPERATORS.
   */
  const apply = OPEN_ENDED_MULTI_VALUE_OPERATORS.includes(operator) && isOpenEndedQuestionSource(rule, ctx)
    ? applyOpenEnded : applyOperator;
  if (ex && cells) {
    // several cells: any of them for a comparison, none of them for its negation
    const any = cells.some((cell) => apply(ex.op, cell, right, right2));
    result = ex.negated ? !any : any;
  } else {
    result = apply(operator, left, right, right2);
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

/*
 * OPEN-ENDED, VALUE BY VALUE (2026-10-24).
 *
 * `applyOpenEnded` is `applyOperator` for an answer the respondent TYPED.
 * When that answer is a comma-separated list ("25, 26, 27", "25; 26",
 * one per line), a positive comparison (`between`, `>`, `≥`, `<`, `≤`,
 * `in`) holds when the WHOLE answer satisfies it as before — so nothing a
 * single value satisfied stops being satisfied — or when EVERY value does.
 * A negation (`notBetween`, `notIn`) holds when the whole answer is not a
 * match AND no value is one. Items are trimmed, empty items ("25,,26,") are
 * ignored, decimals and negatives read as numbers, and a value that is not a
 * number fails a numeric comparison — so "99.100, 101" is never between 1
 * and 100, and "abc, 5" is not either. A scalar answer takes the ordinary
 * path untouched.
 */
const POSITIVE_OF: Partial<Record<ConditionRule["operator"], ConditionRule["operator"]>> = { notBetween: "between", notIn: "in" };
function applyOpenEnded(operator: ConditionRule["operator"], left: unknown, rawRight: unknown, right2: unknown): boolean {
  /* "is in list" typed as one comma-separated value ("1, 5, 10") is the list it spells */
  const right = (operator === "in" || operator === "notIn") && typeof rawRight === "string" && isListText(rawRight) ? listItems(rawRight) : rawRight;
  if (typeof left !== "string" || !isListText(left)) return applyOperator(operator, left, right, right2);
  const items = listItems(left);
  const positive = POSITIVE_OF[operator];
  if (positive) {
    /* the negation itself per item (so a non-number is "not between" nothing, exactly as a scalar), and the whole must not match */
    return !applyOperator(positive, left, right, right2) && items.every((item) => applyOperator(operator, item, right, right2));
  }
  return applyOperator(operator, left, right, right2) || items.every((item) => applyOperator(operator, item, right, right2));
}

/** Column response types whose cell is typed by the respondent. */
const OPEN_COLUMN_TYPES = new Set(["text", "longtext", "numeric", "slider"]);

/**
 * Is this rule reading an answer the respondent TYPES — a text or numeric
 * open end, a Text / Numeric List field, a Text / Numeric Matrix cell, a
 * Constant Sum amount, or a text / numeric column of a composite grid? Only
 * such a source is read value by value (see `applyOpenEnded`); choice,
 * ranking, date, time and Embedded Data sources evaluate exactly as before.
 */
function isOpenEndedQuestionSource(rule: ConditionRule, ctx: EvalContext): boolean {
  const s = rule.source;
  if (s.count || (s.kind !== "question" && s.kind !== "variable")) return false;
  const q = getQuestionByCodeOrVar(ctx.def, s.ref);
  if (!q) return false;
  if (q.type === "composite" || q.type === "custom_table") {
    if (!s.columnId) return false;
    const col = (q.columns ?? []).find((c) => String(c.id) === String(s.columnId));
    return !!col && OPEN_COLUMN_TYPES.has(String(col.responseType));
  }
  switch (effectiveResponseModel(q)) {
    case "text": return q.type !== "date" && q.type !== "time";
    case "numeric": case "allocation": case "fields": return true;
    case "per_row": return q.type === "matrix_text" || q.type === "matrix_numeric";
    default: return false;
  }
}

/** Is this rule reading an Embedded Data field whose effective type is a LIST? */
function isEmbeddedListSource(rule: ConditionRule, ctx: EvalContext, value: unknown): boolean {
  const s = rule.source;
  if (s.count) return false;
  const named = s.kind === "embedded"
    || ((s.kind === "question" || s.kind === "variable") && !getQuestionByCodeOrVar(ctx.def, s.ref)
      && embeddedCatalog(ctx.def).some((e) => e.name === s.ref));
  if (!named) return false;
  try { return effectiveEmbeddedType(ctx.def, s.ref, value) === "list"; } catch { return false; }
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

/**
 * A GROUP WITH NOTHING IN IT SAYS NOTHING.
 *
 * This is the root of the "AND evaluates incorrectly" report, and it is not
 * in the AND. `[].every(...)` is true and `[].some(...)` is false, so an
 * empty group took its truth value from its OPERATOR rather than from its
 * (absent) contents — and the two operators disagreed:
 *
 *     A AND B AND or([])   →  A ∧ B ∧ false  →  always false
 *     A OR  B OR  and([])  →  A ∨ B ∨ true   →  always true
 *
 * A programmer who clicks "+ Group" and has not yet put a rule in it has
 * expressed no condition. One click, in a builder that offers the button,
 * silently inverted a whole logic tree — and the printed summary left the
 * empty group out, so what was on screen said the opposite of what ran.
 *
 * The contract is now the same one an absent condition already has
 * (`if (!condition) return true` above): an empty group is not a constraint.
 * It is skipped, and a group whose children are ALL empty is empty in turn,
 * so nesting cannot smuggle the old behaviour back in.
 *
 * This deliberately does not "fix" it by treating an empty OR as false-open
 * or an empty AND as true-closed. Those are guesses about intent. Saying
 * nothing is the only reading that cannot silently change an answer.
 */
export function isVacuousCondition(c: Condition | undefined | null): boolean {
  if (!c) return true;
  if (c.type === "rule") return false;
  const kids = c.children ?? [];
  return kids.length === 0 || kids.every((k) => isVacuousCondition(k));
}

/**
 * For a TRIGGER — a condition whose holding makes something happen that
 * would not happen without it (hide when, exclude when, move to top/bottom
 * when, stop probing when). An absent trigger never fires; an EMPTY one
 * (`{and: []}`, the builder's starting state, or what is left when every
 * condition in it was deleted) is the same thing — "not configured" — and
 * must not fire either.
 *
 * `evaluateCondition` reads an empty tree as TRUE, which is right for a GATE
 * (show when / eligible when: no constraint). Used for a trigger it meant an
 * unfinished "Hide when" removed the option for everyone, while the very
 * same rule with `when` simply missing hid nothing.
 */
export function conditionFires(
  condition: Condition | undefined | null,
  ctx: EvalContext,
): boolean {
  return !isVacuousCondition(condition) && evaluateCondition(condition, ctx);
}

/** Evaluate any condition tree — arbitrary AND/OR/NOT nesting (req. §6). */
export function evaluateCondition(
  condition: Condition | undefined | null,
  ctx: EvalContext,
): boolean {
  return evaluateAt(condition, ctx, 0);
}

/**
 * How deep a stored tree may nest before the evaluator stops descending. Far
 * beyond anything a person writes (the builder and the linter warn long
 * before it); it exists so a malformed definition cannot exhaust the stack
 * and take the respondent's page down. Past it the subtree is false — the
 * fail-closed direction every unresolvable rule already takes.
 */
export const MAX_CONDITION_DEPTH = 200;

function evaluateAt(condition: Condition | undefined | null, ctx: EvalContext, depth: number): boolean {
  if (!condition) return true;
  if (depth > MAX_CONDITION_DEPTH) return false;
  if (condition.type === "rule") return evaluateRule(condition, ctx);
  const { op } = condition;
  const children = (condition.children ?? []).filter((c) => !isVacuousCondition(c));
  if (!children.length) return true;
  if (op === "and") return children.every((c) => evaluateAt(c, ctx, depth + 1));
  if (op === "or") return children.some((c) => evaluateAt(c, ctx, depth + 1));
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
  return !children.some((c) => evaluateAt(c, ctx, depth + 1));
}
