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
 * EVERY IMAGE OF THE QUESTION ZOOMS (2026-11-15) — whatever the question type and wherever the image was put.
 *
 * The setting used to reach three places only: the stimulus, images typed into the QUESTION text, and the option
 * image of two renderers. An image in an option label, a row or column label, the instruction, a card, a list row, a
 * ranking item, a carousel … did nothing, and the hover magnifier existed on the stimulus alone — so on most
 * questions choosing "Hover magnifier" or "Click to zoom" changed nothing a respondent could see.
 *
 * This runs over the question's card instead of over one renderer: every <img> in it (uploaded or by URL — the
 * element is the same) is found, now and whenever the card redraws, and gets the question's zoom:
 *
 *   in the text (question, instruction, content)   the image itself is the control: click / Enter / Space opens the
 *                                                  lightbox
 *   anywhere a click already means something       (an option, a row, a card, a rank item) the click is left alone —
 *                                                  it still selects — and a small "Enlarge" button sits on the
 *                                                  image's corner, reachable by keyboard and touch
 *   mode "hover-magnifier"                         a lens follows the mouse over any of them, as well as the above
 *
 * Not touched: an image that is itself the answering surface (hotspot, regions, annotation — `data-zoom-skip`), the
 * stimulus already wrapped by <Zoomable>, the lightbox's own image, and icons smaller than 40px.
 */
const TEXT_AREAS = ".rs-qtext, .rs-qhtml, .rs-qinstruction";
const CLICK_OWNERS = "a, button, label, select, [role='button'], [role='radio'], [role='checkbox'], [role='option'], [draggable='true']";
const SKIP = ".rs-lightbox-backdrop, .rs-zoomable, .rs-hotspot, [data-zoom-skip]";
const MIN_ZOOM_PX = 40;

export function enhanceZoomableImages(root: HTMLElement | null, open: ((t: ZoomTarget, from: HTMLElement) => void) | null, mode: ZoomMode = "click"): () => void {
  if (!root || !open || mode === "off" || typeof window === "undefined") return () => {};
  const undo = new Map<HTMLImageElement, () => void>();
  /* released: a late image load must not wire anything for a pass that has been cleaned up */
  let dead = false;
  let lens: HTMLElement | null = null;
  const hideLens = () => { lens?.remove(); lens = null; };
  const showLens = (img: HTMLImageElement, e: MouseEvent) => {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (!lens) {
      lens = document.createElement("span");
      lens.className = "rs-magnifier rs-magnifier-fixed";
      lens.setAttribute("aria-hidden", "true");
      lens.dataset.testid = "rs-magnifier";
      document.body.appendChild(lens);
    }
    const x = e.clientX - r.left, y = e.clientY - r.top;
    lens.style.left = `${e.clientX - 70}px`;
    lens.style.top = `${e.clientY - 70}px`;
    lens.style.backgroundImage = `url("${(img.currentSrc || img.src).replace(/"/g, "%22")}")`;
    lens.style.backgroundSize = `${r.width * MAGNIFIER_SCALE}px ${r.height * MAGNIFIER_SCALE}px`;
    lens.style.backgroundPosition = `${-(x * MAGNIFIER_SCALE - 70)}px ${-(y * MAGNIFIER_SCALE - 70)}px`;
  };

  const wire = (img: HTMLImageElement) => {
    if (undo.has(img) || img.closest(SKIP) || img.dataset.zoomSkip !== undefined) return;
    if (!img.complete || !img.naturalWidth) { img.addEventListener("load", () => schedule(), { once: true }); return; }
    const box = img.getBoundingClientRect();
    if (box.width && box.height && Math.max(box.width, box.height) < MIN_ZOOM_PX) return;
    const cleanups: (() => void)[] = [];
    const target = (): ZoomTarget => ({ src: img.currentSrc || img.src, alt: img.alt });
    const name = `Enlarge image${img.alt ? `: ${img.alt}` : ""}`;
    img.dataset.rsZoom = mode;

    if (mode === "hover-magnifier") {
      const move = (e: MouseEvent) => showLens(img, e);
      img.addEventListener("mousemove", move);
      img.addEventListener("mouseleave", hideLens);
      cleanups.push(() => { img.removeEventListener("mousemove", move); img.removeEventListener("mouseleave", hideLens); });
    }

    const inText = !!img.closest(TEXT_AREAS) && !img.closest(CLICK_OWNERS);
    if (inText) {
      const had = { tab: img.getAttribute("tabindex"), role: img.getAttribute("role"), label: img.getAttribute("aria-label") };
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-haspopup", "dialog");
      img.setAttribute("aria-label", name);
      img.classList.add("rs-zoomable-inline");
      const go = () => { hideLens(); open(target(), img); };
      const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
      img.addEventListener("click", go);
      img.addEventListener("keydown", key);
      cleanups.push(() => {
        img.removeEventListener("click", go); img.removeEventListener("keydown", key);
        img.classList.remove("rs-zoomable-inline"); img.removeAttribute("aria-haspopup");
        for (const [attr, v] of [["tabindex", had.tab], ["role", had.role], ["aria-label", had.label]] as const) { if (v === null) img.removeAttribute(attr); else img.setAttribute(attr, v); }
      });
    } else {
      /* the click belongs to the option / row / card: an Enlarge button on the image's corner, placed from the image's own box */
      const host = img.parentElement;
      if (host) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rs-zoom-btn rs-zoom-btn-auto";
        btn.dataset.testid = "rs-zoom-btn";
        btn.setAttribute("data-testid", "rs-zoom-btn");
        btn.setAttribute("aria-label", name);
        btn.setAttribute("aria-haspopup", "dialog");
        btn.textContent = "⤢";
        const stop = (e: Event) => e.stopPropagation();
        const go = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); hideLens(); open(target(), btn); };
        btn.addEventListener("click", go);
        btn.addEventListener("keydown", stop);
        btn.addEventListener("pointerdown", stop);
        btn.addEventListener("mousedown", stop);
        btn.addEventListener("touchstart", stop, { passive: true });
        const wasStatic = getComputedStyle(host).position === "static";
        if (wasStatic) host.classList.add("rs-zoom-host");
        img.insertAdjacentElement("afterend", btn);
        const place = () => {
          if (!img.isConnected || !btn.isConnected) return;
          const size = Math.min(32, Math.max(22, Math.round(Math.min(img.offsetWidth, img.offsetHeight) * 0.4)));
          btn.style.width = btn.style.height = `${size}px`;
          btn.style.left = `${img.offsetLeft + img.offsetWidth - size - 4}px`;
          btn.style.top = `${img.offsetTop + 4}px`;
        };
        place();
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
        ro?.observe(img); ro?.observe(host);
        cleanups.push(() => { ro?.disconnect(); btn.remove(); if (wasStatic) host.classList.remove("rs-zoom-host"); });
      }
    }
    undo.set(img, () => { delete img.dataset.rsZoom; cleanups.forEach((f) => f()); });
  };

  const scan = () => {
    if (dead) return;
    for (const [img, off] of undo) if (!img.isConnected || !root.contains(img)) { off(); undo.delete(img); }
    root.querySelectorAll<HTMLImageElement>("img").forEach(wire);
  };
  let queued = 0;
  const schedule = () => { if (dead || queued) return; queued = window.requestAnimationFrame(() => { queued = 0; scan(); }); };
  scan();
  /* the card redraws (an answer, a page of a carousel, piped text): new images are picked up, removed ones released */
  const mo = typeof MutationObserver !== "undefined" ? new MutationObserver((list) => {
    if (list.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n instanceof HTMLElement && n.classList.contains("rs-zoom-btn-auto")))) return;
    schedule();
  }) : null;
  mo?.observe(root, { childList: true, subtree: true });
  window.addEventListener("scroll", hideLens, true);
  return () => {
    dead = true;
    mo?.disconnect();
    if (queued) window.cancelAnimationFrame(queued);
    window.removeEventListener("scroll", hideLens, true);
    hideLens();
    undo.forEach((off) => off());
    undo.clear();
  };
}
