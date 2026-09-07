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

/* ========================================================== count conditions
 *
 * "Show Q2 if at least 2 of Q1's options are selected."
 *
 * THE DESIGN DECISION, because it is the whole reason this feature is small:
 * A COUNT IS A SOURCE, NOT AN OPERATOR. The rule stays an ordinary
 * `ConditionRule` — what changes is that its LEFT-HAND VALUE resolves to a
 * number instead of to an answer.
 *
 *   { type: "rule",
 *     source: { kind: "question", ref: "q_brands",
 *               count: { of: "selected", scope: "options" } },
 *     operator: "gte",
 *     value: 2 }
 *
 * Three things fall out of that, all of them free:
 *
 *   · EVERY comparison operator already works on it — eq, ne, gt, lt, gte,
 *     lte and between. No new operators, so nothing that reads the operator
 *     union has to learn anything.
 *   · EVERY place that nests conditions already nests these — arbitrary
 *     AND / OR / NOT, because a count rule is a rule.
 *   · EVERY caller of `evaluateCondition` gets it at once: display rules,
 *     skip logic, masking, option / row / column logic, eligibility, auto
 *     select and auto punch, list logic, list operations, branching, loop
 *     conditions, quota cells and validation `when` clauses. There is exactly
 *     one implementation, which is the requirement — not one per feature.
 *
 * Had this been added as an operator (`countGte`, `countEq`, …) it would have
 * been six operators × the places that switch on operators, and a seventh the
 * day somebody wants `between`.
 */

/**
 * WHAT is being counted.
 *
 * `valid` / `invalid` mean what validation means: an item holding an answer
 * that passes, or fails, the validation rules attached to THAT item. An
 * unanswered item is neither — it is missing, which is a different question
 * and `notSelected` already answers it. Where an item has no validation of
 * its own (a plain multi-select option), `valid` is simply "selected" and
 * `invalid` is always zero; that is stated rather than quietly fudged.
 *
 * `eligible` / `visible` / `hidden` are read from the option pipeline, so they
 * reflect masking, carry-forward, list operations and named display rules —
 * the same list the respondent is actually shown.
 */
export const CountOf = z.enum([
  "selected",
  "notSelected",
  "valid",
  "invalid",
  "eligible",
  "visible",
  "hidden",
  /** items satisfying `where`, or — on a grid — answering with `responseIn` */
  "matching",
]);
export type CountOf = z.infer<typeof CountOf>;

/** WHICH collection is being counted over. */
export const CountScope = z.enum(["options", "rows", "columns"]);
export type CountScope = z.infer<typeof CountScope>;

export interface CountSpec {
  of: CountOf;
  scope: CountScope;
  /**
   * Count only these codes (options / rows) or column ids — the subset case:
   * "at least 2 of A, C and E". Absent counts the whole collection.
   */
  only?: (string | number)[];
  /**
   * Count only members of this option group, by group id. Groups are the
   * other half of this work; a count that names a group nobody has created
   * counts nothing, which is the honest answer rather than silently counting
   * everything.
   */
  group?: string;
  /**
   * GRID / MATRIX: count rows whose answer is one of these column codes.
   * "Count rows rated Good or Very Good >= 3" is
   * `{ of: "matching", scope: "rows", responseIn: ["4", "5"] }`.
   * For a multi-response grid a row matches when it holds ANY of them.
   */
  responseIn?: (string | number)[];
  /**
   * The general escape hatch: a condition evaluated once per item, with that
   * item in scope as the option under test — so `{ $option: "code" }` and
   * option-level sources work exactly as they do in option logic.
   */
  where?: Condition;
}

/**
 * `where` is a Condition, and a Condition contains sources, and a source
 * contains this — so the reference is lazy. The thunk is not called until
 * something is parsed, by which time every binding is in place.
 */
export const CountSpec: z.ZodType<CountSpec, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    of: CountOf.default("selected"),
    scope: CountScope.default("options"),
    only: z.array(z.union([z.string(), z.number()])).optional(),
    group: z.string().optional(),
    responseIn: z.array(z.union([z.string(), z.number()])).optional(),
    where: Condition.optional(),
  }),
) as unknown as z.ZodType<CountSpec, z.ZodTypeDef, unknown>;

/** What a rule reads from: a question's answer, a named variable,
 *  an embedded-data field, a calculated value, or quota state. */
export const ConditionSource = z.object({
  kind: z
    /*
     * `expr` is a CALC EXPRESSION as the left-hand value — `Q5 + Q6 + Q7`,
     * `AVERAGE(Q10, Q11, Q12)`, `LENGTH(Q10)`. It exists so the condition
     * language can borrow the calculation engine's arithmetic and string
     * functions instead of growing a second set of its own: `ref` holds the
     * expression text and the same evaluator that runs `Calculation.expression`
     * produces the value. One language, two places it can be written.
     */
    /*
     * `rule` is a NAMED EXPRESSION (§34, §35): `ref` is the id of an entry in
     * `def.namedExpressions`, and the rule's value is that expression's own
     * result. One definition, referenced from anywhere a condition is
     * accepted — which is every feature, because they all call the same
     * evaluator.
     */
    .enum(["question", "variable", "embedded", "calculation", "quota", "loop", "option", "expr", "rule"])
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
  /**
   * Count instead of read (see the block above). When present, the rule's
   * left-hand value is a NUMBER — how many items of `ref` qualify — and every
   * ordinary comparison operator applies to it.
   */
  count: CountSpec.optional(),
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
  /**
   * A count rule. `cond.count("q_brands", "gte", 2)` reads as it sounds.
   *
   * The convenience wrappers below are the UI's "minimum selections" and
   * "maximum selections" boxes — they are not a second mechanism, they are
   * this one with the operator filled in, which is why a rule built either way
   * is indistinguishable afterwards.
   */
  count(
    ref: string,
    operator: ComparisonOperator,
    value: number,
    spec: Partial<CountSpec> = {},
    extra?: Partial<ConditionSource>,
  ): ConditionRule {
    return {
      type: "rule",
      source: {
        kind: "question",
        ref,
        ...extra,
        count: { of: "selected", scope: "options", ...spec } as CountSpec,
      },
      operator,
      value,
    };
  },
  /** "at least N" */
  minCount(ref: string, n: number, spec?: Partial<CountSpec>): ConditionRule {
    return cond.count(ref, "gte", n, spec);
  },
  /** "no more than N" */
  maxCount(ref: string, n: number, spec?: Partial<CountSpec>): ConditionRule {
    return cond.count(ref, "lte", n, spec);
  },
  /** "exactly N" — deliberately distinct from `minCount`, per the brief */
  exactCount(ref: string, n: number, spec?: Partial<CountSpec>): ConditionRule {
    return cond.count(ref, "eq", n, spec);
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
