/**
 * How to read a survey's flow as Blocks, Groups and Elements.
 *
 * This is the ONE implementation. The Studio's Questions panel, the Survey
 * Flow, the Word export and the JSON export all call these functions, so they
 * cannot disagree about what a block is or which questions are in it — and a
 * change made in the Studio is visible everywhere the moment the definition
 * changes, because nothing here caches or copies anything.
 *
 * The vocabulary maps onto schema node types that already existed:
 *
 *   Block   a `page` node (one page) OR a `block` node whose children are pages
 *   Page    a `page` node — what the respondent actually sees at once
 *   Group   a `section` node holding blocks
 *   Element any other flow node: branch, randomizer, loop, embedded data,
 *           quota check, redirect, end
 *
 * A Group is a section because that is what a section is, which is why
 * grouping cannot change execution order: the flow interpreter walks a
 * section's children in place, exactly as if the section were not there.
 */

export interface PageRef {
  node: { id: string; title?: string; questionIds: string[] };
  parent: any[];
  index: number;
}

export interface BlockRef {
  /** Stable identity: the block node's id when wrapped, else the page's. */
  id: string;
  title?: string;
  /** The node that IS the block — a `block` container, or a lone `page`. */
  node: any;
  parent: any[];
  /** Respondent-facing pages inside this block, in order. Never empty. */
  pages: PageRef[];
  /** True once the block holds a page break and became a `block` container. */
  wrapped: boolean;
}

export type FlowEntry =
  | { kind: "block"; block: BlockRef; node: any; parent: any[] }
  | { kind: "group"; node: any; parent: any[]; blocks: BlockRef[] }
  | { kind: "element"; node: any; parent: any[] };

export const isBlockNode = (n: any): boolean => n?.type === "page" || n?.type === "block";
export const isGroupNode = (n: any): boolean => n?.type === "section";

/** Every page node with its parent array, in visual order. */
export function listPages(flow: any[]): PageRef[] {
  const out: PageRef[] = [];
  const walk = (nodes: any[]) => {
    nodes.forEach((n, i) => {
      if (n?.type === "page") out.push({ node: n, parent: nodes, index: i });
      if (n?.children) walk(n.children);
      if (n?.branches) for (const b of n.branches) walk(b.children);
      if (n?.otherwise) walk(n.otherwise);
    });
  };
  walk(flow ?? []);
  return out;
}

/**
 * Blocks in visual order, wherever they live — including inside groups,
 * branches and loops.
 */
export function listBlocks(flow: any[]): BlockRef[] {
  const out: BlockRef[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "page") {
        out.push({
          id: n.id, title: n.title, node: n, parent: nodes, wrapped: false,
          pages: [{ node: n, parent: nodes, index: nodes.indexOf(n) }],
        });
        continue;
      }
      if (n.type === "block") {
        const kids: any[] = n.children ?? [];
        const pages = kids
          .filter((k) => k?.type === "page")
          .map((k) => ({ node: k, parent: kids, index: kids.indexOf(k) }));
        if (pages.length) {
          out.push({ id: n.id, title: n.title, node: n, parent: nodes, wrapped: true, pages });
        }
        // a block can still contain other constructs; they list on their own
        walk(kids.filter((k) => k?.type !== "page"));
        continue;
      }
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(flow ?? []);
  return out;
}

/** How many questions a block asks, across all of its pages. */
export function blockSize(b: BlockRef): number {
  return b.pages.reduce((t, p) => t + p.node.questionIds.length, 0);
}

/**
 * The flow as a survey programmer reads it: blocks and elements in order,
 * with groups holding their blocks.
 *
 * Page breaks do NOT appear at this level. They paginate one block; they are
 * not survey architecture. Listing them here is what made a four-block survey
 * read "Page 1, Page 2, Page 3, Page 4".
 */
export function flowOutline(nodes: any[]): FlowEntry[] {
  return (nodes ?? []).map((n) => {
    if (isGroupNode(n)) {
      const kids: any[] = n.children ?? [];
      return { kind: "group" as const, node: n, parent: nodes, blocks: listBlocks(kids) };
    }
    if (isBlockNode(n)) {
      const block = blockFromNode(n, nodes);
      return block
        ? { kind: "block" as const, block, node: n, parent: nodes }
        : { kind: "element" as const, node: n, parent: nodes };
    }
    return { kind: "element" as const, node: n, parent: nodes };
  });
}

/**
 * A BlockRef for one node, carrying the array it ACTUALLY lives in.
 *
 * `listBlocks([n])` would build the same shape but with a throwaway one-element
 * array as `parent`, and every mutation in the Studio splices through
 * `parent` — so a ref built that way silently edits a temporary array and
 * appears to do nothing.
 */
export function blockFromNode(n: any, parent: any[]): BlockRef | null {
  if (n?.type === "page") {
    return {
      id: n.id, title: n.title, node: n, parent, wrapped: false,
      pages: [{ node: n, parent, index: parent.indexOf(n) }],
    };
  }
  if (n?.type === "block") {
    const kids: any[] = n.children ?? [];
    const pages = kids
      .filter((k) => k?.type === "page")
      .map((k) => ({ node: k, parent: kids, index: kids.indexOf(k) }));
    if (!pages.length) return null;
    return { id: n.id, title: n.title, node: n, parent, wrapped: true, pages };
  }
  return null;
}
