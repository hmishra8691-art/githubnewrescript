import type { LogicFlow, LogicFlowEdge, LogicFlowNode, LogicFlowEdgeKind } from "@rescript/schema";

/**
 * LAYERED LAYOUT FOR THE FLOW CANVAS — hand-rolled, deterministic, pure.
 *
 * The engine's `buildLogicFlow` gives nodes and edges; this gives them
 * coordinates. Sugiyama in miniature: break the cycles, assign every node
 * to a layer by longest path from the start, order the nodes inside each
 * layer by the barycentre of their neighbours (a few sweeps down and up),
 * then hand out pixel positions top-to-bottom. Nodes with a stored position
 * (the programmer dragged them; `def.logicFlow` keeps x/y by id) are pinned
 * where they were left.
 *
 * Nothing here knows about React or SVG; it is tested directly, including
 * against the 600-question fixture, because a canvas that lays out 30 nodes
 * beautifully and 600 in a second is the failure the brief rules out.
 */

export interface LaidOutNode extends LogicFlowNode {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  /** true when the position came from the survey (a drag), not the algorithm */
  pinned: boolean;
}

export interface LaidOutEdge extends LogicFlowEdge {
  kind: LogicFlowEdgeKind;
  /** the edge goes to an earlier or same layer — drawn around the side */
  back: boolean;
  /** SVG path */
  d: string;
  /** label anchor */
  lx: number;
  ly: number;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  byId: Map<string, LaidOutNode>;
}

export const NODE_W = 220;
export const NODE_H: Record<LogicFlowNode["kind"], number> = { question: 44, decision: 52, action: 40, terminate: 40, end: 40 };
const GAP_X = 40;
const GAP_Y = 64;
const PAD = 40;

/** an edge's kind, for graphs built before `kind` existed */
export function edgeKind(e: LogicFlowEdge): LogicFlowEdgeKind {
  if (e.kind) return e.kind;
  const l = (e.label ?? "").toLowerCase();
  if (l === "otherwise") return "otherwise";
  if (l === "next iteration") return "loop";
  if (l === "full") return "quota";
  if (l.startsWith("skip")) return "skip";
  if (e.when) return "branch";
  return "sequence";
}

/**
 * Layers by longest path from the sources, on the graph with its cycles
 * broken. Loop back-edges are known cycles; any other edge that closes a
 * cycle (a skip backwards, a hand-drawn oddity) is found by DFS and treated
 * the same way — kept, drawn as a back edge, ignored for layering.
 */
export function assignLayers(nodes: LogicFlowNode[], edges: LogicFlowEdge[]): { layer: Map<string, number>; backEdges: Set<string> } {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, LogicFlowEdge[]>();
  for (const id of ids) out.set(id, []);
  const backEdges = new Set<string>();
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    if (edgeKind(e) === "loop") { backEdges.add(e.id); continue; }
    out.get(e.from)!.push(e);
  }
  // DFS to find remaining cycles
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) ?? []) {
      if (backEdges.has(e.id)) continue;
      const st = state.get(e.to) ?? 0;
      if (st === 1) { backEdges.add(e.id); continue; }
      if (st === 0) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);

  // longest path (Kahn), in node order so ties are deterministic
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const e of edges) if (idSet.has(e.from) && idSet.has(e.to) && !backEdges.has(e.id)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const layer = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of out.get(id) ?? []) {
      if (backEdges.has(e.id)) continue;
      layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1));
      indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0);
  return { layer, backEdges };
}

/** barycentre ordering within layers, a few sweeps each way */
function orderLayers(nodes: LogicFlowNode[], edges: LogicFlowEdge[], layer: Map<string, number>, backEdges: Set<string>): Map<string, number> {
  const layers = new Map<number, string[]>();
  for (const n of nodes) { const l = layer.get(n.id) ?? 0; (layers.get(l) ?? layers.set(l, []).get(l)!).push(n.id); }
  const pos = new Map<string, number>();
  for (const ids of layers.values()) ids.forEach((id, i) => pos.set(id, i));
  const up = new Map<string, string[]>(); const down = new Map<string, string[]>();
  for (const e of edges) {
    if (backEdges.has(e.id) || !layer.has(e.from) || !layer.has(e.to)) continue;
    (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to);
    (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from);
  }
  const maxLayer = Math.max(0, ...layers.keys());
  const sweep = (l: number, nb: Map<string, string[]>) => {
    const ids = layers.get(l);
    if (!ids || ids.length < 2) return;
    const bary = (id: string) => { const ns = nb.get(id) ?? []; return ns.length ? ns.reduce((a, b) => a + (pos.get(b) ?? 0), 0) / ns.length : pos.get(id) ?? 0; };
    const sorted = [...ids].sort((a, b) => bary(a) - bary(b) || (pos.get(a)! - pos.get(b)!));
    sorted.forEach((id, i) => pos.set(id, i));
    layers.set(l, sorted);
  };
  for (let iter = 0; iter < 4; iter++) {
    for (let l = 1; l <= maxLayer; l++) sweep(l, up);
    for (let l = maxLayer - 1; l >= 0; l--) sweep(l, down);
  }
  return pos;
}

export function layoutFlow(graph: LogicFlow, opts: { pinned?: boolean } = {}): Layout {
  const nodes = graph.nodes;
  const edges = graph.edges;
  const { layer, backEdges } = assignLayers(nodes, edges);
  const pos = orderLayers(nodes, edges, layer, backEdges);

  // layer geometry
  const perLayer = new Map<number, LogicFlowNode[]>();
  for (const n of nodes) { const l = layer.get(n.id) ?? 0; (perLayer.get(l) ?? perLayer.set(l, []).get(l)!).push(n); }
  const maxLayer = Math.max(0, ...perLayer.keys());
  const widest = Math.max(1, ...[...perLayer.values()].map((ns) => ns.length));
  const totalW = widest * NODE_W + (widest - 1) * GAP_X + PAD * 2;

  const laid: LaidOutNode[] = [];
  const byId = new Map<string, LaidOutNode>();
  let y = PAD;
  const layerY = new Map<number, number>();
  for (let l = 0; l <= maxLayer; l++) {
    const ns = (perLayer.get(l) ?? []).sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    const rowH = Math.max(0, ...ns.map((n) => NODE_H[n.kind]));
    layerY.set(l, y);
    const rowW = ns.length * NODE_W + (ns.length - 1) * GAP_X;
    let x = (totalW - rowW) / 2;
    for (const n of ns) {
      const pinned = opts.pinned !== false && typeof n.x === "number" && typeof n.y === "number";
      const node: LaidOutNode = {
        ...n, w: NODE_W, h: NODE_H[n.kind], layer: l, pinned,
        x: pinned ? (n.x as number) : x,
        y: pinned ? (n.y as number) : y,
      };
      laid.push(node); byId.set(n.id, node);
      x += NODE_W + GAP_X;
    }
    y += rowH + GAP_Y;
  }

  const laidEdges: LaidOutEdge[] = [];
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const kind = edgeKind(e);
    const back = backEdges.has(e.id) || b.y <= a.y;
    let d: string, lx: number, ly: number;
    if (!back) {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
      const c = Math.max(24, (y2 - y1) / 2);
      d = `M ${x1} ${y1} C ${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`;
      // the label sits just above its TARGET: arms fan out to different
      // targets, so labels that would collide at the midpoint separate here
      lx = x2; ly = y2 - 10;
    } else {
      // around the right-hand side, back up to the target's top
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2;
      const out = Math.max(x1, x2) + 36 + (kind === "loop" ? 12 : 0);
      d = `M ${x1} ${y1} C ${out} ${y1}, ${out} ${y2}, ${x2} ${y2}`;
      lx = out + 6; ly = (y1 + y2) / 2;
    }
    laidEdges.push({ ...e, kind, back, d, lx, ly });
  }

  const width = Math.max(totalW, ...laid.map((n) => n.x + n.w + PAD));
  const height = Math.max(y - GAP_Y + PAD, ...laid.map((n) => n.y + n.h + PAD));
  return { nodes: laid, edges: laidEdges, width, height, byId };
}

/* ------------------------------------------------------------ reachability */

/** every node that can reach `id` (upstream), following the graph's edges backwards */
export function upstream(graph: LogicFlow, id: string): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of graph.edges) (rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
  return bfs(id, rev);
}

/** every node `id` can lead to (downstream) */
export function downstream(graph: LogicFlow, id: string): Set<string> {
  const fwd = new Map<string, string[]>();
  for (const e of graph.edges) (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
  return bfs(id, fwd);
}

function bfs(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(adj.get(start) ?? [])];
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n) || n === start) continue;
    seen.add(n);
    queue.push(...(adj.get(n) ?? []));
  }
  return seen;
}

/** the edges on any path from `from` into `set` ∪ from `set` into `from` — for highlighting */
export function edgesTouching(graph: LogicFlow, nodes: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const e of graph.edges) if (nodes.has(e.from) && nodes.has(e.to)) out.add(e.id);
  return out;
}

/** fit a box of (w,h) into a viewport — the transform for "fit to screen" */
export function fitTransform(w: number, h: number, vw: number, vh: number, margin = 24): { k: number; tx: number; ty: number } {
  const k = Math.min(2, Math.max(0.05, Math.min((vw - margin * 2) / Math.max(1, w), (vh - margin * 2) / Math.max(1, h))));
  return { k, tx: (vw - w * k) / 2, ty: margin };
}
