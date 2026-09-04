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
      /** Loop over selected options of a question, a static list, or a design file's tasks. */
      source:
        | { kind: "question"; questionId: string; filter?: "selected" | "displayed" | "all" }
        | { kind: "static"; items: { code: string; label: string }[] }
        | { kind: "design"; designId: string };
      /** Inside the loop, {{loop.code}} / {{loop.label}} / {{loop.index}} pipe in. */
      loopVar: string;
      randomizeIterations?: boolean;
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
      source: z.union([
        z.object({
          kind: z.literal("question"),
          questionId: z.string(),
          filter: z.enum(["selected", "displayed", "all"]).optional(),
        }),
        z.object({
          kind: z.literal("static"),
          items: z.array(z.object({ code: z.string(), label: z.string() })),
        }),
        z.object({ kind: z.literal("design"), designId: z.string() }),
      ]),
      loopVar: z.string(),
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
