import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * Survey Flow — the ordered structure the runtime walks (requirement §7).
 * Flow is a tree of nodes, evaluated depth-first by the flow interpreter.
 * It is entirely separate from per-question configuration.
 */

export type FlowNode =
  | {
      type: "page";
      id: string;
      title?: string;
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
      children: FlowNode[];
      visibleIf?: Condition;
    }
  | {
      type: "randomizer";
      id: string;
      /** Present N of the children, in random order. */
      show?: number;
      evenPresentation?: boolean;
      children: FlowNode[];
    }
  | {
      type: "branch";
      id: string;
      branches: { id: string; label?: string; when: Condition; children: FlowNode[] }[];
      otherwise?: FlowNode[];
    }
  | {
      type: "loop";
      id: string;
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
      fields: { name: string; source: "url" | "panel" | "static" | "expression"; value?: string }[];
    }
  | {
      type: "quota_check";
      id: string;
      quotaIds: string[];
      onFull: { kind: "terminate" | "redirect" | "continue" | "flag"; url?: string };
    }
  | { type: "redirect"; id: string; url: string; when?: Condition }
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
      children: z.array(FlowNode),
      visibleIf: Condition.optional(),
    }),
    z.object({
      type: z.literal("randomizer"),
      id: z.string(),
      show: z.number().optional(),
      evenPresentation: z.boolean().optional(),
      children: z.array(FlowNode),
    }),
    z.object({
      type: z.literal("branch"),
      id: z.string(),
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
      fields: z.array(
        z.object({
          name: z.string(),
          source: z.enum(["url", "panel", "static", "expression"]),
          value: z.string().optional(),
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
      url: z.string(),
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
