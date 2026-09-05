"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { loopNodes, questionIdsInLoop, type LoopFlowNode } from "@rescript/engine";

/**
 * WHICH LOOPS SURROUND THE THING BEING EDITED.
 *
 * The condition builder and the piping picker offer a loop's reference columns
 * — but only the columns of the loops the current question or rule actually
 * sits inside. A `Category` column on LOOP_001 is not a thing a question
 * outside that loop can read, and offering it there would be offering a value
 * that is always empty. This context is how those pickers find out.
 *
 * Innermost first, so `[0]` is what `{{loop.x}}` means here and the rest are
 * the outer loops addressable by their loopVar (§32).
 */
const LoopScopeContext = React.createContext<LoopFlowNode[]>([]);

export function LoopScopeProvider({ loops, children }: { loops: LoopFlowNode[]; children: React.ReactNode }) {
  return <LoopScopeContext.Provider value={loops}>{children}</LoopScopeContext.Provider>;
}

export function useLoopScope(): LoopFlowNode[] {
  return React.useContext(LoopScopeContext);
}

/** The loops a question sits inside, innermost first — from the flow alone. */
export function loopsAroundQuestion(def: SurveyDefinition, questionId: string | null | undefined): LoopFlowNode[] {
  if (!questionId) return [];
  const chain: LoopFlowNode[] = [];
  for (const { node, ancestors } of loopNodes(def)) {
    if (questionIdsInLoop(node).includes(questionId)) {
      // the deepest loop containing the question wins; its ancestors follow
      if (chain.length === 0 || ancestors.length + 1 > chain.length) {
        chain.length = 0;
        chain.push(node, ...[...ancestors].reverse());
      }
    }
  }
  return chain;
}

/** The loops around a loop node's own rules: the node itself, then its ancestors. */
export function loopsAroundLoop(def: SurveyDefinition, loopId: string): LoopFlowNode[] {
  const found = loopNodes(def).find((l) => l.node.id === loopId);
  if (!found) return [];
  return [found.node, ...[...found.ancestors].reverse()];
}
