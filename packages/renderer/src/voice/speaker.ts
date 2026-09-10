"use client";
import React from "react";
import type { SpokenSegment } from "@rescript/engine";
import { chooseVoice, ttsProvider, type TtsProvider, type VoiceInfo } from "./providers";

/**
 * THE SPEAKER — reads a spoken script (engine `spokenSegments`) segment by
 * segment: the question, a pause, then each option with its own pause, a
 * validation error when there is one. Pre-recorded audio plays instead of
 * synthesis when a segment has an `audioUrl`; if that audio fails, the text
 * is synthesised so nothing is lost.
 *
 * Rate, pitch and volume come from the survey's voice settings and are
 * clamped to what a device can sensibly do — volume is never pushed above the
 * device's own level. Emphasis, which browser voices cannot mark up, is
 * approximated by a slightly slower rate on emphasised segments.
 *
 * Cancelling stops the current utterance and skips the rest; a new script
 * always cancels the previous one, so quick navigation never queues speech.
 */

export interface SpeakerOptions {
  provider?: TtsProvider | null;
  lang: string;
  voiceId?: string;
  rate: number;
  pitch: number;
  volume: number;
  /** called with the index of the segment now being spoken, and null at the end */
  onSegment?(index: number | null): void;
}

export interface SpeakRun { cancel(): void; done: Promise<void> }

const wait = (ms: number, cancelled: () => boolean) => new Promise<void>((r) => {
  if (ms <= 0) return r();
  const t0 = Date.now();
  const tick = () => { if (cancelled() || Date.now() - t0 >= ms) r(); else setTimeout(tick, Math.min(60, ms)); };
  setTimeout(tick, Math.min(60, ms));
});

/** Resolve when the provider reports it stopped speaking — a watchdog for engines that never fire `onend`. */
function untilQuiet(p: TtsProvider, cancelled: () => boolean, maxMs: number): Promise<void> {
  return new Promise<void>((r) => {
    const t0 = Date.now();
    const tick = () => {
      if (cancelled() || Date.now() - t0 > maxMs) return r();
      if (Date.now() - t0 > 200 && !p.speaking()) return r();
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

function playAudio(url: string, volume: number, cancelled: () => boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (typeof Audio === "undefined") return resolve(false);
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    a.play().catch(() => finish(false));
    const poll = () => { if (settled) return; if (cancelled()) { a.pause(); finish(true); return; } setTimeout(poll, 100); };
    setTimeout(poll, 100);
  });
}

export function speakSegments(segments: SpokenSegment[], opts: SpeakerOptions): SpeakRun {
  const provider = opts.provider ?? ttsProvider();
  let cancelled = false;
  let current: { cancel(): void } | null = null;
  const isCancelled = () => cancelled;
  const done = (async () => {
    if (!provider || !provider.available()) { opts.onSegment?.(null); return; }
    provider.cancel();
    for (let i = 0; i < segments.length; i++) {
      if (cancelled) break;
      const seg = segments[i];
      opts.onSegment?.(i);
      let spoken = false;
      if (seg.audioUrl) spoken = await playAudio(seg.audioUrl, opts.volume, isCancelled);
      if (!spoken && seg.text.trim() && !cancelled) {
        const rate = seg.emphasis === "moderate" ? opts.rate * 0.9 : seg.emphasis === "light" ? opts.rate * 0.96 : opts.rate;
        const h = provider.speak(seg.text, { lang: opts.lang, voiceId: opts.voiceId, rate, pitch: opts.pitch, volume: opts.volume });
        current = h;
        await Promise.race([h.done, untilQuiet(provider, isCancelled, 4000 + seg.text.length * 120)]);
        current = null;
      }
      if (!cancelled) await wait(seg.pauseMs, isCancelled);
    }
    // a cancelled run says nothing more — its replacement owns the state now
    if (!cancelled) opts.onSegment?.(null);
  })();
  return {
    cancel() { cancelled = true; current?.cancel(); provider?.cancel(); },
    done,
  };
}

/**
 * Speak `segments` whenever their content changes while `enabled`, with the
 * survey's voice; cancel on unmount and when disabled. `replay` reads the
 * current script again; `speakNow` reads something else (a prompt, a
 * read-back) without disturbing what will be re-read on replay.
 */
export function useSpeaker(segments: SpokenSegment[], opts: Omit<SpeakerOptions, "onSegment" | "provider"> & { providerKey?: string; profile?: { gender?: string; ageStyle?: string; voiceId?: string; fallbackVoiceId?: string } }, enabled: boolean) {
  const [speaking, setSpeaking] = React.useState(false);
  const [segmentIndex, setSegmentIndex] = React.useState<number | null>(null);
  const [voices, setVoices] = React.useState<VoiceInfo[]>([]);
  const run = React.useRef<SpeakRun | null>(null);
  const latest = React.useRef<object | null>(null);
  const provider = ttsProvider(opts.providerKey);
  const available = !!provider?.available();

  React.useEffect(() => {
    if (!provider?.available()) return;
    let alive = true;
    provider.voices().then((v) => { if (alive) setVoices(v); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.providerKey, available]);

  const voice = React.useMemo(
    () => chooseVoice(voices, { lang: opts.lang, voiceId: opts.profile?.voiceId, fallbackVoiceId: opts.profile?.fallbackVoiceId, gender: opts.profile?.gender, ageStyle: opts.profile?.ageStyle }),
    [voices, opts.lang, opts.profile?.voiceId, opts.profile?.fallbackVoiceId, opts.profile?.gender, opts.profile?.ageStyle],
  );

  const speak = React.useCallback((segs: SpokenSegment[]) => {
    run.current?.cancel();
    if (!segs.length) { setSpeaking(false); setSegmentIndex(null); return; }
    setSpeaking(true);
    const token = {};
    latest.current = token;
    const r = speakSegments(segs, {
      provider, lang: opts.lang, voiceId: voice?.id, rate: opts.rate, pitch: opts.pitch, volume: opts.volume,
      // only the newest run may report progress — a run being replaced falls silent
      onSegment: (i) => { if (latest.current !== token) return; setSegmentIndex(i); if (i === null) setSpeaking(false); },
    });
    run.current = r;
    r.done.then(() => { if (run.current === r) { setSpeaking(false); setSegmentIndex(null); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, opts.lang, voice?.id, opts.rate, opts.pitch, opts.volume]);

  const key = segments.map((s) => `${s.kind}:${s.text}:${s.audioUrl ?? ""}`).join("|") + `@${opts.lang}`;
  /*
   * Speak when the script changes; the cleanup cancels what is still being
   * said. `speak` is deliberately not a dependency: the voice list arriving a
   * moment after mount must not restart the question mid-sentence. (Under
   * React's development double-mount the cleanup runs and the effect speaks
   * again — the first run is cancelled, not doubled.)
   */
  React.useEffect(() => {
    if (!enabled) { run.current?.cancel(); setSpeaking(false); setSegmentIndex(null); return; }
    if (!key.trim()) return;
    // a tick later, so a script replaced in the same frame (or React's development double-mount) never starts speaking
    const t = setTimeout(() => speak(segments), 0);
    return () => { clearTimeout(t); run.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  React.useEffect(() => () => run.current?.cancel(), []);

  return {
    available,
    speaking,
    segmentIndex,
    voice,
    voices,
    replay: () => speak(segments),
    speakNow: (segs: SpokenSegment[]) => speak(segs),
    stop: () => { run.current?.cancel(); setSpeaking(false); setSegmentIndex(null); },
  };
}
