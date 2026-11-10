"use client";
import React from "react";
import { Icon } from "./Icon";

/**
 * HELP → HELP | DEVELOPER DOCS (2026-11-09). The Help entry in the app header and in the Studio opens this menu
 * instead of going straight to the assistant: Help (the assistant and guides) or Developer Docs (the visual feature
 * guides and technical reference at /docs). In the Studio, Help opens the assistant drawer with the project as
 * context and Developer Docs opens in a new tab, so the survey being edited stays open.
 */
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
  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="help-menu" ref={ref} data-testid={testId}>
      <button type="button" className={`${className ?? ""}${active ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={`${testId}-button`}>
        <Icon name="help" size={15} /> Help <span className="help-menu-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className={`help-menu-panel${align === "right" ? " right" : ""}`} role="menu" data-testid={`${testId}-panel`}>
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
      )}
    </div>
  );
}
