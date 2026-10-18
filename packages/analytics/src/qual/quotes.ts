import type { QualExcerpt, QualSegment } from "./types.js";

/**
 * VERBATIM MEANS VERBATIM (2026-10-18).
 *
 * A quote in this product is a span of the source: `text.slice(start, end)`.
 * A model asked for evidence returns strings; each is LOCATED in the segment
 * it names, and a string that is not there is rejected — a paraphrase,
 * a summary, a "quote" stitched from two sentences or shortened with an
 * ellipsis is never presented as something a participant said.
 *
 * Locating forgives only what does not change the words: letter case, runs of
 * whitespace, straight vs curly quotes and apostrophes, hyphen vs dash. When
 * it finds the words that way, the quote stored is the SOURCE's own span
 * (its casing, its punctuation) — never the model's string.
 */

export interface QuoteSpan { start: number; end: number; /** found as given, character for character */ exact: boolean }

const FOLD: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "“": "\"", "”": "\"", "„": "\"", "″": "\"", "–": "-", "—": "-", "−": "-", " ": " " };

/** the folded text and, for each folded character, the index of the source character it came from */
function fold(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let c = FOLD[s[i]] ?? s[i];
    if (/\s/.test(c)) { if (space || !text.length) continue; c = " "; space = true; } else space = false;
    text += c.toLowerCase();
    map.push(i);
  }
  if (text.endsWith(" ")) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}

/** where a quote is in a text, or null when it is not there (a paraphrase, an ellipsis, words from elsewhere) */
export function locateQuote(source: string, quote: string, from = 0): QuoteSpan | null {
  const q = String(quote ?? "");
  if (!q.trim()) return null;
  const exactAt = source.indexOf(q, from);
  if (exactAt >= 0) return { start: exactAt, end: exactAt + q.length, exact: true };
  /* an ellipsis means the model left words out: whatever it stands for, the result is not something anyone said */
  if (/…|\.\.\./.test(q.trim().slice(1, -1))) return null;
  const s = fold(source), f = fold(q.trim().replace(/^["'“‘]+|["'”’]+$/g, ""));
  if (!f.text) return null;
  const startFolded = s.map.findIndex((i) => i >= from);
  if (startFolded < 0) return null;
  const at = s.text.indexOf(f.text, startFolded);
  if (at < 0) return null;
  const start = s.map[at], end = s.map[at + f.text.length - 1] + 1;
  return { start, end, exact: false };
}

/** true when the excerpt's quote is exactly its segment's span — the invariant every write keeps */
export function quoteMatchesSegment(ex: Pick<QualExcerpt, "charStart" | "charEnd" | "quote">, segmentText: string): boolean {
  return Number.isInteger(ex.charStart) && Number.isInteger(ex.charEnd) && ex.charStart >= 0 && ex.charEnd > ex.charStart && ex.charEnd <= segmentText.length && segmentText.slice(ex.charStart, ex.charEnd) === ex.quote;
}

/** every excerpt whose quote no longer matches its segment (or whose segment is gone) — for the integrity check */
export function brokenQuotes(excerpts: readonly QualExcerpt[], segments: readonly QualSegment[]): QualExcerpt[] {
  const byKey = new Map(segments.map((s) => [`${s.sourceId}|${s.id}`, s]));
  return excerpts.filter((e) => { const s = byKey.get(`${e.sourceId}|${e.segmentId}`); return !s || !quoteMatchesSegment(e, s.text); });
}
