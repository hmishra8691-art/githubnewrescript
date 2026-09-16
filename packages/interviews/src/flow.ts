/**
 * WHAT STATE AN INTERVIEW IS IN, AND WHAT MAY HAPPEN NEXT.
 *
 * One state machine, here, in a file with no database and no React in it, so
 * that the candidate runtime, the company dashboard, the job runners and the
 * retention sweep cannot each hold a slightly different opinion about what
 * `processing` means.
 *
 * The rule that shapes everything: **an answer is not safe until the store
 * says it is.** §9 puts it as "do not allow the user to believe an answer is
 * safely stored until upload verification has completed", and the only way to
 * keep that promise is to make it impossible to express otherwise — so the
 * response status a candidate is shown comes from this file, `stored` is
 * reachable only from `uploading`, and nothing sets it but a confirmation.
 */

export const INTERVIEW_STATUSES = [
  "invited", "started", "in_progress", "completed",
  "processing", "processed", "expired", "abandoned", "failed",
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const RESPONSE_STATUSES = [
  "pending", "recording", "uploading", "stored", "skipped", "failed",
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** What a candidate is told. Never the internal word. */
export const RESPONSE_SAY: Record<ResponseStatus, string> = {
  pending: "Not answered yet",
  recording: "Recording",
  uploading: "Saving your answer…",
  stored: "Saved",
  skipped: "Skipped",
  failed: "Not saved — you can try again",
};

/** What the company is told. */
export const INTERVIEW_SAY: Record<InterviewStatus, string> = {
  invited: "Invited",
  started: "Opened the link",
  in_progress: "Answering",
  completed: "Completed",
  processing: "Processing",
  processed: "Ready to review",
  expired: "Link expired",
  abandoned: "Started and left",
  failed: "Needs attention",
};

/**
 * The transitions that exist. Everything else is a bug, and is refused rather
 * than written — a status field that anything may set to anything is a field
 * that eventually holds every value for every reason.
 */
const INTERVIEW_NEXT: Record<InterviewStatus, readonly InterviewStatus[]> = {
  invited: ["started", "expired"],
  started: ["in_progress", "abandoned", "expired", "failed"],
  in_progress: ["completed", "abandoned", "failed"],
  /* a completed interview with nothing to process goes straight to processed */
  completed: ["processing", "processed", "failed"],
  processing: ["processed", "failed"],
  /* processing can be re-driven: a retried transcription re-enters it */
  processed: ["processing"],
  expired: [],
  /* somebody who comes back to an abandoned link resumes it */
  abandoned: ["in_progress", "expired"],
  /* a failure is recoverable — that is the whole point of recording it */
  failed: ["in_progress", "processing", "completed"],
};

const RESPONSE_NEXT: Record<ResponseStatus, readonly ResponseStatus[]> = {
  pending: ["recording", "skipped"],
  recording: ["uploading", "failed", "pending"],
  /* `stored` is reachable ONLY from `uploading`, and only on confirmation */
  uploading: ["stored", "failed"],
  /* a retake starts again from the beginning */
  stored: ["recording"],
  skipped: ["recording"],
  failed: ["recording", "uploading", "skipped"],
};

export function canAdvanceInterview(from: InterviewStatus, to: InterviewStatus): boolean {
  return from === to || (INTERVIEW_NEXT[from] ?? []).includes(to);
}

export function canAdvanceResponse(from: ResponseStatus, to: ResponseStatus): boolean {
  return from === to || (RESPONSE_NEXT[from] ?? []).includes(to);
}

export class TransitionError extends Error {
  constructor(readonly from: string, readonly to: string, what: string) {
    super(`A${what === "interview" ? "n" : ""} ${what} cannot go from ${from} to ${to}.`);
    this.name = "TransitionError";
  }
}

export function advanceInterview(from: InterviewStatus, to: InterviewStatus): InterviewStatus {
  if (!canAdvanceInterview(from, to)) throw new TransitionError(from, to, "interview");
  return to;
}

export function advanceResponse(from: ResponseStatus, to: ResponseStatus): ResponseStatus {
  if (!canAdvanceResponse(from, to)) throw new TransitionError(from, to, "response");
  return to;
}

/** An interview nobody is going to touch again. */
export function isFinal(status: InterviewStatus): boolean {
  return status === "processed" || status === "expired";
}

/** The company may open the recordings. */
export function isReviewable(status: InterviewStatus): boolean {
  return status === "completed" || status === "processing" || status === "processed";
}

/* ------------------------------------------------------------- progress */

export interface ResponseProgress {
  questionId: string;
  status: ResponseStatus;
  required: boolean;
}

export interface Progress {
  total: number;
  /** Confirmed present in the store. Not "sent". */
  stored: number;
  skipped: number;
  outstanding: number;
  /** Every required question is answered or deliberately skipped. */
  complete: boolean;
  /** 0–1, counting only what is actually safe. */
  fraction: number;
}

/**
 * How far through the candidate is.
 *
 * `stored` counts confirmations and nothing else. A response that is
 * `uploading` is not progress — it is a promise — and a progress bar that
 * counts promises is how somebody closes a tab believing they have finished.
 */
export function progressOf(responses: readonly ResponseProgress[]): Progress {
  const total = responses.length;
  const stored = responses.filter((r) => r.status === "stored").length;
  const skipped = responses.filter((r) => r.status === "skipped").length;
  const outstanding = responses.filter(
    (r) => r.required && r.status !== "stored" && r.status !== "skipped",
  ).length;
  return {
    total, stored, skipped, outstanding,
    complete: total > 0 && outstanding === 0,
    fraction: total === 0 ? 0 : (stored + skipped) / total,
  };
}

/**
 * May this candidate record this question again?
 *
 * `retries` counts takes DISCARDED, not takes made — the first recording is
 * not a retry. So `maxRetries: 0` means one take, which is what a researcher
 * setting it to zero means, and a product that read it as "no recordings"
 * would be unusable.
 */
export function canRetake(retries: number, maxRetries: number): boolean {
  return retries < Math.max(0, maxRetries);
}

/** A question the candidate is allowed to pass on. */
export function canSkip(required: boolean): boolean {
  return !required;
}

/* --------------------------------------------------------- abandonment */

/**
 * When a started interview stops being "in progress" and becomes "abandoned".
 *
 * Long, deliberately. A candidate whose laptop sleeps, who takes a call, who
 * loses wifi for twenty minutes, is not gone — and an interview marked
 * abandoned under them is one they may not be allowed to resume. Two hours of
 * silence is somebody who is not coming back; twenty minutes is somebody
 * getting a glass of water.
 */
export const ABANDON_AFTER_MS = 2 * 60 * 60 * 1000;

export function isAbandoned(lastSeenAt: Date | null, now: Date, afterMs = ABANDON_AFTER_MS): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() > afterMs;
}

export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

/**
 * What the candidate may do with this link right now.
 *
 * One answer, so the page that renders the link and the route that accepts a
 * recording cannot disagree — which is the failure that lets somebody record
 * five minutes into an interview the server will refuse to save.
 */
export type LinkVerdict =
  | { ok: true; resuming: boolean }
  | { ok: false; reason: "expired" | "finished" | "unknown"; message: string };

export function linkVerdict(args: {
  status: InterviewStatus;
  expiresAt: Date | null;
  now: Date;
}): LinkVerdict {
  if (isExpired(args.expiresAt, args.now) && !isReviewable(args.status)) {
    return {
      ok: false, reason: "expired",
      message: "This interview link has expired. Please ask the company for a new one.",
    };
  }
  if (args.status === "expired") {
    return {
      ok: false, reason: "expired",
      message: "This interview link has expired. Please ask the company for a new one.",
    };
  }
  if (isReviewable(args.status)) {
    return {
      ok: false, reason: "finished",
      message: "This interview has already been completed. Thank you — there is nothing more to do.",
    };
  }
  return { ok: true, resuming: args.status === "in_progress" || args.status === "abandoned" };
}
