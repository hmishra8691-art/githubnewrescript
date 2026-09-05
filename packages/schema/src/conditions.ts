import { z } from "zod";

/**
 * Condition model — the universal logic primitive of the platform.
 * Every piece of logic (display, skip, branch, quota routing, column
 * visibility, option visibility, calculation triggers, script guards)
 * is expressed as a Condition tree, so nesting of AND / OR / NOT with
 * any operator is available everywhere, uniformly.
 */

export const ComparisonOperator = z.enum([
  "eq", // equals
  "ne", // not equals
  "gt",
  "lt",
  "gte",
  "lte",
  "in",
  "notIn",
  "contains", // string contains / multi-select contains code
  "notContains",
  "answered",
  "unanswered",
  "selected", // a specific option code is selected
  "notSelected",
  "between", // numeric range [value, value2]
  "matches", // regex on text answers

  /* --- text ------------------------------------------------------------ */
  "startsWith",
  "endsWith",
  "isEmpty", // explicit text/list emptiness (reads better than `unanswered`)
  "isNotEmpty",

  /* --- numeric --------------------------------------------------------- */
  "notBetween",

  /* --- list / multi-select --------------------------------------------- */
  "containsAny", // shares at least one code with value[]
  "containsAll", // contains every code in value[]
  "containsNone", // contains none of the codes in value[]

  /* --- ranking --------------------------------------------------------- */
  "rankedFirst", // value was ranked #1
  "rankedLast", // value was ranked last
  "rankedTopN", // value is within the top `value2` ranks
  "rankEquals", // rank of `value` === value2
  "rankGreaterThan", // rank of `value` > value2 (i.e. ranked lower down)
  "rankLessThan", // rank of `value` < value2 (i.e. ranked higher up)
  "notRanked", // value was not ranked at all

  /* --- date ------------------------------------------------------------ */
  "dateBefore",
  "dateAfter",
  "dateEquals",
  "dateBetween", // value .. value2
]);
export type ComparisonOperator = z.infer<typeof ComparisonOperator>;

/**
 * Operators that take no comparison value at all.
 * Shared by the engine, Studio and the logic linter so they never drift.
 */
export const VALUELESS_OPERATORS: ComparisonOperator[] = [
  "answered",
  "unanswered",
  "isEmpty",
  "isNotEmpty",
];

/** Operators that need a second value (`value2`). */
export const TWO_VALUE_OPERATORS: ComparisonOperator[] = [
  "between",
  "notBetween",
  "dateBetween",
  "rankedTopN",
  "rankEquals",
  "rankGreaterThan",
  "rankLessThan",
];

/** Operators whose comparison value is a list of codes. */
export const LIST_VALUE_OPERATORS: ComparisonOperator[] = [
  "in",
  "notIn",
  "containsAny",
  "containsAll",
  "containsNone",
];

/**
 * Which operators make sense for which kind of source. The Studio uses this
 * to offer only meaningful operators (req §7); the linter uses it to flag
 * incompatible configurations (req §30). "any" operators are always allowed.
 */
export const OPERATORS_BY_KIND: Record<string, ComparisonOperator[]> = {
  any: ["answered", "unanswered", "isEmpty", "isNotEmpty", "eq", "ne"],
  choice: ["selected", "notSelected", "in", "notIn", "contains", "notContains"],
  list: [
    "contains",
    "notContains",
    "containsAny",
    "containsAll",
    "containsNone",
    "selected",
    "notSelected",
    "in",
    "notIn",
  ],
  text: [
    "eq",
    "ne",
    "contains",
    "notContains",
    "startsWith",
    "endsWith",
    "matches",
    "isEmpty",
    "isNotEmpty",
  ],
  numeric: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "notBetween", "in", "notIn"],
  ranking: [
    "rankedFirst",
    "rankedLast",
    "rankedTopN",
    "rankEquals",
    "rankGreaterThan",
    "rankLessThan",
    "notRanked",
    "contains",
    "notContains",
  ],
  date: ["dateBefore", "dateAfter", "dateEquals", "dateBetween", "answered", "unanswered"],
};

/** What a rule reads from: a question's answer, a named variable,
 *  an embedded-data field, a calculated value, or quota state. */
export const ConditionSource = z.object({
  kind: z
    .enum(["question", "variable", "embedded", "calculation", "quota", "loop", "option"])
    .default("question"),
  /**
   * Question id (e.g. "q_brand") or variable / field name.
   *
   * For `kind: "loop"` — the current iteration — `ref` is `code`, `label`,
   * `index`, `count`, or the NAME OF ONE OF THE LOOP'S REFERENCE COLUMNS
   * (`Category`, `Product_ID`, …). Which columns exist is decided by the loop
   * the rule sits inside, not by this schema, so `loop.Category = "Smartphone"`
   * is an ordinary rule with `ref: "Category"`.
   */
  ref: z.string(),
  /** For composite / matrix questions: which row & column cell to read. */
  rowCode: z.string().optional(),
  columnId: z.string().optional(),
  /**
   * For `kind: "loop"` inside NESTED loops: the `loopVar` of the loop meant.
   * Absent means the innermost loop, which is what a rule written inside a
   * single loop has always meant, so nothing existing changes.
   */
  scope: z.string().optional(),
});
export type ConditionSource = z.infer<typeof ConditionSource>;

export const ConditionRule = z.object({
  type: z.literal("rule"),
  source: ConditionSource,
  operator: ComparisonOperator,
  /** Comparison value: string | number | boolean | array of codes. */
  value: z.any().optional(),
  /** Second value for `between`. */
  value2: z.any().optional(),
});
export type ConditionRule = z.infer<typeof ConditionRule>;

export type ConditionGroup = {
  type: "group";
  op: "and" | "or" | "not";
  children: Condition[];
};
export type Condition = ConditionRule | ConditionGroup;

export const Condition: z.ZodType<Condition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([ConditionRule, ConditionGroup]),
) as unknown as z.ZodType<Condition, z.ZodTypeDef, unknown>;

export const ConditionGroup: z.ZodType<ConditionGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    op: z.enum(["and", "or", "not"]),
    children: z.array(Condition),
  }),
) as unknown as z.ZodType<ConditionGroup, z.ZodTypeDef, unknown>;

/**
 * Dynamic comparison value (req §8–9, "option-to-option logic").
 *
 * When a condition is evaluated *per option* — option-level logic, a
 * `filter` list operation, a carry-forward `where` clause — the option under
 * test is available as a value. Storing it as a structured object rather
 * than a magic string keeps the definition JSON self-describing:
 *
 *   { type: "rule",
 *     source: { kind: "question", ref: "q_used" },
 *     operator: "selected",
 *     value: { $option: "code" } }
 *
 *   → "show this option when its own code was selected in Q_USED"
 *
 * The same rule works for every option of every question — no per-question
 * hard-coding (req §28).
 */
export const OptionValueRef = z.object({
  $option: z.enum(["code", "label", "value", "index"]).default("code"),
});
export type OptionValueRef = z.infer<typeof OptionValueRef>;

export function isOptionValueRef(v: unknown): v is OptionValueRef {
  return !!v && typeof v === "object" && !Array.isArray(v) && "$option" in (v as object);
}

/** Convenience builders used by Studio and tests. */
export const cond = {
  /** The option currently being evaluated — use as a rule's `value`. */
  option(field: OptionValueRef["$option"] = "code"): OptionValueRef {
    return { $option: field };
  },
  rule(
    ref: string,
    operator: ComparisonOperator,
    value?: unknown,
    value2?: unknown,
    extra?: Partial<ConditionSource>,
  ): ConditionRule {
    return {
      type: "rule",
      source: { kind: "question", ref, ...extra },
      operator,
      value,
      value2,
    };
  },
  and(...children: Condition[]): ConditionGroup {
    return { type: "group", op: "and", children };
  },
  or(...children: Condition[]): ConditionGroup {
    return { type: "group", op: "or", children };
  },
  not(...children: Condition[]): ConditionGroup {
    return { type: "group", op: "not", children };
  },
};
