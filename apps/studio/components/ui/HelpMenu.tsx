"use client";
import React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/**
 * HELP → HELP | DEVELOPER DOCS (2026-11-09). The Help entry in the app header and in the Studio opens this menu
 * instead of going straight to the assistant: Help (the assistant and guides) or Developer Docs (the visual feature
 * guides and technical reference at /docs). In the Studio, Help opens the assistant drawer with the project as
 * context and Developer Docs opens in a new tab, so the survey being edited stays open.
 *
 * LAYERING (2026-11-10). The panel used to be positioned inside the header that holds the button. The Studio's top bar
 * is its own stacking context, BELOW the sticky menubar under it, so no z-index on the panel could lift it: its first
 * item opened behind the menubar. The panel is now rendered in a portal on <body>, `position: fixed` at the button's
 * place (below it, aligned left or right as asked, kept inside the window on every side), above every header and
 * menubar (z 180) and below dialogs (190+). It follows the button on scroll and resize, scrolls inside itself when the
 * window is short, and keeps the menu's keyboard behaviour: Escape or a click elsewhere closes it and returns focus,
 * the arrow keys move between the items.
 */
const GAP = 6;
const EDGE = 8;

export function HelpMenu({ className, active, onHelp, docsInNewTab, align = "left", testId = "help-menu" }: {
  className?: string;
  active?: boolean;
  /** open the assistant here (the Studio's drawer); absent = go to /help */
  onHelp?: () => void;
  docsInNewTab?: boolean;
  align?: "left" | "right";
  testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  /* where the panel goes: under the button, aligned as asked, never off the window */
  const place = React.useCallback(() => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(320, vw - EDGE * 2);
    let left = align === "right" ? b.right - width : b.left;
    left = Math.max(EDGE, Math.min(left, vw - width - EDGE));
    const top = Math.min(b.bottom + GAP, vh - 120);
    setPos({ top, left, width, maxHeight: Math.max(120, vh - top - EDGE) });
  }, [align]);

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    const onMove = () => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => { window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) close(false);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(true); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[next].focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", keys); };
  }, [open, close]);

  const panel = open && pos ? (
    <div ref={panelRef} className={`help-menu-panel${align === "right" ? " right" : ""}`} role="menu" data-testid={`${testId}-panel`}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
      {onHelp ? (
        <button type="button" role="menuitem" className="help-menu-item" onClick={() => { setOpen(false); onHelp(); }} data-testid={`${testId}-help`}>
          <b>Help</b><span>Ask the assistant or browse the how-to guides</span>
        </button>
      ) : (
        <a role="menuitem" className="help-menu-item" href="/help" data-testid={`${testId}-help`}>
          <b>Help</b><span>Ask the assistant or browse the how-to guides</span>
        </a>
      )}
      <a role="menuitem" className="help-menu-item" href="/docs" {...(docsInNewTab ? { target: "_blank", rel: "noopener" } : {})} data-testid={`${testId}-docs`} onClick={() => setOpen(false)}>
        <b>Developer Docs</b><span>Every feature in the builder, as code and as respondents see it</span>
      </a>
    </div>
  ) : null;

  return (
    <div className="help-menu" ref={ref} data-testid={testId}>
      <button ref={buttonRef} type="button" className={`${className ?? ""}${active ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} data-testid={`${testId}-button`}>
        <Icon name="help" size={15} /> Help <span className="help-menu-caret" aria-hidden>▾</span>
      </button>
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </div>
  );
}
