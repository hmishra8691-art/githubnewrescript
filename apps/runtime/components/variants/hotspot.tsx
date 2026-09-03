"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import { toggleMultiValue } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useOptions, activate } from "./shared";

/**
 * Region / Area Selection (hotspot.regions).
 *
 * Predefined areas of a stimulus image are the options: each carries its
 * rectangle in `option.meta.region = {x, y, w, h}` as PERCENTAGES of the
 * image, and the answer is the ordinary `image_select` list of codes. So a
 * region question reports, pipes and exports exactly like a checkbox list —
 * the image is presentation only, which is why the Draw-on-Image variant
 * (free-form marking, no fixed areas) is a different base type.
 *
 * `settings.maxSelections === 1` behaves as a radio group: picking another
 * region replaces the first rather than being silently ignored at the cap.
 */

export interface Region { x: number; y: number; w: number; h: number }

export function regionOf(o: Option): Region | null {
  const r = o.meta?.region as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
  if (!r) return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const x = n(r.x), y = n(r.y), w = n(r.w), h = n(r.h);
  if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

const plain = (s: string) => s.replace(/<[^>]*>/g, "");

export function Regions(p: QRProps) {
  const options = useOptions(p);
  const img = p.q.settings.imageUrl;
  const max = p.q.settings.maxSelections ?? 1;
  const multi = max > 1;
  const ro = !!p.q.settings.readOnly;

  const vals: (string | number)[] = Array.isArray(p.value)
    ? (p.value as (string | number)[])
    : p.value == null ? [] : [p.value as string | number];
  const isOn = (o: Option) => vals.some((v) => String(v) === String(o.code));

  const set = (next: (string | number)[]) => p.onChange(next.length ? next : null);
  const pick = (o: Option) => {
    if (ro) return;
    if (!multi) return set(isOn(o) ? [] : [o.code]);
    set(toggleMultiValue(vals, o.code, options, max));
  };

  const drawn = options.filter((o) => regionOf(o));
  const undrawn = options.filter((o) => !regionOf(o));

  return (
    <div className="rs-regions">
      {img ? (
        <div className="rs-regions-stage" role={multi ? "group" : "radiogroup"}
          aria-label="Select a region of the image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="rs-regions-img" src={img} alt="" draggable={false} />
          {drawn.map((o, i) => {
            const r = regionOf(o)!;
            const on = isOn(o);
            return (
              <div key={String(o.code)}
                className={`rs-region ${on ? "on" : ""}`}
                style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                role={multi ? "checkbox" : "radio"}
                aria-checked={on}
                aria-label={plain(o.label)}
                tabIndex={ro ? -1 : 0}
                data-code={String(o.code)}
                onClick={() => pick(o)}
                onKeyDown={activate(() => pick(o))}>
                <span className="rs-region-tag">
                  <span className="rs-region-n">{i + 1}</span>
                  <span dangerouslySetInnerHTML={{ __html: o.label }} />
                  {on && <span aria-hidden> ✓</span>}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rs-error-msg">No stimulus image configured — set the image URL in the editor.</div>
      )}

      {/* An option with no rectangle yet is still an answer the respondent can
          give — it would otherwise be invisible and unanswerable. */}
      {undrawn.length > 0 && (
        <div className="rs-region-chips" data-testid="regions-undrawn">
          {undrawn.map((o) => {
            const on = isOn(o);
            return (
              <button key={String(o.code)} type="button"
                className={`rs-region-chip ${on ? "on" : ""}`}
                aria-pressed={on}
                data-code={String(o.code)}
                onClick={() => pick(o)}>
                <span dangerouslySetInnerHTML={{ __html: o.label }} />
              </button>
            );
          })}
        </div>
      )}

      <div className="rs-annot-status" data-testid="regions-status">
        {vals.length} of {options.length} selected
        {multi ? ` · up to ${max}` : " · one region"}
      </div>
    </div>
  );
}

registerVariantRenderer("regions", Regions);
