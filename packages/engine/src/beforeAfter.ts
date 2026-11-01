import type { Question } from "@rescript/schema";
import { questionMediaList } from "./carryforward.js";

/**
 * S5a item 2 — BEFORE / AFTER COMPARISON SLIDER (audit MM2-06), `comparison.before_after`.
 *
 *   beforeAfterView(q)        the two images (mediaItems[0] before, [1] after), labels, start position, whether a
 *                             rating follows and its bounds — what the renderer and the Studio editor read
 *   clampPosition / stepPosition   the divider: 0–100 %, arrow keys ±5, PageUp/Down ±25, Home 0, End 100
 *   DwellClock                dwell per side: the divider's time at ≥ 50 % (the BEFORE image fills most of the frame)
 *                             vs < 50 % (the AFTER image does), from the respondent's first sight of the question
 *   beforeAfterParadata(code, pos, dwell)   BA_<CODE>_POSITION / _DWELL_BEFORE / _DWELL_AFTER (embedded data)
 *   lintBeforeAfter(q)        what a programmer must fix: not two images, bounds that cannot hold the answer
 */
export const BA_STEP = 5;
export const BA_PAGE = 25;

export interface BeforeAfterView {
  before: { url: string; alt: string } | null;
  after: { url: string; alt: string } | null;
  beforeLabel: string; afterLabel: string;
  start: number;
  askRating: boolean; ratingPrompt: string; min: number; max: number; minLabel?: string; maxLabel?: string;
}

export function clampPosition(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

export function stepPosition(pos: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft": case "ArrowDown": return clampPosition(pos - BA_STEP);
    case "ArrowRight": case "ArrowUp": return clampPosition(pos + BA_STEP);
    case "PageDown": return clampPosition(pos - BA_PAGE);
    case "PageUp": return clampPosition(pos + BA_PAGE);
    case "Home": return 0;
    case "End": return 100;
    default: return null;
  }
}

export function beforeAfterView(q: Pick<Question, "settings" | "text">): BeforeAfterView {
  const st = q.settings;
  const ba = st.beforeAfter ?? {};
  const list = questionMediaList(q);
  const img = (i: number, fallback: string) => (list[i]?.url ? { url: list[i].url, alt: list[i].alt ?? fallback } : null);
  const beforeLabel = ba.beforeLabel?.trim() || "Before", afterLabel = ba.afterLabel?.trim() || "After";
  const askRating = ba.askRating !== false;
  const min = Number.isFinite(st.minValue) ? Number(st.minValue) : 1, max = Number.isFinite(st.maxValue) ? Number(st.maxValue) : 5;
  return {
    before: img(0, beforeLabel), after: img(1, afterLabel), beforeLabel, afterLabel,
    start: clampPosition(ba.startPosition ?? 50),
    askRating, ratingPrompt: ba.ratingPrompt?.trim() || "How would you rate the change?",
    min: askRating ? min : 0, max: askRating ? max : 100,
    ...(ba.minLabel ? { minLabel: ba.minLabel } : {}), ...(ba.maxLabel ? { maxLabel: ba.maxLabel } : {}),
  };
}

/** dwell per side, in milliseconds, accumulated as the divider moves (pure: the caller passes the clock) */
export class DwellClock {
  before = 0; after = 0;
  private side: "before" | "after";
  private since: number;
  constructor(pos: number, now: number) { this.side = pos >= 50 ? "before" : "after"; this.since = now; }
  move(pos: number, now: number): void {
    this.flush(now);
    this.side = pos >= 50 ? "before" : "after";
  }
  flush(now: number): void {
    const d = Math.max(0, now - this.since);
    if (this.side === "before") this.before += d; else this.after += d;
    this.since = now;
  }
  seconds(now: number): { before: number; after: number } {
    this.flush(now);
    return { before: Math.round(this.before / 100) / 10, after: Math.round(this.after / 100) / 10 };
  }
}

const SAFE = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
export function beforeAfterKeys(code: string): { position: string; dwellBefore: string; dwellAfter: string } {
  const k = `BA_${SAFE(code) || "Q"}`;
  return { position: `${k}_POSITION`, dwellBefore: `${k}_DWELL_BEFORE`, dwellAfter: `${k}_DWELL_AFTER` };
}
export function beforeAfterParadata(code: string, position: number, dwell: { before: number; after: number }): Record<string, number> {
  const k = beforeAfterKeys(code);
  return { [k.position]: clampPosition(position), [k.dwellBefore]: dwell.before, [k.dwellAfter]: dwell.after };
}

export function lintBeforeAfter(q: Pick<Question, "settings" | "text" | "code">): string[] {
  const out: string[] = [];
  const list = questionMediaList(q);
  if (list.length < 2) out.push(`${q.code}: a before / after slider needs two images (mediaItems[0] before, [1] after) — it has ${list.length}`);
  if (list.length > 2) out.push(`${q.code}: only the first two images are compared; ${list.length - 2} more are ignored`);
  const v = beforeAfterView(q);
  if (v.askRating && !(v.max > v.min)) out.push(`${q.code}: the rating needs a maximum above its minimum`);
  if (!v.askRating && ((q.settings.minValue ?? 0) > 0 || (q.settings.maxValue ?? 100) < 100)) out.push(`${q.code}: without a rating the answer is the divider position 0–100 — set minValue 0 and maxValue 100`);
  return out;
}
