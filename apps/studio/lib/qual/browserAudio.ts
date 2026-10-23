import {
  planChunks, encodeWav, floatToInt16, downmix, resampleLinear, mergeChunkTranscripts, decodeBudget, sniffAudio,
  CHUNK_SAMPLE_RATE, STT_MAX_BYTES, type ChunkPlan, type ChunkTranscript, type MergedTranscript,
} from "@rescript/media";

/**
 * A RECORDING IN ANY FORMAT THE BROWSER CAN PLAY → WAV PARTS FOR SPEECH-TO-TEXT (2026-10-22, engine item #17).
 *
 * The server can split WAV and MP3 without re-encoding; everything else (M4A/AAC, MP4, WebM/Opus, OGG,
 * FLAC) needs a decoder, which the researcher's browser has:
 *
 *   1  how long it is, from the media element's metadata (nothing decoded yet) — refused in words when
 *      decoding it would exceed the memory budget (`decodeBudget`: 16 kHz float PCM per channel)
 *   2  `decodeAudioData` on an OfflineAudioContext running at 16 kHz: the decoder resamples while it
 *      decodes, so the full-rate PCM never exists (if a browser hands back another rate, an
 *      OfflineAudioContext render resamples it to 16 kHz mono)
 *   3  the encoded bytes are let go; the 16 kHz channels are cut into parts of ≤ 24 MB as WAV with 2 s of
 *      overlap (`planChunks`), each part downmixed to mono and encoded only when it is sent — one part's
 *      PCM in memory at a time beside the decoded buffer
 *   4  each part is transcribed by the route (`qual/recordings/chunk`), with word timings; the parts are
 *      merged on the recording's clock, the overlap de-duplicated (`mergeChunkTranscripts`)
 *
 * Browser-only (Web Audio); the arithmetic lives in `@rescript/media` and is unit-tested there.
 */

export interface DecodedAudio { channels: Float32Array[]; sampleRate: number; durationSeconds: number }

/** does this recording need the browser path? (anything the server cannot split; WAV / MP3 over 25 MB stay server-side) */
export async function needsBrowserDecode(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return sniffAudio(head) === null;
}

/** the duration from metadata only — no decode */
export function mediaDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const done = (v: number | null) => { URL.revokeObjectURL(url); el.removeAttribute("src"); resolve(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 15_000);
    el.src = url;
  });
}

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;
const offlineCtor = (): OfflineCtor | null => {
  const w = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null;
};

/** decode at 16 kHz (resampled by the decoder, or rendered down when a browser will not) */
export async function decodeTo16k(file: Blob, onPhase?: (phase: string) => void): Promise<DecodedAudio> {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error("This browser has no Web Audio decoder — use Chrome, Edge, Firefox or Safari, or convert the recording to MP3.");
  const duration = await mediaDuration(file);
  if (duration != null) {
    const b = decodeBudget(duration, 2);
    if (!b.ok) throw new Error(`The recording is ${Math.round(duration / 60)} minutes long; this browser can decode up to about ${Math.floor(b.maxSeconds / 60)} minutes of stereo audio at once. Split it into shorter files, or convert it to MP3 (which the server splits without decoding).`);
  }
  onPhase?.("decoding");
  let encoded: ArrayBuffer | null = await file.arrayBuffer();
  let buf: AudioBuffer;
  try {
    buf = await new Ctor(1, 1, CHUNK_SAMPLE_RATE).decodeAudioData(encoded);
  } catch (e) {
    throw new Error(`This browser could not decode the recording (${(e as Error).message || "unsupported format"}) — its codec is not one this browser plays (Chromium without proprietary codecs cannot decode AAC, for example). Open it in Chrome, Edge or Safari, or convert it to MP3 or WAV, which the server splits without decoding.`);
  } finally {
    encoded = null; // the encoded copy is no longer needed
  }
  if (buf.sampleRate === CHUNK_SAMPLE_RATE) {
    return { channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), sampleRate: CHUNK_SAMPLE_RATE, durationSeconds: buf.duration };
  }
  /* a decoder that kept the file's own rate: an offline render to 16 kHz mono */
  onPhase?.("resampling");
  try {
    const length = Math.ceil(buf.duration * CHUNK_SAMPLE_RATE);
    const ctx = new Ctor(1, length, CHUNK_SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    return { channels: [out.getChannelData(0)], sampleRate: CHUNK_SAMPLE_RATE, durationSeconds: out.duration };
  } catch {
    const mono = downmix(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)));
    return { channels: [resampleLinear(mono, buf.sampleRate, CHUNK_SAMPLE_RATE)], sampleRate: CHUNK_SAMPLE_RATE, durationSeconds: buf.duration };
  }
}

/** the parts, encoded one at a time (a generator: a part's WAV exists only while it is being sent) */
export function* wavParts(audio: DecodedAudio, maxBytes?: number): Generator<{ plan: ChunkPlan; count: number; wav: Uint8Array }> {
  const total = audio.channels[0]?.length ?? 0;
  const plans = planChunks(total, audio.sampleRate, maxBytes);
  for (const plan of plans) {
    const pcm = floatToInt16(downmix(audio.channels, plan.startSample, plan.endSample));
    yield { plan, count: plans.length, wav: encodeWav(pcm, audio.sampleRate) };
  }
}

export interface PartSender {
  /** send one part; the sandbox answers its transcript, a saved project answers 202 until the last one, then the stored transcript */
  (part: { plan: ChunkPlan; count: number; wav: Uint8Array }): Promise<{ part?: ChunkTranscript; final?: unknown }>;
}

/** decode → parts → transcribe; returns the merged transcript (sandbox) and/or the route's final answer (saved) */
export async function transcribeInBrowser(file: Blob, send: PartSender, onProgress?: (done: number, total: number, phase: string) => void): Promise<{ merged: MergedTranscript | null; final: unknown; parts: number; durationSeconds: number }> {
  const audio = await decodeTo16k(file, (p) => onProgress?.(0, 0, p));
  const got: ChunkTranscript[] = [];
  let final: unknown = null, count = 0;
  /* TEST SEAM: a browser suite may shrink the part size (`window.__rescriptChunkBytes`) to exercise the multi-part
     merge with a few seconds of audio; never larger than the provider's limit */
  const seam = Number((globalThis as { __rescriptChunkBytes?: unknown }).__rescriptChunkBytes);
  const maxBytes = Number.isFinite(seam) && seam >= 8_000 && seam < STT_MAX_BYTES ? seam : undefined;
  for (const p of wavParts(audio, maxBytes)) {
    count = p.count;
    if (p.wav.length > STT_MAX_BYTES) throw new Error("a part came out larger than the transcription limit");
    onProgress?.(p.plan.index, p.count, "transcribing");
    const r = await send(p);
    if (r.part) got.push(r.part);
    if (r.final) final = r.final;
  }
  onProgress?.(count, count, "done");
  return { merged: got.length ? mergeChunkTranscripts(got) : null, final, parts: count, durationSeconds: audio.durationSeconds };
}
