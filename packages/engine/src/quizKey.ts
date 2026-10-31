import type { Question, SurveyDefinition } from "@rescript/schema";

/**
 * D14 / GA-03 (S4a, 2026-10-31) — ONE ANSWER KEY.
 *
 * The quiz variant (`gamified.quiz`) used to read its key from `option.meta.correct` while assessments (2026-10-29)
 * keep it in `question.assessment.correct`. The two never met: a quiz keyed through Properties → Assessment or IM
 * `set_answer_key` had no feedback and `_CORRECT` was always 0; a quiz keyed both ways lost its key on a live paper
 * and showed respondents the author hint. Now:
 *
 *   - `question.assessment` is THE key; `meta.correct` is a legacy fallback read only when there is no assessment;
 *   - `migrateQuizKeys` moves `meta.correct` into `assessment.correct` (on load in the Studio and before a respondent
 *     payload is built) — idempotent, never touching a stripped (`withheld`) question;
 *   - `quizKey` tells the renderer what it may use: the codes, or `withheld` (the respondent's copy has no key — the
 *     quiz then renders as a plain single choice with no feedback and no author hint);
 *   - `quizCorrectValue` is the `_CORRECT` export computed on the SERVER from the stored definition, never the
 *     browser's `__correct`.
 */
export const QUIZ_VARIANT = "gamified.quiz";

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true" || v === "yes";

export const isQuiz = (q: Pick<Question, "variant">): boolean => q.variant === QUIZ_VARIANT;

export interface QuizKey {
  /** the correct option codes, as strings ([] when none or withheld) */
  codes: string[];
  /** the respondent's copy: the key exists but was stripped (`stripAssessmentSecrets`) */
  withheld: boolean;
  source: "assessment" | "meta" | "none";
}

export function quizKey(q: Question): QuizKey {
  const a = q.assessment;
  if (a?.withheld) return { codes: [], withheld: true, source: "assessment" };
  const fromAssessment = (a?.correct ?? []).map(String);
  if (fromAssessment.length) return { codes: fromAssessment, withheld: false, source: "assessment" };
  const fromMeta = (q.options ?? []).filter((o) => truthy(o.meta?.correct)).map((o) => String(o.code));
  if (fromMeta.length) return { codes: fromMeta, withheld: false, source: "meta" };
  return { codes: [], withheld: false, source: "none" };
}

/**
 * Move every quiz's `meta.correct` into `question.assessment.correct`. A question that already has an assessment key
 * keeps it (the assessment wins) and only loses the stale `meta.correct`. Returns the SAME object when nothing
 * changes, a copy otherwise — so a second run is a no-op (idempotent).
 */
export function migrateQuizKeys<T extends SurveyDefinition>(def: T): { def: T; migrated: string[] } {
  const needs = (q: Question) => isQuiz(q) && !q.assessment?.withheld && (q.options ?? []).some((o) => o.meta && "correct" in o.meta);
  if (!(def.questions ?? []).some(needs)) return { def, migrated: [] };
  const out = structuredClone(def) as T;
  const migrated: string[] = [];
  for (const q of out.questions) {
    if (!needs(q)) continue;
    const codes = (q.options ?? []).filter((o) => truthy(o.meta?.correct)).map((o) => o.code);
    const had = (q.assessment?.correct ?? []).length > 0;
    if (!had && codes.length) q.assessment = { ...(q.assessment ?? {}), correct: codes } as Question["assessment"];
    for (const o of q.options ?? []) {
      if (!o.meta || !("correct" in o.meta)) continue;
      const { correct: _c, ...rest } = o.meta as Record<string, unknown>;
      if (Object.keys(rest).length) o.meta = rest; else delete o.meta;
    }
    migrated.push(String(q.code));
  }
  return { def: out, migrated };
}

/** `<VAR>_CORRECT` for a quiz, from the key the server holds: 1 / 0, null unanswered; undefined = no key to grade by */
export function quizCorrectValue(q: Question, answer: unknown): 0 | 1 | null | undefined {
  const k = quizKey(q);
  if (k.withheld || !k.codes.length) return undefined;
  if (answer === undefined || answer === null || answer === "") return null;
  const picked = Array.isArray(answer) ? answer.map(String) : [String(answer)];
  if (k.codes.length > 1 || picked.length > 1) return picked.length === k.codes.length && picked.every((c) => k.codes.includes(c)) ? 1 : 0;
  return k.codes.includes(picked[0]) ? 1 : 0;
}
