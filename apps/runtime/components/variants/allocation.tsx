"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions } from "./shared";

/**
 * allocation family renderers — see docs/VARIANT-BATCH.md.
 *
 * `sliderallocation` serves two registry entries — `allocation.slider_allocation`
 * and `slider.allocation_slider` — because both families legitimately offer
 * "sliders that must total 100". One renderer, one response model
 * (`{ code: number }`), so the sum rules, exports and the variable dictionary
 * see the same allocation the typed constant-sum variants produce.
 */

function plain(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/* ------------------------------------------------------ Allocation sliders */
/**
 * One slider per option, all bounded by the same budget. Dragging past what
 * is left is clamped rather than silently rebalancing someone else's share:
 * a respondent who wants more here has to take it from there, which is the
 * whole point of a constant sum. Under-allocation stays possible until Next —
 * the allocation sum validator is what refuses it, exactly as for the typed
 * constant-sum variants.
 */
export function SliderAllocation(p: QRProps) {
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const target = p.q.settings.sumTarget;
  const unit = p.q.settings.sumUnit ?? "";
  const step = p.q.settings.step ?? 1;
  const total = options.reduce((a, o) => a + (Number(vals[String(o.code)]) || 0), 0);
  const max = target ?? 100;

  const set = (code: string, n: number) => {
    const others = options.reduce(
      (a, o) => a + (String(o.code) === code ? 0 : Number(vals[String(o.code)]) || 0),
      0,
    );
    const capped = target == null ? n : Math.max(0, Math.min(n, target - others));
    p.onChange({ ...vals, [code]: capped });
  };

  if (options.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="sliderallocation-no-options">
        Nothing to allocate yet — add the items in the question’s <strong>Options</strong> section.
      </div>
    );
  }

  const remaining = target == null ? null : target - total;
  const state = target == null ? "" : total === target ? "ok" : total > target ? "bad" : "";

  return (
    <div className="rs-sliderallocation" data-testid="sliderallocation">
      {options.map((o) => {
        const code = String(o.code);
        const v = Number(vals[code]) || 0;
        return (
          <div key={code} className="rs-sliderallocation-row" data-rowfor={code}>
            <span className="rs-sliderallocation-label" dangerouslySetInnerHTML={{ __html: o.label }} />
            <input
              type="range" className="rs-sliderallocation-input"
              data-code={code} aria-label={plain(o.label)}
              min={0} max={max} step={step} value={v}
              disabled={p.q.settings.readOnly}
              onChange={(e) => set(code, Number(e.target.value))}
            />
            <span className="rs-sliderallocation-val" data-value-for={code}>{v}{unit}</span>
          </div>
        );
      })}
      <div className={`rs-sliderallocation-total ${state}`} data-testid="alloc-total">
        <strong>{total}{target != null ? ` / ${target}` : ""}{unit}</strong>
        {remaining != null && remaining > 0 && (
          <span className="rs-sliderallocation-left">{remaining}{unit} left to assign</span>
        )}
        {remaining === 0 && <span className="rs-sliderallocation-left">fully assigned ✓</span>}
      </div>
    </div>
  );
}

registerVariantRenderer("sliderallocation", SliderAllocation);
