import type { Confidence } from "./confidence.ts";
import type { HelpMode } from "./intent.ts";
import type { ProblemThread } from "./attempts.ts";
import type { SurveyDiagnosis } from "./diagnostics.ts";

/**
 * WHICH LEVEL ANSWERS (2026-11-10) — the Help Center's router. Internal first; the model only when it adds something
 * the knowledge base and the survey checks cannot.
 *
 *   Level 1  INTERNAL KNOWLEDGE — the guides, the documentation, the generated facts, the live billing rules, the
 *            clarifying questions and the Intelligent Mode hand-off. No model call, no charge. The default.
 *   Level 2  YOUR SURVEY, CHECKED — a troubleshooting question with the user's survey open: the engine's own checks run
 *            on it (lib/help/diagnostics.ts) and the verified findings lead the answer, with the guide's steps and a
 *            fix to propose in Intelligent Mode. No model call.
 *   Level 3  THE MODEL — only when it is worth a call:
 *              · the guides match the question only weakly but it IS about the product (in domain, low confidence);
 *              · the problem persists after an internal answer and the survey checks found nothing to explain it;
 *              · the user asked for the AI explicitly ("Ask the AI instead").
 *            and only where a model is available and a project can be billed (the caller checks). The model writes
 *            from the same retrieved sources and context, its answer is validated (readModelAnswer), and cached.
 *
 * ESCALATION to a person is offered — never forced — when: the user asks for one; the problem has survived two
 * answers; the question is outside what the guides cover; or the confidence is low and no model can help.
 * What the router decides is recorded with the answer (`route`), which is what usage monitoring reads.
 */
export type Level = 1 | 2 | 3;
export interface RouteInput {
  mode: HelpMode;
  confidence: Confidence;
  clarifying: boolean;
  diagnosis: SurveyDiagnosis | null;
  thread: ProblemThread;
  wantsHuman: boolean;
  forceAi: boolean;
  /** a model is configured AND this request may be billed for it (project, AI enabled) */
  modelAllowed: boolean;
  /** words in the question, without stop words — a two-word question is not worth a model call on low confidence */
  substantive: boolean;
}
export interface RouteDecision {
  level: Level;
  reason: string;
  escalate: { offer: boolean; reason: string | null };
}

export function routeHelp(i: RouteInput): RouteDecision {
  const found = !!i.diagnosis && i.diagnosis.findings.some((f) => f.severity !== "info");
  const verdictExplains = i.diagnosis?.verdict === "never" || i.diagnosis?.verdict === "sometimes";
  let level: Level = 1;
  let reason: string;

  if (i.forceAi && i.modelAllowed) { level = 3; reason = "you asked for an AI answer"; }
  else if (i.clarifying) reason = "the request could mean different features — asking which one first";
  else if (i.mode === "do") reason = "a change to the survey — handed to Intelligent Mode, where you approve it";
  else if (i.mode === "billing") reason = "billing questions are answered from the live billing rules";
  else if (i.diagnosis && (found || verdictExplains || i.thread.failedAttempts === 0)) { level = 2; reason = found || verdictExplains ? "your survey was checked and the findings explain it" : "your survey was checked"; }
  else if (i.thread.failedAttempts >= 1 && i.modelAllowed && !i.thread.levels.includes(3) && i.confidence.domain === "in") { level = 3; reason = "the earlier steps didn't fix it and the survey checks found nothing more"; }
  else if (i.confidence.level === "low" && i.confidence.domain === "in" && i.modelAllowed && i.substantive) { level = 3; reason = "the guides cover this only partly"; }
  else if (i.diagnosis) { level = 2; reason = "your survey was checked"; }
  else reason = i.confidence.domain === "out" ? "this isn't covered by the ResLens.ai guides" : `the guides answer this (confidence ${i.confidence.level})`;

  let esc: string | null = null;
  if (i.wantsHuman) esc = "you asked for a person";
  else if (i.thread.failedAttempts >= 2) esc = "this has survived more than one fix";
  else if (i.confidence.domain === "out" && i.mode !== "billing") esc = "the guides don't cover this";
  else if (level === 1 && i.confidence.level === "low" && !i.clarifying && i.mode !== "do" && i.mode !== "billing") esc = "the guides only partly cover this";
  else if (i.thread.failedAttempts >= 1 && level !== 3 && !found) esc = "the internal checks found nothing more to try";
  return { level, reason, escalate: { offer: !!esc, reason: esc } };
}
