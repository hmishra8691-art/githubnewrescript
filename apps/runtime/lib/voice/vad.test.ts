import { test } from "node:test";
import assert from "node:assert/strict";
import { frameFeatures, Vad, type VadEvent } from "./vad.ts";
import { duplexStep, initialDuplex, type DuplexEvent, type DuplexState } from "./bargeIn.ts";
import { concatFrames, encodeWav, FrameRing, resample } from "./wav.ts";

/*
 * VOICE ACTIVITY ON SYNTHETIC AUDIO (G1 2026-10-22): speech-like bursts (a voiced tone with harmonics and a
 * syllable envelope) against silence, broadband noise and a mains hum; hysteresis keeps a soft syllable
 * inside the turn; the end of the turn is dated at the last voiced frame; the first ms of playback are
 * ignored and a playback bias raises the threshold. Then the barge-in state machine, and the WAV writer.
 */

const SR = 16000;
const FRAME = 320; // 20 ms
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

/** ms of audio: "speech" (voiced 140 Hz + harmonics, 4 Hz syllable envelope), "noise" (white), "hum" (50 Hz), "silence" */
function synth(kind: "speech" | "soft" | "noise" | "hum" | "silence", ms: number, amp = 0.3): Float32Array {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (kind === "speech" || kind === "soft") {
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      const v = Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 1100 * t);
      out[i] = (kind === "soft" ? amp * 0.25 : amp) * env * v / 1.8 + 0.002 * rnd();
    } else if (kind === "noise") out[i] = amp * rnd();
    else if (kind === "hum") out[i] = amp * Math.sin(2 * Math.PI * 50 * t);
    else out[i] = 0.0005 * rnd();
  }
  return out;
}
function run(vad: Vad, audio: Float32Array, t0 = 0): VadEvent[] {
  const ev: VadEvent[] = [];
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    const e = vad.push(audio.subarray(i, i + FRAME), t0 + ((i + FRAME) / SR) * 1000);
    if (e) ev.push(e);
  }
  return ev;
}
const cat = (...a: Float32Array[]) => concatFrames(a);

test("features: speech is loud and tonal; white noise crosses zero on about half the samples; silence is quiet", () => {
  const s = frameFeatures(synth("speech", 20)), n = frameFeatures(synth("noise", 20, 0.1)), q = frameFeatures(synth("silence", 20));
  assert.ok(s.db > -30 && s.zcr < 0.2, JSON.stringify(s));
  assert.ok(n.zcr > 0.42, JSON.stringify(n));
  assert.ok(q.db < -60, JSON.stringify(q));
});

test("speech after silence: one start (dated at the onset) and one end (dated at the last voiced frame, after the hang-over)", () => {
  const vad = new Vad({ sampleRate: SR });
  const ev = run(vad, cat(synth("silence", 600), synth("speech", 1500), synth("silence", 1200)));
  assert.deepEqual(ev.map((e) => e.type), ["start", "end"]);
  assert.ok(Math.abs(ev[0].at - 600) <= 40, `onset ${ev[0].at}`);
  assert.ok(Math.abs(ev[1].at - 2100) <= 40, `last voiced ${ev[1].at}`);
  assert.ok(ev[1].type === "end" && Math.abs(ev[1].durationMs - 1500) <= 60);
});

test("noise and hum are not speech; speech over steady noise still is", () => {
  assert.deepEqual(run(new Vad({ sampleRate: SR }), cat(synth("silence", 300), synth("noise", 3000, 0.05))), [], "white noise");
  assert.deepEqual(run(new Vad({ sampleRate: SR }), cat(synth("silence", 300), synth("hum", 3000, 0.2))), [], "mains hum");
  assert.deepEqual(run(new Vad({ sampleRate: SR }), cat(synth("silence", 300), synth("speech", 60), synth("silence", 900))), [], "a click shorter than minSpeechMs");
  const mixed = cat(synth("noise", 800, 0.01), synth("speech", 1200).map((x, i) => x + 0.01 * rnd() + 0 * i), synth("noise", 1200, 0.01));
  assert.deepEqual(run(new Vad({ sampleRate: SR }), mixed).map((e) => e.type), ["start", "end"]);
});

test("hysteresis: a soft syllable and a short pause stay inside the turn; a long pause ends it", () => {
  const vad = new Vad({ sampleRate: SR });
  const ev = run(vad, cat(synth("silence", 400), synth("speech", 800), synth("soft", 300), synth("silence", 400), synth("speech", 600), synth("silence", 1200)));
  assert.deepEqual(ev.map((e) => e.type), ["start", "end"], JSON.stringify(ev));
});

test("echo: the first ms of playback are ignored; a playback bias keeps quiet leakage out but not the participant's voice", () => {
  const vad = new Vad({ sampleRate: SR });
  run(vad, synth("silence", 400));
  vad.ignoreUntil(400 + 300);
  const ev = run(vad, cat(synth("speech", 250), synth("silence", 1000)), 400);
  assert.deepEqual(ev, [], "speech inside the ignored window is not a start");
  const v2 = new Vad({ sampleRate: SR });
  run(v2, synth("silence", 400));
  v2.setBias(30);
  assert.deepEqual(run(v2, cat(synth("speech", 600, 0.01), synth("silence", 1000)), 400), [], "quiet leakage under the bias");
  assert.deepEqual(run(v2, cat(synth("speech", 600, 0.5), synth("silence", 1000)), 2000).map((e) => e.type), ["start", "end"], "a real voice over it");
});

const step = (s: DuplexState, ...events: DuplexEvent[]) => events.reduce((acc, e) => { const r = duplexStep(acc.state, e); return { state: r.state, effects: [...acc.effects, ...r.effects] }; }, { state: s, effects: [] as ReturnType<typeof duplexStep>["effects"] });

test("barge-in state machine: a turn, a reply, an interruption while it plays, the latency measured", () => {
  let r = step(initialDuplex(), { type: "start" }, { type: "vad_start", at: 1000 });
  assert.equal(r.state.phase, "userSpeaking"); assert.deepEqual(r.effects, [{ type: "begin_capture" }]);
  r = step(r.state, { type: "vad_end", at: 3000 });
  assert.deepEqual(r.effects, [{ type: "finish_capture" }, { type: "send_next" }]);
  r = step(r.state, { type: "sent" });
  assert.equal(r.state.phase, "processing");
  r = step(r.state, { type: "audio_start", at: 3900 });
  assert.deepEqual(r.effects, [{ type: "latency", ms: 900 }], "end of speech → first audio");
  assert.equal(r.state.phase, "speaking");
  /* speech in the first 300 ms of playback = echo, ignored */
  r = step(r.state, { type: "vad_start", at: 4100 });
  assert.deepEqual(r.effects, []); assert.equal(r.state.phase, "speaking");
  /* real barge-in */
  r = step(r.state, { type: "vad_start", at: 5000 });
  assert.deepEqual(r.effects, [{ type: "stop_playback", reason: "barge_in" }, { type: "interrupted", during: "speaking" }, { type: "begin_capture" }]);
  assert.equal(r.state.phase, "userSpeaking"); assert.equal(r.state.playing, false);
  /* the new utterance waits for the reply in flight, then is sent */
  r = step(r.state, { type: "vad_end", at: 6000 });
  assert.deepEqual(r.effects, [{ type: "finish_capture" }], "not sent while the earlier turn is open");
  r = step(r.state, { type: "reply_done" });
  assert.deepEqual(r.effects, [{ type: "send_next" }]);
});

test("barge-in while the reply is being prepared: the reply is not played; pause and end stop everything", () => {
  let r = step(initialDuplex(), { type: "start" }, { type: "vad_start", at: 0 }, { type: "vad_end", at: 1000 }, { type: "sent" });
  r = step(r.state, { type: "vad_start", at: 1500 });
  assert.deepEqual(r.effects, [{ type: "interrupted", during: "preparing" }, { type: "begin_capture" }]);
  r = step(r.state, { type: "vad_end", at: 2500 }, { type: "audio_start", at: 2600 });
  assert.deepEqual(r.effects.at(-1), { type: "stop_playback", reason: "discard" });
  assert.equal(r.state.playing, false);
  r = step(r.state, { type: "reply_done" }, { type: "sent" }, { type: "audio_start", at: 4000 });
  assert.deepEqual(r.effects.find((e) => e.type === "latency"), { type: "latency", ms: 1500 });
  r = step(r.state, { type: "pause" });
  assert.deepEqual(r.effects, [{ type: "stop_playback", reason: "pause" }]); assert.equal(r.state.phase, "paused");
  assert.deepEqual(step(r.state, { type: "vad_start", at: 9000 }).effects, [], "nothing is heard while paused");
  r = step(r.state, { type: "resume" }, { type: "end" });
  assert.equal(r.state.phase, "ended");
});

test("WAV: 16 kHz mono 16-bit, resampled from 48 kHz, pre-roll ring", () => {
  const w = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
  assert.equal(new TextDecoder().decode(w.slice(0, 4)), "RIFF");
  const v = new DataView(w.buffer);
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint16(34, true), 16); assert.equal(v.getUint32(40, true), 10);
  assert.equal(v.getInt16(44 + 6, true), 32767); assert.equal(v.getInt16(44 + 8, true), -32768);
  assert.equal(resample(new Float32Array(4800), 48000, 16000).length, 1600);
  const ring = new FrameRing(1000);
  for (let i = 0; i < 10; i++) ring.push(new Float32Array(300));
  const kept = ring.take();
  assert.ok(kept.reduce((a, f) => a + f.length, 0) <= 1300 && kept.length >= 3);
});
