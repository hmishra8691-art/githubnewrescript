/**
 * ONE VARIABLE NAMESPACE FOR THE CALC ENGINE, WHEREVER IT IS CALLED FROM.
 *
 * `runCalculations` built its resolver inline: the flat variable map first,
 * then `state.calculated`, with `names()` over both. Every other caller of
 * `evaluateExpression` built its own — so an expression could resolve a name
 * in a calculation and not in a condition, which is the precise way two
 * languages grow out of one.
 *
 * This is that resolver, in one place, used by `runCalculations` and by the
 * `expr` condition source. A name means the same thing in both, because it is
 * literally the same function.
 *
 * WHAT IS IN SCOPE, in order:
 *
 *   1. the flat variable map — every question's exported variables, by the
 *      names the Variable Dictionary documents (`Q1`, `Q1_3`, `GRID_r1`, …)
 *   2. calculated variables, including the loop variables `runCalculations`
 *      refreshes on every trigger (`LOOP_BRAND_COUNT`, …)
 *   3. embedded data, last — so a field cannot shadow a real answer, which is
 *      the direction that matters: embedded data arrives from a URL.
 *
 *   0. and FIRST, when the expression runs inside a loop iteration: that
 *      iteration. A question answered in the loop body resolves to this
 *      iteration's answer under its plain code (`Q7`, not `Q7_3` — the
 *      respondent is on iteration 3, the expression should not have to know
 *      that), and the loop's own properties are in scope as `loop.index`,
 *      `loop.count`, `loop.first`, `loop.last`, `loop.code`, `loop.label`,
 *      `loop.<ReferenceColumn>`, the `LOOP_INDEX` / `CURRENT_ITEM` aliases,
 *      and `<outerLoopVar>.<prop>` for an enclosing loop. Without this an
 *      `expr` rule or a calculated question inside a loop read the body's
 *      questions as unanswered on every iteration.
 */
import type { CalcOptions } from "./calc.js";
import { evaluateExpression } from "./calc.js";
import { flattenVariables } from "./flatten.js";
import type { LoopContext, ResponseState } from "./state.js";
import { answerLookupKeys, findLoopScope, getQuestionByCodeOrVar, loopValue } from "./state.js";
import type { SurveyDefinition } from "@rescript/schema";

const LOOP_ALIASES: Record<string, string> = {
  CURRENT_ITEM: "label", CURRENT_ITEM_LABEL: "label", CURRENT_ITEM_CODE: "code",
  LOOP_INDEX: "index", LOOP_COUNT: "count", LOOP_FIRST: "first", LOOP_LAST: "last", LOOP_DEPTH: "depth",
};

/** A name as seen from inside an iteration, or `undefined` when the name is not the loop's to answer. */
export function loopScopedName(def: SurveyDefinition, state: ResponseState, loop: LoopContext, n: string): unknown {
  if (n in LOOP_ALIASES) return loopValue(loop, LOOP_ALIASES[n]);
  const dot = n.indexOf(".");
  if (dot > 0) {
    const head = n.slice(0, dot);
    const prop = n.slice(dot + 1);
    if (head === "loop" || head === "CURRENT_ITEM") return loopValue(loop, prop);
    if (!getQuestionByCodeOrVar(def, head)) {
      const outer = findLoopScope(loop, head);
      if (outer) return loopValue(outer, prop);
    }
    return undefined;
  }
  const q = getQuestionByCodeOrVar(def, n);
  if (!q) return undefined;
  /* only an answer written under an iteration key — a survey-level answer
     keeps resolving through the flat map, with its documented shape */
  for (const k of answerLookupKeys(q.id, loop)) {
    if (k === q.id) break;
    if (state.answers[k] !== undefined) return state.answers[k];
  }
  return undefined;
}

export function calcOptionsFor(def: SurveyDefinition, state: ResponseState, loop?: LoopContext | null): CalcOptions {
  const flat = flattenVariables(def, state);
  const embedded = state.embedded ?? {};
  return {
    resolver: (n: string) => {
      if (loop) {
        const v = loopScopedName(def, state, loop, n);
        if (v !== undefined) return v;
      }
      return n in flat ? flat[n]
        : n in state.calculated ? state.calculated[n]
          : n in embedded ? (embedded as Record<string, unknown>)[n]
            : undefined;
    },
    names: () => [
      ...Object.keys(flat),
      ...Object.keys(state.calculated),
      ...Object.keys(embedded),
    ],
  };
}

/**
 * Evaluate a calc expression, never throwing.
 *
 * A condition is a yes/no question and must always have an answer. An
 * expression that will not parse, references a name that does not exist, or
 * trips the engine's depth or step limit yields `null` — and null fails every
 * comparison in `evaluateRule`, so a broken expression makes its rule FALSE
 * rather than taking the page down. Two of the calc engine's callers had no
 * try/catch at all before the limits were added, which is how a bad
 * expression became a blank screen.
 */
export function safeExpression(
  expression: string,
  def: SurveyDefinition,
  state: ResponseState,
  loop?: LoopContext | null,
): unknown {
  try {
    const v = evaluateExpression(expression, calcOptionsFor(def, state, loop));
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}
