import type { FlowNode } from "@rescript/schema";

/**
 * The Survey Flow tree: addressing, nesting rules, and moves.
 *
 * This is the ONE implementation of "where can this go, and what happens when
 * I put it there". The Studio's drag-and-drop, its ⋮ menus, its keyboard moves
 * and its structure validation all call these functions, so a drag and a menu
 * command cannot disagree — and because every one of them returns a new flow
 * array rather than mutating a rendered view, there is no visual-only state to
 * fall out of step with the saved definition (req §22).
 *
 * ## The model
 *
 * A flow is a list of nodes. Some nodes hold lists of their own, and a node
 * can hold MORE than one list — a branch has one per condition plus its
 * "otherwise". So a position is addressed by three things:
 *
 *     container  which list  → { ownerId, slot }
 *     index      where in it
 *
 * `ownerId: null` is the root list. `slot` is "children", "otherwise", or
 * "branch:<branchId>". That is the whole addressing scheme, and it is why a
 * new container type needs no new drag code: declare it in CONTAINER_SLOTS and
 * it participates.
 */

/* ------------------------------------------------------------- addressing */

export interface FlowContainer {
  /** null = the root flow list. */
  ownerId: string | null;
  /** "children" | "otherwise" | `branch:<id>` */
  slot: string;
}

export interface FlowLocation {
  container: FlowContainer;
  index: number;
  node: FlowNode;
}

/** Where a drag or a move wants to put something. */
export type FlowDropTarget =
  | { kind: "before"; refId: string }
  | { kind: "after"; refId: string }
  /** Into a container, at `index` (default: the end). */
  | { kind: "inside"; ownerId: string | null; slot: string; index?: number };

export interface DropVerdict {
  ok: boolean;
  /** Shown to the programmer when a drop is refused (req §23). */
  reason?: string;
}

const rootContainer: FlowContainer = { ownerId: null, slot: "children" };

export const sameContainer = (a: FlowContainer, b: FlowContainer): boolean =>
  a.ownerId === b.ownerId && a.slot === b.slot;

/**
 * Which lists a node type owns.
 *
 * `block` deliberately owns nothing here: its children are the respondent's
 * pages, edited in the Questions tab, and letting the flow drop arbitrary
 * elements between them is how a block stops being one block.
 */
export function containerSlots(node: FlowNode): string[] {
  switch (node.type) {
    case "section":
    case "randomizer":
    case "loop":
      return ["children"];
    case "branch":
      return [...node.branches.map((b) => `branch:${b.id}`), "otherwise"];
    default:
      return [];
  }
}

export const isContainerNode = (n: FlowNode): boolean => containerSlots(n).length > 0;

/** Read the list a container addresses, or null when it does not exist. */
export function readContainer(flow: FlowNode[], c: FlowContainer): FlowNode[] | null {
  if (c.ownerId === null) return flow;
  const owner = findNode(flow, c.ownerId);
  if (!owner) return null;
  return readSlot(owner, c.slot);
}

function readSlot(owner: FlowNode, slot: string): FlowNode[] | null {
  if (slot === "children") return (owner as any).children ?? null;
  if (owner.type !== "branch") return null;
  if (slot === "otherwise") return owner.otherwise ?? [];
  const id = slot.startsWith("branch:") ? slot.slice(7) : null;
  const b = id ? owner.branches.find((x) => x.id === id) : undefined;
  return b ? b.children : null;
}

/** Every container in the flow, outermost first. */
export function allContainers(flow: FlowNode[]): FlowContainer[] {
  const out: FlowContainer[] = [rootContainer];
  const walk = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      for (const slot of containerSlots(n)) {
        out.push({ ownerId: n.id, slot });
        const list = readSlot(n, slot);
        if (list) walk(list);
      }
    }
  };
  walk(flow);
  return out;
}

export function findNode(flow: FlowNode[], id: string): FlowNode | null {
  return locateNode(flow, id)?.node ?? null;
}

/** Where a node lives: its container and index. */
export function locateNode(flow: FlowNode[], id: string): FlowLocation | null {
  const walk = (nodes: FlowNode[], container: FlowContainer): FlowLocation | null => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { container, index: i, node: n };
      for (const slot of containerSlots(n)) {
        const list = readSlot(n, slot);
        if (!list) continue;
        const hit = walk(list, { ownerId: n.id, slot });
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(flow, rootContainer);
}

/** A node's ancestors, outermost first — used for cycle checks and crumbs. */
export function ancestorsOf(flow: FlowNode[], id: string): FlowNode[] {
  const path: FlowNode[] = [];
  const walk = (nodes: FlowNode[], trail: FlowNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === id) { path.push(...trail); return true; }
      for (const slot of containerSlots(n)) {
        const list = readSlot(n, slot);
        if (list && walk(list, [...trail, n])) return true;
      }
    }
    return false;
  };
  walk(flow, []);
  return path;
}

/** Every id in a subtree, including the node's own. */
export function subtreeIds(node: FlowNode): string[] {
  const out: string[] = [node.id];
  for (const slot of containerSlots(node)) {
    for (const child of readSlot(node, slot) ?? []) out.push(...subtreeIds(child));
  }
  // a `block` keeps its pages, which are nodes with ids too
  if (node.type === "block") for (const child of node.children) out.push(...subtreeIds(child));
  return out;
}

/* ---------------------------------------------------------- nesting rules */

/**
 * What each container accepts. One table, consulted by every code path — this
 * is the "reusable engine" the brief asks for: a future flow element joins the
 * system by appearing here, not by growing its own drag handlers.
 */
const NEVER_INSIDE: Record<string, FlowNode["type"][]> = {
  // A randomizer shuffles what comes next; an End inside one makes every
  // sibling after it unreachable in the orders that put it first.
  randomizer: ["end"],
  // Same trap, worse: an End inside a loop kills the remaining iterations.
  loop: ["end"],
};

/**
 * How a destination reads in a "move into…" menu.
 *
 * The type alone is not enough once a survey has three groups — the name is
 * what the programmer is choosing between, so it is part of the label rather
 * than a subtitle they have to scan separately.
 */
export function containerLabel(owner: FlowNode | null, slot: string): string {
  if (!owner) return "Top level of the survey";
  const type = FLOW_TYPE_LABELS[owner.type] ?? owner.type;
  if (owner.type === "branch") {
    const branchName = (owner as any).title ? ` (${(owner as any).title})` : "";
    if (slot === "otherwise") return `Branch — otherwise path${branchName}`;
    const b = owner.branches.find((x) => x.id === slot.slice(7));
    return `Branch — “${b?.label || "untitled path"}”${branchName}`;
  }
  const title = (owner as any).title as string | undefined;
  return title?.trim() ? `${type} “${title.trim()}”` : type;
}

export const FLOW_TYPE_LABELS: Record<string, string> = {
  page: "Block",
  block: "Block",
  section: "Group",
  randomizer: "Randomizer",
  branch: "Branch",
  loop: "Loop",
  embedded_data: "Embedded data",
  quota_check: "Quota check",
  redirect: "Redirect",
  end: "End of survey",
};

/**
 * May `dragged` sit directly inside this container? Structure only — the
 * cycle check is separate because it needs the whole tree.
 */
export function containerAccepts(
  owner: FlowNode | null,
  slot: string,
  dragged: FlowNode,
): DropVerdict {
  if (owner && !containerSlots(owner).includes(slot)) {
    return { ok: false, reason: `${FLOW_TYPE_LABELS[owner.type] ?? owner.type} has no “${slot}” list` };
  }
  if (owner) {
    const banned = NEVER_INSIDE[owner.type] ?? [];
    if (banned.includes(dragged.type)) {
      return {
        ok: false,
        reason: `${FLOW_TYPE_LABELS[dragged.type]} cannot go inside a ${FLOW_TYPE_LABELS[owner.type]} — everything after it would become unreachable`,
      };
    }
  }
  return { ok: true };
}

/** Can this move be made? Everything that refuses a drop lives here. */
export function canDropFlowNode(
  flow: FlowNode[],
  draggedId: string,
  target: FlowDropTarget,
): DropVerdict {
  const from = locateNode(flow, draggedId);
  if (!from) return { ok: false, reason: "that element is no longer in the flow" };

  const resolved = resolveTarget(flow, target);
  if (!resolved) return { ok: false, reason: "that position no longer exists" };
  const { container } = resolved;

  const owner = container.ownerId ? findNode(flow, container.ownerId) : null;
  if (container.ownerId && !owner) return { ok: false, reason: "that position no longer exists" };

  // into itself, or into anything it contains — the classic way to lose a
  // subtree, so it is refused rather than repaired
  const inside = subtreeIds(from.node);
  if (container.ownerId && inside.includes(container.ownerId)) {
    return {
      ok: false,
      reason: container.ownerId === draggedId
        ? "an element cannot be dropped inside itself"
        : "that would put an element inside something it already contains",
    };
  }
  if (target.kind !== "inside") {
    const refLoc = locateNode(flow, target.refId);
    if (refLoc && inside.includes(target.refId) && target.refId !== draggedId) {
      return { ok: false, reason: "that would put an element inside something it already contains" };
    }
  }

  return containerAccepts(owner, container.slot, from.node);
}

/* ----------------------------------------------------------------- moving */

interface ResolvedTarget {
  container: FlowContainer;
  index: number;
}

function resolveTarget(flow: FlowNode[], target: FlowDropTarget): ResolvedTarget | null {
  if (target.kind === "inside") {
    const container = { ownerId: target.ownerId, slot: target.slot };
    const list = readContainer(flow, container);
    if (!list) {
      // an empty branch/otherwise list that has never been written to
      const owner = target.ownerId ? findNode(flow, target.ownerId) : null;
      if (!owner || !containerSlots(owner).includes(target.slot)) return null;
      return { container, index: 0 };
    }
    if (target.index != null) return { container, index: target.index };
    /**
     * "Append" means the end of the part a respondent can REACH.
     *
     * The flow stops at the first End node, so appending past it produces a
     * block the Studio draws and nobody is ever shown — the commonest way to
     * lose work without any error appearing. A drag always names its index, so
     * this only decides where menu moves and plain inserts land.
     */
    const endAt = list.findIndex((n) => n.type === "end");
    return { container, index: endAt < 0 ? list.length : endAt };
  }
  const ref = locateNode(flow, target.refId);
  if (!ref) return null;
  return {
    container: ref.container,
    index: target.kind === "before" ? ref.index : ref.index + 1,
  };
}

/** Ensure a container list exists on the owner, creating empty ones. */
function writableContainer(flow: FlowNode[], c: FlowContainer): FlowNode[] | null {
  if (c.ownerId === null) return flow;
  const owner = findNode(flow, c.ownerId) as any;
  if (!owner) return null;
  if (c.slot === "children") {
    if (!Array.isArray(owner.children)) owner.children = [];
    return owner.children;
  }
  if (owner.type !== "branch") return null;
  if (c.slot === "otherwise") {
    if (!Array.isArray(owner.otherwise)) owner.otherwise = [];
    return owner.otherwise;
  }
  const b = owner.branches.find((x: any) => x.id === c.slot.slice(7));
  if (!b) return null;
  if (!Array.isArray(b.children)) b.children = [];
  return b.children;
}

export interface MoveResult {
  flow: FlowNode[];
  moved: boolean;
  reason?: string;
}

/**
 * Move a node to a new position, subtree and all.
 *
 * The node object itself is carried across by reference, so ids, questions,
 * conditions, randomization settings, piping and everything else nested inside
 * are the same objects afterwards — nothing is rebuilt, which is what makes
 * "preserve structure during every move" (req §11) true by construction rather
 * than by careful copying.
 */
export function moveFlowNode(
  flow: FlowNode[],
  draggedId: string,
  target: FlowDropTarget,
): MoveResult {
  const verdict = canDropFlowNode(flow, draggedId, target);
  if (!verdict.ok) return { flow, moved: false, reason: verdict.reason };

  const next: FlowNode[] = structuredClone(flow);
  const from = locateNode(next, draggedId);
  const resolved = resolveTarget(next, target);
  if (!from || !resolved) return { flow, moved: false, reason: "that position no longer exists" };

  const fromList = writableContainer(next, from.container);
  if (!fromList) return { flow, moved: false, reason: "that element is no longer in the flow" };

  const [node] = fromList.splice(from.index, 1);

  const toList = writableContainer(next, resolved.container);
  if (!toList) {
    // put it back rather than dropping it on the floor
    fromList.splice(from.index, 0, node);
    return { flow, moved: false, reason: "that position no longer exists" };
  }

  // Removing from the same list first shifts everything after it left by one.
  let at = resolved.index;
  if (toList === fromList && from.index < resolved.index) at -= 1;
  toList.splice(Math.max(0, Math.min(at, toList.length)), 0, node);

  return { flow: next, moved: true };
}

/** Insert a new node at a target position. Same rules as a move. */
export function insertFlowNode(
  flow: FlowNode[],
  node: FlowNode,
  target: FlowDropTarget,
): MoveResult {
  const next: FlowNode[] = structuredClone(flow);
  const resolved = resolveTarget(next, target);
  if (!resolved) return { flow, moved: false, reason: "that position no longer exists" };
  const owner = resolved.container.ownerId ? findNode(next, resolved.container.ownerId) : null;
  const verdict = containerAccepts(owner, resolved.container.slot, node);
  if (!verdict.ok) return { flow, moved: false, reason: verdict.reason };
  const list = writableContainer(next, resolved.container);
  if (!list) return { flow, moved: false, reason: "that position no longer exists" };
  list.splice(Math.max(0, Math.min(resolved.index, list.length)), 0, node);
  return { flow: next, moved: true };
}

/** Remove a node (and its subtree). Returns the new flow and what was removed. */
export function removeFlowNode(flow: FlowNode[], id: string): { flow: FlowNode[]; removed: FlowNode | null } {
  const next: FlowNode[] = structuredClone(flow);
  const loc = locateNode(next, id);
  if (!loc) return { flow, removed: null };
  const list = writableContainer(next, loc.container);
  if (!list) return { flow, removed: null };
  const [removed] = list.splice(loc.index, 1);
  return { flow: next, removed };
}

/**
 * Copy a subtree with fresh ids for every node inside it.
 *
 * Duplicating without this produces two nodes claiming one id, which the flow
 * interpreter resolves by finding the first one — so the copy would silently
 * never run (req §23, "would this create a duplicate reference?").
 */
export function cloneFlowSubtree(node: FlowNode, newId: (prefix: string) => string): FlowNode {
  const copy: any = structuredClone(node);
  const rewrite = (n: any) => {
    n.id = newId(n.type);
    for (const child of n.children ?? []) rewrite(child);
    if (n.branches) {
      for (const b of n.branches) {
        b.id = newId("br");
        for (const child of b.children ?? []) rewrite(child);
      }
    }
    for (const child of n.otherwise ?? []) rewrite(child);
  };
  rewrite(copy);
  return copy as FlowNode;
}

/* ------------------------------------------------------------- describing */

export interface FlowNodeSummary {
  id: string;
  type: FlowNode["type"];
  label: string;
  /** "6 questions", "4 blocks", … — the second line of a drag preview. */
  detail: string;
  blocks: number;
  questions: number;
  children: number;
}

/** What a node IS, for drag previews, menus and the ⋮ "move to" list (req §9). */
export function summarizeFlowNode(node: FlowNode): FlowNodeSummary {
  let blocks = 0;
  let questions = 0;
  const walk = (n: any) => {
    if (n?.type === "page") {
      // a lone page IS a block; pages inside a `block` are handled below, so
      // reaching one here means it stands on its own
      questions += n.questionIds?.length ?? 0;
      blocks += 1;
    }
    if (n?.type === "block") {
      blocks += 1;
      for (const c of n.children ?? []) {
        if (c?.type === "page") questions += c.questionIds?.length ?? 0;
        else walk(c);
      }
      return;
    }
    for (const c of n?.children ?? []) walk(c);
    for (const b of n?.branches ?? []) for (const c of b.children ?? []) walk(c);
    for (const c of n?.otherwise ?? []) walk(c);
  };
  walk(node);

  const typeLabel = FLOW_TYPE_LABELS[node.type] ?? node.type;
  const title = (node as any).title as string | undefined;
  const label = title?.trim() || typeLabel;

  let detail: string;
  switch (node.type) {
    case "page":
    case "block":
      detail = `${questions} question${questions === 1 ? "" : "s"}`;
      break;
    case "section":
      detail = `${blocks} block${blocks === 1 ? "" : "s"}`;
      break;
    case "randomizer":
      detail = node.show != null
        ? `show ${node.show} of ${node.children.length}`
        : `${node.children.length} item${node.children.length === 1 ? "" : "s"}, shuffled`;
      break;
    case "branch":
      detail = `${node.branches.length} condition${node.branches.length === 1 ? "" : "s"}`;
      break;
    case "loop":
      detail = `over ${node.loopVar}`;
      break;
    case "embedded_data":
      detail = `${node.fields.length} field${node.fields.length === 1 ? "" : "s"}`;
      break;
    case "quota_check":
      detail = `${node.quotaIds.length} quota${node.quotaIds.length === 1 ? "" : "s"}`;
      break;
    case "redirect":
      detail = node.url || "no URL set";
      break;
    case "end":
      detail = node.status;
      break;
    default:
      detail = "";
  }

  const childCount = containerSlots(node)
    .reduce((t, slot) => t + (readSlot(node, slot)?.length ?? 0), 0);

  return { id: node.id, type: node.type, label, detail, blocks, questions, children: childCount };
}

/* ------------------------------------------------------------- validation */

export interface FlowStructureIssue {
  level: "error" | "warning";
  nodeId?: string;
  message: string;
}

/**
 * Structural problems a flow can carry (req §23).
 *
 * This checks the SHAPE of the flow — logic references are `lintSurveyLogic`'s
 * job. Both are reported together in the Studio's Logic check.
 */
export function validateFlowStructure(flow: FlowNode[]): FlowStructureIssue[] {
  const issues: FlowStructureIssue[] = [];
  const seen = new Map<string, number>();

  const walk = (nodes: FlowNode[], owner: FlowNode | null, slot: string, depth: number) => {
    if (depth > 40) {
      issues.push({ level: "error", message: "Flow nesting is too deep to evaluate — check for a cycle" });
      return;
    }
    let endAt = -1;
    nodes.forEach((n, i) => {
      seen.set(n.id, (seen.get(n.id) ?? 0) + 1);

      const verdict = containerAccepts(owner, slot, n);
      if (!verdict.ok) {
        issues.push({
          level: "error",
          nodeId: n.id,
          message: `${summarizeFlowNode(n).label}: ${verdict.reason}`,
        });
      }

      if (n.type === "end" && endAt < 0) endAt = i;
      else if (endAt >= 0 && owner === null) {
        issues.push({
          level: "warning",
          nodeId: n.id,
          message: `${summarizeFlowNode(n).label} comes after the end of the survey, so no respondent reaches it`,
        });
      }

      for (const s of containerSlots(n)) walk(readSlot(n, s) ?? [], n, s, depth + 1);
      if (n.type === "block") {
        const nonPage = n.children.filter((c) => c.type !== "page");
        if (nonPage.length) {
          issues.push({
            level: "warning",
            nodeId: n.id,
            message: `Block “${summarizeFlowNode(n).label}” contains ${nonPage.length} element(s) that are not pages`,
          });
        }
      }
    });
  };
  walk(flow, null, "children", 0);

  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push({
        level: "error",
        nodeId: id,
        message: `Two flow elements share the id "${id}" — only the first will ever run`,
      });
    }
  }

  return issues;
}
