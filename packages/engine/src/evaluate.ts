import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import { getQuestionByCodeOrVar } from "./state.js";

export interface EvalContext {
  def: SurveyDefinition;
  state: ResponseState;
  loop?: LoopContext | null;
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

export function evaluateRule(rule: ConditionRule, ctx: EvalContext): boolean {
  const left = resolveSourceValue(rule, ctx);
  const { operator } = rule;
  const right = rule.value;
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
      const l = num(left), a = num(right), b = num(rule.value2);
      result = l !== null && a !== null && b !== null && l >= a && l <= b;
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
  // "not" = negation of the conjunction of children
  return !children.every((c) => evaluateCondition(c, ctx));
}
