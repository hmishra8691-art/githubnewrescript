import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * THE AI CONVERSATIONAL SURVEY ENGINE — one configuration.
 *
 * ## Why one object
 *
 * "Voice Survey", "Conversational Survey" and "Adaptive Survey" were offered
 * as three things to choose between, when each is a SETTING of the same
 * interviewer: how the respondent interacts (text, voice, both), how the
 * conversation behaves (standard, conversational, adaptive), and what the
 * voice sounds like and reads. A programmer should think "I am making an AI
 * conversational survey — how should respondents interact with it?", then
 * configure. This object is that configuration.
 *
 * ## Where it lives
 *
 *   branding.aiConversation   the survey-wide interviewer — part of the brand
 *                             experience, so a client's voice, accent and
 *                             personality travel with their logo and colours,
 *                             and a brand profile can be reused across surveys
 *   question.ai               per-question overrides (a partial of the same
 *                             shape) — one question read with options, another
 *                             question-only, one with a deeper follow-up
 *   question.spoken           what the voice SAYS for this question when it
 *                             differs from what is displayed: a spoken version
 *                             of the text, spoken labels for options,
 *                             pronunciations, or pre-recorded audio
 *
 * ## What it is NOT
 *
 * It is not a question type and it never changes what the survey asks. Every
 * behaviour here is a presentation of the programmed survey: display logic,
 * skip logic, masking, validation, quotas, loops and piping remain
 * authoritative, and the AI cannot show a hidden question, accept an invalid
 * answer or store anything but a value the question could take. The one
 * place the AI produces WORDS a respondent sees is the follow-up probe, and
 * that is already a Condition-gated overlay (`ProbeConfig`) that this object
 * merely configures survey-wide.
 *
 * ## Legacy
 *
 * `branding.layout.presentation` and `branding.layout.voice` predate this
 * object. They are still read: the engine's `effectiveAiConversation()`
 * derives an AiConversation from them when this object is absent, and the
 * Studio keeps them in step when this object is edited, so an older runtime
 * build behaves as before. New code reads only the effective config.
 */

/* --------------------------------------------------------------- voice */

export const VOICE_GENDERS = ["female", "male", "neutral"] as const;
export const VOICE_AGE_STYLES = ["young_adult", "adult", "mature_adult", "elderly"] as const;
/** creative voices — only where the provider has such voices; never an imitation of a real or copyrighted character */
export const VOICE_CHARACTERS = ["professional_narrator", "friendly_character", "energetic_presenter", "calm_narrator", "casual_conversational", "cartoon_style", "animated_style"] as const;
export const VOICE_PERSONALITIES = ["professional", "friendly", "warm", "conversational", "energetic", "calm", "neutral", "serious", "empathetic"] as const;

export const VoiceProfile = z.object({
  /** how the voice presents — a style, not an identity */
  gender: z.enum(VOICE_GENDERS).default("neutral"),
  ageStyle: z.enum(VOICE_AGE_STYLES).default("adult"),
  character: z.enum(VOICE_CHARACTERS).optional(),
  personality: z.enum(VOICE_PERSONALITIES).default("neutral"),
  /** free-text personality guidance for providers that accept it */
  customPersonality: z.string().optional(),
  /** provider-specific voice id (advanced); blank = chosen from the profile and locale */
  voiceId: z.string().optional(),
  /** used when the primary voice is unavailable; the survey continues rather than fails */
  fallbackVoiceId: z.string().optional(),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

export const VoiceLocale = z.object({
  /** ISO 3166-1 alpha-2, e.g. "IN" */
  country: z.string().optional(),
  /** ISO 639-1, e.g. "en"; "auto" = detect from the respondent */
  language: z.string().default("auto"),
  /** BCP-47 dialect / accent, e.g. "en-IN"; "match" = the respondent's locale */
  dialect: z.string().default("match"),
  /** a second language the conversation may switch to */
  secondaryLanguage: z.string().optional(),
  /** single: keep one language; auto: follow the respondent's preference; respondent: they may switch */
  switching: z.enum(["single", "auto", "respondent"]).default("single"),
});
export type VoiceLocale = z.infer<typeof VoiceLocale>;

export const VoiceAudio = z.object({
  /** 0.5–2, 1 = normal */
  rate: z.number().min(0.5).max(2).default(1),
  /** 0–2, 1 = the voice's own pitch (where the provider supports pitch) */
  pitch: z.number().min(0).max(2).default(1),
  /** 0–1; never amplified beyond the device's own level */
  volume: z.number().min(0).max(1).default(1),
  emphasis: z.enum(["none", "light", "moderate"]).default("none"),
});
export type VoiceAudio = z.infer<typeof VoiceAudio>;

export const VoicePauses = z.object({
  afterQuestionMs: z.number().int().min(0).max(5000).default(1000),
  beforeOptionsMs: z.number().int().min(0).max(5000).default(500),
  betweenOptionsMs: z.number().int().min(0).max(5000).default(400),
  afterAnswerMs: z.number().int().min(0).max(5000).default(700),
  betweenRowsMs: z.number().int().min(0).max(5000).default(700),
  betweenColumnsMs: z.number().int().min(0).max(5000).default(300),
});
export type VoicePauses = z.infer<typeof VoicePauses>;

export const OPTION_READING_MODES = ["all", "first_n", "grouped", "on_request", "none"] as const;
export const GRID_READING_MODES = ["question_first", "row_by_row", "respondent_driven"] as const;

export const VoiceReading = z.object({
  question: z.boolean().default(true),
  options: z.boolean().default(false),
  instructions: z.boolean().default(false),
  validationErrors: z.boolean().default(false),
  helpText: z.boolean().default(false),
  /** piped and calculated text are part of the question text once resolved; off = say the token's label instead */
  piped: z.boolean().default(true),
  calculated: z.boolean().default(true),
  /** how a list of options is spoken when `options` is on */
  optionMode: z.enum(OPTION_READING_MODES).default("all"),
  firstN: z.number().int().min(1).max(50).default(5),
  /** options per spoken group in "grouped" mode */
  groupSize: z.number().int().min(2).max(20).default(5),
  /** special options */
  speakOther: z.boolean().default(true),
  speakNone: z.boolean().default(true),
  /** grids */
  gridMode: z.enum(GRID_READING_MODES).default("question_first"),
  gridRows: z.boolean().default(true),
  gridColumns: z.boolean().default(true),
  allowChooseRow: z.boolean().default(true),
});
export type VoiceReading = z.infer<typeof VoiceReading>;

export const VoiceInteraction = z.object({
  /** take spoken answers and commands at all (off: the voice reads, the respondent answers on screen) */
  listen: z.boolean().default(true),
  /** "next", "back", "repeat", "select Apple", … */
  navigationCommands: z.boolean().default(true),
  /** "repeat" / "I didn't understand" → the question again, or an offer to explain the options */
  repeat: z.boolean().default(true),
  clarification: z.boolean().default(true),
  /** below this recognition confidence the answer is confirmed, never stored silently */
  confidenceThreshold: z.number().min(0).max(1).default(0.75),
  /** "Apple, I think" → "Did you mean Apple?" */
  clarifyAmbiguous: z.boolean().default(true),
  /** read back a multi-select before storing it: "I have Apple and Samsung. Is that correct?" */
  confirmMultiSelect: z.boolean().default(true),
  /** keep the raw transcript beside the normalised answer */
  transcript: z.enum(["store", "dont_store"]).default("store"),
  /** captions / a visible transcript of what the voice said, for accessibility */
  captions: z.boolean().default(true),
});
export type VoiceInteraction = z.infer<typeof VoiceInteraction>;

export const VoiceConfig = z.object({
  /** TTS/STT adapter key: "browser" (Web Speech), or a registered provider */
  provider: z.string().default("browser"),
  /** a named preset this was started from — informational */
  preset: z.string().optional(),
  profile: VoiceProfile.default({}),
  locale: VoiceLocale.default({}),
  audio: VoiceAudio.default({}),
  pauses: VoicePauses.default({}),
  reading: VoiceReading.default({}),
  interaction: VoiceInteraction.default({}),
  /** displayed term → how to say it; applies to question text, options and rows without changing them */
  pronunciations: z.record(z.string()).default({}),
});
export type VoiceConfig = z.infer<typeof VoiceConfig>;

/* ------------------------------------------------------------ the AI */

export const PROBE_STYLES = ["neutral", "warm", "professional"] as const;

export const AdaptiveConfig = z.object({
  enabled: z.boolean().default(false),
  minFollowUps: z.number().int().min(0).max(5).default(0),
  maxFollowUps: z.number().int().min(0).max(5).default(2),
  /** how deep a chain of follow-ups may go on one question */
  maxDepth: z.number().int().min(1).max(5).default(3),
  probeStyle: z.enum(PROBE_STYLES).default("neutral"),
  /** let the provider write follow-ups (off = only fixed wordings on questions) */
  aiGenerated: z.boolean().default(true),
  stayWithinObjective: z.boolean().default(true),
  researchObjective: z.string().optional(),
  allowedTopics: z.array(z.string()).default([]),
  restrictedTopics: z.array(z.string()).default([]),
  /** which questions get follow-ups when none is configured on the question: open ends only, or any answered question */
  applyTo: z.enum(["open_ends", "all"]).default("open_ends"),
  /** programmer rules: when this holds, allow up to N follow-ups (0 = none) — evaluated with the Universal Logic Engine */
  rules: z.array(z.object({ id: z.string().optional(), when: Condition, maxFollowUps: z.number().int().min(0).max(5), label: z.string().optional() })).default([]),
});
export type AdaptiveConfig = z.infer<typeof AdaptiveConfig>;

export const InterviewerConfig = z.object({
  style: z.enum(PROBE_STYLES).default("neutral"),
  avoidLeading: z.boolean().default(true),
  avoidSuggestive: z.boolean().default(true),
  avoidApproval: z.boolean().default(true),
  avoidPersuasive: z.boolean().default(true),
  /** acknowledge answers briefly ("Thank you.") in conversational mode — never evaluatively */
  acknowledge: z.boolean().default(true),
});
export type InterviewerConfig = z.infer<typeof InterviewerConfig>;

export const RephraseConfig = z.object({
  enabled: z.boolean().default(false),
  /** a locked question is never rephrased, whatever the survey says */
  requireApproval: z.boolean().default(true),
  maxVariation: z.enum(["low", "medium", "high"]).default("low"),
});
export type RephraseConfig = z.infer<typeof RephraseConfig>;

export const INTERACTION_MODES = ["text", "voice", "text_voice"] as const;
export const CONVERSATION_MODES = ["standard", "conversational", "adaptive"] as const;

export const AiConversation = z.object({
  /** whether the interviewer is on at all — off = the survey exactly as before this object existed */
  enabled: z.boolean().default(false),
  interaction: z.enum(INTERACTION_MODES).default("text"),
  conversation: z.enum(CONVERSATION_MODES).default("standard"),
  adaptive: AdaptiveConfig.default({}),
  interviewer: InterviewerConfig.default({}),
  rephrase: RephraseConfig.default({}),
  voice: VoiceConfig.default({}),
  /** a named brand profile this configuration came from — informational */
  brandProfile: z.string().optional(),
});
export type AiConversation = z.infer<typeof AiConversation>;

/**
 * PER-QUESTION OVERRIDES — the same shape, every field optional, merged over
 * the survey's configuration by the engine. Nothing here can turn a setting
 * on that the survey's guardrails forbid (a restricted topic stays
 * restricted; a locked wording stays locked).
 */
export const AiQuestionOverride = z.object({
  interaction: z.enum(INTERACTION_MODES).optional(),
  conversation: z.enum(CONVERSATION_MODES).optional(),
  adaptive: AdaptiveConfig.partial().optional(),
  reading: VoiceReading.partial().optional(),
  audio: VoiceAudio.partial().optional(),
  pauses: VoicePauses.partial().optional(),
  interaction_: VoiceInteraction.partial().optional(),
  /** the voice, when this question should sound different (a second interviewer, a character) */
  profile: VoiceProfile.partial().optional(),
});
export type AiQuestionOverride = z.infer<typeof AiQuestionOverride>;

/**
 * WHAT THE VOICE SAYS for one question, when it differs from what is shown.
 * The displayed text and the stored labels never change.
 */
export const SpokenScript = z.object({
  /** exact: the displayed text; ai: an AI-friendly version (approved below); custom: `question` */
  mode: z.enum(["exact", "ai", "custom"]).default("exact"),
  /** the custom spoken question text (piping allowed) */
  question: z.string().optional(),
  /** an AI-friendly version proposed by the provider, kept only once a programmer approved it */
  aiVersion: z.string().optional(),
  aiApproved: z.boolean().default(false),
  /** lock: this question is never rephrased */
  locked: z.boolean().default(false),
  /** option code → spoken label */
  options: z.record(z.string()).default({}),
  /** row code → spoken label */
  rows: z.record(z.string()).default({}),
  /** displayed term → pronunciation, for this question only */
  pronunciations: z.record(z.string()).default({}),
  /** pre-recorded audio for the question (URL); when set it plays instead of TTS for the question text */
  audioUrl: z.string().optional(),
  /** how to say the instruction, if not the instruction itself */
  instruction: z.string().optional(),
});
export type SpokenScript = z.infer<typeof SpokenScript>;
