import type { SurveyDefinition } from "@rescript/schema";
import { listBlocks, type BlockRef } from "./blocks.js";
import { defaultIds, type IdMinter } from "./questionOps.js";

/**
 * PAGE BREAKS, AS OPERATIONS ON THE FLOW.
 *
 * A page break is not an object. It is the boundary between two `page`
 * nodes inside one block: a block with one page is a bare `page` node; the
 * moment it has a break it becomes a `block` container whose children are
 * pages (`blocks.ts` explains the vocabulary). Adding a break after a
 * question therefore means SPLITTING its page; removing the break after it
 * means JOINING its page with the next one in the same block.
 *
 * The Questions panel has done both by hand for a long time (its
 * `addPageBreak(pageId, pos)` / `removePageBreak(blockId, i)` closures, which
 * wrap and unwrap blocks with the helpers below). Architect's structure view
 * and the Intelligent mode's "add a page break after Q10" need the same
 * edits addressed BY QUESTION, so they live here, once, and the panel's
 * helpers delegate to `wrapBlock` / `unwrapIfSingle`.
 */

/* ----------------------------------------------------------- wrap / unwrap */

/**
 * Turn a single-page block into a `block` container so it can hold breaks.
 *
 * The PAGE keeps its id and the new block node gets a fresh one, deliberately:
 * skip rules written before this point refer to the page id, and jumping to
 * the first page of the block is exactly what "jump to this block" meant. The
 * name and visibility move up to the block, where they now govern every page.
 */
export function wrapBlock(b: BlockRef, ids: IdMinter = defaultIds): any {
  if (b.wrapped) return b.node;
  const page = b.node;
  const blockNode: any = { type: "block", id: ids("block"), children: [page] };
  if (page.title) { blockNode.title = page.title; delete page.title; }
  if (page.showTitle !== undefined) { blockNode.showTitle = page.showTitle; delete page.showTitle; }
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
  if (b.node.showTitle !== undefined && page.showTitle === undefined) page.showTitle = b.node.showTitle;
  if (b.node.visibleIf && !page.visibleIf) page.visibleIf = b.node.visibleIf;
  b.parent.splice(b.parent.indexOf(b.node), 1, page);
}

/* --------------------------------------------------------------- lookup */

export interface PagePosition {
  block: BlockRef;
  /** index of the page within the block */
  pageIndex: number;
  /** the page node */
  page: { id: string; title?: string; questionIds: string[] };
  /** index of the question on its page */
  index: number;
}

/** Where a question sits: its block, its page within the block, its position on the page. */
export function pagePositionOf(def: SurveyDefinition, questionId: string): PagePosition | null {
  for (const block of listBlocks(def.flow as unknown[])) {
    for (let pageIndex = 0; pageIndex < block.pages.length; pageIndex++) {
      const page = block.pages[pageIndex].node;
      const index = page.questionIds.indexOf(questionId);
      if (index >= 0) return { block, pageIndex, page, index };
    }
  }
  return null;
}

/**
 * What follows a question when the respondent presses Next:
 *   "none"   — more questions on the same page
 *   "page"   — a page break inside the block (the next page of the same block)
 *   "block"  — the end of the block (whatever comes next in the flow)
 */
export function boundaryAfter(def: SurveyDefinition, questionId: string): "none" | "page" | "block" | null {
  const pos = pagePositionOf(def, questionId);
  if (!pos) return null;
  if (pos.index < pos.page.questionIds.length - 1) return "none";
  return pos.pageIndex < pos.block.pages.length - 1 ? "page" : "block";
}

/* ------------------------------------------------------------ operations */

export type PageBreakOutcome = { ok: true; pageId: string } | { ok: false; reason: string };

/**
 * Add a page break after a question: its page is split there, the questions
 * after it move to a new page of the SAME block. Refused when the question is
 * already the last on its page — there is nothing to split.
 */
export function splitPageAfter(def: SurveyDefinition, questionId: string, ids: IdMinter = defaultIds): PageBreakOutcome {
  const pos = pagePositionOf(def, questionId);
  if (!pos) return { ok: false, reason: "That question is not on any page." };
  const cut = pos.index + 1;
  if (cut >= pos.page.questionIds.length) return { ok: false, reason: boundaryAfter(def, questionId) === "page" ? "There is already a page break after that question." : "That question is the last on its page — the block ends there." };
  const rest = pos.page.questionIds.slice(cut);
  pos.page.questionIds = pos.page.questionIds.slice(0, cut);
  const newPage = { type: "page", id: ids("page"), questionIds: rest };
  const blockNode = wrapBlock(pos.block, ids);
  const kids: any[] = blockNode.children;
  kids.splice(kids.indexOf(pos.page) + 1, 0, newPage);
  return { ok: true, pageId: newPage.id };
}

/**
 * Remove the page break after a question: its page and the next page of the
 * same block become one page. Refused when there is no break there — a
 * question in the middle of a page, or the last question of a block.
 */
export function joinPageAfter(def: SurveyDefinition, questionId: string): PageBreakOutcome {
  const pos = pagePositionOf(def, questionId);
  if (!pos) return { ok: false, reason: "That question is not on any page." };
  if (pos.index < pos.page.questionIds.length - 1) return { ok: false, reason: "There is no page break after that question." };
  if (pos.pageIndex >= pos.block.pages.length - 1) return { ok: false, reason: "That question ends its block; the next page belongs to the next block." };
  const next = pos.block.pages[pos.pageIndex + 1].node;
  pos.page.questionIds.push(...next.questionIds);
  const kids: any[] = pos.block.node.children;
  kids.splice(kids.indexOf(next), 1);
  unwrapIfSingle(pos.block);
  return { ok: true, pageId: pos.page.id };
}
