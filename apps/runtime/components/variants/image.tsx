"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { activate } from "./shared";

/**
 * Image Annotation / Markup (image.annotation) and Draw-on-Image
 * (hotspot.draw) — one renderer, `annotate`, over the `annotation` base type.
 *
 * The answer is `{ pins, strokes }` in PERCENT coordinates, so a mark made on
 * a phone lands in the same place as one made on a 27" monitor and the data
 * survives any later change of image size:
 *
 *   pins    `{ x, y, comment }`      a numbered marker with a typed comment
 *   strokes `{ tool, points[] }`     freehand, `tool` = "pen" | "highlight"
 *
 * A stroke is stored as an OBJECT rather than the bare point list the base
 * type's note describes, because the tool that drew it is part of what the
 * respondent said (a wide highlight over a paragraph is not the same gesture
 * as a thin circle around a word). Both shapes are read back — a bare array
 * is treated as a pen stroke — and the engine only ever counts `strokes.length`
 * and JSON-stringifies the value, so exports, variables and the min/max rules
 * are unaffected.
 */

type Tool = "pin" | "pen" | "highlight";
interface Pin { x: number; y: number; comment: string }
interface Stroke { tool: Exclude<Tool, "pin">; points: { x: number; y: number }[] }
interface Annotation { pins: Pin[]; strokes: Stroke[] }

const DEFAULT_TOOLS: Tool[] = ["pin", "pen"];
const TOOL_LABEL: Record<Tool, string> = { pin: "📍 Pin", pen: "✏️ Draw", highlight: "🖍 Highlight" };

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

function readStroke(s: unknown): Stroke | null {
  const raw = Array.isArray(s) ? { tool: "pen", points: s } : (s as { tool?: unknown; points?: unknown });
  const pts = Array.isArray(raw?.points) ? raw.points : [];
  const points = pts
    .map((pt) => {
      const o = pt as { x?: unknown; y?: unknown };
      const x = num(o?.x), y = num(o?.y);
      return x == null || y == null ? null : { x, y };
    })
    .filter((pt): pt is { x: number; y: number } => pt != null);
  if (points.length === 0) return null;
  return { tool: raw?.tool === "highlight" ? "highlight" : "pen", points };
}

/** Read the stored answer defensively — both stroke shapes, any junk dropped. */
function readValue(v: unknown): Annotation {
  const o = (v ?? {}) as { pins?: unknown; strokes?: unknown };
  const pins = (Array.isArray(o.pins) ? o.pins : [])
    .map((pt) => {
      const q = pt as { x?: unknown; y?: unknown; comment?: unknown };
      const x = num(q?.x), y = num(q?.y);
      return x == null || y == null ? null : { x, y, comment: q?.comment == null ? "" : String(q.comment) };
    })
    .filter((pt): pt is Pin => pt != null);
  const strokes = (Array.isArray(o.strokes) ? o.strokes : [])
    .map(readStroke)
    .filter((s): s is Stroke => s != null);
  return { pins, strokes };
}

export function Annotate(p: QRProps) {
  const img = p.q.settings.imageUrl;
  const tools = (p.q.settings.tools?.length ? p.q.settings.tools : DEFAULT_TOOLS) as Tool[];
  const color = p.q.settings.penColor ?? "#e11d48";
  const width = p.q.settings.penWidth ?? 3;
  const ro = !!p.q.settings.readOnly;

  const value = readValue(p.value);
  const [tool, setTool] = React.useState<Tool>(tools[0] ?? "pen");
  const [openPin, setOpenPin] = React.useState<number | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const live = React.useRef<{ x: number; y: number }[] | null>(null);
  const [box, setBox] = React.useState({ w: 0, h: 0 });

  // the overlay canvas has to be exactly the size of the image box, in device
  // pixels, or every stroke lands offset from the finger that drew it
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [img]);

  const paint = React.useCallback(
    (extra?: { x: number; y: number }[] | null) => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      const draw = (s: Stroke) => {
        if (s.points.length === 0) return;
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = color;
        ctx.globalAlpha = s.tool === "highlight" ? 0.35 : 1;
        ctx.lineWidth = s.tool === "highlight" ? width * 6 : width;
        s.points.forEach((pt, i) => {
          const x = (pt.x / 100) * c.width;
          const y = (pt.y / 100) * c.height;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        if (s.points.length === 1) ctx.lineTo((s.points[0].x / 100) * c.width + 0.5, (s.points[0].y / 100) * c.height);
        ctx.stroke();
        ctx.globalAlpha = 1;
      };
      // stored strokes first, then whatever is being drawn right now
      readValue(p.value).strokes.forEach(draw);
      if (extra?.length) draw({ tool: tool === "highlight" ? "highlight" : "pen", points: extra });
    },
    [color, width, p.value, tool],
  );

  // redraw from the stored answer: on mount, on resize, and every time the
  // answer changes — so going Back and forward again shows the same drawing
  React.useEffect(() => { paint(live.current); }, [paint, box.w, box.h]);

  if (!img) {
    return <div className="rs-error-msg">No stimulus image configured — set the image URL in the editor.</div>;
  }

  const pctAt = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: clampPct(((e.clientX - r.left) / r.width) * 100), y: clampPct(((e.clientY - r.top) / r.height) * 100) };
  };

  const setValue = (next: Annotation) =>
    p.onChange(next.pins.length === 0 && next.strokes.length === 0 ? null : next);

  const down = (e: React.PointerEvent) => {
    if (ro || e.button !== 0) return;
    if (tool === "pin") {
      const pins = [...value.pins, { ...pctAt(e), comment: "" }];
      setValue({ ...value, pins });
      setOpenPin(pins.length - 1);
      return;
    }
    live.current = [pctAt(e)];
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    if (!live.current) return;
    const pt = pctAt(e);
    const prev = live.current[live.current.length - 1];
    if (Math.abs(pt.x - prev.x) < 0.2 && Math.abs(pt.y - prev.y) < 0.2) return;
    live.current = [...live.current, pt];
    paint(live.current);
  };

  const up = () => {
    const pts = live.current;
    live.current = null;
    // a single click in a drawing tool is a slip, not a stroke
    if (!pts || pts.length < 2) { paint(null); return; }
    setValue({ ...value, strokes: [...value.strokes, { tool: tool === "highlight" ? "highlight" : "pen", points: pts }] });
  };

  const removePin = (i: number) => {
    setOpenPin(null);
    setValue({ ...value, pins: value.pins.filter((_, j) => j !== i) });
  };
  const setComment = (i: number, text: string) =>
    setValue({ ...value, pins: value.pins.map((pin, j) => (j === i ? { ...pin, comment: text } : pin)) });

  const undo = () => setValue({ ...value, strokes: value.strokes.slice(0, -1) });
  const min = p.q.settings.minSelections;
  const max = p.q.settings.maxSelections;
  const marks = value.pins.length + value.strokes.length;

  return (
    <div className="rs-annot">
      <div className="rs-annot-tools" role="toolbar" aria-label="Annotation tools">
        {tools.map((t) => (
          <button key={t} type="button" data-tool={t}
            className={`rs-annot-tool ${tool === t ? "on" : ""}`}
            aria-pressed={tool === t}
            disabled={ro}
            onClick={() => setTool(t)}>
            {TOOL_LABEL[t]}
          </button>
        ))}
        <span className="rs-annot-spacer" />
        <button type="button" className="rs-annot-tool" data-testid="annot-undo"
          disabled={ro || value.strokes.length === 0} onClick={undo}>↩ Undo</button>
        <button type="button" className="rs-annot-tool" data-testid="annot-clear"
          disabled={ro || marks === 0} onClick={() => { setOpenPin(null); setValue({ pins: [], strokes: [] }); }}>Clear all</button>
      </div>

      <div className="rs-annot-stage" ref={wrapRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="rs-annot-img" src={img} alt="" draggable={false} />
        <canvas className="rs-annot-canvas" ref={canvasRef} width={box.w || 1} height={box.h || 1} aria-hidden />
        <div
          className={`rs-annot-surface tool-${tool}`}
          data-testid="annot-surface"
          role="img"
          aria-label={tool === "pin" ? "Click the image to place a pin" : "Drag on the image to draw"}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <div className="rs-annot-pins">
          {value.pins.map((pin, i) => (
            <React.Fragment key={i}>
              <button type="button"
                className={`rs-annot-pin ${openPin === i ? "open" : ""} ${pin.comment ? "noted" : ""}`}
                style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
                data-pin={i}
                title={pin.comment || "Add a comment"}
                aria-label={`Pin ${i + 1}${pin.comment ? `: ${pin.comment}` : ""} — open the comment`}
                onClick={() => setOpenPin(openPin === i ? null : i)}
                onKeyDown={activate(() => setOpenPin(openPin === i ? null : i))}>
                {i + 1}
              </button>
              {openPin === i && (
                <div className="rs-annot-note" style={{ left: `${pin.x}%`, top: `${pin.y}%` }}>
                  <input
                    className="rs-input sm"
                    autoFocus
                    placeholder="What about this spot?"
                    data-testid={`pin-comment-${i}`}
                    defaultValue={pin.comment ?? ""}
                    readOnly={ro}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); setComment(i, (e.target as HTMLInputElement).value); setOpenPin(null); }
                      if (e.key === "Escape") setOpenPin(null);
                    }}
                    onBlur={(e) => setComment(i, e.target.value)}
                  />
                  <button type="button" className="rs-annot-note-x" aria-label={`Remove pin ${i + 1}`}
                    data-testid={`pin-remove-${i}`} onClick={() => removePin(i)}>×</button>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="rs-annot-status" data-testid="annot-status">
        {value.pins.length} pin{value.pins.length === 1 ? "" : "s"} · {value.strokes.length} stroke{value.strokes.length === 1 ? "" : "s"}
        {min != null && <span className="rs-annot-hint"> · at least {min} mark{min === 1 ? "" : "s"}</span>}
        {max != null && <span className="rs-annot-hint"> · at most {max}</span>}
      </div>
    </div>
  );
}

registerVariantRenderer("annotate", Annotate);
// the base type's default presentation when a question stores no variant
registerVariantRenderer("base:annotation", Annotate);
