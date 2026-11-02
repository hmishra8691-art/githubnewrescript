import type { Question } from "@rescript/schema";
import { answerKey, type LoopContext, type ResponseState } from "./state.js";
import { isEmptyAnswer } from "./answers.js";

/**
 * "I DON'T KNOW" ON AN OPEN-TEXT OR NUMERIC QUESTION (2026-11-02).
 *
 * The researcher turns it on per question (`settings.dontKnow`); off, nothing about the question changes.
 *
 * ## Where the choice is stored
 *
 * BESIDE the answer, at `<answer key>__dk` = true — the convention `__other__<code>`, `__comment` and `__voice`
 * already use. The answer itself stays what it always was: a string, a number, or absent. "I don't know" is never
 * written into it as text or as a code, so:
 *
 *   - a numeric question's column stays numeric, and a mean, a median or a regression never meets a sentinel 99;
 *   - an open-text column holds what respondents typed, and nothing a coder has to strip out;
 *   - the choice is countable on its own (`<VAR>_DK`), apart from both answers and silence.
 *
 * ## The three states
 *
 *   answered     the answer has a value (whatever `__dk` says — a value always wins, and setAnswer clears `__dk`)
 *   dont_know    no value, `__dk` set
 *   unanswered   neither
 *
 * ## One writer
 *
 * Mutual exclusivity is enforced HERE, not in a renderer: `setAnswer` calls `syncDontKnow`, so an answer typed by
 * any surface — the runtime page, a test respondent, a script — clears the choice; `setDontKnow(…, true)` clears
 * the answer. A response collected before this existed has no `__dk` key and reads exactly as before.
 */

export const DONT_KNOW_SUFFIX = "__dk";

/** the base types that can carry the choice: one typed box, text or a number */
export const DONT_KNOW_TYPES: ReadonlySet<string> = new Set(["open_text", "long_text", "numeric"]);

/** can this question carry an "I don't know" choice at all (whatever its setting)? */
export function dontKnowEligible(q: Pick<Question, "type">): boolean {
  return DONT_KNOW_TYPES.has(q.type);
}

/** is the choice switched on for this question? (eligible type and the researcher's setting) */
export function dontKnowEnabled(q: Pick<Question, "type" | "settings">): boolean {
  return dontKnowEligible(q) && (q.settings as { dontKnow?: boolean } | undefined)?.dontKnow === true;
}

/** the key the choice is stored under, beside the answer's own key */
export function dontKnowKey(questionId: string, loop: LoopContext | null = null): string {
  return `${answerKey(questionId, loop)}${DONT_KNOW_SUFFIX}`;
}

/** did the respondent choose "I don't know" here? (only ever true without an answer) */
export function isDontKnow(state: Pick<ResponseState, "answers">, q: Pick<Question, "id">, loop: LoopContext | null = null): boolean {
  const answers = state.answers as Record<string, unknown>;
  return answers[dontKnowKey(q.id, loop)] === true && isEmptyAnswer(answers[answerKey(q.id, loop)] as never);
}

export type ResponseStatus = "answered" | "dont_know" | "unanswered";

/** the question's response status, from the stored answer and the choice beside it */
export function responseStatus(state: Pick<ResponseState, "answers">, q: Pick<Question, "id">, loop: LoopContext | null = null): ResponseStatus {
  const v = (state.answers as Record<string, unknown>)[answerKey(q.id, loop)];
  if (!isEmptyAnswer(v as never)) return "answered";
  return isDontKnow(state, q, loop) ? "dont_know" : "unanswered";
}

/**
 * Choose (or un-choose) "I don't know". Choosing it removes the answer — the two are never stored together — and
 * is refused (returns false) on a question that does not offer the choice, so a crafted call cannot attach it to
 * a single-choice question or one whose setting is off.
 */
export function setDontKnow(state: ResponseState, q: Question, on: boolean, loop: LoopContext | null = null): boolean {
  const answers = state.answers as Record<string, unknown>;
  const k = dontKnowKey(q.id, loop);
  if (!on) { delete answers[k]; return true; }
  if (!dontKnowEnabled(q)) return false;
  delete answers[answerKey(q.id, loop)];
  answers[k] = true;
  return true;
}

/**
 * Called by `setAnswer` after every answer write: an answer with a value clears the choice beside it, and a choice
 * left on a question that no longer offers it (the researcher turned it off) is dropped the next time that
 * question is answered. An EMPTY write leaves the choice alone — `setDontKnow` empties the answer itself.
 */
export function syncDontKnow(state: ResponseState, q: Question, loop: LoopContext | null = null): void {
  const answers = state.answers as Record<string, unknown>;
  const k = dontKnowKey(q.id, loop);
  if (!(k in answers)) return;
  if (!isEmptyAnswer(answers[answerKey(q.id, loop)] as never) || !dontKnowEnabled(q)) delete answers[k];
}
