"use client";
import React from "react";
import { useMode } from "./ModeContext";
import { Icon } from "../ui/Icon";
import type { ProgrammingMode } from "../../lib/programmingMode";

/**
 * THE ONBOARDING CHOOSER — "How do you want to program your research?"
 *
 * Five cards, one survey. Shown once, the first time this browser opens
 * the programming tabs without a `?mode=` link or a remembered choice; a
 * card picks the mode and the chooser is remembered as seen. It is not a
 * gate — Escape, the backdrop or "Start in Studio" all dismiss it — and it
 * can be reopened from the selector's ⓘ or ⌘K "Choose how to program…",
 * because the answer is not permanent: the point of five environments is
 * that a person changes their mind between Tuesday and Wednesday.
 */

const GLYPH: Record<ProgrammingMode, React.ReactNode> = {
  studio: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16M9 10v9" /></>,
  grid: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M3 10h18M3 14.5h18M8.5 5v14M14 5v14" /></>,
  architect: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M8 5v14M16 5v14M10 9h4M10 12h4" /></>,
  flow: <><rect x="9" y="3" width="6" height="4" rx="1" /><rect x="3" y="15" width="6" height="4" rx="1" /><rect x="15" y="15" width="6" height="4" rx="1" /><path d="M12 7v3M12 10L6 15M12 10l6 5" /></>,
  intelligent: <><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" /><path d="M5 17l.8 1.8L7.5 19.5l-1.7.7L5 22l-.8-1.8-1.7-.7 1.7-.7z" /><path d="M18.5 15l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /></>,
};

const DETAIL: Record<ProgrammingMode, string[]> = {
  studio: ["Cards, panels and pickers", "Every property in one place", "Drag to reorder"],
  grid: ["One row per question", "Type across the sheet", "Bulk edit, sort and filter"],
  architect: ["Survey map · workspace · inspector", "Dependencies of anything selected", "Focus on what matters"],
  flow: ["Branches, loops, skips as a canvas", "What can reach this, what this affects", "Debug a respondent's path"],
  intelligent: ["Say the change in plain language", "Review the exact rule before it applies", "Nothing is written without Apply"],
};

export function ModeChooser() {
  const m = useMode();
  const first = React.useRef<HTMLButtonElement>(null);
  const open = m?.chooserOpen ?? false;

  React.useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); m?.closeChooser(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, m]);

  if (!m || !open) return null;
  const pick = (id: ProgrammingMode) => { m.setMode(id); m.closeChooser(); };

  return (
    <div className="chooser-backdrop" data-testid="mode-chooser" onMouseDown={(e) => { if (e.target === e.currentTarget) m.closeChooser(); }}>
      <div className="chooser" role="dialog" aria-modal="true" aria-labelledby="chooser-title">
        <div className="chooser-head">
          <span className="chooser-kicker">Rescript Studio</span>
          <h2 id="chooser-title">How do you want to program your research?</h2>
          <p>One survey, one engine, five ways to build it. Switch at any time — nothing converts, nothing is lost.</p>
        </div>
        <div className="chooser-cards">
          {m.modes.map((info, i) => (
            <button
              key={info.id} type="button" ref={i === 0 ? first : undefined}
              className={`chooser-card${m.mode === info.id ? " current" : ""}`}
              data-testid={`chooser-${info.id}`} onClick={() => pick(info.id)}
              disabled={!info.available}
            >
              <span className="chooser-glyph"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{GLYPH[info.id]}</svg></span>
              <span className="chooser-index mono">0{info.index}</span>
              <span className="chooser-name">{info.label}</span>
              <span className="chooser-tagline">{info.tagline}</span>
              <span className="chooser-audience">{info.audience}</span>
              <ul className="chooser-detail">{DETAIL[info.id].map((d) => <li key={d}>{d}</li>)}</ul>
              {m.mode === info.id && <span className="chooser-current">current</span>}
            </button>
          ))}
        </div>
        <div className="chooser-foot">
          <span className="chooser-foot-note"><Icon name="info" size={13} /> Change your mind any time from the Mode switch in the top bar, or press ⌘K and type a mode.</span>
          <button type="button" className="btn" onClick={() => m.closeChooser()} data-testid="chooser-dismiss">Keep {m.modes.find((x) => x.id === m.mode)?.label ?? "Studio"}</button>
        </div>
      </div>
    </div>
  );
}
