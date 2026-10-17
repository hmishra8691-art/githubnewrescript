"use client";
import React from "react";
import type { Question, SurveyDefinition } from "@rescript/schema";
import { appendSpoken, speechInputFor, speechInputLang, type SpeechField } from "@rescript/engine";

/**
 * DICTATION FOR A TEXT ANSWER — the `speech_input` capability.
 *
 * ## Why this is a control on a text field and not a question type
 *
 * A spoken answer is an open-end answer. The moment it exists it needs the
 * same required check, the same min/max length, the same piping token, the
 * same export column, the same quality rules for gibberish and duplicates.
 * Every one of those reads `answers[q.id]` as a string. So the transcript goes
 * into that string through the field's ordinary `onChange`, and nothing
 * downstream is told it was spoken. A "Speech-to-Text" question type would
 * have created a second place for the same data to live, which is the exact
 * defect the taxonomy audit spent a day removing.
 *
 * ## What the respondent gets
 *
 *   · a microphone button beside the field, only when the browser can
 *     recognise speech at all — an unsupported browser shows nothing rather
 *     than a button that fails;
 *   · press to start, press to stop; the transcript is APPENDED to whatever
 *     they had typed, with interim results shown live and finalised on stop,
 *     so dictating one more sentence never wipes the first two;
 *   · the field stays editable throughout, because recognisers mishear and
 *     the respondent is the only one who knows what they said;
 *   · a plain reason when it does not work — microphone denied, no speech
 *     heard, network — instead of a silently inert button.
 *
 * ## Language
 *
 * `settings.speechLang` (BCP-47), else the survey's language, else the
 * browser's. A recogniser told the wrong language produces confident
 * nonsense, so the survey's own language is a better default than the
 * device's.
 *
 * Web Speech API only. It is what browsers ship; a server-side recogniser is
 * a provider decision for later and would sit behind the same control.
 */

type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
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

/** True when this browser can take dictation. Checked at render, not at click. */
export function speechInputAvailable(): boolean {
  return recognizerCtor() !== null;
}

/**
 * A spoken phrase joins what is already in the field with exactly one space.
 *
 * What the respondent typed is left exactly as they typed it — leading and
 * trailing spaces included. Only the transcript is trimmed, because a
 * recogniser's idea of where a phrase begins is not something the respondent
 * chose. (It lives in `@rescript/engine`, beside the eligibility rules, so
 * it is unit-tested; re-exported here for existing importers.)
 */
export { appendSpoken };

const REASONS: Record<string, string> = {
  "not-allowed": "Microphone access was refused. Allow it in your browser and try again.",
  "service-not-allowed": "Speech recognition is not available in this browser.",
  "no-speech": "No speech was heard. Try again, closer to the microphone.",
  "audio-capture": "No microphone was found.",
  "network": "Speech recognition needs a network connection.",
  "aborted": "",
};

/**
 * ON BY DEFAULT (October 2026). The control decides for itself whether it
 * belongs beside its field — `speechInputFor` in the engine: the survey's
 * switch (`deployment.speechInput === false` turns it off everywhere), the
 * question's (`settings.speechInput === false`), never a read-only or hidden
 * question, never a formatted field (email, phone, URL, ZIP, number, date, a
 * regex mask). `field` says which field it sits beside — the question's own
 * text answer (default), an "Other, specify" box, or a form / list field —
 * and `compact` draws an icon-sized button for the boxes that sit inline.
 */
export function SpeechInputButton({
  def, q, value, onChange, field, compact, label,
}: {
  def: SurveyDefinition;
  q: Question;
  value: string;
  onChange(next: string): void;
  field?: SpeechField;
  compact?: boolean;
  /** what the field is, for the button's accessible name when several sit on one question */
  label?: string;
}) {
  const Ctor = recognizerCtor();
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const [reason, setReason] = React.useState<string | null>(null);
  const rec = React.useRef<Recognizer | null>(null);
  /*
   * The answer as it stands RIGHT NOW — every final transcript is appended to
   * this, once, at the moment it arrives.
   *
   * It is read through a ref rather than from the `value` prop closed over by
   * the handler for two reasons. A recogniser callback is not a React event,
   * so React is free to batch the re-render it causes; two phrases arriving
   * before that render would otherwise both append to the same stale prop and
   * the first would be lost. And a click can land before React has re-rendered
   * after the respondent's last keystroke.
   *
   * There is deliberately no snapshot of the text as it was when dictation
   * started. Rewriting the whole answer as `snapshot + everything heard so
   * far` looks equivalent and is not: the field stays editable while the
   * recogniser listens — that is the whole point, recognisers mishear — and a
   * correction typed mid-sentence was silently destroyed by the next final
   * result.
   */
  const latest = React.useRef(value);
  latest.current = value;
  /*
   * The field's writer as of the LATEST render, not the one `start()` closed
   * over: a form field's onChange spreads the question's other fields from
   * its own render, and a phrase arriving after the respondent typed in a
   * neighbouring field must not put that field back.
   */
  const writer = React.useRef(onChange);
  writer.current = onChange;
  /** Write through the ref as well, so results in the same task compose. */
  const write = (next: string) => { latest.current = next; writer.current(next); };

  React.useEffect(() => () => rec.current?.abort(), []);

  if (!Ctor || !speechInputFor(def, q, field ?? { kind: "answer" })) return null;

  // the question's speechLang, the voice mode's, the survey's, then the browser's
  const lang = speechInputLang(def, q, typeof navigator !== "undefined" ? navigator.language : "en");

  const start = () => {
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      /*
       * `resultIndex` is where this event's news starts, so what is gathered
       * here is the phrase just finalised — not the whole session. Appending
       * it is what keeps dictation additive without the answer ever being
       * rewritten from end to end.
       */
      let interimText = "";
      let heard = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) heard += (heard && !heard.endsWith(" ") ? " " : "") + t.trim();
        else interimText += t;
      }
      setInterim(interimText);
      if (heard.trim()) write(appendSpoken(latest.current, heard));
    };
    r.onerror = (e) => {
      const msg = REASONS[e.error] ?? `Speech recognition failed (${e.error}).`;
      if (msg) setReason(msg);
      setListening(false);
    };
    r.onend = () => { setListening(false); setInterim(""); };
    rec.current = r;
    setReason(null);
    setListening(true);
    try { r.start(); } catch { setListening(false); setReason(REASONS["service-not-allowed"]); }
  };
  const stop = () => { rec.current?.stop(); setListening(false); };

  const of = label ? ` — ${label}` : "";
  const Wrap = compact ? "span" : "div";
  return (
    <Wrap className={`rs-speech${compact ? " compact" : ""}`} data-testid="speech-input" data-speech-field={(field ?? { kind: "answer" }).kind}
      /* an inline box sits inside an option's label or a grid row: the mic is its own control, never a click on the row */
      onClick={compact ? (e) => e.stopPropagation() : undefined}
      onPointerDown={compact ? (e) => e.stopPropagation() : undefined}
      onKeyDown={compact ? (e) => e.stopPropagation() : undefined}>
      <button
        type="button"
        className={`rs-btn secondary rs-speech-btn ${listening ? "listening" : ""}`}
        data-testid="speech-toggle"
        aria-pressed={listening}
        aria-label={listening ? `Stop dictating${of}` : `Dictate your answer${of}`}
        title={listening ? "Stop dictating" : `Dictate (${lang})`}
        onClick={listening ? stop : start}
      >
        {compact ? (listening ? "■" : "🎤") : listening ? "■ Stop" : "🎤 Dictate"}
      </button>
      {listening && (
        <span className="rs-speech-live" data-testid="speech-interim" aria-live="polite">
          {interim ? `“${interim}”` : "Listening…"}
        </span>
      )}
      {reason && <span className="rs-speech-reason" role="status" data-testid="speech-reason">{reason}</span>}
    </Wrap>
  );
}
