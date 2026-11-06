"use client";
import React from "react";

/**
 * THE MICROPHONE IN ASK (Analytics upgrade M7). The browser's own speech recognition (Web Speech API, Chrome,
 * Edge, Safari) turns a spoken request into the words of the Ask field — "Compare purchase intention across age
 * groups and recommend the most appropriate chart" — and nothing else: no audio leaves the device, and a browser
 * without a recogniser shows no button. What is heard is appended to what is typed, once, when it is final; the
 * field stays editable while listening; Escape or a second click stops.
 */
type Recognizer = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };

function recognizerCtor(): (new () => Recognizer) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function DictateButton({ value, onChange, onDone, lang = "en-US", disabled }: { value: string; onChange: (next: string) => void; /** called with the final text when listening ends — to submit on a spoken request */ onDone?: (text: string) => void; lang?: string; disabled?: boolean }) {
  const [Ctor] = React.useState(() => recognizerCtor());
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const rec = React.useRef<Recognizer | null>(null);
  const latest = React.useRef(value); latest.current = value;
  const heard = React.useRef(false);
  React.useEffect(() => () => rec.current?.abort(), []);
  if (!Ctor) return null;
  const stop = () => { rec.current?.stop(); };
  const start = () => {
    setProblem(null); setInterim(""); heard.current = false;
    const r = new Ctor();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      let finalText = "", interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; const t = res[0]?.transcript ?? ""; if (res.isFinal) finalText += t; else interimText += t; }
      setInterim(interimText.trim());
      if (finalText.trim()) { heard.current = true; const next = `${latest.current}${latest.current && !/\s$/.test(latest.current) ? " " : ""}${finalText.trim()}`; latest.current = next; onChange(next); }
    };
    r.onerror = (e) => { setProblem(e.error === "not-allowed" ? "The microphone is blocked for this site." : e.error === "no-speech" ? "Nothing was heard." : e.error === "network" ? "The browser's recogniser could not reach its service." : `Dictation failed (${e.error}).`); };
    r.onend = () => { setListening(false); setInterim(""); rec.current = null; if (heard.current) onDone?.(latest.current); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { setProblem("Dictation could not start."); }
  };
  return (
    <span className="ax-dictate">
      <button type="button" className={`btn small ${listening ? "primary" : ""}`} disabled={disabled} onClick={() => (listening ? stop() : start())} aria-pressed={listening} title={listening ? "Stop listening" : "Speak your request"} data-testid="ax-dictate" onKeyDown={(e) => { if (e.key === "Escape" && listening) stop(); }}>
        {listening ? "● Listening…" : "🎤 Speak"}
      </button>
      {interim && <span className="muted ax-dictate-interim" aria-live="polite">{interim}</span>}
      {problem && <span className="ax-dictate-problem" role="alert">{problem}</span>}
    </span>
  );
}
