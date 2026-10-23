import {
  baseLanguage, BUILTIN_MESSAGES, localizePlan, moderationOf, publicTextFor, SpeechGate, speechChunks, speechGateContext, voiceStylesOf,
  type InterviewTurnRecord, type LocalizedPublicText, type ModeratorPlan, type ModeratorState, type PreparedTurn, type PublicStudyView,
} from "@rescript/engine";
import type { SessionRec, StudyRec } from "./types.ts";

/**
 * AI INTERVIEWS: VOICE CONVERSATION AND LANGUAGES ON THE RESPONDENT LINK (G1 2026-10-22) — the helpers the
 * service calls, kept apart so the service's own flow stays readable.
 *
 *   languages   a study language's localized plan (its pack) and the participant page's text in it
 *   styles      text / voice (turn-based) / conversation (hands-free, barge-in) / realtime — a session's
 *               mode stays "voice" (migration 0069's check); the style lives in the moderator state
 *   speech      each sentence of a reply, as soon as it may be spoken (the speech gate), for the route to
 *               synthesize while the reply is still being written
 */

export type VoiceStyle = "turn_based" | "conversation" | "realtime";
/** a sentence cleared to be spoken: `i` orders them; the route turns each into audio */
export type SpeakSink = (chunk: { i: number; text: string }, ctx: { study: StudyRec; session: SessionRec | null }) => void;

/* ------------------------------------------------------------ languages */

export function localizedPlan(base: ModeratorPlan, study: StudyRec, language: string | null | undefined): ModeratorPlan {
  const lang = baseLanguage(language);
  if (!lang) return base;
  const pack = moderationOf(study.guide).translations?.[lang];
  return pack ? localizePlan(base, lang, pack) : base;
}

export interface StudyI18n {
  guideLanguage: string;
  /** per study language: the public text in it and its labels when not built in */
  texts: Record<string, LocalizedPublicText>;
  /** the languages whose page labels are built in */
  builtin: string[];
}
export function studyI18n(study: StudyRec, view: PublicStudyView): StudyI18n {
  const cfg = moderationOf(study.guide);
  const texts: Record<string, LocalizedPublicText> = {};
  for (const [lang, pack] of Object.entries(cfg.translations ?? {})) texts[baseLanguage(lang)] = publicTextFor(view, pack, cfg.screener.map((q) => ({ id: q.id, options: q.options })));
  return { guideLanguage: baseLanguage(study.guideLanguage) || "en", texts, builtin: Object.keys(BUILTIN_MESSAGES) };
}

/* ------------------------------------------------------------ styles */

/** the page's mode word → the session's mode and voice style */
export function modeAndStyle(raw: unknown): { mode: "text" | "voice" | "video" | null; style: VoiceStyle | null } {
  const m = String(raw ?? "");
  if (m === "conversation") return { mode: "voice", style: "conversation" };
  if (m === "realtime") return { mode: "voice", style: "realtime" };
  if (m === "voice") return { mode: "voice", style: "turn_based" };
  if (m === "video") return { mode: "video", style: "turn_based" };
  if (m === "text") return { mode: "text", style: null };
  return { mode: null, style: null };
}

/** the styles this study offers on this runtime (realtime only with a provider) */
export function offeredStyles(study: StudyRec, realtimeAvailable: boolean): VoiceStyle[] {
  const cfg = moderationOf(study.guide);
  if (!cfg.modes.includes("voice")) return [];
  return voiceStylesOf(cfg).filter((s) => s !== "realtime" || realtimeAvailable);
}

export function setVoice(state: ModeratorState, patch: Partial<NonNullable<ModeratorState["voice"]>>): void {
  state.voice = { interruptions: 0, latenciesMs: [], ...(state.voice ?? {}), ...patch };
}

/** the last moderator turn — what an interruption cut short (taken from the store, never from the page) */
export function lastModeratorTurn(turns: readonly InterviewTurnRecord[]): InterviewTurnRecord | null {
  return [...turns].filter((t) => t.speaker === "moderator").sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/* ------------------------------------------------------------ speech */

/**
 * The speaker for one reply: rules replies are spoken whole (cut into sentences); a model reply is gated
 * sentence by sentence as it streams. `finish` returns what the participant heard in total and whether the
 * scripted turn replaced the model's draft after some of it was spoken.
 */
export function replySpeaker(plan: ModeratorPlan, prepared: PreparedTurn, sink: SpeakSink | undefined, ctx: { study: StudyRec; session: SessionRec | null }) {
  let i = 0;
  const emit = (text: string) => { if (sink && text.trim()) sink({ i: i++, text: text.trim() }, ctx); };
  const gate = prepared.kind === "model" ? new SpeechGate(speechGateContext(plan, prepared)) : null;
  /* the intent streams in pieces before the words (the model writes it first): judged once the words begin */
  let intent = "", judged = false;
  return {
    onIntent(delta: string) { if (!judged) intent += delta; },
    onSay(delta: string) {
      if (!gate || !sink) return;
      if (!judged) { judged = true; if (intent.trim()) gate.setIntent(intent); }
      for (const c of gate.pushSay(delta)) emit(c);
    },
    /** problems found while streaming (they force the scripted turn) */
    get problems(): string[] { return gate?.blocked ? [gate.blocked] : []; },
    finish(finalSay: string): { spoken: string; replaced: boolean } {
      if (!sink) return { spoken: "", replaced: false };
      if (!gate) { for (const c of speechChunks(finalSay)) emit(c); return { spoken: "", replaced: false }; }
      const f = gate.finish(finalSay);
      for (const c of speechChunks(f.remainder)) emit(c);
      return { spoken: f.spoken, replaced: f.replaced };
    },
  };
}
