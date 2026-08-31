"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import { useStudio, uid } from "./store";
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

export function FlowPanel() {
  const s = useStudio();
  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Survey Flow</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          START → nodes below in order → END. Branches, loops, randomizers nest arbitrarily.
        </span>
      </div>
      <FlowTree nodes={s.def.flow} onChange={(flow) => s.update((d) => { d.flow = flow; })} />
    </div>
  );
}
