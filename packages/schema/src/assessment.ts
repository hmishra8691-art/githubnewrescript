import { z } from "zod";

/**
 * ASSESSMENTS (2026-10-25, docs/ASSESSMENTS-2026-10-25.md) — practice papers,
 * quizzes and knowledge tests (UPSC Prelims style) scored deterministically on
 * the SERVER after submission.
 *
 * Two optional, backward-compatible pieces:
 *
 *   question.assessment   the answer key and the marking of ONE question —
 *                         correct option code(s), marks, negative marks,
 *                         topic tags, the explanation and per-option
 *                         "why this is wrong" notes.
 *   def.assessment        the paper: on/off, default marking (UPSC +2 /
 *                         −0.66), partial credit for multi-answer questions,
 *                         pass mark, when results are shown, which report
 *                         sections the respondent sees, weak-area threshold.
 *
 * SECRETS: `correct`, `explanation` and `optionExplanations` are the answer
 * key. They live in the stored survey / version only; every definition sent
 * to a respondent (live, test link, preview "as a respondent") goes through
 * `stripAssessmentSecrets` (packages/engine/src/assessment.ts), which removes
 * them and sets `withheld: true` so a renderer can tell "key withheld" from
 * "no key authored". The one exception is `showResults: "per_question"`,
 * which by definition reveals the key in the browser (documented, warned in
 * the Studio).
 */

export const AssessmentDifficulty = z.enum(["easy", "medium", "hard"]);

export const QuestionAssessment = z.object({
  /** the correct option code(s); several = a multi-answer question */
  correct: z.array(z.union([z.string(), z.number()])).default([]),
  /** marks for a fully correct answer (absent = the paper's default) */
  marks: z.number().optional(),
  /** marks DEDUCTED for a wrong answer, as a positive number (UPSC 0.66); absent = the paper's default */
  negativeMarks: z.number().min(0).optional(),
  /** multi-answer credit; absent = the paper's default */
  partialCredit: z.enum(["none", "proportional", "proportional_no_wrong"]).optional(),
  /** subject / topic tag ("Polity", "Economy") — drives the topic report */
  topic: z.string().optional(),
  subtopic: z.string().optional(),
  difficulty: AssessmentDifficulty.optional(),
  /** why the correct answer is correct */
  explanation: z.string().optional(),
  /** per-option "why this one is wrong" (keyed by option code) */
  optionExplanations: z.record(z.string()).optional(),
  /** excluded from scoring (an ungraded / survey question inside the paper) */
  ungraded: z.boolean().optional(),
  /** set by `stripAssessmentSecrets`: the key exists but was withheld from this payload */
  withheld: z.boolean().optional(),
});
export type QuestionAssessment = z.infer<typeof QuestionAssessment>;

export const AssessmentReportSections = z.object({
  /** score, percentage, pass/fail */
  summary: z.boolean().default(true),
  /** every question: selected, correct, marks */
  perQuestion: z.boolean().default(true),
  /** the explanation (and the mistake explanation for the chosen option) */
  explanations: z.boolean().default(true),
  /** attempted / correct / accuracy / marks per topic */
  topicBreakdown: z.boolean().default(true),
  /** lowest-accuracy topics below the threshold */
  weakAreas: z.boolean().default(true),
  /** recommended revision topics */
  recommendations: z.boolean().default(true),
});
export type AssessmentReportSections = z.infer<typeof AssessmentReportSections>;

export const AssessmentSettings = z.object({
  enabled: z.boolean().default(true),
  title: z.string().optional(),
  /** marks for a correct answer when the question names none */
  defaultMarks: z.number().default(1),
  /** marks deducted for a wrong answer when the question names none (positive number) */
  defaultNegativeMarks: z.number().min(0).default(0),
  partialCredit: z.enum(["none", "proportional", "proportional_no_wrong"]).default("none"),
  /** pass at this percentage of the maximum marks … */
  passPercent: z.number().min(0).max(100).optional(),
  /** … or at this many marks (wins over passPercent when both are set) */
  passMarks: z.number().optional(),
  /**
   * after_submit  the report after the final save, from the server's result (default)
   * never         scored and stored for the researcher; the respondent sees only the thank-you
   * per_question  right/wrong after each answer — the key is necessarily in the browser
   */
  showResults: z.enum(["after_submit", "never", "per_question"]).default("after_submit"),
  report: AssessmentReportSections.default({}),
  /** a topic is weak below this accuracy (percent of attempted answered correctly) */
  weakThreshold: z.number().min(0).max(100).default(60),
  /** … counting unattempted questions as wrong when true */
  weakCountsUnattempted: z.boolean().default(true),
  /** how many weak topics the report names at most */
  maxWeakAreas: z.number().int().min(1).max(50).default(5),
  /** restrict the report's per-question section to these question ids (absent = every graded question) */
  reportQuestionIds: z.array(z.string()).optional(),
  /** the number of graded questions the paper is meant to have (validation) */
  expectedQuestions: z.number().int().min(1).optional(),
});
export type AssessmentSettings = z.infer<typeof AssessmentSettings>;
