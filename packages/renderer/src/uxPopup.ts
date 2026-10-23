import type { UxEffect } from "@rescript/schema";

/**
 * THE SURVEY'S OWN POPUP — what the `show_popup` effect and a script's `rs.popup` open, so neither a
 * model nor a programmer ever hand-builds an overlay again (P3, 2026-10-17: "when Q3 has option 1
 * selected, display a popup" produced a fixed div on the body with its own timers that never closed
 * when the answer changed — one sat in the far left corner of the screen).
 *
 *   center    a modal over the survey: role="dialog" + aria-modal, focus moved in and kept there,
 *             given back on close, Escape and the close button close it (when it may be closed)
 *   anchored  a non-modal bubble next to its target element (below it, above when there is no room),
 *             kept in place when the page re-renders or the window is resized
 *   top       a non-modal banner at the top of the screen
 *   inline    a non-modal box in the question's card, beside the answers
 *
 * It is drawn INSIDE the survey shell (`root`), so it takes the survey's theme variables and, in the
 * Studio's preview (whose shell is a containing block), never covers the Studio. One per owner: a
 * second open from the same behaviour replaces the first. Every popup returns its own close, which
 * the UX layer's hold/undo machinery calls when the condition that opened it stops — the close
 * removes exactly that popup, never a newer one with the same owner. Text only, never HTML.
 */

export interface UxPopupOptions {
  root: HTMLElement;
  /** the behaviour (or script) it belongs to: one popup per owner */
  owner: string;
  /** what anchored / inline placement is placed against */
  anchor?: HTMLElement | null;
  effect: Pick<UxEffect, "text" | "title" | "placement" | "dismiss" | "autoMs">;
  /**
   * #14c (2026-10-22): the popup's own words in the respondent's language — its close button's label and the name a
   * popup with no title is announced by (engine `popupUiFor`: the survey's translation, else the built-in text for the
   * language, else English) — and the writing direction (absent: read from the shell's `dir`).
   */
  labels?: { close?: string; message?: string; dir?: "ltr" | "rtl" };
}

interface Open { el: HTMLElement; owner: string; modal: boolean; dismissable: boolean; close: () => void; place?: () => void }
/** every open popup, most recent last — Escape closes the top dismissable one */
const stack: Open[] = [];
const byElement = new WeakMap<Element, Open>();
let uid = 0;
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function onKey(ev: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (ev.key === "Escape") {
    // a modal one first (it is what holds the page), else the most recent one that may be closed
    const open = [...stack].reverse().filter((p) => p.dismissable);
    const target = open.find((p) => p.modal) ?? open[0];
    if (target) { ev.stopPropagation(); target.close(); }
    return;
  }
  if (ev.key === "Tab" && top.modal) {
    // focus stays inside a modal popup
    const f = [...top.el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled"));
    const box = top.el.querySelector<HTMLElement>(".rs-ux-popup");
    if (!f.length) { ev.preventDefault(); box?.focus(); return; }
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); f[f.length - 1]!.focus(); }
    else if (!ev.shiftKey && (i === f.length - 1 || i < 0)) { ev.preventDefault(); f[0]!.focus(); }
  }
}
function onResize() { for (const p of stack) p.place?.(); }
function listen(on: boolean) {
  if (typeof document === "undefined") return;
  if (on && stack.length === 1) { document.addEventListener("keydown", onKey, true); window.addEventListener("resize", onResize); }
  if (!on && stack.length === 0) { document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", onResize); }
}

/** the question card an inline popup goes into (an option or a row is inside one) */
function cardOf(el: HTMLElement | null | undefined): HTMLElement | null {
  if (!el) return null;
  return el.closest<HTMLElement>('[data-rs-el="question"]') ?? null;
}

/** open a popup; returns how to close exactly this one */
export function openUxPopup(o: UxPopupOptions): () => void {
  if (typeof document === "undefined") return () => {};
  const e = o.effect;
  let placement = e.placement ?? "center";
  const card = placement === "inline" ? cardOf(o.anchor) : null;
  // nothing to place it against on this page: the respondent still sees it, centred
  if ((placement === "anchored" && !o.anchor) || (placement === "inline" && !card)) placement = "center";
  const dismiss = e.dismiss ?? "button";
  const dismissable = dismiss !== "none" || placement === "center";
  const modal = placement === "center";

  // one per owner: the one already open is replaced
  for (const p of [...stack]) if (p.owner === o.owner && o.root.contains(p.el)) p.close();

  const id = `rs-ux-popup-${++uid}`;
  /* right to left: the shell's direction (an Urdu or Arabic survey), so the close button and an anchored bubble sit on the reading side */
  const dir = o.labels?.dir ?? ((o.root.closest("[dir]")?.getAttribute("dir") === "rtl" || (typeof getComputedStyle === "function" && getComputedStyle(o.root).direction === "rtl")) ? "rtl" : "ltr");
  const outer = document.createElement("div");
  outer.setAttribute("dir", dir);
  outer.className = `rs-ux-popup-${placement}${modal ? " rs-ux-popup-layer" : ""}`;
  outer.setAttribute("data-rs-ux-popup", o.owner);
  outer.setAttribute("data-placement", placement);
  outer.setAttribute("data-testid", "rs-ux-popup");
  const box = document.createElement("div");
  box.className = "rs-ux-popup";
  box.setAttribute("role", "dialog");
  if (modal) box.setAttribute("aria-modal", "true");
  box.setAttribute("tabindex", "-1");
  box.setAttribute("aria-describedby", `${id}-text`);
  if (e.title) {
    const h = document.createElement("div");
    h.id = `${id}-title`; h.className = "rs-ux-popup-title"; h.textContent = e.title;
    box.setAttribute("aria-labelledby", h.id);
    box.appendChild(h);
  } else box.setAttribute("aria-label", o.labels?.message || "Message");
  const text = document.createElement("div");
  text.id = `${id}-text`; text.className = "rs-ux-popup-text"; text.textContent = e.text ?? "";
  // a non-modal popup is announced; a modal one is read when focus moves into it
  if (!modal) text.setAttribute("aria-live", "polite");
  box.appendChild(text);
  let closeBtn: HTMLButtonElement | null = null;
  if (dismissable && dismiss !== "auto") {
    closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rs-ux-popup-close";
    closeBtn.setAttribute("aria-label", o.labels?.close || "Close");
    closeBtn.setAttribute("title", o.labels?.close || "Close");
    closeBtn.setAttribute("data-testid", "rs-ux-popup-close");
    closeBtn.textContent = "×";
    box.appendChild(closeBtn);
  }
  outer.appendChild(box);
  if (!reducedMotion()) outer.setAttribute("data-rs-ux-anim", "");

  const previous = modal ? (document.activeElement as HTMLElement | null) : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const entry: Open = {
    el: outer, owner: o.owner, modal, dismissable,
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      listen(false);
      const hadFocus = outer.contains(document.activeElement);
      outer.remove();
      if (modal && hadFocus && previous && previous.isConnected) previous.focus?.({ preventScroll: true });
    },
  };
  byElement.set(outer, entry);
  closeBtn?.addEventListener("click", (ev) => { ev.stopPropagation(); entry.close(); });
  // a click on the backdrop of a modal closes it (when it may be closed); a click inside never reaches the survey's options
  if (modal) outer.addEventListener("mousedown", (ev) => { if (ev.target === outer && dismissable) entry.close(); });

  if (placement === "inline") card!.appendChild(outer);
  else o.root.appendChild(outer);

  if (placement === "anchored") {
    const anchor = o.anchor!;
    outer.style.left = "0px"; outer.style.top = "0px"; // measured from its containing block's corner
    entry.place = () => {
      if (!anchor.isConnected || !outer.isConnected) return;
      // where its containing block starts, from where it is now (the shell, or the Studio preview's frame)
      const now = outer.getBoundingClientRect();
      const origin = { left: now.left - (parseFloat(outer.style.left) || 0), top: now.top - (parseFloat(outer.style.top) || 0) };
      const a = anchor.getBoundingClientRect();
      const r = o.root.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
      const w = outer.offsetWidth, h = outer.offsetHeight;
      const minX = Math.max(8, r.left + 4), maxX = Math.min(vw - 8, r.right - 4);
      /* left to right: from the anchor's left edge; right to left: from its right edge */
      let x = Math.min(Math.max(dir === "rtl" ? a.right - w : a.left, minX), Math.max(minX, maxX - w));
      const below = a.bottom + 8, above = a.top - 8 - h;
      const y = below + h > vh - 8 && above >= 8 ? above : below;
      const side = y === below ? "below" : "above";
      if (outer.getAttribute("data-side") !== side) outer.setAttribute("data-side", side);
      if (!Number.isFinite(x)) x = a.left;
      const left = `${Math.round(x - origin.left)}px`, top = `${Math.round(y - origin.top)}px`;
      // only when it moved: a style write is a mutation every observer of the page hears
      if (outer.style.left !== left) outer.style.left = left;
      if (outer.style.top !== top) outer.style.top = top;
    };
    entry.place();
  }

  stack.push(entry);
  listen(true);
  if (dismiss === "auto") timer = setTimeout(entry.close, Math.max(1000, Math.min(60000, e.autoMs ?? 5000)));
  if (modal) (closeBtn ?? box).focus({ preventScroll: true });
  return entry.close;
}

/** close the popups in a shell — every one, or one owner's */
export function closeUxPopups(root: HTMLElement, owner?: string): void {
  for (const el of Array.from(root.querySelectorAll("[data-rs-ux-popup]"))) {
    if (owner != null && el.getAttribute("data-rs-ux-popup") !== owner) continue;
    const p = byElement.get(el);
    if (p) p.close(); else el.remove();
  }
}

/** keep anchored popups next to their target after the page re-rendered */
export function placeUxPopups(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('[data-rs-ux-popup][data-placement="anchored"]'))) byElement.get(el)?.place?.();
}
