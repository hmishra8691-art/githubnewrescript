"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { SafeImage } from "../Media";
import { beforeAfterView, clampPosition, stepPosition, DwellClock, beforeAfterParadata } from "@rescript/engine";

/**
 * S5a item 2 — BEFORE / AFTER COMPARISON SLIDER (audit MM2-06), renderer key `beforeafter`.
 *
 * The AFTER image fills the frame; the BEFORE image sits on top, clipped to the left of the divider. The divider is
 * a real slider (role="slider", aria-valuenow 0–100, aria-valuetext "62 % before"): drag it with a pointer anywhere
 * on the frame, or focus it and use the arrows (±5 %), PageUp / PageDown (±25 %), Home / End. The optional rating
 * after is a radio group (minValue..maxValue). Without a rating the final divider position IS the answer.
 * `settings.recordPosition` writes BA_<CODE>_POSITION / _DWELL_BEFORE / _DWELL_AFTER as paradata on every move.
 */
export function BeforeAfter(p: QRProps) {
  const v = beforeAfterView(p.q);
  const ro = !!p.q.settings.readOnly;
  const record = !!p.q.settings.recordPosition;
  const code = p.q.code || p.q.id;
  const initial = !v.askRating && typeof p.value === "number" ? clampPosition(p.value) : v.start;
  const [pos, setPos] = React.useState(initial);
  const frame = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const dwell = React.useRef<DwellClock | null>(null);
  const posRef = React.useRef(pos);
  posRef.current = pos;
  if (!dwell.current && typeof performance !== "undefined") dwell.current = new DwellClock(initial, performance.now());

  const commit = (next: number) => {
    const c = clampPosition(next);
    setPos(c);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    dwell.current?.move(c, now);
    if (!v.askRating) p.onChange(c);
    if (record && dwell.current) {
      const out = beforeAfterParadata(code, c, dwell.current.seconds(now));
      for (const [k, val] of Object.entries(out)) p.onParadata?.(k, val);
    }
  };
  /* the dwell on leaving: written once more when the question unmounts (Next) */
  React.useEffect(() => () => {
    if (!record || !dwell.current) return;
    const out = beforeAfterParadata(code, posRef.current, dwell.current.seconds(typeof performance !== "undefined" ? performance.now() : Date.now()));
    for (const [k, val] of Object.entries(out)) p.onParadata?.(k, val);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fromPointer = (clientX: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    commit(((clientX - r.left) / r.width) * 100);
  };

  if (!v.before || !v.after) {
    return <div className="rs-media-note" data-testid="ba-missing">This comparison needs two images (before and after).</div>;
  }
  const rating = typeof p.value === "number" && v.askRating ? p.value : null;
  const points: number[] = [];
  if (v.askRating) for (let n = v.min; n <= v.max && points.length < 11; n++) points.push(n);

  return (
    <div className="rs-ba" data-testid="ba">
      <div className="rs-ba-frame" ref={frame} data-testid="ba-frame"
        onPointerDown={(e) => { if (ro) return; dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); fromPointer(e.clientX); }}
        onPointerMove={(e) => { if (dragging.current) fromPointer(e.clientX); }}
        onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
        style={{ touchAction: "pan-y" }}>
        <SafeImage className="rs-ba-img rs-ba-after" src={v.after.url} alt={v.after.alt} draggable={false} data-testid="ba-after" />
        <div className="rs-ba-clip" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} data-testid="ba-before-clip">
          <SafeImage className="rs-ba-img rs-ba-before" src={v.before.url} alt={v.before.alt} draggable={false} data-testid="ba-before" />
        </div>
        <span className="rs-ba-tag rs-ba-tag-before" aria-hidden="true">{v.beforeLabel}</span>
        <span className="rs-ba-tag rs-ba-tag-after" aria-hidden="true">{v.afterLabel}</span>
        <div className="rs-ba-divider" style={{ left: `${pos}%` }} aria-hidden="true" />
        <div className="rs-ba-handle" role="slider" tabIndex={ro ? -1 : 0} data-testid="ba-handle"
          aria-label={`${v.beforeLabel} / ${v.afterLabel} divider`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos)}
          aria-valuetext={`${Math.round(pos)} % ${v.beforeLabel.toLowerCase()} shown`}
          aria-disabled={ro || undefined}
          style={{ left: `${pos}%` }}
          onKeyDown={(e) => { if (ro) return; const n = stepPosition(pos, e.key); if (n !== null) { e.preventDefault(); commit(n); } }}>
          <span aria-hidden="true">⟷</span>
        </div>
      </div>
      {v.askRating && (
        <fieldset className="rs-ba-rating" data-testid="ba-rating">
          <legend>{v.ratingPrompt}</legend>
          <div className="rs-ba-points" role="radiogroup">
            {points.map((n) => (
              <label key={n} className={`rs-ba-point ${rating === n ? "selected" : ""}`}>
                <input type="radio" name={`${p.q.id}-ba`} value={n} checked={rating === n} disabled={ro}
                  data-testid={`ba-rate-${n}`} onChange={() => p.onChange(n)} />
                <span>{n}</span>
              </label>
            ))}
          </div>
          {(v.minLabel || v.maxLabel) && (
            <div className="rs-ba-ends" aria-hidden="true"><span>{v.minLabel}</span><span>{v.maxLabel}</span></div>
          )}
        </fieldset>
      )}
    </div>
  );
}

registerVariantRenderer("beforeafter", BeforeAfter);
