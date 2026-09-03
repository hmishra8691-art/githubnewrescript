"use client";
import React from "react";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";

/**
 * Studio authoring for the hotspot family — see docs/VARIANT-BATCH.md §4.
 *
 * Region / Area Selection needs a region per option, and typing four numbers
 * per region is not authoring — it is arithmetic. So this is a drawing tool:
 * pick an option, drag a rectangle on the stimulus, and the rectangle is
 * written to `option.meta.region` as percentages of the image (the same units
 * the runtime draws with, so it survives any image size).
 */

interface Rect { x: number; y: number; w: number; h: number }

function rectOf(meta: Record<string, unknown> | undefined): Rect | null {
  const r = meta?.region as Rect | undefined;
  if (!r) return null;
  const ok = [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(Number(n)));
  return ok && Number(r.w) > 0 && Number(r.h) > 0
    ? { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) }
    : null;
}
const pct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const plain = (s: string) => s.replace(/<[^>]*>/g, "");

function RegionSettings({ q, patch, patchSettings }: VariantSettingsProps) {
  const [active, setActive] = React.useState<string>(String(q.options[0]?.code ?? ""));
  const [drag, setDrag] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const multi = (q.settings.maxSelections ?? 1) > 1;

  const activeOpt = q.options.find((o) => String(o.code) === active) ?? q.options[0];

  const writeRegion = (code: string, region: Rect | null) =>
    patch({
      options: q.options.map((o) => {
        if (String(o.code) !== code) return o;
        const meta = { ...(o.meta ?? {}) };
        if (region) meta.region = region;
        else delete meta.region;
        return { ...o, meta };
      }),
    });

  const at = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: pct(((e.clientX - r.left) / r.width) * 100), y: pct(((e.clientY - r.top) / r.height) * 100) };
  };
  const rectFromDrag = (d: NonNullable<typeof drag>): Rect => ({
    x: pct(Math.min(d.x0, d.x1)),
    y: pct(Math.min(d.y0, d.y1)),
    w: pct(Math.abs(d.x1 - d.x0)),
    h: pct(Math.abs(d.y1 - d.y0)),
  });

  return (
    <>
      <label className="f"><span>Stimulus image URL</span>
        <input className="input" value={q.settings.imageUrl ?? ""}
          placeholder="https://…/image.jpg"
          data-testid="region-image-url"
          onChange={(e) => patchSettings({ imageUrl: e.target.value || undefined })} /></label>

      <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={multi}
          data-testid="region-multi"
          onChange={(e) => patchSettings({ multiRegion: e.target.checked, maxSelections: e.target.checked ? 99 : 1 })} />
        <span>Allow several regions (otherwise picking one replaces the last)</span>
      </label>

      <div className="f">
        <span className="flabel">Regions — pick an option, then drag a rectangle on the image</span>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {q.options.map((o) => {
            const r = rectOf(o.meta);
            return (
              <button key={String(o.code)} type="button"
                className={`btn small ${String(o.code) === active ? "primary" : ""}`}
                data-testid={`region-pick-${o.code}`}
                onClick={() => setActive(String(o.code))}>
                {plain(o.label) || String(o.code)}
                <span style={{ marginLeft: 6, opacity: 0.7 }}>
                  {r ? `${r.x},${r.y} ${r.w}×${r.h}` : "no region"}
                </span>
              </button>
            );
          })}
          {q.options.length === 0 && (
            <div className="chip warn" data-testid="region-no-options">
              Add options first — each option is one selectable region.
            </div>
          )}
        </div>
      </div>

      {q.settings.imageUrl ? (
        <div
          ref={stage}
          data-testid="region-canvas"
          style={{
            position: "relative", width: "100%", maxWidth: 420, lineHeight: 0,
            border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden",
            cursor: activeOpt ? "crosshair" : "default", touchAction: "none",
          }}
          onPointerDown={(e) => {
            if (!activeOpt) return;
            const pt = at(e);
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            setDrag({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
          }}
          onPointerMove={(e) => { if (drag) { const pt = at(e); setDrag({ ...drag, x1: pt.x, y1: pt.y }); } }}
          onPointerUp={() => {
            if (!drag || !activeOpt) return setDrag(null);
            const r = rectFromDrag(drag);
            setDrag(null);
            // a click, not a drag: leave the existing region alone
            if (r.w < 2 || r.h < 2) return;
            writeRegion(String(activeOpt.code), r);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={q.settings.imageUrl} alt="stimulus" draggable={false} style={{ display: "block", width: "100%", height: "auto" }} />
          {q.options.map((o, i) => {
            const r = rectOf(o.meta);
            if (!r) return null;
            const isActive = String(o.code) === active;
            return (
              <div key={String(o.code)}
                data-testid={`region-box-${o.code}`}
                style={{
                  position: "absolute", left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`,
                  border: `2px ${isActive ? "solid" : "dashed"} var(--accent, #2563eb)`,
                  background: isActive ? "rgb(37 99 235 / 22%)" : "rgb(37 99 235 / 10%)",
                  borderRadius: 4, pointerEvents: "none",
                  fontSize: 10, color: "#0f172a", lineHeight: 1.2, padding: 2,
                }}>
                {i + 1}
              </div>
            );
          })}
          {drag && (
            <div style={{
              position: "absolute",
              left: `${Math.min(drag.x0, drag.x1)}%`, top: `${Math.min(drag.y0, drag.y1)}%`,
              width: `${Math.abs(drag.x1 - drag.x0)}%`, height: `${Math.abs(drag.y1 - drag.y0)}%`,
              border: "2px solid #e11d48", background: "rgb(225 29 72 / 18%)", pointerEvents: "none",
            }} />
          )}
        </div>
      ) : (
        <div className="chip warn" data-testid="region-no-image">
          Add the stimulus image URL above to draw regions on it.
        </div>
      )}

      {activeOpt && rectOf(activeOpt.meta) && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small" type="button"
            data-testid={`region-del-${activeOpt.code}`}
            onClick={() => writeRegion(String(activeOpt.code), null)}>
            delete “{plain(activeOpt.label) || String(activeOpt.code)}” region
          </button>
        </div>
      )}
    </>
  );
}

registerVariantSettings("regions", (p) => <RegionSettings {...p} />);
