/**
 * A LOGIC TRACE THAT SHOWS ITS WORKING (§32, §33).
 *
 * There was already a trace, and it was four things short of useful:
 *
 *   FLAT          `EvalTrace[]` is a list of leaf rules with no group
 *                 structure, so you cannot tell which side of an OR a line
 *                 belongs to — the one thing you need when a nested condition
 *                 comes out the wrong way.
 *   LEAF ONLY     AND / OR / NOT were never recorded at all, so the step that
 *                 combined the leaves — where the mistake usually is — was
 *                 invisible.
 *   ONE FEATURE   it was collected for `q.displayLogic` and nothing else. Not
 *                 skip logic, not a punch `when`, not a mask, not a quota
 *                 cell, not validation.
 *   RUNTIME ONLY  and only in the test runtime's debug panel. The Studio,
 *                 where the logic is written, had no way to see it.
 *
 * This produces a TREE that mirrors the condition, with the value at every
 * step, for any condition and any caller. It is a separate pass rather than
 * instrumentation inside `evaluateCondition`, deliberately:
 *
 *   · the evaluator stays exactly as fast and exactly as simple — a trace is
 *     a debugging concern and should not cost anything when nobody is asking
 *     for one;
 *   · it can be run in the Studio against a hypothetical set of answers,
 *     which is where a programmer actually wants it, without a live session.
 *
 * The one thing that must not drift is the ANSWER. `traceCondition` calls the
 * real `evaluateCondition` for every node rather than reimplementing the
 * logic, so a trace can be incomplete but it can never disagree with what the
 * respondent got.
 */
import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition, resolveSourceValue } from "./evaluate.js";
import { conditionSummary } from "./logicSummary.js";
import { findNamedExpression } from "./namedExpressions.js";

export interface TraceNode {
  /** "and" | "or" | "not" for a group, or the operator for a rule. */
  kind: string;
  /** the condition in words, as the rule list shows it */
  text: string;
  result: boolean;
  /** the left-hand value, for a rule */
  left?: unknown;
  /** the comparison value, for a rule */
  right?: unknown;
  /** why this node decided what it decided, in one sentence */
  because: string;
  children: TraceNode[];
  /**
   * A child that did not need to be evaluated because the group was already
   * decided. Recorded rather than omitted: "we never looked" and "we looked
   * and it was false" are different facts, and confusing them is how somebody
   * spends an hour on the wrong branch.
   */
  shortCircuited?: boolean;
  /** for a named expression: which one, so the trace can be followed into it */
  namedExpressionId?: string;
}

const preview = (v: unknown): string => {
  if (v === null || v === undefined) return "(no answer)";
  if (Array.isArray(v)) return v.length ? `[${v.map(String).join(", ")}]` : "(nothing selected)";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  if (v === "") return "(empty)";
  return String(v);
};

/**
 * Trace one condition against a state.
 *
 * `depth` guards a named expression that references itself: the evaluator
 * already refuses to re-enter one, and the trace has to stop somewhere too or
 * it would build an infinite tree describing a finite answer.
 */
export function traceCondition(
  condition: Condition | undefined | null,
  ctx: EvalContext,
  depth = 0,
): TraceNode {
  if (!condition) {
    return {
      kind: "none", text: "no condition", result: true, children: [],
      because: "Nothing to test, so it passes — an absent condition means “always”.",
    };
  }

  const result = evaluateCondition(condition, ctx);
  const text = conditionSummary(ctx.def, condition);

  if (condition.type === "group") {
    const { op, children } = condition;
    const nodes: TraceNode[] = [];
    let decided = false;

    for (const child of children) {
      if (decided) {
        /*
         * Recorded, not omitted. The evaluator does not short-circuit — it
         * uses `every`/`some`, which do — and either way the reader needs to
         * know the difference between a branch that was false and a branch
         * nobody looked at.
         */
        nodes.push({
          kind: "skipped",
          text: conditionSummary(ctx.def, child),
          result: false,
          because: op === "and"
            ? "Not evaluated — an earlier condition in this ALL group was already false."
            : "Not evaluated — an earlier condition in this ANY group was already true.",
          children: [],
          shortCircuited: true,
        });
        continue;
      }
      const node = depth > 24
        ? { kind: "depth", text: conditionSummary(ctx.def, child), result: false, children: [],
          because: "Too deeply nested to trace any further." }
        : traceCondition(child, ctx, depth + 1);
      nodes.push(node);
      if (op === "and" && !node.result) decided = true;
      if (op === "or" && node.result) decided = true;
    }

    const trues = nodes.filter((n) => !n.shortCircuited && n.result).length;
    const total = nodes.filter((n) => !n.shortCircuited).length;
    const because =
      op === "and"
        ? result
          ? `All ${total} condition${total === 1 ? "" : "s"} held.`
          : "ALL of these must hold, and at least one did not."
        : op === "or"
          ? result
            ? `ANY of these needed to hold, and ${trues} did.`
            : "ANY of these needed to hold, and none did."
          : result
            ? "NONE of these held, which is what NOT requires."
            : "NOT requires that none of these hold, and at least one did.";

    return { kind: op, text, result, because, children: nodes };
  }

  const rule = condition as ConditionRule;

  /* a named expression is traced INTO, because that is where the answer is */
  if (rule.source.kind === "rule") {
    const target = findNamedExpression(ctx.def, rule.source.ref);
    if (!target) {
      return {
        kind: "named", text, result: false, children: [],
        because: `The named expression “${rule.source.ref}” no longer exists, so this is false.`,
      };
    }
    const inner = depth > 24
      ? []
      : [traceCondition(target.when, ctx, depth + 1)];
    return {
      kind: "named",
      text: target.name,
      result,
      namedExpressionId: target.id,
      because: `“${target.name}” came out ${result ? "TRUE" : "FALSE"}.`,
      children: inner,
    };
  }

  let left: unknown;
  try {
    left = resolveSourceValue(rule, ctx);
  } catch {
    left = null;
  }

  return {
    kind: rule.operator,
    text,
    result,
    left,
    right: rule.value,
    because: `${preview(left)} ${result ? "satisfies" : "does not satisfy"} “${text}”.`,
    children: [],
  };
}

/** The trace as indented text — for a log, a test failure, or a copy button. */
export function formatTrace(node: TraceNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const mark = node.shortCircuited ? "–" : node.result ? "✓" : "✗";
  const value = node.left !== undefined && !node.children.length
    ? `  →  ${preview(node.left)}`
    : "";
  const lines = [`${pad}${mark} ${node.text}${value}`];
  if (!node.children.length) lines.push(`${pad}    ${node.because}`);
  for (const c of node.children) lines.push(formatTrace(c, indent + 1));
  if (node.children.length) lines.push(`${pad}  ⇒ ${node.because}`);
  return lines.join("\n");
}

/* ------------------------------------------------------- the punch trace */

export interface PunchTraceRule {
  ruleId: string;
  label: string;
  mode: "if" | "else_if" | "else";
  reached: boolean;
  held: boolean;
  applied: boolean;
  trace: TraceNode | null;
}

export interface PunchTrace {
  questionId: string;
  questionCode: string;
  rules: PunchTraceRule[];
  /** what the chain settled on, in words */
  outcome: string;
}

/**
 * AUTO PUNCH, EXPLAINED (§33).
 *
 * Which rules were reached, which held, which one the chain settled on, and
 * why — the specific thing the brief asks for, and the thing that makes a
 * three-branch chain debuggable at all. A rule that was skipped shows as
 * skipped rather than as false.
 */
export function tracePunches(
  def: SurveyDefinition,
  questionId: string,
  ctx: EvalContext,
): PunchTrace | null {
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return null;

  const rules = q.punches ?? [];
  const out: PunchTraceRule[] = [];
  let chainOpen = false;
  let settled = false;
  let winner: string | null = null;

  for (const [i, rule] of rules.entries()) {
    const mode = (rule.mode ?? "if") as "if" | "else_if" | "else";
    const continues = (mode === "else_if" || mode === "else") && chainOpen;
    if (!continues) { settled = false; chainOpen = true; }

    const label = rule.label?.trim() || `Rule ${i + 1}`;
    if (settled) {
      out.push({ ruleId: rule.id, label, mode, reached: false, held: false, applied: false, trace: null });
      continue;
    }
    const held = mode === "else" && continues ? true : evaluateCondition(rule.when, ctx);
    const trace = mode === "else" && continues ? null : traceCondition(rule.when, ctx);
    if (held) { settled = true; if (!winner) winner = label; }
    out.push({ ruleId: rule.id, label, mode, reached: true, held, applied: held, trace });
  }

  const appliedRules = out.filter((x) => x.applied);
  const outcome = appliedRules.length === 0
    ? "No rule applied — this question is left as the respondent answered it."
    : appliedRules.length === 1
      ? `${appliedRules[0].label} applied.`
      : `${appliedRules.length} rules applied, in order: ${appliedRules.map((x) => x.label).join(", ")}.`;

  return { questionId, questionCode: q.code, rules: out, outcome };
}
