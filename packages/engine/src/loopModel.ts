import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import type { LoopContext } from "./state.js";

/**
 * THE SHAPE OF THE LOOPS — where they are, what they contain, what they are
 * called. Nothing here resolves an item or reads an answer: this module
 * depends on the schema and on `state.ts` alone, so `flatten.ts` (which every
 * evaluator ultimately imports) can know about loops without the import graph
 * closing into a cycle through `piping` → `carryforward` → `loops`.
 */

export type LoopFlowNode = Extract<FlowNode, { type: "loop" }>;

/* ------------------------------------------------------------ discovery */

export interface LoopNodeInfo {
  node: LoopFlowNode;
  /** the enclosing loop nodes, outermost first */
  ancestors: LoopFlowNode[];
}

/** Every loop node in the flow, with its enclosing loops. */
export function loopNodes(def: SurveyDefinition): LoopNodeInfo[] {
  const out: LoopNodeInfo[] = [];
  const walk = (nodes: FlowNode[], ancestors: LoopFlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "loop") {
        out.push({ node: n, ancestors });
        walk(n.children, [...ancestors, n]);
      } else if (n.type === "section" || n.type === "block" || n.type === "randomizer") {
        walk(n.children, ancestors);
      } else if (n.type === "branch") {
        for (const b of n.branches) walk(b.children, ancestors);
        if (n.otherwise) walk(n.otherwise, ancestors);
      }
    }
  };
  walk(def.flow, []);
  return out;
}

/** The loop node a page belongs to, innermost first, by node id path. */
export function loopChainFor(def: SurveyDefinition, nodePath: string[]): LoopFlowNode[] {
  const byId = new Map(loopNodes(def).map((l) => [l.node.id, l.node]));
  return nodePath.map((id) => byId.get(id)).filter((n): n is LoopFlowNode => !!n);
}

/**
 * The question ids that sit inside a loop's body (at any depth), which is what
 * the variable dictionary needs to declare `Q7_1..Q7_N`.
 */
export function questionIdsInLoop(node: LoopFlowNode): string[] {
  const ids: string[] = [];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "page") ids.push(...n.questionIds);
      else if ("children" in n && Array.isArray((n as any).children)) walk((n as any).children);
      else if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(node.children);
  return [...new Set(ids)];
}


/**
 * The question ids DIRECTLY in a loop's body — not those inside a nested
 * loop, which belong to the nested loop's own positional columns.
 */
export function directQuestionIdsInLoop(node: LoopFlowNode): string[] {
  const ids: string[] = [];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "page") ids.push(...n.questionIds);
      else if (n.type === "loop") continue;
      else if ("children" in n && Array.isArray((n as any).children)) walk((n as any).children);
      else if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(node.children);
  return [...new Set(ids)];
}

/** The loop nodes DIRECTLY nested in this loop's body. */
export function directChildLoops(node: LoopFlowNode): LoopFlowNode[] {
  const out: LoopFlowNode[] = [];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (n.type === "loop") out.push(n);
      else if ("children" in n && Array.isArray((n as any).children)) walk((n as any).children);
      else if (n.type === "branch") { for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); }
    }
  };
  walk(node.children);
  return out;
}

/** `LOOP_BRAND` — the prefix of every variable this loop writes (§24). */
export function loopVariablePrefix(node: LoopFlowNode, parent?: LoopContext | null): string {
  const own = `LOOP_${String(node.loopVar || node.id).toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}`;
  if (!parent) return own;
  // nested: the outer iteration's code becomes part of the name, so every
  // outer iteration's inner loop has its own, non-colliding set
  const outer: string[] = [];
  for (let l: LoopContext | null | undefined = parent; l; l = l.parent) {
    outer.unshift(`LOOP_${String(l.loopVar).toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}_${String(l.code).toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}`);
  }
  return `${outer.join("_")}_${own}`;
}

