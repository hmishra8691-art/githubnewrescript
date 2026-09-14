/**
 * ONE TRANSCRIPTION, RUN TO A CONCLUSION.
 *
 * The provider call and the billing hold differ between the Studio (a
 * researcher's question, charged to the project) and the runtime (a
 * respondent's answer, charged to the session). Everything else — claiming
 * the job so two runners cannot both pay for it, reading the stored bytes,
 * refusing a clip the provider cannot read, and writing down which of those
 * happened — is the same work, so it is written once here and the two
 * differences are arguments.
 *
 * The contract this exists to keep: a transcription that fails leaves a row
 * saying so, with the audio still in the bucket and an attempt count that has
 * not been exhausted. That is what makes "Retry" a button rather than an
 * apology.
 */
import { STT_MAX_BYTES, type MediaStage, type TranscriptStatus } from "./plan.js";
import {
  claimTranscript, markTranscript, readObject, transcriptFor,
  type MediaDb, type TranscriptRow,
} from "./store.js";

export interface TranscriptionResult {
  text: string;
  language?: string;
  model: string;
  durationSeconds?: number;
}

/**
 * What the provider did, not merely whether it worked.
 *
 * A `null` here would be six different problems wearing the same face — no
 * credentials, no such model, rate-limited, unreadable audio, no speech, a
 * timeout — each with a different fix, and the researcher reading the result
 * is the person who has to apply it.
 */
export type TranscribeResult =
  | { ok: true; value: TranscriptionResult }
  | { ok: false; reason: string; status?: number };

export interface TranscribeFn {
  (bytes: Uint8Array, opts: {
    mimeType?: string;
    fileName?: string;
    language?: string;
    durationSeconds?: number;
  }): Promise<TranscribeResult>;
}

/**
 * Whatever the caller's billing arrangement is, reduced to: hold for this
 * many seconds, run this, settle. A refusal is a first-class outcome rather
 * than an exception — an empty wallet must not read as a broken pipeline.
 */
export interface MeteredRun {
  <T>(seconds: number, fn: () => Promise<T>): Promise<{ value: T } | { refused: string }>;
}

export interface RunnerDeps {
  transcribe: TranscribeFn;
  metered: MeteredRun;
  /** BCP-47 hint, or undefined to let the provider detect. */
  language?: string;
  provider?: string;
  log?: (stage: MediaStage | "transcription_failed", detail: Record<string, unknown>) => void;
  staleSeconds?: number;
  maxAttempts?: number;
}

export interface RunOutcome {
  status: TranscriptStatus;
  text?: string | null;
  error?: string | null;
  attempts: number;
  /** True when this call did the work, false when it found someone else had it. */
  ran: boolean;
}

function outcomeOf(row: TranscriptRow | null, ran: boolean): RunOutcome {
  if (!row) return { status: "failed", error: "no transcription job for this recording", attempts: 0, ran };
  return { status: row.status, text: row.text, error: row.error, attempts: row.attempts, ran };
}

/**
 * Drive one recording's transcription as far as it will go.
 *
 * Safe to call repeatedly: a job someone else is running, or one that has
 * used all its attempts, is not claimed, and the caller is told the state it
 * is actually in rather than being given a second charge for the same audio.
 */
export async function runTranscription(db: MediaDb, mediaId: string, deps: RunnerDeps): Promise<RunOutcome> {
  const log = deps.log ?? (() => {});

  const job = await claimTranscript(db, mediaId, {
    staleSeconds: deps.staleSeconds,
    maxAttempts: deps.maxAttempts,
  });
  if (!job) return outcomeOf(await transcriptFor(db, mediaId), false);

  log("transcription_started", { mediaId, jobId: job.id, attempt: job.attempts, bucket: job.bucket, path: job.path });

  let bytes: Uint8Array;
  try {
    bytes = await readObject(db, job.bucket, job.path);
  } catch (e) {
    const message = (e as Error).message;
    await markTranscript(db, job.id, "failed", { error: message });
    log("transcription_failed", { mediaId, jobId: job.id, at: "read_object", error: message });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  if (bytes.length > STT_MAX_BYTES) {
    /*
     * Said here rather than discovered at the provider, because the provider
     * says "413" and the researcher needs to know that the fix is a shorter
     * clip. The video's audio companion is recorded at 64 kbps precisely so
     * this cannot happen to an ordinary interview.
     */
    const error = `That recording is ${Math.round(bytes.length / 1024 / 1024)} MB of audio and the transcription service accepts ${STT_MAX_BYTES / 1024 / 1024} MB. Record a shorter take.`;
    await markTranscript(db, job.id, "failed", { error });
    log("transcription_failed", { mediaId, jobId: job.id, at: "size_check", bytes: bytes.length });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  await markTranscript(db, job.id, "transcribing");

  const seconds = job.duration_seconds && job.duration_seconds > 0
    ? Number(job.duration_seconds)
    : Math.max(1, Math.round(bytes.length / 16_000));

  let ran: { value: TranscribeResult } | { refused: string };
  try {
    ran = await deps.metered(seconds, () => deps.transcribe(bytes, {
      mimeType: job.mime_type ?? undefined,
      fileName: job.path.split("/").pop(),
      language: deps.language,
      durationSeconds: seconds,
    }));
  } catch (e) {
    const message = (e as Error).message;
    await markTranscript(db, job.id, "failed", { error: message });
    log("transcription_failed", { mediaId, jobId: job.id, at: "provider", error: message });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  if ("refused" in ran) {
    await markTranscript(db, job.id, "failed", { error: ran.refused });
    log("transcription_failed", { mediaId, jobId: job.id, at: "billing", error: ran.refused });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  const outcome = ran.value;
  if (!outcome.ok) {
    /* the provider's own diagnosis, kept verbatim — it knows better than we do */
    await markTranscript(db, job.id, "failed", { error: outcome.reason });
    log("transcription_failed", { mediaId, jobId: job.id, at: "provider", status: outcome.status, error: outcome.reason });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  const result = outcome.value;
  if (!result.text.trim()) {
    const error = "The transcription service heard no speech in this recording. The audio is saved — check that it is audible, then try again.";
    await markTranscript(db, job.id, "failed", { error });
    log("transcription_failed", { mediaId, jobId: job.id, at: "empty_result" });
    return outcomeOf(await transcriptFor(db, mediaId), true);
  }

  await markTranscript(db, job.id, "completed", {
    text: result.text.trim(),
    language: result.language ?? deps.language ?? null,
    model: result.model,
    provider: deps.provider ?? null,
    error: null,
  });
  log("transcription_completed", { mediaId, jobId: job.id, characters: result.text.trim().length, seconds });
  return outcomeOf(await transcriptFor(db, mediaId), true);
}

/**
 * One line per stage, in one shape, so that "where did it fail" is a grep.
 *
 * The stages are the ones named in `plan.ts`; a failure report is the last
 * stage that appears for a given recording id.
 */
export function stageLogger(scope: string): (stage: MediaStage | "transcription_failed", detail: Record<string, unknown>) => void {
  return (stage, detail) => {
    try {
      console.info(`[rescript:media] ${stage}`, JSON.stringify({ scope, ...detail }));
    } catch {
      console.info(`[rescript:media] ${stage}`, scope);
    }
  };
}
