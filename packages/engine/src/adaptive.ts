import type { Condition, Option, Question } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";

/**
 * Two tiny decision functions the 2026-09 variant batch needs on BOTH sides of
 * the wire: the runtime renderer picks with them, and the tests / inspector
 * reproduce the pick from the same inputs. Keeping them here (rather than
 * inside a React component) is what makes an adaptive question and an
 * experiment arm reproducible outside a browser.
 */

/** One alternative presentation of an adaptive question (`settings.adaptive`). */
export interface AdaptiveAlternative {
  label?: string;
  when: Condition;
  text?: string;
  instruction?: string;
  options?: Option[];
  minValue?: number;
  maxValue?: number;
}

/**
 * The alternative that governs an adaptive question right now: the FIRST one
 * whose condition holds, so the author reads the list top-down as a
 * priority order. `undefined` = none matched, i.e. the question as authored.
 */
export function pickAdaptive(
  q: Pick<Question, "settings">,
  ctx: EvalContext,
): AdaptiveAlternative | undefined {
  const alts = q.settings?.adaptive as AdaptiveAlternative[] | undefined;
  if (!Array.isArray(alts)) return undefined;
  for (const alt of alts) {
    if (!alt?.when) continue;
    if (evaluateCondition(alt.when, ctx)) return alt;
  }
  return undefined;
}

/** An adaptive alternative applied to a question — the view the runtime shows. */
export function adaptedQuestion(q: Question, ctx: EvalContext): {
  q: Question;
  alt: AdaptiveAlternative | undefined;
} {
  const alt = pickAdaptive(q, ctx);
  if (!alt) return { q, alt: undefined };
  return {
    alt,
    q: {
      ...q,
      text: alt.text ?? q.text,
      instruction: alt.instruction ?? q.instruction,
      options: alt.options?.length ? alt.options : q.options,
      settings: {
        ...q.settings,
        minValue: alt.minValue ?? q.settings.minValue,
        maxValue: alt.maxValue ?? q.settings.maxValue,
      },
    },
  };
}

export interface ExperimentArm {
  code: string | number;
  label: string;
  weight?: number;
  html?: string;
  mediaUrl?: string;
}

/**
 * Weighted arm assignment from one random draw in [0, 1).
 *
 * A missing weight is 1, so an unweighted list is a uniform draw. A weight of
 * 0 (or a negative one) means "never assign this arm" — the way an author
 * parks a treatment without deleting it. If that leaves nothing assignable at
 * all the list is treated as uniform rather than returning nothing, because a
 * respondent staring at an unassigned experiment is worse than a
 * misconfiguration quietly behaving like an even split.
 */
export function pickArm(
  arms: ReadonlyArray<ExperimentArm> | undefined,
  rand: number,
): ExperimentArm | undefined {
  if (!arms?.length) return undefined;
  const w = (a: ExperimentArm) => {
    const n = a.weight == null ? 1 : Number(a.weight);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  let total = arms.reduce((s, a) => s + w(a), 0);
  const weightOf = total > 0 ? w : () => 1;
  if (total <= 0) total = arms.length;
  const r = (Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 0.999999999) : 0) * total;
  let acc = 0;
  for (const a of arms) {
    acc += weightOf(a);
    if (r < acc) return a;
  }
  return arms[arms.length - 1];
}
