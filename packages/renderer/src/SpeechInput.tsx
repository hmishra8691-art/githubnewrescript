"use client";
import React from "react";
import type { Question, SurveyDefinition } from "@rescript/schema";
import { appendSpoken, speechInputFor, speechInputLang, speechServerOn, type SpeechField } from "@rescript/engine";

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
 * ## When the browser cannot (2026-10-22, engine item #16)
 *
 * Firefox ships no recogniser, and Chrome's can fail (network, a language it
 * does not serve). Then the same button RECORDS (MediaRecorder), sends the
 * clip to the runtime's speech-to-text (`SpeechService`, provided by the
 * Runner: `/api/session/dictate`, metered to the project) and appends the text
 * — "Transcribing…" while it waits. Audio leaves the device only after the
 * respondent agrees once (per survey session), only when the survey allows it
 * (`deployment.speechServer`), and only when the runtime has speech-to-text
 * configured; otherwise no button, as before.
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

/** what the Runner provides for server dictation (absent: browser recognition only) */
export interface SpeechService {
  /** whether the runtime can transcribe at all (probed once by the Runner) */
  available: boolean | null;
  /** the language the respondent is answering in (multilingual surveys) */
  language?: string | null;
  transcribe(audio: Blob, meta: { lang: string; durationMs: number; questionId: string }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}
export const SpeechServiceContext = React.createContext<SpeechService | null>(null);

/** a test / support switch: behave as a browser without Web Speech (Firefox) — `window.__rescriptNoWebSpeech = true` or `?nowebspeech=1` */
function webSpeechForcedOff(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __rescriptNoWebSpeech?: boolean };
  if (w.__rescriptNoWebSpeech) return true;
  try { return new URLSearchParams(window.location.search).has("nowebspeech"); } catch { return false; }
}
function recorderSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder === "function" && !!navigator.mediaDevices?.getUserMedia;
}
const RECORD_MAX_MS = 60_000;
const CONSENT_KEY = "rescript:dictation-consent";
const consentGiven = () => { try { return sessionStorage.getItem(CONSENT_KEY) === "1"; } catch { return false; } };
const rememberConsent = () => { try { sessionStorage.setItem(CONSENT_KEY, "1"); } catch { /* asked again next time */ } };
/** Web Speech errors a server recogniser can cure (the rest — refused microphone, silence — it cannot) */
const SERVER_CURES = new Set(["network", "service-not-allowed", "language-not-supported", "bad-grammar"]);

/**
 * ON BY DEFAULT (October 2026). The control decides for itself whether it
 * belongs beside its field — `speechInputFor` in the engine: the survey's
 * switch (`deployment.speechInput === false` turns it off everywhere), the
 * question's (`settings.speechInput === false`), never a read-only or hidden
 * question, never a formatted field (email, phone, URL, ZIP, number, date, a
 * regex mask). `field` says which field it sits beside — the question's own
 * text answer (default), an "Other, specify" box, a form / list field or a
 * grid cell — and `compact` draws an icon-sized button for the boxes that sit
 * inline. `target` is the field itself: focus goes back to it when dictation
 * ends, caret at the end, so typing can carry on.
 */
export function SpeechInputButton({
  def, q, value, onChange, field, compact, label, target,
}: {
  def: SurveyDefinition;
  q: Question;
  value: string;
  onChange(next: string): void;
  field?: SpeechField;
  compact?: boolean;
  /** what the field is, for the button's accessible name when several sit on one question */
  label?: string;
  target?: React.RefObject<HTMLInputElement | HTMLTextAreaElement>;
}) {
  const service = React.useContext(SpeechServiceContext);
  const Ctor = webSpeechForcedOff() ? null : recognizerCtor();
  const serverOk = !!service?.available && speechServerOn(def) && recorderSupported();
  /* for a FALLBACK after the browser's recogniser failed, "not known yet" is enough: the route says plainly if it cannot */
  const serverMaybe = !!service && service.available !== false && speechServerOn(def) && recorderSupported();
  const [mode, setMode] = React.useState<"web" | "server">(Ctor ? "web" : "server");
  const [listening, setListening] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const [reason, setReason] = React.useState<string | null>(null);
  const rec = React.useRef<Recognizer | null>(null);
  const media = React.useRef<{ recorder: MediaRecorder; stream: MediaStream; started: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
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
  /** focus back on the field, caret at the end */
  const refocus = () => {
    const el = target?.current;
    if (!el) return;
    requestAnimationFrame(() => { try { el.focus(); const n = el.value.length; el.setSelectionRange?.(n, n); } catch { /* not focusable */ } });
  };

  React.useEffect(() => () => {
    rec.current?.abort();
    const m = media.current;
    if (m) { if (m.timer) clearTimeout(m.timer); try { m.recorder.stop(); } catch { /* done */ } m.stream.getTracks().forEach((t) => t.stop()); }
  }, []);

  const eligible = speechInputFor(def, q, field ?? { kind: "answer" });
  if (!eligible || (!Ctor && !serverOk)) return null;
  const useServer = mode === "server" || !Ctor;

  // the question's speechLang, the respondent's language, the voice mode's, the survey's, then the browser's
  const lang = speechInputLang(def, q, typeof navigator !== "undefined" ? navigator.language : "en", service?.language ?? null);

  /* ---------------------------------------------------------------- server dictation */
  const startServer = async () => {
    if (!service) return;
    if (!consentGiven()) { setAsking(true); return; }
    setReason(null);
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) {
      const n = (e as Error).name;
      setReason(n === "NotAllowedError" || n === "SecurityError" ? REASONS["not-allowed"] : n === "NotFoundError" ? REASONS["audio-capture"] : `The microphone could not be opened (${n || "error"}).`);
      return;
    }
    const MR = (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((t) => { try { return MR.isTypeSupported(t); } catch { return false; } });
    let recorder: MediaRecorder;
    try { recorder = new MR(stream, type ? { mimeType: type } : undefined); }
    catch { stream.getTracks().forEach((t) => t.stop()); setReason("This browser cannot record audio."); return; }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const m = media.current;
      media.current = null;
      stream.getTracks().forEach((t) => t.stop());
      setListening(false);
      const durationMs = m ? Date.now() - m.started : 0;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      if (!blob.size) { setReason(REASONS["no-speech"]); return; }
      setTranscribing(true);
      try {
        const r = await service.transcribe(blob, { lang, durationMs, questionId: q.id });
        if (r.ok) { if (r.text.trim()) write(appendSpoken(latest.current, r.text)); else setReason(REASONS["no-speech"]); }
        else setReason(r.error);
      } catch { setReason("Your answer could not be turned into text — please try again, or type it."); }
      finally { setTranscribing(false); refocus(); }
    };
    recorder.start(1000);
    media.current = { recorder, stream, started: Date.now(), timer: setTimeout(() => { try { recorder.stop(); } catch { /* stopped */ } }, RECORD_MAX_MS) };
    setListening(true);
  };
  const stopServer = () => {
    const m = media.current;
    if (!m) return;
    if (m.timer) clearTimeout(m.timer);
    try { m.recorder.stop(); } catch { setListening(false); }
  };

  /* ---------------------------------------------------------------- browser recognition */
  const startWeb = () => {
    const r = new Ctor!();
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
      setListening(false);
      /* a failure the server can cure: switch to it (the respondent presses once more, after agreeing) */
      if (SERVER_CURES.has(e.error) && serverMaybe) {
        setMode("server");
        setReason(null);
        void startServer();
        return;
      }
      const msg = REASONS[e.error] ?? `Speech recognition failed (${e.error}).`;
      if (msg) setReason(msg);
    };
    r.onend = () => { setListening(false); setInterim(""); refocus(); };
    rec.current = r;
    setReason(null);
    setListening(true);
    try { r.start(); } catch {
      setListening(false);
      if (serverMaybe) { setMode("server"); void startServer(); }
      else setReason(REASONS["service-not-allowed"]);
    }
  };
  const stopWeb = () => { rec.current?.stop(); setListening(false); };

  const start = () => (useServer ? void startServer() : startWeb());
  const stop = () => (useServer ? stopServer() : stopWeb());

  const of = label ? ` — ${label}` : "";
  const Wrap = compact ? "span" : "div";
  const busy = transcribing;
  return (
    <Wrap className={`rs-speech${compact ? " compact" : ""}${listening || busy || asking ? " active" : ""}`} data-testid="speech-input" data-speech-field={(field ?? { kind: "answer" }).kind}
      data-speech-mode={useServer ? "server" : "web"}
      /* an inline box sits inside an option's label or a grid row: the mic is its own control, never a click on the row */
      onClick={compact ? (e) => e.stopPropagation() : undefined}
      onPointerDown={compact ? (e) => e.stopPropagation() : undefined}
      onKeyDown={compact ? (e) => e.stopPropagation() : undefined}>
      <button
        type="button"
        className={`rs-btn secondary rs-speech-btn ${listening ? "listening" : ""}`}
        data-testid="speech-toggle"
        aria-pressed={listening}
        aria-busy={busy || undefined}
        disabled={busy}
        aria-label={listening ? `Stop dictating${of}` : `Dictate your answer${of}`}
        title={listening ? "Stop dictating" : `Dictate (${lang})${useServer ? " — sent to our transcription service" : ""}`}
        onClick={listening ? stop : start}
      >
        {compact ? (listening ? "■" : "🎤") : listening ? "■ Stop" : "🎤 Dictate"}
      </button>
      {asking && (
        <span className="rs-speech-consent" role="group" aria-label="Allow dictation" data-testid="speech-consent">
          <span>Your recording is sent to our transcription service and typed into the box; the audio is not kept.</span>
          <button type="button" className="rs-btn small" data-testid="speech-consent-allow" onClick={() => { rememberConsent(); setAsking(false); void startServer(); }}>Allow</button>
          <button type="button" className="rs-btn secondary small" data-testid="speech-consent-cancel" onClick={() => { setAsking(false); refocus(); }}>Cancel</button>
        </span>
      )}
      {listening && (
        <span className="rs-speech-live" data-testid="speech-interim" aria-live="polite">
          {useServer ? "Recording… press ■ when you are done" : interim ? `“${interim}”` : "Listening…"}
        </span>
      )}
      {busy && <span className="rs-speech-live" data-testid="speech-transcribing" aria-live="polite">Transcribing…</span>}
      {reason && <span className="rs-speech-reason" role="status" data-testid="speech-reason">{reason}</span>}
    </Wrap>
  );
}

/**
 * DICTATION IN A GRID CELL (2026-10-22, #16) — matrix_text answers, custom
 * table and Editable Table text columns. A button per cell would widen every
 * column and add a tab stop per cell, so the microphone sits INSIDE the cell
 * and appears only while the cell (or the microphone) has focus, or while it
 * records / transcribes; the text goes into that cell under its own key and
 * focus returns to it. The cell's width never changes.
 */
export function SpeechCell({
  def, q, value, onChange, label, columnType, validation, children,
}: {
  def: SurveyDefinition;
  q: Question;
  value: string;
  onChange(next: string): void;
  label: string;
  columnType?: string | null;
  validation?: readonly { kind: string }[] | null;
  children(ref: React.RefObject<HTMLInputElement & HTMLTextAreaElement>): React.ReactNode;
}) {
  const ref = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const field: SpeechField = { kind: "cell", columnType: columnType ?? "text", validation: validation ?? null };
  if (!speechInputFor(def, q, field)) return <>{children(ref)}</>;
  return (
    <span className="rs-speech-cell" data-testid="speech-cell">
      {children(ref)}
      <SpeechInputButton def={def} q={q} value={value} onChange={onChange} field={field} compact label={label} target={ref} />
    </span>
  );
}
