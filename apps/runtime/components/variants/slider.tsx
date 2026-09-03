"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";

/**
 * slider family renderers — see docs/VARIANT-BATCH.md.
 *
 * Four presentations, three existing response models:
 *
 *   rangeslider       numeric_list  { from, to }        two handles on one track
 *   vslider           slider        number              vertical track
 *   slidermatrix      matrix_numeric { rowCode: n }     one slider per row
 *   sliderallocation  allocation    { code: n }         sliders bounded by a sum
 *
 * The last one is registered from `allocation.tsx`: the Slider / Rating and
 * Constant Sum families both legitimately offer it, and it belongs beside the
 * base type whose response model it writes.
 *
 * Every handle is a native `<input type="range">`, so each one is keyboard
 * operable (arrows, Home/End, Page Up/Down) and announced by screen readers
 * without a line of our own key handling.
 */

function plain(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** min / max / step from settings, with the base type's defaults. */
function bounds(p: QRProps) {
  const min = p.q.settings.minValue ?? 0;
  const max = p.q.settings.maxValue ?? 100;
  const step = p.q.settings.step ?? 1;
  return { min, max: max > min ? max : min + 1, step: step > 0 ? step : 1 };
}

/** Where a value sits on the track, 0–100%. */
function pct(v: number, min: number, max: number): number {
  return max === min ? 0 : ((v - min) / (max - min)) * 100;
}

/* --------------------------------------------------------- Dual / Range */
/**
 * Two overlaid range inputs. The inputs themselves are transparent and
 * pointer-transparent; only their thumbs take the pointer (see slider.css),
 * which is what lets two handles share one track without either one
 * swallowing the other's drags. The handles are clamped so they cannot cross.
 *
 * Stored exactly as a two-row numeric list: `{ from, to }` keyed by the row
 * codes, which is why the engine's `rangePair` rule already guards the order.
 */
export function RangeSlider(p: QRProps) {
  const rows = useRows(p);
  const { min, max, step } = bounds(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;

  if (rows.length < 2) {
    return <div className="rs-error-msg">A range slider needs two rows — a “from” and a “to”.</div>;
  }
  const [loRow, hiRow] = rows;
  const loCode = String(loRow.code);
  const hiCode = String(hiRow.code);
  const loStored = vals[loCode] == null ? null : Number(vals[loCode]);
  const hiStored = vals[hiCode] == null ? null : Number(vals[hiCode]);
  const lo = loStored ?? min;
  const hi = hiStored ?? max;
  const touched = loStored != null || hiStored != null;

  const commit = (next: Record<string, number>) =>
    p.onChange({ ...vals, [loCode]: next[loCode], [hiCode]: next[hiCode] });
  const setLo = (n: number) => commit({ [loCode]: Math.min(n, hi), [hiCode]: hi });
  const setHi = (n: number) => commit({ [loCode]: lo, [hiCode]: Math.max(n, lo) });

  const leftLabel = p.q.settings.sliderLeftLabel ?? String(min);
  const rightLabel = p.q.settings.sliderRightLabel ?? String(max);

  return (
    <div className="rs-rangeslider" data-testid="rangeslider">
      <div className={`rs-rangeslider-readout ${touched ? "" : "muted"}`} data-testid="range-readout">
        <span data-testid="range-from">{lo}</span>
        <span className="rs-rangeslider-sep" aria-hidden>–</span>
        <span data-testid="range-to">{hi}</span>
        {!touched && <span className="rs-rangeslider-hint">drag a handle to set your range</span>}
      </div>
      <div className={`rs-rangeslider-track ${touched ? "" : "untouched"}`}>
        <span className="rs-rangeslider-rail" aria-hidden />
        <span
          className="rs-rangeslider-fill"
          aria-hidden
          style={{ left: `${pct(lo, min, max)}%`, right: `${100 - pct(hi, min, max)}%` }}
        />
        <input
          type="range" className="rs-rangeslider-input lo"
          data-row={loCode} aria-label={`${plain(loRow.label)} (lower bound)`}
          min={min} max={max} step={step} value={lo}
          disabled={p.q.settings.readOnly}
          onChange={(e) => setLo(Number(e.target.value))}
        />
        <input
          type="range" className="rs-rangeslider-input hi"
          data-row={hiCode} aria-label={`${plain(hiRow.label)} (upper bound)`}
          min={min} max={max} step={step} value={hi}
          disabled={p.q.settings.readOnly}
          onChange={(e) => setHi(Number(e.target.value))}
        />
      </div>
      <div className="rs-rangeslider-ends">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- Vertical slider */
/**
 * A vertical track: minimum at the bottom, maximum at the top — the direction
 * people expect of "more". `writing-mode: vertical-lr` + `direction: rtl`
 * (slider.css) rotates a native range input without a transform, so hit
 * testing and keyboard behaviour stay native.
 */
export function VerticalSlider(p: QRProps) {
  const { min, max, step } = bounds(p);
  const stored = p.value == null ? null : Number(p.value);
  const shown = stored ?? Math.round((min + max) / 2);
  return (
    <div className="rs-vslider" data-testid="vslider">
      <div className="rs-vslider-col">
        <div className="rs-vslider-end top">{p.q.settings.sliderRightLabel ?? max}</div>
        <input
          type="range" className={`rs-vslider-input ${stored == null ? "untouched" : ""}`}
          aria-label={plain(p.q.text) || "Slider"}
          aria-orientation="vertical"
          min={min} max={max} step={step} value={shown}
          disabled={p.q.settings.readOnly}
          onChange={(e) => p.onChange(Number(e.target.value))}
        />
        <div className="rs-vslider-end bottom">{p.q.settings.sliderLeftLabel ?? min}</div>
      </div>
      {/* beside the track, not under it: a readout 250px below the handle is
          not where anyone looks while dragging */}
      <div className={`rs-vslider-val ${stored == null ? "muted" : ""}`} data-testid="vslider-val">
        {stored == null ? "—" : stored}
      </div>
    </div>
  );
}

/* ---------------------------------------------------- Multi-attribute grid */
/**
 * One slider per row. Two layouts, both from this component so the Grid /
 * Matrix family can offer the same thing as a compact table:
 *
 *   stack (default)  each attribute is a labelled slider with its own readout
 *   grid             label | slider | value rows under one pair of end labels
 *
 * A row has no answer until its handle is moved — the readout shows "—" and
 * the ordinary matrix "required" rule (validate.ts) asks for the rest.
 */
export function SliderMatrix(p: QRProps) {
  const rows = useRows(p);
  const { min, max, step } = bounds(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const grid = p.q.settings.sliderLayout === "grid";
  const leftLabel = p.q.settings.sliderLeftLabel ?? String(min);
  const rightLabel = p.q.settings.sliderRightLabel ?? String(max);
  const setRow = (rc: string, n: number) => p.onChange({ ...vals, [rc]: n });

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="slidermatrix-no-rows">
        This question has no attributes yet — add them in the question’s
        <strong> Rows </strong> section. Each row becomes one slider.
      </div>
    );
  }

  const row = (rc: string, label: string) => {
    const stored = vals[rc] == null ? null : Number(vals[rc]);
    const shown = stored ?? Math.round((min + max) / 2);
    return (
      <>
        <input
          type="range" className={`rs-slidermatrix-input ${stored == null ? "untouched" : ""}`}
          data-row={rc} aria-label={label}
          min={min} max={max} step={step} value={shown}
          disabled={p.q.settings.readOnly}
          onChange={(e) => setRow(rc, Number(e.target.value))}
        />
        <span className={`rs-slidermatrix-val ${stored == null ? "muted" : ""}`} data-value-for={rc}>
          {stored == null ? "—" : stored}
        </span>
      </>
    );
  };

  if (grid) {
    return (
      <div className="rs-slidermatrix grid" data-testid="slidermatrix" data-layout="grid">
        <div className="rs-slidermatrix-head" aria-hidden>
          <span />
          <span className="rs-slidermatrix-ends"><span>{leftLabel}</span><span>{rightLabel}</span></span>
          <span />
        </div>
        {rows.map((r) => {
          const rc = String(r.code);
          return (
            <div key={rc} className="rs-slidermatrix-gridrow" data-rowfor={rc}>
              <span className="rs-slidermatrix-label" dangerouslySetInnerHTML={{ __html: r.label }} />
              {row(rc, plain(r.label))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rs-slidermatrix stack" data-testid="slidermatrix" data-layout="stack">
      <div className="rs-slidermatrix-ends top" aria-hidden>
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
      {rows.map((r) => {
        const rc = String(r.code);
        return (
          <div key={rc} className="rs-slidermatrix-item" data-rowfor={rc}>
            <div className="rs-slidermatrix-label" dangerouslySetInnerHTML={{ __html: r.label }} />
            <div className="rs-slidermatrix-line">{row(rc, plain(r.label))}</div>
          </div>
        );
      })}
    </div>
  );
}

registerVariantRenderer("rangeslider", RangeSlider);
registerVariantRenderer("vslider", VerticalSlider);
registerVariantRenderer("slidermatrix", SliderMatrix);
