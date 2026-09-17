/**
 * THE CAPS A COMPANY SETS, AND THE WARNINGS BEFORE THEY BITE.
 *
 * §22 asks for maximum recording minutes per interview, maximum project
 * storage, maximum monthly transcription, maximum AI usage, and warnings
 * before a limit is reached — with the explicit instruction not to silently
 * allow unlimited billable media or AI.
 *
 * The arithmetic is here, away from the database and the routes, because the
 * interesting part is the WARNING, and a warning is a judgement about a
 * number rather than a number. Three states, and the middle one is the one
 * that matters: a company that discovers a cap at the moment it stops an
 * interview has been failed by the product, not by the cap.
 */

export type LimitLevel = "ok" | "approaching" | "reached";

export interface LimitStatus {
  level: LimitLevel;
  used: number;
  limit: number | null;
  remaining: number | null;
  /** 0–1 against the limit; 0 when there is none. */
  fraction: number;
  message: string | null;
}

/** Warn at four fifths: enough room left to do something about it. */
export const WARN_AT = 0.8;

export function limitStatus(args: {
  used: number;
  limit: number | null;
  /** "recording minutes", "GB of storage" — goes into the sentence. */
  unit: string;
  format?: (n: number) => string;
  warnAt?: number;
}): LimitStatus {
  const fmt = args.format ?? ((n: number) => String(Math.round(n * 100) / 100));
  const used = Math.max(0, args.used);
  if (args.limit == null || args.limit <= 0) {
    return { level: "ok", used, limit: null, remaining: null, fraction: 0, message: null };
  }
  const remaining = Math.max(0, args.limit - used);
  const fraction = Math.min(1, used / args.limit);
  if (used >= args.limit) {
    return {
      level: "reached", used, limit: args.limit, remaining: 0, fraction: 1,
      message: `This project has used its ${fmt(args.limit)} ${args.unit}. Raise the limit to carry on.`,
    };
  }
  if (fraction >= (args.warnAt ?? WARN_AT)) {
    return {
      level: "approaching", used, limit: args.limit, remaining, fraction,
      message: `${fmt(remaining)} of ${fmt(args.limit)} ${args.unit} left.`,
    };
  }
  return { level: "ok", used, limit: args.limit, remaining, fraction, message: null };
}

/**
 * How long this candidate may record for this question.
 *
 * The smallest of everything that has an opinion — the question's own limit,
 * the project's per-interview ceiling, and the platform's. Taking the minimum
 * rather than the most specific is deliberate: a question set to ten minutes
 * inside a project capped at five is a mistake, and honouring the question
 * would spend money the company said not to spend.
 *
 * The limit is told to the candidate BEFORE the camera opens. A limit
 * discovered at upload time is a limit discovered after the interview.
 */
export const PLATFORM_MAX_SECONDS = 15 * 60;

/**
 * How long ONE moderated session recording may run.
 *
 * Not a product opinion about interview length — a session can be as long
 * as the people in it want. It is the point past which the audio companion
 * (64 kbps, what actually gets transcribed) would exceed what a speech
 * provider accepts, with the same 15% margin `expectedBytes` applies. Forty
 * minutes fits with room to spare; the recorder stops itself there and says
 * so, and the researcher starts a second recording against the next question.
 * A recording that cannot be transcribed is a recording nobody can search,
 * quote or analyse, which is worse than one that stopped.
 */
export const SESSION_MAX_SECONDS = 40 * 60;

export function recordingSeconds(args: {
  questionMaxSeconds?: number | null;
  projectMaxSeconds?: number | null;
  platformMaxSeconds?: number;
}): number {
  const candidates = [
    args.questionMaxSeconds,
    args.projectMaxSeconds,
    args.platformMaxSeconds ?? PLATFORM_MAX_SECONDS,
  ].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  return candidates.length ? Math.min(...candidates) : PLATFORM_MAX_SECONDS;
}

/**
 * How big that recording will be, so a ceiling can be checked before anybody
 * speaks rather than after.
 *
 * The bitrates are the ones the recorder is configured with — 720p at 900
 * kbps video plus 96 kbps audio, which `packages/media` arrived at the hard
 * way after five-minute takes came out at 190 MB. A 15% margin, because
 * MediaRecorder targets a bitrate rather than obeying one.
 */
export const RECORDING_BITRATE = {
  video: 900_000,
  audio: 96_000,
  /** the audio-only companion track that is what actually gets transcribed */
  audioOnly: 64_000,
} as const;

export function expectedBytes(seconds: number, kind: "video" | "audio" = "video"): number {
  const bits = kind === "video"
    ? RECORDING_BITRATE.video + RECORDING_BITRATE.audio
    : RECORDING_BITRATE.audioOnly;
  return Math.ceil((bits / 8) * Math.max(0, seconds) * 1.15);
}

/** The inverse: how long fits in a byte ceiling. */
export function secondsThatFit(limitBytes: number, kind: "video" | "audio" = "video"): number {
  const bits = kind === "video"
    ? RECORDING_BITRATE.video + RECORDING_BITRATE.audio
    : RECORDING_BITRATE.audioOnly;
  const perSecond = (bits / 8) * 1.15;
  return Math.max(0, Math.floor(Math.max(0, limitBytes) / perSecond));
}

/**
 * Whether this project may start another recording at all.
 *
 * Checked before the camera opens. Every reason is separate, because
 * "storage is full" and "the transcription budget is spent" need different
 * people to do different things, and one message covering both sends
 * whoever reads it to the wrong screen.
 */
export interface ProjectUsage {
  storageBytes: number;
  recordingSeconds: number;
  transcriptionSeconds: number;
  analyses: number;
}

export interface ProjectCaps {
  maxStorageBytes: number | null;
  maxRecordingSeconds: number | null;
  maxTranscriptionSeconds: number | null;
  maxAiAnalyses: number | null;
}

const GB = 1024 ** 3;

export function projectLimits(usage: ProjectUsage, caps: ProjectCaps) {
  return {
    storage: limitStatus({
      used: usage.storageBytes, limit: caps.maxStorageBytes, unit: "GB of storage",
      format: (n) => `${Math.round((n / GB) * 100) / 100} GB`.replace("GB GB", "GB"),
    }),
    recording: limitStatus({
      used: usage.recordingSeconds, limit: caps.maxRecordingSeconds,
      unit: "recording minutes", format: (n) => String(Math.round(n / 60)),
    }),
    transcription: limitStatus({
      used: usage.transcriptionSeconds, limit: caps.maxTranscriptionSeconds,
      unit: "transcription minutes", format: (n) => String(Math.round(n / 60)),
    }),
    analysis: limitStatus({
      used: usage.analyses, limit: caps.maxAiAnalyses, unit: "AI analyses",
      format: (n) => String(Math.round(n)),
    }),
  };
}

/** The first thing that would stop a recording, or null if nothing would. */
export function blockingLimit(usage: ProjectUsage, caps: ProjectCaps): string | null {
  const l = projectLimits(usage, caps);
  for (const [, status] of Object.entries(l)) {
    if (status.level === "reached") return status.message;
  }
  return null;
}

/* ------------------------------------------------------------- retention */

export interface RetentionScope {
  media: boolean;
  transcripts: boolean;
  analysis: boolean;
  /** typed and chosen answers, and the transcript copied onto the response row */
  responses?: boolean;
  /** the behavioural events — focus, paste, timings */
  telemetry?: boolean;
  /** the person: name, email, hashed IP, user agent, roster row */
  identity?: boolean;
}

/**
 * The brief's rule for respondent data: seven days, then everything about the
 * sitting goes. New projects get this; existing projects keep what they had,
 * because a code change must not decide to destroy things.
 */
export const RESPONDENT_RETENTION_SCOPE: RetentionScope = {
  media: true, transcripts: true, analysis: false, responses: true, telemetry: true, identity: true,
};
export const RESPONDENT_RETENTION_DAYS = 7;
/** A practice recording is the person's own; it is kept a day so they can download it. */
export const MOCK_RETENTION_HOURS = 24;

export const DEFAULT_RETENTION_SCOPE: RetentionScope = {
  /* the recording is the expensive, sensitive thing and the usual reason a
     retention policy exists at all */
  media: true,
  /* a transcript is small, is what the company actually works from, and
     deleting it by default would surprise somebody who set "90 days" meaning
     "do not keep video for ever" */
  transcripts: false,
  analysis: false,
};

export const RETENTION_PRESETS = [7, 30, 90] as const;

export function retentionDue(completedAt: Date | null, retentionDays: number | null, now: Date): boolean {
  if (!completedAt || retentionDays == null || retentionDays <= 0) return false;
  return now.getTime() - completedAt.getTime() > retentionDays * 24 * 60 * 60 * 1000;
}

export function retentionRemainingDays(
  completedAt: Date | null, retentionDays: number | null, now: Date,
): number | null {
  if (!completedAt || retentionDays == null || retentionDays <= 0) return null;
  const due = completedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((due - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * How long before a retried job runs.
 *
 * Exponential with jitter, capped at an hour. Policy lives here rather than
 * in the SQL that claims a job, so it can be tested without a database — the
 * claim function takes `run_after` as an argument for exactly this reason.
 */
export function jobBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}
