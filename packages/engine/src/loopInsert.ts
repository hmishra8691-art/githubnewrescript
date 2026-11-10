import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { canDropFlowNode, findNode, locateNode, moveFlowNode, type MoveResult } from "./flowTree.js";
import type { LoopFlowNode } from "./loopModel.js";

/**
 * PUT AN EXISTING BLOCK OR QUESTION INTO A LOOP (2026-11-10) — the alternative to dragging it there.
 *
 * `loopInsertChoices` lists every block in the survey and every question beneath it, each selectable or greyed with
 * the reason. `moveIntoLoop` performs the choice:
 *
 *   a block      MOVED into the loop's body, subtree and all (`moveFlowNode` carries the node object across, so its
 *                pages, questions, options, piping, validation, display logic and timers are the same objects
 *                afterwards — nothing is rebuilt or copied, and every answer is still stored once).
 *   a question   taken off its page and placed on a page of its own at the end of the loop's body; the question
 *                object itself does not change. A page left empty by it is removed.
 *
 * Inside the loop, the moved questions are asked once per iteration — the runtime keys their answers by iteration
 * (`Q5@1`, `Q5@3`) and `{{loop.…}}` resolves for the current item; nothing about the questions needs editing.
 *
 * What cannot go in, and why: something already in this loop; the loop's own source question (the loop iterates over
 * its answers, so it must be asked before the loop); a block that contains this loop; anything the flow's own drop
 * rules refuse (the same `canDropFlowNode` the drag uses).
 */

export interface LoopBlockChoice {
  id: string;
  kind: "block";
  title: string;
  number: number;
  questionCodes: string[];
  selectable: boolean;
  reason?: string;
  where: string;
}
export interface LoopQuestionChoice {
  id: string;
  kind: "question";
  code: string;
  text: string;
  blockId: string;
  blockTitle: string;
  selectable: boolean;
  reason?: string;
}

function loopOf(def: SurveyDefinition, loopId: string): LoopFlowNode | null {
  const n = findNode(def.flow as FlowNode[], loopId);
  return n && n.type === "loop" ? (n as LoopFlowNode) : null;
}

/** every node id inside a subtree */
function idsUnder(node: FlowNode, out = new Set<string>()): Set<string> {
  out.add(node.id);
  const n = node as unknown as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
  for (const k of n.children ?? []) idsUnder(k, out);
  for (const b of n.branches ?? []) for (const k of b.children) idsUnder(k, out);
  for (const k of n.otherwise ?? []) idsUnder(k, out);
  return out;
}

/** the question ids on every page inside a subtree */
function questionsUnder(node: FlowNode): string[] {
  const out: string[] = [];
  const walk = (x: FlowNode) => {
    if (x.type === "page") { out.push(...x.questionIds); return; }
    const n = x as unknown as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    for (const k of n.children ?? []) walk(k);
    for (const b of n.branches ?? []) for (const k of b.children) walk(k);
    for (const k of n.otherwise ?? []) walk(k);
  };
  walk(node);
  return out;
}

export function loopInsertChoices(def: SurveyDefinition, loopId: string): { blocks: LoopBlockChoice[]; questions: LoopQuestionChoice[]; note: string } {
  const flow = def.flow as FlowNode[];
  const loop = loopOf(def, loopId);
  const inLoop = loop ? idsUnder(loop) : new Set<string>();
  const inLoopQuestions = new Set(loop ? questionsUnder(loop) : []);
  const sourceQid = loop?.source.kind === "question" ? loop.source.questionId : null;
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const codeOf = (id: string) => String(qById.get(id)?.code ?? id);
  const blocks: LoopBlockChoice[] = [];
  const questions: LoopQuestionChoice[] = [];

  listBlocks(flow as unknown[]).forEach((b, i) => {
    const title = b.title?.trim() || `Block ${i + 1}`;
    const qids = b.pages.flatMap((p) => p.node.questionIds);
    const loc = locateNode(flow, b.id);
    const owner = loc?.container.ownerId ? findNode(flow, loc.container.ownerId) as (FlowNode & { title?: string; loopVar?: string }) | null : null;
    const where = !owner ? "top level of the flow" : owner.id === loopId ? "already in this loop" : `inside ${owner.title || (owner.type === "loop" ? `loop ${owner.loopVar}` : owner.type)}`;
    let reason: string | undefined;
    if (!loop) reason = "the loop is gone";
    else if (inLoop.has(b.id)) reason = "already in this loop";
    else if (sourceQid && qids.includes(sourceQid)) reason = `it holds ${codeOf(sourceQid)}, the question this loop iterates over — that has to be asked before the loop`;
    else {
      const v = canDropFlowNode(flow, b.id, { kind: "inside", ownerId: loopId, slot: "children" });
      if (!v.ok) reason = v.reason;
    }
    blocks.push({ id: b.id, kind: "block", title, number: i + 1, questionCodes: qids.map(codeOf), selectable: !reason, ...(reason ? { reason } : {}), where });
    for (const qid of qids) {
      const q = qById.get(qid);
      if (!q) continue;
      let qr: string | undefined;
      if (!loop) qr = "the loop is gone";
      else if (inLoopQuestions.has(qid)) qr = "already in this loop";
      else if (qid === sourceQid) qr = "this loop iterates over its answers — it has to be asked before the loop";
      questions.push({ id: q.id, kind: "question", code: String(q.code), text: String(q.text ?? "").replace(/<[^>]*>/g, "").slice(0, 80), blockId: b.id, blockTitle: title, selectable: !qr, ...(qr ? { reason: qr } : {}) });
    }
  });
  return { blocks, questions, note: "Choose a whole block, or a single question — it is moved into the loop with all its settings, and asked once per iteration." };
}

let pageSeq = 0;
const newPageId = (flow: FlowNode[]): string => {
  const taken = new Set<string>();
  const walk = (ns: FlowNode[]) => { for (const n of ns) { taken.add(n.id); idsUnder(n).forEach((x) => taken.add(x)); } };
  walk(flow);
  let id: string;
  do { id = `page_loop_${Date.now().toString(36)}_${(pageSeq++).toString(36)}`; } while (taken.has(id));
  return id;
};

/** Move a block (by its id) or a question (by its id or code) into the loop's body, at `index` (default: the end). */
export function moveIntoLoop(def: SurveyDefinition, ref: string, loopId: string, index?: number): MoveResult {
  const flow = def.flow as FlowNode[];
  const choices = loopInsertChoices(def, loopId);
  const block = choices.blocks.find((b) => b.id === ref);
  if (block) {
    if (!block.selectable) return { flow, moved: false, reason: block.reason };
    return moveFlowNode(flow, ref, { kind: "inside", ownerId: loopId, slot: "children", ...(index != null ? { index } : {}) });
  }
  const q = def.questions.find((x) => x.id === ref || String(x.code) === ref);
  const choice = q ? choices.questions.find((c) => c.id === q.id) : undefined;
  if (!q || !choice) return { flow, moved: false, reason: "there is no such block or question" };
  if (!choice.selectable) return { flow, moved: false, reason: choice.reason };

  const next: FlowNode[] = structuredClone(flow);
  /* off its page — and the page, if that leaves it empty */
  const pages: { node: Extract<FlowNode, { type: "page" }>; list: FlowNode[] }[] = [];
  const walk = (ns: FlowNode[]) => {
    for (const n of ns) {
      if (n.type === "page") { if (n.questionIds.includes(q.id)) pages.push({ node: n, list: ns }); continue; }
      const x = n as unknown as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
      if (x.children) walk(x.children);
      for (const b of x.branches ?? []) walk(b.children);
      if (x.otherwise) walk(x.otherwise);
    }
  };
  walk(next);
  for (const p of pages) {
    p.node.questionIds = p.node.questionIds.filter((id) => id !== q.id);
    if (!p.node.questionIds.length) { const at = p.list.indexOf(p.node); if (at >= 0) p.list.splice(at, 1); }
  }
  /* onto a page of its own in the loop */
  const loop = findNode(next, loopId) as LoopFlowNode | null;
  if (!loop) return { flow, moved: false, reason: "the loop is gone" };
  const page: FlowNode = { type: "page", id: newPageId(next), title: String(q.code), questionIds: [q.id] } as FlowNode;
  const kids = loop.children;
  kids.splice(index == null ? kids.length : Math.max(0, Math.min(index, kids.length)), 0, page);
  return { flow: next, moved: true };
}
