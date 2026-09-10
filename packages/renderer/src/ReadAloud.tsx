"use client";
import React from "react";
import type { SurveyDefinition, Question } from "@rescript/schema";

/**
 * READ ALOUD — speech synthesis for the voice presentation mode.
 *
 * `branding.layout.voice.readAloud` makes the runtime speak each question as
 * it appears: the question text, then its options ("Option 1, Strongly
 * agree; option 2, …") so a respondent who is listening can answer without
 * reading. It uses the browser's own `speechSynthesis` — no service, no key,
 * nothing leaves the device — and it is a layer OVER the ordinary rendering:
 * the question is still on screen, still answered the ordinary way (or
 * dictated, if `voice.dictation` is on).
 *
 * The text spoken is derived from the rendered question — piping resolved,
 * HTML stripped — so what is heard is what is shown. A mute control stays
 * on screen while read-aloud is on; a "replay" reads the current question
 * again. Speech is cancelled whenever the question changes, so navigating
 * quickly never queues a backlog.
 *
 * Where speech synthesis is missing (some embedded browsers) nothing is
 * spoken and nothing breaks; `readAloudAvailable()` lets the toolbar say so.
 */

export function readAloudAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof (window as any).SpeechSynthesisUtterance === "function";
}

const strip = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** What is said for one question: its text, then its options / rows, numbered. */
export function spokenText(q: Question, renderedText: string): string {
  const parts: string[] = [strip(renderedText)];
  if (q.instruction) parts.push(strip(q.instruction));
  const opts = (q.options ?? []).filter((o) => o.label?.trim());
  if (opts.length && opts.length <= 15) {
    parts.push(opts.map((o, i) => `Option ${i + 1}: ${strip(o.label)}`).join(". "));
  }
  const rows = (q.rows ?? []).filter((r) => r.label?.trim());
  if (rows.length && rows.length <= 15 && !opts.length) {
    parts.push(rows.map((r) => strip(r.label)).join(". "));
  }
  return parts.filter(Boolean).join(". ");
}

export function speechLangFor(def: SurveyDefinition, q?: Question | null): string {
  return q?.settings.speechLang
    || def.branding.layout.voice?.lang
    || (def as unknown as { meta?: { language?: string } }).meta?.language
    || def.deployment?.languages?.[0]
    || (typeof navigator !== "undefined" ? navigator.language : "en");
}

/** Speak `text` now, cancelling anything queued. No-op without the API. */
export function speak(text: string, lang: string): boolean {
  if (!readAloudAvailable() || !text.trim()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new (window as any).SpeechSynthesisUtterance(text) as SpeechSynthesisUtterance;
  u.lang = lang;
  u.rate = 1;
  synth.speak(u);
  return true;
}

export function stopSpeaking(): void {
  if (readAloudAvailable()) window.speechSynthesis.cancel();
}

/**
 * Speak `text` whenever it changes while `enabled`; cancel on unmount and
 * when disabled. Returns a replay function for the toolbar.
 */
export function useReadAloud(text: string, lang: string, enabled: boolean): { replay(): void; speaking: boolean } {
  const [speaking, setSpeaking] = React.useState(false);
  const last = React.useRef<string>("");
  React.useEffect(() => {
    if (!enabled) { stopSpeaking(); setSpeaking(false); return; }
    if (!text.trim() || text === last.current) return;
    last.current = text;
    setSpeaking(speak(text, lang));
    const t = setInterval(() => { if (readAloudAvailable() && !window.speechSynthesis.speaking) setSpeaking(false); }, 400);
    return () => clearInterval(t);
  }, [text, lang, enabled]);
  React.useEffect(() => () => stopSpeaking(), []);
  return { replay: () => { last.current = text; setSpeaking(speak(text, lang)); }, speaking };
}
