/**
 * WHERE MEDIA GOES, HOW BIG IT MAY BE, AND HOW IT IS RECORDED.
 *
 * Four routes used to answer these questions four times — four copies of the
 * same bucket-existence dance, four sanitisers, four path templates, four
 * return envelopes. This file answers them once, in pure functions, so that a
 * fifth kind of media is a row in a table below rather than a fifth copy.
 *
 * Everything here is deliberately dependency-free and synchronous: a test can
 * assert the whole policy without a database, a browser, or a network.
 */

/** The kinds of object this platform stores. One row per kind, below. */
export type MediaKind =
  | "question_video"       // the researcher asking, on camera
  | "question_audio"       // the audio track of that recording, for transcription
  | "answer_audio"         // the respondent answering out loud
  | "answer_upload"        // any other respondent file answer
  | "localization_audio";  // a recorded or generated reading of a question

export interface MediaKindSpec {
  readonly bucket: string;
  /** Hard ceiling for one object of this kind. */
  readonly maxBytes: number;
  /** How long a signed URL for this kind lives. */
  readonly signedSeconds: number;
  /** Accepted top-level media type, or null to accept anything. */
  readonly accept: "video" | "audio" | null;
  /** Whether this kind is transcribed when it lands. */
  readonly transcribed: boolean;
}

const YEAR = 60 * 60 * 24 * 365;

/**
 * Two limits per bucket, one rule each — the reasoning the video route
 * already carried, now applied to every kind rather than re-argued per route.
 *
 * The video ceiling is 150 MB rather than the old 200 MB because the recorder
 * now caps its own bitrate: ten minutes at the constraints in
 * `RECORDING_CONSTRAINTS` is about 97 MB, so 150 MB is headroom for a
 * high-motion take, not an invitation to upload a film.
 *
 * The audio ceilings are 25 MB because that is what speech-to-text providers
 * accept. A clip larger than the provider will read is not a clip that needs
 * a bigger bucket; it is a clip that needed a lower bitrate.
 */
export const MEDIA_KINDS: Record<MediaKind, MediaKindSpec> = {
  question_video:     { bucket: "rescript-video",   maxBytes: 150 * 1024 * 1024, signedSeconds: YEAR * 5, accept: "video", transcribed: false },
  question_audio:     { bucket: "rescript-video",   maxBytes: 25 * 1024 * 1024,  signedSeconds: YEAR * 5, accept: "audio", transcribed: true },
  answer_audio:       { bucket: "rescript-uploads", maxBytes: 25 * 1024 * 1024,  signedSeconds: YEAR,     accept: "audio", transcribed: true },
  answer_upload:      { bucket: "rescript-uploads", maxBytes: 25 * 1024 * 1024,  signedSeconds: YEAR,     accept: null,    transcribed: false },
  localization_audio: { bucket: "rescript-audio",   maxBytes: 20 * 1024 * 1024,  signedSeconds: YEAR * 5, accept: "audio", transcribed: false },
};

export const MEDIA_BUCKETS: readonly string[] =
  Array.from(new Set(Object.values(MEDIA_KINDS).map((s) => s.bucket)));

/**
 * The largest file a speech-to-text provider will read. Checked before the
 * call rather than after, because a provider rejection costs a round trip and
 * tells the researcher nothing they can act on.
 */
export const STT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * How the browser is told to record.
 *
 * This is the actual fix for "exceed limit". The old recorder asked for
 * `{video: true}` and whatever bitrate the browser felt like — on a 1080p
 * webcam that is 2.5–5 Mbps, so five minutes was 95–190 MB held in the tab as
 * an array of Blobs AND a concatenated copy AND a third copy inside a
 * FormData. It did not fail because a limit was too low. It failed because
 * nothing had ever said how big a recording should be.
 *
 * 720p at 900 kbps is a person talking to a camera, which is what this
 * feature records. Five minutes is ~36 MB, which matters: a Supabase project
 * has a GLOBAL upload limit of 50 MB by default, and no bucket may exceed it.
 * A five-minute take has to fit inside that with room to spare, because a
 * variable-bitrate encoder overshoots on a take with movement in it.
 *
 * `maxSeconds` is the ceiling this package would like. The real one is
 * whatever storage will accept — `secondsThatFit` works it out from the limit
 * the server discovers, and the recorder uses the smaller of the two.
 */
export const RECORDING_CONSTRAINTS = {
  video: { width: 1280, height: 720, frameRate: 30 },
  videoBitsPerSecond: 900_000,
  audioBitsPerSecond: 96_000,
  /** The audio-only companion track, recorded for transcription. */
  answerAudioBitsPerSecond: 64_000,
  /** Flush a chunk this often so nothing is held for the whole take. */
  timesliceMs: 5_000,
  /** Stop on its own here. Ten minutes, so "at least five" has real headroom. */
  maxSeconds: 600,
} as const;

/** Bytes a take of this many seconds should be, give or take. */
export function expectedVideoBytes(seconds: number): number {
  const bits = RECORDING_CONSTRAINTS.videoBitsPerSecond + RECORDING_CONSTRAINTS.audioBitsPerSecond;
  return Math.round((bits / 8) * Math.max(0, seconds));
}

/** Bytes the audio companion of a take this long should be, give or take. */
export function expectedAudioBytes(seconds: number): number {
  return Math.round((RECORDING_CONSTRAINTS.answerAudioBitsPerSecond / 8) * Math.max(0, seconds));
}

/**
 * How long a take of this kind fits inside a given ceiling.
 *
 * The fifteen percent held back is for the encoder, not for us: MediaRecorder
 * targets a bitrate rather than obeying one, and a take with movement in it
 * runs over. A recorder that stops at exactly the limit produces a file that
 * is over it.
 */
export function secondsThatFit(kind: MediaKind, limitBytes: number): number {
  const perSecond = kind === "question_video"
    ? (RECORDING_CONSTRAINTS.videoBitsPerSecond + RECORDING_CONSTRAINTS.audioBitsPerSecond) / 8
    : RECORDING_CONSTRAINTS.answerAudioBitsPerSecond / 8;
  const usable = Math.max(0, limitBytes) * 0.85;
  return Math.max(30, Math.min(RECORDING_CONSTRAINTS.maxSeconds, Math.floor(usable / perSecond)));
}

const EXTENSIONS: Array<[RegExp, string]> = [
  [/webm/, "webm"], [/mp4|m4a|m4v/, "mp4"], [/quicktime|mov/, "mov"],
  [/ogg|opus/, "ogg"], [/mpeg|mp3/, "mp3"], [/wav/, "wav"],
];

/** A file extension for a content type, defaulting to the container browsers record. */
export function extensionFor(mimeType: string | undefined, fallback = "webm"): string {
  const m = (mimeType ?? "").toLowerCase();
  return EXTENSIONS.find(([re]) => re.test(m))?.[1] ?? fallback;
}

/**
 * One path segment, safe for object storage and for a URL.
 *
 * Empty in, `"_"` out: a segment that collapses to nothing would silently
 * shorten the path and put the object somewhere other than where the row
 * says it is.
 */
export function safeSegment(value: string | null | undefined, max = 80): string {
  const s = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    /* every run of two or more dots goes: one dot is an extension, two are a
       path traversal, and no legitimate name needs the difference explained */
    .replace(/\.{2,}/g, "_")
    .replace(/^\./, "_")
    .slice(0, max);
  return s || "_";
}

export interface PathParts {
  surveyId: string;
  questionId?: string | null;
  sessionId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  /** Injectable so a test does not depend on the clock. */
  now?: number;
}

/**
 * Where an object of this kind lives.
 *
 * Researcher media is keyed by SURVEY, respondent media by SESSION — not an
 * inconsistency but the two different owners. Both are now also rows in
 * `media_objects`, which is what finally makes both reachable for deletion;
 * before that, the survey-keyed buckets were the trivially enumerable ones
 * and were the ones nothing ever cleaned.
 */
export function mediaPath(kind: MediaKind, parts: PathParts): string {
  const stamp = parts.now ?? Date.now();
  const ext = extensionFor(parts.mimeType ?? undefined, kind === "question_video" ? "webm" : "webm");
  const name = safeSegment(parts.fileName || `${kind}.${ext}`);
  const question = safeSegment(parts.questionId ?? "question");
  switch (kind) {
    case "question_video":
    case "question_audio":
      return `${safeSegment(parts.surveyId)}/${question}/${stamp}-${name}`;
    case "answer_audio":
    case "answer_upload":
      return `${safeSegment(parts.sessionId ?? "session")}/${question}/${stamp}-${name}`;
    case "localization_audio":
      return `${safeSegment(parts.surveyId)}/${question}/${stamp}-${name}`;
  }
}

export interface SizeVerdict {
  ok: boolean;
  /** A sentence for the researcher, not a status code. */
  message?: string;
}

/**
 * Whether an object of this size may be stored.
 *
 * Checked in the browser BEFORE the upload starts as well as on the server,
 * because the old arrangement only discovered the problem after the whole
 * file had been sent — which on a serverless host meant the request died at
 * the platform's body limit long before the route's own careful message could
 * run.
 */
export function withinLimit(kind: MediaKind, bytes: number, ceilingBytes?: number): SizeVerdict {
  const limit = Math.min(MEDIA_KINDS[kind].maxBytes, ceilingBytes && ceilingBytes > 0 ? ceilingBytes : Infinity);
  if (bytes <= limit) return { ok: true };
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  return {
    ok: false,
    message: `That recording is ${mb(bytes)} and this project's storage accepts ${mb(limit)}. Record a shorter take, or upload a file saved at a lower quality.`,
  };
}

/** Whether a content type is the kind of media this slot takes. */
export function acceptsType(kind: MediaKind, mimeType: string | undefined): SizeVerdict {
  const accept = MEDIA_KINDS[kind].accept;
  if (!accept) return { ok: true };
  if (new RegExp(`^${accept}/`).test(mimeType ?? "")) return { ok: true };
  return {
    ok: false,
    message: `That file is ${mimeType || "an unknown type"} — please choose ${accept === "video" ? "a video" : "an audio"} file.`,
  };
}

/**
 * The stages a recording passes through, in order.
 *
 * Named here rather than in the components so that the client's log lines,
 * the server's log lines and the tests all say the same words. When a
 * researcher reports "it failed", the answer should be which of these was the
 * last one reached.
 */
export const MEDIA_STAGES = [
  "recording_started",
  "recording_completed",
  "blob_created",
  "upload_url_issued",
  "upload_started",
  "upload_completed",
  "storage_confirmed",
  "audio_extracted",
  "transcription_queued",
  "transcription_started",
  "transcription_completed",
] as const;

export type MediaStage = (typeof MEDIA_STAGES)[number];

/** The five words the interface uses for a transcript, and nothing else. */
export type TranscriptStatus = "waiting" | "processing" | "transcribing" | "completed" | "failed";

export const TRANSCRIPT_SAY: Record<TranscriptStatus, string> = {
  waiting: "Waiting to transcribe",
  processing: "Fetching the audio",
  transcribing: "Transcribing",
  completed: "Transcript ready",
  failed: "Transcription failed",
};

/** True while a transcript is still expected to change on its own. */
export function transcriptPending(status: TranscriptStatus | undefined): boolean {
  return status === "waiting" || status === "processing" || status === "transcribing";
}
