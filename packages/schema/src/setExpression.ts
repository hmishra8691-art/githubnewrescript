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
  /**
   * A List Fill's already-decided result — the same list a loop can already
   * iterate over via `source.kind: "listFill"`. Read-only: this never
   * triggers List Fill's own allocation, it reads back whatever it already
   * decided (see `listFillLoopItems` in `packages/engine/src/listFill.ts`),
   * so evaluating a mask can never itself consume List Fill sample capacity.
   */
  | { kind: "listFill"; listFillId: string }
  /**
   * The current loop item, when this expression is evaluated inside a loop —
   * `ref: null` is the item's own code (`CURRENT_ITEM_CODE`), `ref: "<name>"`
   * a named reference column (`CURRENT_ITEM.<name>`). Evaluated by the exact
   * `findLoopScope`/`loopValue` pair the condition engine already uses for
   * `CURRENT_ITEM`/`CURRENT_ITEM.<ref>` — same resolver, so a punch payload
   * and a punch's trigger condition can never disagree about what the current
   * item is. Outside a loop this resolves to nothing.
   */
  | { kind: "loopItem"; ref: string | null; scope?: string }
  /**
   * A calculated value, as a punch payload rather than a trigger — the same
   * `evaluateExpression` the calc engine and the condition `expr` source
   * already run (`SUM`/`AVERAGE`/string concatenation/etc.), so a function
   * calc already has works as a punch value from day one. Resolves to one
   * code: the expression's result, stringified.
   */
  | { kind: "expr"; expression: string }
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
    z.object({
      kind: z.literal("listFill"),
      listFillId: z.string(),
    }),
    z.object({
      kind: z.literal("loopItem"),
      ref: z.string().nullable().default(null),
      /*
       * Which loop, when loops nest — named by its `loopVar`, absent meaning
       * the innermost, exactly as `ConditionSource.scope` already works.
       * Without it an inner loop could only ever mask on its own item, so
       * "show the products for the BRAND the outer loop is on" was
       * inexpressible — a one-field omission rather than a design decision,
       * since the condition engine had solved the same problem already.
       */
      scope: z.string().optional(),
    }),
    z.object({
      kind: z.literal("expr"),
      expression: z.string(),
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
/**
 * What to show when the mask's own set expression resolves to nothing —
 * an unanswered or invalid source is the ordinary case, not an edge case, so
 * this is a real choice rather than one hardcoded behavior:
 *
 *   show_all          ignore the mask entirely; the item list is untouched
 *   show_none         the mask result stands: nothing (unless `remove`, where
 *                     "nothing selected" means nothing removed)
 *   always_show_only  fall back to whatever `keepAlwaysShow` already protects
 *
 * Absent is derived from the legacy `keepAlwaysShow` boolean so every
 * existing mask keeps behaving exactly as it does today: `true` →
 * `"always_show_only"`, `false`/absent → `"show_none"`. `keepAlwaysShow`
 * keeps working standalone; new UI writes both fields for clarity.
 */
export const MaskEmptySourceFallback = z.enum(["show_all", "show_none", "always_show_only"]);
export type MaskEmptySourceFallback = z.infer<typeof MaskEmptySourceFallback>;

export const OptionMask = z.object({
  expr: SetExpr,
  action: MaskAction.default("display"),
  /** Options flagged Always Show, or special (other/none/dk/refused), stay. */
  keepAlwaysShow: z.boolean().default(true),
  /** See `MaskEmptySourceFallback`. Optional — derived from `keepAlwaysShow` when absent. */
  onEmptySource: MaskEmptySourceFallback.optional(),
  /**
   * Whether options flagged Always Show — and the four special codes — survive
   * a mask that did not select them.
   *
   * Absent means "derive it from `onEmptySource`/`keepAlwaysShow`", which is
   * exactly what every existing mask did and so changes nothing. Setting it
   * explicitly separates two questions that were tangled together: "what
   * should happen when the source is unanswered" and "may a mask remove my
   * Other / None of the above". Those are different decisions, and deriving
   * the second from the first meant the same option was kept or dropped for a
   * reason the programmer never chose — picking `show_none` because an
   * unanswered source should show nothing also, silently, made the mask able
   * to delete "Prefer not to say".
   */
  protectAlwaysShow: z.boolean().optional(),
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

/**
 * What a punch does to the codes it resolves. `select` / `deselect` write the
 * answer; `clear` empties it; `show` / `hide` / `enable` / `disable` act on
 * the option LIST (through the option pipeline, so they compose with masks
 * and option logic); `set_value` is `select` that also replaces a single
 * answer. The union is open on purpose — an action is data, and the runtime
 * applies whichever it knows.
 */
export const PunchAction = z.enum([
  "select", "deselect", "clear", "set_value",
  "show", "hide", "enable", "disable",
]);
export type PunchAction = z.infer<typeof PunchAction>;

export const PunchRule = z.object({
  id: z.string(),
  label: z.string().optional(),
  /** Which codes to punch. */
  source: SetExpr,
  action: PunchAction.default("select"),
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
  /**
   * WHERE THIS RULE SITS IN AN IF / ELSE IF / ELSE CHAIN (§8, §23).
   *
   *   if        an independent rule — evaluated on its own merits
   *   else_if   only reached when every rule above it in the chain failed
   *   else      reached when every rule above it failed; carries no condition
   *
   * Consecutive rules form one chain and the FIRST match wins, which is what
   * makes "Heavy / Medium / Light" three rules instead of three rules and two
   * hand-written negations:
   *
   *   if      COUNT(Q2) >= 5   →  "Heavy User"
   *   else if COUNT(Q2) >= 3   →  "Medium User"
   *   else                     →  "Light User"
   *
   * Absent means `if`, so every punch rule that exists today keeps behaving
   * exactly as it does: independent, applied in order, last writer wins per
   * code. A chain only exists where a programmer builds one.
   *
   * An `else_if` or `else` with no `if` above it starts its own chain and
   * therefore behaves as an `if` — the alternative is a rule that silently
   * never runs.
   */
  mode: z.enum(["if", "else_if", "else"]).optional(),
  /**
   * MATRIX / GRID / COMPOSITE CELL TARGETING.
   *
   * Absent (the default, and every existing rule): the rule writes the
   * target question's whole answer, exactly as today. Set `targetRow` alone
   * to address one row of a matrix's row-keyed answer (e.g. `Q4["Apple"] =
   * "Very Interested"`); set both `targetRow` and `targetColumn` to address
   * one cell of a composite/custom-table grid (`Q4["Apple"]["Satisfaction"]
   * = 5`). The row/column codes are resolved against the target's own
   * `rows`/`columns` — a code that does not exist there is a validation
   * error, not a silent write (see `validatePunchRule`).
   */
  targetRow: z.union([z.string(), z.number()]).optional(),
  targetColumn: z.string().optional(),
  /**
   * EXPLICIT PRIORITY (§29–§30). Higher runs — and, for two INDEPENDENT
   * rules (not in the same if/else-if/else chain) that both resolve a value
   * for the same code, higher WINS — first; absent is treated as 0, so every
   * existing rule keeps its current behavior (array order breaks ties, same
   * as before this field existed). This is the one new field the "which rule
   * wins" requirement needs — see `tracePunches` for where the winner is
   * actually named.
   */
  priority: z.number().optional(),
});
export type PunchRule = z.infer<typeof PunchRule>;

/**
 * Rules in evaluation order: highest `priority` first (absent = 0), ties
 * broken by original array position — a stable sort, so a survey with no
 * `priority` set anywhere reorders nothing.
 */
export function orderPunchRules<T extends { priority?: number }>(rules: T[]): T[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index)
    .map((x) => x.rule);
}

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
