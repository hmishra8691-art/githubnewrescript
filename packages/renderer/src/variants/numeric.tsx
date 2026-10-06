"use client";
import React from "react";
import type { QuestionRow } from "@rescript/schema";
import type { QRProps } from "../QuestionRenderer";
import { NumberField } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";
import { anchor } from "../authoring";
import { TimeSelects } from "../TimeSelects";

/**
 * numeric family renderers — see docs/VARIANT-BATCH.md.
 *
 * Numeric Range is a `numeric_list` with two rows (`from`, `to`), so the pair
 * exports as two ordinary variables and the engine's `rangePair` rule
 * (validate.ts) keeps from ≤ to — compared as the fields' own type, so a date
 * range is checked as dates and a time range as times.
 *
 * WHAT EACH END LOOKS LIKE FOLLOWS ITS FIELD TYPE (October 2026 review):
 * "after selecting these different types, the From and To fields look very
 * similar. This makes it difficult for the respondent to immediately
 * understand what type of information should be entered." Every type drew the
 * same number box, so a Date range accepted only digits and a Time range could
 * not be answered at all. Now:
 *
 *   number    a number box
 *   decimal   a decimal box ("e.g. 10.5")
 *   integer   a whole-number box that refuses a decimal point
 *   date      a calendar date picker
 *   time      hour / minute / AM-PM selectors, stored as 24-hour HH:MM
 *   hours     hours and minutes, stored as decimal hours (2 h 30 min = 2.5)
 *
 * and each end carries a cue saying which it is.
 */

type Kind = "number" | "decimal" | "integer" | "date" | "time" | "hours";
const KIND_CUE: Record<Kind, { icon: string; label: string }> = {
  number: { icon: "#", label: "Number" },
  decimal: { icon: "0.0", label: "Decimal" },
  integer: { icon: "123", label: "Whole number" },
  date: { icon: "📅", label: "Date" },
  time: { icon: "🕒", label: "Time" },
  hours: { icon: "⏱", label: "Duration" },
};

export function rangeKind(row: Pick<QuestionRow, "fieldType"> | undefined): Kind {
  const t = row?.fieldType;
  return t === "decimal" || t === "integer" || t === "date" || t === "time" || t === "hours" ? t : "number";
}

/** A duration as hours and minutes, stored as decimal hours. */
export function DurationField({ value, onChange, label, readOnly, testid }: {
  value: unknown; onChange(v: number | null): void; label: string; readOnly?: boolean; testid: string;
}) {
  const total = value == null || value === "" ? null : Number(value);
  const hours = total != null && Number.isFinite(total) ? Math.floor(total) : null;
  const minutes = total != null && Number.isFinite(total) ? Math.round((total - Math.floor(total)) * 60) : null;
  const emit = (h: number | null, m: number | null) => {
    if (h == null && m == null) return onChange(null);
    onChange(Math.round(((h ?? 0) + (m ?? 0) / 60) * 10000) / 10000);
  };
  return (
    <span className="rs-duration" data-testid={testid}>
      <NumberField className="rs-input sm rs-duration-h" ariaLabel={`${label} — hours`} min={0} decimals={0}
        value={hours} readOnly={readOnly} placeholder="0" onChange={(h) => emit(h, minutes)} />
      <span className="rs-duration-unit">h</span>
      <select className="rs-select sm" aria-label={`${label} — minutes`} disabled={readOnly} data-part="minutes"
        value={minutes ?? ""} onChange={(e) => emit(hours, e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">min</option>
        {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].concat(minutes != null && minutes % 5 ? [minutes] : []).sort((a, b) => a - b)
          .map((m) => <option key={m} value={m}>{String(m).padStart(2, "0")}</option>)}
      </select>
      <span className="rs-duration-unit">min</span>
    </span>
  );
}

/* -------------------------------------------------------- Numeric Range */
export function NumericRange(p: QRProps) {
  const rows = useRows(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const min = p.q.settings.minValue;
  const max = p.q.settings.maxValue;
  const step = p.q.settings.step;
  const set = (code: string, v: unknown) => p.onChange({ ...vals, [code]: v });

  if (rows.length < 2) {
    return <div className="rs-error-msg">A numeric range needs two rows — a “from” and a “to”.</div>;
  }
  const pair = rows.slice(0, 2);
  const numeric = (k: Kind) => k === "number" || k === "decimal" || k === "integer";

  return (
    <div className="rs-numrange" data-testid="numrange" data-kind={rangeKind(pair[0])}>
      {pair.map((row, i) => {
        const code = String(row.code);
        const label = row.label.replace(/<[^>]*>/g, "");
        const kind = rangeKind(row);
        const cue = KIND_CUE[kind];
        const ro = p.q.settings.readOnly;
        const tid = `numrange-input-${code}`;
        let control: React.ReactNode;
        if (kind === "date") {
          control = (
            <input className="rs-input sm" type="date" aria-label={label} data-testid={tid} readOnly={ro}
              value={vals[code] == null ? "" : String(vals[code])}
              onChange={(e) => set(code, e.target.value || null)} />
          );
        } else if (kind === "time") {
          control = <TimeSelects label={label} testid={tid} readOnly={ro} value={vals[code]} onChange={(v) => set(code, v)} />;
        } else if (kind === "hours") {
          control = <DurationField label={label} testid={tid} readOnly={ro} value={vals[code]} onChange={(v) => set(code, v)} />;
        } else {
          control = (
            <span data-testid={tid}>
              <NumberField
                className="rs-input sm"
                ariaLabel={label}
                value={vals[code]}
                min={min}
                max={max}
                step={kind === "integer" ? 1 : step ?? "any"}
                decimals={kind === "integer" ? 0 : undefined}
                placeholder={row.placeholder
                  ?? (kind === "decimal" ? (i === 0 ? "e.g. 10.5" : "e.g. 99.99")
                    : i === 0 ? (min != null ? String(min) : undefined) : (max != null ? String(max) : undefined))}
                readOnly={ro}
                onChange={(n) => set(code, n)}
              />
            </span>
          );
        }
        return (
          <React.Fragment key={code}>
            {i === 1 && <span className="rs-numrange-dash" aria-hidden>→</span>}
            <label className="rs-numrange-field" data-row={code} data-kind={kind} {...anchor("row", code)}>
              <span className="rs-numrange-lbl">
                <span dangerouslySetInnerHTML={{ __html: row.label }} />
                <span className="rs-numrange-cue" data-testid={`numrange-cue-${code}`} title={cue.label}>
                  <span aria-hidden>{cue.icon}</span> {cue.label}
                </span>
              </span>
              {control}
            </label>
          </React.Fragment>
        );
      })}
      {numeric(rangeKind(pair[0])) && (min != null || max != null) && (
        <span className="rs-numrange-bounds">
          {min != null && max != null ? `allowed ${min}–${max}` : min != null ? `min ${min}` : `max ${max}`}
        </span>
      )}
    </div>
  );
}

registerVariantRenderer("numrange", NumericRange);
