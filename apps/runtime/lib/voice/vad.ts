/**
 * VOICE-ACTIVITY DETECTION FOR THE HANDS-FREE INTERVIEW (G1 2026-10-22) — no dependencies, pure, unit
 * tested on synthetic buffers (`vad.test.ts`). The page feeds it ~20 ms frames of microphone samples.
 *
 *   features   per frame: energy (RMS in dBFS) and the zero-crossing rate
 *   voiced     energy above the adaptive noise floor by `startDb` (in speech: by the lower `stopDb` —
 *              HYSTERESIS, so a soft syllable does not end the turn) and above an absolute floor, with a
 *              zero-crossing rate under `zcrMax` (broadband hiss and fan noise cross zero on about half
 *              the samples; voiced speech far less)
 *   start      `minSpeechMs` of voiced frames in a row (a click or a cough is shorter) → `start`, dated at
 *              the first voiced frame of the run (the caller keeps a pre-roll, so no syllable is lost)
 *   end        `hangoverMs` without voiced frames → `end`, dated at the LAST voiced frame (end of turn by
 *              silence; the latency budget is measured from that moment)
 *   noise      the floor follows the quiet frames slowly (and drops at once to a quieter frame)
 *   echo       `ignoreUntil(t)` ignores frames before t (the first ms of the moderator's playback, before the
 *              browser's echo canceller has converged); `setBias(db)` raises the start threshold while
 *              the moderator speaks, so its own voice leaking from a loudspeaker does not count as speech
 */

export interface VadOptions {
  sampleRate: number;
  startDb?: number;
  stopDb?: number;
  minSpeechMs?: number;
  hangoverMs?: number;
  /** an absolute floor (dBFS) below which nothing is speech */
  floorDb?: number;
  zcrMax?: number;
  /** zero crossings per second below this are a hum (mains, a fan's motor), not a voice */
  zcrMinPerSec?: number;
  /** the first ms set the noise floor whatever they hold */
  calibrateMs?: number;
  /** an utterance longer than this is closed (a voice never runs on without a breath; a constant tone does) */
  maxUtteranceMs?: number;
  /** how fast the noise floor follows quiet frames (0–1 per frame) */
  adapt?: number;
}
export type VadEvent = { type: "start"; at: number } | { type: "end"; at: number; durationMs: number };

export function frameFeatures(frame: Float32Array): { db: number; zcr: number } {
  let sum = 0, cross = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
    if (i && (frame[i] >= 0) !== (frame[i - 1] >= 0)) cross++;
  }
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  return { db: 20 * Math.log10(rms + 1e-9), zcr: frame.length > 1 ? cross / (frame.length - 1) : 0 };
}

export class Vad {
  readonly o: Required<VadOptions>;
  private noise = -60;
  private speaking = false;
  private run = 0;
  private runStart = 0;
  private lastVoiced = 0;
  private speechStart = 0;
  private quietMs = 0;
  private ignoreBefore = -Infinity;
  private bias = 0;
  private seenMs = 0;

  constructor(o: VadOptions) {
    this.o = { startDb: 14, stopDb: 7, minSpeechMs: 140, hangoverMs: 800, floorDb: -52, zcrMax: 0.42, zcrMinPerSec: 90, calibrateMs: 240, maxUtteranceMs: 60_000, adapt: 0.04, ...o };
  }

  get isSpeaking(): boolean { return this.speaking; }
  get noiseFloorDb(): number { return this.noise; }
  ignoreUntil(t: number): void { this.ignoreBefore = t; }
  setBias(db: number): void { this.bias = Math.max(0, db); }
  /** forget an utterance in progress (pause) */
  reset(): void { this.speaking = false; this.run = 0; this.quietMs = 0; }

  /** one frame (samples in -1…1) ending at time `t` (ms) → an event, or null */
  push(frame: Float32Array, t: number): VadEvent | null {
    const ms = (frame.length / this.o.sampleRate) * 1000;
    const { db, zcr } = frameFeatures(frame);
    const start = t - ms;
    if (start < this.ignoreBefore) return null;
    if (this.seenMs < this.o.calibrateMs) {
      this.noise = this.seenMs === 0 ? db : Math.max(this.noise, db);
      this.noise = Math.max(-90, Math.min(-20, this.noise));
      this.seenMs += ms;
      return null;
    }
    const above = db - this.noise;
    const tonal = zcr <= this.o.zcrMax && zcr * this.o.sampleRate >= this.o.zcrMinPerSec;
    const voiced = db > this.o.floorDb && tonal && above > (this.speaking ? this.o.stopDb : this.o.startDb + this.bias);
    if (!voiced && !this.speaking) {
      /* the noise floor: down at once, up slowly — and never from a loud tonal frame (that is speech too short to start) */
      if (db < this.noise) this.noise = db;
      else if (!(tonal && above > this.o.stopDb)) this.noise += (db - this.noise) * this.o.adapt;
      this.noise = Math.max(-90, Math.min(-20, this.noise));
    }
    if (!this.speaking) {
      if (voiced) {
        if (!this.run) this.runStart = start;
        this.run += ms;
        this.lastVoiced = t;
        if (this.run >= this.o.minSpeechMs) { this.speaking = true; this.speechStart = this.runStart; this.quietMs = 0; this.run = 0; return { type: "start", at: this.runStart }; }
      } else this.run = 0;
      return null;
    }
    if (voiced) {
      this.lastVoiced = t; this.quietMs = 0;
      if (t - this.speechStart >= this.o.maxUtteranceMs) { this.speaking = false; return { type: "end", at: t, durationMs: t - this.speechStart }; }
      return null;
    }
    this.quietMs += ms;
    if (this.quietMs >= this.o.hangoverMs) {
      this.speaking = false; this.quietMs = 0;
      return { type: "end", at: this.lastVoiced, durationMs: Math.max(0, this.lastVoiced - this.speechStart) };
    }
    return null;
  }
}
