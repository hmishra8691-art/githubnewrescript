import type { Question } from "@rescript/schema";

/**
 * S5a item 1 — IMAGE ZOOM / LIGHTBOX (audit MM2-04), the rules the renderer and the actions share.
 *
 *   zoomModeFor(q, item?)   the mode of a stimulus item / an option image / an image in the question text:
 *                           the item's own `zoom`, else the question's `settings.zoom`, else "off". "off" when unset
 *                           keeps every existing survey exactly as it was; the image variants' defaults carry
 *                           `zoom: "click"`, so a new image question zooms (decision, docs/S5-EXTENDED-FEATURES).
 *   zoomParadataKey(ref)    ZOOMED_<CODE> — how many times the respondent opened the lightbox on this question
 *                           (embedded data, so it travels with every save and every export, like TIMER_<REF>_*)
 *   ZOOM_MIN / ZOOM_MAX, clampScale, clampPan, wheelScale, pinchScale   the lightbox's bounded zoom and pan (pure,
 *                           so the bounds are unit-tested; the renderer only applies them)
 */
export type ZoomMode = "off" | "click" | "hover-magnifier";
export const ZOOM_MODES: readonly ZoomMode[] = ["off", "click", "hover-magnifier"];
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 0.5;
export const MAGNIFIER_SCALE = 2.5;

export function isZoomMode(v: unknown): v is ZoomMode { return typeof v === "string" && (ZOOM_MODES as readonly string[]).includes(v); }

export function zoomModeFor(q: Pick<Question, "settings">, item?: { zoom?: unknown } | null): ZoomMode {
  if (item && isZoomMode(item.zoom)) return item.zoom;
  const z = (q.settings as { zoom?: unknown } | undefined)?.zoom;
  return isZoomMode(z) ? z : "off";
}

/** does anything on this question zoom (its own setting or any stimulus item's)? */
export function questionZooms(q: Pick<Question, "settings">): boolean {
  if (zoomModeFor(q) !== "off") return true;
  return (q.settings.mediaItems ?? []).some((m) => zoomModeFor(q, m) !== "off");
}

const SAFE = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
export function zoomParadataKey(ref: string): string { return `ZOOMED_${SAFE(ref) || "Q"}`; }

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(s * 100) / 100));
}

/**
 * Pan bounds: at scale s an image of w×h overflows its frame by (s−1)·w/2 on each side — the pan can never show
 * empty space past the image's edge, and at 1× there is no pan at all.
 */
export function clampPan(pan: { x: number; y: number }, scale: number, w: number, h: number): { x: number; y: number } {
  const s = clampScale(scale);
  const mx = Math.max(0, ((s - 1) * Math.max(0, w)) / 2), my = Math.max(0, ((s - 1) * Math.max(0, h)) / 2);
  const c = (v: number, m: number) => (Number.isFinite(v) ? Math.min(m, Math.max(-m, v)) : 0);
  return { x: c(pan.x, mx) || 0, y: c(pan.y, my) || 0 };
}

/** a wheel / trackpad step: up zooms in, down zooms out, bounded */
export function wheelScale(scale: number, deltaY: number): number {
  if (!deltaY) return clampScale(scale);
  return clampScale(scale * (deltaY < 0 ? 1.15 : 1 / 1.15));
}

/** two fingers: the scale at the start times the ratio of the finger distances, bounded */
export function pinchScale(startScale: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampScale(startScale);
  return clampScale(startScale * (distance / startDistance));
}

/** the lightbox keyboard: + / = zoom in, - zoom out, 0 reset, arrows pan (when zoomed), Escape closes */
export function zoomKey(key: string): { kind: "in" | "out" | "reset" | "close" } | { kind: "pan"; dx: number; dy: number } | null {
  switch (key) {
    case "+": case "=": return { kind: "in" };
    case "-": case "_": return { kind: "out" };
    case "0": return { kind: "reset" };
    case "Escape": return { kind: "close" };
    case "ArrowLeft": return { kind: "pan", dx: 40, dy: 0 };
    case "ArrowRight": return { kind: "pan", dx: -40, dy: 0 };
    case "ArrowUp": return { kind: "pan", dx: 0, dy: 40 };
    case "ArrowDown": return { kind: "pan", dx: 0, dy: -40 };
    default: return null;
  }
}
