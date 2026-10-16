import type { SurveyDefinition } from "@rescript/schema";
import type { AnswerValue, ResponseState } from "./state.js";
import { createResponseState, getQuestion } from "./state.js";
import { advance, start, visibleQuestions, type RuntimeStep } from "./flow.js";
import type { QuotaCounts } from "./quotas.js";
import { blockingErrors, validatePage } from "./validate.js";

/**
 * THE SERVER CHECKS WHAT THE CLIENT SAYS HAPPENED.
 *
 * Every page the respondent submits is validated in the browser
 * (`validatePage` in the Runner) and then POSTed to `/api/session/save`,
 * which used to store the payload verbatim: `answers`, `status`,
 * `step_index` — all of it. A respondent-side actor could therefore write
 * `{ q_age: "999" }` and `status: "complete"` for any in-progress session,
 * and the row flowed into quotas, analytics and exports like any other
 * interview (audit 2026-10-16, RUNTIME-01).
 *
 * This replays the interview on the server with the same engine the browser
 * ran: the row's seed, the posted answers, the survey's flow. Walking from the
 * first page to the page the client claims to be on, every page passed must
 * validate (type, range, format, required — the same rules the browser
 * applied), and a completed interview must actually reach an end. Nothing
 * here is a second validation engine; it is the first one, run again where
 * the client cannot edit it.
 *
 * What it deliberately does NOT do: run `def.scripts` (they are unsandboxed
 * — RUNTIME-04) or option popups, and it does not recompute quota outcomes
 * against live counts (a respondent who started before a cell filled is the
 * route's business). Problems are graded so the route can log before it
 * refuses:
 *
 *   hard  — the payload cannot be an honest interview: an answer that fails
 *           its question's rules on a page already passed, an unknown
 *           question id, a claimed completion that does not reach an end.
 *   soft  — worth a log line, not a refusal on its own: an answer for a
 *           question the replay never showed (display logic hid it; a loop
 *           iteration that did not exist), a status the replay ended
 *           differently from (quota timing).
 */
export type SubmissionProblem = {
  severity: "hard" | "soft";
  code:
    | "bad_shape"
    | "unknown_question"
    | "invalid_answer"
    | "not_asked"
    | "incomplete"
    | "status_mismatch"
    | "step_unreachable";
  questionId?: string;
  pageId?: string;
  message: string;
};

export interface SubmissionCheck {
  ok: boolean;
  hard: SubmissionProblem[];
  soft: SubmissionProblem[];
  /** how far the replay got, for the log line */
  replayedPages: number;
  endStatus?: string;
}

export interface SubmissionInput {
  def: SurveyDefinition;
  /** the row as it is before this save */
  prior: { seed: number | null | undefined; sessionId: string; startedAt?: string | null };
  /** what the client posted */
  posted: {
    answers: unknown;
    calculated?: unknown;
    embedded?: unknown;
    flags?: unknown;
    stepIndex: unknown;
    status: string;
    completed?: boolean;
  };
  quotaCounts?: QuotaCounts;
  /** replay safety valve: stop after this many pages (a loop that never ends must not hang the save) */
  maxPages?: number;
}

const FINAL = new Set(["complete", "screened", "quota_full", "terminated"]);
const COMPANION = /__(other|voice|probe|comment|err|transcript)(__.*)?$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** the question id an answer key belongs to: `q1@apple__other` → `q1` */
export function answerKeyBase(key: string): string {
  const noCompanion = key.replace(COMPANION, "");
  const at = noCompanion.indexOf("@");
  return at >= 0 ? noCompanion.slice(0, at) : noCompanion;
}

const answered = (v: AnswerValue | undefined): boolean =>
  !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));

export function checkSubmission(input: SubmissionInput): SubmissionCheck {
  const { def, prior, posted } = input;
  const hard: SubmissionProblem[] = [];
  const soft: SubmissionProblem[] = [];
  const out = (replayedPages = 0, endStatus?: string): SubmissionCheck => ({ ok: hard.length === 0, hard, soft, replayedPages, endStatus });

  if (!isPlainObject(posted.answers)) { hard.push({ severity: "hard", code: "bad_shape", message: "answers must be an object" }); return out(); }
  for (const k of ["calculated", "embedded"] as const) {
    if (posted[k] !== undefined && !isPlainObject(posted[k])) { hard.push({ severity: "hard", code: "bad_shape", message: `${k} must be an object` }); return out(); }
  }
  if (posted.flags !== undefined && !Array.isArray(posted.flags)) { hard.push({ severity: "hard", code: "bad_shape", message: "flags must be an array" }); return out(); }
  const stepIndex = Number(posted.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) { hard.push({ severity: "hard", code: "bad_shape", message: "stepIndex must be a non-negative integer" }); return out(); }
  if (posted.status !== "in_progress" && !FINAL.has(posted.status)) { hard.push({ severity: "hard", code: "bad_shape", message: `unknown status ${posted.status}` }); return out(); }

  // every answer key must name a question of this survey
  const answers = posted.answers as Record<string, AnswerValue>;
  for (const key of Object.keys(answers)) {
    if (key === "__proto__" || key === "constructor") { hard.push({ severity: "hard", code: "bad_shape", message: `forbidden key ${key}` }); continue; }
    const base = answerKeyBase(key);
    if (!getQuestion(def, base)) hard.push({ severity: "hard", code: "unknown_question", questionId: base, message: `${key} is not a question of this survey` });
  }
  if (hard.length) return out();

  // replay
  const state: ResponseState = createResponseState(def, {
    sessionId: prior.sessionId,
    seed: typeof prior.seed === "number" ? prior.seed : undefined,
    embedded: isPlainObject(posted.embedded) ? (posted.embedded as ResponseState["embedded"]) : {},
  });
  if (prior.startedAt) state.startedAt = prior.startedAt;
  state.answers = { ...answers };
  state.calculated = isPlainObject(posted.calculated) ? { ...(posted.calculated as Record<string, unknown>) } as ResponseState["calculated"] : {};
  state.flags = Array.isArray(posted.flags) ? [...(posted.flags as string[])] : [];
  const counts = input.quotaCounts ?? {};
  const maxPages = input.maxPages ?? 2000;

  const askedBases = new Set<string>();
  let nav = start(def, state, counts);
  let pages = 0;
  const claimsFinal = FINAL.has(posted.status);
  const target = claimsFinal ? Number.POSITIVE_INFINITY : stepIndex;

  while (!nav.done && pages < maxPages) {
    const step = nav.steps[nav.stepIndex] as RuntimeStep | undefined;
    if (!step || step.kind !== "page") break;
    const visible = visibleQuestions(def, step, state, counts);
    for (const q of visible) askedBases.add(q.id);
    // the page the client is still on is being filled in — it is not validated until it is left
    if (!claimsFinal && nav.stepIndex >= target) break;
    const errs = blockingErrors(validatePage(def, visible, { def, state, loop: step.loop ?? null, quotaCounts: counts }));
    for (const e of errs) hard.push({ severity: "hard", code: "invalid_answer", questionId: e.questionId, pageId: step.pageId, message: e.message });
    if (errs.length) return out(pages); // the browser would not have let the respondent past this page
    pages++;
    nav = advance(def, state, counts, { fromPageId: step.pageId });
  }

  if (claimsFinal) {
    if (!nav.done) {
      hard.push({ severity: "hard", code: "incomplete", pageId: (nav.steps[nav.stepIndex] as { pageId?: string } | undefined)?.pageId, message: pages >= maxPages ? "the interview does not end within the page limit" : "the interview has pages left to answer" });
      return out(pages);
    }
    if (nav.endStatus && nav.endStatus !== posted.status) {
      // quota timing can legitimately differ; everything else is suspicious but not provable here
      soft.push({ severity: "soft", code: "status_mismatch", message: `the flow ends as ${nav.endStatus}, the client said ${posted.status}` });
    }
  } else if (nav.done) {
    // the client says in progress at a step the replay has already finished — a stale or crafted index
    soft.push({ severity: "soft", code: "step_unreachable", message: `stepIndex ${stepIndex} is past the end of the interview` });
  }

  // answers for questions the replay never showed (hidden by display logic, in an iteration that did not exist)
  for (const key of Object.keys(answers)) {
    const base = answerKeyBase(key);
    if (!answered(answers[key]) || askedBases.has(base)) continue;
    const q = getQuestion(def, base);
    if (!q || q.type === "hidden" || q.type === "calculated" || q.type === "embedded_data") continue;
    // beyond the claimed step the respondent has not been shown anything yet: only count what the replay covered
    soft.push({ severity: "soft", code: "not_asked", questionId: base, message: `${base} was answered but never shown on the pages passed` });
  }

  return out(pages, nav.endStatus);
}
