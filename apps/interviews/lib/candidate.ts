import "server-only";
import type { Condition, SkipRule } from "@rescript/schema";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "./admin";
import {
  drawSequence, linkVerdict, seedFor, recordingSeconds,
  type DrawnQuestion, type InterviewStatus, type TelemetryEvent,
  isTelemetryKind, isFlowKind, type FlowKind,
} from "@rescript/interviews";

/**
 * THE CANDIDATE'S SIDE OF THE DOOR.
 *
 * A candidate has no account, no password and no session in the ordinary
 * sense. What they have is a link, and the link is a bearer credential — so
 * the whole of this file is about treating it like one.
 *
 * ## The token is stored as a hash
 *
 * `respondents.token` in the survey product is plaintext, and the migration
 * that hashed collaborator invitations said in as many words that it should
 * not be. A new product has no reason to inherit that: the token is generated
 * once, shown once, and only its SHA-256 is written down. Losing a link is a
 * re-issue — a normal thing for a company to want — and recovering one from
 * the database is not possible, which is the point.
 *
 * SHA-256 with no salt and no stretching is correct here and would be wrong
 * for a password: this is 256 bits of `randomBytes`, not something a person
 * chose, so there is no dictionary to run and nothing for a work factor to
 * slow down. Adding bcrypt would cost every request and buy nothing.
 *
 * ## Why every candidate route re-reads the token
 *
 * There is no candidate session cookie. Each request carries the token and is
 * authorized from scratch, which means a link that is revoked, expires or
 * finishes stops working on the very next request rather than whenever some
 * cached session would have lapsed. It costs one indexed lookup.
 */

export interface CandidateGate {
  interview: {
    id: string;
    project_id: string;
    customer_id: string;
    status: InterviewStatus;
    question_sequence: DrawnQuestion[];
    selection_seed: string | null;
    candidate_name: string | null;
    consent_given_at: string | null;
    expires_at: string | null;
    started_at: string | null;
    is_test: boolean;
  };
  project: {
    id: string;
    customer_id: string;
    name: string;
    instructions: string;
    consent_text: string;
    status: string;
    settings: Record<string, unknown>;
    selection: unknown;
    max_recording_seconds: number | null;
  };
}

export type CandidateFailure = { response: NextResponse };

export function isCandidateFailure<T>(v: T | CandidateFailure): v is CandidateFailure {
  return !!v && typeof v === "object" && "response" in (v as object);
}

/** 32 random bytes, base64url. Shown once; only the hash is kept. */
export function mintInterviewToken(): { token: string; hash: string; prefix: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve a link, or say why it does not work — in the candidate's words.
 *
 * Every refusal is a sentence a person can act on, and none of them
 * distinguishes "this token never existed" from "this token is not yours":
 * both are "we could not find this interview", because telling them apart
 * turns the link into an oracle for guessing other links.
 */
export async function candidateGate(token: unknown): Promise<CandidateGate | CandidateFailure> {
  const t = typeof token === "string" ? token.trim() : "";
  if (t.length < 20) {
    return { response: NextResponse.json({ error: "This interview link is not valid." }, { status: 404 }) };
  }
  const db = supabaseAdmin();
  const { data: interview, error } = await db
    .from("interviews")
    .select("id, project_id, customer_id, status, question_sequence, selection_seed, candidate_name, consent_given_at, expires_at, started_at, is_test, deleted_at")
    .eq("token_hash", hashToken(t))
    .maybeSingle();
  if (error) {
    return { response: NextResponse.json({ error: "We could not open this interview. Please try again." }, { status: 503 }) };
  }
  if (!interview || interview.deleted_at) {
    return { response: NextResponse.json({ error: "We could not find this interview. Please check the link." }, { status: 404 }) };
  }

  const verdict = linkVerdict({
    status: interview.status as InterviewStatus,
    expiresAt: interview.expires_at ? new Date(interview.expires_at) : null,
    now: new Date(),
  });
  if (!verdict.ok) {
    return {
      response: NextResponse.json(
        { error: verdict.message, reason: verdict.reason },
        /* 410 Gone, not 403: the link was real and is finished with, which is
           what a candidate reading it needs to understand */
        { status: verdict.reason === "finished" ? 410 : 410 },
      ),
    };
  }

  const { data: project } = await db
    .from("interview_projects")
    .select("id, customer_id, name, instructions, consent_text, status, settings, selection, max_recording_seconds, deleted_at")
    .eq("id", interview.project_id)
    .maybeSingle();
  if (!project || project.deleted_at) {
    return { response: NextResponse.json({ error: "We could not find this interview. Please check the link." }, { status: 404 }) };
  }
  if (project.status === "closed" || project.status === "archived") {
    return {
      response: NextResponse.json(
        { error: "This interview is closed. Please contact the company that invited you." },
        { status: 410 },
      ),
    };
  }

  return {
    interview: interview as unknown as CandidateGate["interview"],
    project: project as unknown as CandidateGate["project"],
  };
}

/* ------------------------------------------------------- the sequence */

export interface CandidateQuestion {
  responseId: string;
  questionId: string;
  code: string;
  position: number;
  prompt: string;
  guidance: string;
  kind: FlowKind;
  required: boolean;
  minSeconds: number | null;
  maxSeconds: number;
  maxRetries: number;
  thinkSeconds: number;
  status: string;
  retries: number;
  /** choices for the two choice kinds */
  options: { code: string; label: string }[];
  /** what was already answered, so a reload shows it rather than a blank */
  answerText: string | null;
  answerValue: unknown;
  /** the interviewer asking, when a clip was recorded for this question */
  promptMedia: { id: string; mimeType: string | null; durationSeconds: number | null } | null;
  promptWatchedAt: string | null;
  /*
   * The logic, verbatim, so the browser can run the same engine the server
   * runs and know what comes next WITHOUT a round trip per answer. The server
   * re-derives everything at `finish`; the browser's copy is for navigation,
   * never for authority.
   */
  visibleIf: Condition | null;
  skipLogic: SkipRule[];
}

/**
 * Draw this candidate's sequence — ONCE — and write the response rows.
 *
 * The draw happens at the moment the interview starts and is then frozen on
 * the row. Re-running it later is not reproducible, because the question bank
 * can be edited between the sitting and the audit; `explainDraw` exists for
 * that comparison and deliberately reports a difference rather than hiding it.
 *
 * Writing the response rows here, up front, also means the candidate's
 * progress is a set of rows from the first moment rather than something
 * inferred from what happens to exist — so "which question are we on" has an
 * answer after a refresh, on another device, and in the dashboard.
 */
export async function ensureSequence(gate: CandidateGate): Promise<DrawnQuestion[]> {
  const db = supabaseAdmin();
  if (Array.isArray(gate.interview.question_sequence) && gate.interview.question_sequence.length) {
    return gate.interview.question_sequence;
  }

  const [{ data: pools }, { data: questions }] = await Promise.all([
    db.from("interview_pools").select("id, code, draw, position").eq("project_id", gate.project.id),
    db.from("interview_questions")
      .select("id, code, pool_id, position, required")
      .eq("project_id", gate.project.id)
      .is("archived_at", null),
  ]);

  /*
   * THE PROJECT'S DRAW CONFIGURATION, READ FOR THE FIRST TIME.
   *
   * `interview_projects.selection` was created in 0030 to carry exactly this
   * and was never read by any code, so the one call to `drawSequence` omitted
   * `randomize` and `randomizePools` and every candidate got the positional
   * order whatever the builder intended. The pool row's own `draw` column is
   * the fallback when the config does not mention the pool.
   */
  const selection = readSelection(gate.project.selection);
  const seed = gate.interview.selection_seed ?? seedFor(gate.interview.id);
  const { sequence } = drawSequence({
    seed,
    randomizePools: selection.randomizePools,
    pools: (pools ?? []).map((p) => {
      const cfg = selection.pools.find((x) => x.id === p.id);
      return {
        id: p.id, code: p.code, position: p.position,
        draw: cfg?.draw ?? p.draw,
        randomize: cfg?.randomize ?? false,
      };
    }),
    questions: (questions ?? []).map((q) => ({
      id: q.id, code: q.code, poolId: q.pool_id, position: q.position, required: q.required,
    })),
  });

  await db.from("interviews")
    .update({ question_sequence: sequence, selection_seed: seed })
    .eq("id", gate.interview.id);

  if (sequence.length) {
    await db.from("interview_responses").upsert(
      sequence.map((s) => ({
        interview_id: gate.interview.id,
        project_id: gate.project.id,
        customer_id: gate.interview.customer_id,
        question_id: s.questionId,
        position: s.position,
        status: "pending",
      })),
      { onConflict: "interview_id,question_id", ignoreDuplicates: true },
    );
  }
  return sequence;
}

/** The sequence as the candidate's browser needs it: questions joined to their rows. */
export async function candidateQuestions(
  gate: CandidateGate, sequence: DrawnQuestion[],
): Promise<CandidateQuestion[]> {
  if (!sequence.length) return [];
  const db = supabaseAdmin();
  const ids = sequence.map((s) => s.questionId);
  const [{ data: questions }, { data: responses }] = await Promise.all([
    db.from("interview_questions")
      .select("id, code, prompt, guidance, kind, required, min_seconds, max_seconds, max_retries, think_seconds, options, visible_if, skip_logic, prompt_media_id")
      .in("id", ids),
    db.from("interview_responses")
      .select("id, question_id, status, retries, answer_text, answer_value, prompt_watched_at")
      .eq("interview_id", gate.interview.id),
  ]);

  /* the interviewer's clips, only the ones that are actually stored */
  const promptIds = (questions ?? []).map((q) => q.prompt_media_id).filter((x): x is string => !!x);
  const { data: prompts } = promptIds.length
    ? await db.from("interview_media")
        .select("id, mime_type, duration_seconds, upload_status")
        .in("id", promptIds)
        .eq("upload_status", "stored")
        .is("deleted_at", null)
    : { data: [] as { id: string; mime_type: string | null; duration_seconds: number | null; upload_status: string }[] };
  const promptById = new Map((prompts ?? []).map((m) => [m.id, m]));
  const byQuestion = new Map((questions ?? []).map((q) => [q.id, q]));
  const byResponse = new Map((responses ?? []).map((r) => [r.question_id, r]));

  const out: CandidateQuestion[] = [];
  for (const s of sequence) {
    const q = byQuestion.get(s.questionId);
    const r = byResponse.get(s.questionId);
    /* a question archived between the draw and the sitting is skipped rather
       than shown as a blank — the sequence is the record, not the menu */
    if (!q || !r) continue;
    out.push({
      responseId: r.id,
      questionId: q.id,
      code: q.code,
      position: s.position,
      prompt: q.prompt,
      guidance: q.guidance ?? "",
      kind: isFlowKind(q.kind) ? q.kind : "video",
      required: !!q.required,
      options: readOptions(q.options),
      answerText: (r.answer_text as string | null) ?? null,
      answerValue: r.answer_value ?? null,
      promptMedia: (() => {
        const m = q.prompt_media_id ? promptById.get(q.prompt_media_id) : undefined;
        return m ? { id: m.id, mimeType: m.mime_type ?? null, durationSeconds: m.duration_seconds ?? null } : null;
      })(),
      promptWatchedAt: (r.prompt_watched_at as string | null) ?? null,
      visibleIf: (q.visible_if as Condition | null) ?? null,
      skipLogic: Array.isArray(q.skip_logic) ? (q.skip_logic as SkipRule[]) : [],
      minSeconds: q.min_seconds ?? null,
      maxSeconds: recordingSeconds({
        questionMaxSeconds: q.max_seconds,
        projectMaxSeconds: gate.project.max_recording_seconds,
      }),
      maxRetries: q.max_retries ?? 0,
      thinkSeconds: q.think_seconds ?? 0,
      status: r.status,
      retries: r.retries ?? 0,
    });
  }
  return out;
}

/* -------------------------------------------------------- telemetry */

/**
 * Record what the browser reported.
 *
 * Never throws and never blocks a reply. Telemetry is a courtesy to whoever
 * reviews the interview later; a failure to write it must not be a reason a
 * candidate cannot answer a question. Unknown event kinds are dropped rather
 * than stored, so the vocabulary stays the one in `@rescript/interviews` and
 * a reviewer's screen cannot acquire an event nobody has written a neutral
 * sentence for.
 */
export async function recordTelemetry(
  gate: CandidateGate, events: unknown,
): Promise<number> {
  if (!Array.isArray(events) || !events.length) return 0;
  const rows = events
    .slice(0, 200)
    .filter((e): e is TelemetryEvent => !!e && typeof e === "object" && isTelemetryKind((e as TelemetryEvent).kind))
    .map((e) => ({
      interview_id: gate.interview.id,
      project_id: gate.project.id,
      response_id: typeof e.responseId === "string" ? e.responseId : null,
      question_id: typeof e.questionId === "string" ? e.questionId : null,
      kind: e.kind,
      detail: e.detail && typeof e.detail === "object" ? e.detail : {},
      client_at: typeof e.clientAt === "string" ? e.clientAt : null,
    }));
  if (!rows.length) return 0;
  try {
    await supabaseAdmin().from("interview_telemetry").insert(rows);
    return rows.length;
  } catch {
    return 0;
  }
}

/** A heartbeat, so `isAbandoned` has something to measure against. */
export async function touchInterview(gate: CandidateGate, patch: Record<string, unknown> = {}): Promise<void> {
  try {
    await supabaseAdmin().from("interviews")
      .update({ last_seen_at: new Date().toISOString(), ...patch })
      .eq("id", gate.interview.id);
  } catch { /* a heartbeat that fails is not a reason to stop an interview */ }
}


/* ------------------------------------------------------- draw config */

export interface SelectionConfig {
  pools: { id: string; draw: number | null; randomize: boolean }[];
  randomizePools: boolean;
}

/**
 * `interview_projects.selection`, read defensively.
 *
 * It is jsonb with a default of `{}`, so an installation that never touched
 * randomization has an empty object here and gets positional order — the
 * behaviour every existing project has had. Anything malformed degrades to
 * the same rather than throwing in front of a candidate.
 */
export function readSelection(raw: unknown): SelectionConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pools = Array.isArray(o.pools)
    ? o.pools
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof p.id === "string")
        .map((p) => ({
          id: p.id as string,
          draw: typeof p.draw === "number" && Number.isInteger(p.draw) && p.draw >= 0 ? p.draw : null,
          randomize: p.randomize === true,
        }))
    : [];
  return { pools, randomizePools: o.randomizePools === true };
}

function readOptions(raw: unknown): { code: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({ code: String(o.code ?? ""), label: String(o.label ?? o.code ?? "") }))
    .filter((o) => o.code);
}
