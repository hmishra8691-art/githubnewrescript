import type { FlowNode, SurveyDefinition, Condition } from "@rescript/schema";

/**
 * BLOCK PREVIEW ISOLATION (client review 19/10/2026, item A44).
 *
 * "Preview block" used to run the WHOLE compiled flow and merely enter it at
 * the chosen block: Next walked on into the next block, Back walked out into
 * the previous one, and the completion card thanked the tester for the whole
 * survey. The review asks for the opposite: a block preview shows that block
 * and nothing else, forwards or backwards, and ends with "Thank you for
 * completing this block" / "Restart Block".
 *
 * The root-cause fix is a DEFINITION whose flow holds only the chosen node,
 * built here and handed to the ordinary Runner — the same compiler, the same
 * page breaks inside the block, the same display / skip logic, loops and auto
 * punch within it. Nothing is special-cased in navigation, so Back cannot
 * leave the block because there is nowhere outside it to go.
 *
 * What travels with the block:
 *   · the Embedded Data elements on the way to it (root level and inside its
 *     enclosing containers, before its position) — a block that pipes
 *     `{{ed.REGION}}` or branches on an embedded value still has the value;
 *   · its enclosing LOOPS, pruned to the path that reaches the block — a
 *     block inside a loop is previewed per iteration, with `{{loop.label}}`
 *     and the loop's variables intact, because that is what the block IS;
 *   · its own pages, children and everything inside them, untouched.
 *
 * What is left behind: sibling blocks and elements, enclosing branches,
 * randomizers and groups (the block is what the programmer asked to see, so
 * an enclosing branch that would have hidden it is not allowed to), and the
 * survey's own End elements — a single `end` of status `complete` closes the
 * scoped flow so the Runner shows its completion card.
 *
 * The block's OWN display logic (`visibleIf`) is lifted off the copy and
 * returned as `gate`, so the Runner can still show the block for testing
 * while saying that, with the current test values, the survey would have
 * hidden it. Survey-level display rules that name the block stay in force.
 *
 * The saved definition is never modified: this returns a new object with a
 * new `flow`; questions, calculations, quotas and everything else are shared
 * by reference.
 */

export interface BlockScope {
  /** the definition to run — the same survey with a flow of just the chosen node */
  def: SurveyDefinition;
  /** whether the node exists in the flow; false → `def` is the original, unchanged */
  found: boolean;
  /** the node's own display condition, removed from the scoped copy so the block can be shown regardless */
  gate?: Condition;
  /** the title of the chosen node, for the preview bar */
  title?: string;
}

type AnyNode = FlowNode & { children?: FlowNode[]; otherwise?: FlowNode[]; branches?: { children: FlowNode[] }[]; visibleIf?: Condition; title?: string };

/** every child list a node owns, in order (branch paths, then "otherwise") */
function childLists(n: AnyNode): FlowNode[][] {
  const out: FlowNode[][] = [];
  if (Array.isArray(n.children)) out.push(n.children);
  if (Array.isArray(n.branches)) for (const b of n.branches) if (Array.isArray(b?.children)) out.push(b.children);
  if (Array.isArray(n.otherwise)) out.push(n.otherwise);
  return out;
}

/**
 * The path of nodes from the root list down to (and including) the one with
 * this id, each paired with the list it sits in — or null when it is not in
 * the flow.
 */
function pathTo(flow: FlowNode[], id: string): { node: AnyNode; siblings: FlowNode[] }[] | null {
  const walk = (nodes: FlowNode[], trail: { node: AnyNode; siblings: FlowNode[] }[]): { node: AnyNode; siblings: FlowNode[] }[] | null => {
    for (const raw of nodes) {
      const n = raw as AnyNode;
      if (!n || typeof n !== "object") continue;
      const here = [...trail, { node: n, siblings: nodes }];
      if (n.id === id) return here;
      for (const list of childLists(n)) {
        const hit = walk(list, here);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(flow ?? [], []);
}

/** the embedded-data elements of `list` that come before `upTo` */
function embeddedBefore(list: FlowNode[], upTo: FlowNode): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of list) {
    if (n === upTo) break;
    if ((n as AnyNode).type === "embedded_data") out.push(n);
  }
  return out;
}

const END_ID = "__block_preview_end";

/**
 * A definition whose flow is just the chosen block (or group, loop — any flow
 * node), closed by an End element. See the file comment for what travels
 * with it. Returns the original definition untouched when the id is unknown.
 */
export function scopeDefinitionToNode(def: SurveyDefinition, nodeId: string | undefined | null): BlockScope {
  if (!nodeId) return { def, found: false };
  const path = pathTo(def.flow as FlowNode[], nodeId);
  if (!path) return { def, found: false };

  const target = path[path.length - 1].node;
  const gate = target.visibleIf;
  /* the block itself, without its own gate (the Runner reports it instead) */
  const { visibleIf: _lifted, ...rest } = target;
  void _lifted;
  const block = rest as FlowNode;

  /*
   * Rebuild from the inside out: start with the block, then wrap it in each
   * enclosing LOOP (pruned to the path), carrying the embedded-data elements
   * that precede the path at every level. Branches, randomizers and groups
   * are flattened — their preceding embedded data still comes along.
   */
  let inner: FlowNode[] = [block];
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, siblings } = path[i];
    const before = embeddedBefore(siblings, node as FlowNode);
    if (i === path.length - 1) {
      inner = [...before, ...inner];
      continue;
    }
    if (node.type === "loop") {
      const loop = { ...(node as AnyNode), children: inner } as FlowNode;
      inner = [...before, loop];
    } else {
      inner = [...before, ...inner];
    }
  }

  const end: FlowNode = { type: "end", id: END_ID, status: "complete" };
  const flow: FlowNode[] = [...inner, end];
  return {
    def: { ...def, flow } as SurveyDefinition,
    found: true,
    gate,
    title: typeof target.title === "string" ? target.title : undefined,
  };
}
