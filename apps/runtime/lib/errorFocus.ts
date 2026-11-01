/**
 * D19 / VA-06 — FOCUS THE FIRST ERROR.
 *
 * When Next / Submit is refused (built-in rules, a script's rs.error, a logic
 * script's error(), a soft warning on its first Next, the section navigator's
 * Submit gate after "go to"), keyboard and screen-reader respondents used to
 * have to hunt for the message: the banner said "please review" and focus
 * stayed on the Next button at the foot of the page. This module decides WHERE
 * focus goes (pure, unit-tested) and moves it there (DOM, browser-tested).
 *
 * The rule:
 *  - only the errors that refused the page count — the blocking ones when there
 *    are any, else the warnings (a soft check refuses only its first Next);
 *  - the first of those questions IN PAGE ORDER, not in error order (built-in
 *    rules come before script errors in the list, but the respondent reads the
 *    page top to bottom);
 *  - an error that names no question on this page (a script's page-level
 *    message) focuses the banner that shows it — only when no question error
 *    exists, since the banner is announced (role=status) anyway and the control
 *    is what the respondent has to fix.
 */

export interface FocusableError {
  questionId: string;
  severity?: "error" | "warning";
}

export type ErrorFocusTarget =
  | { kind: "question"; questionId: string }
  | { kind: "banner" };

export function firstInvalidTarget(errors: readonly FocusableError[], pageQuestionIds: readonly string[]): ErrorFocusTarget | null {
  if (!errors.length) return null;
  const blocking = errors.filter((e) => (e.severity ?? "error") === "error");
  const pool = blocking.length ? blocking : errors;
  const order = new Map(pageQuestionIds.map((id, i) => [id, i]));
  let best: { id: string; at: number } | null = null;
  for (const e of pool) {
    const at = e.questionId ? order.get(e.questionId) : undefined;
    if (at === undefined) continue;
    if (!best || at < best.at) best = { id: e.questionId, at };
  }
  if (best) return { kind: "question", questionId: best.id };
  return { kind: "banner" };
}

/** What counts as "the first focusable control" of a question card. */
export const FOCUSABLE_SELECTOR = [
  "input:not([type=hidden]):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[contenteditable=true]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Whether the respondent asked the system for less motion. */
export function prefersReducedMotion(win: { matchMedia?: (q: string) => { matches: boolean } } | undefined): boolean {
  try { return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/**
 * Move focus to the target and scroll it into view. Returns the element that
 * received focus (for tests and logs), or null when nothing could be found.
 * `root` is the document (or a container holding `#rs-questions` and the banner).
 */
export function focusErrorTarget(root: Document, target: ErrorFocusTarget | null, reducedMotion: boolean): HTMLElement | null {
  if (!target) return null;
  let el: HTMLElement | null = null;
  let scrollTo: HTMLElement | null = null;
  if (target.kind === "question") {
    const card = root.querySelector<HTMLElement>(`#rs-questions [data-qid="${cssEscape(target.questionId)}"]`)
      ?? root.querySelector<HTMLElement>(`[data-qid="${cssEscape(target.questionId)}"]`);
    if (card) {
      scrollTo = card;
      el = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(isShown) ?? null;
      if (!el) {
        // nothing focusable inside (a display-only variant): the card itself, which names its error
        if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
        el = card;
      }
    }
  }
  if (!el) {
    el = root.querySelector<HTMLElement>("[data-testid=rs-error-banner]");
    scrollTo = el;
  }
  if (!el) return null;
  try { scrollTo?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" }); } catch { /* old engines */ }
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  return el;
}

function isShown(el: HTMLElement): boolean {
  if (el.closest("[hidden],[aria-hidden=true]")) return false;
  return el.getClientRects().length > 0;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
