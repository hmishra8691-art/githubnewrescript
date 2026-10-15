import {
  popupsOnChange, markPopupSeen, sanitizeHtml, type PopupRequest,
  type ResponseState, type LoopContext,
} from "@rescript/engine";
import type { Question, SurveyDefinition } from "@rescript/schema";

/**
 * THE MESSAGE ITSELF — a dialog drawn straight onto the page.
 *
 * It is imperative on purpose. The two callers are very different: a question
 * that has just had an option selected (the renderer, mid-event) and a page
 * about to move on (the Runner, mid-async-function, which wants to AWAIT the
 * respondent's answer before it continues). A DOM function that returns a
 * promise serves both; a React component would need state threaded through
 * each, and through every renderer in between.
 *
 * It is drawn inside the question's own card, or the page's question list, so
 * it inherits the survey's theme variables, and it is `position: fixed` so it
 * covers the viewport on a desktop, a tablet and a phone alike.
 *
 * Messages queue: a second request waits for the first to be answered, so two
 * options selected at once are two messages in order, never one on top of the
 * other. Resolves `true` for the accept button, `false` for Cancel, Escape or
 * a click outside (information and warning have no Cancel — Escape and the
 * backdrop simply acknowledge).
 */
let chain: Promise<unknown> = Promise.resolve();

export function showOptionPopup(req: PopupRequest, host?: Element | null): Promise<boolean> {
  const run = () => new Promise<boolean>((resolve) => {
    if (typeof document === "undefined") { resolve(true); return; }
    const root = host ?? document.querySelector(`[data-qid="${CSS.escape(req.questionId)}"]`) ?? document.body;
    const previous = document.activeElement as HTMLElement | null;
    const uid = `rs-popup-${Math.random().toString(36).slice(2, 8)}`;

    const overlay = document.createElement("div");
    overlay.className = "rs-popup-overlay";
    overlay.setAttribute("data-testid", "rs-option-popup");
    overlay.setAttribute("data-popup-type", req.type);
    overlay.setAttribute("data-popup-trigger", req.trigger);
    overlay.setAttribute("data-popup-code", req.code);

    const box = document.createElement("div");
    box.className = `rs-popup rs-popup-${req.type}`;
    box.setAttribute("role", req.type === "information" ? "dialog" : "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-describedby", `${uid}-msg`);
    if (req.title) box.setAttribute("aria-labelledby", `${uid}-title`);

    if (req.title) {
      const h = document.createElement("div");
      h.id = `${uid}-title`;
      h.className = "rs-popup-title";
      h.textContent = req.title;
      box.appendChild(h);
    }
    const msg = document.createElement("div");
    msg.id = `${uid}-msg`;
    msg.className = "rs-popup-message";
    msg.setAttribute("data-testid", "rs-option-popup-message");
    msg.innerHTML = sanitizeHtml(req.message);
    box.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "rs-popup-actions";
    const confirm = req.type === "confirmation";
    let cancelBtn: HTMLButtonElement | null = null;
    if (confirm) {
      cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "rs-btn secondary";
      cancelBtn.setAttribute("data-testid", "rs-option-popup-cancel");
      cancelBtn.textContent = "Cancel";
      actions.appendChild(cancelBtn);
    }
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "rs-btn";
    ok.setAttribute("data-testid", "rs-option-popup-ok");
    ok.textContent = req.buttonText;
    actions.appendChild(ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    root.appendChild(overlay);

    const done = (accepted: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      previous?.focus?.();
      resolve(accepted);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(!confirm); return; }
      if (e.key === "Tab") {
        const focusable = [cancelBtn, ok].filter(Boolean) as HTMLButtonElement[];
        const i = focusable.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        focusable[(i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    ok.addEventListener("click", () => done(true));
    cancelBtn?.addEventListener("click", () => done(false));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(!confirm); });
    ok.focus();
  });
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Show the messages for the options a change just selected. Fire-and-forget:
 * the selection has already been made and stays made whatever is clicked.
 */
export function announceSelection(
  def: SurveyDefinition, q: Question, state: ResponseState, loop: LoopContext | null, prev: unknown, next: unknown,
): void {
  for (const req of popupsOnChange(def, q, state, loop, prev, next)) {
    if (req.frequency === "once") markPopupSeen(state, q.id, loop, req.code);
    void showOptionPopup(req);
  }
}
