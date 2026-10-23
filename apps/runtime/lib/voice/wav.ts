/**
 * AN UTTERANCE AS A FILE (G1 2026-10-22): the hands-free conversation records raw samples itself (Web
 * Audio), so it needs no MediaRecorder codec — the reason it works in Safari and Firefox alike — and sends
 * each utterance as a 16 kHz mono 16-bit WAV, which every speech-to-text provider reads (32 kB a second:
 * the transcribe route's 4 MB limit is about two minutes).
 */

/** linear-interpolating resample (good enough for speech-to-text; no anti-alias filter needed at 48→16 kHz for speech bands) */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = (input[k] ?? 0) * (1 - f) + (input[k + 1] ?? input[k] ?? 0) * f;
  }
  return out;
}

export function concatFrames(frames: readonly Float32Array[]): Float32Array {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
}

/** samples (-1…1) → a 16-bit PCM WAV file */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Uint8Array(buf);
}

/** a fixed-length history of frames — the pre-roll that keeps an utterance's first syllable */
export class FrameRing {
  private frames: Float32Array[] = [];
  private total = 0;
  private readonly maxSamples: number;
  constructor(maxSamples: number) { this.maxSamples = maxSamples; }
  push(f: Float32Array): void {
    this.frames.push(f); this.total += f.length;
    while (this.frames.length > 1 && this.total - this.frames[0].length >= this.maxSamples) this.total -= this.frames.shift()!.length;
  }
  take(): Float32Array[] { const out = this.frames; this.frames = []; this.total = 0; return out; }
}
