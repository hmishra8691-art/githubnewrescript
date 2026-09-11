import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import { answerKey, type LoopContext, type ResponseState } from "./state.js";

/**
 * "OTHER, SPECIFY" — ONE IDENTITY PER FIELD.
 *
 * Every other-specify box belongs to exactly one question, in exactly one loop
 * iteration, and its text is stored under exactly one key:
 *
 *     `${answerKey(questionId, loop)}__other`      q_abc__other · q_abc@apple__other
 *
 * That key was already the storage contract, but it was spelled by hand at
 * nine call sites across three packages — the runtime runner, the renderer's
 * callers, the validator, the flattener, the exporter — and one of them
 * spelling it differently is exactly how a respondent's text for Apple once
 * appeared under Google. This module is the only place the key is built, so
 * they cannot drift again, and it carries the three operations that go with
 * it: read, write, and the housekeeping nobody was doing.
 *
 * THE HOUSEKEEPING. Text typed into an other box and then abandoned — the
 * respondent unticks "Other" and picks "Blue" instead — used to stay in the
 * response for ever: exported, analysed, and shown again on the way back.
 * `syncOtherText` removes it the moment no selected option carries the flag,
 * and `setAnswer` calls it, so every surface that answers a question through
 * the engine gets it for free.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a per-option store. An option's
 * `other_specify` flag makes the question's box appear; a question shows one
 * box, whichever flagged option is chosen, and stores one string — which is
 * what the dictionary declares (`VAR_other`) and what every export, analysis
 * and downstream tool already expects. Two flagged options in one question
 * (say "Other brand" and "Other flavour") share that box by design; giving
 * each its own would change the response model and every file built from it.
 */

/** The flag that makes an option carry an other-specify box. */
export const OTHER_SPECIFY_FLAG = "other_specify";

export function isOtherOption(o: Option): boolean {
  return !!o.flags?.includes(OTHER_SPECIFY_FLAG);
}

/** THE key an other-specify text is stored under. Nothing else may spell it. */
export function otherKey(questionId: string, loop?: LoopContext | null): string {
  return `${answerKey(questionId, loop ?? null)}__other`;
}

/** The text a respondent typed into this question's other box, in this iteration. */
export function otherTextOf(state: ResponseState, questionId: string, loop?: LoopContext | null): string {
  const v = state.answers[otherKey(questionId, loop)];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Store it. An empty string removes the key rather than storing "" — an absent answer, not a blank one. */
export function setOtherText(state: ResponseState, questionId: string, text: string, loop?: LoopContext | null): void {
  const key = otherKey(questionId, loop);
  if (text === "") delete state.answers[key];
  else state.answers[key] = text as never;
}

/** Does this answer select an option flagged `other_specify`? */
export function otherIsSelected(q: Question, answer: unknown): boolean {
  const flagged = q.options.filter(isOtherOption);
  if (!flagged.length) return false;
  if (answer == null || answer === "") return false;
  const codes = new Set(flagged.map((o) => String(o.code)));
  if (Array.isArray(answer)) return answer.some((v) => codes.has(String(v)));
  if (typeof answer === "object") {
    // per-row grids: any row whose value (or array of values) names a flagged option
    for (const v of Object.values(answer as Record<string, unknown>)) {
      if (Array.isArray(v) ? v.some((x) => codes.has(String(x))) : codes.has(String(v))) return true;
    }
    return false;
  }
  return codes.has(String(answer));
}

/**
 * Drop abandoned other text. Called by `setAnswer` for the question just
 * answered, so an unticked "Other" takes its text with it — in the runtime,
 * in the Studio's simulator, and in anything else that answers through the
 * engine. Returns true when something was removed.
 */
export function syncOtherText(state: ResponseState, q: Question, loop?: LoopContext | null): boolean {
  const key = otherKey(q.id, loop);
  if (state.answers[key] === undefined) return false;
  if (otherIsSelected(q, state.answers[answerKey(q.id, loop ?? null)])) return false;
  delete state.answers[key];
  return true;
}

/**
 * Every other-specify text in a response, keyed by the question it belongs to
 * — for storage, export and analysis, where "which question was this typed
 * into" is the whole question. Loop iterations are reported separately, with
 * the iteration path, because they are separate answers.
 */
export interface OtherSpecifyEntry {
  questionId: string;
  /** the variable this question writes, for the column name */
  variableName: string;
  /** the loop suffix, "" outside a loop (e.g. "@apple") */
  iteration: string;
  text: string;
}

export function otherSpecifyEntries(def: SurveyDefinition, state: ResponseState): OtherSpecifyEntry[] {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const out: OtherSpecifyEntry[] = [];
  for (const [key, value] of Object.entries(state.answers)) {
    if (!key.endsWith("__other") || typeof value !== "string" || !value) continue;
    const base = key.slice(0, -"__other".length);
    const at = base.indexOf("@");
    const questionId = at < 0 ? base : base.slice(0, at);
    const q = byId.get(questionId);
    if (!q) continue;
    out.push({ questionId, variableName: q.variableName, iteration: at < 0 ? "" : base.slice(at), text: value });
  }
  return out;
}
