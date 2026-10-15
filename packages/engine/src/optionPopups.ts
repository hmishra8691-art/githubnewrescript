import type { Option, OptionPopup, Question, SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import type { LoopContext, ResponseState } from "./state.js";
import { loopKeySuffix } from "./state.js";
import { effectiveQuestion } from "./carryforward.js";

/**
 * A MESSAGE WHEN AN OPTION IS SELECTED.
 *
 * One module answers every question about it, for every renderer: which
 * options carry a message, which of them were JUST selected, which were
 * selected when the respondent pressed Next, and whether a "only once"
 * message has already been shown. The renderer calls these from one place —
 * the question's `onChange` — rather than from the dozen choice renderers, so
 * a single select, a multi select, a dropdown, a button or card variant and an
 * image select behave the same without any of them knowing about it.
 *
 * The message never changes the answer: it is shown, and the selection stays.
 * Deselecting is never an event, because only options ADDED by a change are
 * looked at.
 */

export interface PopupRequest {
  questionId: string;
  code: string;
  /** the question's own text-free identity for "once" tracking */
  key: string;
  title?: string;
  message: string;
  type: OptionPopup["type"];
  trigger: OptionPopup["trigger"];
  frequency: OptionPopup["frequency"];
  /** the accept button, with the default for the type filled in */
  buttonText: string;
}

/** The popup an option carries, when it is switched on and says something. */
export function popupOf(option: Pick<Option, "logic">): OptionPopup | null {
  const p = option.logic?.popup;
  if (!p || !p.enabled || !String(p.message ?? "").trim()) return null;
  return p;
}

/** The codes an answer holds, whatever its shape: a scalar, a list, or nothing. */
export function popupSelectedCodes(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== "").map(String);
  if (typeof value === "object") return [];
  return [String(value)];
}

/** the codes in `next` that `prev` did not hold — what a change ADDED */
export function addedCodes(prev: unknown, next: unknown): string[] {
  const before = new Set(popupSelectedCodes(prev));
  return popupSelectedCodes(next).filter((c) => !before.has(c));
}

/* "only once" is per respondent session and lives in memory: a respondent who reloads sees it once more, which is the safe direction for a message somebody wanted shown */
const seen = new Set<string>();
const seenKey = (sessionId: string, questionId: string, loop: LoopContext | null | undefined, code: string) =>
  `${sessionId}|${questionId}${loopKeySuffix(loop ?? null)}|${code}`;
export const popupSeen = (state: ResponseState, questionId: string, loop: LoopContext | null | undefined, code: string): boolean =>
  seen.has(seenKey(state.sessionId, questionId, loop, code));
export const markPopupSeen = (state: ResponseState, questionId: string, loop: LoopContext | null | undefined, code: string): void => {
  seen.add(seenKey(state.sessionId, questionId, loop, code));
};
/** take a mark back — a confirmation that was cancelled has not been agreed to, so a "once" message must ask again */
export const unmarkPopupSeen = (state: ResponseState, questionId: string, loop: LoopContext | null | undefined, code: string): void => {
  seen.delete(seenKey(state.sessionId, questionId, loop, code));
};
/** forget what was shown (a restarted test run) */
export const resetPopupsSeen = (sessionId?: string): void => {
  if (!sessionId) { seen.clear(); return; }
  for (const k of [...seen]) if (k.startsWith(`${sessionId}|`)) seen.delete(k);
};

const defaultButton = (type: OptionPopup["type"]): string => (type === "confirmation" ? "Continue" : "OK");

function requestsFor(
  def: SurveyDefinition,
  q: Question,
  state: ResponseState,
  loop: LoopContext | null,
  codes: string[],
  trigger: OptionPopup["trigger"],
): PopupRequest[] {
  if (!codes.length) return [];
  const ctx: EvalContext = { def, state, loop };
  /* the options as the respondent sees them — a popup on an option that was excluded is never reachable */
  const options = (effectiveQuestion(q, ctx).options ?? []) as Option[];
  const out: PopupRequest[] = [];
  for (const code of codes) {
    const option = options.find((o) => String(o.code) === code);
    const p = option ? popupOf(option) : null;
    if (!p || p.trigger !== trigger) continue;
    if (p.frequency === "once" && popupSeen(state, q.id, loop, code)) continue;
    out.push({
      questionId: q.id, code, key: seenKey(state.sessionId, q.id, loop, code),
      title: p.title?.trim() || undefined, message: p.message, type: p.type, trigger: p.trigger, frequency: p.frequency,
      buttonText: p.buttonText?.trim() || defaultButton(p.type),
    });
  }
  return out;
}

/** Messages to show NOW, for the options a change just selected. */
export function popupsOnChange(
  def: SurveyDefinition, q: Question, state: ResponseState, loop: LoopContext | null, prev: unknown, next: unknown,
): PopupRequest[] {
  return requestsFor(def, q, state, loop, addedCodes(prev, next), "immediate");
}

/** Messages to show when Next is pressed, for the options that are selected right now. */
export function popupsOnNext(
  def: SurveyDefinition, q: Question, state: ResponseState, loop: LoopContext | null, value: unknown,
): PopupRequest[] {
  return requestsFor(def, q, state, loop, popupSelectedCodes(value), "on_next");
}
