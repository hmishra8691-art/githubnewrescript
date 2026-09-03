"use client";
import React from "react";
import type { QuestionColumn } from "@rescript/schema";
import { effectiveQuestion, fieldInputProps } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { NumberField, ctxOf } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";

/**
 * List / Form Fields family — the presentations that were "coming soon".
 *
 *   dynamiclist  Dynamic List     repeating_group, fields → [{item: "a"}, …]
 *   spreadsheet  Editable Table   custom_table, cells     → {rowCode: {colId: v}}
 *
 * Both reuse a base type the engine already exports and validates: a
 * repeating group's variables are VAR_<i>_<field> plus VAR_N, and a custom
 * table's are the columns' variable stems per row.
 */

/* -------------------------------------------------------------- Dynamic List */
/**
 * "List everything you can think of" — one field, as many lines as the
 * respondent needs, between `minRepeats` and `maxRepeats`.
 *
 * The visible line count is presentation, not data: trailing blank lines are
 * dropped on every change, so an unused line never becomes an entry and
 * never counts towards the minimum. The line count itself is remembered
 * locally so a half-typed list does not collapse under the respondent.
 */
export function DynamicList(p: QRProps) {
  const rows = useRows(p);
  const field = rows[0];
  const stored = React.useMemo(
    () => (Array.isArray(p.value) ? (p.value as Record<string, unknown>[]) : []),
    [p.value],
  );
  const min = Math.max(1, p.q.settings.minRepeats ?? 1);
  const max = Math.max(min, p.q.settings.maxRepeats ?? 10);
  const [shownState, setShown] = React.useState<number | null>(null);
  const inputs = React.useRef<(HTMLInputElement | null)[]>([]);

  if (!field) {
    return (
      <div className="rs-empty-hint" data-testid="dynlist-no-field">
        A dynamic list needs one field — add it in the question’s
        <strong> Rows </strong> section; every line the respondent adds captures it.
      </div>
    );
  }

  const fc = String(field.code);
  const values = stored.map((e) => (e?.[fc] == null ? "" : String(e[fc])));
  const shown = Math.min(max, Math.max(shownState ?? values.length, min, 1));
  const lines = Array.from({ length: shown }, (_, i) => values[i] ?? "");
  const filled = values.filter((v) => v.trim() !== "").length;
  const ip = fieldInputProps(field.fieldType);

  /** Commit a line list, with trailing blanks trimmed off the data. */
  const commit = (next: string[]) => {
    let end = next.length;
    while (end > 0 && next[end - 1].trim() === "") end--;
    p.onChange(next.slice(0, end).map((v) => ({ [fc]: v })));
  };
  const setLine = (i: number, text: string) => {
    const next = [...lines];
    next[i] = text;
    setShown(next.length);
    commit(next);
  };
  const add = () => {
    if (shown >= max) return;
    setShown(shown + 1);
    // focus the new line so "add another" lands the caret where it belongs
    requestAnimationFrame(() => inputs.current[shown]?.focus());
  };
  const remove = (i: number) => {
    const next = lines.filter((_, j) => j !== i);
    setShown(Math.max(min, next.length));
    commit(next);
  };

  return (
    <div className="rs-dynlist">
      {lines.map((v, i) => (
        <div key={i} className="rs-dynlist-line">
          <span className="rs-dynlist-n" aria-hidden>{i + 1}.</span>
          <input
            ref={(el) => { inputs.current[i] = el; }}
            className="rs-input"
            type={ip.inputType}
            inputMode={ip.inputMode as never}
            data-line={i}
            aria-label={`${field.label.replace(/<[^>]*>/g, "")} ${i + 1}`}
            placeholder={field.placeholder ?? field.label.replace(/<[^>]*>/g, "")}
            value={v}
            readOnly={p.q.settings.readOnly}
            onChange={(e) => setLine(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && i === lines.length - 1) { e.preventDefault(); add(); }
            }}
          />
          <button type="button" className="rs-dynlist-remove"
            data-line={i}
            aria-label={`Remove line ${i + 1}`}
            disabled={p.q.settings.readOnly || (lines.length <= min && v === "")}
            onClick={() => (lines.length <= min ? setLine(i, "") : remove(i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="rs-dynlist-foot">
        <button type="button" className="rs-dynlist-add" data-testid="dynlist-add"
          disabled={p.q.settings.readOnly || shown >= max}
          onClick={add}>
          + Add another
        </button>
        <span className="rs-dynlist-count" data-testid="dynlist-count">
          {filled} of up to {max}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Editable Table */
/**
 * Starter columns for a table the programmer has not configured yet — see
 * the note on `fallbackSumColumns` in ./matrix.tsx. Keep the ids in step
 * with `starterSheetColumns` in
 * apps/studio/components/studio/variantConfig/list.tsx.
 */
export function fallbackSheetColumns(p: QRProps): QuestionColumn[] {
  const spec: { label: string; responseType: "text" | "numeric" }[] = [
    { label: "Item", responseType: "text" },
    { label: "Detail", responseType: "text" },
    { label: "Amount", responseType: "numeric" },
  ];
  return spec.map((s, i) => ({
    id: `c${i + 1}`,
    label: s.label,
    responseType: s.responseType,
    variableStem: `${p.q.variableName}_C${i + 1}`,
    options: [],
    validation: [],
    readOnly: false,
  }));
}

/**
 * The minimal typed-cell subset a data-entry grid needs. `CompositeCell` in
 * QuestionRenderer covers more (calculated cells, multi-selects, sliders) but
 * is not exported, and a dense grid wants smaller controls anyway — so this
 * maps the four response types the Editable Table offers and falls back to a
 * text box for anything else, which is what a spreadsheet does too.
 */
function SheetCell({
  col, value, onChange, label, readOnly,
}: {
  col: QuestionColumn;
  value: unknown;
  onChange(v: unknown): void;
  label: string;
  readOnly: boolean;
}) {
  const ro = readOnly || col.readOnly;
  switch (col.responseType) {
    case "numeric":
    case "slider":
      return (
        <NumberField className="rs-input rs-sheet-in" ariaLabel={label}
          min={col.min} max={col.max} placeholder={col.placeholder}
          readOnly={ro} value={value} onChange={onChange} />
      );
    case "dropdown":
    case "single":
      return (
        <select className="rs-select rs-sheet-in" aria-label={label} disabled={ro}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {col.options.map((o) => (
            <option key={String(o.code)} value={String(o.code)}>
              {o.label.replace(/<[^>]*>/g, "")}
            </option>
          ))}
        </select>
      );
    case "multi":
    case "multi_dropdown": {
      const arr = (Array.isArray(value) ? value : []) as (string | number)[];
      return (
        <select className="rs-select rs-sheet-in" aria-label={label} disabled={ro} multiple
          size={Math.min(col.options.length || 1, 3)}
          value={arr.map(String)}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
          {col.options.map((o) => (
            <option key={String(o.code)} value={String(o.code)}>
              {o.label.replace(/<[^>]*>/g, "")}
            </option>
          ))}
        </select>
      );
    }
    case "checkbox":
      return (
        <input type="checkbox" aria-label={label} disabled={ro}
          checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      );
    case "date":
    case "time":
      return (
        <input className="rs-input rs-sheet-in" type={col.responseType} aria-label={label}
          readOnly={ro}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value || null)} />
      );
    default:
      return (
        <input className="rs-input rs-sheet-in" type="text" aria-label={label}
          readOnly={ro} placeholder={col.placeholder}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
      );
  }
}

export function Spreadsheet(p: QRProps) {
  const view = effectiveQuestion(p.q, ctxOf(p));
  const rows = view.rows;
  const columns = view.columns.length ? view.columns : fallbackSheetColumns(p);
  const cells = (p.value ?? {}) as Record<string, Record<string, unknown>>;
  const wrap = React.useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="sheet-no-rows">
        This table has no rows yet — add them in the question’s
        <strong> Rows </strong> section.
      </div>
    );
  }

  const setCell = (rc: string, colId: string, v: unknown) => {
    const row = { ...(cells[rc] ?? {}) };
    if (v === null || v === undefined || v === "") delete row[colId];
    else row[colId] = v;
    p.onChange({ ...cells, [rc]: row });
  };

  /**
   * Focus the control in cell (r, c), found through the DOM rather than a
   * ref per cell: a numeric cell is a `NumberField`, which owns its own
   * input and takes no ref, and a grid whose arrow keys stopped working on
   * the numeric column would be worse than no arrow keys at all.
   */
  const focusCell = (r: number, c: number) => {
    const tr = wrap.current?.querySelectorAll("tbody tr")[r];
    const td = tr?.querySelectorAll("td[data-col]")[c];
    const el = td?.querySelector("input, select, textarea") as HTMLElement | null;
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement && el.type === "text") el.select();
    return true;
  };

  /**
   * Spreadsheet keys. Up/Down and Enter step rows; Left/Right step columns
   * only from the edge of the text, so the arrow keys still move the caret
   * inside a cell you are editing. Tab is the browser's own and needs no help.
   */
  const onKeyDown = (e: React.KeyboardEvent, r: number, c: number) => {
    const el = e.target as HTMLElement;
    const isText = el instanceof HTMLInputElement && el.type === "text";
    const atStart = !isText || (el as HTMLInputElement).selectionStart === 0;
    const atEnd = !isText || (el as HTMLInputElement).selectionEnd === (el as HTMLInputElement).value.length;
    let moved = false;
    if (e.key === "ArrowDown" || e.key === "Enter") moved = focusCell(r + 1, c);
    else if (e.key === "ArrowUp") moved = focusCell(r - 1, c);
    else if (e.key === "ArrowLeft" && atStart) moved = focusCell(r, c - 1);
    else if (e.key === "ArrowRight" && atEnd) moved = focusCell(r, c + 1);
    if (moved) e.preventDefault();
  };

  return (
    <div className="rs-table-wrap" ref={wrap}>
      <table className="rs-matrix rs-sheet">
        <thead>
          <tr>
            <th className="rs-sheet-n" aria-label="Row" />
            <th className="rowlabel">Row</th>
            {columns.map((c) => (
              <th key={c.id} style={c.width ? { width: c.width } : undefined}
                dangerouslySetInnerHTML={{ __html: c.label }} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const rc = String(row.code);
            const plain = row.label.replace(/<[^>]*>/g, "");
            return (
              <tr key={rc} data-row={rc}>
                <th className="rs-sheet-n" scope="row">{r + 1}</th>
                <td className="rowlabel" dangerouslySetInnerHTML={{ __html: row.label }} />
                {columns.map((c, ci) => (
                  <td key={c.id} data-row={rc} data-col={c.id}
                    onKeyDown={(e) => onKeyDown(e, r, ci)}>
                    <SheetCell col={c} label={`${plain} — ${c.label.replace(/<[^>]*>/g, "")}`}
                      readOnly={!!p.q.settings.readOnly}
                      value={cells[rc]?.[c.id]}
                      onChange={(v) => setCell(rc, c.id, v)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

registerVariantRenderer("dynamiclist", DynamicList);
registerVariantRenderer("spreadsheet", Spreadsheet);
