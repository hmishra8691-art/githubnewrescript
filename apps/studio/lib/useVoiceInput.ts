"use client";
import React from "react";
import { pickRecordingMime, type HeardTranscript } from "./intelligent/voice";

/**
 * THE STUDIO'S MICROPHONE — record, send to /api/ai/transcribe, hand back
 * what was heard. Extracted from Intelligent mode (UI upgrade §18–§21) so
 * the Branding theme assistant uses the very same path: MediaRecorder in the
 * browser, the configured (metered) speech provider on the server, the same
 * states and the same messages.
 *
 *   idle ──click──► recording ──click──► transcribing ──► idle
 *                     │  ▲
 *              pause  ▼  │ resume      (MediaRecorder.pause / resume — only
 *                    paused             offered where the recorder has them)
 *
 * It stops by itself after `maxMs` of RECORDED time (a pause stops the clock).
 * A 501 from the route means no speech provider is configured: `available`
 * turns false for the page's lifetime, and the button says so.
 *
 * TEST SEAM: `window.__rescriptVoiceHint(text, language)` tells the FAKE
 * speech provider what it should have heard (the route honours it for the
 * platform's fake provider only). One pending hint, shared by every mounted
 * microphone; the next recording sent takes it.
 */
export type VoiceState = "idle" | "recording" | "paused" | "transcribing";

/** whether /api/ai/transcribe answered (true), refused (false) or has not been asked — for the page's lifetime, shared by every microphone */
let sttKnown: boolean | null = null;
let pendingHint: { hint: string; language: string } | null = null;
let mounted = 0;

export interface VoiceInputOptions {
  surveyId: string;
  /** called with a transcript that has words in it; awaited before the microphone is idle again */
  onTranscript(heard: HeardTranscript): void | Promise<void>;
  /** what the browser is told when the microphone is refused */
  refusedMessage?: string;
  /** the recording's file name on the form (the route only reads its type) */
  fileName?: string;
  /** recorded time before it stops by itself */
  maxMs?: number;
}

export interface VoiceInput {
  state: VoiceState;
  /** null until the first recording is sent; false when no speech provider is configured */
  available: boolean | null;
  error: string | null;
  setError(e: string | null): void;
  /** MediaRecorder.pause / resume exist in this browser */
  canPause: boolean;
  start(): Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  /** idle → recording, recording / paused → stop and transcribe */
  toggle(): void;
}

export function useVoiceInput(opts: VoiceInputOptions): VoiceInput {
  const [state, setState] = React.useState<VoiceState>("idle");
  const [available, setAvailableState] = React.useState<boolean | null>(sttKnown);
  const setAvailable = React.useCallback((v: boolean) => { sttKnown = v; setAvailableState(v); }, []);
  const [error, setError] = React.useState<string | null>(null);
  const recorder = React.useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number; startedAt: number; left: number } | null>(null);
  const optsRef = React.useRef(opts);
  optsRef.current = opts;
  const maxMs = opts.maxMs ?? 45_000;

  const send = React.useCallback(async (blob: Blob) => {
    setState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, optsRef.current.fileName ?? "instruction.webm");
      form.append("surveyId", optsRef.current.surveyId);
      // the browser suites, against the fake provider, say what the fake should have heard
      if (pendingHint) { form.append("hint", pendingHint.hint); form.append("hintLanguage", pendingHint.language); pendingHint = null; }
      const r = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      if (r.status === 501) { setAvailable(false); setError("No transcription provider is configured on this Studio."); return; }
      const d = await r.json().catch(() => null) as { ok?: boolean; text?: string; language?: string; english?: string; model?: string; error?: string } | null;
      if (!r.ok || !d?.ok) { setError(d?.error ?? `Transcription failed (${r.status}).`); return; }
      setAvailable(true);
      const heard: HeardTranscript = { text: d.text ?? "", language: d.language ?? "en", ...(d.english ? { english: d.english } : {}), ...(d.model ? { model: d.model } : {}) };
      if (!(heard.english || heard.text).trim()) { setError("I could not make out any words — try again, a little closer to the microphone."); return; }
      await optsRef.current.onTranscript(heard);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setState("idle");
    }
  }, [setAvailable]);

  const stop = React.useCallback(() => {
    const r = recorder.current;
    if (!r) return;
    window.clearTimeout(r.timer);
    if (r.rec.state !== "inactive") r.rec.stop();
  }, []);

  const start = React.useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("This browser cannot record audio."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecordingMime((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) { setState("idle"); setError("Nothing was recorded."); return; }
        void send(blob);
      };
      rec.start(250);
      const timer = window.setTimeout(() => stop(), maxMs);
      recorder.current = { rec, stream, chunks, timer, startedAt: Date.now(), left: maxMs };
      setState("recording");
    } catch (e) {
      setError(/NotAllowed|Permission/i.test(String((e as Error).name)) ? (optsRef.current.refusedMessage ?? "Microphone access was refused — allow it in the browser to speak an instruction.") : (e as Error).message);
      setState("idle");
    }
  }, [send, stop, maxMs]);

  const canPause = typeof MediaRecorder !== "undefined" && typeof MediaRecorder.prototype?.pause === "function" && typeof MediaRecorder.prototype?.resume === "function";
  const pause = React.useCallback(() => {
    const r = recorder.current;
    if (!r || r.rec.state !== "recording" || typeof r.rec.pause !== "function") return;
    r.rec.pause();
    window.clearTimeout(r.timer);
    r.left = Math.max(1000, r.left - (Date.now() - r.startedAt));
    setState("paused");
  }, []);
  const resume = React.useCallback(() => {
    const r = recorder.current;
    if (!r || r.rec.state !== "paused") return;
    r.rec.resume();
    r.startedAt = Date.now();
    r.timer = window.setTimeout(() => stop(), r.left);
    setState("recording");
  }, [stop]);

  const toggle = React.useCallback(() => {
    if (state === "recording" || state === "paused") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  React.useEffect(() => () => { const r = recorder.current; if (r) { window.clearTimeout(r.timer); r.stream.getTracks().forEach((t) => t.stop()); } }, []);
  // the browser suites set the fake provider's transcript through a global hook, since a fake cannot hear
  React.useEffect(() => {
    mounted++;
    (window as unknown as { __rescriptVoiceHint?: (hint: string, language?: string) => void }).__rescriptVoiceHint = (hint, language = "en") => { pendingHint = { hint, language }; };
    return () => { if (--mounted === 0) delete (window as unknown as { __rescriptVoiceHint?: unknown }).__rescriptVoiceHint; };
  }, []);

  return { state, available, error, setError, canPause, start, stop, pause, resume, toggle };
}
