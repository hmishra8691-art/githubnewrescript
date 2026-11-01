"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import { noteExamined, shelfParadataKeys, shelfSeconds } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { SafeImage } from "../Media";
import { useOptions, activate } from "./shared";
import { anchor } from "../authoring";
import { regionOf } from "./hotspot";

/**
 * S5c item 5 — SHELF TEST (audit SM-16), renderer key `shelf` (variant hotspot.shelf).
 *
 * The shelf image with each product as a region (the hotspot machinery). A click (or Enter / Space on a focused
 * product) picks it: the answer is [code]. Time to find (seconds since the shelf was first shown), the products
 * examined before the pick (pointer hover or keyboard focus, each once, in order) and — with
 * settings.shelf.secondPick — a second choice among the others go out as paradata (engine shelf.ts).
 */
export function Shelf(p: QRProps) {
  const options = useOptions(p);
  const img = p.q.settings.imageUrl;
  const cfg = (p.q.settings as { shelf?: { secondPick?: boolean; secondPrompt?: string } }).shelf ?? {};
  const ro = !!p.q.settings.readOnly;
  const keys = shelfParadataKeys(p.q.code || p.q.id);
  const shownAt = React.useRef<number>(typeof performance !== "undefined" ? performance.now() : Date.now());
  const examined = React.useRef<string[]>([]);
  const picked = Array.isArray(p.value) ? String((p.value as unknown[])[0] ?? "") : p.value == null ? "" : String(p.value);
  const [second, setSecond] = React.useState<string>(() => String(((p.state.embedded ?? {}) as Record<string, unknown>)[keys.pick2] ?? ""));

  const look = (o: Option) => {
    if (picked) return;
    const next = noteExamined(examined.current, String(o.code));
    if (next.length !== examined.current.length) { examined.current = next; p.onParadata?.(keys.examined, next.join(",")); }
  };
  const pick = (o: Option) => {
    if (ro) return;
    const code = String(o.code);
    if (picked && cfg.secondPick) {
      if (code === picked) return;
      setSecond(code); p.onParadata?.(keys.pick2, code); return;
    }
    if (picked === code) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    examined.current = noteExamined(examined.current, code);
    p.onParadata?.(keys.examined, examined.current.join(","));
    p.onParadata?.(keys.time, shelfSeconds(now - shownAt.current));
    p.onChange([o.code]);
  };

  const drawn = options.filter((o) => regionOf(o));
  const stage = picked && cfg.secondPick ? "second" : picked ? "done" : "first";
  return (
    <div className="rs-shelf" data-testid="shelf" data-stage={stage}>
      {img ? (
        <div className="rs-regions-stage rs-shelf-stage" role="radiogroup" aria-label="Products on the shelf">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <SafeImage className="rs-regions-img" src={img} alt="" draggable={false} imageOnly />
          {drawn.map((o) => {
            const r = regionOf(o)!;
            const code = String(o.code);
            const on = picked === code, two = second === code;
            return (
              <div key={code} className={`rs-region rs-shelf-item ${on ? "on" : ""} ${two ? "second" : ""}`}
                style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
                role="radio" aria-checked={on} aria-label={o.label.replace(/<[^>]*>/g, "")} tabIndex={ro ? -1 : 0}
                data-code={code} {...anchor("option", code)}
                onMouseEnter={() => look(o)} onFocus={() => look(o)}
                onClick={() => pick(o)} onKeyDown={activate(() => pick(o))}>
                {(on || two) && <span className="rs-region-tag">{on ? "✓ " : "2 · "}<span dangerouslySetInnerHTML={{ __html: o.label }} /></span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rs-error-msg">No shelf image configured — set the image URL in the editor.</div>
      )}
      <div className="rs-annot-status" data-testid="shelf-status" aria-live="polite">
        {stage === "first" ? "Click the product you would buy." : stage === "second" ? (second ? "Thank you." : (cfg.secondPrompt ?? "If that product were not on the shelf, which would you buy instead?")) : "Thank you."}
      </div>
    </div>
  );
}

registerVariantRenderer("shelf", Shelf);
