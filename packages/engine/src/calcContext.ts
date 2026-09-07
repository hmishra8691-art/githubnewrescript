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
 */
import type { CalcOptions } from "./calc.js";
import { evaluateExpression } from "./calc.js";
import { flattenVariables } from "./flatten.js";
import type { ResponseState } from "./state.js";
import type { SurveyDefinition } from "@rescript/schema";

export function calcOptionsFor(def: SurveyDefinition, state: ResponseState): CalcOptions {
  const flat = flattenVariables(def, state);
  const embedded = state.embedded ?? {};
  return {
    resolver: (n: string) =>
      n in flat ? flat[n]
        : n in state.calculated ? state.calculated[n]
          : n in embedded ? (embedded as Record<string, unknown>)[n]
            : undefined,
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
): unknown {
  try {
    const v = evaluateExpression(expression, calcOptionsFor(def, state));
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}
