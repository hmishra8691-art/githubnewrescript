import type { QualExcerpt, QualSegment, SegmentWord } from "./types.js";
import { diffHunks, mapOffset, type Hunk } from "./transcriptEdit.js";

/**
 * WORD TIMINGS ON A TRANSCRIPT (2026-10-22, engine item #17).
 *
 * Speech-to-text asked for word timestamps (`transcribe({ words: true })`)
 * returns each word with its start and end. Stored on each segment as
 * `words: [{ s, e, c0, c1 }]` — seconds on the recording's clock and the
 * word's CHARACTER SPAN in the segment's text — so an excerpt (a character
 * span) maps straight to a time range: the clip plays exactly the excerpt's
 * words instead of the whole turn.
 *
 *   alignWords        the provider's words → the segment text's tokens (the
 *                     provider writes "price" where the text says "price,";
 *                     a token it did not return is interpolated and marked
 *                     approximate)
 *   attachWords       a whole transcript: each word to the segment it falls in
 *   excerptClip       the time range of an excerpt — exact by its words, else
 *                     the turn (`clipRange`), said which
 *   realignAfterEdit  a corrected segment: words outside the edit keep their
 *                     timings (offsets shifted); the corrected words are given
 *                     timings interpolated across the time the replaced words
 *                     took, marked approximate; with no timed word on either
 *                     side the segment's word timings are flagged stale
 */

const TOKEN = /\S+/g;
const norm = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface TimedWord { word: string; start: number; end: number }

/** the word tokens of a text with their character spans */
export function tokenSpans(text: string): { t: string; c0: number; c1: number }[] {
  const out: { t: string; c0: number; c1: number }[] = [];
  for (const m of text.matchAll(TOKEN)) out.push({ t: m[0], c0: m.index!, c1: m.index! + m[0].length });
  return out;
}

/** fill the timings of unmatched tokens by interpolation between their timed neighbours (approximate) */
function interpolate(words: (SegmentWord | null)[], spans: { c0: number; c1: number }[], lo: number, hi: number): SegmentWord[] {
  const out: SegmentWord[] = [];
  let i = 0;
  while (i < words.length) {
    if (words[i]) { out.push(words[i]!); i++; continue; }
    let j = i;
    while (j < words.length && !words[j]) j++;
    const before = i > 0 ? words[i - 1]!.e : lo;
    const after = j < words.length ? words[j]!.s : hi;
    const span = Math.max(0, after - before), n = j - i;
    for (let k = 0; k < n; k++) out.push({ s: r3(before + (span * k) / n), e: r3(before + (span * (k + 1)) / n), c0: spans[i + k].c0, c1: spans[i + k].c1, a: 1 });
    i = j;
  }
  return out;
}

/**
 * Align the provider's words to a segment's text. Sequential with a small
 * look-ahead on both sides (the provider may split or merge a token); every
 * token of the text gets a timing — exact when matched, else interpolated.
 */
export function alignWords(text: string, words: readonly TimedWord[], segStart?: number, segEnd?: number): SegmentWord[] {
  const spans = tokenSpans(text);
  if (!spans.length) return [];
  const timed = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && norm(w.word));
  const lo = Number.isFinite(segStart) ? segStart! : timed[0]?.start ?? 0;
  const hi = Number.isFinite(segEnd) ? segEnd! : timed[timed.length - 1]?.end ?? lo;
  const got: (SegmentWord | null)[] = spans.map(() => null);
  let j = 0;
  for (let i = 0; i < spans.length && j < timed.length; i++) {
    const t = norm(spans[i].t);
    if (!t) continue;
    let hit = -1;
    for (let k = j; k < Math.min(timed.length, j + 4); k++) if (norm(timed[k].word) === t) { hit = k; break; }
    if (hit < 0) {
      /* a token the provider split ("don't" → "don", "t") or joined: compare concatenations */
      let acc = "";
      for (let k = j; k < Math.min(timed.length, j + 3); k++) { acc += norm(timed[k].word); if (acc === t) { got[i] = { s: r3(timed[j].start), e: r3(timed[k].end), c0: spans[i].c0, c1: spans[i].c1 }; j = k + 1; break; } }
      continue;
    }
    got[i] = { s: r3(timed[hit].start), e: r3(timed[hit].end), c0: spans[i].c0, c1: spans[i].c1 };
    j = hit + 1;
  }
  if (!got.some(Boolean)) return [];
  return interpolate(got, spans, lo, hi);
}

/** a transcript's words (recording clock) onto its segments: each word to the segment whose time it falls in */
export function attachWords<T extends { start?: number; end?: number; text: string }>(segments: readonly T[], words: readonly TimedWord[]): (T & { words?: SegmentWord[] })[] {
  if (!words.length) return segments.map((s) => ({ ...s }));
  const sorted = [...words].sort((a, b) => a.start - b.start);
  return segments.map((sg, i) => {
    if (typeof sg.start !== "number") return { ...sg };
    const next = segments[i + 1];
    const end = typeof sg.end === "number" ? sg.end : typeof next?.start === "number" ? next.start : Infinity;
    const mine = sorted.filter((w) => w.start >= sg.start! - 0.25 && w.start < end + 0.05);
    const aligned = alignWords(sg.text, mine, sg.start, Number.isFinite(end) ? end : undefined);
    return aligned.length ? { ...sg, words: aligned } : { ...sg };
  });
}

/** the excerpt's own time range from its words, else the whole turn (`clipRange` semantics) */
export function excerptClip(e: Pick<QualExcerpt, "sourceId" | "segmentId" | "charStart" | "charEnd">, segments: readonly QualSegment[]): { start: number; end: number; approximate: boolean; byWords: boolean } | null {
  const seg = segments.find((s) => s.sourceId === e.sourceId && s.id === e.segmentId);
  if (!seg || typeof seg.start !== "number") return null;
  if (seg.words?.length && !seg.wordsStale) {
    const inside = seg.words.filter((w) => w.c1 > e.charStart && w.c0 < e.charEnd);
    if (inside.length) {
      const start = Math.min(...inside.map((w) => w.s)), end = Math.max(...inside.map((w) => w.e));
      if (end > start) return { start: r3(start), end: r3(end), approximate: inside.some((w) => w.a === 1), byWords: true };
    }
  }
  if (typeof seg.end === "number" && seg.end > seg.start) return { start: seg.start, end: seg.end, approximate: false, byWords: false };
  const next = segments.filter((s) => s.sourceId === e.sourceId && s.index > seg.index && typeof s.start === "number").sort((a, b) => a.index - b.index)[0];
  if (next && next.start! > seg.start) return { start: seg.start, end: next.start!, approximate: true, byWords: false };
  return { start: seg.start, end: seg.start + 30, approximate: true, byWords: false };
}

/**
 * Keep the word timings of a corrected segment aligned. Words outside every
 * edit keep their timings with their offsets moved; the words of the corrected
 * text inside an edit are timed by interpolation across the time the replaced
 * words occupied (bounded by the nearest timed words either side) and marked
 * approximate. If an edit has no timed word on either side to bound it, the
 * segment's word timings are flagged STALE and clips fall back to the turn.
 */
export function realignAfterEdit(before: string, after: string, words: readonly SegmentWord[] | undefined, segStart?: number, segEnd?: number, hunks: readonly Hunk[] = diffHunks(before, after)): { words?: SegmentWord[]; stale: boolean; approximate: number } {
  if (!words?.length) return { stale: false, approximate: 0 };
  if (!hunks.length) return { words: [...words], stale: false, approximate: 0 };
  const touched = (w: SegmentWord) => hunks.some((h) => (h.oldStart < w.c1 && h.oldEnd > w.c0) || (h.oldStart === h.oldEnd && h.oldStart > w.c0 && h.oldStart < w.c1));
  const kept = words.filter((w) => !touched(w)).map((w) => ({ ...w, c0: mapOffset(hunks, w.c0, "start"), c1: mapOffset(hunks, w.c1, "end") }));
  /* the new text's tokens: timed when a kept word sits exactly on them, else interpolated */
  const spans = tokenSpans(after);
  const got: (SegmentWord | null)[] = spans.map((sp) => kept.find((w) => w.c0 === sp.c0 && w.c1 === sp.c1) ?? null);
  const unbounded = spans.some((_, i) => {
    if (got[i]) return false;
    const left = got.slice(0, i).some(Boolean), right = got.slice(i + 1).some(Boolean);
    return !left && !right && !Number.isFinite(segStart);
  });
  if (unbounded || !got.some(Boolean)) return { stale: true, approximate: 0 };
  const lo = Number.isFinite(segStart) ? segStart! : got.find(Boolean)!.s;
  const hi = Number.isFinite(segEnd) ? segEnd! : [...got].reverse().find(Boolean)!.e;
  const out = interpolate(got, spans, lo, hi);
  return { words: out, stale: false, approximate: out.filter((w) => w.a === 1).length };
}
