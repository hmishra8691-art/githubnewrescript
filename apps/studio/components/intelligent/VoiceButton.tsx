"use client";
import React from "react";
import { useVoiceInput } from "../../lib/useVoiceInput";
import { languageName, type HeardTranscript } from "../../lib/intelligent/voice";

/**
 * THE MICROPHONE ON EVERY AGENT FIELD (2026-11-07). The Intelligent mode's own voice pipeline — the shared
 * `useVoiceInput` hook: record in the browser, transcribe with the configured speech provider (any language,
 * detected), read into English by the same normaliser — so the agent fields hear exactly what the Copilot hears.
 *
 * States are said in words: Listening (with Stop, Pause and Cancel), Transcribing, then the words land in the field
 * for the researcher to edit before anything is sent. A non-English recording keeps what was said beside the English
 * reading, with a one-click switch to the original words. Cancel throws the recording away; nothing is sent.
 */
export function VoiceButton({ surveyId, onHeard, label = "Speak", disabled, compact, refusedMessage }: { surveyId: string; onHeard: (heard: HeardTranscript) => void; label?: string; disabled?: boolean; compact?: boolean; /** what to say when the browser refuses the microphone (defaults to the agents' wording) */ refusedMessage?: string }) {
  const v = useVoiceInput({ surveyId, onTranscript: (h) => onHeard(h), refusedMessage: refusedMessage ?? "Microphone access was refused — allow it in the browser to speak to the agents." });
  const rec = v.state === "recording" || v.state === "paused";
  return (
    <span className={`agw-voice${rec ? " on" : ""}`} data-testid="agw-voice" data-state={v.state}>
      {!rec && (
        <button type="button" className={`agw-mic${v.state === "transcribing" ? " busy" : ""}`} onClick={() => void v.start()} disabled={disabled || v.state === "transcribing" || v.available === false}
          aria-label={`${label} — any language`} title={v.available === false ? "No transcription provider is configured on this Studio" : `${label} — any language; you can edit the words before anything is sent`} data-testid="agw-mic">
          <MicGlyph />{!compact && <span>{v.state === "transcribing" ? "Transcribing…" : label}</span>}
        </button>
      )}
      {rec && (
        <span className="agw-voice-live" role="status" aria-live="polite">
          <span className="agw-voice-dot" aria-hidden="true" />{v.state === "paused" ? "Paused" : "Listening…"}
          <button type="button" className="btn tiny primary" onClick={v.stop} data-testid="agw-voice-stop">Stop</button>
          {v.canPause && (v.state === "paused" ? <button type="button" className="btn tiny" onClick={v.resume}>Resume</button> : <button type="button" className="btn tiny" onClick={v.pause}>Pause</button>)}
          <button type="button" className="btn tiny ghost" onClick={v.cancel} data-testid="agw-voice-cancel">Cancel</button>
        </span>
      )}
      {v.error && <span className="agw-voice-err" role="alert">{v.error}</span>}
    </span>
  );
}

/** what the researcher said, when it was not English: the original beside the reading the agents used */
export function HeardNote({ heard, onUseOriginal }: { heard: HeardTranscript | null; onUseOriginal?: () => void }) {
  if (!heard || !heard.english || heard.language === "en") return null;
  return <div className="agw-heard" data-testid="agw-heard">Heard in {languageName(heard.language)}: “{heard.text}”{onUseOriginal && <> · <button type="button" className="linkish" onClick={onUseOriginal}>use the original words</button></>}</div>;
}

const MicGlyph = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" /></svg>;
