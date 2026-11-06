/**
 * REVIEWED QUOTES FOR THE SURVEY DECK AND REPORT (platform audit 2026-11-05; capability `qualitative:quotes`,
 * previously partial: "the qualitative report carries reviewed verbatim excerpts with source, speaker and time;
 * the survey findings deck and report do not").
 *
 * Selects, per theme, the excerpts a person has reviewed — never an AI suggestion, never a rejected one, never
 * a moderator's turn — spread across sources (one per source first, so four quotes are four voices, not one
 * participant four times), redacted with the study's own name list, and shaped as the deck carries them. A
 * contrasting view (`negativeCase`) is kept and labelled: a deck that only quotes agreement is advertising.
 */
import type { QualExcerpt, QualSegment, QualState } from "./types.js";
import type { SourceMeta } from "./evidence.js";
import { liveEvidence } from "./evidence.js";
import { redactText, type RedactOptions } from "./redact.js";
import { formatTimestamp } from "./transcripts.js";
import type { DeckQuoteSet } from "../deck.js";

export interface DeckQuoteOptions {
  sources?: Record<string, SourceMeta>;
  redact?: RedactOptions;
  /** quotes per theme (default 4) */
  perTheme?: number;
  /** themes at most (default 6), most-quoted first */
  maxThemes?: number;
  /** longest quote kept, in characters (default 280) */
  maxChars?: number;
}

export function deckQuotesFor(state: QualState, segments: readonly QualSegment[], opts: DeckQuoteOptions = {}): DeckQuoteSet[] {
  const perTheme = opts.perTheme ?? 4;
  const maxChars = opts.maxChars ?? 280;
  const live = liveEvidence(state, segments).filter((e) => e.status === "human_reviewed" && e.quote.trim().length >= 12 && e.quote.length <= maxChars);
  const themeOfCode = new Map(state.codebook.codes.map((c) => [c.id, c.themeId ?? null]));
  const themes = state.codebook.themes.filter((t) => t.status !== "rejected");
  const byTheme = new Map<string, QualExcerpt[]>();
  for (const e of live) {
    const t = themeOfCode.get(e.codeId);
    if (!t) continue;
    byTheme.set(t, [...(byTheme.get(t) ?? []), e]);
  }
  const title = (id: string) => opts.sources?.[id]?.title ?? "a participant";
  const out: DeckQuoteSet[] = [];
  for (const t of themes) {
    const all = byTheme.get(t.id) ?? [];
    if (!all.length) continue;
    /* one per source first, then the rest — four quotes are four voices */
    const seen = new Set<string>();
    const first: QualExcerpt[] = [], rest: QualExcerpt[] = [];
    for (const e of all) { if (seen.has(e.sourceId)) rest.push(e); else { seen.add(e.sourceId); first.push(e); } }
    const picked = [...first, ...rest].slice(0, perTheme);
    out.push({
      theme: t.name,
      coverage: `${seen.size} source${seen.size === 1 ? "" : "s"}`,
      quotes: picked.map((e) => ({
        quote: redactText(e.quote, opts.redact).text,
        source: title(e.sourceId),
        ...(e.speaker ? { speaker: redactText(e.speaker, opts.redact).text } : {}),
        ...(e.start != null ? { time: formatTimestamp(e.start) } : {}),
        ...(e.negativeCase ? { negativeCase: true } : {}),
      })),
    });
  }
  return out.sort((a, b) => b.quotes.length - a.quotes.length || a.theme.localeCompare(b.theme)).slice(0, opts.maxThemes ?? 6);
}
