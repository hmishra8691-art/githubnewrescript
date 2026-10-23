import { languageInfo } from "@rescript/schema";
import { EN_MESSAGES, PARTICIPANT_MESSAGE_KEYS, type ParticipantMessageKey, type ParticipantMessages } from "./aiInterviewMessages.js";
import { BN_MESSAGES, HI_MESSAGES, MR_MESSAGES } from "./aiInterviewMessagesIn1.js";
import { GU_MESSAGES, TA_MESSAGES, TE_MESSAGES } from "./aiInterviewMessagesIn2.js";
import { KN_MESSAGES, ML_MESSAGES, PA_MESSAGES } from "./aiInterviewMessagesIn3.js";
import { AR_MESSAGES, ES_MESSAGES, UR_MESSAGES } from "./aiInterviewMessagesW1.js";
import { DE_MESSAGES, FR_MESSAGES, ID_MESSAGES, PT_MESSAGES } from "./aiInterviewMessagesW2.js";
import { JA_MESSAGES, KO_MESSAGES, ZH_MESSAGES } from "./aiInterviewMessagesW3.js";
import { BN_WORDS, EN_WORDS, GU_WORDS, HI_WORDS, MODERATOR_WORD_KEYS, MR_WORDS, TA_WORDS, TE_WORDS, type ModeratorWordKey, type ModeratorWordPack } from "./aiInterviewWords.js";
import { AR_WORDS, ES_WORDS, KN_WORDS, ML_WORDS, PA_WORDS, UR_WORDS } from "./aiInterviewWords2.js";
import { DE_WORDS, FR_WORDS, ID_WORDS, JA_WORDS, KO_WORDS, PT_WORDS, ZH_WORDS } from "./aiInterviewWords3.js";

/**
 * THE AI INTERVIEW'S LANGUAGES (G1 2026-10-22): which languages have built-in participant-page labels and
 * moderator wording, which are right-to-left, their own names, and the language a participant gets
 * (study languages, the browser's Accept-Language / navigator.languages, the guide's language).
 */

export const BUILTIN_MESSAGES: Readonly<Record<string, ParticipantMessages>> = {
  en: EN_MESSAGES, hi: HI_MESSAGES, mr: MR_MESSAGES, bn: BN_MESSAGES, ta: TA_MESSAGES, te: TE_MESSAGES, gu: GU_MESSAGES,
  kn: KN_MESSAGES, ml: ML_MESSAGES, pa: PA_MESSAGES, ur: UR_MESSAGES, ar: AR_MESSAGES, es: ES_MESSAGES, pt: PT_MESSAGES,
  fr: FR_MESSAGES, de: DE_MESSAGES, id: ID_MESSAGES, ja: JA_MESSAGES, zh: ZH_MESSAGES, ko: KO_MESSAGES,
};
export const BUILTIN_WORDS: Readonly<Record<string, ModeratorWordPack>> = {
  en: EN_WORDS, hi: HI_WORDS, mr: MR_WORDS, bn: BN_WORDS, ta: TA_WORDS, te: TE_WORDS, gu: GU_WORDS,
  kn: KN_WORDS, ml: ML_WORDS, pa: PA_WORDS, ur: UR_WORDS, ar: AR_WORDS, es: ES_WORDS, pt: PT_WORDS,
  fr: FR_WORDS, de: DE_WORDS, id: ID_WORDS, ja: JA_WORDS, zh: ZH_WORDS, ko: KO_WORDS,
};
/** the languages the participant page speaks without a translation provider */
export const BUILTIN_INTERVIEW_LANGUAGES = Object.keys(BUILTIN_MESSAGES);

const RTL = new Set(["ar", "ur", "fa", "he", "ps", "sd", "ug", "yi", "dv", "ckb", "ku-arab"]);
export const baseLanguage = (l: string | null | undefined): string => String(l ?? "").trim().toLowerCase().replace(/_/g, "-").split("-")[0].replace(/[^a-z]/g, "").slice(0, 8);
export function isRtlLanguage(l: string | null | undefined): boolean {
  const b = baseLanguage(l);
  return RTL.has(b) || languageInfo(b)?.direction === "rtl";
}
/** the language's own name ("हिन्दी"), else its English name, else the code */
export function nativeLanguageName(l: string): string {
  const info = languageInfo(baseLanguage(l));
  return info ? (info.nativeName === info.name ? info.name : `${info.nativeName} (${info.name})`) : l;
}

/** "{persona} is speaking" + { persona: "Maya" } */
export function formatMessage(s: string, vars: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * The participant page's catalog for a language: built-in, else the study's machine-translated labels
 * (`ui`), every key missing from those filled from English (never a blank button).
 */
export function participantMessages(language: string | null | undefined, ui?: Partial<Record<string, string>> | null): ParticipantMessages {
  const b = baseLanguage(language);
  const builtin = BUILTIN_MESSAGES[b];
  if (builtin) return builtin;
  const out = { ...EN_MESSAGES };
  if (ui) for (const k of PARTICIPANT_MESSAGE_KEYS) { const v = ui[k]; if (typeof v === "string" && v.trim()) out[k as ParticipantMessageKey] = v; }
  return out;
}

/** the moderator's rule wording for a language: built-in, else the study's translated wording (missing keys: English), else null */
export function moderatorWordPack(language: string | null | undefined, words?: Partial<Record<string, string>> | null): ModeratorWordPack | null {
  const b = baseLanguage(language);
  const builtin = BUILTIN_WORDS[b];
  if (builtin) return builtin;
  if (!words || !Object.keys(words).length) return null;
  const out = { ...EN_WORDS };
  for (const k of MODERATOR_WORD_KEYS) { const v = words[k]; if (typeof v === "string" && v.trim()) out[k as ModeratorWordKey] = v; }
  return out;
}

/** "hi-IN,hi;q=0.9,en;q=0.8" → ["hi", "en"] in preference order */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  return String(header ?? "").split(",").map((part) => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { tag: baseLanguage(tag), q: q ? Number(q.slice(2)) || 0 : 1 };
  }).filter((x) => x.tag && x.tag !== "*" && x.q > 0).sort((a, b) => b.q - a.q).map((x) => x.tag).filter((t, i, a) => a.indexOf(t) === i);
}

/**
 * The language a participant starts in: the first of their preferences (browser languages, then the
 * Accept-Language header) the study offers; a study open to any language takes their first preference;
 * else the study's first language; else the guide's.
 */
export function pickInterviewLanguage(o: { studyLanguages: readonly string[]; preferences: readonly (string | null | undefined)[]; guideLanguage?: string }): string {
  const prefs = o.preferences.map(baseLanguage).filter(Boolean);
  const offered = o.studyLanguages.map(baseLanguage).filter(Boolean);
  if (offered.length) return prefs.find((p) => offered.includes(p)) ?? offered[0];
  return prefs[0] ?? (baseLanguage(o.guideLanguage) || "en");
}
