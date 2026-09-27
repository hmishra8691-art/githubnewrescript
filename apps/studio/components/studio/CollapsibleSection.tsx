"use client";
import React from "react";
import { useMode } from "./ModeContext";

export interface CollapsibleSectionProps {
  /**
   * Stable id for this section — used for its test ids. Sections are keyed
   * by this id alone (not by which question is selected), so a programmer
   * who collapses "Custom code" once keeps it collapsed while clicking
   * through other questions too — the same "it's a preference" behavior
   * `QuestionsPanel.tsx`'s block collapse already has.
   */
  id: string;
  title: string;
  /**
   * True when the section already carries configuration. Used ONLY to pick
   * the section's INITIAL open/closed state (req §39: "only open sections
   * actively being configured or already containing configuration") — once
   * the programmer has toggled a section by hand, that choice is theirs and
   * is never overridden by `active` changing later.
   */
  active?: boolean;
  /** Force the initial state instead of deriving it from `active`. */
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * One independently collapsible section of the Properties panel (Part B,
 * §36–§45).
 *
 * Modeled directly on `QuestionsPanel.tsx`'s existing block collapse — same
 * `▸`/`▾` glyph toggle, same "collapsed content is not rendered, not just
 * hidden" behavior — rather than inventing a new visual language. The
 * properties panel gets its own `.psec`/`.psec-head`/`.psec-toggle` CSS
 * family, siblings of that file's `.block`/`.block-head`/`.block-toggle`.
 *
 * WHY LOCAL STATE, NOT A STORE SLICE: expand/collapse is a UI preference
 * that "must not alter survey logic" (§45) — it must never be written into
 * `def`, must never touch undo history, and must never be part of what an
 * autosave persists to the server. A plain `useState` here satisfies all
 * three by construction, and it is the exact mechanism `QuestionsPanel.tsx`
 * already uses for the identical problem, so this follows established
 * precedent rather than adding a new, parallel place state can live.
 *
 * The "configured" indicator is a glyph (●) with `aria-label="configured"`,
 * not a color alone (§40's accessibility note) — a section that is
 * collapsed but has something in it still says so in text, not just tint.
 */
export function CollapsibleSection({ id, title, active, defaultOpen, children }: CollapsibleSectionProps) {
  const [open, setOpen] = React.useState(() => defaultOpen ?? active ?? false);
  const ref = React.useRef<HTMLDivElement>(null);

  /*
   * REVEALED FROM ELSEWHERE: Grid's Display-logic cell, Architect's logic
   * chips and Flow's inspector ask for a section by id (`requestPanel`). The
   * section opens and scrolls into view; the programmer's own toggle is
   * otherwise untouched. `nonce` makes the same request twice scroll twice.
   */
  const reveal = useMode()?.reveal ?? null;
  const last = React.useRef<number>(0);
  React.useEffect(() => {
    if (!reveal || reveal.section !== id || reveal.nonce === last.current) return;
    last.current = reveal.nonce;
    setOpen(true);
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: "start", behavior: "auto" }), 0);
    return () => clearTimeout(t);
  }, [reveal, id]);

  return (
    <div className={`psec${open ? "" : " collapsed"}`} data-testid={`psec-${id}`} ref={ref}>
      <div className="psec-head" data-testid={`psec-head-${id}`}
        role="button" tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}>
        <button className="psec-toggle" type="button" tabIndex={-1}
          title={open ? "Collapse section" : "Expand section"}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
          {open ? "▾" : "▸"}
        </button>
        <span className="psec-title">{title}</span>
        {active && (
          <span className="psec-dot" data-testid={`psec-active-${id}`}
            aria-label="configured" title="This section has configuration">●</span>
        )}
      </div>
      {open && <div className="psec-body" data-testid={`psec-body-${id}`}>{children}</div>}
    </div>
  );
}
