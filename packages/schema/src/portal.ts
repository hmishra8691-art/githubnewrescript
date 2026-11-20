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
  }).default({}),
  editing: PortalEditing.default({}),
  /** null / absent = the survey's own rule (one attempt, or unlimited with allowRetake) */
  maxAttempts: z.number().int().min(1).max(1000).optional(),
  /** the portal template this survey presents as (phase 4); absent = the standard portal */
  template: z.string().max(60).optional(),
});
export type PortalSettings = z.infer<typeof PortalSettings>;
