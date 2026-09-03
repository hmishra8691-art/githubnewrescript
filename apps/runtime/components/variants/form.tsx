"use client";
import React from "react";
import { fieldInputProps } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { NumberField } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";

/**
 * Custom Form family — the presentations that were "coming soon".
 *
 *   repeatform   Repeating / Nested Form   repeating_group, fields → [{…}, {…}]
 *   (Conditional Form has no renderer of its own: it is an ordinary field
 *    list whose rows carry `visibleIf`, and the runtime re-evaluates row
 *    visibility on every answer change, so a field appears and disappears
 *    live as an earlier question is answered.)
 *
 * `repeatform` is also registered as `base:repeating_group`, the default for
 * the base type, so a repeating group built from JSON — or converted from
 * another type — renders as a form rather than falling through to a text box.
 */

const NUMERIC_FIELDS = ["number", "decimal", "integer", "currency"];

/* ------------------------------------------------- Repeating / Nested Form */
export function RepeatForm(p: QRProps) {
  const rows = useRows(p);
  const stored = React.useMemo(
    () => (Array.isArray(p.value) ? (p.value as Record<string, unknown>[]) : []),
    [p.value],
  );
  const min = Math.max(1, p.q.settings.minRepeats ?? 1);
  const max = Math.max(min, p.q.settings.maxRepeats ?? 5);
  const [shownState, setShown] = React.useState<number | null>(null);
  const shown = Math.min(max, Math.max(shownState ?? stored.length, min, 1));
  const entries = Array.from({ length: shown }, (_, i) => stored[i] ?? {});

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="repeatform-no-fields">
        This form has no fields yet — add them in the question’s
        <strong> Rows </strong> section. Every field is captured once per entry.
      </div>
    );
  }

  /** Trailing entries nobody filled in are presentation, never data. */
  const commit = (list: Record<string, unknown>[]) => {
    const empty = (e: Record<string, unknown>) =>
      Object.values(e).every((v) => v === null || v === undefined || v === "");
    let end = list.length;
    while (end > 0 && empty(list[end - 1])) end--;
    p.onChange(list.slice(0, end));
  };
  const setField = (i: number, code: string, v: unknown) => {
    const list = entries.map((e) => ({ ...e }));
    if (v === null || v === undefined || v === "") delete list[i][code];
    else list[i][code] = v;
    setShown(list.length);
    commit(list);
  };
  const add = () => {
    if (shown >= max) return;
    setShown(shown + 1);
  };
  const remove = (i: number) => {
    const list = entries.filter((_, j) => j !== i);
    setShown(Math.max(min, list.length));
    commit(list);
  };

  return (
    <div className="rs-repeatform">
      {entries.map((entry, i) => {
        // the engine reports per-entry problems as "Entry 3: Name is required."
        const mine = p.errors.filter((e) => e.startsWith(`Entry ${i + 1}:`));
        return (
          <div key={i} className={`rs-entry ${mine.length ? "bad" : ""}`} data-entry={i}>
            <div className="rs-entry-head">
              <span className="rs-entry-n">Entry {i + 1}</span>
              <button type="button" className="rs-entry-remove"
                data-entry={i}
                aria-label={`Remove entry ${i + 1}`}
                disabled={p.q.settings.readOnly || shown <= min}
                onClick={() => remove(i)}>
                ✕
              </button>
            </div>
            <div className="rs-entry-fields">
              {rows.map((row) => {
                const rc = String(row.code);
                const ft = row.fieldType ?? "text";
                const ip = fieldInputProps(ft);
                const v = entry[rc];
                const plain = row.label.replace(/<[^>]*>/g, "");
                return (
                  <label key={rc} className="rs-entry-field" data-field={rc}>
                    <span className="flab">
                      <span dangerouslySetInnerHTML={{ __html: row.label }} />
                      {row.required && <span className="rs-req"> *</span>}
                    </span>
                    {ip.prefix && <span className="rs-prefix">{ip.prefix}</span>}
                    {ip.multiline ? (
                      <textarea className="rs-textarea" style={{ minHeight: 56 }}
                        aria-label={`${plain} — entry ${i + 1}`}
                        placeholder={row.placeholder}
                        value={v == null ? "" : String(v)}
                        readOnly={p.q.settings.readOnly}
                        onChange={(e) => setField(i, rc, e.target.value)} />
                    ) : NUMERIC_FIELDS.includes(ft) ? (
                      <NumberField className="rs-input"
                        ariaLabel={`${plain} — entry ${i + 1}`}
                        placeholder={row.placeholder}
                        value={v}
                        readOnly={p.q.settings.readOnly}
                        onChange={(n) => setField(i, rc, n)} />
                    ) : (
                      <input className="rs-input" type={ip.inputType}
                        inputMode={ip.inputMode as never}
                        aria-label={`${plain} — entry ${i + 1}`}
                        placeholder={row.placeholder}
                        value={v == null ? "" : String(v)}
                        readOnly={p.q.settings.readOnly}
                        onChange={(e) => setField(i, rc, e.target.value)} />
                    )}
                  </label>
                );
              })}
            </div>
            {mine.map((m, j) => (
              <div key={j} className="rs-error-msg">{m.replace(`Entry ${i + 1}: `, "")}</div>
            ))}
          </div>
        );
      })}
      <div className="rs-repeatform-foot">
        <button type="button" className="rs-repeatform-add" data-testid="repeatform-add"
          disabled={p.q.settings.readOnly || shown >= max}
          onClick={add}>
          + Add another entry
        </button>
        <span className="rs-repeatform-count" data-testid="repeatform-count">
          {shown} of up to {max}
        </span>
      </div>
    </div>
  );
}

registerVariantRenderer("repeatform", RepeatForm);
// the base type's default: a repeating group with no variant stored is a form
registerVariantRenderer("base:repeating_group", RepeatForm);
