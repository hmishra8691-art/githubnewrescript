"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import { useStudio, uid } from "./store";
import {
  type BlockRef, listBlocks, blockSize, flowOutline, isBlockNode, isGroupNode,
  newBlockNode, newGroupNode, ELEMENT_LABELS, INSERTABLE,
} from "./blockModel";
import { OptionalCondition, ConditionEditor, conditionToText } from "./ConditionBuilder";

/** Structured Survey Flow editor (requirement §7). */

type NodeList = FlowNode[];

function newNode(type: FlowNode["type"]): FlowNode {
  const id = uid(type);
  switch (type) {
    case "page": return { type, id, title: "New page", questionIds: [] };
    case "section": return { type, id, title: "Section", children: [] };
    case "block": return { type, id, title: "Block", children: [] };
    case "randomizer": return { type, id, children: [] };
    case "branch": return { type, id, branches: [{ id: uid("br"), when: { type: "group", op: "and", children: [] }, children: [] }], otherwise: [] };
    case "loop": return { type, id, source: { kind: "static", items: [] }, loopVar: "item", children: [] };
    case "embedded_data": return { type, id, fields: [] };
    case "quota_check": return { type, id, quotaIds: [], onFull: { kind: "terminate" } };
    case "redirect": return { type, id, url: "https://" };
    case "end": return { type, id, status: "complete" };
  }
}

const ADDABLE: FlowNode["type"][] = [
  "page", "section", "block", "randomizer", "branch", "loop", "embedded_data", "quota_check", "redirect", "end",
];

function NodeEditor({ node, onChange }: { node: FlowNode; onChange(n: FlowNode): void }) {
  const s = useStudio();
  switch (node.type) {
    case "page":
      return (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input" style={{ width: 220 }} value={node.title ?? ""}
              placeholder="Page title" onChange={(e) => onChange({ ...node, title: e.target.value })} />
            <span className="muted mono" style={{ fontSize: 11 }}>{node.id}</span>
          </div>
          <div className="flabel">Questions on this page</div>
          {node.questionIds.map((qid, i) => {
            const q = s.def.questions.find((x) => x.id === qid);
            return (
              <div key={qid} className="opt-row">
                <span className="mono grow">{q ? `${q.code} — ${q.text.replace(/<[^>]*>/g, "").slice(0, 60)}` : `⚠ missing ${qid}`}</span>
                <button className="btn small" onClick={() => {
                  if (i === 0) return;
                  const ids = [...node.questionIds];
                  [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                  onChange({ ...node, questionIds: ids });
                }}>↑</button>
                <button className="btn small danger"
                  onClick={() => onChange({ ...node, questionIds: node.questionIds.filter((x) => x !== qid) })}>×</button>
              </div>
            );
          })}
          <select className="select" style={{ width: 260, marginTop: 4 }} value=""
            onChange={(e) => {
              if (e.target.value) onChange({ ...node, questionIds: [...node.questionIds, e.target.value] });
            }}>
            <option value="">+ add question to page…</option>
            {s.def.questions.filter((q) => !node.questionIds.includes(q.id))
              .map((q) => <option key={q.id} value={q.id}>{q.code} — {q.variableName}</option>)}
          </select>
          <OptionalCondition label="Show page only when" value={node.visibleIf}
            onChange={(c) => onChange({ ...node, visibleIf: c })} />
        </div>
      );
    case "section":
    case "block":
      return (
        <div className="row">
          <input className="input" style={{ width: 240 }} value={node.title ?? ""}
            onChange={(e) => onChange({ ...node, title: e.target.value })} />
        </div>
      );
    case "randomizer":
      return (
        <div className="row">
          <label className="row" style={{ gap: 6 }}>show
            <input className="input" style={{ width: 64 }} type="number" value={node.show ?? ""}
              placeholder="all" onChange={(e) => onChange({ ...node, show: e.target.value === "" ? undefined : Number(e.target.value) })} />
            of {node.children.length} children (random order)
          </label>
        </div>
      );
    case "branch":
      return (
        <div>
          {node.branches.map((b, i) => (
            <div key={b.id} className="card" style={{ padding: 10 }}>
              <div className="row"><span className="flabel" style={{ margin: 0 }}>IF</span>
                <input className="input grow" placeholder="branch label" value={b.label ?? ""}
                  onChange={(e) => onChange({
                    ...node,
                    branches: node.branches.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  })} />
                <button className="btn small danger" onClick={() =>
                  onChange({ ...node, branches: node.branches.filter((_, j) => j !== i) })}>×</button>
              </div>
              <ConditionEditor value={b.when} onChange={(when) =>
                onChange({ ...node, branches: node.branches.map((x, j) => (j === i ? { ...x, when } : x)) })} />
              <div className="muted" style={{ fontSize: 11 }}>Drop nodes into this branch below (branch children shown in tree).</div>
            </div>
          ))}
          <button className="btn small" onClick={() =>
            onChange({
              ...node,
              branches: [...node.branches, { id: uid("br"), when: { type: "group", op: "and", children: [] }, children: [] }],
            })}>+ branch</button>
        </div>
      );
    case "loop": {
      const src = node.source;
      return (
        <div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="flabel" style={{ margin: 0 }}>loop over</span>
            <select className="select" value={src.kind}
              onChange={(e) => {
                const kind = e.target.value;
                onChange({
                  ...node,
                  source: kind === "question"
                    ? { kind: "question", questionId: s.def.questions[0]?.id ?? "", filter: "selected" }
                    : kind === "design"
                      ? { kind: "design", designId: s.def.designs[0]?.id ?? "" }
                      : { kind: "static", items: [] },
                });
              }}>
              <option value="question">question answers</option>
              <option value="static">static list</option>
              <option value="design">design tasks</option>
            </select>
            {src.kind === "question" && (
              <>
                <select className="select" value={src.questionId}
                  onChange={(e) => onChange({ ...node, source: { ...src, questionId: e.target.value } })}>
                  {s.def.questions.map((q) => <option key={q.id} value={q.id}>{q.code}</option>)}
                </select>
                <select className="select" value={src.filter ?? "selected"}
                  onChange={(e) => onChange({ ...node, source: { ...src, filter: e.target.value as any } })}>
                  <option value="selected">selected</option><option value="displayed">displayed</option><option value="all">all</option>
                </select>
              </>
            )}
            <label className="row" style={{ gap: 4 }}>var
              <input className="input mono" style={{ width: 90 }} value={node.loopVar}
                onChange={(e) => onChange({ ...node, loopVar: e.target.value })} /></label>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={node.randomizeIterations ?? false}
                onChange={(e) => onChange({ ...node, randomizeIterations: e.target.checked })} /> randomize
            </label>
          </div>
          {src.kind === "static" && (
            <div style={{ marginTop: 6 }}>
              {src.items.map((it, i) => (
                <div key={i} className="opt-row">
                  <input className="input code-input" value={it.code}
                    onChange={(e) => onChange({ ...node, source: { ...src, items: src.items.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) } })} />
                  <input className="input grow" value={it.label}
                    onChange={(e) => onChange({ ...node, source: { ...src, items: src.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
                  <button className="btn small danger" onClick={() =>
                    onChange({ ...node, source: { ...src, items: src.items.filter((_, j) => j !== i) } })}>×</button>
                </div>
              ))}
              <button className="btn small" onClick={() =>
                onChange({ ...node, source: { ...src, items: [...src.items, { code: String(src.items.length + 1), label: "" }] } })}>+ item</button>
            </div>
          )}
          <p className="muted" style={{ fontSize: 11 }}>
            Inside the loop, pipe with {"{{loop.label}} {{loop.code}} {{loop.index}}"}; answers store per-iteration.
          </p>
        </div>
      );
    }
    case "embedded_data":
      return (
        <div>
          {node.fields.map((f, i) => (
            <div key={i} className="opt-row">
              <input className="input mono" style={{ width: 130 }} value={f.name} placeholder="FIELD_NAME"
                onChange={(e) => onChange({ ...node, fields: node.fields.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase() } : x)) })} />
              <select className="select" style={{ width: 110 }} value={f.source}
                onChange={(e) => onChange({ ...node, fields: node.fields.map((x, j) => (j === i ? { ...x, source: e.target.value as any } : x)) })}>
                <option value="url">from URL</option>
                <option value="static">static</option>
                <option value="expression">expression</option>
                <option value="panel">panel</option>
              </select>
              {(f.source === "static" || f.source === "expression") && (
                <input className="input grow mono" value={f.value ?? ""}
                  onChange={(e) => onChange({ ...node, fields: node.fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              )}
              <button className="btn small danger" onClick={() =>
                onChange({ ...node, fields: node.fields.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="btn small" onClick={() =>
            onChange({ ...node, fields: [...node.fields, { name: "FIELD", source: "url" }] })}>+ field</button>
        </div>
      );
    case "quota_check":
      return (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select className="select" multiple size={Math.max(2, Math.min(4, s.def.quotas.length))}
            value={node.quotaIds}
            onChange={(e) => onChange({ ...node, quotaIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
            {s.def.quotas.map((qt) => <option key={qt.id} value={qt.id}>{qt.name}</option>)}
          </select>
          <span className="flabel" style={{ margin: 0 }}>when full →</span>
          <select className="select" value={node.onFull.kind}
            onChange={(e) => onChange({ ...node, onFull: { ...node.onFull, kind: e.target.value as any } })}>
            <option value="terminate">terminate</option>
            <option value="redirect">redirect</option>
            <option value="flag">flag &amp; continue</option>
            <option value="continue">continue</option>
          </select>
          {node.onFull.kind === "redirect" && (
            <input className="input grow" placeholder="https://…" value={node.onFull.url ?? ""}
              onChange={(e) => onChange({ ...node, onFull: { ...node.onFull, url: e.target.value } })} />
          )}
        </div>
      );
    case "redirect":
      return (
        <input className="input" style={{ width: 340 }} value={node.url}
          onChange={(e) => onChange({ ...node, url: e.target.value })} />
      );
    case "end":
      return (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <select className="select" value={node.status}
            onChange={(e) => onChange({ ...node, status: e.target.value as any })}>
            <option value="complete">complete</option>
            <option value="screened">screened</option>
            <option value="quota_full">quota full</option>
            <option value="terminated">terminated</option>
          </select>
          <input className="input grow" placeholder="end message (piping allowed)" value={node.message ?? ""}
            onChange={(e) => onChange({ ...node, message: e.target.value || undefined })} />
          <input className="input" style={{ width: 200 }} placeholder="redirect URL (optional)" value={node.redirectUrl ?? ""}
            onChange={(e) => onChange({ ...node, redirectUrl: e.target.value || undefined })} />
        </div>
      );
  }
}

function AddMenu({ onAdd }: { onAdd(t: FlowNode["type"]): void }) {
  return (
    <select className="select" style={{ width: 170 }} value=""
      onChange={(e) => { if (e.target.value) onAdd(e.target.value as FlowNode["type"]); }}>
      <option value="">+ add node…</option>
      {ADDABLE.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
    </select>
  );
}

function FlowTree({ nodes, onChange, depth = 0 }: {
  nodes: NodeList; onChange(n: NodeList): void; depth?: number;
}) {
  const s = useStudio();
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= nodes.length) return;
    const next = [...nodes];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const setNode = (i: number, n: FlowNode) => onChange(nodes.map((x, j) => (j === i ? n : x)));

  return (
    <div>
      {nodes.map((node, i) => {
        const isOpen = open[node.id] ?? depth < 2;
        const summary =
          node.type === "page" ? `${node.title ?? node.id} · ${node.questionIds.length} q`
          : node.type === "branch" ? `${node.branches.length} branch(es)`
          : node.type === "loop" ? `loop:${node.loopVar}`
          : node.type === "end" ? node.status
          : (("title" in node && node.title) || node.id);
        return (
          <div key={node.id} className="flow-node">
            <div className="fn-head" onClick={() => setOpen((o) => ({ ...o, [node.id]: !isOpen }))}>
              <span style={{ color: "var(--subtle)", width: 12 }}>{isOpen ? "▾" : "▸"}</span>
              <span className={`fn-type ${node.type}`}>{node.type}</span>
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
              <button className="btn small" onClick={(e) => { e.stopPropagation(); move(i, -1); }}>↑</button>
              <button className="btn small" onClick={(e) => { e.stopPropagation(); move(i, 1); }}>↓</button>
              <button className="btn small danger" onClick={(e) => {
                e.stopPropagation();
                if (confirm("Remove this flow node (children removed too)?")) onChange(nodes.filter((_, j) => j !== i));
              }}>×</button>
            </div>
            {isOpen && (
              <div className="fn-body" onClick={(e) => e.stopPropagation()}>
                <NodeEditor node={node} onChange={(n) => setNode(i, n)} />
                {"children" in node && Array.isArray((node as any).children) && (
                  <div className="flow-children">
                    <FlowTree depth={depth + 1} nodes={(node as any).children}
                      onChange={(children) => setNode(i, { ...(node as any), children })} />
                  </div>
                )}
                {node.type === "branch" && (
                  <>
                    {node.branches.map((b, bi) => (
                      <div key={b.id} className="flow-children">
                        <div className="flabel">
                          branch: {b.label || conditionToText(b.when, s.def) || "(no condition)"}
                        </div>
                        <FlowTree depth={depth + 1} nodes={b.children}
                          onChange={(children) =>
                            setNode(i, { ...node, branches: node.branches.map((x, j) => (j === bi ? { ...x, children } : x)) })} />
                      </div>
                    ))}
                    <div className="flow-children">
                      <div className="flabel">otherwise</div>
                      <FlowTree depth={depth + 1} nodes={node.otherwise ?? []}
                        onChange={(otherwise) => setNode(i, { ...node, otherwise })} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ margin: "8px 0" }}>
        <AddMenu onAdd={(t) => onChange([...nodes, newNode(t)])} />
      </div>
    </div>
  );
}

/* ==========================================================================
 * The Survey Flow, read at BLOCK level.
 *
 * The flow used to render `def.flow` node-for-node, so a four-block survey
 * read "page, page, page, page" — the respondent's pagination presented as
 * the survey's architecture. It now shows what a programmer designs with:
 * Blocks, Groups of blocks, and the flow Elements between them. Page breaks
 * stay where they belong, inside their block.
 *
 * Nothing is duplicated to do this. Every card below is a view of a node in
 * `def.flow`; every control edits that node in place, which is why the
 * Questions panel, Preview, Test and both exports change the moment you do
 * anything here.
 * ======================================================================== */

/** Insert-between control: the "+" node the brief asks for between blocks. */
function InsertNode({ onInsert, onDropNode, testid }: {
  onInsert(type: string): void;
  onDropNode?(id: string): void;
  testid?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [over, setOver] = React.useState(false);
  return (
    <div className={`flow-insert ${over ? "dropping" : ""}`}
      onDragOver={(e) => { if (onDropNode) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData("text/rescript-node");
        if (id && onDropNode) { e.preventDefault(); onDropNode(id); }
      }}>
      <span className="fi-rail" />
      <div className="menu-anchor">
        <button className="fi-btn" data-testid={testid ?? "flow-insert"}
          title="Add a flow element here" onClick={() => setOpen((o) => !o)}>
          + Add element
        </button>
        {open && (
          <>
            <div className="menu-scrim" onClick={() => setOpen(false)} />
            <div className="menu wide" role="menu">
              {INSERTABLE.map((it) => (
                <button key={it.type} className="menu-item" data-testid={`insert-${it.type}`}
                  onClick={() => { setOpen(false); onInsert(it.type); }}>
                  <span className="mi-label">{it.label}</span>
                  <span className="mi-hint">{it.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <span className="fi-rail" />
    </div>
  );
}

/** One block, as the flow shows it: what it is, not how it paginates. */
function BlockCard({ block, index, onOpen, ...ops }: {
  block: BlockRef; index: number; onOpen(): void;
  onRename(t: string): void; onMove(dir: -1 | 1): void; onDelete(): void;
  onMoveToGroup(groupId: string | null): void;
  groups: { id: string; title: string }[];
  inGroup: string | null;
}) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const n = blockSize(block);
  const pages = block.pages.length;
  return (
    <div className="flow-card block-card" data-testid="flow-block" draggable
      onDragStart={(e) => {
        // without this the enclosing group's handler runs too and overwrites
        // the payload, so dragging a block out of a group moved the group
        e.stopPropagation();
        e.dataTransfer.setData("text/rescript-node", block.id);
      }}>
      <div className="fc-head">
        <button className="block-toggle" onClick={() => setOpen((o) => !o)}
          title={open ? "Hide questions" : "Show questions"}>{open ? "▾" : "▸"}</button>
        <span className="block-badge">BLOCK {index}</span>
        {/* a text field inside a draggable card: selecting text would start
            a node drag unless the field opts out */}
        <input className="input block-title" data-testid="flow-block-title" draggable={false}
          placeholder="Name this block" value={block.title ?? ""}
          onChange={(e) => ops.onRename(e.target.value)} />
        <span className="muted block-count">
          {n} question{n === 1 ? "" : "s"}{pages > 1 ? ` · ${pages} pages` : ""}
        </span>
        <button className="btn small" title="Edit this block's questions" onClick={onOpen}>edit</button>
        <button className="btn small" title="Move up" onClick={() => ops.onMove(-1)}>↑</button>
        <button className="btn small" title="Move down" onClick={() => ops.onMove(1)}>↓</button>
        {ops.groups.length > 0 && (
          <select className="select small move-to" title="Move this block into a group" value=""
            data-testid="block-to-group"
            onChange={(e) => { if (e.target.value) ops.onMoveToGroup(e.target.value === "__root" ? null : e.target.value); }}>
            <option value="">group…</option>
            {ops.inGroup && <option value="__root">(no group)</option>}
            {ops.groups.filter((g) => g.id !== ops.inGroup).map((g) => (
              <option key={g.id} value={g.id}>{g.title || "Untitled group"}</option>
            ))}
          </select>
        )}
        <button className="btn small danger" title="Delete block" onClick={ops.onDelete}>×</button>
      </div>
      {open && (
        <div className="fc-body">
          {block.pages.map((p, pi) => (
            <div key={p.node.id} className="fc-page">
              {pages > 1 && <span className="page-badge">PAGE {pi + 1}</span>}
              {p.node.questionIds.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
              {p.node.questionIds.map((qid) => {
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

/** A flow element — everything that is not a block or a group. */
function ElementCard({ node, onChange, onMove, onDelete }: {
  node: FlowNode; onChange(n: FlowNode): void; onMove(dir: -1 | 1): void; onDelete(): void;
}) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const summary =
    node.type === "branch" ? `${node.branches.length} branch${node.branches.length === 1 ? "" : "es"}`
    : node.type === "loop" ? `over ${node.loopVar}`
    : node.type === "end" ? node.status
    : node.type === "randomizer" ? (node.show != null ? `show ${node.show} of ${node.children.length}` : `${node.children.length} children`)
    : node.type === "embedded_data" ? `${node.fields.length} field${node.fields.length === 1 ? "" : "s"}`
    : node.type === "quota_check" ? `${node.quotaIds.length} quota${node.quotaIds.length === 1 ? "" : "s"}`
    : node.type === "redirect" ? node.url
    : node.id;
  return (
    <div className="flow-card element-card" data-testid="flow-element" draggable
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData("text/rescript-node", node.id); }}>
      <div className="fc-head">
        <button className="block-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
        <span className={`fn-type ${node.type}`}>{ELEMENT_LABELS[node.type] ?? node.type}</span>
        <span className="grow fc-summary">{summary}</span>
        <button className="btn small" onClick={() => onMove(-1)}>↑</button>
        <button className="btn small" onClick={() => onMove(1)}>↓</button>
        <button className="btn small danger" onClick={onDelete}>×</button>
      </div>
      {open && (
        <div className="fc-body">
          <NodeEditor node={node} onChange={onChange} />
          {"children" in node && Array.isArray((node as any).children) && (
            <div className="flow-children">
              <div className="flabel">inside this {ELEMENT_LABELS[node.type]?.toLowerCase() ?? node.type}</div>
              <FlowTree depth={1} nodes={(node as any).children}
                onChange={(children) => onChange({ ...(node as any), children })} />
            </div>
          )}
          {node.type === "branch" && (
            <>
              {node.branches.map((b, bi) => (
                <div key={b.id} className="flow-children">
                  <div className="flabel">
                    branch: {b.label || conditionToText(b.when, s.def) || "(no condition)"}
                  </div>
                  <FlowTree depth={1} nodes={b.children}
                    onChange={(children) =>
                      onChange({ ...node, branches: node.branches.map((x, j) => (j === bi ? { ...x, children } : x)) })} />
                </div>
              ))}
              <div className="flow-children">
                <div className="flabel">otherwise</div>
                <FlowTree depth={1} nodes={node.otherwise ?? []}
                  onChange={(otherwise) => onChange({ ...node, otherwise })} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FlowPanel() {
  const s = useStudio();
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const flow = s.def.flow as any[];
  const entries = flowOutline(flow);
  const groups = entries
    .filter((e) => e.kind === "group")
    .map((e: any) => ({ id: e.node.id, title: e.node.title ?? "" }));

  /* --------------------------------------------------------- mutations */
  /* Every one of these edits `def.flow` in place. There is no second copy of
     the flow to keep in step, which is the point. */

  /** The array a node lives in, searching the top level and inside groups. */
  const locate = (d: any, id: string): { arr: any[]; i: number } | null => {
    const scan = (arr: any[]): { arr: any[]; i: number } | null => {
      const i = arr.findIndex((n: any) => n.id === id);
      if (i >= 0) return { arr, i };
      for (const n of arr) {
        if (isGroupNode(n) && Array.isArray(n.children)) {
          const hit = scan(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    return scan(d.flow as any[]);
  };

  const container = (d: any, groupId: string | null): any[] => {
    if (!groupId) return d.flow as any[];
    const g = (d.flow as any[]).find((n) => n.id === groupId && isGroupNode(n));
    if (!g) return d.flow as any[];
    if (!Array.isArray(g.children)) g.children = [];
    return g.children;
  };

  const makeNode = (type: string): any =>
    type === "page" ? newBlockNode()
    : type === "section" ? newGroupNode()
    : newNode(type as FlowNode["type"]);

  /**
   * Where the header buttons add things.
   *
   * Appending to the very end puts a block AFTER the End node, where no
   * respondent will ever reach it — the flow stops at the first end. So new
   * top-level items go in front of it, which is what "add a block" means.
   */
  const defaultInsertIndex = (): number => {
    const i = flow.findIndex((n: any) => n?.type === "end");
    return i < 0 ? flow.length : i;
  };

  const insert = (groupId: string | null, index: number, type: string) => {
    s.update((d) => { container(d, groupId).splice(index, 0, makeNode(type)); });
    s.toast(`${ELEMENT_LABELS[type] ?? type} added`);
  };

  const moveNode = (id: string, dir: -1 | 1) =>
    s.update((d) => {
      const hit = locate(d, id);
      if (!hit) return;
      const j = hit.i + dir;
      if (j < 0 || j >= hit.arr.length) return;
      [hit.arr[hit.i], hit.arr[j]] = [hit.arr[j], hit.arr[hit.i]];
    });

  /**
   * Drop a dragged node immediately before `index` in a container.
   *
   * Two things it refuses, because both produce a flow the editor can no
   * longer represent: dropping a group inside itself, and nesting a group in
   * another group (the Flow renders one level of grouping, so a nested group
   * would fall through to the raw node tree this work exists to replace).
   */
  const dropInto = (groupId: string | null, index: number, id: string) =>
    s.update((d) => {
      const hit = locate(d, id);
      if (!hit) return;
      const dragged = hit.arr[hit.i];
      if (groupId && isGroupNode(dragged)) return; // no groups inside groups
      if (groupId && dragged.id === groupId) return; // nor inside itself
      hit.arr.splice(hit.i, 1);
      const target = container(d, groupId);
      // removing from the same array first shifts everything after it
      const at = target === hit.arr && hit.i < index ? index - 1 : index;
      target.splice(Math.max(0, Math.min(at, target.length)), 0, dragged);
    });

  const renameNode = (id: string, title: string) =>
    s.update((d) => {
      const hit = locate(d, id);
      if (hit) hit.arr[hit.i].title = title || undefined;
    });

  const setNode = (id: string, next: any) =>
    s.update((d) => {
      const hit = locate(d, id);
      if (hit) hit.arr[hit.i] = next;
    });

  /** Deleting a block takes its questions with it, exactly as in Questions. */
  const deleteBlock = (b: BlockRef) => {
    const n = blockSize(b);
    if (n > 0 && !confirm(
      `Delete this block and its ${n} question${n === 1 ? "" : "s"}? Logic referring to them will need updating.`,
    )) return;
    s.update((d) => {
      const hit = locate(d, b.id);
      if (!hit) return;
      const ids = new Set(listBlocks([hit.arr[hit.i]]).flatMap((x) => x.pages.flatMap((p) => p.node.questionIds)));
      d.questions = d.questions.filter((q: any) => !ids.has(q.id));
      hit.arr.splice(hit.i, 1);
    });
  };

  const deleteElement = (id: string) => {
    if (!confirm("Remove this flow element? Anything nested inside it goes too.")) return;
    s.update((d) => {
      const hit = locate(d, id);
      if (hit) hit.arr.splice(hit.i, 1);
    });
  };

  /** Ungroup: the group disappears, its blocks stay exactly where they were. */
  const ungroup = (id: string) =>
    s.update((d) => {
      const hit = locate(d, id);
      if (!hit) return;
      const kids = hit.arr[hit.i].children ?? [];
      hit.arr.splice(hit.i, 1, ...kids);
    });

  const deleteGroup = (id: string, count: number) => {
    if (!confirm(
      `Delete this group and the ${count} block${count === 1 ? "" : "s"} in it, with their questions?\n\n` +
      `To keep the blocks, use “Ungroup” instead.`,
    )) return;
    s.update((d) => {
      const hit = locate(d, id);
      if (!hit) return;
      const ids = new Set(
        listBlocks(hit.arr[hit.i].children ?? []).flatMap((x) => x.pages.flatMap((p) => p.node.questionIds)),
      );
      d.questions = d.questions.filter((q: any) => !ids.has(q.id));
      hit.arr.splice(hit.i, 1);
    });
  };

  const moveBlockToGroup = (blockId: string, groupId: string | null) =>
    s.update((d) => {
      const hit = locate(d, blockId);
      if (!hit) return;
      const [node] = hit.arr.splice(hit.i, 1);
      const target = container(d, groupId);
      // leaving a group means going back to the top level, which must be in
      // FRONT of the End node — the flow stops there, so a block after it is
      // one the Studio draws and no respondent ever sees
      if (!groupId) {
        const end = target.findIndex((n: any) => n?.type === "end");
        target.splice(end < 0 ? target.length : end, 0, node);
      } else {
        target.push(node);
      }
    });

  /* ------------------------------------------------------------ render */

  let blockNo = 0;
  const numberOf = () => ++blockNo;

  const renderBlock = (b: BlockRef, groupId: string | null) => (
    <BlockCard key={b.id} block={b} index={numberOf()}
      groups={groups} inGroup={groupId}
      onOpen={() => { s.select(b.pages[0]?.node.questionIds[0] ?? null); s.goToTab?.("questions"); }}
      onRename={(t) => renameNode(b.id, t)}
      onMove={(dir) => moveNode(b.id, dir)}
      onMoveToGroup={(g) => moveBlockToGroup(b.id, g)}
      onDelete={() => deleteBlock(b)} />
  );

  return (
    <div className="flow-panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Survey Flow</h2>
        {/* count the BLOCKS, including those inside groups — "3 in order"
            was ambiguous the moment a group held two of them */}
        <span className="chip" data-testid="flow-counts">
          {listBlocks(flow).length} block{listBlocks(flow).length === 1 ? "" : "s"}
          {groups.length > 0 && ` · ${groups.length} group${groups.length === 1 ? "" : "s"}`}
        </span>
        <span className="grow" />
        <button className="btn" data-testid="add-group"
          onClick={() => insert(null, defaultInsertIndex(), "section")}>+ Add group</button>
        <button className="btn" data-testid="add-flow-block"
          onClick={() => insert(null, defaultInsertIndex(), "page")}>+ Add block</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        The survey runs top to bottom. Blocks hold the questions — page breaks inside a
        block are the respondent’s pages, and stay in the Questions tab. Drag a card onto
        any <em>+ Add element</em> line to move it, including into and out of a group.
      </p>

      <div className="flow-start">START</div>

      {entries.map((e, i) => (
        <React.Fragment key={e.kind === "group" ? e.node.id : e.kind === "block" ? e.block.id : e.node.id}>
          <InsertNode onInsert={(t) => insert(null, i, t)} onDropNode={(id) => dropInto(null, i, id)} />
          {e.kind === "block" && renderBlock(e.block, null)}
          {e.kind === "element" && (
            <ElementCard node={e.node} onChange={(n) => setNode(e.node.id, n)}
              onMove={(dir) => moveNode(e.node.id, dir)}
              onDelete={() => deleteElement(e.node.id)} />
          )}
          {e.kind === "group" && (() => {
            const isShut = collapsed[e.node.id];
            const kids: any[] = e.node.children ?? [];
            return (
              <div className={`flow-group ${isShut ? "collapsed" : ""}`} data-testid="flow-group" draggable
                onDragStart={(ev) => { ev.stopPropagation(); ev.dataTransfer.setData("text/rescript-node", e.node.id); }}>
                <div className="fg-head">
                  <button className="block-toggle" data-testid="group-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [e.node.id]: !c[e.node.id] }))}>
                    {isShut ? "▶" : "▼"}
                  </button>
                  <span className="group-badge">GROUP</span>
                  <input className="input block-title" data-testid="group-title" draggable={false}
                    placeholder="Name this group"
                    value={e.node.title ?? ""} onChange={(ev) => renameNode(e.node.id, ev.target.value)} />
                  <span className="muted block-count">
                    {e.blocks.length} block{e.blocks.length === 1 ? "" : "s"}
                  </span>
                  <button className="btn small" onClick={() => moveNode(e.node.id, -1)}>↑</button>
                  <button className="btn small" onClick={() => moveNode(e.node.id, 1)}>↓</button>
                  <button className="btn small" data-testid="ungroup" title="Remove the group, keep its blocks"
                    onClick={() => ungroup(e.node.id)}>ungroup</button>
                  <button className="btn small danger" title="Delete the group and everything in it"
                    onClick={() => deleteGroup(e.node.id, e.blocks.length)}>×</button>
                </div>
                {isShut ? (
                  // collapsed groups still count what is inside, so a long flow
                  // can be folded away without losing track of it
                  <div className="fg-shut muted">
                    {e.blocks.length === 0 ? "empty" : e.blocks.map((b) => b.title || "Untitled block").join(" · ")}
                  </div>
                ) : (
                  <div className="fg-body">
                    {kids.map((k: any, ki: number) => {
                      const [blk] = isBlockNode(k) ? listBlocks([k]) : [];
                      return (
                        <React.Fragment key={k.id}>
                          <InsertNode onInsert={(t) => insert(e.node.id, ki, t)}
                            onDropNode={(id) => dropInto(e.node.id, ki, id)} />
                          {blk
                            ? renderBlock(blk, e.node.id)
                            : (
                              <ElementCard node={k} onChange={(n) => setNode(k.id, n)}
                                onMove={(dir) => moveNode(k.id, dir)}
                                onDelete={() => deleteElement(k.id)} />
                            )}
                        </React.Fragment>
                      );
                    })}
                    <InsertNode onInsert={(t) => insert(e.node.id, kids.length, t)}
                      onDropNode={(id) => dropInto(e.node.id, kids.length, id)}
                      testid="group-insert-end" />
                  </div>
                )}
              </div>
            );
          })()}
        </React.Fragment>
      ))}

      <InsertNode onInsert={(t) => insert(null, flow.length, t)}
        onDropNode={(id) => dropInto(null, flow.length, id)} testid="flow-insert-end" />
      <div className="flow-end">END</div>

      {flow.length === 0 && (
        <p className="muted">Nothing in the flow yet — add a block to start.</p>
      )}
    </div>
  );
}
