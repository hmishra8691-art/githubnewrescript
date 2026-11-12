/**
 * THE ONLY ANSWER THERE IS (2026-11-12).
 *
 * A required single-choice, multiple-choice or ranking question that, for THIS respondent, shows exactly one ordinary answer has
 * nothing to ask: ticking the one box, or ranking the one item first, is the only response the page would accept.
 * The engine gives that answer itself, records that it did, and does not show the question. Display logic, masks,
 * carry-forward and list fills are all "how the list got short" — the rule reads the list the respondent would
 * have seen, whatever shortened it.
 *
 * It stays a question for a person whenever there is a choice to make:
 *   - more than one answer is shown — including "one brand + None of these" or "one brand + Other";
 *   - the one answer shown is itself special (exclusive, other-specify): leaving it and taking it are different;
 *   - the question is optional — not answering is a valid response, and the engine does not answer for anyone;
 *   - the question was WRITTEN with a single answer (a consent box, an acknowledgement): ticking it is the point;
 *   - the programmer already codes it (auto-punch rules, a default value) or made it read-only / hidden;
 *   - a ranking or selection rule asks for more than one (min selections > 1): one answer would not be valid.
 *
 * The answer is written like any other (`state.answers`), so logic, quotas, piping and exports read it; the keys
 * the engine answered are kept in `state.meta.__auto`, which is how a dataset tells them from the respondent's.
 * When the list grows again (the respondent goes back and changes what narrowed it) the engine's answer is
 * withdrawn and the question is asked.
 */
import type { Question, SurveyDefinition } from "@rescript/schema";
import type { AnswerValue, ResponseState } from "./state.js";
import { answerKey } from "./state.js";
import type { EvalContext } from "./evaluate.js";
import { effectiveQuestion } from "./carryforward.js";
import { effectiveResponseModel } from "@rescript/schema";
import { isConsentQuestion } from "./consent.js";

const AUTO_KEY = "__auto";

/** the answer keys the engine answered itself (for exports and the test console) */
export function autoAnswered(state: Pick<ResponseState, "meta">): string[] {
  const v = state.meta?.[AUTO_KEY];
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * WHAT THE RULE DOES ON THIS QUESTION — selection and skipping are separate decisions (2026-11-12):
 *   "skip"    (default) the engine answers and the question is not shown — the page moves past it
 *   "select"  the engine answers, the question is SHOWN with the answer in place, and the respondent presses Next
 *   "ask"     the engine does nothing: the respondent answers a one-answer question themselves
 */
export type SingleOptionMode = "skip" | "select" | "ask";
export function singleOptionMode(q: Pick<Question, "settings">): SingleOptionMode {
  const m = (q.settings as { singleOption?: string } | undefined)?.singleOption;
  return m === "select" || m === "ask" ? m : "skip";
}

/** the engine answered it AND it is not shown (the "skip" mode) */
export function forcedAndHidden(q: Question, ctx: EvalContext): boolean {
  return singleOptionMode(q) === "skip" && forcedSingleAnswer(q, ctx) !== undefined;
}

const SPECIAL = new Set(["exclusive", "other_specify", "none_of_above", "dont_know", "refused"]);

/** could this question ever be answered by the engine? — the cheap test, before any list is worked out */
function eligible(q: Question): boolean {
  if (!q.required || q.settings?.hidden || q.settings?.readOnly) return false;
  /* consent is given by the respondent, never by the engine (consent.ts); "ask" is the author switching the rule off here */
  if (singleOptionMode(q) === "ask" || isConsentQuestion(q)) return false;
  if (q.type === "hidden" || q.type === "calculated") return false;
  if (q.punches?.length) return false;
  const dv = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue;
  if (dv !== undefined && dv !== null && dv !== "") return false;
  if ((q.rows?.length ?? 0) > 0 || q.carryForward?.into === "rows") return false;
  const model = effectiveResponseModel(q);
  if (model !== "multiple_choice" && model !== "rank_order" && model !== "single_choice") return false;
  if ((q.validation ?? []).some((v) => v.kind === "min_selections" && Number((v as { value?: unknown }).value) > 1)) return false;
  if (Number((q.settings as { minSelections?: unknown } | undefined)?.minSelections) > 1) return false;
  /*
   * Only a list that something SHORTENED. A question written with one answer ("I agree", "I have read this") is a
   * deliberate act the respondent must perform — the engine never performs it for them — and a fixed list of two or
   * more that nothing can shorten is never a single.
   */
  const carried = !!q.carryForward;
  const narrowable = !!(q as { mask?: unknown }).mask || (q.listLogic?.length ?? 0) > 0 || (q.optionPipeline?.length ?? 0) > 0 || (q.options ?? []).some((o) => !!o.visibleIf || !!(o as { logic?: unknown }).logic);
  return carried || (narrowable && (q.options?.length ?? 0) >= 2);
}

/**
 * The answer the engine gives, or undefined when the question is one for the respondent.
 * `ctx.loop` is the iteration the question is being asked in.
 */
export function forcedSingleAnswer(q: Question, ctx: EvalContext): AnswerValue | undefined {
  if (!eligible(q)) return undefined;
  let shown: Question["options"];
  try { shown = effectiveQuestion(q, ctx).options; } catch { return undefined; }
  if (shown.length !== 1) return undefined;
  const only = shown[0];
  if ((only.flags ?? []).some((f) => SPECIAL.has(f))) return undefined;
  /* a single choice holds the code itself; a multiple choice and a ranking hold a list */
  return (effectiveResponseModel(q) === "single_choice" ? only.code : [only.code]) as AnswerValue;
}

/**
 * Give (or withdraw) the engine's answers for these questions. Returns the ids it answers now.
 * A question the respondent already answered differently is theirs: it is not touched unless the engine gave it.
 */
export function applyForcedAnswers(def: SurveyDefinition, questions: Question[], ctx: EvalContext): string[] {
  const state = ctx.state;
  const mine = new Set(autoAnswered(state));
  const now: string[] = [];
  for (const q of questions) {
    const key = answerKey(q.id, ctx.loop ?? null);
    const forced = forcedSingleAnswer(q, ctx);
    if (forced !== undefined) {
      state.answers[key] = forced;
      mine.add(key);
      now.push(q.id);
    } else if (mine.has(key)) {
      /* the list is no longer one answer long: what the engine wrote is not the respondent's, so it goes */
      delete state.answers[key];
      mine.delete(key);
    }
  }
  if (mine.size || state.meta?.[AUTO_KEY]) (state.meta ??= {})[AUTO_KEY] = [...mine].slice(-5000);
  void def;
  return now;
}
