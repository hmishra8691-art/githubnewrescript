"use client";

/**
 * LIVE CAPTIONS WHILE SOMEBODY IS SPEAKING.
 *
 * The browser's own recogniser, running alongside the `MediaRecorder` that is
 * capturing the audio, so a respondent sees their words appear as they say
 * them instead of watching a spinner and hoping.
 *
 * ## Two transcripts, and which one wins
 *
 * The recording is transcribed twice, for two different purposes:
 *
 *   · HERE, in the browser, live. Free, instant, and roughly accurate. It
 *     exists so the respondent can see that they are being heard, catch a
 *     mishearing while they still remember what they meant, and have SOME
 *     transcript even on an installation with no speech-to-text provider
 *     configured at all.
 *   · On the server, afterwards, by a provider. Slower, better, and the one
 *     analysis will be done on.
 *
 * The browser's text is written as the answer the moment recording stops, and
 * the server's replaces it when it arrives. That ordering is deliberate: a
 * transcript that is present and approximate beats a transcript that is
 * absent, and every consumer downstream reads the same field either way.
 * `transcript.source` says which one is in there.
 *
 * ## What this must never do
 *
 * Touch the recording. A recogniser is a network service in most browsers and
 * is absent in some; it fails, it stops early, it hears nothing. None of that
 * may interrupt the `MediaRecorder`, which is the thing holding the answer.
 * Every callback here is wrapped, every failure is silent to the respondent
 * except as an absence of captions, and nothing in this file is awaited by
 * anything that records.
 *
 * ## Why `continuous` needs a watchdog, and why the watchdog needs a leash
 *
 * Chrome ends a continuous session on its own after a pause, without error
 * and without warning. A respondent who thinks for four seconds mid-sentence
 * would lose captions for the rest of their answer. So `onend` restarts it
 * for as long as the caller is still recording, and the finalised text
 * accumulated so far is kept across the restart.
 *
 * But a browser where the recogniser CANNOT run — no network, a headless
 * build, a policy that blocks it — ends the session immediately, every time,
 * and a bare `onend → start()` is then an unbounded loop that pins a core and
 * exhausts memory while the respondent is trying to answer a question. So a
 * restart is always deferred by a moment, and a session that ends at once
 * having heard nothing counts against a small budget. Three of those and the
 * captions give up, silently: the recording is unaffected, which is the only
 * thing that actually matters here.
 */

type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognizerCtor(): (new () => Recognizer) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser can caption speech as it is spoken. */
export function liveCaptionsAvailable(): boolean {
  return recognizerCtor() !== null;
}

export interface CaptionState {
  /** Everything the recogniser has committed to. This will not change again. */
  final: string;
  /** The phrase still being recognised. This WILL change, and may vanish. */
  interim: string;
}

export interface LiveCaptions {
  stop(): void;
  /** Whatever was finalised, for use as the answer. */
  text(): string;
}

/**
 * Start captioning. Returns null when the browser cannot, which is a normal
 * outcome and not an error — the recording proceeds either way.
 *
 * `onChange` is called on every result, interim or final, so the caller can
 * render the two differently. It is never called after `stop()`.
 */
export function startLiveCaptions(opts: {
  lang?: string;
  onChange(state: CaptionState): void;
}): LiveCaptions | null {
  const Ctor = recognizerCtor();
  if (!Ctor) return null;

  let finalText = "";
  let stopped = false;
  let rec: Recognizer | null = null;
  /** Consecutive restarts that produced nothing — the leash. */
  let barren = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (interim: string) => {
    if (stopped) return;
    try { opts.onChange({ final: finalText, interim }); } catch { /* never break a recording to draw a caption */ }
  };

  const spin = () => {
    if (stopped) return;
    let r: Recognizer;
    try { r = new Ctor(); } catch { return; }
    rec = r;
    const startedAt = Date.now();
    let heardAnything = false;
    r.lang = opts.lang || (typeof navigator !== "undefined" ? navigator.language : "en");
    r.continuous = true;
    r.interimResults = true;

    r.onresult = (e) => {
      let interim = "";
      let heard = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) heard += (heard && !heard.endsWith(" ") ? " " : "") + t.trim();
        else interim += t;
      }
      if (heard.trim() || interim.trim()) { heardAnything = true; barren = 0; }
      if (heard.trim()) {
        const add = heard.trim();
        finalText = finalText ? (/\s$/.test(finalText) ? finalText + add : `${finalText} ${add}`) : add;
      }
      emit(interim);
    };

    /*
     * Errors are swallowed on purpose. `no-speech` and `aborted` are ordinary
     * events in a thinking pause, and none of them is the respondent's
     * problem: the microphone is still recording, which is what matters.
     */
    r.onerror = () => {};
    r.onend = () => {
      if (stopped) return;
      /*
       * A session that ended at once having heard nothing is a recogniser
       * that cannot run here, not a respondent who paused. Restarting it
       * immediately would be a tight loop.
       */
      if (!heardAnything && Date.now() - startedAt < 500) barren += 1;
      if (barren >= 3) return;
      timer = setTimeout(spin, 300);
    };

    try { r.start(); } catch { barren += 1; }
  };

  spin();

  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { rec?.stop(); } catch { /* nothing to stop */ }
      rec = null;
    },
    text() {
      return finalText.trim();
    },
  };
}
