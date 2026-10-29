/**
 * A SCORED EXAM AS A DURABLE TASK (K4 2026-10-25, ported onto the base engine 2026-10-29 step 4B —
 * docs/ASSESSMENTS-2026-10-29.md part B). Task kind `scored_exam` (engine.ts `taskKindOf("assessment")`).
 *
 * "100 questions, General Studies, UPSC, answer key, 2 marks, −0.66" — or the production 650-character Hindi brief —
 * is planned as:
 *   assessment.settings (deterministic: set_assessment — the marking read from the request, results after submit,
 *                        every report section on, expectedQuestions = N)
 *   → the generation planner's content batches (`buildGenerationSteps` with `assessment`): each batch's actions are
 *     create_question + ONE set_answer_key per question, checked by the engine's gate with the assessment validator
 *     scoped to the batch before they are kept
 *   → gen.validate (the generation final check, `assessment:N` among its criteria; waits for the settings)
 *   → assessment.validate (deterministic): every respondent question keyed, every key names an existing option,
 *     exactly N graded questions, explanations and topics present.
 * The same check is registered as the completion validator `assessment.validate`, so the task is `completed` only
 * when the final draft passes it (and the base's scored_exam deliverable gate).
 *
 * The production follow-up — "for every question show what was correct, what I selected, explanations and weak
 * areas" (164 s twice, sent to the model) — is NOT a task and NOT a model call: `assessmentReportTurn` answers it
 * deterministically in the turn route with where the results page and the analytics card are, proposing only the
 * `set_assessment` that switches the report on when it is off.
 */
import type { Question, SurveyDefinition } from "@rescript/schema";
import {
  applySurveyActions, assessmentSettings, coerceSurveyActions, gradedQuestions, isRespondentQuestion, readGenerationRequest, seededIds, validateAssessment,
} from "@rescript/engine";
import type { StepContext, StepHandler, StepResult, StepValidation, TaskPlanner, TaskStepSpec, TaskSummary } from "../types.ts";
import { registerCompletionValidator, registerStepHandler, registerTaskPlanner } from "../registry.ts";
import { buildGenerationSteps } from "./generation.ts";
import { assessmentIntent } from "../../copilot/assessmentGuide.ts";

type Def = SurveyDefinition;
const CHOICE = new Set(["single_select", "multi_select", "dropdown", "image_select"]);
const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0 };
const ALL_SECTIONS = { summary: true, perQuestion: true, explanations: true, topicBreakdown: true, weakAreas: true, recommendations: true };

/* ------------------------------------------------------------ reading the request */

export interface Marking { defaultMarks?: number; defaultNegativeMarks?: number; passPercent?: number; title?: string }

/** The paper's marking, read deterministically (UPSC Prelims GS: +2 / −0.66 = one third of 2). */
export function markingFrom(message: string): Marking {
  const m = String(message ?? "");
  const out: Marking = {};
  if (/\bupsc\b|यूपीएससी/i.test(m) && /\bprelim|प्रारंभिक|प्रीलिम्स|\bgs\b|general studies|सामान्य अध्ययन/i.test(m)) { out.defaultMarks = 2; out.defaultNegativeMarks = 0.66; out.title = "UPSC Prelims — General Studies (practice paper)"; }
  const plus = /\+\s*(\d+(?:\.\d+)?)\s*(?:marks?|अंक)?/i.exec(m)
    ?? /(\d+(?:\.\d+)?)\s*marks?\s*(?:for|per)\s*(?:a |each |every )?(?:correct|right|question)/i.exec(m)
    ?? /(?:^|[^−–\-\d.])(\d+(?:\.\d+)?)\s*(?:marks?|अंक)\b(?!\s*(?:for|per)\s*(?:a |each |every )?(?:wrong|incorrect))/i.exec(m);
  if (plus) out.defaultMarks = Number(plus[1]);
  const minus = /[−–-]\s*(\d+(?:\.\d+)?)\s*(?:marks?)?\s*(?:for|per)\s*(?:a |each |every )?(?:wrong|incorrect)/i.exec(m)
    ?? /negative marking (?:of\s*)?[−–-]?\s*(\d+(?:\.\d+)?)/i.exec(m)
    ?? /(?:^|[\s,;(])[−–]\s*(\d+(?:\.\d+)?)\b(?!\s*%)/.exec(m)
    ?? /(?:^|[,;(]\s*)-\s*(\d*\.\d+)\b/.exec(m);
  if (minus) out.defaultNegativeMarks = Number(minus[1]);
  if (/negative marking[^.]{0,40}\b(?:one[- ]third|1\/3)\b|\b(?:one[- ]third|1\/3)\b[^.]{0,40}negative/i.test(m)) out.defaultNegativeMarks = Math.round(((out.defaultMarks ?? 1) / 3) * 100) / 100;
  if (/\bno negative marking\b/i.test(m)) out.defaultNegativeMarks = 0;
  const pass = /pass(?:ing)?(?: mark| marks| score| percentage)?\s*(?:of|at|is|=|:)?\s*(\d{1,3})\s*%/i.exec(m);
  if (pass) out.passPercent = Math.min(100, Number(pass[1]));
  return out;
}

/**
 * A new paper: "create a 100-question UPSC paper …", or the terse "100 questions, General Studies, UPSC, answer key,
 * 2 marks, −0.66" (no verb, no "exam": the generation reader calls it `none`, but a count with exam words on a
 * survey that does not already have that many questions is a paper to build).
 */
const examRequest = (message: string, survey: unknown) => {
  const req = readGenerationRequest(message, survey);
  if (!req.assessment || req.translation || req.method || !(req.count && req.count >= 1)) return null;
  if (req.kind === "generate") return req;
  const have = Array.isArray((survey as Def | null)?.questions) ? (survey as Def).questions.length : 0;
  if (req.kind === "none" && req.count > have && /\b(?:questions?|mcqs?)\b|प्रश्न|सवाल/i.test(message)) return { ...req, kind: "generate" as const };
  return null;
};

/* ------------------------------------------------------------ the check (step + completion validator) */

/**
 * Every respondent question keyed (or explicitly ungraded), every key on an existing option (validateAssessment),
 * exactly `expected` graded questions, explanations and topics present, the paper switched on.
 */
export function examValidation(def: Def, expected?: number): StepValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!assessmentSettings(def)) errors.push("The survey is not switched on as a test (set_assessment enabled).");
  const unkeyed = (def.questions ?? []).filter((q) => isRespondentQuestion(q) && !q.settings?.hidden && !q.assessment);
  if (unkeyed.length) errors.push(`${unkeyed.length} respondent question${unkeyed.length === 1 ? " has" : "s have"} no answer key: ${unkeyed.slice(0, 8).map((q) => q.code).join(", ")}${unkeyed.length > 8 ? ` (+${unkeyed.length - 8})` : ""}.`);
  const notChoice = gradedQuestions(def).filter((q) => !CHOICE.has(q.type));
  if (notChoice.length) errors.push(`${notChoice.length} keyed question${notChoice.length === 1 ? " is" : "s are"} not a choice question and cannot be scored: ${notChoice.slice(0, 5).map((q) => q.code).join(", ")}.`);
  const v = validateAssessment(def, { ...(expected ? { expectedCount: expected } : {}), requireExplanations: true, requireTopics: true });
  errors.push(...v.errors.map((e) => e.message));
  warnings.push(...v.warnings.map((w) => w.message));
  const graded = gradedQuestions(def).length;
  if (expected && graded !== expected && !v.errors.some((e) => e.code === "count_mismatch")) errors.push(`The paper has ${graded} graded questions; ${expected} were asked for.`);
  return { ok: errors.length === 0, errors: [...new Set(errors)].slice(0, 40), warnings: [...new Set(warnings)].slice(0, 20) };
}

const expectedFrom = (completion: readonly string[]): number | undefined => {
  for (const l of completion) { const m = /^assessment:(\d+)$/i.exec(String(l).trim()); if (m) return Number(m[1]); }
  return undefined;
};

/* ------------------------------------------------------------ the planner */

export const assessmentPlanner: TaskPlanner = {
  id: "assessment",
  matches({ message, survey }) {
    const req = examRequest(message, survey);
    if (!req) return 0;
    /* ≥ 0.9 forces a task even when the size estimate says small; the generation planner answers an exam at 0.7 */
    return (req.count ?? 0) >= 20 ? 0.95 : 0;
  },
  async plan({ message, survey, summary, ai }) {
    const def = (survey ?? { questions: [], flow: [] }) as Def;
    const req = examRequest(message, survey)!;
    const count = Math.max(1, Math.min(1000, req.count ?? 100));
    const marking = markingFrom(message);
    const g = await buildGenerationSteps({ message, survey: def, count, assessment: { perQuestion: true, optionsCount: 4 }, ai, req, ...(summary ? { summary } : {}) });
    const settings = { op: "set_assessment", enabled: true, showResults: "after_submit", report: ALL_SECTIONS, defaultMarks: marking.defaultMarks ?? 1, defaultNegativeMarks: marking.defaultNegativeMarks ?? 0, ...(marking.passPercent !== undefined ? { passPercent: marking.passPercent } : {}), ...(marking.title ? { title: marking.title } : {}) };
    const steps: TaskStepSpec[] = [{
      id: "assess_settings", kind: "assessment.settings", dependsOn: [], input: { action: settings }, estimate: ZERO,
      title: `Marking: +${settings.defaultMarks}${settings.defaultNegativeMarks ? ` / −${settings.defaultNegativeMarks}` : ""}${marking.passPercent !== undefined ? `, pass ${marking.passPercent}%` : ""}; results after submission`,
    }];
    const validateId = g.steps.find((s) => s.kind === "gen.validate")?.id;
    for (const s of g.steps) steps.push(s.id === validateId ? { ...s, dependsOn: [...new Set([...s.dependsOn, "assess_settings"])] } : s);
    steps.push({ id: "assess_check", kind: "assessment.validate", title: `Answer key check: ${count} questions, every key on a real option`, dependsOn: [...(validateId ? [validateId] : g.steps.map((s) => s.id)), "assess_settings"], input: { expectedCount: count }, estimate: ZERO });
    const completion = [...new Set([...g.completion.filter((c) => !/^assessment/i.test(c)), `assessment:${count}`])];
    const s: TaskSummary = {
      ...g.summary,
      deliverables: [...new Set([...g.summary.deliverables, `${count} questions, each with an answer key, topic and explanation`, "the marking and the respondent's results report (computed on the server after submission)"])],
      decisions: [...g.summary.decisions, `Marking +${settings.defaultMarks} / −${settings.defaultNegativeMarks}; results after submission, scored on the server`].slice(-20),
    };
    return { summary: s, steps, completion };
  },
};

/* ------------------------------------------------------------ handlers */

const done = (actions: unknown[], data: unknown, validation: StepValidation): StepResult => ({ status: "completed", output: { actions, data, validation } });

/** assessment.settings — the paper's marking and results policy, one set_assessment through the engine's gate */
async function runSettings(ctx: StepContext): Promise<StepResult> {
  const action = ctx.step.input.action as Record<string, unknown>;
  const c = coerceSurveyActions([action]);
  if (!c.actions.length) return { status: "failed", permanent: true, reason: `The marking could not be read: ${c.rejected[0]?.reason ?? "unknown"}` };
  const r = applySurveyActions(ctx.draft as Def, c.actions, { ids: seededIds(`${ctx.taskId}:${ctx.step.id}`), lite: true });
  const bad = r.results.filter((x) => !x.ok);
  if (bad.length) return { status: "failed", permanent: true, reason: `The marking was refused: ${bad.map((x) => x.error ?? "").join("; ")}` };
  return done(c.actions, { settings: action }, { ok: true, errors: [], warnings: r.warnings.slice(0, 10) });
}

/** assessment.validate — deterministic: the whole paper keyed, keys on real options, counts exact */
async function runValidate(ctx: StepContext): Promise<StepResult> {
  const expected = Number(ctx.step.input.expectedCount) || undefined;
  const v = examValidation(ctx.draft as Def, expected);
  /* valid: pin the count on the paper (expectedQuestions) so a later edit that drops a question is caught by the
     Studio's validation chip too — pinned only now, because the batches' scoped checks read it as the whole count */
  const pin = v.ok && expected ? [{ op: "set_assessment", expectedQuestions: expected }] : [];
  return done(pin, { graded: gradedQuestions(ctx.draft as Def).length, expected: expected ?? null }, v);
}

const HANDLERS: StepHandler[] = [
  { kind: "assessment.settings", run: runSettings },
  { kind: "assessment.validate", run: runValidate },
];

export function registerAssessmentTasks(): void {
  registerTaskPlanner(assessmentPlanner);
  for (const h of HANDLERS) registerStepHandler(h);
  /* the exam's completion check, on the final draft — only for the tasks this planner made */
  registerCompletionValidator("assessment.validate", (draft, completion, task) => (task.planner === "assessment" ? examValidation(draft as Def, expectedFrom(completion)) : null));
}

/* ------------------------------------------------------------ the follow-up: deterministic, no model call */

/** "for every question show what was correct, what I selected, explanations and weak areas" (and Hindi) */
export const REPORT_FOLLOW_UP = /\b(?:for (?:every|each|all(?: the)?) questions?|every question|each question|question[- ]by[- ]question|per[- ]question)\b[\s\S]{0,160}\b(?:correct|right answer|selected|chose|explanations?|weak|report)\b|\b(?:which answer was correct|what (?:was|is) (?:the )?correct|what i (?:selected|chose|answered)|weak (?:areas?|topics?)|results? (?:page|report)|score ?card)\b|(?:हर|प्रत्येक|सभी)\s*(?:प्रश्न|सवाल)[\s\S]{0,80}(?:सही|चुना|व्याख्या|कमजोर)|(?:क्या सही था|मैंने क्या चुना|कमजोर (?:क्षेत्र|विषय))/i;

export interface AssessmentReportTurn { reply: string; actions: Record<string, unknown>[] }

/**
 * The deterministic answer to a request for the per-question results report, or null when the message is not one.
 * Correct / selected / scores / weak areas exist only after a respondent submits, are computed on the server and
 * shown on the results page — nothing to generate. When the paper's report (or the paper) is off, the one
 * `set_assessment` that switches it on is proposed; keys missing on some questions are named, never invented here.
 */
export function assessmentReportTurn(message: string, def: Def): AssessmentReportTurn | null {
  const m = String(message ?? "");
  if (!REPORT_FOLLOW_UP.test(m)) return null;
  /* a request to BUILD something ("create a 100-question paper … and a report of weak areas") is the planner's */
  if (readGenerationRequest(m, def).kind === "generate") return null;
  /* "add a question on weak areas …" asks for a change, not to be shown the report */
  if (/^\s*(?:please\s+)?(?:add|create|build|insert|write|generate|draft|make (?:a|an|the|me)|design)\b/i.test(m)) return null;
  const choice = (def?.questions ?? []).filter((q: Question) => CHOICE.has(q.type) && !q.settings?.hidden);
  if (!choice.length) return null;
  const s = assessmentSettings(def);
  /* only about a paper: the survey is one (or carries keys), or the words are about marking — "weak areas of our product" on a survey is not */
  if (!s && !choice.some((q) => q.assessment) && !assessmentIntent(m)) return null;
  const keyed = choice.filter((q) => q.assessment && !q.assessment.ungraded && (q.assessment.correct ?? []).length > 0);
  const noExplanation = keyed.filter((q) => !(q.assessment?.explanation ?? "").trim()).length;
  const sections = s?.report;
  const reportOff = !s || s.showResults !== "after_submit" || !sections || !sections.perQuestion || !sections.explanations || !sections.weakAreas || !sections.topicBreakdown;
  const actions: Record<string, unknown>[] = reportOff ? [{ op: "set_assessment", enabled: true, showResults: "after_submit", report: ALL_SECTIONS }] : [];
  const lines = [
    "This needs no generation: after a respondent submits, the paper is scored on the server and the results page shows every question with what they selected, the correct answer, the explanation, the topic breakdown and their weak areas.",
    reportOff ? "The proposal below switches that report on (results after submitting, every section)." : "The report is already on (results after submitting, every section).",
    keyed.length < choice.length ? `${choice.length - keyed.length} of ${choice.length} choice questions have no answer key yet, so they cannot be marked: key them under Properties → Assessment, or ask “set the answer key for all questions”.` : `All ${keyed.length} choice questions are keyed.`,
    noExplanation ? `${noExplanation} keyed question${noExplanation === 1 ? " has" : "s have"} no explanation; ask “add explanations to every question” to write them.` : "",
    "Try it: Preview (tick “as a respondent”) or Test Survey, then submit. Scores across respondents, the pass rate, the topic table, the item analysis and the Word answer key are in Data Analytics → Assessment results.",
  ].filter(Boolean);
  return { reply: lines.join(" "), actions };
}
