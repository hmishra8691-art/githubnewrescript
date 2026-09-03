import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * Set expressions: which options a question shows, computed from other
 * questions' answers.
 *
 * The platform already had a *sequential* list pipeline — carry forward, then
 * union, then exclude, one step after another. That covers a great deal, but a
 * sequence cannot express `A UNION (B INTERSECTION C)`: every step applies to
 * whatever the previous step produced, so the brackets have nowhere to live.
 *
 * A `SetExpr` is the nested form. It is a TREE, so the structure a programmer
 * draws is the structure that is stored and evaluated, and the visual builder
 * and the written expression are two views of the same tree — exactly as the
 * logic builder and the logic expression editor already are.
 *
 * The sequential pipeline is untouched and still runs; a mask, when present,
 * computes the list the pipeline then works on.
 */

/** Which slice of a source question's options a reference means. */
export const SetSelection = z.enum([
  "selected",    // what the respondent picked
  "unselected",  // what they were shown and did not pick
  "all",         // every option the question defines
  "displayed",   // what they were actually shown (that question's own pipeline)
]);
export type SetSelection = z.infer<typeof SetSelection>;

export const SetOperator = z.enum([
  "union",         // A ∪ B
  "intersection",  // A ∩ B
  "difference",    // A \ B — order matters, and the builder says so
]);
export type SetOperator = z.infer<typeof SetOperator>;

export type SetExpr =
  /** A slice of one question: `Q5.Selected`. */
  | { kind: "ref"; questionId: string; selection: SetSelection }
  /** Literal codes, for "these three, always". */
  | { kind: "codes"; codes: (string | number)[] }
  /** Everything this question defines that is NOT in `of` — the complement. */
  | { kind: "complement"; of: SetExpr }
  | { kind: "op"; operator: SetOperator; left: SetExpr; right: SetExpr };

export const SetExpr: z.ZodType<SetExpr, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("ref"),
      questionId: z.string(),
      selection: SetSelection.default("selected"),
    }),
    z.object({
      kind: z.literal("codes"),
      codes: z.array(z.union([z.string(), z.number()])).default([]),
    }),
    z.object({ kind: z.literal("complement"), of: SetExpr }),
    z.object({
      kind: z.literal("op"),
      operator: SetOperator,
      left: SetExpr,
      right: SetExpr,
    }),
  ]),
) as unknown as z.ZodType<SetExpr, z.ZodTypeDef, unknown>;

/** What the computed set is used for. */
export const MaskAction = z.enum([
  "display",              // show exactly these options
  "preselect",            // leave the list alone, tick these
  "display_and_preselect",
  "disable",              // show all, but only these are answerable
  "remove",               // drop these from the list (the inverse of display)
]);
export type MaskAction = z.infer<typeof MaskAction>;

/**
 * A question's mask: the set expression, and what to do with the result.
 *
 * `keepAlwaysShow` is on by default and is the thing survey programmers ask
 * for first: "Other", "None of the above", "Don't know" and "Prefer not to
 * say" must survive a mask that returns nothing, or a respondent can be shown
 * a question with no answerable options at all.
 */
export const OptionMask = z.object({
  expr: SetExpr,
  action: MaskAction.default("display"),
  /** Options flagged Always Show, or special (other/none/dk/refused), stay. */
  keepAlwaysShow: z.boolean().default(true),
  /** Apply the mask only while this holds. */
  when: Condition.optional(),
  label: z.string().optional(),
});
export type OptionMask = z.infer<typeof OptionMask>;

/**
 * Auto-selection ("punching"): tick options in THIS question, computed from
 * other questions' answers.
 *
 * The rule lives on the question being filled, never on the question being
 * read. That is deliberate: a rule that reached across and wrote into another
 * question would depend on which of them the respondent saw first, and two
 * such rules could disagree. Reading is order-independent, so a punch is
 * always computed from state that already exists.
 *
 * `FOR EACH option IN Q5.Selected → punch the matching option here` is exactly
 * this rule with an identity mapping, which is why there is no separate loop
 * construct and no expression language to execute (req §17–§20).
 */
export const PunchMapping = z.object({
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]),
});
export type PunchMapping = z.infer<typeof PunchMapping>;

export const PunchRule = z.object({
  id: z.string(),
  label: z.string().optional(),
  /** Which codes to punch. */
  source: SetExpr,
  action: z.enum(["select", "deselect"]).default("select"),
  /**
   * Source code → this question's code. Empty means "the same code", which is
   * the common case: option lists that were built to line up.
   */
  mapping: z.array(PunchMapping).default([]),
  /** Only punch codes this question actually has. Off = report them instead. */
  ignoreUnmatched: z.boolean().default(true),
  /**
   * `once` fills only a question the respondent has not answered — so going
   * back and forward never overwrites their edit. `always` recomputes on every
   * visit, which is what a programmer wants for a derived question.
   */
  recompute: z.enum(["once", "always"]).default("once"),
  when: Condition.optional(),
});
export type PunchRule = z.infer<typeof PunchRule>;

/* -------------------------------------------------------------- builders */

export const setRef = (questionId: string, selection: SetSelection = "selected"): SetExpr =>
  ({ kind: "ref", questionId, selection });

export const setOp = (operator: SetOperator, left: SetExpr, right: SetExpr): SetExpr =>
  ({ kind: "op", operator, left, right });

export const SET_OPERATOR_LABEL: Record<SetOperator, string> = {
  union: "UNION",
  intersection: "INTERSECTION",
  difference: "DIFFERENCE",
};

export const SET_SELECTION_LABEL: Record<SetSelection, string> = {
  selected: "Selected",
  unselected: "Unselected",
  all: "All options",
  displayed: "Displayed",
};
