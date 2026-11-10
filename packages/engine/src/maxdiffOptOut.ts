/**
 * MAXDIFF TASK OPT-OUTS (2026-11-10) — "None of these", "No preference", "I cannot choose".
 *
 * A MaxDiff task forces a best and a worst. For some lists that is wrong for some respondents: nothing in the set
 * appeals, or the items in it are the same to them, or they cannot judge. Forced answers there are noise in the
 * utilities. An opt-out lets the respondent say so, per task.
 *
 * What an opt-out IS, everywhere in the platform:
 *
 *   design          a switch on the DESIGN's config (like anchoring) — never a row of the design file and never an
 *                   item: it is not shown in rotation, has no show count, and the balance is computed without it
 *   questionnaire   one control under each set; choosing it clears the best / worst of that set and choosing a best
 *                   or worst clears it; it completes the task for a required question
 *   answer          `{ optOut: "<kind>" }` for that task — no best, no worst
 *   data            `<VAR>_T<n>_OPTOUT` (the kind), beside `_BEST` / `_WORST`, which are empty for that task; the long
 *                   choice file carries the task's items with OPT_OUT set and BEST / WORST empty
 *   analysis        the task is not a choice observation: it is left out of the counts and of the logit, and the
 *                   number of tasks opted out is reported by kind. The three kinds differ in what they MEAN:
 *                     none            substantive — no item in the set clears the respondent's bar. In an ANCHORED
 *                                     design it is the same statement as the anchor answer "none", and is used as one
 *                     no_preference   substantive — the items are equal to this respondent; no ranking information
 *                     cannot_choose   non-substantive — treated as item non-response for that task
 *
 * Read from the design's config in one place (here) so the generator, the renderer, the validator, the data map, the
 * exports and the analysis cannot disagree about which opt-outs a design offers or what they are called.
 */
export const MAXDIFF_OPT_OUTS = ["none", "no_preference", "cannot_choose"] as const;
export type MaxDiffOptOut = (typeof MAXDIFF_OPT_OUTS)[number];

export const MAXDIFF_OPT_OUT_LABELS: Record<MaxDiffOptOut, string> = {
  none: "None of these",
  no_preference: "No preference between these",
  cannot_choose: "I cannot choose",
};
export const MAXDIFF_OPT_OUT_MEANING: Record<MaxDiffOptOut, string> = {
  none: "substantive: no item in the set matters to the respondent",
  no_preference: "substantive: the items in the set are equal to the respondent",
  cannot_choose: "non-substantive: the respondent could not answer this set",
};
/** the design config's keys: one switch and one optional label per kind */
export const MAXDIFF_OPT_OUT_KEYS: Record<MaxDiffOptOut, { on: string; label: string }> = {
  none: { on: "optOutNone", label: "optOutNoneLabel" },
  no_preference: { on: "optOutNoPreference", label: "optOutNoPreferenceLabel" },
  cannot_choose: { on: "optOutCannotChoose", label: "optOutCannotChooseLabel" },
};

/** the opt-outs a design offers, in display order, with the wording to show */
export function maxdiffOptOutsOf(config: unknown): { kind: MaxDiffOptOut; label: string }[] {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return MAXDIFF_OPT_OUTS.filter((k) => c[MAXDIFF_OPT_OUT_KEYS[k].on] === true).map((k) => ({ kind: k, label: String(c[MAXDIFF_OPT_OUT_KEYS[k].label] ?? "").trim() || MAXDIFF_OPT_OUT_LABELS[k] }));
}

/** the opt-out a task was answered with — only a kind the design offers counts (a stale or tampered value is not an answer) */
export function maxdiffTaskOptOut(config: unknown, taskAnswer: unknown): MaxDiffOptOut | null {
  if (!taskAnswer || typeof taskAnswer !== "object") return null;
  const v = (taskAnswer as { optOut?: unknown }).optOut;
  if (typeof v !== "string") return null;
  return maxdiffOptOutsOf(config).some((o) => o.kind === v) ? (v as MaxDiffOptOut) : null;
}
