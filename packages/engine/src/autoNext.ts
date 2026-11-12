import type { Question, SurveyDefinition } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";
import { isOtherOption } from "./otherSpecify.js";
import { isConsentQuestion } from "./consent.js";

/**
 * AUTO-NEXT (2026-11-07) — "choosing an answer moves the page on", decided in one place for the Runner, the Studio
 * and Intelligent Mode.
 *
 *   setting   the survey's `branding.layout.autoAdvance`, overridden per question by `settings.autoNext`
 *   eligible  a question that takes ONE answer: single choice (list, buttons, cards, dropdown, image, stars, NPS,
 *             yes / no), and a single-choice GRID once every row has its answer. A multi-select, an open end, a
 *             number, a slider, a ranking never move the page: the respondent may still be answering.
 *   page      the page moves on only when EVERY answerable question on it is eligible, switched on and answered —
 *             so a page of three single choices advances after the third, and a page holding a multi-select or an
 *             open end waits for Next. An answer that opens an "Other — specify" box never advances (the box needs
 *             typing).
 */
export type AutoNextKind = "single" | "grid" | null;

const GRID_TYPES = new Set(["matrix_single", "matrix_dropdown"]);
const NEVER = new Set(["slider", "ranking", "image_ranking", "allocation", "open_text", "long_text", "numeric", "date", "time"]);

/** whether — and how — a question can move the page on by itself */
export function autoNextKind(q: Pick<Question, "type" | "variant" | "settings">): AutoNextKind {
  if (NEVER.has(q.type)) return null;
  /* consent is never left by itself: the respondent chooses, then presses Next (consent.ts) */
  if (isConsentQuestion(q as never)) return null;
  if (GRID_TYPES.has(q.type)) return "grid";
  const model = effectiveResponseModel(q);
  if (model !== "single_choice") return null;
  if (q.type === "image_select" && Number((q.settings as { maxSelections?: number }).maxSelections ?? 1) > 1) return null;
  return "single";
}

/** the effective switch for a question: its own override, else the survey's */
export function autoNextOn(def: SurveyDefinition, q: Pick<Question, "type" | "variant" | "settings">): boolean {
  if (!autoNextKind(q)) return false;
  const own = (q.settings as { autoNext?: boolean }).autoNext;
  return own ?? !!(def.branding?.layout as { autoAdvance?: boolean } | undefined)?.autoAdvance;
}

const answered = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Should the page move on now? `questions` = the page's visible questions; `valueOf` reads an answer (loop-aware);
 * `rowsOf` = the rows a grid shows (carry-forward / masking applied).
 */
export function autoNextReady(
  def: SurveyDefinition,
  questions: Question[],
  valueOf: (q: Question) => unknown,
  rowsOf: (q: Question) => { code: string | number }[] = (q) => q.rows,
): boolean {
  const answerable = questions.filter((q) => q.type !== "html" && !(q.settings as { hidden?: boolean }).hidden && !(q.settings as { readOnly?: boolean }).readOnly);
  if (!answerable.length) return false;
  for (const q of answerable) {
    if (!autoNextOn(def, q)) return false;
    const v = valueOf(q);
    if (autoNextKind(q) === "grid") {
      const o = (v ?? {}) as Record<string, unknown>;
      if (typeof o !== "object" || Array.isArray(o)) return false;
      if (!rowsOf(q).every((r) => answered(o[String(r.code)]))) return false;
      continue;
    }
    if (!answered(v) || Array.isArray(v)) return false;
    const chosen = q.options.find((o) => String(o.code) === String(v));
    if (chosen && isOtherOption(chosen)) return false;
  }
  return true;
}
