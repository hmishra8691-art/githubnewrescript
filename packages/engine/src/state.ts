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
  | Record<string, unknown>
  // repeating groups, timeline reactions, multi-file uploads
  | Array<Record<string, unknown>>;

/** A reference value as the loop's table holds it, typed per column. */
export type LoopReferenceValue = string | number | boolean | null;

/**
 * THE CURRENT ITEM — everything a question inside a loop iteration can know
 * about where it is.
 *
 * `code`, `label`, `index` are what the context always was. The rest is what
 * turns a loop from "repeat this block" into a programmable construct:
 *
 *   references   the item's row of the loop's own reference table
 *                (`{{loop.Product_ID}}`, `loop.Category = "Smartphone"`).
 *                Present only for columns THIS loop defines — a loop over the
 *                same question elsewhere has its own, and the two never meet.
 *   count        how many iterations this loop is running, for "2 of 3".
 *   parent       the enclosing iteration when loops nest. Contexts form a
 *                stack, innermost first; `{{loop.x}}` reads this one and
 *                `{{<outer loopVar>.x}}` walks up to the one named.
 *
 * The four new fields are optional so that every existing place that builds a
 * bare `{ loopVar, code, label, index }` — the carry-forward shim in
 * evaluate.ts, tests, the inspector's snapshot — keeps compiling and keeps
 * meaning exactly what it meant.
 */
export interface LoopContext {
  loopVar: string;
  code: string;
  label: string;
  index: number; // 1-based
  loopId?: string;
  count?: number;
  references?: Record<string, LoopReferenceValue>;
  parent?: LoopContext | null;
}

/**
 * The suffix that scopes an answer or page id to an iteration.
 *
 * `@apple` for a single loop — unchanged from before, so nothing stored under
 * the old convention moves. For nested loops the codes stack outermost first,
 * `@apple@pro`, so an inner iteration's answer can never overwrite the same
 * question's answer in another outer iteration — which is exactly what
 * happened before, when the inner context simply replaced the outer one.
 */
export function loopKeySuffix(loop?: LoopContext | null): string {
  if (!loop) return "";
  const codes: string[] = [];
  for (let l: LoopContext | null | undefined = loop; l; l = l.parent) codes.unshift(l.code);
  return codes.map((c) => `@${c}`).join("");
}

/**
 * Every key under which an answer to `questionId` could live, seen from this
 * iteration, deepest first: `q@apple@pro`, then `q@apple`, then `q`.
 *
 * This is the one statement of "loop-local wins, then the enclosing
 * iteration's, then the survey-level answer". A question that sits in the outer
 * loop's body is reached from inside the inner loop through the middle key; a
 * question outside every loop through the last. Before this there were six
 * hand-written copies of the two-key version, and none of them could see an
 * outer loop at all.
 */
export function answerLookupKeys(questionId: string, loop?: LoopContext | null): string[] {
  const keys: string[] = [];
  for (let l: LoopContext | null | undefined = loop; l; l = l.parent) {
    keys.push(`${questionId}${loopKeySuffix(l)}`);
  }
  keys.push(questionId);
  return keys;
}

/** The answer to `questionId` as seen from this iteration — see `answerLookupKeys`. */
export function lookupAnswer(
  answers: Record<string, AnswerValue>,
  questionId: string,
  loop?: LoopContext | null,
): AnswerValue | undefined {
  for (const k of answerLookupKeys(questionId, loop)) {
    if (answers[k] !== undefined) return answers[k];
  }
  return undefined;
}

/** The built-in properties of a loop item, which no reference column may shadow. */
export const LOOP_BUILTIN_REFS = ["code", "label", "index", "count"] as const;

/**
 * ONE item property, by name — the single place `{{loop.X}}`, `loop.X = …`,
 * `getCurrentLoopReference("X")` and the inspector agree on what `X` means.
 *
 * `code`, `label`, `index`, `count` are the item's own; anything else is looked
 * up in THIS loop's reference row and is `null` when the loop declares no such
 * column. It is not the label, which is what an unknown name used to render —
 * a `{{loop.Category}}` on a loop with no `Category` column silently piped the
 * brand name into the sentence, and that is precisely the kind of quiet wrong
 * answer a survey cannot afford. The lint names the unknown column instead.
 */
export function loopValue(loop: LoopContext, ref: string): LoopReferenceValue {
  switch (ref) {
    case "code": return loop.code;
    case "label": return loop.label;
    case "index": return loop.index;
    case "count": return loop.count ?? null;
    default: {
      const refs = loop.references;
      return refs && Object.prototype.hasOwnProperty.call(refs, ref) ? refs[ref] : null;
    }
  }
}

/**
 * The loop context a `scope` names, walking outwards by `loopVar`. Absent
 * scope means the innermost — what a rule or token written inside a single
 * loop has always meant. Unknown scope means null, never a silent fallback to
 * some other loop.
 */
export function findLoopScope(loop: LoopContext | null | undefined, scope?: string | null): LoopContext | null {
  if (!loop) return null;
  if (!scope) return loop;
  for (let l: LoopContext | null | undefined = loop; l; l = l.parent) {
    if (l.loopVar === scope) return l;
  }
  return null;
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

/** Answer key for a question, disambiguated inside a loop iteration (and its parents). */
export function answerKey(questionId: string, loop?: LoopContext | null): string {
  return `${questionId}${loopKeySuffix(loop)}`;
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
