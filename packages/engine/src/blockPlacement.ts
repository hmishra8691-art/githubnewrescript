/**
 * WHERE A BLOCK GOES (2026-11-12) — creating a block at a chosen place and moving one before or after another.
 *
 * One implementation for the Studio's dialogs and for Intelligent Mode's actions (create_block / move_block):
 *
 *   position   { at: "start" }            after the survey's set-up (embedded data), before the first block
 *              { at: "end" }              after the last block, before the End nodes
 *              { at: "before" | "after", block }   next to that block, in ITS container (a section, a branch path,
 *                                                  a randomizer) — so "after B3" inside a section stays inside it
 *   moving     only the block's node changes place. Every question keeps its id, code, variable, logic, piping,
 *              quota and randomization settings, and the block keeps its own id — nothing is re-created.
 *   preview    previewBlockMove() returns the order the survey would have and what the move would BREAK: a question
 *              that now reads an answer asked after it (display logic, skip logic, piping, carry-forward, auto-punch,
 *              list logic, validation), and any new quality-check finding. The caller shows it before confirming.
 */
import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { dependencyGraph, orderIndex } from "./dependencies.js";
import { lintPageStructure } from "./structureLint.js";

export type BlockPosition = { at: "start" } | { at: "end" } | { at: "before"; block: string } | { at: "after"; block: string };

type Kids = { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
const lists = (n: FlowNode): FlowNode[][] => { const k = n as Kids; return [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise].filter((x): x is FlowNode[] => Array.isArray(x)); };

function locate(flow: FlowNode[], id: string): { list: FlowNode[]; index: number; node: FlowNode } | null {
  const i = flow.findIndex((n) => n.id === id);
  if (i >= 0) return { list: flow, index: i, node: flow[i] };
  for (const n of flow) for (const l of lists(n)) { const f = locate(l, id); if (f) return f; }
  return null;
}
const contains = (node: FlowNode, id: string): boolean => node.id === id || lists(node).some((l) => l.some((n) => contains(n, id)));

const setupEnd = (flow: FlowNode[]) => { let i = 0; while (i < flow.length && flow[i].type === "embedded_data") i++; return i; };
const endStart = (flow: FlowNode[]) => { let i = flow.length; while (i > 0 && flow[i - 1].type === "end") i--; return i; };

/** the list and index a position names; an error string when it cannot be resolved */
function resolve(flow: FlowNode[], pos: BlockPosition, moving?: FlowNode): { list: FlowNode[]; index: number } | string {
  if (pos.at === "start") return { list: flow, index: setupEnd(flow) };
  if (pos.at === "end") return { list: flow, index: endStart(flow) };
  const ref = locate(flow, pos.block);
  if (!ref) return `there is no block “${pos.block}”`;
  if (moving && contains(moving, pos.block)) return "a block cannot be placed next to itself or inside itself";
  return { list: ref.list, index: ref.index + (pos.at === "after" ? 1 : 0) };
}

/** put a new node at the position (mutates `def.flow`); returns an error string or null */
export function insertBlockAt(def: SurveyDefinition, node: FlowNode, pos: BlockPosition): string | null {
  const flow = def.flow as FlowNode[];
  const at = resolve(flow, pos);
  if (typeof at === "string") return at;
  at.list.splice(at.index, 0, node);
  return null;
}

/** move an existing block (mutates `def.flow`); returns an error string or null */
export function moveBlockTo(def: SurveyDefinition, blockId: string, pos: BlockPosition): string | null {
  const flow = def.flow as FlowNode[];
  const from = locate(flow, blockId);
  if (!from) return `there is no block “${blockId}”`;
  if ((pos.at === "before" || pos.at === "after") && pos.block === blockId) return "a block cannot be placed next to itself or inside itself";
  const check = resolve(flow, pos, from.node);
  if (typeof check === "string") return check;
  from.list.splice(from.index, 1);
  const at = resolve(flow, pos) as { list: FlowNode[]; index: number };
  at.list.splice(at.index, 0, from.node);
  return null;
}

export interface BlockOrderEntry { id: string; title: string; questions: number; moved: boolean }
export interface BlockMovePreview {
  ok: boolean;
  error?: string;
  /** nothing would change (the block is already there) */
  unchanged?: boolean;
  before: BlockOrderEntry[];
  after: BlockOrderEntry[];
  /** what the move would break — each a sentence naming the questions */
  conflicts: string[];
  /** the definition after the move (apply it to confirm) */
  def?: SurveyDefinition;
}

const blockOrder = (def: SurveyDefinition, moved?: string): BlockOrderEntry[] =>
  listBlocks(def.flow as unknown[]).map((b, i) => ({ id: b.id, title: b.title || `Block ${i + 1}`, questions: b.pages.reduce((t, p) => t + p.node.questionIds.length, 0), moved: b.id === moved }));

/** the forward references of a definition: "A reads B, and B is asked after A" */
function forwardRefs(def: SurveyDefinition): Map<string, string> {
  const order = orderIndex(def);
  const graph = dependencyGraph(def);
  const code = new Map(def.questions.map((q) => [q.id, q.code || q.variableName || q.id]));
  const out = new Map<string, string>();
  for (const [qid, deps] of Object.entries(graph)) {
    for (const d of deps) {
      if ((order[d] ?? -1) > (order[qid] ?? -1)) out.set(`${qid}>${d}`, `${code.get(qid)} uses the answer to ${code.get(d)}, which would now be asked after it`);
    }
  }
  return out;
}

/** what moving the block to the position would do — nothing is changed */
export function previewBlockMove(input: SurveyDefinition, blockId: string, pos: BlockPosition): BlockMovePreview {
  const before = blockOrder(input, blockId);
  const def = structuredClone(input) as SurveyDefinition;
  const error = moveBlockTo(def, blockId, pos);
  if (error) return { ok: false, error, before, after: before, conflicts: [] };
  const after = blockOrder(def, blockId);
  const unchanged = JSON.stringify(input.flow) === JSON.stringify(def.flow);
  const conflicts: string[] = [];
  try {
    const had = forwardRefs(input);
    for (const [k, msg] of forwardRefs(def)) if (!had.has(k)) conflicts.push(`${msg}.`);
  } catch { /* the preview still shows the order */ }
  try {
    const key = (i: { code: string; questionIds: string[] }) => `${i.code}|${i.questionIds.join(",")}`;
    const had = new Set(lintPageStructure(input).map(key));
    for (const i of lintPageStructure(def)) if (!had.has(key(i))) conflicts.push(i.message);
  } catch { /* as above */ }
  /* consent comes first: moving question blocks ahead of it asks before consent is given */
  return { ok: true, unchanged, before, after, conflicts: [...new Set(conflicts)].slice(0, 30), def };
}

/** the positions a block can be given, for a picker: start, end, and before / after every other block */
export function blockPositionChoices(def: SurveyDefinition, movingId?: string): { label: string; position: BlockPosition }[] {
  const out: { label: string; position: BlockPosition }[] = [{ label: "At the beginning of the survey", position: { at: "start" } }];
  const flow = def.flow as FlowNode[];
  const moving = movingId ? locate(flow, movingId)?.node : undefined;
  listBlocks(flow as unknown[]).forEach((b, i) => {
    if (b.id === movingId || (moving && contains(moving, b.id))) return;
    const name = b.title || `Block ${i + 1}`;
    out.push({ label: `Before “${name}”`, position: { at: "before", block: b.id } });
    out.push({ label: `After “${name}”`, position: { at: "after", block: b.id } });
  });
  out.push({ label: "At the end of the survey", position: { at: "end" } });
  return out;
}
