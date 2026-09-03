"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { NumberField } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";

/**
 * numeric family renderers — see docs/VARIANT-BATCH.md.
 *
 * Numeric Range is a `numeric_list` with two rows (`from`, `to`), so the pair
 * exports as two ordinary numeric variables and the engine's `rangePair` rule
 * (validate.ts) keeps from ≤ to. Nothing here is a new response model: the
 * only difference from the labelled numeric list is that the two fields sit on
 * one line with an en dash between them, the way a range reads.
 */

/* -------------------------------------------------------- Numeric Range */
export function NumericRange(p: QRProps) {
  const rows = useRows(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const min = p.q.settings.minValue;
  const max = p.q.settings.maxValue;
  const step = p.q.settings.step;
  const set = (code: string, n: number | null) => p.onChange({ ...vals, [code]: n });

  if (rows.length < 2) {
    return <div className="rs-error-msg">A numeric range needs two rows — a “from” and a “to”.</div>;
  }
  const pair = rows.slice(0, 2);

  return (
    <div className="rs-numrange" data-testid="numrange">
      {pair.map((row, i) => {
        const code = String(row.code);
        const label = row.label.replace(/<[^>]*>/g, "");
        return (
          <React.Fragment key={code}>
            {i === 1 && <span className="rs-numrange-dash" aria-hidden>—</span>}
            <label className="rs-numrange-field" data-row={code}>
              <span className="rs-numrange-lbl" dangerouslySetInnerHTML={{ __html: row.label }} />
              <NumberField
                className="rs-input sm"
                ariaLabel={label}
                value={vals[code]}
                min={min}
                max={max}
                step={step ?? "any"}
                placeholder={row.placeholder ?? (i === 0 ? (min != null ? String(min) : undefined) : (max != null ? String(max) : undefined))}
                readOnly={p.q.settings.readOnly}
                onChange={(n) => set(code, n)}
              />
            </label>
          </React.Fragment>
        );
      })}
      {(min != null || max != null) && (
        <span className="rs-numrange-bounds">
          {min != null && max != null ? `allowed ${min}–${max}` : min != null ? `min ${min}` : `max ${max}`}
        </span>
      )}
    </div>
  );
}

registerVariantRenderer("numrange", NumericRange);
