import { uid } from "./store";
import type { BlockRef } from "@rescript/engine";

/**
 * Studio-side block operations.
 *
 * The READING of the flow — what a block is, which pages it holds, how the
 * flow outlines into blocks, groups and elements — lives in
 * `@rescript/engine` (`blocks.ts`), because the runtime and both exporters
 * need exactly the same answers. This file adds only the things that edit,
 * which need the Studio's id generator.
 */

export {
  type PageRef, type BlockRef, type FlowEntry,
  listPages, listBlocks, blockSize, flowOutline, isBlockNode, isGroupNode,
} from "@rescript/engine";

/**
 * Turn a single-page block into a `block` container so it can hold breaks.
 *
 * The PAGE keeps its id and the new block node gets a fresh one, deliberately:
 * skip rules written before this point refer to the page id, and jumping to
 * the first page of the block is exactly what "jump to this block" meant. The
 * name and visibility move up to the block, where they now govern every page.
 */
export function wrapBlock(b: BlockRef): any {
  if (b.wrapped) return b.node;
  const page = b.node;
  const blockNode: any = { type: "block", id: uid("block"), children: [page] };
  if (page.title) { blockNode.title = page.title; delete page.title; }
  if (page.visibleIf) { blockNode.visibleIf = page.visibleIf; delete page.visibleIf; }
  b.parent.splice(b.parent.indexOf(page), 1, blockNode);
  return blockNode;
}

/** Collapse a block back to a bare page once it has no breaks left. */
export function unwrapIfSingle(b: BlockRef): void {
  if (!b.wrapped) return;
  const kids: any[] = b.node.children ?? [];
  if (kids.length !== 1 || kids[0].type !== "page") return;
  const page = kids[0];
  if (b.node.title && !page.title) page.title = b.node.title;
  if (b.node.visibleIf && !page.visibleIf) page.visibleIf = b.node.visibleIf;
  b.parent.splice(b.parent.indexOf(b.node), 1, page);
}

/** A fresh, empty block — one page, because it has no breaks yet. */
export function newBlockNode(title?: string): any {
  const node: any = { type: "page", id: uid("page"), questionIds: [] };
  if (title) node.title = title;
  return node;
}

/** A fresh group. Empty groups are allowed: you make one, then fill it. */
export function newGroupNode(title = "New group"): any {
  return { type: "section", id: uid("section"), title, children: [] };
}

/**
 * Human labels for flow elements. The raw node type ("embedded_data") is what
 * the flow used to show; these are what survey programmers call them.
 */
export const ELEMENT_LABELS: Record<string, string> = {
  branch: "Branch / condition",
  randomizer: "Randomizer",
  loop: "Loop",
  embedded_data: "Embedded data",
  quota_check: "Quota check",
  redirect: "Redirect",
  end: "End of survey",
  section: "Group",
  page: "Block",
  block: "Block",
};

/** What a programmer can insert between two blocks. */
export const INSERTABLE: { type: string; label: string; hint: string }[] = [
  { type: "embedded_data", label: "Embedded data", hint: "capture URL, panel or computed values" },
  { type: "branch", label: "Branch / condition", hint: "send respondents down different paths" },
  { type: "randomizer", label: "Randomizer", hint: "shuffle what comes next, or show N of M" },
  { type: "loop", label: "Loop", hint: "repeat what is inside, once per item" },
  { type: "quota_check", label: "Quota check", hint: "stop or flag when a quota is full" },
  { type: "redirect", label: "Redirect", hint: "send the respondent to another URL" },
  { type: "end", label: "End of survey", hint: "complete, screen out or terminate here" },
  { type: "page", label: "Block", hint: "another block of questions" },
  { type: "section", label: "Group", hint: "a collapsible group of blocks" },
];
