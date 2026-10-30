import type { SurveyDefinition } from "@rescript/schema";
import type { AnswerValue, ResponseState } from "./state.js";
import { createResponseState, getQuestion } from "./state.js";
import { advance, start, visibleQuestions, type RuntimeStep } from "./flow.js";
import type { QuotaCounts } from "./quotas.js";
import { blockingErrors, validatePage } from "./validate.js";
import { isEmptyAnswer } from "./answers.js";
import { lookupAnswer } from "./state.js";
import { sectionNavMode } from "./sectionNav.js";
import { assessmentSettings } from "./assessment.js";
import { isServerResolvedExpression } from "./aiFunctions.js";

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
 * What it deliberately does NOT do: execute ANY author JavaScript. Until
 * 2026-10-30 that claim was false — a `custom_script` validation rule reached
 * `runScript` (a `new Function` in the server's own realm) through
 * `validatePage`, so author code could read `process` and an endless loop
 * hung the save route (audit 2026-10-30 D1). The replay now passes
 * `scripts: "skip"`: such a rule is never executed here, it is recorded as a
 * soft `client_only` problem (it ran in the browser, where it belongs) and
 * cannot refuse a save on its own. Owner decision S0 #2: "skip on the
 * server". It also does not run option popups, and it does not recompute
 * quota outcomes against live counts (a respondent who started before a cell
 * filled is the route's business), nor punches/calculations (D7, S0b).
 * Problems are graded so the route can log before it refuses:
 *
 *   hard  — the payload cannot be an honest interview: an answer that fails
 *           its question's rules on a page already passed, an unknown
 *           question id, a claimed completion that does not reach an end.
 *   soft  — worth a log line, not a refusal on its own: an answer for a
 *           question the replay never showed (display logic hid it; a loop
 *           iteration that did not exist), a status the replay ended
 *           differently from (quota timing), a `custom_script` rule the
 *           server does not execute (`client_only`).
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
    | "step_unreachable"
    | "skipped_required"
    | "client_only"
    | "server_mismatch";
  questionId?: string;
  pageId?: string;
  /** server_mismatch on a calculated variable: its name */
  variable?: string;
  /** server_mismatch: what was posted and what the server derived — summarised, never the raw text of an open end */
  posted?: unknown;
  server?: unknown;
  message: string;
};

export interface SubmissionCheck {
  ok: boolean;
  hard: SubmissionProblem[];
  soft: SubmissionProblem[];
  /** how far the replay got, for the log line */
  replayedPages: number;
  endStatus?: string;
  /**
   * D7 (S0b): the values the server derived for the fields it can recompute, where they differ from what was
   * posted — answer keys of derived questions, calculated variables, exact-balance claims. The save route stores
   * these instead of the posted ones under RUNTIME_SERVER_RECOMPUTE=store. Empty when everything agrees.
   */
  recomputed?: { answers: Record<string, unknown>; calculated: Record<string, unknown> };
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
  /**
   * D7 (S0b): compare the derived fields with what the replay recomputed (default true). `balanceClaims` are the
   * exact-balance assignments as the SERVER stored them (`RANDOMIZER_<ID>` / `<VAR>_VERSION` → "arm,arm"); a
   * posted value that differs is a mismatch and the server's is the one to store.
   */
  recompute?: boolean;
  balanceClaims?: Record<string, string>;
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
  let recomputed: SubmissionCheck["recomputed"];
  const out = (replayedPages = 0, endStatus?: string): SubmissionCheck => ({ ok: hard.length === 0, hard, soft, replayedPages, endStatus, ...(recomputed ? { recomputed } : {}) });

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
  const clientOnlySeen = new Set<string>();
  let nav = start(def, state, counts);
  let pages = 0;
  const claimsFinal = FINAL.has(posted.status);
  const target = claimsFinal ? Number.POSITIVE_INFINITY : stepIndex;
  const freeNav = sectionNavMode(def) === "free";
  const isAssessment = !!assessmentSettings(def);

  while (!nav.done && pages < maxPages) {
    const step = nav.steps[nav.stepIndex] as RuntimeStep | undefined;
    if (!step || step.kind !== "page") break;
    const visible = visibleQuestions(def, step, state, counts);
    for (const q of visible) askedBases.add(q.id);
    // the page the client is still on is being filled in — it is not validated until it is left
    if (!claimsFinal && nav.stepIndex >= target) break;
    const skippedScripts: { questionId?: string; script: string }[] = [];
    let errs = blockingErrors(validatePage(def, visible, { def, state, loop: step.loop ?? null, quotaCounts: counts, scripts: "skip", skippedScripts }));
    for (const sk of skippedScripts) {
      const key = `${step.pageId}|${sk.questionId ?? ""}|${sk.script}`;
      if (clientOnlySeen.has(key)) continue;
      clientOnlySeen.add(key);
      soft.push({ severity: "soft", code: "client_only", questionId: sk.questionId, pageId: step.pageId, message: `custom_script rule "${sk.script}" is checked in the browser only; the server does not run author code` });
    }
    /*
     * FREE SECTION NAVIGATION (sectionNav.ts): a page jumped over is not
     * validated at jump time, so an UNANSWERED question on it is not a lie —
     * it is a skip the engine allowed. Answers given still have to pass their
     * rules. At completion the Submit gate refused unanswered required
     * questions — except in an assessment, where unanswered = unattempted.
     */
    if (freeNav) {
      const unanswered = errs.filter((e) => isEmptyAnswer(lookupAnswer(state.answers, e.questionId, step.loop ?? null)));
      if (unanswered.length && (!claimsFinal || isAssessment)) {
        for (const e of unanswered) soft.push({ severity: "soft", code: "skipped_required", questionId: e.questionId, pageId: step.pageId, message: `${e.questionId} skipped by section navigation` });
        errs = errs.filter((e) => !unanswered.includes(e));
      }
    }
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

  if (input.recompute !== false) recomputed = compareDerived(def, answers, posted.calculated, state, input.balanceClaims, soft);

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

/* ------------------------------------------------------------------------------------------------
 * D7 (audit 2026-10-30, S0b) — WHAT THE SERVER CAN DERIVE ITSELF, COMPARED WITH WHAT WAS POSTED.
 *
 * The replay above already recomputes, from the posted answers and the row's seed, everything the engine derives
 * deterministically: arriving at each page applies the punch rules of derived (hidden / calculated / settings.hidden)
 * questions and the page's own punches, submitting it runs the calculations (and the loop / masking variables).
 * Until now the result was thrown away and the posted values were stored. Here the two are compared for:
 *
 *   - answer keys of derived questions (hidden type, calculated type with an expression, settings.hidden with punch
 *     rules) and of questions whose punch rules say recompute: "always" (the rule owns the answer);
 *   - every calculated variable the replay wrote (calculations, loop and masking variables) — a value only a
 *     script sets (setCalc) is not recomputed here (the server never runs author code) and stays as posted;
 *   - the exact-balance assignments, against the claims the SERVER stored (the replay reads them, it cannot
 *     recompute them).
 *
 * Every difference is a soft `server_mismatch` (question or variable, posted vs server, summarised so an open
 * end's text never reaches a log). An AI-resolved calculated question is the server's own business and skipped.
 * ------------------------------------------------------------------------------------------------ */
const SAFE_SCALAR = /^[\w .,:;@#%+\-/]{0,40}$/;
/** a value for a log line: numbers, booleans, codes and short code-like strings as they are; other text by length only */
export function summariseValue(v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v ?? null;
  if (typeof v === "string") return SAFE_SCALAR.test(v) ? v : `<text, ${v.length} chars>`;
  if (Array.isArray(v)) return v.length > 20 ? `<list of ${v.length}>` : v.map(summariseValue);
  if (typeof v === "object") { const e = Object.entries(v as Record<string, unknown>); return e.length > 20 ? `<object with ${e.length} keys>` : Object.fromEntries(e.map(([k, x]) => [k, summariseValue(x)])); }
  return `<${typeof v}>`;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function compareDerived(
  def: SurveyDefinition,
  postedAnswers: Record<string, AnswerValue>,
  postedCalculated: unknown,
  state: ResponseState,
  claims: Record<string, string> | undefined,
  soft: SubmissionProblem[],
): NonNullable<SubmissionCheck["recomputed"]> {
  const rec = { answers: {} as Record<string, unknown>, calculated: {} as Record<string, unknown> };
  const derived = new Set<string>();
  for (const q of def.questions) {
    const always = (q.punches ?? []).some((p) => (p as { recompute?: string }).recompute === "always");
    const hiddenLike = q.type === "hidden" || !!q.settings?.hidden;
    if (q.type === "calculated") { if (q.settings?.expression && !isServerResolvedExpression(q.settings.expression)) derived.add(q.id); continue; }
    if ((hiddenLike && q.punches?.length) || always) derived.add(q.id);
  }
  if (derived.size) {
    const keys = new Set([...Object.keys(postedAnswers), ...Object.keys(state.answers)]);
    for (const key of keys) {
      if (COMPANION.test(key)) continue;
      const base = answerKeyBase(key);
      if (!derived.has(base)) continue;
      const p = postedAnswers[key], sv = state.answers[key];
      if (same(p, sv)) continue;
      rec.answers[key] = sv ?? null;
      soft.push({ severity: "soft", code: "server_mismatch", questionId: base, posted: summariseValue(p), server: summariseValue(sv), message: `${key}: the posted answer differs from the one the server derives from the other answers` });
    }
  }
  const pc = isPlainObject(postedCalculated) ? postedCalculated as Record<string, unknown> : {};
  for (const name of Object.keys(state.calculated)) {
    if (claims && name in claims) continue; // judged against the stored claim below
    const p = pc[name], sv = (state.calculated as Record<string, unknown>)[name];
    if (same(p, sv)) continue;
    rec.calculated[name] = sv ?? null;
    soft.push({ severity: "soft", code: "server_mismatch", variable: name, posted: summariseValue(p), server: summariseValue(sv), message: `${name}: the posted value differs from the one the server calculates` });
  }
  for (const [name, stored] of Object.entries(claims ?? {})) {
    const p = pc[name];
    if (same(p == null ? null : String(p), stored)) continue;
    rec.calculated[name] = stored;
    soft.push({ severity: "soft", code: "server_mismatch", variable: name, posted: summariseValue(p), server: summariseValue(stored), message: `${name}: the posted assignment differs from the claim the server stored` });
  }
  return rec;
}
