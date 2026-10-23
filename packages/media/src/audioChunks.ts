/**
 * LONG RECORDINGS IN ANY FORMAT (2026-10-22, engine item #17) — the pure half.
 *
 * The server splits WAV and MP3 without re-encoding (`audioSplit.ts`). Every
 * other format a browser can play — M4A/AAC, MP4, WebM/Opus, OGG, FLAC — needs
 * a decoder, and the Studio's server has none. The RESEARCHER'S BROWSER has
 * one: `decodeAudioData` (Web Audio), resampled to 16 kHz mono (what speech
 * models are trained on). This file is everything that is arithmetic about
 * that, testable in Node:
 *
 *   planChunks      where to cut 16-bit mono PCM so each WAV part (header
 *                   included) fits the provider's 25 MB, with an OVERLAP at
 *                   each cut so a word spoken across it is heard whole once
 *   encodeWav       PCM → a WAV file (44-byte header)
 *   floatToInt16 / downmix / resampleLinear   the sample maths (the browser
 *                   uses OfflineAudioContext to resample; the linear version
 *                   is the fallback and the reference the tests check)
 *   mergeChunkTranscripts   each part's words / segments moved onto the
 *                   recording's clock, the overlap DE-DUPLICATED (each overlap
 *                   is cut at its midpoint: a word belongs to the part in whose
 *                   half it starts; the text's seam is then checked for a
 *                   repeated phrase)
 *   decodeBudget    how long a recording the browser can decode within a
 *                   memory budget (decoded float PCM is 64 KB per second per
 *                   channel at 16 kHz) — refused in words above it
 */

export const CHUNK_SAMPLE_RATE = 16_000;
/** the same margin under 25 MB the server split uses */
export const CHUNK_TARGET_BYTES = 24 * 1024 * 1024;
export const CHUNK_OVERLAP_SECONDS = 2;
export const WAV_HEADER_BYTES = 44;

export interface ChunkPlan {
  index: number;
  /** first and one-past-last sample of the part, overlap included */
  startSample: number;
  endSample: number;
  /** where the part starts on the recording's clock */
  offsetSeconds: number;
  durationSeconds: number;
  /** seconds of this part shared with the previous / next part */
  overlapBefore: number;
  overlapAfter: number;
  /** the part's WAV size */
  bytes: number;
}

/**
 * Cut `totalSamples` of 16-bit mono PCM into parts of at most `maxBytes` (as
 * WAV), each starting `overlapSeconds` before the previous one ended.
 */
export function planChunks(totalSamples: number, sampleRate = CHUNK_SAMPLE_RATE, maxBytes = CHUNK_TARGET_BYTES, overlapSeconds = CHUNK_OVERLAP_SECONDS): ChunkPlan[] {
  const total = Math.max(0, Math.floor(totalSamples));
  if (!total) return [];
  const per = Math.floor((maxBytes - WAV_HEADER_BYTES) / 2);
  if (per <= 0) throw new Error("a part cannot hold any audio");
  const overlap = Math.min(Math.floor(overlapSeconds * sampleRate), Math.floor(per / 4));
  const out: ChunkPlan[] = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(total, start + per);
    out.push({
      index: out.length, startSample: start, endSample: end,
      offsetSeconds: start / sampleRate, durationSeconds: (end - start) / sampleRate,
      overlapBefore: out.length ? overlap / sampleRate : 0, overlapAfter: 0,
      bytes: WAV_HEADER_BYTES + (end - start) * 2,
    });
    if (end >= total) break;
    start = end - overlap;
  }
  for (let i = 0; i < out.length - 1; i++) out[i].overlapAfter = out[i + 1].overlapBefore;
  return out;
}

/** −1…1 floats → 16-bit PCM (clipped, rounded) */
export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = Math.max(-1, Math.min(1, f[i]));
    out[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
  }
  return out;
}

/** the average of the channels over [start, end) — one part at a time, so the mono copy never exists whole */
export function downmix(channels: readonly Float32Array[], start = 0, end = channels[0]?.length ?? 0): Float32Array {
  const n = Math.max(0, end - start);
  const out = new Float32Array(n);
  if (!channels.length) return out;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[start + i] ?? 0;
  if (channels.length > 1) for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** linear-interpolation resampling (the fallback where OfflineAudioContext is unavailable; and the test's reference) */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const n = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const x = i * step, j = Math.floor(x), t = x - j;
    const a = input[Math.min(j, input.length - 1)], b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * t;
  }
  return out;
}

/** 16-bit mono PCM → a WAV file */
export function encodeWav(pcm: Int16Array, sampleRate = CHUNK_SAMPLE_RATE): Uint8Array {
  const data = pcm.length * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + data);
  const v = new DataView(out.buffer);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + data, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, data, true);
  new Int16Array(out.buffer, WAV_HEADER_BYTES, pcm.length).set(pcm);
  return out;
}

/** how much a browser may decode: float PCM at 16 kHz is 64 KB/s per channel; the default budget is ~640 MB */
export const DECODE_BUDGET_BYTES = 640 * 1024 * 1024;
export function decodeBudget(durationSeconds: number, channels = 2, budget = DECODE_BUDGET_BYTES): { ok: boolean; bytes: number; maxSeconds: number } {
  const per = CHUNK_SAMPLE_RATE * 4 * Math.max(1, channels);
  const bytes = Math.ceil(durationSeconds * per);
  return { ok: bytes <= budget, bytes, maxSeconds: Math.floor(budget / per) };
}

/* ------------------------------------------------------------ merging the parts */

export interface ChunkWord { word: string; start: number; end: number }
export interface ChunkSegment { start: number; end: number; text: string; speaker?: string }
export interface ChunkTranscript {
  index: number;
  offsetSeconds: number;
  durationSeconds: number;
  overlapBefore: number;
  overlapAfter: number;
  text: string;
  segments?: ChunkSegment[];
  words?: ChunkWord[];
  diarized?: boolean;
}
export interface MergedTranscript {
  text: string;
  segments: ChunkSegment[];
  words: ChunkWord[];
  /** every part returned word timings */
  wordTimings: boolean;
  diarized: boolean;
  warnings: string[];
  /** words dropped as the duplicate of the neighbouring part's overlap */
  deduplicated: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/**
 * Move each part onto the recording's clock and de-duplicate the overlaps.
 * Overlap k (between part k and k+1) spans [offset(k+1), offset(k+1) + overlap];
 * its midpoint is the seam: part k keeps what STARTS before it, part k+1 what
 * starts at or after it. With word timings the seam is exact to the word; with
 * segments only, a segment belongs to the part where it starts. A phrase that
 * both parts heard across the seam with slightly different timings (one or two
 * words either side) is then caught by comparing the words at the seam.
 */
export function mergeChunkTranscripts(parts: readonly ChunkTranscript[]): MergedTranscript {
  const sorted = [...parts].sort((a, b) => a.index - b.index);
  const seams = sorted.map((p, i) => {
    const next = sorted[i + 1];
    return next ? next.offsetSeconds + next.overlapBefore / 2 : Infinity;
  });
  const from = (i: number) => (i > 0 ? seams[i - 1] : -Infinity);
  const words: ChunkWord[] = [];
  const segments: ChunkSegment[] = [];
  let dedup = 0;
  const wordTimings = sorted.length > 0 && sorted.every((p) => (p.words?.length ?? 0) > 0 || !p.text.trim());
  sorted.forEach((p, i) => {
    const lo = from(i), hi = seams[i];
    const all = (p.words ?? []).map((w) => ({ word: w.word, start: r3(w.start + p.offsetSeconds), end: r3(w.end + p.offsetSeconds) }));
    const ws = all.filter((w) => w.start >= lo && w.start < hi);
    dedup += all.length - ws.length;
    /* the seam check: drop leading words of this part that repeat the last words kept from the previous one */
    if (i > 0 && ws.length && words.length) {
      for (let k = Math.min(3, ws.length, words.length); k >= 1; k--) {
        const tail = words.slice(-k).map((w) => norm(w.word)).join(" "), head = ws.slice(0, k).map((w) => norm(w.word)).join(" ");
        if (tail && tail === head && ws[0].start - words[words.length - k].start < 2.5) { ws.splice(0, k); dedup += k; break; }
      }
    }
    words.push(...ws);
    const shifted = (p.segments ?? []).map((sg) => ({ ...sg, start: r3(sg.start + p.offsetSeconds), end: r3(sg.end + p.offsetSeconds) }));
    /* with word timings a segment straddling a seam is trimmed to this part's words; without, it belongs to the part where it starts */
    const segs = shifted.filter((sg) => (ws.length ? sg.end > lo && sg.start < hi : sg.start >= lo && sg.start < hi)).map((sg) => {
      /* a segment running across a seam: its text is the words this part keeps inside it (exact with word timings) */
      if (ws.length && (sg.end > hi || sg.start < lo)) {
        const inside = ws.filter((w) => w.start >= Math.max(sg.start - 0.05, lo) && w.start < Math.min(sg.end, hi));
        return inside.length ? { ...sg, start: Math.max(sg.start, inside[0].start), end: Math.min(sg.end, inside[inside.length - 1].end), text: inside.map((w) => w.word).join(" ") } : null;
      }
      return sg;
    }).filter((sg): sg is ChunkSegment => !!sg);
    if (segs.length) segments.push(...segs);
    else if (!p.segments?.length && p.text.trim()) {
      /* no segments: the part's kept words become one segment, else its text placed at its start */
      if (ws.length) segments.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.word).join(" ") });
      else segments.push({ start: r3(Math.max(p.offsetSeconds, lo)), end: r3(p.offsetSeconds + p.durationSeconds), text: p.text.trim() });
    }
  });
  const text = segments.map((sg) => sg.text.trim()).filter(Boolean).join(" ");
  const diarized = sorted.length > 0 && sorted.every((p) => p.diarized);
  const warnings: string[] = [];
  if (sorted.length > 1) {
    const at = sorted.slice(1).map((p) => `${Math.floor(p.offsetSeconds / 60)}:${String(Math.floor(p.offsetSeconds % 60)).padStart(2, "0")}`).join(", ");
    warnings.push(`The recording was decoded in this browser and transcribed in ${sorted.length} parts with ${Math.round(sorted[1].overlapBefore * 10) / 10} s of overlap (parts start at ${at}); words heard twice in an overlap were kept once${wordTimings ? " (by their word timings)" : " (by segment start — the provider returned no word timings, so a word at a seam may repeat or drop)"}.${diarized ? " Speakers were separated within each part only: “Speaker 1” in one part is not necessarily “Speaker 1” in the next — check the speaker map." : ""}`);
  }
  if (!wordTimings) warnings.push("The transcription service returned no word timings: clips play the whole turn a quote is in.");
  return { text, segments, words, wordTimings, diarized, warnings, deduplicated: Math.max(0, dedup) };
}
