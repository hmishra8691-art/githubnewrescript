import type { QualSegment } from "./types.js";

/**
 * TRANSCRIPT IMPORT (2026-10-18) — the formats a research team actually has:
 *
 *   vtt      WebVTT captions (Zoom, Teams, Meet): timed cues, `<v Speaker>` voice tags
 *   srt      SubRip subtitles: numbered timed cues
 *   speaker  "Speaker: text" turns, with an optional timestamp before or after the name
 *            ("[00:01:02] Moderator: …", "P2 (00:03:10): …", "00:12 Anna: …")
 *   text     plain text: one turn per paragraph, no speaker
 *
 * A .docx is read to text first (`readDocxText`, export entry) and then parsed
 * like any other text. Speaker ids and timestamps are preserved exactly as the
 * file has them; nothing is renamed or guessed except the moderator role, which
 * is suggested from the label ("Moderator", "Interviewer", "Facilitator") and
 * can be changed. Pure: no I/O.
 */

export type TranscriptFormat = "vtt" | "srt" | "speaker" | "text";
export interface TranscriptTurn { speaker?: string; start?: number; end?: number; text: string }
export interface ParsedTranscript { format: TranscriptFormat; turns: TranscriptTurn[]; speakers: string[]; warnings: string[] }

export const TRANSCRIPT_MAX_CHARS = 2_000_000;
export const TRANSCRIPT_MAX_TURNS = 20_000;

/** "01:02:03.450", "02:03,450", "1:02:03", "02:03" → seconds; null when it is not a timestamp */
export function parseTimestamp(s: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0, min = Number(m[2]), sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return Math.round((h * 3600 + min * 60 + sec + ms / 1000) * 1000) / 1000;
}

/** seconds → "hh:mm:ss" (or "mm:ss" under an hour) */
export function formatTimestamp(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

const TIMING = /^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
/** a speaker label: a name, a role or "Speaker 2" — short, starts with a letter, no sentence punctuation */
const LABEL = "[\\p{L}][\\p{L}\\p{N} ._'’()-]{0,38}?";
const TS = "\\[?\\(?((?:\\d{1,3}:)?\\d{1,2}:\\d{2}(?:[.,]\\d{1,3})?)\\)?\\]?";
const SPEAKER_LINE = [
  new RegExp(`^\\s*${TS}\\s+(${LABEL})\\s*:\\s+(.*)$`, "u"),           // [00:01:02] Name: text
  new RegExp(`^\\s*(${LABEL})\\s+${TS}\\s*:?\\s+(.*)$`, "u"),           // Name (00:01:02): text | Name 00:01:02 text
  new RegExp(`^\\s*(${LABEL})\\s*:\\s+(.*)$`, "u"),                     // Name: text
];
const NOT_A_SPEAKER = /^(?:note|notes|http|https|www|q|a|question|answer|re|subject|date|time|tel|e-?mail)$/i;

function speakerLine(line: string): { speaker: string; start?: number; text: string } | null {
  let m = SPEAKER_LINE[0].exec(line);
  if (m) return label(m[2], m[3], m[1]);
  m = SPEAKER_LINE[1].exec(line);
  if (m) return label(m[1], m[3], m[2]);
  m = SPEAKER_LINE[2].exec(line);
  if (m) return label(m[1], m[2]);
  return null;
}
function label(name: string, text: string, ts?: string): { speaker: string; start?: number; text: string } | null {
  const speaker = name.trim().replace(/\s+/g, " ");
  if (!speaker || NOT_A_SPEAKER.test(speaker) || speaker.split(" ").length > 4) return null;
  const start = ts ? parseTimestamp(ts) : null;
  return { speaker, ...(start != null ? { start } : {}), text: text.trim() };
}

const stripTags = (s: string) => s.replace(/<\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?>/g, "").replace(/<\/?(?:c|i|b|u|ruby|rt|lang)(?:[.\s][^>]*)?>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/** which format a text is in — the file name's extension wins when it is one of ours */
export function detectTranscriptFormat(text: string, fileName = ""): TranscriptFormat {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "vtt") return "vtt";
  if (ext === "srt") return "srt";
  const head = text.replace(/^﻿/, "").trimStart();
  if (/^WEBVTT\b/.test(head)) return "vtt";
  const lines = head.split(/\r?\n/).slice(0, 40);
  if (lines.some((l, i) => /^\d+\s*$/.test(l) && TIMING.test(lines[i + 1] ?? ""))) return "srt";
  if (lines.filter((l) => TIMING.test(l)).length >= 2) return "vtt";
  const nonEmpty = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 200);
  const labelled = nonEmpty.filter((l) => speakerLine(l));
  return nonEmpty.length && labelled.length / nonEmpty.length >= 0.3 && labelled.length >= 2 ? "speaker" : "text";
}

function cues(text: string, format: "vtt" | "srt"): TranscriptTurn[] {
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out: TranscriptTurn[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, REGION, or noise
    const m = TIMING.exec(lines[at])!;
    const start = parseTimestamp(m[1]) ?? undefined, end = parseTimestamp(m[2]) ?? undefined;
    let body = lines.slice(at + 1).join("\n");
    let speaker: string | undefined;
    if (format === "vtt") {
      const v = /<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(body);
      if (v) speaker = v[1].trim();
      body = body.replace(/<\/?v(?:\.[^\s>]+)?(?:\s+[^>]+)?>/g, "");
    }
    body = stripTags(body).replace(/\s*\n\s*/g, " ").trim();
    if (!speaker) { const s = speakerLine(body); if (s) { speaker = s.speaker; body = s.text; } else { const b = /^\[([^\]]{1,40})\]\s+(.*)$/.exec(body); if (b && !parseTimestamp(b[1])) { speaker = b[1].trim(); body = b[2]; } } }
    if (!body) continue;
    out.push({ ...(speaker ? { speaker } : {}), ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}), text: body });
  }
  /* subtitle cues are a line or two: join a speaker's consecutive cues into one turn, and an unlabelled cue that continues a sentence */
  const merged: TranscriptTurn[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    const sameSpeaker = prev && c.speaker && prev.speaker === c.speaker;
    const continues = prev && !c.speaker && !prev.speaker && !/[.?!…"”]$/.test(prev.text) && (c.start === undefined || prev.end === undefined || c.start - prev.end <= 2);
    if (sameSpeaker || continues) { prev.text = `${prev.text} ${c.text}`; if (c.end !== undefined) prev.end = c.end; }
    else merged.push({ ...c });
  }
  return merged;
}

function speakerTurns(text: string): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const raw of text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const s = speakerLine(line);
    if (s) out.push({ speaker: s.speaker, ...(s.start !== undefined ? { start: s.start } : {}), text: s.text });
    else if (out.length) out[out.length - 1].text = `${out[out.length - 1].text}${out[out.length - 1].text ? " " : ""}${line}`;
    else out.push({ text: line });
  }
  return out.filter((t) => t.text);
}

const paragraphs = (text: string): TranscriptTurn[] => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).map((t) => ({ text: t }));

/** Parse a transcript. `format` "auto" (default) detects it. */
export function parseTranscript(text: string, opts: { format?: TranscriptFormat | "auto"; fileName?: string } = {}): ParsedTranscript {
  const warnings: string[] = [];
  let src = String(text ?? "");
  if (src.length > TRANSCRIPT_MAX_CHARS) { warnings.push(`The transcript is ${src.length.toLocaleString("en")} characters; the first ${TRANSCRIPT_MAX_CHARS.toLocaleString("en")} were imported.`); src = src.slice(0, TRANSCRIPT_MAX_CHARS); }
  const format = !opts.format || opts.format === "auto" ? detectTranscriptFormat(src, opts.fileName) : opts.format;
  let turns = format === "vtt" || format === "srt" ? cues(src, format) : format === "speaker" ? speakerTurns(src) : paragraphs(src);
  if (turns.length > TRANSCRIPT_MAX_TURNS) { warnings.push(`${turns.length} turns; the first ${TRANSCRIPT_MAX_TURNS} were imported.`); turns = turns.slice(0, TRANSCRIPT_MAX_TURNS); }
  if (!turns.length) warnings.push("No text was found in the file.");
  if ((format === "vtt" || format === "srt") && turns.length && !turns.some((t) => t.speaker)) warnings.push("The captions carry no speaker names: every turn is unattributed. Assign speakers after import, or export the captions with speaker names.");
  if (format === "text" && turns.length) warnings.push("Plain text: one turn per paragraph, no speakers or timestamps. Use “Speaker: text” lines to keep who said what.");
  const speakers = [...new Set(turns.map((t) => t.speaker).filter((s): s is string => !!s))];
  return { format, turns, speakers, warnings };
}

const MODERATOR = /^(?:moderator|mod|interviewer|int|facilitator|researcher|host|i)\b/i;
export const suggestRole = (speaker: string | undefined): "moderator" | "participant" | undefined => (!speaker ? undefined : MODERATOR.test(speaker.trim()) ? "moderator" : "participant");

export interface SpeakerInfo { role?: "moderator" | "participant"; group?: string; participantId?: string }

/** the turns as segments of one transcript: ids t1…tn in order, roles and groups from the speaker map */
export function transcriptSegments(sourceId: string, turns: TranscriptTurn[], speakers: Record<string, SpeakerInfo> = {}): QualSegment[] {
  return turns.map((t, i) => {
    const info = t.speaker ? speakers[t.speaker] : undefined;
    const role = info?.role ?? suggestRole(t.speaker);
    return {
      id: `t${i + 1}`, sourceKind: "transcript", sourceId, index: i,
      ...(t.speaker ? { speaker: t.speaker } : {}), ...(t.start !== undefined ? { start: t.start } : {}), ...(t.end !== undefined ? { end: t.end } : {}),
      ...(role ? { role } : {}), ...(info?.group ? { group: info.group } : {}),
      text: t.text,
    };
  });
}

/** open-ended answers as segments: one per answered response × question */
export function openEndSegments(sourceId: string, rows: { responseId: string; answers: Record<string, unknown>; group?: string }[], questions: { id: string; code?: string }[]): QualSegment[] {
  const out: QualSegment[] = [];
  for (const r of rows) for (const q of questions) {
    const v = r.answers[q.id] ?? (q.code ? r.answers[q.code] : undefined);
    const text = typeof v === "string" ? v.trim() : v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? String((v as { text: string }).text).trim() : "";
    if (!text) continue;
    out.push({ id: `${r.responseId}:${q.id}`, sourceKind: "response", sourceId, index: out.length, responseId: r.responseId, questionId: q.id, speaker: `R-${r.responseId.slice(0, 8)}`, role: "participant", ...(r.group ? { group: r.group } : {}), text });
  }
  return out;
}
