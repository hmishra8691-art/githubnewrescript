/**
 * QUALITATIVE ANALYSIS — THE SHAPES (2026-10-18).
 *
 * Sources are transcripts (an interview or focus group, imported or
 * transcribed) and open-ended survey answers; both are cut into SEGMENTS (a
 * speaker turn, a subtitle cue, one respondent's answer). A CODEBOOK holds the
 * codes (definition, inclusion / exclusion criteria, parent / child), the
 * themes and subthemes they belong to and the relationships between codes.
 * An EXCERPT links a code to evidence: the source, the segment, the speaker,
 * the timestamp, the response, the exact character span — and the quote,
 * which is always `segment.text.slice(charStart, charEnd)`, never a model's
 * paraphrase. Everything AI-made is `ai_suggested` until a person reviews it.
 *
 * Pure data: shared by the Studio routes, the browser workspace and the
 * Word report. No I/O here.
 */

export type QualSourceKind = "transcript" | "response";
export type ReviewStatus = "ai_suggested" | "human_reviewed" | "rejected";

export interface QualSegment {
  /** stable within its source: "t3" for a transcript turn, "<responseId>:<questionId>" for an answer */
  id: string;
  sourceKind: QualSourceKind;
  /** the transcript id, or the open-ends snapshot id */
  sourceId: string;
  /** the turn's position in its source */
  index: number;
  /** the speaker's label as the source has it ("Moderator", "P2", "Speaker 1") */
  speaker?: string;
  /** seconds from the start of the recording */
  start?: number;
  end?: number;
  /** open ends: the response this answer belongs to */
  responseId?: string;
  questionId?: string;
  /** the participant segment (group) this turn belongs to, when known — the group in the theme table */
  group?: string;
  /** moderator turns are evidence of what was asked, not of what participants think */
  role?: "moderator" | "participant";
  text: string;
  /**
   * WORD TIMINGS (2026-10-22, #17): each word of `text` — seconds on the
   * recording's clock (`s`, `e`) and its character span (`c0`, `c1`); `a: 1`
   * when the timing was interpolated (a word the provider did not return, or
   * one a correction changed). Present only for speech-to-text asked for word
   * timestamps. `wordsStale` when a correction could not be re-aligned: clips
   * then play the whole turn.
   */
  words?: SegmentWord[];
  wordsStale?: boolean;
}

export interface SegmentWord { s: number; e: number; c0: number; c1: number; a?: 1 }

export interface QualCode {
  id: string;
  name: string;
  definition: string;
  include?: string;
  exclude?: string;
  parentId?: string | null;
  themeId?: string | null;
  status: ReviewStatus;
  origin: "inductive" | "deductive" | "manual";
}

export interface QualTheme {
  id: string;
  name: string;
  description?: string;
  /** a subtheme's parent theme */
  parentId?: string | null;
  status: ReviewStatus;
}

export type QualRelationKind = "causes" | "co_occurs" | "contradicts" | "part_of" | "associated";
export interface QualRelationship { id: string; from: string; to: string; kind: QualRelationKind; note?: string }

export interface QualCodebook {
  version: number;
  method: "inductive" | "deductive";
  /** the framework a deductive codebook was built from, in the researcher's words */
  framework?: string;
  codes: QualCode[];
  themes: QualTheme[];
  relationships: QualRelationship[];
}

export interface QualExcerpt {
  id: string;
  codeId: string;
  sourceKind: QualSourceKind;
  sourceId: string;
  segmentId: string;
  speaker?: string;
  start?: number;
  responseId?: string;
  /** the exact span inside the segment's text */
  charStart: number;
  charEnd: number;
  /** === segment.text.slice(charStart, charEnd) — checked on every write */
  quote: string;
  /** "ai" or the reviewer's user id */
  coder: string;
  status: ReviewStatus;
  /** a reviewer marked it as evidence AGAINST the theme it is coded to */
  negativeCase?: boolean;
  rationale?: string;
  createdAt?: string;
}

export interface QualHistoryEntry {
  at: string;
  actor: string;
  action: string;
  /** what happened, in words: "Merged “Cost” into “Price”" */
  detail: string;
  ids: string[];
}

export interface QualState {
  codebook: QualCodebook;
  excerpts: QualExcerpt[];
}

export const emptyCodebook = (): QualCodebook => ({ version: 0, method: "inductive", codes: [], themes: [], relationships: [] });
