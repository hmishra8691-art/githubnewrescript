import type { InterviewAnswer, InterviewWatch, Question } from "@rescript/schema";

/**
 * THE VIDEO INTERVIEW RESPONSE MODEL — one place that decides what a
 * half-finished interview means.
 *
 * A `video_interview` answer is built up across a single page turn, in
 * stages, and it has to survive a refresh at every one of them. The
 * respondent arrives, watches a clip, records an answer, waits for a
 * transcript, and only then may the page turn. Four different things can be
 * true at once — video part-watched, audio recorded but not uploaded,
 * uploaded but not transcribed — and every surface that has an opinion about
 * the question needs the same answer to "where are we".
 *
 * So the state lives here and nowhere else. The renderer draws it, the
 * validator gates on it, the export flattens it, and none of them
 * re-implements it. That is the same rule the rest of this engine follows:
 * a question's shape is asked, never guessed from whichever field happens to
 * be populated.
 *
 * ## Why watched seconds and not `currentTime`
 *
 * `video.currentTime >= duration - tolerance` is the condition the brief
 * suggests, and on its own it is bypassed by dragging the scrubber to the
 * end — which fires `ended` just as honestly as watching does. The platform
 * already learned this once, in the watch-time variant: seconds are SUMMED
 * FROM PLAYBACK, so a jump larger than one tick is a seek and adds nothing.
 * `completed` here means both: the player reached the end AND the seconds
 * actually accumulated. Either alone is a lie.
 *
 * ## Why a missing transcript is not a broken interview
 *
 * Transcription is a provider call, and every provider call in this platform
 * degrades rather than blocks. If no provider is configured, or the wallet
 * refuses, or the request times out, the clip is still recorded, still
 * uploaded, still the answer — `transcript.source` is `"none"` and the
 * respondent moves on. A qualitative interview that cannot be completed
 * because a transcription service was slow is worse than one with a
 * transcript to be generated later.
 */

/** Seconds of slack when deciding the player reached the end. */
export const INTERVIEW_END_TOLERANCE = 0.35;

/**
 * How much of the clip must genuinely have played for `completed` to be
 * honest. Not 100%: a browser that drops the last frames, a clip whose
 * reported duration is slightly long, and a respondent who pauses over the
 * final second are all ordinary, and failing them would be a gate nobody
 * can pass. Below this, reaching the end was not watching.
 */
export const INTERVIEW_WATCH_FLOOR = 0.9;

/**
 * The response states, in the order an interview passes through them. The
 * brief names these; they are spelled once, here, and every surface reads
 * them from here.
 */
export type InterviewState =
  | "VIDEO_NOT_STARTED"
  | "VIDEO_PLAYING"
  | "VIDEO_COMPLETED"
  | "WAITING_FOR_ANSWER"
  | "RECORDING"
  | "PROCESSING"
  | "TRANSCRIBING"
  | "ANSWER_COMPLETED"
  | "ERROR";

/** What the live UI knows that the stored answer cannot. */
export interface InterviewLive {
  /** the player is playing right now */
  playing?: boolean;
  /** the microphone is live right now */
  recording?: boolean;
  /** the clip is being uploaded */
  uploading?: boolean;
  /** the clip is with the transcription provider */
  transcribing?: boolean;
  /** something failed in a way the respondent must be told about */
  error?: string | null;
}

export function isInterviewAnswer(v: unknown): v is InterviewAnswer {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const watchOf = (v: unknown): InterviewWatch =>
  (isInterviewAnswer(v) && v.watch) || {};

/* ------------------------------------------------------------- the settings */

/**
 * Whether the question demands the video be watched through. Default ON —
 * this is the type's whole reason to exist — but a preset may turn it off,
 * and a question with no video cannot demand one be watched.
 */
export function requiresWatch(q: Question): boolean {
  if (!q.settings.interviewVideo?.url) return false;
  return q.settings.requireWatch !== false;
}

/** Whether a spoken answer is required. Default ON. */
export function requiresAudioAnswer(q: Question): boolean {
  return q.settings.requireAudioAnswer !== false;
}

/**
 * Whether to transcribe. Saving no transcript makes transcribing pointless,
 * so `saveTranscript: false` turns it off rather than paying a provider for
 * something that is immediately discarded.
 */
export function transcribes(q: Question): boolean {
  if (q.settings.saveTranscript === false) return false;
  return q.settings.transcribeAnswer !== false;
}

/** Whether to keep the recording. Default ON. */
export function savesAudio(q: Question): boolean {
  return q.settings.saveAnswerAudio !== false;
}

/** Whether the progress bar has a handle the respondent can drag. Default OFF. */
export function allowsSeek(q: Question): boolean {
  return q.settings.allowSeek === true;
}

/** Re-records permitted. `undefined` means the default of 3; 0 means one take. */
export function retakeLimit(q: Question): number {
  const n = q.settings.maxRetakes;
  return Number.isFinite(n) && (n as number) >= 0 ? Math.floor(n as number) : 3;
}

/* --------------------------------------------------------------- the gates */

/**
 * Has the researcher's video genuinely been watched through?
 *
 * Both halves must hold: the player reported the end, and the seconds add up.
 * A clip with no duration (a stream, a broken header) cannot be measured, so
 * the `ended` event is all there is — refusing it would strand the
 * respondent on a question they cannot complete.
 */
export function videoCompleted(q: Question, v: unknown): boolean {
  if (!requiresWatch(q)) return true;
  const w = watchOf(v);
  if (!w.completed) return false;
  const d = w.durationSeconds ?? 0;
  if (!(d > 0)) return true;
  const watched = w.watchedSeconds ?? 0;
  return watched >= d * INTERVIEW_WATCH_FLOOR - INTERVIEW_END_TOLERANCE;
}

/** Is there a recorded answer stored? */
export function hasAudioAnswer(v: unknown): boolean {
  const a = isInterviewAnswer(v) ? v.audio : undefined;
  return !!a && typeof a.url === "string" && a.url.length > 0;
}

/** Is there transcript text? */
export function hasTranscript(v: unknown): boolean {
  const t = isInterviewAnswer(v) ? v.transcript : undefined;
  return !!t && typeof t.text === "string" && t.text.trim().length > 0;
}

/**
 * Is the answer complete enough to move on?
 *
 * Deliberately NOT gated on the transcript. The brief's own condition —
 * `transcription_processing === false` — is about the request being
 * finished, not about it having succeeded, and it is enforced live by the
 * renderer (which knows whether a request is in flight) rather than here
 * (which only ever sees what was stored). What this must guarantee is the
 * thing that cannot be recovered later: the recording is safely uploaded.
 * A transcript can always be generated again from a stored clip; a clip
 * that was never uploaded is gone.
 */
export function interviewAnswered(q: Question, v: unknown): boolean {
  if (!videoCompleted(q, v)) return false;
  if (!requiresAudioAnswer(q)) return true;
  if (savesAudio(q)) return hasAudioAnswer(v);
  /* audio discarded by configuration — the transcript is the whole answer */
  return hasTranscript(v);
}

/**
 * Where the interview is, given what is stored and what the UI knows it is
 * doing. `live` is optional: with nothing passed this reports the state of a
 * stored answer, which is what the validator and the data screens see.
 */
export function interviewState(q: Question, v: unknown, live: InterviewLive = {}): InterviewState {
  if (live.error) return "ERROR";
  if (live.recording) return "RECORDING";
  if (live.uploading) return "PROCESSING";
  if (live.transcribing) return "TRANSCRIBING";

  const w = watchOf(v);
  if (requiresWatch(q) && !videoCompleted(q, v)) {
    if (live.playing) return "VIDEO_PLAYING";
    return w.started ? "VIDEO_PLAYING" : "VIDEO_NOT_STARTED";
  }
  if (interviewAnswered(q, v)) return "ANSWER_COMPLETED";
  /* the gate has opened; VIDEO_COMPLETED is the instant it does, and
     WAITING_FOR_ANSWER is every moment after, which is what the UI shows */
  return hasAudioAnswer(v) || !requiresWatch(q) ? "WAITING_FOR_ANSWER" : "VIDEO_COMPLETED";
}

/**
 * Problems worth telling the respondent about, beyond "you have not answered".
 * Length bounds only — everything else is a gate rather than a complaint.
 */
export function interviewProblems(q: Question, v: unknown): string[] {
  const out: string[] = [];
  if (!isInterviewAnswer(v)) return out;
  const secs = v.audio?.durationSeconds;
  if (typeof secs === "number" && Number.isFinite(secs) && hasAudioAnswer(v)) {
    const min = q.settings.minAnswerSeconds;
    const max = q.settings.maxAnswerSeconds;
    if (min != null && secs + 0.5 < min) out.push(`Please record at least ${formatSeconds(min)}.`);
    if (max != null && secs - 0.5 > max) out.push(`Please keep your answer under ${formatSeconds(max)}.`);
  }
  return out;
}

/* ------------------------------------------------------- textual forms */

/**
 * The one-column textual form: the transcript. It is what a piped `{{Q5}}`
 * should show, what a text comparison in logic reads, and what the base
 * export column holds — a URL would be none of those things to a human.
 */
export function interviewText(v: unknown): string {
  if (!isInterviewAnswer(v)) return "";
  return (v.transcript?.text ?? "").trim();
}

/** Whole seconds as words a respondent reads: "3 seconds", "2 minutes". */
export function formatSeconds(s: number): string {
  if (s >= 120) return `${Math.round(s / 60)} minutes`;
  if (s >= 60) return "1 minute";
  return `${Math.round(s)} second${Math.round(s) === 1 ? "" : "s"}`;
}

/**
 * Fold one playback tick into a watch record.
 *
 * `delta` is the wall-clock advance the player reported since the last tick.
 * A delta larger than `maxTick` is a seek, not watching: it is discounted
 * and counted, so a researcher can see that somebody tried. Written as a
 * pure function so the renderer, the tests and any future replay all agree
 * on what a tick means.
 */
export function foldWatchTick(
  prev: InterviewWatch | undefined,
  tick: { delta: number; position: number; duration: number; maxTick?: number },
): InterviewWatch {
  const w: InterviewWatch = { ...(prev ?? {}) };
  const maxTick = tick.maxTick ?? 1.5;
  w.started = true;
  w.durationSeconds = tick.duration > 0 ? tick.duration : w.durationSeconds;
  if (tick.delta > 0 && tick.delta <= maxTick) {
    w.watchedSeconds = round2((w.watchedSeconds ?? 0) + tick.delta);
  } else if (tick.delta > maxTick) {
    w.seeks = (w.seeks ?? 0) + 1;
  }
  const d = w.durationSeconds ?? 0;
  w.percent = d > 0 ? Math.min(100, round2(((w.watchedSeconds ?? 0) / d) * 100)) : 0;
  const atEnd = d > 0 && tick.position >= d - INTERVIEW_END_TOLERANCE;
  if (atEnd && (w.watchedSeconds ?? 0) >= d * INTERVIEW_WATCH_FLOOR - INTERVIEW_END_TOLERANCE) {
    w.completed = true;
  }
  return w;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
