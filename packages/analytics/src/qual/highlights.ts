import type { QualExcerpt, QualSegment, QualState } from "./types.js";
import { liveEvidence } from "./evidence.js";
import { codesOfTheme } from "./analysis.js";
import { tokenize, sentimentOf } from "../analyses/business.js";
import { stem } from "./ask.js";
import { excerptClip } from "./wordTimings.js";

/**
 * HIGHLIGHT REELS (2026-10-22) — a named collection of excerpts from across
 * sessions ("pricing complaints"), in an order the researcher chooses, each
 * with a note, and — when its source is a recording with timestamps — a CLIP:
 * the excerpt's segment from its start to its end (or to the next turn), played
 * from the recording through a short signed URL after the same access check as
 * the recording itself.
 *
 * An item keeps a snapshot of its excerpt (the quote, where it is), so a reel
 * still reads if the excerpt is later rejected, re-anchored or removed — and
 * says so ("the excerpt was changed / removed since"). Timing is the SEGMENT's:
 * transcripts carry turn timings, not word timings, so a clip plays the whole
 * turn the quote is in (stated on the reel). Stitching the clips into one video
 * is not done (no media processing in the Studio). Pure.
 */

export interface HighlightSnapshot { quote: string; sourceId: string; segmentId: string; speaker?: string; group?: string; start?: number; end?: number; charStart: number; charEnd: number; codeId: string }
export interface HighlightItem { excerptId: string; note?: string; snapshot: HighlightSnapshot }
export interface HighlightReel { id: string; name: string; description?: string; items: HighlightItem[]; createdBy: string; createdAt: string; updatedAt: string; version: number }

export const REEL_MAX_ITEMS = 100;
const segKey = (x: { sourceId: string; segmentId?: string; id?: string }) => `${x.sourceId}|${x.segmentId ?? x.id}`;

/** the time range of an excerpt's clip: its segment's start, to its end — else the next segment's start — else 30 s on */
export function clipRange(e: Pick<QualExcerpt, "sourceId" | "segmentId">, segments: readonly QualSegment[]): { start: number; end: number; approximate: boolean } | null {
  const seg = segments.find((s) => s.sourceId === e.sourceId && s.id === e.segmentId);
  if (!seg || typeof seg.start !== "number") return null;
  if (typeof seg.end === "number" && seg.end > seg.start) return { start: seg.start, end: seg.end, approximate: false };
  const next = segments.filter((s) => s.sourceId === e.sourceId && s.index > seg.index && typeof s.start === "number").sort((a, b) => a.index - b.index)[0];
  if (next && next.start! > seg.start) return { start: seg.start, end: next.start!, approximate: true };
  return { start: seg.start, end: seg.start + 30, approximate: true };
}

export function snapshotOf(e: QualExcerpt, segments: readonly QualSegment[]): HighlightSnapshot {
  const seg = segments.find((s) => s.sourceId === e.sourceId && s.id === e.segmentId);
  /* the excerpt's own words when the transcript has word timings (#17), else the turn */
  const clip = excerptClip(e, segments);
  return { quote: e.quote, sourceId: e.sourceId, segmentId: e.segmentId, codeId: e.codeId, charStart: e.charStart, charEnd: e.charEnd, ...(e.speaker ? { speaker: e.speaker } : {}), ...(seg?.group ? { group: seg.group } : {}), ...(clip ? { start: clip.start, end: clip.end } : {}) };
}

export type ReelOp =
  | { op: "add"; excerptIds: string[]; note?: string }
  | { op: "remove"; excerptId: string }
  | { op: "move"; excerptId: string; to: number }
  | { op: "note"; excerptId: string; note: string }
  | { op: "rename"; name: string; description?: string };

/** apply one change to a reel: only live excerpts can be added; duplicates are ignored */
export function applyReelOp(reel: HighlightReel, op: ReelOp, state: QualState, segments: readonly QualSegment[], now: string): HighlightReel {
  const next: HighlightReel = JSON.parse(JSON.stringify(reel));
  const live = new Map(liveEvidence(state, segments).map((e) => [e.id, e]));
  const at = (id: string) => { const i = next.items.findIndex((x) => x.excerptId === id); if (i < 0) throw new Error(`excerpt ${id} is not in this reel`); return i; };
  switch (op.op) {
    case "add": {
      const bad = op.excerptIds.filter((id) => !live.has(id));
      if (bad.length) throw new Error(`these excerpts do not exist, were rejected, or are moderator turns: ${bad.join(", ")}`);
      for (const id of op.excerptIds) if (!next.items.some((x) => x.excerptId === id)) next.items.push({ excerptId: id, ...(op.note?.trim() ? { note: op.note.trim().slice(0, 500) } : {}), snapshot: snapshotOf(live.get(id)!, segments) });
      if (next.items.length > REEL_MAX_ITEMS) throw new Error(`a reel holds at most ${REEL_MAX_ITEMS} excerpts`);
      break;
    }
    case "remove": next.items.splice(at(op.excerptId), 1); break;
    case "move": { const i = at(op.excerptId); const [x] = next.items.splice(i, 1); next.items.splice(Math.max(0, Math.min(next.items.length, Math.round(op.to))), 0, x); break; }
    case "note": { const i = at(op.excerptId); if (op.note.trim()) next.items[i].note = op.note.trim().slice(0, 500); else delete next.items[i].note; break; }
    case "rename": { if (!op.name.trim()) throw new Error("a reel needs a name"); next.name = op.name.trim().slice(0, 120); if (op.description !== undefined) next.description = op.description.trim().slice(0, 1000) || undefined; break; }
    default: throw new Error("unknown reel operation");
  }
  next.updatedAt = now; next.version = (next.version ?? 0) + 1;
  return next;
}

export type ItemState = "current" | "changed" | "removed";
/** each item against the coding now: the same excerpt and words, changed since it was added, or gone */
export function reelItemStates(reel: HighlightReel, state: QualState, segments: readonly QualSegment[]): Record<string, ItemState> {
  const live = new Map(liveEvidence(state, segments).map((e) => [e.id, e]));
  const out: Record<string, ItemState> = {};
  for (const it of reel.items) { const e = live.get(it.excerptId); out[it.excerptId] = !e ? "removed" : e.quote !== it.snapshot.quote || segKey(e) !== segKey(it.snapshot) ? "changed" : "current"; }
  return out;
}

/**
 * Excerpts for a reel on a topic ("pricing complaints"): codes and themes whose name or definition shares a
 * (stemmed) word with the topic, plus excerpts whose own words do; "complaints / negative / frustrations" keeps
 * only excerpts with a negative lexicon reading when there are any (said in the note); a group narrows it. Order:
 * one per source first. A proposal — the researcher sees it before the reel is made.
 */
export function selectForReel(state: QualState, segments: readonly QualSegment[], topic: string, opts: { group?: string; max?: number } = {}): { excerpts: QualExcerpt[]; codes: string[]; note: string } {
  const live = liveEvidence(state, segments);
  const NEG = /\b(?:complain\w*|negative|frustrat\w*|pain\s*points?|problems?|issues?|annoy\w*|angry|unhappy|dissatisf\w*|criticis\w*|grievances?)\b/i;
  const wantNegative = NEG.test(topic);
  const words = new Set(tokenize(topic.replace(NEG, " ")).map(stem).filter((w) => !["reel", "highlight", "clip", "quote", "make", "about", "all"].includes(w)));
  const codeHit = new Set<string>();
  for (const c of state.codebook.codes.filter((x) => x.status !== "rejected")) if (tokenize(`${c.name} ${c.definition}`).map(stem).some((w) => words.has(w))) codeHit.add(c.id);
  for (const t of state.codebook.themes.filter((x) => x.status !== "rejected")) if (tokenize(`${t.name} ${t.description ?? ""}`).map(stem).some((w) => words.has(w))) for (const c of codesOfTheme(state, t.id)) codeHit.add(c.id);
  const byKey = new Map(segments.map((s) => [segKey(s), s]));
  let pool = live.filter((e) => codeHit.has(e.codeId) || tokenize(e.quote).map(stem).some((w) => words.has(w)));
  if (opts.group) pool = pool.filter((e) => byKey.get(segKey(e))?.group?.toLowerCase() === opts.group!.toLowerCase());
  let note = `${pool.length} excerpt${pool.length === 1 ? "" : "s"} on “${[...words].join(", ") || topic}”${opts.group ? ` from ${opts.group}` : ""}`;
  if (wantNegative) {
    const neg = pool.filter((e) => sentimentOf(tokenize(e.quote)) < 0 || e.negativeCase);
    if (neg.length) { pool = neg; note += `; ${neg.length} read as negative by the word list (indicative — check them)`; }
    else note += "; none reads as negative by the word list, so all are offered — choose the complaints yourself";
  }
  /* one excerpt per segment: the same words coded twice are one clip */
  pool = pool.filter((e, i, a) => a.findIndex((x) => segKey(x) === segKey(e)) === i);
  const out: QualExcerpt[] = [];
  const seen = new Set<string>();
  for (const pass of [0, 1]) for (const e of pool) { if (out.length >= (opts.max ?? 20)) break; if (out.includes(e) || (pass === 0 && seen.has(e.sourceId))) continue; out.push(e); seen.add(e.sourceId); }
  return { excerpts: out, codes: [...codeHit], note };
}

export const CLIP_NOTE = "Clips play exactly the quote's words when the transcript has word timings (speech-to-text since 2026-10-22; timings re-aligned after a correction are approximate), otherwise the whole turn the quote is in. Clips are played one by one from the recording; joining them into one video is not done.";
