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
]);
export type ComparisonOperator = z.infer<typeof ComparisonOperator>;

/** What a rule reads from: a question's answer, a named variable,
 *  an embedded-data field, a calculated value, or quota state. */
export const ConditionSource = z.object({
  kind: z
    .enum(["question", "variable", "embedded", "calculation", "quota", "loop"])
    .default("question"),
  /** Question id (e.g. "q_brand") or variable / field name. */
  ref: z.string(),
  /** For composite / matrix questions: which row & column cell to read. */
  rowCode: z.string().optional(),
  columnId: z.string().optional(),
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

/** Convenience builders used by Studio and tests. */
export const cond = {
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
