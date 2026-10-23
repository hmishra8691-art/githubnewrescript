/**
 * SPLITTING LONG RECORDINGS FOR SPEECH-TO-TEXT (2026-10-22) — without
 * re-encoding, because a Vercel function has no ffmpeg.
 *
 * The provider reads at most 25 MB per request (`STT_MAX_BYTES`). A longer
 * recording is cut into parts that each fit, every part a valid file of its own,
 * each with the TIME OFFSET at which it starts, so the transcript's timestamps
 * are shifted back to the recording's clock:
 *
 *   WAV (RIFF, PCM or any fixed block size)  cut on block boundaries inside the
 *     `data` chunk; each part gets its own 44-byte header; offset = bytes ÷ byte rate. Exact.
 *   MP3 (MPEG-1/2/2.5 Layer III)             cut on frame boundaries (each frame's length and
 *     samples are read from its header; an ID3v2 tag is skipped); offset = Σ samples ÷ sample rate.
 *     Exact to the frame (≈ 26 ms); the first frame of a part may decode imperfectly (bit
 *     reservoir) — harmless for transcription.
 *
 * Everything else (M4A/AAC, MP4/MOV video, WebM/Opus, OGG, FLAC) is NOT split:
 * cutting those safely needs a demuxer, and their container index must be
 * rewritten — refused with that reason (`splitAudio` returns `unsupported`).
 * Pure: bytes in, parts out.
 */

export interface AudioPart { index: number; bytes: Uint8Array; offsetSeconds: number; durationSeconds: number; mimeType: string; fileName: string }
export type SplitResult =
  | { ok: true; format: "wav" | "mp3"; parts: AudioPart[]; durationSeconds: number }
  | { ok: false; reason: string; code: "unsupported" | "corrupt" | "too_many_parts" };

export const SPLIT_MAX_PARTS = 40;
/** a margin under the provider's 25 MB, for the multipart envelope */
export const SPLIT_TARGET_BYTES = 24 * 1024 * 1024;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

/** which of the splittable formats the bytes are (by content, not by name) */
export function sniffAudio(b: Uint8Array): "wav" | "mp3" | null {
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (b.length >= 10 && ascii(b, 0, 3) === "ID3") return "mp3";
  if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 1) & 3) === 1) return "mp3";
  return null;
}

/* ------------------------------------------------------------ WAV */

export interface WavInfo { channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number; byteRate: number; formatTag: number; dataStart: number; dataBytes: number }

export function readWav(b: Uint8Array): WavInfo | null {
  if (sniffAudio(b) !== "wav") return null;
  let at = 12, fmt: Omit<WavInfo, "dataStart" | "dataBytes"> | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4), size = u32(b, at + 4), body = at + 8;
    if (id === "fmt ") fmt = { formatTag: u16(b, body), channels: u16(b, body + 2), sampleRate: u32(b, body + 4), byteRate: u32(b, body + 8), blockAlign: u16(b, body + 12), bitsPerSample: u16(b, body + 14) };
    if (id === "data") {
      if (!fmt || !fmt.blockAlign || !fmt.byteRate) return null;
      /* a streaming writer may leave the size 0 or 0xFFFFFFFF: the data then runs to the end of the file */
      const dataBytes = size === 0 || size === 0xffffffff || body + size > b.length ? b.length - body : size;
      return { ...fmt, dataStart: body, dataBytes: dataBytes - (dataBytes % fmt.blockAlign) };
    }
    at = body + size + (size % 2);
  }
  return null;
}

function wavHeader(info: WavInfo, dataBytes: number): Uint8Array {
  const h = new Uint8Array(44);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i); };
  const p32 = (at: number, v: number) => { h[at] = v & 255; h[at + 1] = (v >>> 8) & 255; h[at + 2] = (v >>> 16) & 255; h[at + 3] = (v >>> 24) & 255; };
  const p16 = (at: number, v: number) => { h[at] = v & 255; h[at + 1] = (v >>> 8) & 255; };
  w(0, "RIFF"); p32(4, 36 + dataBytes); w(8, "WAVE"); w(12, "fmt "); p32(16, 16);
  p16(20, info.formatTag === 0xfffe ? 1 : info.formatTag); p16(22, info.channels); p32(24, info.sampleRate); p32(28, info.byteRate); p16(32, info.blockAlign); p16(34, info.bitsPerSample);
  w(36, "data"); p32(40, dataBytes);
  return h;
}

export function splitWav(b: Uint8Array, maxBytes = SPLIT_TARGET_BYTES): SplitResult {
  const info = readWav(b);
  if (!info) return { ok: false, code: "corrupt", reason: "This WAV file has no readable format and data sections." };
  const perPart = Math.floor((maxBytes - 44) / info.blockAlign) * info.blockAlign;
  if (perPart <= 0) return { ok: false, code: "corrupt", reason: "The WAV block size is larger than a part." };
  const parts: AudioPart[] = [];
  for (let off = 0; off < info.dataBytes; off += perPart) {
    const n = Math.min(perPart, info.dataBytes - off);
    const out = new Uint8Array(44 + n);
    out.set(wavHeader(info, n), 0);
    out.set(b.subarray(info.dataStart + off, info.dataStart + off + n), 44);
    parts.push({ index: parts.length, bytes: out, offsetSeconds: off / info.byteRate, durationSeconds: n / info.byteRate, mimeType: "audio/wav", fileName: `part-${parts.length + 1}.wav` });
    if (parts.length > SPLIT_MAX_PARTS) return { ok: false, code: "too_many_parts", reason: `The recording would need more than ${SPLIT_MAX_PARTS} parts of ${Math.round(maxBytes / 1024 / 1024)} MB; transcribe it elsewhere and import the transcript.` };
  }
  return { ok: true, format: "wav", parts, durationSeconds: info.dataBytes / info.byteRate };
}

/* ------------------------------------------------------------ MP3 */

const BITRATES: Record<string, number[]> = {
  /* MPEG-1 Layer III */ "1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  /* MPEG-2 / 2.5 Layer III */ "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export interface Mp3Frame { at: number; length: number; samples: number; sampleRate: number }

/** one MPEG audio Layer III frame header at `at`, or null */
export function mp3Frame(b: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[at + 1] >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bi = (b[at + 2] >> 4) & 15, ri = (b[at + 2] >> 2) & 3, pad = (b[at + 2] >> 1) & 1;
  if (bi === 0 || bi === 15 || ri === 3) return null;
  const kbps = BITRATES[version === 3 ? "1" : "2"][bi], rate = RATES[version][ri];
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
  return length > 4 ? { at, length, samples, sampleRate: rate } : null;
}

/** where the audio frames start: after an ID3v2 tag, at the first frame followed by another (a false sync is skipped) */
function mp3Start(b: Uint8Array): number {
  let at = 0;
  if (ascii(b, 0, 3) === "ID3" && b.length >= 10) at = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) + ((b[5] & 0x10) ? 10 : 0);
  for (let i = at; i < Math.min(b.length - 4, at + 64 * 1024); i++) { const f = mp3Frame(b, i); if (f && mp3Frame(b, i + f.length)) return i; }
  return -1;
}

export function splitMp3(b: Uint8Array, maxBytes = SPLIT_TARGET_BYTES): SplitResult {
  const start = mp3Start(b);
  if (start < 0) return { ok: false, code: "corrupt", reason: "No MP3 audio frames were found in this file." };
  const parts: AudioPart[] = [];
  let partStart = start, partSamples = 0, totalSamples = 0, rate = 0, at = start, offsetSamples = 0;
  const flush = (end: number) => {
    if (end <= partStart) return;
    parts.push({ index: parts.length, bytes: b.slice(partStart, end), offsetSeconds: offsetSamples / rate, durationSeconds: partSamples / rate, mimeType: "audio/mpeg", fileName: `part-${parts.length + 1}.mp3` });
    offsetSamples += partSamples; partStart = end; partSamples = 0;
  };
  while (at < b.length) {
    const f = mp3Frame(b, at);
    if (!f) {
      /* resynchronise (a stray byte, a trailing ID3v1 / APE tag): look ahead for the next frame */
      let next = -1;
      for (let i = at + 1; i < Math.min(b.length - 4, at + 8192); i++) { const g = mp3Frame(b, i); if (g && (i + g.length >= b.length || mp3Frame(b, i + g.length))) { next = i; break; } }
      if (next < 0) break;
      flush(at); partStart = next; at = next; continue;
    }
    rate = rate || f.sampleRate;
    if (at + f.length - partStart > maxBytes) flush(at);
    partSamples += f.samples; totalSamples += f.samples; at += f.length;
    if (parts.length > SPLIT_MAX_PARTS) return { ok: false, code: "too_many_parts", reason: `The recording would need more than ${SPLIT_MAX_PARTS} parts; transcribe it elsewhere and import the transcript.` };
  }
  flush(Math.min(at, b.length));
  if (!parts.length || !rate) return { ok: false, code: "corrupt", reason: "No MP3 audio frames were found in this file." };
  return { ok: true, format: "mp3", parts, durationSeconds: totalSamples / rate };
}

/** split a recording that is too large for one transcription request — WAV and MP3 only, honestly refused otherwise */
export function splitAudio(b: Uint8Array, mimeType = "", maxBytes = SPLIT_TARGET_BYTES): SplitResult {
  const kind = sniffAudio(b);
  if (kind === "wav") return splitWav(b, maxBytes);
  if (kind === "mp3") return splitMp3(b, maxBytes);
  return { ok: false, code: "unsupported", reason: `Recordings in ${mimeType || "this format"} cannot be split here without re-encoding (only WAV and MP3 can be cut safely as they are). Convert it to MP3 or WAV, or transcribe it elsewhere and import the .vtt / .srt — the timings are kept.` };
}

/** the timed segments of each part, moved onto the recording's clock; speaker labels kept as each part's provider gave them */
export function mergePartTranscripts(parts: readonly { offsetSeconds: number; text: string; segments?: { start: number; end: number; text: string; speaker?: string }[]; words?: { word: string; start: number; end: number }[]; diarized?: boolean }[]): { text: string; segments: { start: number; end: number; text: string; speaker?: string }[]; words: { word: string; start: number; end: number }[]; diarized: boolean; warnings: string[] } {
  const segments: { start: number; end: number; text: string; speaker?: string }[] = [];
  /* word timings (#17) move onto the recording's clock with their part (the server split has no overlap, so nothing to de-duplicate) */
  const words = parts.every((p) => p.words?.length || !p.text.trim())
    ? parts.flatMap((p) => (p.words ?? []).map((w) => ({ word: w.word, start: Math.round((w.start + p.offsetSeconds) * 1000) / 1000, end: Math.round((w.end + p.offsetSeconds) * 1000) / 1000 })))
    : [];
  for (const p of parts) {
    if (p.segments?.length) for (const s of p.segments) segments.push({ ...s, start: Math.round((s.start + p.offsetSeconds) * 1000) / 1000, end: Math.round((s.end + p.offsetSeconds) * 1000) / 1000 });
    else if (p.text.trim()) segments.push({ start: Math.round(p.offsetSeconds * 1000) / 1000, end: Math.round(p.offsetSeconds * 1000) / 1000, text: p.text.trim() });
  }
  const diarized = parts.length > 0 && parts.every((p) => p.diarized);
  const warnings = parts.length > 1 ? [`The recording was transcribed in ${parts.length} parts (cut at ${parts.slice(1).map((p) => `${Math.floor(p.offsetSeconds / 60)}:${String(Math.floor(p.offsetSeconds % 60)).padStart(2, "0")}`).join(", ")}); a word spoken across a cut may be split or lost.${diarized ? " Speakers were separated within each part only: “Speaker 1” in one part is not necessarily “Speaker 1” in the next — check the speaker map." : ""}`] : [];
  return { text: parts.map((p) => p.text.trim()).filter(Boolean).join(" "), segments, words, diarized, warnings };
}
