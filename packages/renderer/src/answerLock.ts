/**
 * D12 (audit 2026-10-30): a script cannot lock a respondent out of an answer. Beside the Next / Back protection
 * above, the host refuses `hidden` / `disabled` and the hiding styles (display:none, visibility:hidden|collapse,
 * pointer-events:none) on
 *   - an answer control inside a question card — an option (`[data-rs-el="option"]`), anything inside one, an
 *     input / select / textarea / editable / radio / checkbox / slider, or an element holding one; and
 *   - a whole question card (or anything holding cards) when a question in it is REQUIRED (`data-rs-required`,
 *     drawn by QuestionRenderer; data-rs-* is not a script's to change). Hiding a card that is not required is
 *     allowed — it is the author's choice, and the answer is still validated if one was given.
 * Restyling (colours, borders, classes) stays allowed: that is the point of a UX script.
 */
const ANSWER_CONTROL = '[data-rs-el="option"], input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="slider"], [role="option"], [role="spinbutton"]';
export function answerLockReason(el: Element): string | null {
  const card = el.closest("[data-qid]");
  if (card && card !== el) {
    if (el.matches(ANSWER_CONTROL) || el.closest('[data-rs-el="option"]') || el.querySelector(ANSWER_CONTROL)) return "an answer input — the respondent needs it to answer";
    return null;
  }
  const cards = card === el ? [el] : [...el.querySelectorAll("[data-qid]")];
  if (cards.some((c) => c.getAttribute("data-rs-required") === "1")) return "a required question — the respondent could not answer it and could not move on";
  return null;
}
/** the declarations that would hide or disable an element */
export const HIDING_STYLE = (prop: string, value: string): boolean =>
  (prop === "display" && /\bnone\b/i.test(value)) || (prop === "visibility" && /\b(hidden|collapse)\b/i.test(value)) || (prop === "pointer-events" && /\bnone\b/i.test(value));
