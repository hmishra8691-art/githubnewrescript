"use client";
import React from "react";

/**
 * A MULTI-SELECT DROPDOWN WITH CHECKBOXES.
 *
 * The native `<select multiple>` it replaces is a scrolling list box that only
 * selects with ctrl/cmd-click — easy to lose a selection in, impossible on a
 * phone. This is a button that shows the choice ("Q1.A, Q1.C" or "3 options
 * selected") and opens a list of checkboxes that STAYS OPEN while several are
 * ticked; outside click, Escape or the button closes it.
 */
export interface DropdownOption { value: string; label: string; disabled?: boolean }

export function CheckboxDropdown({ options, values, onChange, testId, placeholder = "Select options", ariaLabel }: {
  options: DropdownOption[];
  values: string[];
  onChange(values: string[]): void;
  testId: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const chosen = options.filter((o) => values.includes(o.value));
  const summary = chosen.length === 0 ? placeholder
    : chosen.length <= 2 ? chosen.map((o) => o.label).join(", ")
    : `${chosen.length} options selected`;
  const toggle = (v: string, on: boolean) => {
    /* keep the list's own order, so the stored array is stable however the boxes were ticked */
    const set = new Set(values);
    if (on) set.add(v); else set.delete(v);
    onChange(options.filter((o) => set.has(o.value)).map((o) => o.value)
      .concat(values.filter((x) => set.has(x) && !options.some((o) => o.value === x))));
  };
  return (
    <div ref={root} className="cbd" style={{ position: "relative", display: "inline-block", minWidth: 180, maxWidth: "100%" }}>
      <button type="button" className="select cbd-button" data-testid={testId} aria-haspopup="listbox" aria-expanded={open}
        aria-label={ariaLabel} onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {summary} <span aria-hidden style={{ float: "right" }}>▾</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" className="cbd-list" data-testid={`${testId}-list`}
          style={{ position: "absolute", zIndex: 30, left: 0, right: 0, minWidth: 220, maxHeight: 240, overflow: "auto",
            background: "var(--panel, #fff)", border: "1px solid var(--border, #cbd5e1)", borderRadius: 6, padding: 4,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)" }}>
          {options.length === 0 && <div className="muted" style={{ padding: 6, fontSize: 12.5 }}>No options</div>}
          {options.map((o) => (
            <label key={o.value} role="option" aria-selected={values.includes(o.value)}
              style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 6px", cursor: o.disabled ? "default" : "pointer" }}>
              <input type="checkbox" data-testid={`${testId}-opt-${o.value}`} disabled={o.disabled}
                checked={values.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
