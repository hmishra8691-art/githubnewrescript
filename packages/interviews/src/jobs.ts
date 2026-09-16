import { jobBackoffMs } from "./limits.js";

/**
 * THE QUEUE'S POLICY, WITH NO DATABASE IN IT.
 *
 * `interview_jobs` and `rescript_interview_claim_job` have existed since 0030
 * and nothing has ever written to them or claimed from them. This is the half
 * that decides what happens — what to retry, when, and what to stop retrying —
 * so it can be tested without a queue, and so the two bad answers are hard to
 * reach:
 *
 *   **Retrying for ever.** An unreadable recording sent to a paid provider
 *   every thirty seconds until somebody notices the bill. `attempts <
 *   max_attempts` is enforced in SQL, but the interesting case is a failure
 *   that will NEVER succeed — a deleted object, a file the provider refuses —
 *   where even three attempts is two too many.
 *
 *   **Giving up on a blip.** A 503 from a provider is not a broken recording,
 *   and a job that fails permanently on one is a transcript a researcher has
 *   to ask a human to rescue.
 *
 * So failures are CLASSIFIED rather than counted. The SQL function's comment
 * says it: "backoff is policy, and policy belongs in TypeScript where it can
 * be tested without a database" — `finish_job` takes the `run_after` this
 * module computes rather than inventing one.
 *
 * ## Why there is one queue and not two
 *
 * 0030 also shipped `rescript_interview_claim_transcript`, which claims a
 * transcript row directly. Using both would mean two attempt counters for one
 * piece of work, and two answers to "has this been tried too often". The JOB
 * is the unit of retry; the transcript row is state. `claim_transcript` stays
 * for a future path that drives a single transcript by hand.
 */

export const JOB_KINDS = [
  "transcription",
  "analysis",
  "media_processing",
  "export",
  "retention",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(v: unknown): v is JobKind {
  return typeof v === "string" && (JOB_KINDS as readonly string[]).includes(v);
}

export const JOB_STATUSES = ["queued", "running", "complete", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  kind: JobKind;
  subjectId: string | null;
  attempts: number;
  maxAttempts: number;
  payload?: Record<string, unknown>;
}

/* ------------------------------------------------------- failures */

/**
 * Why a job failed, in the only two categories that change what happens next.
 *
 * `permanent` is a claim about the FUTURE — trying again cannot help — and it
 * is deliberately hard to earn. Everything unrecognised is transient, because
 * the cost of retrying a doomed job three times is small and the cost of
 * abandoning a recoverable one is a researcher chasing a support ticket.
 */
export type FailureKind = "transient" | "permanent";

export interface JobFailure {
  kind: FailureKind;
  reason: string;
}

/**
 * Patterns that mean "this will never work".
 *
 * Each is a state of the WORLD, not of the network: the object is gone, the
 * provider has looked at the file and refused it, the thing the job is about
 * has been deleted. A timeout, a 5xx, a rate limit and a connection reset are
 * all absent on purpose.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /\bnot found\b/i,
  /\bno such (key|object|file)\b/i,
  /\bdoes not exist\b/i,
  /\bdeleted\b/i,
  /\bunsupported (file|format|media|codec)\b/i,
  /\binvalid (file|audio|format)\b/i,
  /\bfile is (empty|corrupt)/i,
  /\btoo large\b/i,
  /\bexceeds the maximum\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
];

/**
 * An HTTP status, when there is one, decides before the words do.
 *
 * 4xx is the provider saying the REQUEST is wrong, which a retry will not fix.
 * The exceptions are the ones that are about timing rather than content: 408,
 * 425 and 429 are all "not now", and 409 is a race.
 */
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);

export function classifyFailure(reason: string, status?: number | null): JobFailure {
  const text = (reason || "").trim() || "the job failed without saying why";

  if (typeof status === "number" && Number.isFinite(status)) {
    if (TRANSIENT_STATUSES.has(status)) return { kind: "transient", reason: text };
    if (status >= 400 && status < 500) return { kind: "permanent", reason: text };
    /* 5xx and anything else: the provider had a bad moment, not a bad file */
    return { kind: "transient", reason: text };
  }

  for (const p of PERMANENT_PATTERNS) {
    if (p.test(text)) return { kind: "permanent", reason: text };
  }
  return { kind: "transient", reason: text };
}

/* ------------------------------------------------- what happens next */

export type JobDecision =
  | { status: "complete" }
  /** try again after `runAfter`; `attemptsLeft` is what remains after this one */
  | { status: "failed"; runAfter: Date; retrying: true; attemptsLeft: number; reason: string }
  /** stop — either no attempts left, or trying again cannot help */
  | { status: "failed"; retrying: false; reason: string; permanent: boolean };

/**
 * What to do with a job that has just been tried.
 *
 * `attempts` is the value AFTER the claim incremented it, which is what
 * `rescript_interview_claim_job` returns — so a job on its third of three has
 * `attempts === 3` and no retries left.
 *
 * A permanent failure stops immediately regardless of attempts remaining. That
 * is the whole reason for classifying: three attempts at a recording the
 * provider has already refused is three charges for the same "no".
 */
export function decideAfterFailure(
  job: Pick<Job, "attempts" | "maxAttempts">,
  failure: JobFailure,
  now: Date = new Date(),
  random: () => number = Math.random,
): JobDecision {
  if (failure.kind === "permanent") {
    return { status: "failed", retrying: false, reason: failure.reason, permanent: true };
  }
  const attemptsLeft = Math.max(0, job.maxAttempts - job.attempts);
  if (attemptsLeft <= 0) {
    return { status: "failed", retrying: false, reason: failure.reason, permanent: false };
  }
  return {
    status: "failed",
    retrying: true,
    attemptsLeft,
    reason: failure.reason,
    runAfter: new Date(now.getTime() + jobBackoffMs(job.attempts, random)),
  };
}

/**
 * The key that makes enqueueing twice free.
 *
 * `interview_jobs.idempotency_key` is unique, so the second insert loses. That
 * is what turns "a retried HTTP request must not create a second transcription
 * job" from a hope into a constraint — and it is why the key is derived from
 * WHAT the work is about rather than from when it was asked for.
 *
 * An `attempt` suffix exists for the one case where a second job for the same
 * subject is legitimate: a human asking for a redo after a permanent failure.
 * Nothing automatic passes it.
 */
export function jobKey(kind: JobKind, subjectId: string, attempt = 0): string {
  return attempt > 0 ? `${kind}:${subjectId}:${attempt}` : `${kind}:${subjectId}`;
}

/* ---------------------------------------------------- a drain pass */

export interface DrainBudget {
  /** wall-clock the runner may use, well under the platform's function limit */
  msAvailable: number;
  /** how many jobs one pass may take, so a backlog cannot starve one invocation */
  maxJobs: number;
}

/**
 * Whether to claim another job.
 *
 * A serverless invocation that is killed mid-job leaves it `running` until the
 * stale-claim timeout reclaims it — survivable, but it wastes an attempt and
 * delays the work by minutes. So the runner stops while it still has room for
 * a whole job rather than starting one it probably cannot finish.
 *
 * `longestJobMs` is the caller's honest estimate for the kind of work it does.
 * Guessing low here is the failure that matters: it is what fills the queue
 * with abandoned `running` rows.
 */
export function shouldClaimAnother(
  budget: DrainBudget,
  done: number,
  elapsedMs: number,
  longestJobMs: number,
): boolean {
  if (done >= budget.maxJobs) return false;
  return budget.msAvailable - elapsedMs > longestJobMs;
}

/** A one-line summary of a pass, for the cron's own log and its JSON reply. */
export interface DrainReport {
  claimed: number;
  completed: number;
  retrying: number;
  abandoned: number;
  warnings: string[];
}

export function emptyReport(): DrainReport {
  return { claimed: 0, completed: 0, retrying: 0, abandoned: 0, warnings: [] };
}

export function noteDecision(report: DrainReport, decision: JobDecision): DrainReport {
  if (decision.status === "complete") report.completed++;
  else if (decision.retrying) report.retrying++;
  else {
    report.abandoned++;
    report.warnings.push(
      decision.permanent
        ? `gave up (will not retry): ${decision.reason}`
        : `gave up (out of attempts): ${decision.reason}`,
    );
  }
  return report;
}
