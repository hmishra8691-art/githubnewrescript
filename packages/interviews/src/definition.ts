import {
  parseSurvey, type Condition, type Question as SurveyQuestion, type SkipRule, type SurveyDefinition,
} from "@rescript/schema";
import {
  advance, compileFlow, createResponseState, evaluateCondition, hashString, resumeAt, start,
  visibleQuestions, type ResponseState, type RuntimeStep,
} from "@rescript/engine";
import type { QuestionKind } from "./authoring.js";

/**
 * THE ONE ADAPTER THAT UNLOCKS THE ENGINE.
 *
 * `packages/engine` already implements everything the brief's sections 11 and
 * 12 ask for — one condition language, thirty-eight operators, arbitrary
 * nesting, skip rules, branch nodes, seeded randomization — and it is pure:
 * one dependency, no database, no React. It wants a single JSON document
 * (`SurveyDefinition`) and a small state object (`ResponseState`). The
 * interviews app stores questions as relational rows. This file is the
 * projection between the two, and it is the only place that knows both shapes.
 *
 * ## What the projection is, precisely
 *
 * One page per question, in the DRAWN order. The draw — which pool questions
 * this candidate got, in what order — is decided once at invitation by
 * `drawSequence` and frozen in `interviews.question_sequence`; that is the
 * audit property the brief wants and the engine does not have. The engine is
 * then handed that frozen sequence and evaluates display and skip logic over
 * it LIVE, against the candidate's answers so far. Two responsibilities, two
 * mechanisms, one seam: `toSurveyDefinition` takes the sequence as given.
 *
 * ## What is deliberately NOT projected
 *
 * Nothing about video. The engine knows a `video` question as a `Question`
 * with `type: "video"` that it never needs to render; whether it is answered
 * is a fact the runtime writes into `ResponseState.answers` as a marker. The
 * engine decides what is shown next. It does not decide how anything is
 * recorded, uploaded, or verified — that stays where it is.
 *
 * ## The kind → type mapping
 *
 * `Question.type` in the schema is an open string resolved against a
 * registry, so the interview kinds pass through under names the survey side
 * already understands where one exists and under their own name where not.
 * The engine's `visibleQuestions` filters out `hidden`, `calculated` and
 * `embedded_data`; none of these are.
 */
export const KIND_TO_TYPE: Record<QuestionKind | "long_text" | "single_choice" | "multi_choice" | "code", string> = {
  video: "video",
  audio: "audio",
  text: "open_text",
  long_text: "long_text",
  single_choice: "single_select",
  multi_choice: "multi_select",
  /* a legal open type today; the renderer has no component for it, this app does */
  code: "code_editor",
};

export type FlowKind = keyof typeof KIND_TO_TYPE;

export function isFlowKind(v: unknown): v is FlowKind {
  return typeof v === "string" && v in KIND_TO_TYPE;
}

/** The choice kinds — the ones whose answers are option codes rather than words or media. */
export const CHOICE_KINDS: readonly FlowKind[] = ["single_choice", "multi_choice"];
/** The kinds a respondent types rather than records. */
export const TYPED_KINDS: readonly FlowKind[] = ["text", "long_text", "code"];
/** The kinds that need a microphone, and possibly a camera. */
export const RECORDED_KINDS: readonly FlowKind[] = ["video", "audio"];

export interface FlowQuestion {
  id: string;
  code: string;
  kind: FlowKind;
  prompt: string;
  required: boolean;
  options?: readonly { code: string; label: string }[] | null;
  visibleIf?: Condition | null;
  skipLogic?: readonly SkipRule[] | null;
}

export interface FlowProject {
  id: string;
  name: string;
}

/**
 * Project interview rows into the engine's document.
 *
 * `sequence` is the drawn question order for THIS interview — ids only. Any
 * id that does not resolve to a question is dropped rather than failing: a
 * question archived between invitation and sitting must not strand the
 * candidate on a page that does not exist, and the runtime already treats a
 * short sequence as the sequence.
 */
export function toSurveyDefinition(
  project: FlowProject,
  questions: readonly FlowQuestion[],
  sequence: readonly string[],
): SurveyDefinition {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = sequence.map((id) => byId.get(id)).filter((q): q is FlowQuestion => !!q);

  const surveyQuestions = ordered.map((q) => ({
    id: q.id,
    code: q.code,
    variableName: q.code,
    type: KIND_TO_TYPE[q.kind],
    text: q.prompt,
    required: q.required,
    options: (q.options ?? []).map((o) => ({ code: o.code, label: o.label })),
    displayLogic: q.visibleIf ?? undefined,
    skipLogic: (q.skipLogic ?? []).map((r) => ({ ...r })),
  }));

  /*
   * One page per question, id-stable: the page id IS the question id, so a
   * skip target of `{ kind: "question", ref }` and `{ kind: "page", ref }`
   * resolve to the same place and a builder does not have to choose.
   */
  const flow = ordered.map((q) => ({
    type: "page" as const,
    id: q.id,
    questionIds: [q.id],
  }));

  /*
   * `parseSurvey`, not a cast. The zod schema fills every default the engine
   * expects — `calculations`, `displayRules`, `quotas`, the lot — and refuses
   * a malformed condition here, at build time, rather than letting
   * `evaluateCondition` meet it in front of a candidate. A definition that
   * does not parse is a bug in this file or in stored logic, and either is
   * better found now.
   */
  return parseSurvey({
    meta: { id: project.id, code: "INTERVIEW", title: project.name, version: "1" },
    questions: surveyQuestions,
    flow,
  });
}

/* ------------------------------------------------------------------ state */

/**
 * What the engine needs to know about an answer.
 *
 * A recorded answer has no value the condition language can compare, so it is
 * marked with the literal `"answered"` — enough for `is_answered` /
 * `is_not_answered` operators, which is what an interviewer means by "if they
 * answered Q3, ask Q4". A typed answer is its text. A choice is its code or
 * codes, so `eq`, `in`, `contains` and the rest work as they do on a survey.
 */
export interface AnsweredResponse {
  questionId: string;
  status: string;
  answerKind?: string | null;
  answerText?: string | null;
  answerValue?: unknown;
}

export function toResponseState(
  def: SurveyDefinition,
  interview: { id: string; seed: string | number | null | undefined },
  responses: readonly AnsweredResponse[],
): ResponseState {
  const seed = typeof interview.seed === "number"
    ? interview.seed
    : hashString(String(interview.seed ?? interview.id));
  const state = createResponseState(def, { sessionId: interview.id, seed });

  for (const r of responses) {
    if (r.status !== "stored") continue;
    state.answers[r.questionId] = answerValueOf(r);
  }
  return state;
}

export function answerValueOf(r: AnsweredResponse): ResponseState["answers"][string] {
  if (r.answerKind === "single_choice" || r.answerKind === "multi_choice") {
    const v = r.answerValue;
    if (Array.isArray(v)) return v.map(String);
    if (v === null || v === undefined) return null;
    return String(v);
  }
  if (r.answerKind === "text" || r.answerKind === "long_text" || r.answerKind === "code") {
    return r.answerText ?? "";
  }
  /* video, audio, or a legacy row with no kind: the fact of an answer */
  return "answered";
}

/* -------------------------------------------------------------- walking */

export interface FlowPosition {
  /** the question to show now, or null when the interview is over */
  questionId: string | null;
  /** index into the compiled steps — persist this, not a question index */
  stepIndex: number;
  done: boolean;
  /** question ids the engine hid on the way here — mark these `skipped` with reason `logic` */
  hiddenByLogic: string[];
  /** a skip rule fired on the question just answered */
  skipped: { questionId: string; ruleId: string }[];
}

/**
 * Where the interview begins.
 *
 * `start` compiles the flow and moves to the first page with a visible
 * question. Every page it passes on the way is a question display logic
 * hid, and those are reported so the runtime can record them as skipped
 * rather than leaving them `pending` for ever — which would make `finish`
 * refuse an interview the candidate had correctly completed.
 */
export function beginFlow(def: SurveyDefinition, state: ResponseState): FlowPosition {
  const nav = start(def, state);
  return positionFrom(def, state, nav.steps, nav.stepIndex, nav.done, 0, nav.triggeredSkips);
}

/**
 * Continue after an answer.
 *
 * `advance` runs the answered question's skip rules and then walks forward
 * past anything display logic hides. The pages between the old index and the
 * new one that were passed over are the hidden ones.
 */
export function continueFlow(def: SurveyDefinition, state: ResponseState): FlowPosition {
  const from = state.stepIndex;
  const nav = advance(def, state);
  return positionFrom(def, state, nav.steps, nav.stepIndex, nav.done, from + 1, nav.triggeredSkips);
}

/**
 * Reopen at a saved position.
 *
 * `resumeAt` is the engine's own answer to the P0 the survey runtime had — a
 * saved index that no longer points at a visible page — and it is reused here
 * rather than re-derived. If the saved step is still a page with a visible
 * question, that is where the candidate lands; otherwise the engine walks
 * forward to the next one.
 */
export function resumeFlow(def: SurveyDefinition, state: ResponseState, savedIndex: number | null): FlowPosition {
  const nav = resumeAt(def, state, {}, savedIndex);
  return positionFrom(def, state, nav.steps, nav.stepIndex, nav.done, 0, nav.triggeredSkips);
}

function positionFrom(
  def: SurveyDefinition,
  state: ResponseState,
  steps: RuntimeStep[],
  stepIndex: number,
  done: boolean,
  scanFrom: number,
  triggeredSkips: { questionId: string; ruleId: string }[],
): FlowPosition {
  const hiddenByLogic: string[] = [];
  const limit = done ? steps.length : stepIndex;
  for (let i = scanFrom; i < limit; i++) {
    const s = steps[i];
    if (s?.kind !== "page") continue;
    /* a page the walk passed: every question on it that logic hid */
    const shown = new Set(visibleQuestions(def, s, state).map((q) => q.id));
    for (const id of s.questionIds) if (!shown.has(id) && !(id in state.answers)) hiddenByLogic.push(id);
  }

  if (done) return { questionId: null, stepIndex, done: true, hiddenByLogic, skipped: triggeredSkips };

  const step = steps[stepIndex];
  const questionId = step?.kind === "page" ? (visibleQuestions(def, step, state)[0]?.id ?? null) : null;
  return { questionId, stepIndex, done: questionId === null, hiddenByLogic, skipped: triggeredSkips };
}

/**
 * Is this question shown, given the answers so far?
 *
 * The same `evaluateCondition` the engine uses, called directly, for the
 * places that need a yes or no about one question without walking the flow —
 * the finish check, and the builder's preview.
 */
export function isShown(def: SurveyDefinition, state: ResponseState, questionId: string): boolean {
  const q = def.questions.find((x) => x.id === questionId) as SurveyQuestion | undefined;
  if (!q) return false;
  return evaluateCondition(q.displayLogic ?? null, { def, state });
}

/**
 * Which questions the candidate is still expected to answer.
 *
 * The server-side truth `finish` needs: required, visible under the current
 * answers, and not yet stored or skipped. A question logic hides is not
 * outstanding whatever its `required` flag says — it was never asked.
 */
export function outstandingQuestions(
  def: SurveyDefinition,
  state: ResponseState,
  responses: readonly { questionId: string; status: string; required: boolean }[],
): string[] {
  const steps = compileFlow(def, state);
  const reachable = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "page") continue;
    for (const q of visibleQuestions(def, s, state)) reachable.add(q.id);
  }
  return responses
    .filter((r) => r.required && reachable.has(r.questionId))
    .filter((r) => r.status !== "stored" && r.status !== "skipped")
    .map((r) => r.questionId);
}

/**
 * Every question id a condition in this project refers to.
 *
 * For the builder: a condition on Q4 that references Q7 is a condition that
 * can never be true when Q4 is asked, because Q7 has not been answered yet.
 * The engine evaluates it as false and hides Q4 for everybody, silently. This
 * lets the builder say so.
 */
export function referencedQuestionIds(c: Condition | null | undefined): string[] {
  if (!c) return [];
  if (c.type === "rule") return c.source.kind === "question" ? [c.source.ref] : [];
  return (c.children ?? []).flatMap((child) => referencedQuestionIds(child));
}

/**
 * Conditions that reference a later question, which can therefore never fire.
 *
 * Returns `{ questionId, refersTo }` for every forward reference in display or
 * skip logic. An empty array means every condition can, in principle, be
 * evaluated with information the candidate has already given.
 */
export function forwardReferences(
  questions: readonly FlowQuestion[],
  sequence: readonly string[],
): { questionId: string; refersTo: string }[] {
  const at = new Map(sequence.map((id, i) => [id, i]));
  const out: { questionId: string; refersTo: string }[] = [];
  for (const q of questions) {
    const mine = at.get(q.id);
    if (mine === undefined) continue;
    const refs = [
      ...referencedQuestionIds(q.visibleIf),
      ...(q.skipLogic ?? []).flatMap((r) => referencedQuestionIds(r.when)),
    ];
    for (const ref of refs) {
      const theirs = at.get(ref);
      if (theirs === undefined || theirs >= mine) out.push({ questionId: q.id, refersTo: ref });
    }
  }
  return out;
}
