"use client";
import React from "react";
import { useMode } from "./ModeContext";

/**
 * PROGRAMMING MODE — the selector in the top bar.
 *
 * Five environments over one survey. The ones without a renderer yet are
 * shown, disabled, with their tagline: the selector is also the place the
 * product says what it is becoming, and a programmer who sees "Grid —
 * program at scale" greyed out knows to expect it. Switching is instant and
 * changes nothing but the view.
 */
export function ModeSelector() {
  const m = useMode();
  if (!m) return null;
  return (
    <div className="mode-selector" role="radiogroup" aria-label="Programming mode" data-testid="mode-selector">
      <span className="mode-selector-label">Mode</span>
      {m.modes.map((info) => {
        const active = m.mode === info.id;
        return (
          <button
            key={info.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`mode-option${active ? " active" : ""}${info.available ? "" : " soon"}`}
            data-testid={`mode-${info.id}`}
            data-mode={info.id}
            data-available={info.available ? "1" : "0"}
            disabled={!info.available}
            title={info.available ? `${info.label} — ${info.tagline}. ${info.audience}` : `${info.label} — ${info.tagline}. Coming soon.`}
            onClick={() => m.setMode(info.id)}
          >
            {info.label}
          </button>
        );
      })}
    </div>
  );
}
