import type { QualExcerpt } from "./types.js";

/**
 * TRANSCRIPT CORRECTION WITH HISTORY (2026-10-22) — fixing what speech-to-text
 * misheard ("the prize went up" → "the price went up") without ever corrupting a
 * quote. A segment's text is replaced; every excerpt on that segment is moved
 * through the edit:
 *
 *   • an edit OUTSIDE the excerpt's span shifts its offsets — the quote is the
 *     same words, still `text.slice(start, end)`;
 *   • an edit INSIDE (or across) the span re-anchors it to the corrected words:
 *     the quote becomes the corrected span, the old quote is kept, and the
 *     excerpt is flagged "re-anchored — check it" for review;
 *   • an edit that deletes the whole span INVALIDATES the excerpt: it is
 *     rejected with the reason, never left pointing at other words.
 *
 * The diff is word-level (an LCS over word/space tokens), so two corrections far
 * apart do not drag the text between them into the "changed" region. Pure.
 */

export interface Hunk { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
export interface ExcerptAnchor { state: "reanchored" | "invalid"; previousQuote: string; at: string; revision: number }
export type AnchoredExcerpt = QualExcerpt & { anchor?: ExcerptAnchor };
export interface EditOutcome { excerptId: string; outcome: "unchanged" | "shifted" | "reanchored" | "invalid"; before: { start: number; end: number; quote: string }; after?: { start: number; end: number; quote: string } }

const TOKEN = /\s+|[^\s]+/g;
const tokens = (s: string) => s.match(TOKEN) ?? [];

/** the edit hunks between two texts, in character offsets of each */
export function diffHunks(a: string, b: string): Hunk[] {
  if (a === b) return [];
  /* common prefix / suffix first: most corrections are one word */
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ta = tokens(a.slice(p, a.length - s)), tb = tokens(b.slice(p, b.length - s));
  if (!ta.length || !tb.length || ta.length * tb.length > 4_000_000) return [{ oldStart: p, oldEnd: a.length - s, newStart: p, newEnd: b.length - s }];
  /* LCS over tokens of the middle */
  const n = ta.length, m = tb.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: Hunk[] = [];
  let i = 0, j = 0, ao = p, bo = p;
  let cur: Hunk | null = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) { flush(); ao += ta[i].length; bo += tb[j].length; i++; j++; continue; }
    if (!cur) cur = { oldStart: ao, oldEnd: ao, newStart: bo, newEnd: bo };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { bo += tb[j].length; cur.newEnd = bo; j++; }
    else { ao += ta[i].length; cur.oldEnd = ao; i++; }
  }
  flush();
  return hunks;
}

/** where an offset of the old text is in the new one; an offset inside a changed region goes to that region's edge */
export function mapOffset(hunks: readonly Hunk[], x: number, edge: "start" | "end"): number {
  /* hunks carry absolute positions in both texts, so the shift after a hunk is newEnd − oldEnd */
  let shift = 0;
  for (const h of hunks) {
    if (edge === "start" ? x < h.oldStart : x <= h.oldStart) break;
    if (x < h.oldEnd) return edge === "start" ? h.newStart : h.newEnd;
    shift = h.newEnd - h.oldEnd;
  }
  return x + shift;
}

/** does an edit touch the span [start, end)? (an insertion strictly inside it does) */
export const spanTouched = (hunks: readonly Hunk[], start: number, end: number): boolean => hunks.some((h) => (h.oldStart < end && h.oldEnd > start) || (h.oldStart === h.oldEnd && h.oldStart > start && h.oldStart < end));

/** move one excerpt through an edit of its segment */
export function reanchorExcerpt(e: QualExcerpt, before: string, after: string, hunks: readonly Hunk[], env: { now: string; revision: number }): { excerpt: AnchoredExcerpt; outcome: EditOutcome } {
  const was = { start: e.charStart, end: e.charEnd, quote: e.quote };
  if (!hunks.length) return { excerpt: e, outcome: { excerptId: e.id, outcome: "unchanged", before: was, after: was } };
  const start = mapOffset(hunks, e.charStart, "start"), end = mapOffset(hunks, e.charEnd, "end");
  const touched = spanTouched(hunks, e.charStart, e.charEnd);
  const quote = after.slice(start, end);
  if (end <= start || !quote.trim()) {
    const x: AnchoredExcerpt = { ...e, status: "rejected", anchor: { state: "invalid", previousQuote: e.quote, at: env.now, revision: env.revision }, rationale: `The corrected transcript no longer contains these words (was “${e.quote.slice(0, 200)}”).` };
    return { excerpt: x, outcome: { excerptId: e.id, outcome: "invalid", before: was } };
  }
  if (!touched && quote === e.quote) {
    const moved = start !== e.charStart;
    return { excerpt: { ...e, charStart: start, charEnd: end }, outcome: { excerptId: e.id, outcome: moved ? "shifted" : "unchanged", before: was, after: { start, end, quote } } };
  }
  const x: AnchoredExcerpt = { ...e, charStart: start, charEnd: end, quote, anchor: { state: "reanchored", previousQuote: e.quote, at: env.now, revision: env.revision } };
  return { excerpt: x, outcome: { excerptId: e.id, outcome: quote === e.quote ? "shifted" : "reanchored", before: was, after: { start, end, quote } } };
}

export interface SegmentEditResult { excerpts: AnchoredExcerpt[]; outcomes: EditOutcome[]; hunks: Hunk[]; summary: string }

/** apply a corrected text to one segment: every excerpt of it moved, re-anchored or invalidated; the rest untouched */
export function editSegmentExcerpts(excerpts: readonly QualExcerpt[], sourceId: string, segmentId: string, before: string, after: string, env: { now: string; revision: number }): SegmentEditResult {
  const hunks = diffHunks(before, after);
  const outcomes: EditOutcome[] = [];
  const next = excerpts.map((e) => {
    if (e.sourceId !== sourceId || e.segmentId !== segmentId) return e;
    const r = reanchorExcerpt(e, before, after, hunks, env);
    outcomes.push(r.outcome);
    return r.excerpt;
  });
  const n = (k: EditOutcome["outcome"]) => outcomes.filter((o) => o.outcome === k).length;
  const summary = outcomes.length ? `${n("shifted") + n("unchanged")} excerpt${n("shifted") + n("unchanged") === 1 ? "" : "s"} kept their words${n("reanchored") ? `, ${n("reanchored")} re-anchored to the corrected words (check them)` : ""}${n("invalid") ? `, ${n("invalid")} invalidated (their words were removed)` : ""}` : "no excerpt was coded on this segment";
  return { excerpts: next, outcomes, hunks, summary };
}

/** a correction must be a correction: not empty, not longer than a turn can be, different from the text */
export function checkCorrection(before: string, after: unknown): string | null {
  if (typeof after !== "string") return "send the corrected text";
  if (!after.trim()) return "a segment cannot be emptied — delete the transcript or leave the turn";
  if (after.length > 20_000) return "a segment is at most 20,000 characters";
  if (after === before) return "nothing changed";
  return null;
}

/** excerpts that need a person to look again after corrections */
export const needsAnchorReview = (excerpts: readonly QualExcerpt[]): AnchoredExcerpt[] => (excerpts as AnchoredExcerpt[]).filter((e) => e.anchor?.state === "reanchored" && e.status !== "rejected");

export interface TranscriptRevision { revision: number; segmentId: string; before: string; after: string; actor: string; at: string; outcomes: EditOutcome[] }
