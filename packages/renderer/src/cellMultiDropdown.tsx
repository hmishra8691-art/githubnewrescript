import React from "react";
import { toggleMultiValue } from "@rescript/engine";
import type { QuestionColumn } from "@rescript/schema";
import { anchor } from "./authoring";

/**
 * A MULTI-SELECT DROPDOWN FOR ONE CELL — checkboxes in a popover.
 *
 * A Dropdown Matrix column of type "multi_dropdown" used to render as the
 * browser's `<select multiple>`: a scrolling list box that only selects with
 * ctrl/cmd-click, collapses nothing and cannot be used on a phone. This is the
 * dropdown people expect:
 *
 *   · a button that shows what is chosen — the labels when there are one or
 *     two, "3 Options Selected" beyond that, a placeholder when nothing is;
 *   · a list of CHECKBOXES that stays open while several are ticked, and closes
 *     on an outside click, Escape, or the button again;
 *   · the column's own minimum / maximum number of selections: once the maximum
 *     is reached the unticked boxes are disabled and the panel says why, and
 *     the minimum is stated in the panel (the check itself is the column's
 *     `min_selections` rule, run by validation when the page is submitted);
 *   · exclusive options ("None of these") clear the others, as everywhere else.
 *
 * The state is the cell's own: nothing is shared between rows, so two rows of
 * the same column choose independently. The VALUE is the same array of codes
 * the select produced, so saved answers, exports, logic and piping are
 * unchanged — and because it is just the answer, going back to the page shows
 * the same ticks.
 *
 * The panel is `position: fixed` at viewport coordinates measured from the
 * button: a matrix sits inside a horizontally scrolling wrapper that would clip
 * a panel positioned inside the table, and fixed positioning escapes that clip.
 * It stays in the cell's own DOM, so the survey's theme variables still apply.
 */
const plain = (s: string) => s.replace(/<[^>]*>/g, "");

/** the number a column's `min_selections` / `max_selections` rule asks for, if any */
export function selectionLimits(col: Pick<QuestionColumn, "validation">): { min?: number; max?: number } {
  const num = (kind: string) => {
    const r = (col.validation ?? []).find((v) => v.kind === kind);
    const n = r ? Number(r.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return { min: num("min_selections"), max: num("max_selections") };
}

export function CellMultiDropdown({ col, value, onChange, readOnly, label }: {
  col: QuestionColumn;
  value: unknown;
  onChange(v: (string | number)[]): void;
  readOnly?: boolean;
  label: string;
}) {
  const arr = (Array.isArray(value) ? value : []) as (string | number)[];
  const { min, max } = selectionLimits(col);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number; above: boolean } | null>(null);
  const btn = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const uid = React.useId();

  const place = React.useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const room = window.innerHeight - r.bottom;
    const above = room < 220 && r.top > room;
    setPos({ top: above ? r.top : r.bottom, left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - Math.max(r.width, 220))), width: Math.max(r.width, 220), above });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    place();
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const chosen = col.options.filter((o) => arr.some((v) => String(v) === String(o.code)));
  const summary = chosen.length === 0 ? (col.placeholder ?? "— Select —")
    : chosen.length <= 2 ? chosen.map((o) => plain(o.label)).join(", ")
    : `${chosen.length} Options Selected`;
  const atMax = max != null && arr.length >= max;

  return (
    <span className="rs-cmd" data-testid="rs-cell-multi-dropdown">
      <button ref={btn} type="button" className="rs-select rs-cmd-button" disabled={readOnly}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-panel` : undefined} aria-label={`${label}: ${summary}`}
        data-count={chosen.length}
        onClick={() => setOpen((v) => !v)}>
        <span className="rs-cmd-summary" style={chosen.length === 0 ? { color: "var(--rs-subtle)" } : undefined}>{summary}</span>
        <span className="rs-cmd-caret" aria-hidden>▾</span>
      </button>
      {open && pos && (
        <div ref={panel} id={`${uid}-panel`} className="rs-cmd-panel" role="listbox" aria-multiselectable="true" aria-label={label}
          data-testid="rs-cell-multi-dropdown-panel"
          style={{ position: "fixed", left: pos.left, minWidth: pos.width, ...(pos.above ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}>
          {(min != null || max != null) && (
            <div className="rs-cmd-hint" data-testid="rs-cell-multi-dropdown-hint">
              {min != null && max != null ? (min === max ? `Select ${min}` : `Select ${min} to ${max}`)
                : min != null ? `Select at least ${min}` : `Select up to ${max}`}
              {" · "}{arr.length} selected
            </div>
          )}
          <div className="rs-cmd-list">
            {col.options.map((o) => {
              const on = arr.some((v) => String(v) === String(o.code));
              const disabled = !!o.meta?.disabled || (atMax && !on);
              return (
                <label key={String(o.code)} className={`rs-cmd-item${disabled ? " disabled" : ""}`} role="option" aria-selected={on} aria-disabled={disabled}
                  {...anchor("option", o.code)}>
                  <input type="checkbox" checked={on} disabled={disabled}
                    data-testid={`rs-cmd-opt-${String(o.code)}`}
                    onChange={() => onChange(toggleMultiValue(arr, o.code, col.options, max))} />
                  <span>{plain(o.label)}</span>
                </label>
              );
            })}
            {col.options.length === 0 && <div className="rs-cmd-hint">No options</div>}
          </div>
          {atMax && <div className="rs-cmd-hint" data-testid="rs-cell-multi-dropdown-max">Maximum of {max} reached — untick one to choose another.</div>}
        </div>
      )}
    </span>
  );
}
