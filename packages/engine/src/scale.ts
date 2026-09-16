import { resolveVariant, type Question } from "@rescript/schema";

/**
 * WHAT SCALE A RATING QUESTION ACTUALLY HAS.
 *
 * There were three answers to that question and they disagreed. The editor's
 * Min and Max were plain unbounded numbers. The renderer clamped what it drew
 * — ten stars, eleven faces — without saying so. The validator checked the
 * answer against whatever the settings held. So a Heart Rating configured
 * 1–50 drew ten hearts, printed "3 / 10" beside them, and would have accepted
 * a 40 posted directly; the scale in the data was not the scale the
 * respondent saw. The September review reported the visible half of that
 * three times, once per rating type.
 *
 * One answer now, in one place. A variant declares what its scale may be
 * (`QuestionVariantDef.scale`), and everything that needs a min and a max —
 * the renderer that draws the symbols, the editor that offers the inputs, the
 * validator that checks the answer, the lint that warns the author — asks
 * here and gets the same pair of numbers.
 *
 * `fixed` means the range is the variant's definition rather than a setting:
 * an NPS that is not 0–10 is not an NPS.
 */

export interface ScaleLimit {
  min: number;
  max: number;
  /** the author cannot change this range — it is what the variant is */
  fixed?: boolean;
}

export interface EffectiveScale {
  min: number;
  max: number;
  /** the declared limit, when this question's variant has one */
  limit?: ScaleLimit;
  /** the stored settings fell outside the limit and were brought inside it */
  clamped: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** The range this question's variant allows, if it declares one. */
export function scaleLimitFor(q: Pick<Question, "variant">): ScaleLimit | undefined {
  return resolveVariant(q.variant ?? undefined)?.scale;
}

/**
 * The min and max to draw, offer and validate against.
 *
 * `fallback` is what the renderer would use with no settings at all, and
 * doubles as the ceiling for LEGACY questions — those authored before
 * variants, which carry no variant id and therefore no declared limit. A
 * pre-existing 1–50 heart rating still cannot draw fifty hearts, so the
 * fallback's max is applied to it; that is the renderer being honest about
 * what it can do rather than clamping in silence.
 */
export function effectiveScale(
  q: Pick<Question, "variant" | "settings">,
  fallback: ScaleLimit,
): EffectiveScale {
  const limit = scaleLimitFor(q) ?? undefined;
  if (limit?.fixed) {
    const clamped =
      (q.settings.minValue != null && q.settings.minValue !== limit.min) ||
      (q.settings.maxValue != null && q.settings.maxValue !== limit.max);
    return { min: limit.min, max: limit.max, limit, clamped };
  }
  const ceiling = limit ?? fallback;
  const rawMin = q.settings.minValue ?? fallback.min;
  const rawMax = q.settings.maxValue ?? fallback.max;
  let min = clamp(rawMin, ceiling.min, ceiling.max);
  let max = clamp(rawMax, ceiling.min, ceiling.max);
  if (max < min) max = min;
  return { min, max, limit, clamped: min !== rawMin || max !== rawMax };
}

/**
 * The bounds the VALIDATOR should use. Only a declared limit narrows them —
 * a plain numeric question has no symbols to run out of, so nothing is
 * imposed on it here.
 */
export function validationBounds(
  q: Pick<Question, "variant" | "settings">,
): { min?: number; max?: number } {
  const limit = scaleLimitFor(q);
  const min = q.settings.minValue;
  const max = q.settings.maxValue;
  if (!limit) return { min: min ?? undefined, max: max ?? undefined };
  if (limit.fixed) return { min: limit.min, max: limit.max };
  return {
    min: min == null ? undefined : clamp(min, limit.min, limit.max),
    max: max == null ? undefined : clamp(max, limit.min, limit.max),
  };
}
