import type { QuestionTiming } from "@rescript/quality";

/**
 * S5b — the pure arithmetic behind the newer paradata collectors (audit TE-04, TE-02, TE-06), kept apart from the
 * DOM wiring in telemetry.ts so it can be unit-tested. Nothing here ever sees answer TEXT: visibility is times,
 * scroll depth a percentage, value history the codes / numbers of closed questions only, idle periods durations.
 */

/* ------------------------------------------------------------------ visibility + scroll (TE-04) */

/**
 * A card counts as visible when at least half of it is inside the viewport — or, for a card taller than the
 * viewport (a long grid can never be half on screen), when it fills at least half of the viewport.
 */
export function isCardVisible(ratio: number, visibleHeight: number, viewportHeight: number): boolean {
  if (ratio >= 0.5) return true;
  return viewportHeight > 0 && visibleHeight >= viewportHeight * 0.5;
}

/** how far down the page the viewport's bottom edge is, % of the page height, 0–100 (a page that fits = 100) */
export function scrollDepthPct(scrollY: number, viewportHeight: number, pageHeight: number): number {
  if (!(pageHeight > 0)) return 100;
  const v = ((Math.max(0, scrollY) + Math.max(0, viewportHeight)) / pageHeight) * 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** start counting a question's visible time (idempotent while it stays visible) */
export function visibleStart(open: Map<string, number>, q: QuestionTiming, qid: string, t: number): void {
  if (open.has(qid)) return;
  open.set(qid, t);
  if (q.firstSeenAt === undefined) q.firstSeenAt = t;
}
/** stop counting it, adding the interval to visibleMs */
export function visibleStop(open: Map<string, number>, q: QuestionTiming | undefined, qid: string, t: number): void {
  const since = open.get(qid);
  if (since === undefined) return;
  open.delete(qid);
  if (q) q.visibleMs = (q.visibleMs ?? 0) + Math.max(0, t - since);
}
