import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * Survey Flow — the ordered structure the runtime walks (requirement §7).
 * Flow is a tree of nodes, evaluated depth-first by the flow interpreter.
 * It is entirely separate from per-question configuration.
 */

/**
 * The declared type of an embedded-data field.
 *
 * Everything arriving from a URL or a panel is text; the type says how to read
 * it, which is what makes `score > 80` a numeric comparison rather than a
 * lexicographic one ("9" > "80" as strings). Untyped fields stay strings, so
 * surveys written before this existed behave exactly as they did.
 */
export const EmbeddedDataType = z.enum([
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
]);
export type EmbeddedDataType = z.infer<typeof EmbeddedDataType>;

/* ------------------------------------------------------------ loops */

/**
 * THE LOOP — "for each qualifying item, run this block".
 *
 * One construct, grown in place. The platform already had a `loop` flow node
 * that iterated a block over selected options, a static list, a design file or
 * a List Fill result. Everything below extends that node rather than adding a
 * second repeating construct beside it: an existing definition parses exactly
 * as before and behaves exactly as before, because every new field is optional
 * and the two legacy fields (`randomizeIterations`, `maxIterations`) are still
 * honoured as aliases of `order` and `count`.
 *
 * THE ONE RULE THAT SHAPES THE DATA MODEL — references are loop-level only.
 *
 * A loop can carry a table of programmer-defined columns for its items
 * (`Brand_Nickname`, `Product_ID`, `Client_Code`, …). That table lives HERE, on
 * the loop node, and nowhere else. It is not a property of the source
 * question, not a property of its options, and not a survey-wide dictionary.
 * Two loops over the same question can carry entirely different columns, a
 * loop's columns cannot collide with another loop's, and creating a loop over
 * Q2 leaves Q2 byte-for-byte unchanged. Everything that reads a reference —
 * piping, conditions, calculations, scripts, exports — reads it through the
 * iteration's context, never by looking the option up somewhere global.
 */

/** How a reference column's values are typed, for comparison and export. */
export const LoopReferenceType = z.enum(["text", "number", "boolean"]);
export type LoopReferenceType = z.infer<typeof LoopReferenceType>;

export interface LoopReferenceColumn {
  /**
   * The column's name, which is also how it is addressed everywhere —
   * `{{loop.Product_ID}}`, `loop.Product_ID = "PROD_001"`,
   * `getCurrentLoopReference("Product_ID")`. An identifier: letters, digits
   * and underscores, not starting with a digit, so it can appear inside a
   * piping token and an expression without quoting.
   */
  name: string;
  dataType?: LoopReferenceType;
  /** every item the loop can produce must have a value (lint, not runtime) */
  required?: boolean;
  description?: string;
}

/**
 * The reference table itself: columns in display order, and one row of values
 * per item CODE. Keyed by code rather than by position so the same table
 * serves every order the loop can run in, and keyed by column NAME rather
 * than an opaque id so the JSON is self-describing (§38) — renaming a column
 * rewrites its key, which the editor does in one place.
 */
export interface LoopReferences {
  columns: LoopReferenceColumn[];
  values: Record<string, Record<string, string | number | boolean | null>>;
}

/**
 * A number the loop needs — how many iterations, at most, at least — given
 * either literally or by pointing at something the respondent's data holds.
 * `Q2_SELECTED_COUNT` style counts are the `calculation`/`variable` case.
 */
export type LoopCountValue =
  | number
  | { kind: "question" | "calculation" | "embedded" | "variable"; ref: string };

export type LoopQuestionFilter =
  /** the options the respondent chose (a single-select yields one item) */
  | "selected"
  /** every option that was available and NOT chosen */
  | "notSelected"
  /** the options the display pipeline actually showed them */
  | "displayed"
  /** every option, answered or not */
  | "all"
  /**
   * codes in the answer that match no option, plus every option for which
   * `invalidIf` holds — "invalid" is whatever the programmer defines it to be
   */
  | "invalid"
  /** every option for which `eligibleIf` holds */
  | "eligible";

export type LoopSource =
  | { kind: "question"; questionId: string; filter?: LoopQuestionFilter }
  | { kind: "static"; items: { code: string; label: string }[] }
  | { kind: "design"; designId: string }
  /** one iteration per item a List Fill allocated to this respondent */
  | { kind: "listFill"; listFillId: string }
  /** a plain numeric iteration: items 1..N */
  | { kind: "count"; count: LoopCountValue }
  /**
   * a list held in a calculated variable, embedded-data field or answer —
   * which is how a custom script, an API result via embedded data, or a
   * calculation feeds a loop. A JSON array (`["a","b"]`, or
   * `[{"code":"a","label":"Apple"}]`) or a delimited string.
   */
  | { kind: "variable"; ref: string; separator?: string };

export type LoopOrderKind =
  | "source"          // the order of the options / items in the definition
  | "selection"       // the order the respondent chose them
  | "listFill"        // the allocation order (the natural order for that source)
  | "priority"        // sort by a reference column
  | "random"          // seeded shuffle — stable per respondent
  | "weightedRandom"  // seeded draw weighted by a reference column
  | "custom";         // an explicit list of codes

export interface LoopOrder {
  kind: LoopOrderKind;
  /** the reference column that drives `priority` / `weightedRandom` */
  column?: string;
  direction?: "asc" | "desc";
  /** for `custom`: codes in the order wanted; anything unlisted follows in source order */
  custom?: string[];
}

export interface LoopCount {
  /**
   *   all    every qualifying item
   *   exact  exactly N — fewer qualifying items means fewer iterations, never invented ones
   *   max    at most N
   *   min    a gate: run only when at least N items qualify, else zero iterations
   */
  mode: "all" | "exact" | "max" | "min";
  value?: LoopCountValue;
}

export const LoopCountValue: z.ZodType<LoopCountValue> = z.union([
  z.number(),
  z.object({ kind: z.enum(["question", "calculation", "embedded", "variable"]), ref: z.string() }),
]);

export const LoopReferenceColumn: z.ZodType<LoopReferenceColumn> = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a reference column name must be an identifier"),
  dataType: LoopReferenceType.optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const LoopReferences: z.ZodType<LoopReferences> = z.object({
  columns: z.array(LoopReferenceColumn),
  values: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
});

export const LoopSource: z.ZodType<LoopSource> = z.union([
  z.object({
    kind: z.literal("question"),
    questionId: z.string(),
    filter: z.enum(["selected", "notSelected", "displayed", "all", "invalid", "eligible"]).optional(),
  }),
  z.object({
    kind: z.literal("static"),
    items: z.array(z.object({ code: z.string(), label: z.string() })),
  }),
  z.object({ kind: z.literal("design"), designId: z.string() }),
  z.object({ kind: z.literal("listFill"), listFillId: z.string() }),
  z.object({ kind: z.literal("count"), count: LoopCountValue }),
  z.object({ kind: z.literal("variable"), ref: z.string(), separator: z.string().optional() }),
]);

export const LoopOrder: z.ZodType<LoopOrder> = z.object({
  kind: z.enum(["source", "selection", "listFill", "priority", "random", "weightedRandom", "custom"]),
  column: z.string().optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  custom: z.array(z.string()).optional(),
});

export const LoopCount: z.ZodType<LoopCount> = z.object({
  mode: z.enum(["all", "exact", "max", "min"]),
  value: LoopCountValue.optional(),
});

export type FlowNode =
  | {
      type: "page";
      id: string;
      title?: string;
      showTitle?: boolean;
      /** image / video / YouTube / Drive URL shown under the block name (engine `resolveMediaUrl`) */
      mediaUrl?: string;
      questionIds: string[];
      visibleIf?: Condition;
    }
  | {
      type: "section";
      id: string;
      title?: string;
      children: FlowNode[];
      visibleIf?: Condition;
    }
  | {
      type: "block";
      id: string;
      title?: string;
      showTitle?: boolean;
      mediaUrl?: string;
      children: FlowNode[];
      visibleIf?: Condition;
    }
  | {
      type: "randomizer";
      id: string;
      title?: string;
      /** Present N of the children, in random order. */
      show?: number;
      evenPresentation?: boolean;
      children: FlowNode[];
    }
  | {
      type: "branch";
      id: string;
      title?: string;
      branches: { id: string; label?: string; when: Condition; children: FlowNode[] }[];
      otherwise?: FlowNode[];
    }
  | {
      type: "loop";
      id: string;
      title?: string;
      source: LoopSource;
      /**
       * The loop's name inside the survey. Three jobs: it prefixes the loop's
       * variables (`LOOP_BRAND_COUNT`, `LOOP_BRAND_ITEM_1_CODE`, …), it lets a
       * question inside a NESTED loop address the outer one by name
       * (`{{brand.label}}` while `{{loop.label}}` means the innermost), and it
       * names the loop in the inspector. An identifier.
       */
      loopVar: string;
      /**
       * Narrows the items further, whatever the filter — evaluated once per
       * candidate item with THAT item as the loop context, so it can read the
       * item's own reference columns: `loop.Category = "Smartphone"`.
       */
      eligibleIf?: Condition;
      /** what "invalid" means for this loop's items (`filter: "invalid"`) */
      invalidIf?: Condition;
      count?: LoopCount;
      order?: LoopOrder;
      /**
       * The loop's own reference columns and values — see the header comment
       * above. Optional: a loop with no references behaves exactly as loops
       * always did.
       */
      references?: LoopReferences;
      /** @deprecated — `order: { kind: "random" }`. Honoured when `order` is absent. */
      randomizeIterations?: boolean;
      /** @deprecated — `count: { mode: "max", value: n }`. Honoured when `count` is absent. */
      maxIterations?: number;
      children: FlowNode[];
    }
  | {
      type: "embedded_data";
      id: string;
      title?: string;
      fields: {
        name: string;
        source: "url" | "panel" | "static" | "expression";
        value?: string;
        /**
         * How the stored value is typed. Absent means "string", which is what
         * every field written before typing existed already behaved as.
         */
        dataType?: EmbeddedDataType;
        /** Used when the URL / panel / expression produced nothing. */
        defaultValue?: string;
      }[];
    }
  | {
      type: "quota_check";
      id: string;
      quotaIds: string[];
      onFull: { kind: "terminate" | "redirect" | "continue" | "flag"; url?: string };
    }
  | {
      type: "redirect";
      id: string;
      title?: string;
      /** May contain piping tokens: https://x.com/done?id={{ed.PANEL_ID}} */
      url: string;
      /** Open in a new window/tab instead of replacing the survey. */
      newWindow?: boolean;
      when?: Condition;
    }
  | {
      type: "end";
      id: string;
      status: "complete" | "screened" | "quota_full" | "terminated";
      message?: string;
      redirectUrl?: string;
    };

export const FlowNode: z.ZodType<FlowNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("page"),
      id: z.string(),
      title: z.string().optional(),
      /**
       * Whether respondents see the name. Unset inherits the enclosing block,
       * then `branding.layout.showBlockTitles`. The name is always shown in
       * the Studio — it exists for the programmer first.
       */
      showTitle: z.boolean().optional(),
      /** Block media: an image, video, YouTube or Google Drive URL shown under the name. */
      mediaUrl: z.string().optional(),
      questionIds: z.array(z.string()),
      visibleIf: Condition.optional(),
    }),
    z.object({
      type: z.literal("section"),
      id: z.string(),
      title: z.string().optional(),
      children: z.array(FlowNode),
      visibleIf: Condition.optional(),
    }),
    z.object({
      type: z.literal("block"),
      id: z.string(),
      title: z.string().optional(),
      showTitle: z.boolean().optional(),
      mediaUrl: z.string().optional(),
      children: z.array(FlowNode),
      visibleIf: Condition.optional(),
    }),
    z.object({
      type: z.literal("randomizer"),
      id: z.string(),
      title: z.string().optional(),
      show: z.number().optional(),
      evenPresentation: z.boolean().optional(),
      children: z.array(FlowNode),
    }),
    z.object({
      type: z.literal("branch"),
      id: z.string(),
      title: z.string().optional(),
      branches: z.array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          when: Condition,
          children: z.array(FlowNode),
        }),
      ),
      otherwise: z.array(FlowNode).optional(),
    }),
    z.object({
      type: z.literal("loop"),
      id: z.string(),
      title: z.string().optional(),
      source: LoopSource,
      loopVar: z.string(),
      eligibleIf: Condition.optional(),
      invalidIf: Condition.optional(),
      count: LoopCount.optional(),
      order: LoopOrder.optional(),
      references: LoopReferences.optional(),
      randomizeIterations: z.boolean().optional(),
      maxIterations: z.number().optional(),
      children: z.array(FlowNode),
    }),
    z.object({
      type: z.literal("embedded_data"),
      id: z.string(),
      title: z.string().optional(),
      fields: z.array(
        z.object({
          name: z.string(),
          source: z.enum(["url", "panel", "static", "expression"]),
          value: z.string().optional(),
          dataType: EmbeddedDataType.optional(),
          defaultValue: z.string().optional(),
        }),
      ),
    }),
    z.object({
      type: z.literal("quota_check"),
      id: z.string(),
      quotaIds: z.array(z.string()),
      onFull: z.object({
        kind: z.enum(["terminate", "redirect", "continue", "flag"]),
        url: z.string().optional(),
      }),
    }),
    z.object({
      type: z.literal("redirect"),
      id: z.string(),
      title: z.string().optional(),
      url: z.string(),
      newWindow: z.boolean().optional(),
      when: Condition.optional(),
    }),
    z.object({
      type: z.literal("end"),
      id: z.string(),
      status: z.enum(["complete", "screened", "quota_full", "terminated"]),
      message: z.string().optional(),
      redirectUrl: z.string().optional(),
    }),
  ]),
) as unknown as z.ZodType<FlowNode>;

/**
 * Logic Flow — a standalone decision graph (requirement §8), independent of
 * the visual layout. Exportable / inspectable. Each edge fires on condition.
 */
export const LogicFlowNode = z.object({
  id: z.string(),
  kind: z.enum(["question", "decision", "action", "terminate", "end"]),
  ref: z.string().optional(), // question id or action name
  label: z.string().optional(),
  x: z.number().optional(), // canvas position for the editor
  y: z.number().optional(),
});

export const LogicFlowEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  when: Condition.optional(),
  label: z.string().optional(),
});

export const LogicFlow = z.object({
  nodes: z.array(LogicFlowNode).default([]),
  edges: z.array(LogicFlowEdge).default([]),
});
export type LogicFlow = z.infer<typeof LogicFlow>;
