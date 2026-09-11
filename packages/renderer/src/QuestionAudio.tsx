"use client";
import React from "react";
import type { Question, SurveyDefinition, AudioAsset } from "@rescript/schema";
import { audioFor, K } from "@rescript/engine";

/**
 * THE QUESTION'S AUDIO IN THE RESPONDENT'S LANGUAGE — a play button that
 * appears only when the localization layer has audio for this question in
 * this language: a human recording first, then approved AI audio, then a
 * hosted file, in the survey's own priority order (engine `audioFor`).
 *
 * It plays the question, then each visible option that has audio of its own,
 * in order. Nothing here is the AI Conversational Survey — that reads with a
 * synthetic voice when the survey has one; this plays the files a programmer
 * attached, and works with the AI voice off. The audio is addressed by
 * question id + option code + language, never by the text on screen, so a
 * language switch changes which file plays without touching anything else.
 */
export function QuestionAudio({ def, q, language, options }: { def: SurveyDefinition; q: Question; language: string; options?: { code: string | number }[] }) {
  const [playing, setPlaying] = React.useState(false);
  const run = React.useRef<{ cancelled: boolean; audio: HTMLAudioElement | null } | null>(null);
  const main = audioFor(def, K.qText(q.id), language);
  const optionAudio = (options ?? q.options ?? []).map((o) => audioFor(def, K.opt(q.id, o.code), language)).filter((a): a is AudioAsset => !!a);
  React.useEffect(() => () => { if (run.current) { run.current.cancelled = true; run.current.audio?.pause(); } }, []);
  if (!main && !optionAudio.length) return null;
  const list = [main, ...optionAudio].filter((a): a is AudioAsset => !!a);

  const stop = () => { if (run.current) { run.current.cancelled = true; run.current.audio?.pause(); } setPlaying(false); };
  const play = async () => {
    if (playing) { stop(); return; }
    const r = { cancelled: false, audio: null as HTMLAudioElement | null };
    run.current = r;
    setPlaying(true);
    for (const a of list) {
      if (r.cancelled) break;
      await new Promise<void>((resolve) => {
        const el = new Audio(a.url);
        r.audio = el;
        el.onended = () => resolve();
        el.onerror = () => resolve();
        el.play().catch(() => resolve());
      });
      if (!r.cancelled) await new Promise((res) => setTimeout(res, 350));
    }
    if (run.current === r) setPlaying(false);
  };
  const kind = main?.kind ?? optionAudio[0]?.kind;
  return (
    <div className="rs-qaudio" data-testid="rs-question-audio" data-question={q.id} data-kind={kind} data-count={list.length}>
      <button type="button" className={`rs-qaudio-btn${playing ? " playing" : ""}`} data-testid="rs-question-audio-play" onClick={play} aria-pressed={playing} aria-label={playing ? "Stop audio" : "Listen to this question"}>
        {playing ? "■ Stop" : "▶ Listen"}
      </button>
      <span className="rs-qaudio-kind" title={kind === "ai" ? "AI-generated audio" : kind === "human" ? "Human recording" : "Audio file"}>
        {kind === "ai" ? "AI voice" : kind === "human" ? "Recorded" : "Audio"}
      </span>
    </div>
  );
}
