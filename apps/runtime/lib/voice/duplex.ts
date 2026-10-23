"use client";
import { Vad } from "./vad";
import { duplexStep, initialDuplex, type DuplexEffect, type DuplexEvent, type DuplexPhase, type DuplexState } from "./bargeIn";
import { concatFrames, encodeWav, FrameRing, resample } from "./wav";

/**
 * THE HANDS-FREE CONVERSATION IN THE BROWSER (G1 2026-10-22): microphone → voice-activity detection →
 * utterances (16 kHz WAV, no MediaRecorder needed) → the page sends each one; the reply's sentences and
 * their audio come back in the turn's stream and are played in order AS THEY ARRIVE; the participant's
 * voice during playback stops it at once (barge-in). The turn-taking rules are the pure state machine in
 * `bargeIn.ts`; this file only does the Web Audio and media work around it.
 *
 * Echo: the microphone is opened with echoCancellation / noiseSuppression / autoGainControl; the first
 * `ignoreMs` of each playback are not listened to (the echo canceller converging) and, while the moderator
 * speaks, the start threshold is raised (`playbackBiasDb`). Headphones are still the best defence and the
 * page says so.
 */

export type ConversationSupport = { ok: true } | { ok: false; reason: "insecure" | "no_mic" | "no_audio" };

/** can this browser hold a hands-free conversation? (getUserMedia, Web Audio with a script processor, a secure page) */
export function conversationSupport(): ConversationSupport {
  if (typeof window === "undefined") return { ok: false, reason: "no_audio" };
  if (window.isSecureContext === false) return { ok: false, reason: "insecure" };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "no_mic" };
  const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC || typeof AC.prototype.createScriptProcessor !== "function" || typeof AC.prototype.createMediaStreamSource !== "function") return { ok: false, reason: "no_audio" };
  return { ok: true };
}

export interface DuplexHooks {
  /** an utterance is ready to send (the page transcribes it and sends the turn; then calls `sent()`) */
  onUtterance(wav: Uint8Array, info: { durationMs: number; endAt: number }): void;
  onPhase(p: DuplexPhase): void;
  /** end of the participant's speech → the first audio of the reply */
  onLatency(ms: number): void;
  /** the participant cut the reply short: how much of it they heard */
  onInterrupted(i: { heardChars: number; during: "speaking" | "preparing" }): void;
}
export interface DuplexOptions { language: string; ignoreMs?: number; playbackBiasDb?: number; hangoverMs?: number }

interface Chunk { i: number; text: string; audio?: { mime: string; b64: string } | null }

export class DuplexController {
  private st: DuplexState = initialDuplex();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private vad: Vad | null = null;
  private ring: FrameRing | null = null;
  private capture: Float32Array[] | null = null;
  private captureStart = 0;
  private queue: { wav: Uint8Array; durationMs: number; endAt: number }[] = [];
  /* playback */
  private chunks = new Map<number, Chunk>();
  private nextIndex = 0;
  private replyOpen = false;
  private heard = 0;
  private current: { el: HTMLAudioElement | null; utter: SpeechSynthesisUtterance | null; chunk: Chunk; url: string | null } | null = null;
  private discarding = false;
  muted = false;
  private readonly hooks: DuplexHooks;
  private readonly o: Required<DuplexOptions>;

  constructor(hooks: DuplexHooks, o: DuplexOptions) {
    this.hooks = hooks;
    this.o = { ignoreMs: 300, playbackBiasDb: 10, hangoverMs: 800, ...o };
  }

  get phase(): DuplexPhase { return this.st.phase; }

  /** open the microphone and start listening — call from a click (mobile browsers need the gesture for audio) */
  async start(): Promise<void> {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    this.ctx = new AC();
    void this.ctx.resume?.().catch(() => {});
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const sr = this.ctx.sampleRate;
    this.vad = new Vad({ sampleRate: sr, hangoverMs: this.o.hangoverMs });
    this.ring = new FrameRing(Math.round(sr * 0.4));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(1024, 1, 1);
    this.proc.onaudioprocess = (e) => this.onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    this.src.connect(this.proc);
    /* a script processor only runs when connected to the output: through a silent gain */
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    this.proc.connect(sink); sink.connect(this.ctx.destination);
    this.dispatch({ type: "start" });
  }

  stop(): void {
    this.dispatch({ type: "end" });
    try { this.proc?.disconnect(); this.src?.disconnect(); } catch { /* gone */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = null; this.stream = null; this.proc = null; this.src = null;
  }
  pause(): void { this.dispatch({ type: "pause" }); this.vad?.reset(); }
  resume(): void { this.dispatch({ type: "resume" }); }

  /* ---------------------------------------------------------------- the reply */

  /** a turn request went out (the utterance's, or a nudge's) */
  sent(): void { this.chunks.clear(); this.nextIndex = 0; this.heard = 0; this.replyOpen = true; this.discarding = false; this.dispatch({ type: "sent" }); }
  speakChunk(i: number, text: string): void { if (!this.chunks.has(i)) this.chunks.set(i, { i, text }); this.pump(); }
  audioChunk(i: number, audio: { mime: string; b64: string } | null): void { const c = this.chunks.get(i) ?? { i, text: "" }; c.audio = audio; this.chunks.set(i, c); this.pump(); }
  /** the turn's response is complete (no more chunks will come) */
  replyDone(ok: boolean): void {
    this.replyOpen = false;
    this.dispatch({ type: ok ? "reply_done" : "reply_failed" });
    this.pump();
  }
  /** how much of the current / last reply the participant heard */
  get heardChars(): number { return this.heard; }

  private pump(): void {
    if (this.current || this.discarding) return;
    const c = this.chunks.get(this.nextIndex);
    if (!c || c.audio === undefined) {
      if (!c && !this.replyOpen && this.st.playing) this.dispatch({ type: "audio_end", at: performance.now() });
      return;
    }
    if (this.st.phase === "userSpeaking" || this.st.phase === "paused" || this.st.phase === "ended") return;
    this.nextIndex++;
    const first = !this.st.playing;
    const done = () => {
      if (this.current?.url) URL.revokeObjectURL(this.current.url);
      this.heard += c.text.length + 1;
      this.current = null;
      this.vad?.setBias(0);
      this.pump();
    };
    if (this.muted) { done(); return; }
    this.vad?.setBias(this.o.playbackBiasDb);
    if (first) { const at = performance.now(); this.vad?.ignoreUntil(at + this.o.ignoreMs); this.dispatch({ type: "audio_start", at }); if (!this.st.playing) { this.current = null; return; } }
    if (c.audio) {
      const bytes = Uint8Array.from(atob(c.audio.b64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: c.audio.mime }));
      const el = new Audio(url);
      this.current = { el, utter: null, chunk: c, url };
      el.onended = done; el.onerror = done;
      void el.play().catch(done);
    } else {
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== "function") { done(); return; }
      const u = new SpeechSynthesisUtterance(c.text);
      u.lang = this.o.language;
      const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith(this.o.language.toLowerCase()));
      if (voice) u.voice = voice;
      u.onend = done; u.onerror = done;
      this.current = { el: null, utter: u, chunk: c, url: null };
      synth.speak(u);
    }
  }

  private stopPlayback(reason: "barge_in" | "discard" | "pause" | "end"): void {
    const cur = this.current;
    let partial = 0;
    if (cur?.el) {
      const d = Number.isFinite(cur.el.duration) && cur.el.duration > 0 ? cur.el.duration : 0;
      partial = d ? Math.round((cur.el.currentTime / d) * cur.chunk.text.length) : 0;
      cur.el.onended = null; cur.el.onerror = null; cur.el.pause();
      if (cur.url) URL.revokeObjectURL(cur.url);
    }
    if (cur?.utter) { cur.utter.onend = null; window.speechSynthesis?.cancel(); }
    this.current = null;
    if (reason === "barge_in" || reason === "discard") { this.heard += partial; this.discarding = true; }
    this.vad?.setBias(0);
    if (reason === "barge_in" || reason === "pause" || reason === "end") { if (this.st.playing) this.st = { ...this.st, playing: false }; }
  }

  /* ---------------------------------------------------------------- the microphone */

  private onFrame(frame: Float32Array): void {
    if (!this.vad || !this.ring) return;
    const t = performance.now();
    if (this.capture) this.capture.push(frame); else this.ring.push(frame);
    if (this.capture && this.ctx && (t - this.captureStart) > 110_000) this.dispatch({ type: "vad_end", at: t });
    const ev = this.vad.push(frame, t);
    if (ev?.type === "start") this.dispatch({ type: "vad_start", at: ev.at });
    else if (ev?.type === "end") this.dispatch({ type: "vad_end", at: ev.at });
  }

  private dispatch(e: DuplexEvent): void {
    const r = duplexStep(this.st, e, { ignoreMs: this.o.ignoreMs });
    const before = this.st.phase;
    this.st = r.state;
    for (const fx of r.effects) this.apply(fx);
    if (this.st.phase !== before) this.hooks.onPhase(this.st.phase);
  }

  private apply(fx: DuplexEffect): void {
    switch (fx.type) {
      case "begin_capture": this.capture = this.ring?.take() ?? []; this.captureStart = performance.now(); break;
      case "drop_capture": this.capture = null; break;
      case "finish_capture": {
        const frames = this.capture ?? [];
        this.capture = null;
        if (!this.ctx || !frames.length) break;
        const sr = this.ctx.sampleRate;
        const pcm = concatFrames(frames);
        /* trim the hang-over's silence (keep 200 ms after the last voiced frame) */
        const keep = Math.min(pcm.length, Math.max(0, pcm.length - Math.round(sr * Math.max(0, (this.o.hangoverMs - 200) / 1000))));
        const wav = encodeWav(resample(pcm.subarray(0, keep), sr, 16000), 16000);
        this.queue.push({ wav, durationMs: Math.round((keep / sr) * 1000), endAt: performance.now() });
        break;
      }
      case "send_next": { const u = this.queue.shift(); if (u) this.hooks.onUtterance(u.wav, { durationMs: u.durationMs, endAt: u.endAt }); break; }
      case "stop_playback": this.stopPlayback(fx.reason); break;
      case "interrupted": this.hooks.onInterrupted({ heardChars: fx.during === "speaking" ? this.heard : 0, during: fx.during }); break;
      case "latency": this.hooks.onLatency(fx.ms); break;
    }
  }
}
