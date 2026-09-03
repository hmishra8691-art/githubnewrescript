"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import {
  type FlowDropTarget, type FlowContainer,
  moveFlowNode, insertFlowNode, removeFlowNode, cloneFlowSubtree,
  locateNode, findNode, allContainers, summarizeFlowNode, containerSlots,
  containerLabel, canDropFlowNode, validateFlowStructure,
  listBlocks, blockSize, isBlockNode, isGroupNode,
  FLOW_TYPE_LABELS,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { newBlockNode, newGroupNode, ELEMENT_LABELS, INSERTABLE } from "./blockModel";
import { conditionToText } from "./ConditionBuilder";
import { NodeEditor } from "./FlowNodeEditors";
import {
  FlowDragProvider, useFlowDrag, DragHandle, DropZone, InsideDropTarget, EmptyContainerZone,
} from "./FlowDnd";

/* ==========================================================================
 * Survey Flow — one recursive tree over the canonical definition.
 *
 * Before this, the panel rendered a flattened outline: top-level blocks,
 * groups one level deep, and everything nested inside a randomizer or a branch
 * only reachable by expanding a card into a different, older editor. Dragging
 * worked between "+ Add element" lines and nowhere else, which is why putting
 * a group inside a randomizer was impossible without deleting and rebuilding
 * it.
 *
 * Now every container renders the SAME component for its children, at any
 * depth, and every position between or inside those children is a drop target.
 * Nesting is therefore not a feature of any particular element — a randomizer
 * inside a randomizer inside a branch needs no code of its own, because the
 * rules live in the engine's one table and the rendering is one recursion.
 *
 * Every mutation goes through the engine's move/insert/remove, which refuse
 * what would break the flow and preserve subtrees by reference, and then
 * through `s.update`, which autosaves. There is no drag state that is not
 * already in the definition. (reqs §1, §11, §22)
 * ======================================================================== */

function newNode(type: FlowNode["type"]): FlowNode {
  const id = uid(type);
  switch (type) {
    case "page": return { type, id, title: "New block", questionIds: [] };
    case "section": return { type, id, title: "New group", children: [] };
    case "block": return { type, id, title: "Block", children: [] };
    case "randomizer": return { type, id, children: [] };
    case "branch": return {
      type, id,
      branches: [{ id: uid("br"), label: "Path 1", when: { type: "group", op: "and", children: [] }, children: [] }],
      otherwise: [],
    };
    case "loop": return { type, id, source: { kind: "static", items: [] }, loopVar: "item", children: [] };
    case "embedded_data": return { type, id, fields: [{ name: "", source: "url", dataType: "string" }] };
    case "quota_check": return { type, id, quotaIds: [], onFull: { kind: "terminate" } };
    case "redirect": return { type, id, url: "https://" };
    case "end": return { type, id, status: "complete" };
  }
}

const makeNode = (type: string): FlowNode =>
  type === "page" ? (newBlockNode() as FlowNode)
  : type === "section" ? (newGroupNode() as FlowNode)
  : newNode(type as FlowNode["type"]);

/* ------------------------------------------------------ the element picker */

/**
 * One picker, used everywhere something can be added (req §19) — between
 * cards, inside a randomizer, inside a branch path. Same list, same search,
 * same wording, so "add an element" is one thing to learn.
 */
function AddElementMenu({ onAdd, testid, compact }: {
  onAdd(type: string): void; testid?: string; compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const f = filter.trim().toLowerCase();
  const items = INSERTABLE.filter(
    (it) => !f || it.label.toLowerCase().includes(f) || it.hint.toLowerCase().includes(f),
  );
  return (
    <div className="menu-anchor">
      <button className={compact ? "fi-btn" : "btn small"} data-testid={testid ?? "flow-insert"}
        title="Add a flow element here" onClick={() => setOpen((o) => !o)}>
        + Add element
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu wide" role="menu" data-testid="flow-insert-menu">
            <input className="input" autoFocus placeholder="search elements…"
              data-testid="flow-insert-search"
              value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="menu-scroll">
              {items.map((it) => (
                <button key={it.type} className="menu-item" data-testid={`insert-${it.type}`}
                  onClick={() => { setOpen(false); setFilter(""); onAdd(it.type); }}>
                  <span className="mi-label">{it.label}</span>
                  <span className="mi-hint">{it.hint}</span>
                </button>
              ))}
              {items.length === 0 && <div className="menu-group">nothing matches “{filter}”</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- the ⋮ menu */

/**
 * Everything a drag can do, available without one (req §20).
 *
 * "Move to" lists every container in the survey that would ACCEPT this
 * element — the list is filtered by the same `canDropFlowNode` the drop zones
 * use, so the menu can never offer a move the drag would refuse.
 */
function NodeMenu({ nodeId, onDelete, onDuplicate, onMoveTo, onMoveStep }: {
  nodeId: string;
  onDelete(): void;
  onDuplicate(): void;
  onMoveTo(target: FlowDropTarget): void;
  onMoveStep(dir: -1 | 1): void;
}) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const flow = s.def.flow as FlowNode[];

  const destinations = React.useMemo(() => {
    if (!open) return [];
    return allContainers(flow)
      .map((c: FlowContainer) => {
        const target: FlowDropTarget = { kind: "inside", ownerId: c.ownerId, slot: c.slot };
        const owner = c.ownerId ? findNode(flow, c.ownerId) : null;
        return { c, target, owner, verdict: canDropFlowNode(flow, nodeId, target) };
      })
      .filter((d) => d.verdict.ok)
      // where it already is, is not a destination
      .filter((d) => {
        const loc = locateNode(flow, nodeId);
        return !(loc && loc.container.ownerId === d.c.ownerId && loc.container.slot === d.c.slot);
      });
  }, [open, flow, nodeId]);

  return (
    <div className="menu-anchor">
      <button className="btn small" data-testid="node-menu" title="More actions"
        onClick={() => setOpen((o) => !o)}>⋮</button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu" role="menu" data-testid="node-menu-open">
            <button className="menu-item" onClick={() => { setOpen(false); onMoveStep(-1); }}>
              <span className="mi-label">Move up</span>
            </button>
            <button className="menu-item" onClick={() => { setOpen(false); onMoveStep(1); }}>
              <span className="mi-label">Move down</span>
            </button>
            <button className="menu-item" data-testid="node-duplicate"
              onClick={() => { setOpen(false); onDuplicate(); }}>
              <span className="mi-label">Duplicate</span>
              <span className="mi-hint">a copy with new ids</span>
            </button>
            <div className="menu-group">Move into…</div>
            <div className="menu-scroll">
              {destinations.map(({ c, target, owner }) => (
                <button key={`${c.ownerId ?? "root"}/${c.slot}`} className="menu-item"
                  data-testid="move-into"
                  onClick={() => { setOpen(false); onMoveTo(target); }}>
                  <span className="mi-label">{containerLabel(owner as FlowNode | null, c.slot)}</span>
                  {owner && <span className="mi-hint">{summarizeFlowNode(owner as FlowNode).detail}</span>}
                </button>
              ))}
              {destinations.length === 0 && (
                <div className="menu-group">nowhere else it can go</div>
              )}
            </div>
            <button className="menu-item danger" data-testid="node-delete"
              onClick={() => { setOpen(false); onDelete(); }}>
              <span className="mi-label">Delete</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------- shared plumbing */

interface FlowOps {
  move(id: string, target: FlowDropTarget): void;
  insert(type: string, target: FlowDropTarget): void;
  remove(id: string): void;
  duplicate(id: string): void;
  patch(id: string, next: FlowNode): void;
  rename(id: string, title: string): void;
  step(id: string, dir: -1 | 1): void;
  openQuestions(blockId: string): void;
  /** 1-based position of a block among ALL blocks, wherever they are nested. */
  blockNumber(id: string): number | null;
}
const OpsCtx = React.createContext<FlowOps | null>(null);
const useOps = () => {
  const v = React.useContext(OpsCtx);
  if (!v) throw new Error("flow ops outside provider");
  return v;
};

/** A stable key for a drop zone, so verdicts can be cached per drag. */
const zoneKey = (t: FlowDropTarget): string =>
  t.kind === "inside"
    ? `in:${t.ownerId ?? "root"}:${t.slot}:${t.index ?? "end"}`
    : `${t.kind}:${t.refId}`;

/**
 * One container's children, with a drop line before each and after the last.
 * This is the recursion: a group, a randomizer, a loop and each branch path
 * all render through here.
 */
function FlowChildren({ nodes, container, depth, what }: {
  nodes: FlowNode[]; container: FlowContainer; depth: number; what: string;
}) {
  const ops = useOps();
  const insideTarget = (index: number): FlowDropTarget =>
    ({ kind: "inside", ownerId: container.ownerId, slot: container.slot, index });

  if (nodes.length === 0) {
    return (
      <div className="flow-children">
        <EmptyContainerZone zoneKey={zoneKey(insideTarget(0))} target={insideTarget(0)} what={what} />
        <div className="row" style={{ marginTop: 6 }}>
          <AddElementMenu compact testid="flow-insert-empty"
            onAdd={(t) => ops.insert(t, insideTarget(0))} />
        </div>
      </div>
    );
  }

  return (
    <div className="flow-children">
      {nodes.map((node, i) => (
        <React.Fragment key={node.id}>
          <FlowDropRow target={insideTarget(i)} onAdd={(t) => ops.insert(t, insideTarget(i))} />
          <FlowCard node={node} depth={depth} />
        </React.Fragment>
      ))}
      <FlowDropRow target={insideTarget(nodes.length)}
        onAdd={(t) => ops.insert(t, insideTarget(nodes.length))} />
    </div>
  );
}

/** A drop line with the "+ Add element" affordance sitting on it. */
function FlowDropRow({ target, onAdd }: { target: FlowDropTarget; onAdd(type: string): void }) {
  const { dragging } = useFlowDrag();
  return (
    <div className="flow-insert">
      {dragging ? (
        <DropZone zoneKey={zoneKey(target)} target={target} label="Drop here" />
      ) : (
        <>
          <span className="fi-rail" />
          <AddElementMenu compact onAdd={onAdd} />
          <span className="fi-rail" />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the cards */

function FlowCard({ node, depth }: { node: FlowNode; depth: number }) {
  if (isGroupNode(node)) return <GroupCard node={node} depth={depth} />;
  if (isBlockNode(node)) return <BlockCard node={node} />;
  if (node.type === "branch") return <BranchCard node={node} depth={depth} />;
  if (containerSlots(node).length > 0) return <ContainerCard node={node} depth={depth} />;
  return <ElementCard node={node} />;
}

/** The bar every card shares: grip, badge, name, summary, actions. */
function CardHead({ node, badge, badgeClass, children }: {
  node: FlowNode; badge: string; badgeClass: string; children?: React.ReactNode;
}) {
  const ops = useOps();
  const summary = summarizeFlowNode(node);
  return (
    <div className="fc-head">
      <DragHandle id={node.id} />
      <span className={badgeClass}>{badge}</span>
      {children}
      <span className="muted block-count" data-testid="card-detail">{summary.detail}</span>
      <NodeMenu nodeId={node.id}
        onDelete={() => ops.remove(node.id)}
        onDuplicate={() => ops.duplicate(node.id)}
        onMoveTo={(t) => ops.move(node.id, t)}
        onMoveStep={(dir) => ops.step(node.id, dir)} />
    </div>
  );
}

function BlockCard({ node }: { node: FlowNode }) {
  const s = useStudio();
  const ops = useOps();
  const [open, setOpen] = React.useState(false);
  const block = listBlocks([node])[0];
  const pages = block?.pages ?? [];
  const n = block ? blockSize(block) : 0;

  return (
    <div className="flow-card block-card" data-testid="flow-block" data-node-id={node.id}>
      <div className="fc-head">
        <DragHandle id={node.id} />
        <button className="block-toggle" onClick={() => setOpen((o) => !o)}
          title={open ? "Hide questions" : "Show questions"}>{open ? "▾" : "▸"}</button>
        <span className="block-badge">BLOCK {ops.blockNumber(node.id) ?? ""}</span>
        <input className="input block-title" data-testid="flow-block-title"
          placeholder="Name this block" value={(node as any).title ?? ""}
          onChange={(e) => ops.rename(node.id, e.target.value)} />
        <span className="muted block-count">
          {n} question{n === 1 ? "" : "s"}{pages.length > 1 ? ` · ${pages.length} pages` : ""}
        </span>
        <button className="btn small" title="Edit this block's questions"
          onClick={() => ops.openQuestions(node.id)}>edit</button>
        <NodeMenu nodeId={node.id}
          onDelete={() => ops.remove(node.id)}
          onDuplicate={() => ops.duplicate(node.id)}
          onMoveTo={(t) => ops.move(node.id, t)}
          onMoveStep={(dir) => ops.step(node.id, dir)} />
      </div>
      {open && (
        <div className="fc-body">
          {pages.map((p, pi) => (
            <div key={p.node.id} className="fc-page">
              {pages.length > 1 && <span className="page-badge">PAGE {pi + 1}</span>}
              {p.node.questionIds.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>empty</span>
              )}
              {p.node.questionIds.map((qid: string) => {
                const q = s.def.questions.find((x) => x.id === qid);
                return (
                  <div key={qid} className="fc-q">
                    <span className="mono fc-qcode">{q?.code ?? "?"}</span>
                    <span className="fc-qtext">
                      {q ? q.text.replace(/<[^>]*>/g, "").slice(0, 90) || "(untitled)" : `⚠ missing ${qid}`}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupCard({ node, depth }: { node: FlowNode; depth: number }) {
  const ops = useOps();
  const [shut, setShut] = React.useState(false);
  const kids = ((node as any).children ?? []) as FlowNode[];
  const summary = summarizeFlowNode(node);
  const inside: FlowDropTarget = { kind: "inside", ownerId: node.id, slot: "children" };

  return (
    <div className={`flow-group ${shut ? "collapsed" : ""}`} data-testid="flow-group" data-node-id={node.id}>
      <InsideDropTarget zoneKey={zoneKey(inside)} target={inside} className="fg-head-wrap">
        <div className="fg-head">
          <DragHandle id={node.id} />
          <button className="block-toggle" data-testid="group-toggle"
            onClick={() => setShut((v) => !v)}>{shut ? "▶" : "▼"}</button>
          <span className="group-badge">GROUP</span>
          <input className="input block-title" data-testid="group-title"
            placeholder="Name this group" value={(node as any).title ?? ""}
            onChange={(e) => ops.rename(node.id, e.target.value)} />
          <span className="muted block-count">{summary.detail}</span>
          <button className="btn small" data-testid="ungroup"
            title="Remove the group, keep what is inside it"
            onClick={() => ops.remove(`__ungroup__${node.id}`)}>ungroup</button>
          <NodeMenu nodeId={node.id}
            onDelete={() => ops.remove(node.id)}
            onDuplicate={() => ops.duplicate(node.id)}
            onMoveTo={(t) => ops.move(node.id, t)}
            onMoveStep={(dir) => ops.step(node.id, dir)} />
        </div>
      </InsideDropTarget>
      {shut ? (
        <div className="fg-shut muted">
          {kids.length === 0 ? "empty" : kids.map((k) => summarizeFlowNode(k).label).join(" · ")}
        </div>
      ) : (
        <div className="fg-body">
          <FlowChildren nodes={kids} depth={depth + 1} what="group"
            container={{ ownerId: node.id, slot: "children" }} />
        </div>
      )}
    </div>
  );
}

/** A randomizer or a loop: an element that is also a container. */
function ContainerCard({ node, depth }: { node: FlowNode; depth: number }) {
  const ops = useOps();
  const [open, setOpen] = React.useState(true);
  const kids = ((node as any).children ?? []) as FlowNode[];
  const summary = summarizeFlowNode(node);
  const inside: FlowDropTarget = { kind: "inside", ownerId: node.id, slot: "children" };

  return (
    <div className={`flow-card container-card ${node.type}`} data-testid="flow-element"
      data-node-id={node.id}>
      <InsideDropTarget zoneKey={zoneKey(inside)} target={inside}>
        <div className="fc-head">
          <DragHandle id={node.id} />
          <button className="block-toggle" data-testid="container-toggle"
            onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"}</button>
          <span className={`fn-type ${node.type}`}>{ELEMENT_LABELS[node.type] ?? node.type}</span>
          {/* the name if it has one, and the count once — not the count twice */}
          <span className="grow fc-summary">
            {summary.label !== FLOW_TYPE_LABELS[node.type] ? summary.label : ""}
          </span>
          <span className="muted block-count">{summary.detail}</span>
          <NodeMenu nodeId={node.id}
            onDelete={() => ops.remove(node.id)}
            onDuplicate={() => ops.duplicate(node.id)}
            onMoveTo={(t) => ops.move(node.id, t)}
            onMoveStep={(dir) => ops.step(node.id, dir)} />
        </div>
      </InsideDropTarget>
      {open && (
        <div className="fc-body">
          <NodeEditor node={node} onChange={(n) => ops.patch(node.id, n)} />
          <div className="flabel" style={{ marginTop: 8 }}>
            inside this {(ELEMENT_LABELS[node.type] ?? node.type).toLowerCase()}
          </div>
          <FlowChildren nodes={kids} depth={depth + 1} what={node.type === "loop" ? "loop" : "randomizer"}
            container={{ ownerId: node.id, slot: "children" }} />
        </div>
      )}
    </div>
  );
}

/** A branch: one container per condition, plus the otherwise path. */
function BranchCard({ node, depth }: { node: Extract<FlowNode, { type: "branch" }>; depth: number }) {
  const s = useStudio();
  const ops = useOps();
  const [open, setOpen] = React.useState(true);
  const summary = summarizeFlowNode(node);

  return (
    <div className="flow-card container-card branch" data-testid="flow-element" data-node-id={node.id}>
      <div className="fc-head">
        <DragHandle id={node.id} />
        <button className="block-toggle" data-testid="container-toggle"
          onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"}</button>
        <span className="fn-type branch">{ELEMENT_LABELS.branch}</span>
        <span className="grow fc-summary">{summary.label !== "Branch" ? summary.label : ""}</span>
        <span className="muted block-count">{summary.detail}</span>
        <NodeMenu nodeId={node.id}
          onDelete={() => ops.remove(node.id)}
          onDuplicate={() => ops.duplicate(node.id)}
          onMoveTo={(t) => ops.move(node.id, t)}
          onMoveStep={(dir) => ops.step(node.id, dir)} />
      </div>
      {open && (
        <div className="fc-body">
          <NodeEditor node={node} onChange={(n) => ops.patch(node.id, n)} />
          {node.branches.map((b) => {
            const inside: FlowDropTarget = { kind: "inside", ownerId: node.id, slot: `branch:${b.id}` };
            return (
              <div key={b.id} className="branch-path" data-testid="branch-path">
                <InsideDropTarget zoneKey={zoneKey(inside)} target={inside} className="bp-head">
                  <span className="flabel" style={{ margin: 0 }}>
                    IF {b.label || conditionToText(b.when, s.def) || "(no condition)"} THEN
                  </span>
                </InsideDropTarget>
                <FlowChildren nodes={b.children} depth={depth + 1} what="path"
                  container={{ ownerId: node.id, slot: `branch:${b.id}` }} />
              </div>
            );
          })}
          {(() => {
            const inside: FlowDropTarget = { kind: "inside", ownerId: node.id, slot: "otherwise" };
            return (
              <div className="branch-path" data-testid="branch-otherwise">
                <InsideDropTarget zoneKey={zoneKey(inside)} target={inside} className="bp-head">
                  <span className="flabel" style={{ margin: 0 }}>OTHERWISE</span>
                </InsideDropTarget>
                <FlowChildren nodes={node.otherwise ?? []} depth={depth + 1} what="path"
                  container={{ ownerId: node.id, slot: "otherwise" }} />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/** A leaf element: embedded data, quota check, redirect, end. */
function ElementCard({ node }: { node: FlowNode }) {
  const ops = useOps();
  const [open, setOpen] = React.useState(false);
  const summary = summarizeFlowNode(node);
  return (
    <div className="flow-card element-card" data-testid="flow-element" data-node-id={node.id}>
      <div className="fc-head">
        <DragHandle id={node.id} />
        <button className="block-toggle" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"}</button>
        <span className={`fn-type ${node.type}`}>{ELEMENT_LABELS[node.type] ?? node.type}</span>
        <span className="grow fc-summary">{summary.detail}</span>
        <NodeMenu nodeId={node.id}
          onDelete={() => ops.remove(node.id)}
          onDuplicate={() => ops.duplicate(node.id)}
          onMoveTo={(t) => ops.move(node.id, t)}
          onMoveStep={(dir) => ops.step(node.id, dir)} />
      </div>
      {open && (
        <div className="fc-body">
          <NodeEditor node={node} onChange={(n) => ops.patch(node.id, n)} />
        </div>
      )}
    </div>
  );
}

/* ============================================================== the panel */

export function FlowPanel() {
  const s = useStudio();
  const flow = s.def.flow as FlowNode[];

  /** Apply an engine result, or say why it was refused. Nothing else writes. */
  const applyFlow = (
    label: string,
    run: (current: FlowNode[]) => { flow: FlowNode[]; moved?: boolean; reason?: string },
  ) => {
    const result = run(flow);
    if (result.moved === false) {
      s.toast(result.reason ?? "That is not allowed here", "err");
      return;
    }
    s.labelNextEdit(label);
    s.update((d) => { (d as any).flow = result.flow; });
  };

  // numbering runs over the blocks in visual order, at every depth, so a block
  // inside a randomizer is still "BLOCK 4" and not a second "BLOCK 1"
  const blocks = listBlocks(flow as any[]);

  const ops: FlowOps = {
    move(id, target) {
      const node = findNode(flow, id);
      applyFlow(`move ${node ? summarizeFlowNode(node).label : "element"}`,
        (f) => moveFlowNode(f, id, target));
    },
    insert(type, target) {
      applyFlow(`add ${ELEMENT_LABELS[type] ?? type}`, (f) => insertFlowNode(f, makeNode(type), target));
    },
    remove(id) {
      // "ungroup" arrives as a pseudo-id so one code path owns flow writes
      if (id.startsWith("__ungroup__")) {
        const groupId = id.slice("__ungroup__".length);
        const group = findNode(flow, groupId);
        if (!group) return;
        const kids = ((group as any).children ?? []) as FlowNode[];
        applyFlow("ungroup", (f) => {
          const loc = locateNode(f, groupId);
          if (!loc) return { flow: f, moved: false, reason: "that group is gone" };
          let next = f;
          // children first, in order, at the group's position; then the shell
          kids.forEach((kid, i) => {
            const r = insertFlowNode(next, structuredClone(kid), {
              kind: "inside", ownerId: loc.container.ownerId, slot: loc.container.slot, index: loc.index + i,
            });
            if (r.moved) next = r.flow;
          });
          return { flow: removeFlowNode(next, groupId).flow, moved: true };
        });
        return;
      }

      const node = findNode(flow, id);
      if (!node) return;
      const summary = summarizeFlowNode(node);
      const questionIds = collectQuestionIds(node);
      const message = questionIds.length > 0
        ? `Delete ${summary.label} and its ${questionIds.length} question${questionIds.length === 1 ? "" : "s"}? Logic referring to them will need updating.`
        : summary.children > 0
          ? `Delete ${summary.label}? Anything nested inside it goes too.`
          : `Delete ${summary.label}?`;
      if (!confirm(message)) return;
      s.labelNextEdit(`delete ${summary.label}`);
      s.update((d) => {
        const r = removeFlowNode((d as any).flow as FlowNode[], id);
        (d as any).flow = r.flow;
        if (questionIds.length) {
          const gone = new Set(questionIds);
          d.questions = d.questions.filter((q) => !gone.has(q.id));
        }
      });
    },
    duplicate(id) {
      const node = findNode(flow, id);
      if (!node) return;
      applyFlow(`duplicate ${summarizeFlowNode(node).label}`, (f) => {
        const original = findNode(f, id);
        if (!original) return { flow: f, moved: false, reason: "that element is gone" };
        const copy = cloneFlowSubtree(original, (p) => uid(p));
        if ((copy as any).title) (copy as any).title = `${(copy as any).title} (copy)`;
        return insertFlowNode(f, copy, { kind: "after", refId: id });
      });
    },
    patch(id, next) {
      s.labelNextEdit("edit flow element");
      s.update((d) => {
        const loc = locateNode((d as any).flow as FlowNode[], id);
        if (!loc) return;
        const list = containerListFor(d, loc.container);
        if (list) list[loc.index] = next;
      });
    },
    rename(id, title) {
      s.labelNextEdit("rename");
      s.update((d) => {
        const loc = locateNode((d as any).flow as FlowNode[], id);
        if (!loc) return;
        const list = containerListFor(d, loc.container);
        if (list) (list[loc.index] as any).title = title || undefined;
      });
    },
    step(id, dir) {
      const loc = locateNode(flow, id);
      if (!loc) return;
      const list = readContainerList(flow, loc.container);
      if (!list) return;
      const j = loc.index + dir;
      if (j < 0 || j >= list.length) {
        s.toast(dir < 0 ? "Already first here" : "Already last here", "err");
        return;
      }
      const sibling = list[j];
      ops.move(id, dir < 0 ? { kind: "before", refId: sibling.id } : { kind: "after", refId: sibling.id });
    },
    blockNumber(id) {
      const i = blocks.findIndex((b) => b.id === id);
      return i < 0 ? null : i + 1;
    },
    openQuestions(blockId) {
      const node = findNode(flow, blockId);
      const first = node ? collectQuestionIds(node)[0] : null;
      s.select(first ?? null);
      s.goToTab?.("questions");
    },
  };

  const issues = validateFlowStructure(flow);
  const groupCount = countByType(flow, "section");

  return (
    <OpsCtx.Provider value={ops}>
      <FlowDragProvider flow={flow} onMove={(id, target) => ops.move(id, target)}>
        <div className="flow-panel">
          <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Survey Flow</h2>
            <span className="chip" data-testid="flow-counts">
              {blocks.length} block{blocks.length === 1 ? "" : "s"}
              {groupCount > 0 && ` · ${groupCount} group${groupCount === 1 ? "" : "s"}`}
            </span>
            <span className="grow" />
            <button className="btn small" data-testid="flow-undo" disabled={!s.canUndo}
              title={s.undoLabel ? `Undo ${s.undoLabel} (⌘Z)` : "Nothing to undo"}
              onClick={() => s.undo()}>↶ Undo</button>
            <button className="btn small" data-testid="flow-redo" disabled={!s.canRedo}
              title={s.redoLabel ? `Redo ${s.redoLabel} (⌘⇧Z)` : "Nothing to redo"}
              onClick={() => s.redo()}>↷ Redo</button>
            <button className="btn" data-testid="add-group"
              onClick={() => ops.insert("section", endTarget(flow))}>+ Add group</button>
            <button className="btn" data-testid="add-flow-block"
              onClick={() => ops.insert("page", endTarget(flow))}>+ Add block</button>
          </div>

          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            The survey runs top to bottom. Grab a card by its <strong>⠿</strong> handle and drop it
            on any highlighted line — between elements, or onto a group, randomizer or branch path to
            put it inside. Everything nested travels with it. <strong>Esc</strong> cancels a drag;
            <strong> ⌘Z</strong> undoes a move.
          </p>

          {issues.length > 0 && (
            <div className="flow-issues" data-testid="flow-issues">
              {issues.slice(0, 6).map((iss, i) => (
                <div key={i} className={`fi-issue ${iss.level}`}>
                  {iss.level === "error" ? "⛔" : "⚠"} {iss.message}
                </div>
              ))}
            </div>
          )}

          <div className="flow-start">START</div>
          <FlowChildren nodes={flow} depth={0} what="survey"
            container={{ ownerId: null, slot: "children" }} />
          <div className="flow-end">END</div>
        </div>
      </FlowDragProvider>
    </OpsCtx.Provider>
  );
}

/* ------------------------------------------------------------- helpers */

/** New top-level items go in FRONT of the End node, where they can be reached. */
function endTarget(flow: FlowNode[]): FlowDropTarget {
  const i = flow.findIndex((n) => n.type === "end");
  return { kind: "inside", ownerId: null, slot: "children", index: i < 0 ? flow.length : i };
}

function countByType(flow: FlowNode[], type: FlowNode["type"]): number {
  let n = 0;
  const walk = (nodes: any[]) => {
    for (const node of nodes ?? []) {
      if (node?.type === type) n += 1;
      if (node?.children) walk(node.children);
      if (node?.branches) for (const b of node.branches) walk(b.children);
      if (node?.otherwise) walk(node.otherwise);
    }
  };
  walk(flow as any[]);
  return n;
}

function collectQuestionIds(node: FlowNode): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n?.type === "page") out.push(...(n.questionIds ?? []));
    for (const c of n?.children ?? []) walk(c);
    for (const b of n?.branches ?? []) for (const c of b.children ?? []) walk(c);
    for (const c of n?.otherwise ?? []) walk(c);
  };
  walk(node);
  return out;
}

function readContainerList(flow: FlowNode[], c: FlowContainer): FlowNode[] | null {
  if (c.ownerId === null) return flow;
  const owner = findNode(flow, c.ownerId) as any;
  if (!owner) return null;
  if (c.slot === "children") return owner.children ?? null;
  if (c.slot === "otherwise") return owner.otherwise ?? [];
  const b = owner.branches?.find((x: any) => x.id === c.slot.slice(7));
  return b?.children ?? null;
}

function containerListFor(def: any, c: FlowContainer): FlowNode[] | null {
  return readContainerList(def.flow as FlowNode[], c);
}
