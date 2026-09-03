import type { SurveyDefinition, Question } from "@rescript/schema";

/**
 * Answer value shapes:
 *  - single / dropdown / numeric / text / date / time / slider / nps: scalar
 *  - multi / multi_dropdown: array of codes
 *  - ranking / image_ranking: ordered array of codes (first = rank 1)
 *  - allocation: { [optionCode]: number }
 *  - matrix_*: { [rowCode]: scalar | array }
 *  - composite / custom_table: { [rowCode]: { [columnId]: value } }
 *  - numeric_list / text_list: array of values
 *  - other_specify texts: stored under `${questionId}__other`
 */
export type AnswerValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number>
  | Record<string, unknown>;

export interface LoopContext {
  loopVar: string;
  code: string;
  label: string;
  index: number; // 1-based
}

export interface ResponseState {
  surveyId: string;
  surveyVersion: string;
  sessionId: string;
  respondentId?: string;
  seed: number;
  startedAt: string;
  status: "in_progress" | "complete" | "screened" | "quota_full" | "terminated";
  /** questionId (optionally suffixed with loop key `@code`) -> value */
  answers: Record<string, AnswerValue>;
  /** embedded data fields — booleans since typed embedded data (req §12) */
  embedded: Record<string, string | number | boolean | null>;
  /** calculated variable values */
  calculated: Record<string, string | number | boolean | null>;
  /** flags raised by soft quotas / scripts */
  flags: string[];
  /** current position in the compiled step sequence */
  stepIndex: number;
  meta?: Record<string, unknown>;
}

export function createResponseState(
  def: SurveyDefinition,
  opts?: Partial<Pick<ResponseState, "sessionId" | "respondentId" | "seed" | "embedded">>,
): ResponseState {
  return {
    surveyId: def.meta.id,
    surveyVersion: def.meta.version,
    sessionId: opts?.sessionId ?? cryptoRandomId(),
    respondentId: opts?.respondentId,
    seed: opts?.seed ?? Math.floor(Math.random() * 2 ** 31),
    startedAt: new Date().toISOString(),
    status: "in_progress",
    answers: {},
    embedded: { ...(opts?.embedded ?? {}) },
    calculated: {},
    flags: [],
    stepIndex: 0,
  };
}

export function cryptoRandomId(): string {
  const bytes =
    typeof crypto !== "undefined" && "getRandomValues" in crypto
      ? crypto.getRandomValues(new Uint8Array(12))
      : new Uint8Array(12).map(() => Math.floor(Math.random() * 256));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Answer key for a question, disambiguated inside a loop iteration. */
export function answerKey(questionId: string, loop?: LoopContext | null): string {
  return loop ? `${questionId}@${loop.code}` : questionId;
}

export function getQuestion(def: SurveyDefinition, id: string): Question | undefined {
  return def.questions.find((q) => q.id === id);
}

export function getQuestionByCodeOrVar(
  def: SurveyDefinition,
  ref: string,
): Question | undefined {
  return def.questions.find(
    (q) => q.id === ref || q.code === ref || q.variableName === ref,
  );
}
