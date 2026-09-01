import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * Option-level logic and the reusable list-processing model.
 *
 * These types are deliberately generic: every rule is expressed in terms of
 * question id + option code + condition + operator, never in terms of a
 * specific question (req §28). The same primitives drive options, matrix rows
 * and composite columns, in the editor, the runtime, validation and exports.
 *
 * Everything here is OPTIONAL on the question/option. A definition written
 * before this feature existed carries none of these fields and behaves
 * exactly as before — "no option logic" means "Always Show" (req §33).
 */

/* ------------------------------------------------------------ visibility */

export const OptionVisibilityMode = z.enum([
  /** Inherit legacy behaviour: shown unless `visibleIf` says otherwise. */
  "default",
  /** Pinned visible — dynamic filtering can never remove it (req §2). */
  "always_show",
  /** Never rendered, but kept in the definition for reference (req §3). */
  "always_hide",
  /** Shown only while `when` holds (req §4). */
  "show_when",
  /** Hidden while `when` holds. */
  "hide_when",
]);
export type OptionVisibilityMode = z.infer<typeof OptionVisibilityMode>;

/**
 * Option-level carry forward / carry back.
 *
 * "This option survives only if its own code was <which> in <question>."
 * `direction: "back"` points at a question that comes LATER in the flow; it
 * is evaluated only when that answer already exists (respondent navigated
 * back, or a later loop iteration). A back reference never blocks display —
 * with no answer yet the rule is skipped rather than failing closed.
 */
export const OptionSourceRule = z.object({
  direction: z.enum(["forward", "back"]).default("forward"),
  sourceQuestionId: z.string(),
  which: z.enum(["selected", "not_selected", "displayed"]).default("selected"),
  /** Match the source list by option code (default), stored value, or label. */
  match: z.enum(["code", "value", "label"]).default("code"),
});
export type OptionSourceRule = z.infer<typeof OptionSourceRule>;

/**
 * The full per-option control set (req §1).
 * Every field is optional; an absent field imposes no constraint.
 */
export const OptionLogic = z.object({
  visibility: OptionVisibilityMode.default("default"),
  /** Condition for `show_when` / `hide_when`. */
  when: Condition.optional(),
  /** Extra gate: the option is only eligible while this holds. */
  eligibleWhen: Condition.optional(),
  /** Hard exclusion: removed while this holds (beats eligibility). */
  excludeWhen: Condition.optional(),
  /** Move to the top of the list while this holds. */
  prioritizeWhen: Condition.optional(),
  /** Move to the bottom of the list while this holds. */
  deprioritizeWhen: Condition.optional(),
  /**
   * Randomization participation. When present and FALSE the option is pinned
   * to its programmed position instead of being shuffled or dropped by
   * "show only N" — a conditional version of the anchor flags.
   */
  randomizeWhen: Condition.optional(),
  /** Membership rules against earlier / later questions. */
  carryForward: OptionSourceRule.optional(),
  carryBack: OptionSourceRule.optional(),
  /** Programmer note shown in the logic summary. */
  notes: z.string().optional(),
});
export type OptionLogic = z.infer<typeof OptionLogic>;

/** True when the block imposes nothing — used to keep saved JSON clean. */
export function isEmptyOptionLogic(l: OptionLogic | undefined): boolean {
  if (!l) return true;
  return (
    (l.visibility ?? "default") === "default" &&
    !l.when &&
    !l.eligibleWhen &&
    !l.excludeWhen &&
    !l.prioritizeWhen &&
    !l.deprioritizeWhen &&
    !l.randomizeWhen &&
    !l.carryForward &&
    !l.carryBack
  );
}

/* -------------------------------------------------------- list operations */

/** Which slice of a source question's answer a list operation reads. */
export const ListSourceWhich = z.enum([
  "selected",
  "not_selected",
  "displayed",
  "answered_rows",
  "all",
]);
export type ListSourceWhich = z.infer<typeof ListSourceWhich>;

export const ListSource = z.object({
  questionId: z.string(),
  which: ListSourceWhich.default("selected"),
});
export type ListSource = z.infer<typeof ListSource>;

/**
 * Reusable list operations (req §10). Each operation transforms the working
 * option list; they run in the programmed order inside the option pipeline
 * (req §11), so `intersect` then `exclude` then `randomize` is exactly what
 * the respondent gets.
 *
 *   carry_forward  replace the list with the options drawn from `sources`
 *   union          append options from `sources` that are not already present
 *   intersect      keep options whose code appears in EVERY source list
 *   difference     keep options in sources[0] that are in none of sources[1..]
 *   exclude        remove options whose code appears in ANY source list
 *   remaining      keep options that appear in NO source list ("not yet seen")
 *   prioritize     move matching options to the top
 *   deprioritize   move matching options to the bottom
 *   dedupe         drop repeated codes, keeping the first occurrence
 *   filter         keep options where `where` holds ({{$option}} available)
 *   sort           order the list (presentation only)
 *   randomize      shuffle / rotate / pick N, honouring anchors
 */
export const ListOperationKind = z.enum([
  "carry_forward",
  "union",
  "intersect",
  "difference",
  "exclude",
  "remaining",
  "prioritize",
  "deprioritize",
  "dedupe",
  "filter",
  "sort",
  "randomize",
]);
export type ListOperationKind = z.infer<typeof ListOperationKind>;

export const ListOperation = z.object({
  id: z.string(),
  kind: ListOperationKind,
  label: z.string().optional(),
  /** Source lists — required by every kind except dedupe/filter/sort/randomize. */
  sources: z.array(ListSource).default([]),
  /** Run this operation only while the condition holds. */
  when: Condition.optional(),
  /** `filter`: per-option predicate. The option under test is available as
   *  `{ $option: "code" }` on the value side of any rule. */
  where: Condition.optional(),
  /** `carry_forward`: keep the question's own static options as well. */
  keepOwn: z.boolean().default(false),
  /** `sort`: ordering to apply. */
  order: z.enum(["original", "az", "za", "numeric_asc", "numeric_desc"]).optional(),
  /** `randomize`: method / subset size. */
  method: z.enum(["shuffle", "rotate", "reverse_half", "none"]).optional(),
  pick: z.number().optional(),
});
export type ListOperation = z.infer<typeof ListOperation>;

/** Kinds that read from `sources`. */
export const LIST_OPS_WITH_SOURCES: ListOperationKind[] = [
  "carry_forward",
  "union",
  "intersect",
  "difference",
  "exclude",
  "remaining",
  "prioritize",
  "deprioritize",
];

export const LIST_OP_LABELS: Record<ListOperationKind, string> = {
  carry_forward: "carry forward from",
  union: "union — add options from",
  intersect: "intersection — keep options in all of",
  difference: "difference — first list minus the rest",
  exclude: "exclude options from",
  remaining: "remaining — drop options seen in",
  prioritize: "move to top — options from",
  deprioritize: "move to bottom — options from",
  dedupe: "remove duplicates",
  filter: "filter by condition",
  sort: "sort",
  randomize: "randomize",
};
