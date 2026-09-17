import "server-only";
import {
  buildScorecard, classifyFailure, decideAfterFailure, emptyReport, isJobKind, jobKey,
  noteDecision, planAnalysisPrompt, readClaims, shouldClaimAnother,
  summariseRequirements, verifyEvidence,
  type DrainBudget, type DrainReport, type Job, type JobDecision, type JobKind,
} from "@rescript/interviews";
import { completeJson, transcribe } from "@rescript/ai";
import { supabaseAdmin } from "./admin";
import { meteredAnalysis, meteredTranscription } from "./metering";
import { storageOrResponse } from "./storage";

/**
 * THE THING THAT MAKES THE QUEUE A QUEUE.
 *
 * `interview_jobs`, `rescript_interview_claim_job` and
 * `rescript_interview_finish_job` have existed since 0030 and had no caller at
 * all — zero references anywhere in TypeScript. Transcript rows were created
 * at `waiting` and waited for ever. This is the runner they were waiting for.
 *
 * ## What it is careful about
 *
 * **Claiming is atomic.** `for update skip locked` in the SQL means two
 * invocations of the cron overlapping — which will happen, because a slow pass
 * and a ten-minute schedule eventually meet — cannot both take the same job.
 *
 * **Stopping early is deliberate.** A serverless function killed mid-job
 * leaves the row `running` until the stale-claim timeout reclaims it: a wasted
 * attempt and minutes of delay. So the loop stops while it still has room for
 * a whole job rather than starting one it probably cannot finish.
 *
 * **Failures are classified, not counted.** A provider that has refused a file
 * will refuse it twice more; a 503 is not a broken recording. The policy is in
 * `@rescript/interviews` where it is tested without a database, and this file
 * only carries out what it decides.
 */

/**
 * What a speech-to-text provider will accept.
 *
 * The same 25 MB `packages/media` uses, restated rather than imported: this
 * app does not otherwise depend on the survey product's media package, and one
 * constant is a poor reason to couple two products whose storage layers are
 * deliberately separate. If a provider's limit changes, both move.
 */
const STT_MAX_BYTES = 25 * 1024 * 1024;

/** The platform kills the function at 300s; the runner gives itself less. */
const BUDGET: DrainBudget = { msAvailable: 240_000, maxJobs: 25 };

/** An honest ceiling for one transcription, matching the provider timeout in `@rescript/ai`. */
const LONGEST_JOB_MS = 60_000;

interface JobRow {
  id: string;
  kind: string;
  subject_id: string | null;
  customer_id: string;
  project_id: string;
  interview_id: string | null;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
}

export type Handler = (job: Job, row: JobRow) => Promise<void>;

/* ------------------------------------------------------------ enqueue */

/**
 * Put work on the queue, at most once.
 *
 * `idempotency_key` is unique, so a second insert for the same subject loses
 * rather than duplicating — which is what turns "a retried request must not
 * create a second transcription job" from a hope into a constraint. The
 * conflict is swallowed on purpose: the caller asked for the work to be
 * queued, and it is.
 */
export async function enqueue(args: {
  kind: JobKind;
  subjectId: string;
  customerId: string;
  projectId: string;
  interviewId?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  attempt?: number;
}): Promise<{ queued: boolean }> {
  const db = supabaseAdmin();
  const { error } = await db.from("interview_jobs").insert({
    customer_id: args.customerId,
    project_id: args.projectId,
    interview_id: args.interviewId ?? null,
    kind: args.kind,
    subject_id: args.subjectId,
    payload: args.payload ?? {},
    priority: args.priority ?? 100,
    idempotency_key: jobKey(args.kind, args.subjectId, args.attempt ?? 0),
  });

  if (error) {
    /* 23505 is the unique index doing its job — the work is already queued */
    if ((error as { code?: string }).code === "23505") return { queued: false };
    console.warn("[rescript:interviews] could not enqueue",
      JSON.stringify({ kind: args.kind, subject: args.subjectId, error: error.message }));
    return { queued: false };
  }
  return { queued: true };
}

/* -------------------------------------------------------------- drain */

export async function drain(
  kinds: JobKind[] = ["transcription"],
  now: () => number = Date.now,
): Promise<DrainReport> {
  const db = supabaseAdmin();
  const report = emptyReport();
  const startedAt = now();

  for (const kind of kinds) {
    while (shouldClaimAnother(BUDGET, report.claimed, now() - startedAt, LONGEST_JOB_MS)) {
      const { data, error } = await db.rpc("rescript_interview_claim_job", {
        p_kind: kind,
        p_stale_seconds: 300,
      });
      if (error) {
        report.warnings.push(`could not claim a ${kind} job: ${error.message}`);
        break;
      }
      const row = (Array.isArray(data) ? data[0] : data) as JobRow | null;
      /* the function returns an empty row when there is nothing due */
      if (!row?.id) break;

      report.claimed++;
      const decision = await runOne(row);
      noteDecision(report, decision);
      await finish(row.id, decision);
    }
  }

  return report;
}

async function runOne(row: JobRow): Promise<JobDecision> {
  const job: Job = {
    id: row.id,
    kind: isJobKind(row.kind) ? row.kind : "transcription",
    subjectId: row.subject_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: row.payload ?? {},
  };

  const handler = HANDLERS[job.kind];
  if (!handler) {
    /*
     * A kind nobody implements is permanent by construction: retrying will
     * not make the handler appear, and a job that cycles for ever is how a
     * queue fills up silently.
     */
    return {
      status: "failed", retrying: false, permanent: true,
      reason: `no handler for job kind "${job.kind}"`,
    };
  }

  try {
    await handler(job, row);
    return { status: "complete" };
  } catch (e) {
    const err = e as Error & { status?: number };
    const failure = classifyFailure(err.message ?? String(e), err.status ?? null);
    const decision = decideAfterFailure(job, failure);
    console.warn("[rescript:interviews] job failed", JSON.stringify({
      job: row.id, kind: job.kind, attempts: job.attempts,
      permanent: failure.kind === "permanent",
      retrying: decision.status === "failed" && decision.retrying,
      reason: failure.reason.slice(0, 200),
    }));
    return decision;
  }
}

async function finish(jobId: string, decision: JobDecision): Promise<void> {
  const db = supabaseAdmin();
  await db.rpc("rescript_interview_finish_job", {
    p_job: jobId,
    p_status: decision.status === "complete" ? "complete" : "failed",
    p_error: decision.status === "complete" ? null : decision.reason.slice(0, 500),
    /*
     * `run_after` is only moved for a retry. A job that has given up keeps its
     * old one, so the `attempts < max_attempts` guard is what stops it rather
     * than a date far in the future that somebody would have to understand.
     */
    p_run_after: decision.status === "failed" && decision.retrying
      ? decision.runAfter.toISOString()
      : null,
  });
}

/* ------------------------------------------------------- transcription */

/**
 * Transcribe one recording.
 *
 * Throws on failure rather than returning a verdict, so the classifier above
 * sees the provider's own words and its HTTP status — which is what decides
 * between "try again in a minute" and "this file will never work".
 */
const transcription: Handler = async (job, row) => {
  const db = supabaseAdmin();
  const mediaId = job.subjectId;
  if (!mediaId) throw new Error("the job names no recording");

  const { data: media, error } = await db
    .from("interview_media")
    .select("id, customer_id, project_id, interview_id, response_id, kind, storage_key, mime_type, file_size, duration_seconds, upload_status, deleted_at")
    .eq("id", mediaId)
    .maybeSingle();
  if (error) throw new Error(`could not read the recording: ${error.message}`);
  if (!media || media.deleted_at) throw new Error("that recording does not exist");
  if (media.upload_status !== "stored") {
    throw new Error(`the recording is ${media.upload_status}, not stored`);
  }

  const { data: project } = await db
    .from("interview_projects")
    .select("id, customer_id, settings, max_transcription_seconds")
    .eq("id", media.project_id)
    .maybeSingle();

  const { data: interview } = await db
    .from("interviews")
    .select("id, is_test, status")
    .eq("id", media.interview_id ?? "")
    .maybeSingle();

  const store = storageOrResponse();
  if ("response" in store) throw new Error("storage is not configured on this installation");

  /*
   * Size first, before the bytes are pulled. A 40 MB video handed to a
   * provider that accepts 25 is a download, a failure and a wasted attempt —
   * and this is a PERMANENT condition, which the classifier recognises from
   * the words "too large".
   */
  if (Number(media.file_size ?? 0) > STT_MAX_BYTES) {
    throw new Error(
      `the recording is too large to transcribe (${Math.round(Number(media.file_size) / 1e6)} MB, limit ${Math.round(STT_MAX_BYTES / 1e6)} MB)`,
    );
  }

  await db.from("interview_transcripts")
    .update({ status: "transcribing", started_at: new Date().toISOString(), error: null })
    .eq("media_id", mediaId);

  let bytes: Uint8Array;
  try {
    bytes = await store.storage.read(media.storage_key);
  } catch (e) {
    const err = new Error(`could not read the recording from storage: ${(e as Error).message}`);
    (err as Error & { status?: number }).status = (e as { status?: number }).status;
    throw err;
  }

  const seconds = Number(media.duration_seconds ?? 0) ||
    Math.max(1, Math.round(bytes.length / 16_000));

  /*
   * Diarization is asked for on a MODERATED recording and not on a candidate's
   * own answer. A person alone in front of a camera is one voice, and asking a
   * provider to separate speakers in it invites it to invent a second.
   */
  const moderated = media.kind === "session_video" || media.kind === "session_audio";

  const outcome = await meteredTranscription(
    {
      customerId: media.customer_id,
      projectId: media.project_id,
      environment: interview?.is_test ? "TEST" : "LIVE",
    },
    {
      seconds,
      operation: moderated ? "transcribe_session"
        : media.kind === "question_prompt" ? "transcribe_prompt" : "transcribe_answer",
      /* the same key for the same recording, so a retried settle is a no-op */
      idempotencyKey: `interview-stt:${mediaId}`,
    },
    () => transcribe(bytes, {
      mimeType: media.mime_type ?? "audio/webm",
      fileName: `${mediaId}.webm`,
      durationSeconds: seconds,
      segments: true,
      diarize: moderated,
    }),
  );

  if (outcome.refused) {
    /*
     * A wallet refusal is not a broken recording and must not burn attempts:
     * the transcript goes back to waiting, plainly explained, and a retry after
     * the wallet is topped up will find it.
     */
    await db.from("interview_transcripts")
      .update({ status: "waiting", error: outcome.refused.slice(0, 500) })
      .eq("media_id", mediaId);
    const err = new Error(outcome.refused);
    (err as Error & { status?: number }).status = 402;
    throw err;
  }

  const result = outcome.value;
  if (!result || !result.ok) {
    throw new Error(result?.ok === false ? result.reason : "the transcription provider said nothing");
  }

  const t = result.value;
  const speakerCount = t.speakerCount ?? 0;

  const { error: writeError } = await db.from("interview_transcripts").update({
    status: "completed",
    text: t.text,
    segments: t.segments ?? null,
    language: t.language ?? null,
    provider: process.env.AI_STT_API_URL ? "openai-compatible" : "fake",
    model: t.model,
    billed_seconds: outcome.billedSeconds ?? seconds,
    diarized: !!t.diarized,
    speaker_count: t.diarized ? speakerCount : null,
    completed_at: new Date().toISOString(),
    error: null,
  }).eq("media_id", mediaId);
  if (writeError) throw new Error(`the transcript could not be saved: ${writeError.message}`);

  await db.from("interview_media")
    .update({ processing_status: "complete" })
    .eq("id", mediaId);

  /*
   * A candidate's answer is the transcript, so it is copied onto the response
   * row the way `0028_transcript_is_the_answer` does for surveys. A moderated
   * recording has no response row and nothing to copy it to.
   */
  if (media.response_id && !moderated) {
    await db.from("interview_responses")
      .update({ answer_text: t.text })
      .eq("id", media.response_id);
  }

  /*
   * ANALYSIS FOLLOWS THE LAST TRANSCRIPT, not the completion of the interview.
   *
   * Queueing it when the candidate finishes would analyse whatever happened to
   * be transcribed by then — usually nothing, since transcription is
   * asynchronous and the candidate leaves first. So the check is here, after
   * each transcript, and is simply "is there anything left to transcribe": the
   * last one to finish queues the analysis, and the idempotency key means the
   * other five that finish at almost the same moment queue nothing.
   */
  if (media.interview_id) await maybeQueueAnalysis(media.interview_id);

  void project;
};

/**
 * Queue the analysis if this interview has nothing left to transcribe.
 *
 * Never throws: an analysis that was not queued is recoverable by hand, and a
 * transcription marked failed because the FOLLOW-UP could not be queued is a
 * recording transcribed twice for no reason.
 */
async function maybeQueueAnalysis(interviewId: string): Promise<void> {
  try {
    const db = supabaseAdmin();

    const { data: interview } = await db
      .from("interviews")
      .select("id, project_id, customer_id, status")
      .eq("id", interviewId)
      .maybeSingle();
    /* an interview still being answered is not ready to be read */
    if (!interview) return;
    if (interview.status !== "completed" && interview.status !== "processing") return;

    const { data: outstanding } = await db
      .from("interview_transcripts")
      .select("media_id")
      .eq("interview_id", interviewId)
      .in("status", ["waiting", "processing", "transcribing"])
      .limit(1);
    if ((outstanding ?? []).length) return;

    await db.from("interviews")
      .update({ status: "processing" })
      .eq("id", interviewId)
      .eq("status", "completed");

    await enqueue({
      kind: "analysis",
      subjectId: interviewId,
      customerId: interview.customer_id as string,
      projectId: interview.project_id as string,
      interviewId,
      priority: 200,
    });
  } catch (e) {
    console.warn("[rescript:interviews] could not queue analysis",
      JSON.stringify({ interview: interviewId, error: (e as Error).message }));
  }
}


/* ------------------------------------------------------------ analysis */

/**
 * READ ONE INTERVIEW'S TRANSCRIPTS AGAINST ITS REQUIREMENTS.
 *
 * `verifyEvidence` has been built and tested since Phase 1 with no production
 * caller at all — 309 lines enforcing the rule that every finding points at
 * words the candidate actually said. This is the caller.
 *
 * The order matters and is the whole design:
 *
 *   ask for quotes  →  the model answers  →  EVERY quote is checked against
 *   the transcript verbatim  →  anything that cannot be found is downgraded to
 *   `insufficient` with the reason recorded
 *
 * The prompt asking is not enough: a model can decline a rule silently. The
 * verifier alone is not enough either: it has nothing to check if nothing was
 * quoted. Together they mean a fabricated finding cannot reach a reviewer as a
 * finding — it reaches them as "not enough evidence", which is true.
 */
const analysis: Handler = async (job, row) => {
  const db = supabaseAdmin();
  const interviewId = job.subjectId;
  if (!interviewId) throw new Error("the job names no interview");

  const { data: interview, error } = await db
    .from("interviews")
    .select("id, project_id, customer_id, status, is_test, deleted_at")
    .eq("id", interviewId)
    .maybeSingle();
  if (error) throw new Error(`could not read the interview: ${error.message}`);
  if (!interview || interview.deleted_at) throw new Error("that interview does not exist");

  const [{ data: requirements }, { data: responses }, { data: questions }] = await Promise.all([
    db.from("interview_requirements")
      .select("id, code, title, criteria, weight, category")
      .eq("project_id", interview.project_id)
      .order("position", { ascending: true }),
    db.from("interview_responses")
      .select("id, question_id, answer_text, answer_value, answer_kind, status")
      .eq("interview_id", interviewId)
      .order("position", { ascending: true }),
    db.from("interview_questions")
      .select("id, code, options")
      .eq("project_id", interview.project_id),
  ]);

  const reqs = (requirements ?? []).map((r) => ({
    id: r.id as string, code: r.code as string, title: r.title as string,
    criteria: (r.criteria as string) || undefined,
    weight: Number(r.weight ?? 1),
    category: (r.category as string | null) ?? "general",
  }));

  /*
   * No requirements is not a failure. A project can collect interviews without
   * assessing them against anything, and running a model over transcripts with
   * nothing to look for would spend money to produce an empty answer.
   */
  if (!reqs.length) {
    await writeAnalysis(interviewId, interview.project_id, {
      status: "complete", summary: {}, narrative: null, requirements: [],
    });
    await markProcessed(interviewId);
    return;
  }

  const codeOf = new Map((questions ?? []).map((q) => [q.id as string, q.code as string]));
  const optionsOf = new Map((questions ?? []).map((q) => [
    q.id as string,
    (Array.isArray((q as { options?: unknown }).options) ? (q as { options: { code: string; label: string }[] }).options : []),
  ]));

  /*
   * A CHOSEN ANSWER IS WORDS TOO. A candidate who picked "Go" from a list has
   * said something the requirements may bear on, and the model needs the
   * label, not the code — `ts` means nothing to it; "TypeScript" does. A
   * multi-choice answer is the labels, joined. Typed answers are already
   * text. Recorded answers arrive through their transcript, as before.
   */
  const chosenText = (r: { question_id: unknown; answer_kind: unknown; answer_value: unknown }): string | null => {
    if (r.answer_kind !== "single_choice" && r.answer_kind !== "multi_choice") return null;
    const opts = optionsOf.get(r.question_id as string) ?? [];
    const label = (code: unknown) => opts.find((o) => o.code === String(code))?.label ?? String(code);
    const v = r.answer_value;
    if (Array.isArray(v)) return v.map(label).join(", ");
    if (v === null || v === undefined) return null;
    return label(v);
  };

  const { data: transcripts } = await db
    .from("interview_transcripts")
    .select("response_id, media_id, text, segments, status")
    .eq("interview_id", interviewId)
    .eq("status", "completed");

  const byResponse = new Map<string, { text: string; segments: unknown }>();
  for (const t of transcripts ?? []) {
    if (t.response_id) byResponse.set(t.response_id as string, { text: (t.text as string) ?? "", segments: t.segments });
  }

  const sources = (responses ?? [])
    .map((r) => {
      const t = byResponse.get(r.id as string);
      const text = (t?.text ?? chosenText(r) ?? (r.answer_text as string) ?? "").trim();
      if (!text) return null;
      return {
        responseId: r.id as string,
        questionId: (r.question_id as string) ?? "",
        questionCode: codeOf.get((r.question_id as string) ?? "") ?? "",
        text,
        segments: (t?.segments as { start: number; end: number; text: string }[] | null) ?? null,
      };
    })
    .filter(Boolean) as Parameters<typeof verifyEvidence>[1][number][];

  if (!sources.length) {
    throw new Error("no transcript is ready for this interview yet");
  }

  const plan = planAnalysisPrompt(reqs, sources);

  const outcome = await meteredAnalysis(
    {
      customerId: interview.customer_id,
      projectId: interview.project_id,
      environment: interview.is_test ? "TEST" : "LIVE",
    },
    {
      estimatedTokens: plan.approxTokens,
      operation: "analyse_interview",
      idempotencyKey: `interview-analysis:${interviewId}`,
    },
    () => completeJson(plan.system, plan.user, 2_000),
  );

  if (outcome.refused) {
    const err = new Error(outcome.refused);
    (err as Error & { status?: number }).status = 402;
    throw err;
  }

  const { claims, narrative } = readClaims(outcome.value ?? null);

  /*
   * THE CHECK. Every claim's quote must appear in the transcript it names,
   * character for character. What cannot be found is not discarded silently —
   * it is downgraded to `insufficient` and carries the reason, so a reviewer
   * seeing a thin analysis can tell "the candidate did not say this" from "the
   * model made something up".
   */
  const verified = verifyEvidence(
    claims.map((c) => ({
      requirementId: c.requirementId,
      responseId: c.responseId,
      verdict: c.verdict as never,
      quote: c.quote ?? null,
      explanation: c.explanation ?? "",
    })),
    sources,
    reqs,
  );

  const summary = summariseRequirements(reqs, verified.evidence);

  /* a re-run replaces: stale findings from an earlier model are not evidence */
  await db.from("interview_evidence").delete().eq("interview_id", interviewId);

  /*
   * THE SCORECARD IS BUILT FROM THE ROWS AS WRITTEN, not from the model's
   * claims. `verified.evidence` has already had every unquoted claim
   * downgraded; the insert below returns the ids, and `buildScorecard` names
   * those ids in every number it produces. A score that could not be expanded
   * into stored evidence rows would be a score about nothing.
   */
  let insertedEvidence: { id: string; requirement_id: string; response_id: string | null; question_id: string | null; verdict: string; quote: string | null; explanation: string | null }[] = [];
  if (verified.evidence.length) {
    const { data: inserted, error: evidenceError } = await db.from("interview_evidence").insert(verified.evidence.map((e) => ({
      interview_id: interviewId,
      project_id: interview.project_id,
      requirement_id: e.requirementId,
      response_id: e.responseId,
      question_id: e.questionId ?? sources.find((s) => s.responseId === e.responseId)?.questionId ?? null,
      verdict: e.verdict,
      explanation: e.explanation ?? "",
      quote: e.quote ?? null,
      quote_start_seconds: e.quoteStartSeconds,
      quote_end_seconds: e.quoteEndSeconds,
      provider: process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible",
      model: process.env.AI_MODEL ?? null,
    }))).select("id, requirement_id, response_id, question_id, verdict, quote, explanation");
    /*
     * Previously unchecked: a duplicate pair or an off-vocabulary verdict lost
     * the whole batch silently while the analysis row still said `complete`.
     * Now it is the job's failure, retried like any other.
     */
    if (evidenceError) throw new Error(`the evidence could not be saved: ${evidenceError.message}`);
    insertedEvidence = (inserted ?? []) as typeof insertedEvidence;
  }

  const scorecard = buildScorecard(
    reqs,
    insertedEvidence.map((e) => ({
      id: e.id, requirementId: e.requirement_id, responseId: e.response_id, questionId: e.question_id,
      verdict: e.verdict as never, quote: e.quote, explanation: e.explanation,
    })),
  );

  await writeAnalysis(interviewId, interview.project_id, {
    status: "complete",
    summary: Object.fromEntries(summary.map((s) => [s.code, { verdict: s.verdict, evidenceCount: s.evidenceCount }])),
    narrative,
    requirements: reqs,
    dropped: verified.dropped.length,
    omitted: plan.omitted,
    score: scorecard,
  });

  await markProcessed(interviewId);

  async function writeAnalysis(
    iv: string, project: string,
    body: { status: string; summary: Record<string, unknown>; narrative: string | null;
      requirements: unknown[]; dropped?: number; omitted?: string[]; score?: unknown },
  ) {
    await db.from("interview_analysis").upsert({
      interview_id: iv,
      project_id: project,
      status: body.status,
      score: body.score ?? null,
      summary: {
        ...body.summary,
        ...(body.dropped ? { _unverifiedClaimsDropped: body.dropped } : {}),
        ...(body.omitted?.length ? { _answersNotSentToTheModel: body.omitted } : {}),
      },
      narrative: body.narrative,
      provider: process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible",
      model: process.env.AI_MODEL ?? null,
      requirements_snapshot: body.requirements,
      completed_at: new Date().toISOString(),
      error: null,
    }, { onConflict: "interview_id" });
  }

  async function markProcessed(iv: string) {
    await db.from("interviews").update({
      status: "processed", processed_at: new Date().toISOString(),
    }).eq("id", iv);
  }

  void row;
};

const HANDLERS: Partial<Record<JobKind, Handler>> = { transcription, analysis };
