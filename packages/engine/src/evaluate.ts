import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";
import { isOptionValueRef } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * The option currently under evaluation. Present whenever a condition is
 * evaluated per option — option-level logic, `filter` list operations,
 * carry-forward `where` clauses. It makes option-to-option rules possible
 * without any per-question hard-coding (reqs §8–9, §28).
 */
export interface OptionEvalContext {
  code: string | number;
  label: string;
  value: string | number;
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

/** Resolve the raw value a condition source points at. */
export function resolveSourceValue(rule: ConditionRule, ctx: EvalContext): unknown {
  const { source } = rule;
  const { state } = ctx;

  switch (source.kind) {
    case "option": {
      const o = ctx.option;
      if (!o) return null;
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
    case "loop":
      if (!ctx.loop) return null;
      return source.ref === "code"
        ? ctx.loop.code
        : source.ref === "label"
          ? ctx.loop.label
          : ctx.loop.index;
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
      // loop-local answer takes precedence
      const loopKey = ctx.loop ? `${baseId}@${ctx.loop.code}` : null;
      let val =
        (loopKey != null ? state.answers[loopKey] : undefined) ??
        state.answers[baseId] ??
        state.calculated[source.ref] ??
        state.embedded[source.ref] ??
        null;
      // drill into a matrix / composite cell
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (source.rowCode != null) {
          const row = (val as Record<string, unknown>)[String(source.rowCode)];
          if (row !== undefined) {
            val =
              source.columnId != null && row && typeof row === "object" && !Array.isArray(row)
                ? ((row as Record<string, unknown>)[source.columnId] as any) ?? null
                : (row as any);
          } else {
            val = null;
          }
        } else if (source.columnId != null) {
          val = (val as Record<string, unknown>)[source.columnId] as any;
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

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Parse a date-ish value to epoch ms; day-only strings compare by day. */
function toTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
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
 */
export function resolveComparisonValue(v: unknown, ctx: EvalContext): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveComparisonValue(x, ctx));
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
      const l = num(left), r = num(right);
      result = l !== null && r !== null && l > r;
      break;
    }
    case "lt": {
      const l = num(left), r = num(right);
      result = l !== null && r !== null && l < r;
      break;
    }
    case "gte": {
      const l = num(left), r = num(right);
      result = l !== null && r !== null && l >= r;
      break;
    }
    case "lte": {
      const l = num(left), r = num(right);
      result = l !== null && r !== null && l <= r;
      break;
    }
    case "between": {
      const l = num(left), a = num(right), b = num(right2);
      result = l !== null && a !== null && b !== null && l >= a && l <= b;
      break;
    }
    case "notBetween": {
      const l = num(left), a = num(right), b = num(right2);
      result = l === null || a === null || b === null ? false : l < a || l > b;
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
  o: { code: string | number; label?: string; value?: string | number; index?: number },
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
