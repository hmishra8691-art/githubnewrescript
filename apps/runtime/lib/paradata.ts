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

/* ------------------------------------------------------------------ answer-value history (TE-02) */

/** the question types whose VALUES may be kept in the history: codes, numbers, ranks, grid cells */
export const HISTORY_CLOSED_TYPES = new Set([
  "single_select", "multi_select", "dropdown", "multi_dropdown", "image_select", "nps", "slider", "numeric", "numeric_list",
  "ranking", "image_ranking", "allocation", "matrix_single", "matrix_multi", "matrix_numeric", "matrix_dropdown",
]);
/** typed text: only its LENGTH is kept */
export const HISTORY_TEXT_TYPES = new Set(["open_text", "long_text", "text_list", "matrix_text"]);
/** at most this many entries per question — the latest are kept */
export const HISTORY_CAP = 20;

export type HistoryValue = string | number | boolean | null | (string | number)[] | Record<string, string | number | boolean | null | (string | number)[]> | { len: number };
export type HistoryEntry = [number, HistoryValue];

const prim = (v: unknown): v is string | number | boolean | null => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "string";
const short = (v: string | number | boolean | null) => (typeof v === "string" ? v.slice(0, 40) : v);
const primList = (v: unknown): (string | number)[] | undefined =>
  Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) ? v.map((x) => (typeof x === "string" ? x.slice(0, 40) : x)) : undefined;
const textLen = (v: unknown): number => typeof v === "string" ? v.length : Array.isArray(v) ? v.reduce((s: number, x) => s + textLen(x), 0) : v && typeof v === "object" ? Object.values(v).reduce((s: number, x) => s + textLen(x), 0) : 0;

/**
 * What the history keeps for one value of one question: the value itself for a closed type (codes, numbers, a
 * grid's cells — strings cut to 40 characters, at most 50 list items / 60 grid rows), `{ len }` for typed text,
 * and nothing (undefined) for every other type (uploads, places, dates, …). Never the text of an open end.
 */
export function historyValue(type: string | undefined, v: unknown): HistoryValue | undefined {
  if (!type) return undefined;
  if (HISTORY_TEXT_TYPES.has(type)) return { len: textLen(v) };
  if (!HISTORY_CLOSED_TYPES.has(type)) return undefined;
  if (v === undefined || v === null || v === "") return null;
  if (prim(v)) return short(v);
  const list = primList(v);
  if (list) return list;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 60) return undefined;
    const out: Record<string, string | number | boolean | null | (string | number)[]> = {};
    for (const [k, x] of entries) {
      if (prim(x)) out[k.slice(0, 40)] = short(x);
      else { const l = primList(x); if (!l) return undefined; out[k.slice(0, 40)] = l; }
    }
    return out;
  }
  return undefined;
}

/** append one entry, keeping the latest HISTORY_CAP; returns how many were dropped so far */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry, dropped = 0): number {
  list.push(entry);
  let d = dropped;
  while (list.length > HISTORY_CAP) { list.shift(); d++; }
  return d;
}

