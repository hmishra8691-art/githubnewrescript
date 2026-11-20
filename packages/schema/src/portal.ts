import { z } from "zod";

/**
 * THE RESPONDENT PORTAL, PER SURVEY (Respondent Intelligence Engine, phase 1, 2026-11-20).
 *
 * Optional and absent on every survey made before it: a survey without `portal` (or with `enabled: false`) behaves
 * exactly as it always has, and its links are untouched. With it, the people on the respondent list who have a
 * portal account see this survey after signing in, and the researcher decides here what they may see and change.
 *
 * Everything here is a PERMISSION the researcher grants; the default of each is the careful one (see nothing extra,
 * change nothing). The decisions themselves are `@rescript/engine` portalPolicy.ts — one function per question
 * ("may this answer be edited now?"), used by the portal and by the Studio's preview of it.
 */
export const PortalEditing = z.object({
  /**
   * none            answers are final at submission
   * until_deadline  editable until `deadline`
   * window          editable for `windowHours` after each submission
   * until_locked    editable until the researcher locks the respondent's assessment (or all of them)
   */
  mode: z.enum(["none", "until_deadline", "window", "until_locked"]).default("none"),
  deadline: z.string().datetime().optional(),
  windowHours: z.number().positive().max(24 * 365).optional(),
  /** question ids that can never be edited (a screener, a consent) */
  lockedQuestions: z.array(z.string()).max(2000).default([]),
  /** section / block / page ids whose questions can never be edited */
  lockedSections: z.array(z.string()).max(500).default([]),
  /** when present, ONLY these questions can be edited */
  onlyQuestions: z.array(z.string()).max(2000).optional(),
  /** the researcher locked every respondent's answers at this moment (until_locked) */
  lockedAt: z.string().datetime().optional(),
});
export type PortalEditing = z.infer<typeof PortalEditing>;

/* ------------------------------------------------------------------ the scorecard (phase 2) */

/**
 * WHERE ONE SCORE COMES FROM. A scorecard does not score anything a second time: a knowledge test is marked by the
 * assessment engine and a scale is usually a calculated variable already; a dimension POINTS at one of them.
 *
 *   test_total   the paper's marks                      (def.assessment)
 *   test_topic   the marks of one topic of the paper
 *   variable     a calculated variable, by its code     (the validated scales in the template library make these)
 *   items        answers added up or averaged here, for a scale with no calculated variable of its own
 */
export const ScoreItem = z.object({
  question: z.string().min(1).max(200),
  /** a grid's row, when the item is one row of a grid */
  row: z.union([z.string(), z.number()]).optional(),
  /** a reverse-keyed item: counted as (lowest + highest − answer) */
  reverse: z.boolean().default(false),
});
export const ScoreSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test_total") }),
  z.object({ kind: z.literal("test_topic"), topic: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("variable"), name: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("items"), method: z.enum(["sum", "mean"]).default("sum"), items: z.array(ScoreItem).min(1).max(400) }),
]);
export type ScoreSource = z.infer<typeof ScoreSource>;

/** a named range of a score: everything above the previous band's `upTo`, up to and including this one's */
export const ScoreBand = z.object({
  upTo: z.number(),
  label: z.string().min(1).max(80),
  /** what the range means, in the respondent's words — never a diagnosis */
  note: z.string().max(600).optional(),
});
export type ScoreBand = z.infer<typeof ScoreBand>;

export const ScoreDimension = z.object({
  id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  description: z.string().max(600).optional(),
  source: ScoreSource,
  /** the lowest and highest possible score; worked out for a test and for items, needed for a variable to draw a bar */
  min: z.number().optional(),
  max: z.number().optional(),
  /** false for a score where less is better (stress, errors): comparisons are worded the other way round */
  higherIsBetter: z.boolean().default(true),
  bands: z.array(ScoreBand).max(12).default([]),
});
export type ScoreDimension = z.infer<typeof ScoreDimension>;

export const PortalScorecard = z.object({
  dimensions: z.array(ScoreDimension).max(40).default([]),
  /** one headline figure: the average position (0–100) across the dimensions that could be scored */
  overall: z.object({ label: z.string().min(1).max(120).default("Overall") }).optional(),
});
export type PortalScorecard = z.infer<typeof PortalScorecard>;

/**
 * COMPARISON WITH OTHER PEOPLE. A respondent only ever sees a figure about a GROUP, and only when the group has at
 * least `minCohort` people: 10 is the floor and cannot be lowered (decision of 2026-11-20).
 */
export const BENCHMARK_FLOOR = 10;
export const BenchmarkGroup = z.object({
  id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  /** what splits people into groups: a single-choice question (by id) or a field of the respondent list */
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("question"), ref: z.string().min(1).max(200) }),
    z.object({ kind: z.literal("embedded"), ref: z.string().min(1).max(200) }),
  ]),
});
export type BenchmarkGroup = z.infer<typeof BenchmarkGroup>;
export const PortalBenchmark = z.object({
  enabled: z.boolean().default(false),
  minCohort: z.number().int().min(BENCHMARK_FLOOR).max(100000).default(BENCHMARK_FLOOR),
  groups: z.array(BenchmarkGroup).max(6).default([]),
});
export type PortalBenchmark = z.infer<typeof PortalBenchmark>;

export const PortalSettings = z.object({
  enabled: z.boolean().default(false),
  /**
   * persistent   one account for the person, across the surveys they are invited to
   * assessment   an account made for this survey alone, which ends with it
   */
  identity: z.enum(["persistent", "assessment"]).default("persistent"),
  /** what the respondent sees after signing in */
  show: z.object({
    /** their own submitted answers */
    answers: z.boolean().default(false),
    /** the questionnaire of earlier attempts */
    history: z.boolean().default(false),
    /** their own scores (the scorecard below) */
    scores: z.boolean().default(false),
    /** the named range each score falls in */
    bands: z.boolean().default(true),
    /** how their scores compare with everyone's and with their own group's */
    comparison: z.boolean().default(false),
  }).default({}),
  /** phase 2: what is scored, and how it is compared. Absent = this survey shows no scores in the portal. */
  scorecard: PortalScorecard.optional(),
  benchmark: PortalBenchmark.default({}),
  editing: PortalEditing.default({}),
  /** null / absent = the survey's own rule (one attempt, or unlimited with allowRetake) */
  maxAttempts: z.number().int().min(1).max(1000).optional(),
  /** the portal template this survey presents as (phase 4); absent = the standard portal */
  template: z.string().max(60).optional(),
});
export type PortalSettings = z.infer<typeof PortalSettings>;
