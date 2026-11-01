"use client";
import React from "react";
import { clampScale, clampPan, wheelScale, pinchScale, zoomKey, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, MAGNIFIER_SCALE, type ZoomMode } from "@rescript/engine";

/**
 * S5a item 1 — IMAGE ZOOM / LIGHTBOX (audit MM2-04).
 *
 *   <ZoomProvider mode onZoomed>   one per question (QuestionRenderer's shell). Holds the open image and draws the
 *                                  lightbox; `onZoomed` is called once per open (the Runner counts ZOOMED_<CODE>).
 *   <Zoomable mode src alt>        wraps a stimulus image: "click" makes it a button that opens the lightbox;
 *                                  "hover-magnifier" adds a lens that follows the pointer (the click / Enter still
 *                                  opens the lightbox, so keyboard and touch users get the same zoom).
 *   <ZoomButton src alt>           the small "Enlarge" button on an option image — the image itself still selects
 *   enhanceZoomableImages(root…)   images inserted in the question text become keyboard-operable zoom targets
 *
 * The lightbox: role="dialog" aria-modal, labelled by the image's alt text (shown as the caption), focus moves to it
 * and is trapped inside (Tab cycles its buttons), Escape / the close button / a click on the backdrop closes it and
 * focus returns to the element that opened it. Zoom 1–5× by the buttons, + / − / 0, the wheel or a pinch; pan by
 * dragging or the arrow keys — all bounded (engine mediaZoom.ts) so the image never leaves its frame. Motion is
 * instant under prefers-reduced-motion.
 */

export interface ZoomTarget { src: string; alt: string }
interface ZoomApi { mode: ZoomMode; open(t: ZoomTarget, from: HTMLElement | null): void }
export const ZoomContext = React.createContext<ZoomApi | null>(null);
export const useZoom = () => React.useContext(ZoomContext);

export function ZoomProvider({ mode, onZoomed, children }: { mode: ZoomMode; onZoomed?: () => void; children: React.ReactNode }) {
  const [open, setOpen] = React.useState<{ t: ZoomTarget; from: HTMLElement | null } | null>(null);
  const onZoomedRef = React.useRef(onZoomed);
  onZoomedRef.current = onZoomed;
  const api = React.useMemo<ZoomApi>(() => ({
    mode,
    open: (t, from) => { setOpen({ t, from }); onZoomedRef.current?.(); },
  }), [mode]);
  return (
    <ZoomContext.Provider value={api}>
      {children}
      {open && <Lightbox target={open.t} onClose={() => { const f = open.from; setOpen(null); setTimeout(() => f?.focus?.(), 0); }} />}
    </ZoomContext.Provider>
  );
}

function reducedMotion(): boolean {
  try { return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function Lightbox({ target, onClose }: { target: ZoomTarget; onClose(): void }) {
  const [scale, setScale] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dlg = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<HTMLDivElement>(null);
  const pointers = React.useRef(new Map<number, { x: number; y: number }>());
  const gesture = React.useRef<{ scale: number; dist: number; pan: { x: number; y: number }; x: number; y: number } | null>(null);
  const size = () => ({ w: frame.current?.clientWidth ?? 0, h: frame.current?.clientHeight ?? 0 });
  const apply = (s: number, p = pan) => { const c = clampScale(s); const { w, h } = size(); setScale(c); setPan(clampPan(p, c, w, h)); };
  const titleId = React.useId();

  React.useEffect(() => {
    dlg.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      const els = Array.from(dlg.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      if (!els.length) return;
      const i = els.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
      e.preventDefault(); els[next].focus();
      return;
    }
    const k = zoomKey(e.key);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    if (k.kind === "close") onClose();
    else if (k.kind === "in") apply(scale + ZOOM_STEP);
    else if (k.kind === "out") apply(scale - ZOOM_STEP);
    else if (k.kind === "reset") apply(1, { x: 0, y: 0 });
    else if (k.kind === "pan") apply(scale, { x: pan.x + k.dx, y: pan.y + k.dy });
  };
  const onWheel = (e: React.WheelEvent) => { apply(wheelScale(scale, e.deltaY)); };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { scale, dist, pan, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2 && g.dist > 0) apply(pinchScale(g.scale, g.dist, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)), g.pan);
    else if (pts.length === 1) apply(scale, { x: g.pan.x + (e.clientX - g.x), y: g.pan.y + (e.clientY - g.y) });
  };
  const onPointerUp = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); gesture.current = pointers.current.size ? { scale, dist: 0, pan, x: e.clientX, y: e.clientY } : null; };

  const pct = Math.round(scale * 100);
  const body = (
    <div className="rs-lightbox-backdrop" data-testid="rs-lightbox-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dlg} className="rs-lightbox" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="rs-lightbox"
        data-scale={scale} onKeyDown={onKeyDown}>
        <div className="rs-lightbox-bar">
          <button type="button" className="rs-lightbox-btn" aria-label="Zoom out" data-testid="rs-lightbox-out" disabled={scale <= ZOOM_MIN} onClick={() => apply(scale - ZOOM_STEP)}>−</button>
          <span className="rs-lightbox-pct" aria-live="polite" data-testid="rs-lightbox-pct">{pct}%</span>
          <button type="button" className="rs-lightbox-btn" aria-label="Zoom in" data-testid="rs-lightbox-in" disabled={scale >= ZOOM_MAX} onClick={() => apply(scale + ZOOM_STEP)}>+</button>
          <button type="button" className="rs-lightbox-btn" aria-label="Reset zoom" data-testid="rs-lightbox-reset" disabled={scale === 1 && !pan.x && !pan.y} onClick={() => apply(1, { x: 0, y: 0 })}>1:1</button>
          <button type="button" className="rs-lightbox-btn rs-lightbox-close" aria-label="Close image viewer" data-testid="rs-lightbox-close" data-autofocus onClick={onClose}>×</button>
        </div>
        <div ref={frame} className="rs-lightbox-frame" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={{ touchAction: "none", cursor: scale > 1 ? "grab" : "zoom-in" }}
          onDoubleClick={() => apply(scale > 1 ? 1 : 2, { x: 0, y: 0 })}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={target.src} alt={target.alt} draggable={false} data-testid="rs-lightbox-img" referrerPolicy="no-referrer"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transition: reducedMotion() || gesture.current ? "none" : "transform .15s ease-out" }} />
        </div>
        <p id={titleId} className="rs-lightbox-caption" data-testid="rs-lightbox-caption">{target.alt || "Image"}</p>
        <p className="rs-sr-only">Use plus and minus to zoom, the arrow keys to move the image, 0 to reset and Escape to close.</p>
      </div>
    </div>
  );
  /* position: fixed over the page (no portal: the renderer does not depend on react-dom) */
  return body;
}

/** a stimulus image that zooms: a button around it ("click") and, for "hover-magnifier", a lens */
export function Zoomable({ mode, src, alt, children }: { mode: ZoomMode; src: string; alt: string; children: React.ReactNode }) {
  const z = useZoom();
  const [lens, setLens] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  if (mode === "off" || !z) return <>{children}</>;
  return (
    <button type="button" className={`rs-zoomable rs-zoom-${mode}`} data-testid="rs-zoomable" data-zoom={mode}
      aria-label={`Enlarge image${alt ? `: ${alt}` : ""}`} aria-haspopup="dialog"
      onClick={(e) => z.open({ src, alt }, e.currentTarget)}
      onMouseMove={mode === "hover-magnifier" ? (e) => { const r = e.currentTarget.getBoundingClientRect(); setLens({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }); } : undefined}
      onMouseLeave={mode === "hover-magnifier" ? () => setLens(null) : undefined}>
      {children}
      {mode === "hover-magnifier" && lens && (
        <span className="rs-magnifier" aria-hidden="true" data-testid="rs-magnifier"
          style={{ left: lens.x - 70, top: lens.y - 70, backgroundImage: `url("${src.replace(/"/g, "%22")}")`, backgroundSize: `${lens.w * MAGNIFIER_SCALE}px ${lens.h * MAGNIFIER_SCALE}px`, backgroundPosition: `${-(lens.x * MAGNIFIER_SCALE - 70)}px ${-(lens.y * MAGNIFIER_SCALE - 70)}px` }} />
      )}
      <span className="rs-zoom-hint" aria-hidden="true">⤢</span>
    </button>
  );
}

/** the "Enlarge" button on an option image — a sibling control, so clicking the image still selects the option */
export function ZoomButton({ src, alt }: { src: string | null | undefined; alt: string }) {
  const z = useZoom();
  if (!z || z.mode === "off" || !src) return null;
  return (
    <button type="button" className="rs-zoom-btn" data-testid="rs-zoom-btn" aria-label={`Enlarge image${alt ? `: ${alt}` : ""}`} aria-haspopup="dialog"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); z.open({ src, alt }, e.currentTarget); }}
      onKeyDown={(e) => e.stopPropagation()}>⤢</button>
  );
}

/**
 * Images inserted in the question text (Insert media) — markup, not React — become zoom targets: tabbable, a button
 * role and name, Enter / Space / click open the lightbox. Re-applied whenever the text is redrawn; undone on cleanup.
 */
export function enhanceZoomableImages(root: HTMLElement | null, open: ((t: ZoomTarget, from: HTMLElement) => void) | null): () => void {
  if (!root || !open || typeof window === "undefined") return () => {};
  const done: (() => void)[] = [];
  root.querySelectorAll<HTMLImageElement>(".rs-qtext img, .rs-qhtml img").forEach((img) => {
    if (img.dataset.rsZoom === "1" || img.closest("a,button")) return;
    img.dataset.rsZoom = "1";
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-haspopup", "dialog");
    const label = `Enlarge image${img.alt ? `: ${img.alt}` : ""}`;
    img.setAttribute("aria-label", label);
    img.classList.add("rs-zoomable-inline");
    const go = () => open({ src: img.currentSrc || img.src, alt: img.alt }, img);
    const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    img.addEventListener("click", go);
    img.addEventListener("keydown", key);
    done.push(() => { img.removeEventListener("click", go); img.removeEventListener("keydown", key); delete img.dataset.rsZoom; img.removeAttribute("role"); img.removeAttribute("aria-label"); img.removeAttribute("aria-haspopup"); img.removeAttribute("tabindex"); img.classList.remove("rs-zoomable-inline"); });
  });
  return () => done.forEach((f) => f());
}
