import type { SurveyDefinition, Question, Option, AiConversation, AiQuestionOverride, VoiceConfig, VoiceReading, ProbeConfig, SpokenScript } from "@rescript/schema";
import { AiConversation as AiConversationSchema } from "@rescript/schema";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { resolvePiping } from "./piping.js";
import { audioFor, K } from "./localization.js";

/**
 * THE AI CONVERSATIONAL SURVEY ENGINE — the pure half.
 *
 * Everything the runtime and the Studio need to decide WITHOUT a screen or a
 * provider: what the effective configuration is (survey + question + legacy
 * settings), what the voice should say for a question and in what order with
 * what pauses, how a spoken answer maps onto the question's own values, which
 * voice commands apply to the question on screen, and how the survey-wide
 * adaptive settings become a follow-up probe on a question — through the
 * ordinary `ProbeConfig` the runtime already knows how to show.
 *
 * Nothing here changes what the survey asks. The programmed survey is the
 * authority: this module reads the VISIBLE options it is handed (after
 * masking), resolves piping through the same `resolvePiping` the screen uses
 * (so a loop's CURRENT_ITEM is spoken exactly as displayed), and hands back
 * VALUES the question can take — never a transcript as the answer.
 */

/* ------------------------------------------------------- effective config */

/**
 * The survey's interviewer. When `branding.aiConversation` is absent the
 * older settings are read instead — `layout.presentation` and
 * `layout.voice` — so a survey saved before this object existed behaves
 * exactly as it did.
 */
export function effectiveAiConversation(def: SurveyDefinition): AiConversation {
  const explicit = def.branding?.aiConversation;
  if (explicit) return AiConversationSchema.parse(explicit);
  const layout = def.branding?.layout;
  const voice = layout?.voice;
  const conversational = layout?.presentation === "conversational";
  const readAloud = !!voice?.readAloud, dictation = !!voice?.dictation;
  const anyVoice = readAloud || dictation;
  return AiConversationSchema.parse({
    enabled: conversational || anyVoice,
    interaction: anyVoice ? "text_voice" : "text",
    conversation: conversational ? "conversational" : "standard",
    // the older settings never acknowledged answers; a survey saved with them still does not
    interviewer: { acknowledge: false },
    voice: {
      locale: voice?.lang ? { language: voice.lang.split("-")[0], dialect: voice.lang } : {},
      // the older switches only mean something when one of them was on; otherwise the defaults stand,
      // so a survey that later turns voice on reads the question and listens
      ...(anyVoice ? {
        reading: { question: readAloud, options: readAloud },
        // read-aloud without dictation was a listening survey with no microphone; it still is
        interaction: { listen: dictation },
      } : {}),
    },
  });
}

/** Deep-merge a partial over a full config (arrays and scalars replace, objects merge). */
function merge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || typeof over !== "object") return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** The interviewer as it applies to ONE question: the survey's config with the question's overrides merged in. */
export function questionAi(def: SurveyDefinition, q: Question): AiConversation {
  const survey = effectiveAiConversation(def);
  const o: AiQuestionOverride | undefined = q.ai;
  if (!o) return survey;
  return {
    ...survey,
    interaction: o.interaction ?? survey.interaction,
    conversation: o.conversation ?? survey.conversation,
    adaptive: merge(survey.adaptive, o.adaptive),
    voice: {
      ...survey.voice,
      profile: merge(survey.voice.profile, o.profile),
      reading: merge(survey.voice.reading, o.reading),
      audio: merge(survey.voice.audio, o.audio),
      pauses: merge(survey.voice.pauses, o.pauses),
      interaction: merge(survey.voice.interaction, o.interaction_),
    },
  };
}

export const voiceOn = (c: AiConversation) => c.enabled && c.interaction !== "text";
export const dictationOn = (c: AiConversation) => voiceOn(c);
export const readAloudOn = (c: AiConversation) => voiceOn(c);

/* ---------------------------------------------------------------- presets */

export interface VoicePreset {
  id: string; name: string; description: string;
  config: {
    profile?: Partial<VoiceConfig["profile"]>; audio?: Partial<VoiceConfig["audio"]>; pauses?: Partial<VoiceConfig["pauses"]>;
    reading?: Partial<VoiceReading>; interaction?: Partial<VoiceConfig["interaction"]>;
  };
}

/**
 * Starting points. The names describe a STYLE of voice and pacing, never an
 * identity: "youthful voice" is a voice style suited to research with young
 * people, not a claim about who is speaking.
 */
export const VOICE_PRESETS: VoicePreset[] = [
  { id: "professional_interviewer", name: "Professional Interviewer", description: "Neutral voice, normal pace, moderate volume; reads the question and the options.",
    config: { profile: { gender: "neutral", ageStyle: "adult", personality: "professional" }, audio: { rate: 1, volume: 0.85, emphasis: "none" }, reading: { question: true, options: true, optionMode: "all" } } },
  { id: "friendly_consumer", name: "Friendly Consumer Survey", description: "Warm, conversational voice, slightly slower, moderate volume.",
    config: { profile: { gender: "female", ageStyle: "adult", personality: "warm" }, audio: { rate: 0.95, volume: 0.85, emphasis: "light" }, reading: { question: true, options: true, optionMode: "all" }, pauses: { afterQuestionMs: 900, betweenOptionsMs: 350 } } },
  { id: "youth_research", name: "Children's / Youth Research", description: "A youthful, friendly voice style with simple pacing — for studies with younger respondents.",
    config: { profile: { gender: "neutral", ageStyle: "young_adult", personality: "friendly", character: "friendly_character" }, audio: { rate: 0.9, volume: 0.85, emphasis: "light" }, reading: { question: true, options: true, optionMode: "all" }, pauses: { afterQuestionMs: 1200, betweenOptionsMs: 500 } } },
  { id: "accessibility", name: "Accessibility", description: "Slower speech, longer pauses, options read one by one, repeat and clarification on, captions on.",
    config: { profile: { gender: "neutral", ageStyle: "adult", personality: "calm" }, audio: { rate: 0.8, volume: 1, emphasis: "moderate" }, reading: { question: true, options: true, instructions: true, validationErrors: true, optionMode: "all" }, pauses: { afterQuestionMs: 1500, beforeOptionsMs: 800, betweenOptionsMs: 700, afterAnswerMs: 1000, betweenRowsMs: 1000 }, interaction: { repeat: true, clarification: true, captions: true, confidenceThreshold: 0.8 } } },
];

export function applyVoicePreset(voice: VoiceConfig, presetId: string): VoiceConfig {
  const p = VOICE_PRESETS.find((x) => x.id === presetId);
  if (!p) return voice;
  return { ...merge(voice, p.config), preset: presetId };
}

/* ---------------------------------------------------------------- locales */

export interface LocaleEntry { country: string; countryName: string; languages: { code: string; name: string; dialect: string; dialectName: string }[] }

/** Countries a programmer can pick, with the languages and dialect tags the browser voices are most likely to carry. */
export const LOCALES: LocaleEntry[] = [
  { country: "US", countryName: "United States", languages: [{ code: "en", name: "English", dialect: "en-US", dialectName: "American English" }, { code: "es", name: "Spanish", dialect: "es-US", dialectName: "US Spanish" }] },
  { country: "GB", countryName: "United Kingdom", languages: [{ code: "en", name: "English", dialect: "en-GB", dialectName: "British English" }] },
  { country: "IN", countryName: "India", languages: [{ code: "en", name: "English", dialect: "en-IN", dialectName: "Indian English" }, { code: "hi", name: "Hindi", dialect: "hi-IN", dialectName: "Hindi (India)" }, { code: "ta", name: "Tamil", dialect: "ta-IN", dialectName: "Tamil (India)" }, { code: "bn", name: "Bengali", dialect: "bn-IN", dialectName: "Bengali (India)" }, { code: "mr", name: "Marathi", dialect: "mr-IN", dialectName: "Marathi (India)" }, { code: "te", name: "Telugu", dialect: "te-IN", dialectName: "Telugu (India)" }] },
  { country: "AU", countryName: "Australia", languages: [{ code: "en", name: "English", dialect: "en-AU", dialectName: "Australian English" }] },
  { country: "CA", countryName: "Canada", languages: [{ code: "en", name: "English", dialect: "en-CA", dialectName: "Canadian English" }, { code: "fr", name: "French", dialect: "fr-CA", dialectName: "Canadian French" }] },
  { country: "SG", countryName: "Singapore", languages: [{ code: "en", name: "English", dialect: "en-SG", dialectName: "Singapore English" }, { code: "zh", name: "Chinese", dialect: "zh-SG", dialectName: "Mandarin (Singapore)" }, { code: "ms", name: "Malay", dialect: "ms-SG", dialectName: "Malay (Singapore)" }] },
  { country: "JP", countryName: "Japan", languages: [{ code: "ja", name: "Japanese", dialect: "ja-JP", dialectName: "Japanese" }, { code: "en", name: "English", dialect: "en-US", dialectName: "American English" }] },
  { country: "DE", countryName: "Germany", languages: [{ code: "de", name: "German", dialect: "de-DE", dialectName: "German (Germany)" }, { code: "en", name: "English", dialect: "en-GB", dialectName: "British English" }] },
  { country: "FR", countryName: "France", languages: [{ code: "fr", name: "French", dialect: "fr-FR", dialectName: "French (France)" }, { code: "en", name: "English", dialect: "en-GB", dialectName: "British English" }] },
  { country: "ES", countryName: "Spain", languages: [{ code: "es", name: "Spanish", dialect: "es-ES", dialectName: "Spanish (Spain)" }, { code: "ca", name: "Catalan", dialect: "ca-ES", dialectName: "Catalan" }] },
  { country: "BR", countryName: "Brazil", languages: [{ code: "pt", name: "Portuguese", dialect: "pt-BR", dialectName: "Brazilian Portuguese" }] },
  { country: "MX", countryName: "Mexico", languages: [{ code: "es", name: "Spanish", dialect: "es-MX", dialectName: "Mexican Spanish" }] },
];

/**
 * THE LOCALE THE VOICE SHOULD USE. Explicit dialect wins; "match" follows the
 * respondent's locale when it is known and reliable (a full BCP-47 tag with a
 * region, e.g. "en-IN"); otherwise the survey's explicit language/region;
 * otherwise the browser's. Never a guess: when the respondent's locale is
 * only a bare language ("en") and the survey names a country, the country's
 * dialect for that language is used.
 */
export function resolveVoiceLocale(voice: VoiceConfig, respondentLocale?: string | null, surveyLanguage?: string | null): string {
  const loc = voice.locale;
  if (loc.dialect && loc.dialect !== "match") return loc.dialect;
  const lang = loc.language && loc.language !== "auto" ? loc.language : (respondentLocale?.split("-")[0] || surveyLanguage || "en");
  if (respondentLocale && /^[a-z]{2,3}-[A-Za-z]{2,4}$/.test(respondentLocale) && (loc.language === "auto" || respondentLocale.startsWith(lang))) return respondentLocale;
  if (loc.country) {
    const entry = LOCALES.find((l) => l.country === loc.country);
    const hit = entry?.languages.find((l) => l.code === lang);
    if (hit) return hit.dialect;
  }
  if (respondentLocale && respondentLocale.split("-")[0] === lang && respondentLocale.includes("-")) return respondentLocale;
  return lang;
}

/* --------------------------------------------------------- spoken script */

export interface SpokenSegment {
  /** what to say */
  text: string;
  /** what this is — the renderer may emphasise or caption differently */
  kind: "question" | "instruction" | "option" | "row" | "column" | "prompt" | "error" | "ack";
  /** silence after this segment */
  pauseMs: number;
  /** pre-recorded audio to play instead of synthesising `text` */
  audioUrl?: string;
  /** the option / row this segment reads, for highlighting */
  code?: string;
  emphasis?: "none" | "light" | "moderate";
}

const strip = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Apply pronunciations (survey-wide, then the question's own) to a spoken string, whole words only. */
export function pronounce(text: string, ...maps: (Record<string, string> | undefined)[]): string {
  let out = text;
  for (const m of maps) {
    if (!m) continue;
    for (const [term, said] of Object.entries(m)) {
      if (!term.trim()) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "giu");
      out = out.replace(re, (_, pre) => `${pre}${said}`);
    }
  }
  return out;
}

export interface SpokenScriptInput {
  /** the options the respondent actually sees — after masking, randomisation, carry-forward */
  options: Option[];
  /** rows as shown (matrix / list) */
  rows?: { code: string | number; label: string }[];
  /** columns as shown (matrix) */
  columns?: { code: string | number; label: string }[];
  /** a validation error to read */
  error?: string;
  /** which row the respondent chose to hear (respondent-driven grids) */
  rowCode?: string;
  /** "read options" was asked for, so read them even in on_request mode */
  optionsRequested?: boolean;
  /** the respondent's language — recordings attached in the localization layer replace synthesis for the segments that have one */
  language?: string;
}

/**
 * WHAT THE VOICE SAYS FOR A QUESTION, in order, with pauses.
 *
 * Reads the question (displayed text, custom spoken text, or approved AI
 * wording — piping resolved so a loop item is spoken as shown), then the
 * instruction if enabled, then the options under the configured reading
 * mode, or the grid under its strategy. Pronunciations apply to everything
 * spoken; the stored labels are untouched. Only the VISIBLE options are
 * ever spoken — a masked option is not exposed by voice.
 */
export function spokenSegments(def: SurveyDefinition, q: Question, ctx: EvalContext, cfg: AiConversation, input: SpokenScriptInput): SpokenSegment[] {
  const v = cfg.voice, r = v.reading, p = v.pauses;
  const sp: SpokenScript | undefined = q.spoken;
  const say = (s: string) => pronounce(strip(resolvePiping(s, ctx)), v.pronunciations, sp?.pronunciations);
  const emph = v.audio.emphasis;
  const out: SpokenSegment[] = [];
  // a recording attached for this language (human, approved AI, or a hosted file — by the survey's priority) plays instead of synthesis
  const au = (key: string): string | undefined => (input.language ? audioFor(def, key, input.language)?.url : undefined);

  if (r.question) {
    let text = q.text;
    if (sp?.mode === "custom" && sp.question?.trim()) text = sp.question;
    else if (sp?.mode === "ai" && sp.aiApproved && sp.aiVersion?.trim() && !sp.locked) text = sp.aiVersion;
    const spoken = say(text);
    if (spoken) out.push({ text: spoken, kind: "question", pauseMs: p.afterQuestionMs, audioUrl: au(K.qText(q.id)) ?? sp?.audioUrl, emphasis: emph });
  }
  if (r.instructions && (sp?.instruction || q.instruction)) {
    const t = say(sp?.instruction ?? q.instruction ?? "");
    if (t) out.push({ text: t, kind: "instruction", pauseMs: p.beforeOptionsMs, emphasis: emph === "none" ? "none" : "light" });
  }
  if (input.error && r.validationErrors) out.push({ text: say(input.error), kind: "error", pauseMs: p.afterAnswerMs, emphasis: "moderate" });

  const isGrid = /^matrix_/.test(q.type) && (input.rows?.length ?? 0) > 0;
  if (isGrid) {
    out.push(...gridSegments(q, cfg, input, say));
    return out;
  }

  const readOptions = r.options && input.options.length > 0 && (r.optionMode !== "on_request" || input.optionsRequested) && r.optionMode !== "none";
  if (readOptions) {
    const speakable = input.options.filter((o) => {
      const flags = o.flags ?? [];
      if (flags.includes("other_specify") && !r.speakOther) return false;
      if ((flags.includes("none_of_above") || flags.includes("exclusive")) && !r.speakNone) return false;
      return true;
    });
    const list = r.optionMode === "first_n" ? speakable.slice(0, r.firstN) : speakable;
    if (out.length) out[out.length - 1].pauseMs = Math.max(out[out.length - 1].pauseMs, p.beforeOptionsMs);
    list.forEach((o, i) => {
      const label = say(optionSpokenLabel(q, o));
      const last = i === list.length - 1;
      out.push({ text: label, kind: "option", code: String(o.code), pauseMs: last ? p.afterAnswerMs : p.betweenOptionsMs, emphasis: emph === "moderate" ? "light" : "none", audioUrl: au(K.opt(q.id, o.code)) });
      if (r.optionMode === "grouped" && (i + 1) % r.groupSize === 0 && !last) out[out.length - 1].pauseMs = Math.max(p.betweenOptionsMs * 2, p.beforeOptionsMs);
    });
    if (r.optionMode === "first_n" && speakable.length > list.length) {
      out.push({ text: `and ${speakable.length - list.length} more. Say "read options" to hear them all.`, kind: "prompt", pauseMs: p.afterAnswerMs });
    }
  } else if (r.options && r.optionMode === "on_request" && input.options.length > 0) {
    out.push({ text: `There are ${input.options.length} options. Say "read options" to hear them.`, kind: "prompt", pauseMs: p.afterAnswerMs });
  }
  return out;
}

/** The spoken form of an option: its `spoken` field, the question's spoken map, or the label. */
export function optionSpokenLabel(q: Question, o: Option): string {
  return o.spoken?.trim() || q.spoken?.options?.[String(o.code)]?.trim() || o.label;
}

function gridSegments(q: Question, cfg: AiConversation, input: SpokenScriptInput, say: (s: string) => string): SpokenSegment[] {
  const r = cfg.voice.reading, p = cfg.voice.pauses;
  const rows = input.rows ?? [], cols = input.columns ?? input.options.map((o) => ({ code: o.code, label: optionSpokenLabel(q, o) }));
  const out: SpokenSegment[] = [];
  const rowLabel = (row: { code: string | number; label: string }) => say(q.spoken?.rows?.[String(row.code)]?.trim() || row.label);
  const colSegs = (pause: number) => cols.map((c, i) => ({ text: say(c.label), kind: "column" as const, code: String(c.code), pauseMs: i === cols.length - 1 ? pause : p.betweenColumnsMs }));
  if (r.gridMode === "respondent_driven") {
    if (input.rowCode) {
      const row = rows.find((x) => String(x.code) === input.rowCode);
      if (row) { out.push({ text: rowLabel(row), kind: "row", code: String(row.code), pauseMs: p.beforeOptionsMs }); if (r.gridColumns) out.push(...colSegs(p.afterAnswerMs)); }
    } else {
      out.push({ text: "Which one would you like to rate first?", kind: "prompt", pauseMs: p.afterAnswerMs });
    }
    return out;
  }
  if (r.gridMode === "row_by_row") {
    rows.forEach((row) => {
      if (r.gridRows) out.push({ text: rowLabel(row), kind: "row", code: String(row.code), pauseMs: r.gridColumns ? p.betweenColumnsMs : p.betweenRowsMs });
      if (r.gridColumns) out.push(...colSegs(p.betweenRowsMs));
    });
    return out;
  }
  // question_first: the rows, then (once) the columns
  if (r.gridRows) rows.forEach((row, i) => out.push({ text: rowLabel(row), kind: "row", code: String(row.code), pauseMs: i === rows.length - 1 ? p.beforeOptionsMs : p.betweenRowsMs }));
  if (r.gridColumns && cols.length) { out.push({ text: "The choices for each are:", kind: "prompt", pauseMs: p.betweenColumnsMs }); out.push(...colSegs(p.afterAnswerMs)); }
  return out;
}

/** The whole script as one string — for previews, captions and transcripts. */
export function spokenText(segments: SpokenSegment[]): string {
  return segments.map((s) => (/[.!?]$/.test(s.text.trim()) ? s.text.trim() : `${s.text.trim()}.`)).join(" ");
}

/* -------------------------------------------------------- voice answers */

export type VoiceCommand =
  | { kind: "next" } | { kind: "back" } | { kind: "repeat" } | { kind: "skip" } | { kind: "help" }
  | { kind: "read_options" } | { kind: "none" } | { kind: "other" } | { kind: "clarify" }
  | { kind: "select"; target: string } | { kind: "remove"; target: string } | { kind: "row"; target: string }
  | { kind: "confirm"; yes: boolean };

/** lower-case, punctuation dropped except commas (they separate items in a spoken list), spaces collapsed */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s,]/gu, " ").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();

/**
 * A NAVIGATION OR EDITING COMMAND in what was said, or null when it is an
 * answer. Only commands compatible with the question on screen are offered
 * to the runtime (`applicableCommands`); this just recognises them.
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const t = norm(transcript).replace(/,/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/^(next|continue|go on|go ahead|submit|done|that s all|that is all)$/.test(t)) return { kind: "next" };
  if (/^(back|go back|previous|previous question)$/.test(t)) return { kind: "back" };
  if (/^(repeat|say that again|say again|repeat the question|repeat question|pardon|what)$/.test(t)) return { kind: "repeat" };
  if (/^(i didn t understand|i don t understand|i did not understand|sorry|can you explain|explain)$/.test(t)) return { kind: "clarify" };
  if (/^(skip|skip this|no answer|pass)$/.test(t)) return { kind: "skip" };
  if (/^(help|what can i say|options|commands)$/.test(t)) return { kind: "help" };
  if (/^(read|repeat|list|what are)( the)? (options|choices|answers)$/.test(t) || /^(read|repeat) options$/.test(t)) return { kind: "read_options" };
  if (/^(none|none of the above|none of these|nothing|no|neither)$/.test(t)) return { kind: "none" };
  if (/^(other|something else|other specify)$/.test(t)) return { kind: "other" };
  if (/^(yes|yeah|yep|correct|that s right|that s correct|right|confirm|ok|okay)$/.test(t)) return { kind: "confirm", yes: true };
  if (/^(no|nope|that s wrong|incorrect|not right|wrong)$/.test(t)) return { kind: "confirm", yes: false };
  let m = /^(?:select|choose|pick|add|tick|check)\s+(.+)$/.exec(t);
  if (m) return { kind: "select", target: m[1] };
  m = /^(?:remove|unselect|deselect|take off|drop|untick|uncheck|not)\s+(.+)$/.exec(t);
  if (m) return { kind: "remove", target: m[1] };
  m = /^(?:rate|start with|first|let s do|do)\s+(.+?)(?: first)?$/.exec(t);
  if (m) return { kind: "row", target: m[1] };
  return null;
}

/** Which commands make sense for this question right now. */
export function applicableCommands(q: Question, hasAnswer: boolean, canGoBack: boolean, hasOptions: boolean): VoiceCommand["kind"][] {
  const out: VoiceCommand["kind"][] = ["repeat", "clarify", "help", "next"];
  if (canGoBack) out.push("back");
  if (!q.required) out.push("skip");
  if (hasOptions) out.push("read_options", "select");
  if (hasOptions && (q.type === "multi_select" || q.type === "multi_dropdown")) out.push("remove");
  if (hasOptions && q.options.some((o) => (o.flags ?? []).some((f) => f === "none_of_above" || f === "exclusive"))) out.push("none");
  if (hasOptions && q.options.some((o) => (o.flags ?? []).includes("other_specify"))) out.push("other");
  if (/^matrix_/.test(q.type)) out.push("row");
  void hasAnswer;
  return out;
}

export interface SpokenMatch {
  /** option codes the utterance names, in order */
  codes: string[];
  /** words that named nothing */
  unmatched: string[];
  /** 0–1: how sure the mapping is (label similarity × recognition confidence) */
  confidence: number;
  /** a hedge was heard ("I think", "maybe") or a label matched only loosely */
  ambiguous: boolean;
  /** "Other" / "None" flags named by the utterance */
  other?: boolean;
  none?: boolean;
  /** items the utterance asked to remove ("remove Samsung") */
  removed: string[];
  /** for numeric / scale questions: the value heard */
  number?: number;
}

const HEDGES = /\b(i think|maybe|perhaps|probably|i guess|kind of|sort of|i suppose|not sure|possibly)\b/;
const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (b.includes(a) || a.includes(b)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.9 + 0.1;
  // token overlap
  const ta = new Set(a.split(" ")), tb = new Set(b.split(" "));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  return inter ? inter / Math.max(ta.size, tb.size) : 0;
}

/**
 * MAP WHAT WAS SAID ONTO THE QUESTION'S OWN VALUES.
 *
 * "Apple and Samsung" → the two option codes; "Apple, Samsung, and Google" →
 * three; "remove Samsung" → a removal; "none of the above" → the none option;
 * "around two hundred" → 200 with `ambiguous` set (a hedge was heard);
 * "pretty happy" → the option whose label or spoken synonyms match, ONLY
 * when the match is close — otherwise nothing, and the runtime asks. The
 * transcript itself is never the answer; it may be stored beside it.
 */
export function matchSpokenAnswer(q: Question, transcript: string, visible: Option[], recognitionConfidence = 1): SpokenMatch {
  const raw = norm(transcript);
  const hedged = HEDGES.test(raw);
  const text = raw.replace(HEDGES, " ").replace(/\b(i d say|i would say|i want|i ll take|i ll go with|let s say|um|uh)\b/g, " ").replace(/\s+/g, " ").trim();
  const result: SpokenMatch = { codes: [], unmatched: [], confidence: 0, ambiguous: hedged, removed: [] };

  // removals first: "remove samsung" / "not samsung"
  const removeRe = /\b(?:remove|without|not|take off|drop|except)\s+([\p{L}\p{N} ]+?)(?=\b(?:and|,)\b|$)/gu;
  let rm: RegExpExecArray | null;
  const stripped: string[] = [];
  while ((rm = removeRe.exec(text)) !== null) { stripped.push(rm[1].trim()); }
  const body = text.replace(removeRe, " ").replace(/\s+/g, " ").trim();

  // special options
  const noneOpt = visible.find((o) => (o.flags ?? []).some((f) => f === "none_of_above" || f === "exclusive"));
  const otherOpt = visible.find((o) => (o.flags ?? []).includes("other_specify"));
  if (/^(none|none of the above|none of these|nothing|no)$/.test(body) && noneOpt) {
    return { ...result, codes: [String(noneOpt.code)], none: true, confidence: recognitionConfidence };
  }
  if (/^(other|something else)$/.test(body) && otherOpt) {
    return { ...result, codes: [String(otherOpt.code)], other: true, confidence: recognitionConfidence };
  }

  // numbers for numeric / slider / nps
  if (q.type === "numeric" || q.type === "slider" || q.type === "nps") {
    const n = parseSpokenNumber(body);
    if (n != null) return { ...result, number: n, confidence: recognitionConfidence * (hedged || /\b(around|about|roughly|approximately|or so|something)\b/.test(raw) ? 0.6 : 1), ambiguous: hedged || /\b(around|about|roughly|approximately|or so|or something)\b/.test(raw) };
    // a scale word on an NPS/slider with labelled options falls through to label matching
  }

  // option labels: split on separators, match each piece to the closest visible option
  const pieces = body.split(/\s*(?:,|\band\b|\bplus\b|&)\s*/).map((s) => s.trim()).filter(Boolean);
  const labelsOf = (o: Option) => [o.label, optionSpokenLabel(q, o), ...(Array.isArray(o.meta?.synonyms) ? (o.meta!.synonyms as string[]) : [])].map(norm).filter(Boolean);
  const scores: number[] = [];
  const multi = q.type === "multi_select" || q.type === "multi_dropdown" || q.type === "image_select" || q.type === "matrix_multi";
  for (const piece of pieces.length ? pieces : [body]) {
    if (!piece) continue;
    let best: { o: Option; s: number } | null = null;
    for (const o of visible) for (const l of labelsOf(o)) { const s = similarity(piece, l); if (!best || s > best.s) best = { o, s }; }
    if (best && best.s >= 0.6) { result.codes.push(String(best.o.code)); scores.push(best.s); }
    else {
      // "apple samsung google" said without separators: every label that appears whole in the piece
      const inside = visible.filter((o) => labelsOf(o).some((l) => l && new RegExp(`(^| )${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(piece)));
      if (inside.length && (multi || inside.length === 1)) { for (const o of inside) { result.codes.push(String(o.code)); scores.push(0.8); } }
      else if (best && best.s >= 0.4 && pieces.length === 1) { result.codes.push(String(best.o.code)); scores.push(best.s); result.ambiguous = true; }
      else result.unmatched.push(piece);
    }
    if (!multi && result.codes.length) break;
  }
  for (const r of stripped) {
    let best: { o: Option; s: number } | null = null;
    for (const o of visible) for (const l of labelsOf(o)) { const s = similarity(r, l); if (!best || s > best.s) best = { o, s }; }
    if (best && best.s >= 0.6) result.removed.push(String(best.o.code)); else result.unmatched.push(r);
  }
  result.codes = [...new Set(result.codes)];
  const labelConf = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  result.confidence = Math.round(labelConf * recognitionConfidence * 100) / 100;
  if (result.unmatched.length && result.codes.length) result.ambiguous = true;
  return result;
}

/** "two hundred", "200", "around two hundred and fifty" → 200 / 250; null when nothing numeric was said. */
export function parseSpokenNumber(text: string): number | null {
  const t = norm(text);
  const digits = /-?\d+(?:\.\d+)?/.exec(t.replace(/,/g, ""));
  if (digits) return Number(digits[0]);
  const words = t.split(" ").filter((w) => w in NUMBER_WORDS || w === "and");
  if (!words.length) return null;
  let total = 0, current = 0;
  for (const w of words) {
    if (w === "and") continue;
    const n = NUMBER_WORDS[w];
    if (n === 100) current = (current || 1) * 100;
    else if (n === 1000) { total += (current || 1) * 1000; current = 0; }
    else current += n;
  }
  return total + current;
}

/** Read back a set of chosen options, for a confirmation prompt. */
export function readBack(q: Question, codes: string[], visible: Option[]): string {
  const labels = codes.map((c) => visible.find((o) => String(o.code) === c)).filter((o): o is Option => !!o).map((o) => optionSpokenLabel(q, o));
  if (!labels.length) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/* -------------------------------------------------------------- adaptive */

/**
 * THE FOLLOW-UP PROBE THIS QUESTION GETS, from the question's own `probe`
 * when it has one, else from the survey's adaptive settings: the interviewer
 * style and the research objective become the probe's instruction, the
 * maximum follow-ups come from the first matching programmer rule
 * ("IF Q10 = Dissatisfied THEN allow up to 2"), else the survey default.
 * Returns null when nothing applies — and a rule that says 0 is a rule.
 */
export function effectiveProbe(def: SurveyDefinition, q: Question, ctx: EvalContext, cfg?: AiConversation): ProbeConfig | null {
  const c = cfg ?? questionAi(def, q);
  if (q.probe) return q.probe;
  if (!c.enabled || c.conversation !== "adaptive" || !c.adaptive.enabled || !c.adaptive.aiGenerated) return null;
  const openEnd = q.type === "open_text" || q.type === "long_text";
  const eligible = openEnd || (c.adaptive.applyTo === "all" && ["single_select", "dropdown", "nps", "numeric", "slider", "multi_select"].includes(q.type));
  if (!eligible) return null;
  let max = c.adaptive.maxFollowUps;
  for (const rule of c.adaptive.rules) {
    if (evaluateCondition(rule.when, ctx)) { max = rule.maxFollowUps; break; }
  }
  max = Math.min(max, c.adaptive.maxDepth);
  if (max <= 0) return null;
  return {
    maxProbes: max,
    minWords: 0,
    required: c.adaptive.minFollowUps > 0,
    instruction: probeInstruction(c),
    when: undefined, stopWhen: undefined, prompt: undefined,
  };
}

/** The guardrails and style, as the instruction the probe writer receives. */
export function probeInstruction(c: AiConversation): string {
  const a = c.adaptive, i = c.interviewer;
  const parts: string[] = [];
  if (a.researchObjective?.trim()) parts.push(`Research objective: ${a.researchObjective.trim()}.`);
  if (a.stayWithinObjective) parts.push("Stay within the research objective; do not introduce unrelated topics.");
  if (a.allowedTopics.length) parts.push(`Allowed topics: ${a.allowedTopics.join(", ")}.`);
  if (a.restrictedTopics.length) parts.push(`Never ask about: ${a.restrictedTopics.join(", ")}.`);
  parts.push(`Style: ${a.probeStyle}.`);
  const avoid: string[] = [];
  if (i.avoidLeading) avoid.push("leading");
  if (i.avoidSuggestive) avoid.push("suggestive");
  if (i.avoidApproval) avoid.push("approving or disapproving");
  if (i.avoidPersuasive) avoid.push("persuasive");
  if (avoid.length) parts.push(`Avoid ${avoid.join(", ")} language; never suggest a preferred answer; preserve the respondent's own words.`);
  return parts.join(" ");
}

/** A brief, non-evaluative acknowledgement for conversational mode — never praise, never judgement. */
export function acknowledgement(c: AiConversation, n: number): string | null {
  if (!c.enabled || c.conversation === "standard" || !c.interviewer.acknowledge) return null;
  const neutral = ["Thank you.", "Noted.", "Okay.", "Got it."];
  const warm = ["Thank you.", "Thanks for that.", "Okay, thank you.", "Got it, thanks."];
  const list = c.interviewer.style === "warm" ? warm : neutral;
  return list[n % list.length];
}

/* ------------------------------------------------------------- transcripts */

export interface VoiceRecord { transcript: string; confidence?: number; repeats?: number; clarifications?: number; durationMs?: number; lang?: string }
export const voiceKey = (qid: string) => `${qid}__voice`;

/** Record what was heard for a question (beside the normalised answer), when transcripts are stored. */
export function recordVoice(answers: Record<string, unknown>, qid: string, rec: Partial<VoiceRecord>, store: boolean): void {
  if (!store) { const prev = answers[voiceKey(qid)] as VoiceRecord | undefined; answers[voiceKey(qid)] = { ...(prev ?? { transcript: "" }), ...rec, transcript: "" }; return; }
  const prev = (answers[voiceKey(qid)] as VoiceRecord | undefined) ?? { transcript: "" };
  answers[voiceKey(qid)] = { ...prev, ...rec };
}

/* -------------------------------------------------------------------- lint */

/** Problems a programmer can fix, in words. */
export function lintAiConversation(def: SurveyDefinition): string[] {
  const c = effectiveAiConversation(def);
  const out: string[] = [];
  if (!c.enabled) return out;
  if (c.conversation === "adaptive" && !c.adaptive.enabled) out.push("The conversation is set to Adaptive but adaptive follow-ups are off — nothing adapts. Turn Adaptive Follow-Up on, or choose Conversational.");
  if (c.adaptive.enabled && c.adaptive.stayWithinObjective && !c.adaptive.researchObjective?.trim()) out.push("Adaptive follow-ups are told to stay within the research objective, but no objective is written. Add one under AI → Guardrails.");
  if (c.adaptive.minFollowUps > c.adaptive.maxFollowUps) out.push("Minimum follow-ups is above the maximum.");
  if (voiceOn(c) && !c.voice.reading.question && !c.voice.reading.options) out.push("Voice is on but the voice reads neither the question nor the options — respondents will hear nothing.");
  if (voiceOn(c) && c.voice.audio.volume > 1) out.push("Volume above 100% is not applied — audio is never amplified beyond the device's level.");
  for (const q of def.questions) {
    if (q.spoken?.mode === "custom" && !q.spoken.question?.trim()) out.push(`${q.code}: spoken text is set to Custom but no custom wording is written; the displayed text will be read.`);
    if (q.spoken?.mode === "ai" && !q.spoken.aiApproved) out.push(`${q.code}: the AI-friendly spoken version is not approved yet; the displayed text will be read until it is.`);
  }
  return out;
}
