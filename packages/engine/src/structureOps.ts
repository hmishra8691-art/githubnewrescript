import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { pagePositionOf, splitPageAfter, unwrapIfSingle } from "./pageBreaks.js";
import { defaultIds, type IdMinter } from "./questionOps.js";

/**
 * STRUCTURAL OPERATIONS THE INTELLIGENT MODE PROPOSES (UI upgrade §17, §24).
 *
 * "Create a loop around Q5 to Q8", "create an embedded variable called
 * country and set it to India" — edits to the FLOW, not to a question. They
 * live beside `pageBreaks.ts` because they are built from the same page
 * surgery, and they are engine functions so that a proposal card, a command
 * and a test all perform exactly the same edit.
 */

export type StructureOutcome = { ok: true; id: string } | { ok: false; reason: string };

type LoopNode = Extract<FlowNode, { type: "loop" }>;
type EmbeddedNode = Extract<FlowNode, { type: "embedded_data" }>;
type EmbeddedField = EmbeddedNode["fields"][number];

/**
 * Wrap a contiguous run of questions on ONE page in a loop.
 *
 * The run is cut out into a page of its own (a page break before it and one
 * after it, when it is not already the whole page), that page leaves its
 * block, and a loop node holding it takes its place in the flow — with the
 * block's remaining pages before and after it as their own blocks. The loop
 * starts with an empty static list: which items to repeat over is a choice
 * for the Studio's loop editor, not for a sentence.
 */
export function wrapInLoop(def: SurveyDefinition, fromId: string, toId: string, opts: { loopVar?: string; title?: string } = {}, ids: IdMinter = defaultIds): StructureOutcome {
  const a = pagePositionOf(def, fromId);
  const b = pagePositionOf(def, toId);
  if (!a || !b) return { ok: false, reason: "Both ends of the loop must be questions on a page." };
  if (a.page.id !== b.page.id) return { ok: false, reason: "A loop wraps questions on one page — add a page break to separate them first, or name a range on one page." };
  const lo = Math.min(a.index, b.index), hi = Math.max(a.index, b.index);
  const first = a.page.questionIds[lo], last = a.page.questionIds[hi];
  // cut the run out into its own page: a break after it, then a break before it
  if (hi < a.page.questionIds.length - 1) { const r = splitPageAfter(def, last, ids); if (!r.ok) return r; }
  if (lo > 0) { const r = splitPageAfter(def, a.page.questionIds[lo - 1], ids); if (!r.ok) return r; }
  // the run's page is now one page of its (wrapped) block
  const pos = pagePositionOf(def, first);
  if (!pos) return { ok: false, reason: "Lost the page while splitting it." };
  const block = pos.block;
  const runPage = pos.page as unknown as FlowNode;
  const loop: LoopNode = { type: "loop", id: ids("loop"), loopVar: opts.loopVar ?? "item", source: { kind: "static", items: [] }, children: [runPage], ...(opts.title ? { title: opts.title } : {}) } as LoopNode;
  if (!block.wrapped) {
    // the whole (single) page is the run: the loop simply takes the page's place
    block.parent.splice(block.parent.indexOf(block.node), 1, loop);
    return { ok: true, id: loop.id };
  }
  const kids: FlowNode[] = block.node.children;
  const at = kids.indexOf(runPage);
  const after = kids.slice(at + 1);
  kids.splice(at);
  const parent: FlowNode[] = block.parent;
  const blockAt = parent.indexOf(block.node);
  const tail: FlowNode[] = [];
  if (after.length) tail.push(after.length === 1 && after[0].type === "page" ? after[0] : ({ type: "block", id: ids("block"), children: after } as FlowNode));
  if (kids.length === 0) parent.splice(blockAt, 1, loop, ...tail);
  else { parent.splice(blockAt + 1, 0, loop, ...tail); unwrapIfSingle(block); }
  return { ok: true, id: loop.id };
}

/** an embedded-data node at the start of the flow, or the first one anywhere — where a new field goes */
export function findEmbeddedNode(def: SurveyDefinition): EmbeddedNode | null {
  let found: EmbeddedNode | null = null;
  const walk = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (found) return;
      if (n.type === "embedded_data") { found = n; return; }
      const kids = (n as { children?: FlowNode[] }).children; if (kids) walk(kids);
    }
  };
  walk(def.flow as FlowNode[]);
  return found;
}

/** every embedded field name in the survey, for uniqueness checks and for the context listing */
export function embeddedFieldNames(def: SurveyDefinition): string[] {
  const out: string[] = [];
  const walk = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (n.type === "embedded_data") out.push(...n.fields.map((f) => f.name).filter(Boolean));
      const kids = (n as { children?: FlowNode[] }).children; if (kids) walk(kids);
      const branches = (n as { branches?: { children: FlowNode[] }[] }).branches; if (branches) for (const b of branches) walk(b.children);
      const other = (n as { otherwise?: FlowNode[] }).otherwise; if (other) walk(other);
    }
  };
  walk(def.flow as FlowNode[]);
  return out;
}

/**
 * Add an embedded-data field. It joins the survey's first embedded-data
 * node — the one at the top of the flow, where URL parameters are read —
 * or, when the survey has none, a new node placed first in the flow.
 */
export function addEmbeddedField(def: SurveyDefinition, field: EmbeddedField, ids: IdMinter = defaultIds): StructureOutcome {
  const name = (field.name ?? "").trim();
  if (!/^[A-Za-z_][\w]*$/.test(name)) return { ok: false, reason: `“${field.name}” is not a valid variable name — letters, digits and underscores, not starting with a digit.` };
  if (embeddedFieldNames(def).includes(name)) return { ok: false, reason: `An embedded variable ${name} already exists.` };
  if (def.questions.some((q) => q.variableName === name || q.code === name)) return { ok: false, reason: `${name} is already a question's name.` };
  let node = findEmbeddedNode(def);
  if (!node) {
    node = { type: "embedded_data", id: ids("embedded_data"), fields: [] } as EmbeddedNode;
    (def.flow as FlowNode[]).unshift(node);
  }
  node.fields.push({ ...field, name });
  return { ok: true, id: node.id };
}

/** where a block sits in the flow, for the summaries: "Block 3 · Brands" */
export function blockLabel(def: SurveyDefinition, blockId: string): string {
  const blocks = listBlocks(def.flow as unknown[]);
  const i = blocks.findIndex((b) => b.id === blockId);
  if (i < 0) return blockId;
  return `Block ${i + 1}${blocks[i].title ? ` · ${blocks[i].title}` : ""}`;
}
