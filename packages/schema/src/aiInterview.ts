import { z } from "zod";

/**
 * AI-MODERATED INTERVIEWS (2026-10-22) — how an interview guide (`qualStudy`,
 * kind "interview") is run by an AI moderator, one participant at a time,
 * asynchronously, from a public link: which modes the participant may use
 * (text chat, voice, voice + camera), how long it should take, how deep the
 * moderator probes each question, which objectives it must cover, in which
 * languages, the screener and quotas, the persona, the stimuli shown, the
 * thank-you / incentive / redirect, and the hard cost caps.
 *
 * It is CONFIGURATION, so it lives on the definition beside the guide
 * (`qualStudy.aiModeration`) — versioned, cloned, undone and edited by
 * Intelligent Mode through the gate (`configure_ai_interviews`). What the
 * interviews PRODUCE (participants, sessions, turns, costs, flags) is data and
 * lives in its own tables (migration 0069); a launched study keeps a SNAPSHOT
 * of the guide and this configuration, so editing the guide during fieldwork
 * never changes an interview already running.
 *
 * Consent text is NOT here: it is the guide's (`qualStudy.consent`), and a
 * study cannot be launched without a consent statement.
 */

/** text = chat; voice = spoken turns (speech-to-text in, speech out); video = voice + the participant's camera recorded per answer */
export const AI_INTERVIEW_MODES = ["text", "voice", "video"] as const;
export const AiInterviewMode = z.enum(AI_INTERVIEW_MODES);
export type AiInterviewMode = z.infer<typeof AiInterviewMode>;

/** none = ask and move on; light = up to 1 follow-up when an answer is thin; deep = up to 3, for reasons, examples, feelings */
export const AI_PROBING_DEPTHS = ["none", "light", "deep"] as const;
export const AiProbingDepth = z.enum(AI_PROBING_DEPTHS);
export type AiProbingDepth = z.infer<typeof AiProbingDepth>;

export const AiProbingRule = z.object({
  /** a guide question id (`s2q1`) */
  questionId: z.string(),
  depth: AiProbingDepth,
  /** overrides the depth's default (none 0, light 1, deep 3) */
  maxFollowUps: z.number().int().min(0).max(5).optional(),
});
export type AiProbingRule = z.infer<typeof AiProbingRule>;

export const AiScreenerOption = z.object({
  label: z.string(),
  /** false = choosing it screens the participant out */
  qualifies: z.boolean().default(true),
  /** the participant segment (quota cell) the answer puts them in */
  segment: z.string().optional(),
});
export type AiScreenerOption = z.infer<typeof AiScreenerOption>;

export const AiScreenerQuestion = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(["single", "multi", "number"]).default("single"),
  options: z.array(AiScreenerOption).default([]),
  /** number: qualifies inside [min, max] */
  min: z.number().optional(),
  max: z.number().optional(),
  /** copied from this survey question (its text and options) when the screener was configured */
  fromQuestionId: z.string().optional(),
});
export type AiScreenerQuestion = z.infer<typeof AiScreenerQuestion>;

export const AiQuota = z.object({ segment: z.string(), target: z.number().int().nonnegative() });
export type AiQuota = z.infer<typeof AiQuota>;

/** what the guide's `stimuli` names point at: an image or a video (https or the project's asset), or a concept text */
export const AiStimulus = z.object({
  name: z.string(),
  kind: z.enum(["image", "video", "text"]),
  url: z.string().optional(),
  text: z.string().optional(),
  alt: z.string().optional(),
});
export type AiStimulus = z.infer<typeof AiStimulus>;

export const AiPersona = z.object({
  name: z.string().default("Alex"),
  tone: z.enum(["warm", "neutral", "professional", "casual"]).default("warm"),
  /** a short note on manner ("speaks plainly, avoids jargon") — never instructions about the participant */
  style: z.string().optional(),
});
export type AiPersona = z.infer<typeof AiPersona>;

export const AiModeration = z.object({
  enabled: z.boolean().default(true),
  modes: z.array(AiInterviewMode).min(1).default(["text"]),
  /** the interview's time budget; the guide's duration when absent */
  targetMinutes: z.number().int().min(3).max(120).optional(),
  /** a hard cap on moderator turns per interview */
  maxTurns: z.number().int().min(4).max(200).default(40),
  defaultProbing: AiProbingDepth.default("light"),
  probing: z.array(AiProbingRule).default([]),
  /** objectives the moderator must cover; the guide's objectives when empty */
  objectives: z.array(z.string()).default([]),
  /** BCP-47 codes the participant may choose; empty = the participant's own language (any the provider handles) */
  languages: z.array(z.string()).default([]),
  screener: z.array(AiScreenerQuestion).default([]),
  quotas: z.array(AiQuota).default([]),
  /** completed interviews wanted; the link closes itself at this number */
  targetCompletes: z.number().int().positive().optional(),
  /** voice / video: storing the recording is optional for the participant, or required to take part */
  recordingConsent: z.enum(["optional", "required"]).default("optional"),
  incentive: z.string().optional(),
  thankYouMessage: z.string().optional(),
  /** where the participant goes after the thank-you (a panel's return link) — https only */
  redirectUrl: z.string().optional(),
  persona: AiPersona.default({}),
  stimuli: z.array(AiStimulus).default([]),
  /** hard cap on AI spend per interview (USD, customer charge); the interview finishes on the guide's scripted questions past it */
  costCapUsd: z.number().positive().max(50).default(1.5),
  /** hard cap on AI spend for the whole study (USD); the link stops taking new participants past it */
  studyBudgetUsd: z.number().positive().optional(),
  /** a nudge after this many seconds without an answer */
  silenceSeconds: z.number().int().min(20).max(600).default(120),
});
export type AiModeration = z.infer<typeof AiModeration>;

/** the follow-ups a depth allows when no rule overrides it */
export const PROBE_DEPTH_FOLLOW_UPS: Record<AiProbingDepth, number> = { none: 0, light: 1, deep: 3 };
