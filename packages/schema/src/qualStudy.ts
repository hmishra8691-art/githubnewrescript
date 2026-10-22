import { z } from "zod";
import { AiModeration } from "./aiInterview.js";

/**
 * THE QUALITATIVE STUDY (2026-10-18) — the plan of a moderated in-depth
 * interview (IDI) or focus-group study: objectives, protocol, the interview
 * or discussion guide (sections with timing, opening and closing scripts,
 * main questions, follow-up probes, conditional probes, moderator
 * instructions, ground rules, exercises, concept evaluation), screening
 * criteria, consent and recording disclosures, participant segments and the
 * session plan.
 *
 * It is the DESIGN of a study run by a human moderator, stored on the survey
 * definition beside `research` so it is versioned, cloned, previewed and
 * undone with it, and so Intelligent Mode edits it through the same gated,
 * previewed actions (`create_qual_guide` / `update_qual_guide`). The data the
 * study produces — sessions, recordings, transcripts, codes and excerpts — is
 * not here: it is sensitive, grows without bound and is decided by the Data
 * module's permissions, so it lives in its own tables (migration 0065).
 *
 * Nothing here runs a live session: Rescript has no conferencing or real-time
 * moderation. Absent on every survey that never had one.
 */

export const QualConditionalProbe = z.object({
  /** what the participant says or does that triggers it ("mentions price") */
  ifMentions: z.string(),
  /** what the moderator then asks */
  ask: z.string(),
});
export type QualConditionalProbe = z.infer<typeof QualConditionalProbe>;

export const QualGuideQuestion = z.object({
  id: z.string(),
  text: z.string(),
  /** follow-up probes the moderator may use */
  probes: z.array(z.string()).default([]),
  /** "if the participant mentions X → ask Y" */
  conditionalProbes: z.array(QualConditionalProbe).default([]),
  /** a note to the moderator about this question (not read aloud) */
  moderatorNote: z.string().optional(),
  minutes: z.number().nonnegative().optional(),
});
export type QualGuideQuestion = z.infer<typeof QualGuideQuestion>;

export const QUAL_SECTION_KINDS = ["opening", "warm_up", "main", "exercise", "concept", "closing"] as const;
export const QualSectionKind = z.enum(QUAL_SECTION_KINDS);
export type QualSectionKind = z.infer<typeof QualSectionKind>;

export const QualExercise = z.object({
  title: z.string(),
  instructions: z.string().optional(),
  materials: z.array(z.string()).default([]),
});
export type QualExercise = z.infer<typeof QualExercise>;

export const QualGuideSection = z.object({
  id: z.string(),
  title: z.string(),
  kind: QualSectionKind.default("main"),
  minutes: z.number().nonnegative().optional(),
  /** why the section exists — the objective or research question it serves */
  purpose: z.string().optional(),
  /** what the moderator says (the opening and closing scripts, transitions) */
  script: z.string().optional(),
  /** instructions to the moderator */
  instructions: z.array(z.string()).default([]),
  questions: z.array(QualGuideQuestion).default([]),
  /** a task the participants do (card sort, collage, projective technique) */
  exercise: QualExercise.optional(),
  /** concepts or stimuli shown for evaluation, by name */
  stimuli: z.array(z.string()).default([]),
});
export type QualGuideSection = z.infer<typeof QualGuideSection>;

export const QualScreeningCriterion = z.object({
  criterion: z.string(),
  rule: z.enum(["include", "exclude"]).default("include"),
  /** a quota on it, in words ("at least 3 per group") */
  quota: z.string().optional(),
});
export type QualScreeningCriterion = z.infer<typeof QualScreeningCriterion>;

export const QualParticipantSegment = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** participants (IDIs) or groups (focus groups) planned for the segment */
  target: z.number().int().nonnegative().optional(),
});
export type QualParticipantSegment = z.infer<typeof QualParticipantSegment>;

export const QualConsent = z.object({
  /** the consent statement read or shown before the session */
  statement: z.string().optional(),
  /** what is recorded (audio / video / screen), who sees it, how long it is kept */
  recordingDisclosure: z.string().optional(),
  /** how the data are used and reported (anonymised quotes, no attribution) */
  dataUse: z.string().optional(),
});
export type QualConsent = z.infer<typeof QualConsent>;

export const QualSessionPlan = z.object({
  sessions: z.number().int().nonnegative().optional(),
  participantsPerSession: z.number().int().nonnegative().optional(),
  /** where and how: "remote video call", "in-person viewing facility" */
  mode: z.enum(["in_person", "remote", "phone", "mixed"]).optional(),
  notes: z.string().optional(),
});
export type QualSessionPlan = z.infer<typeof QualSessionPlan>;

export const QualStudy = z.object({
  kind: z.enum(["interview", "focus_group"]),
  title: z.string().optional(),
  objectives: z.array(z.string()).default([]),
  /** the protocol in words: who moderates, how a session runs, what is recorded */
  protocol: z.string().optional(),
  durationMinutes: z.number().int().positive().optional(),
  /** focus groups: the ground rules read at the start */
  groundRules: z.array(z.string()).default([]),
  screening: z.array(QualScreeningCriterion).default([]),
  consent: QualConsent.default({}),
  segments: z.array(QualParticipantSegment).default([]),
  sessionPlan: QualSessionPlan.default({}),
  sections: z.array(QualGuideSection).default([]),
  /** 2026-10-22: run this interview guide as AI-moderated 1:1 interviews (aiInterview.ts); absent = not configured */
  aiModeration: AiModeration.optional(),
  updatedAt: z.string().optional(),
});
export type QualStudy = z.infer<typeof QualStudy>;
