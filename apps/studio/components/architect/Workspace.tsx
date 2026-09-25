"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import { parseObjectKey, findNode, replaceFlowNode, summarizeFlowNode, type ObjectKey, type ObjectStatusMap } from "@rescript/engine";
import { useStudio } from "../studio/store";
import { QuestionEditor } from "../studio/QuestionsPanel";
import { useCommands } from "../studio/CommandContext";
import { NodeEditor } from "../studio/FlowNodeEditors";
import { DisplayRuleCard, CalculationCard } from "../studio/LogicPanel";
import { Icon } from "../ui/Icon";

/**
 * THE WORKSPACE — the centre pane of Architect.
 *
 * Whatever is selected in the map is programmed here, with the editor the
 * Studio already has for that kind of object: `QuestionEditor` for a
 * question (the same 760 lines the Questions panel expands inline),
 * `NodeEditor` for a branch / loop / randomizer / embedded data / redirect /
 * end, `DisplayRuleCard` for a named rule, `CalculationCard` for a
 * calculation. The workspace adds no editing of its own — it chooses.
 *
 * With nothing selected it shows the survey at a glance: what there is, and
 * what is wrong, as a place to start.
 */
export function Workspace({ primary, status, onSelect }: { primary: ObjectKey | null; status: ObjectStatusMap; onSelect(key: ObjectKey): void }) {
  const s = useStudio();
  const def = s.def;

  if (!primary) {
    const broken = [...status.byKey.values()].filter((x) => x.level !== "ok");
    return (
      <div className="aw aw-overview" data-testid="workspace-overview">
        <h2>{def.meta.title}</h2>
        <div className="aw-stats">
          <Stat n={def.questions.length} label="questions" />
          <Stat n={def.displayRules.length} label="display rules" />
          <Stat n={def.calculations.length} label="calculations" />
          <Stat n={def.quotas.length} label="quotas" />
          <Stat n={def.questions.filter((q) => q.displayLogic).length} label="with display logic" />
          <Stat n={def.questions.filter((q) => q.skipLogic?.length).length} label="with skips" />
        </div>
        {broken.length > 0 ? (
          <section className="aw-sec">
            <h3>{broken.length} object{broken.length === 1 ? "" : "s"} need attention</h3>
            <ul className="aw-broken">
              {broken.slice(0, 20).map((b) => (
                <li key={b.key}>
                  <button className="ai-link" onClick={() => onSelect(b.key)} data-testid="overview-issue">
                    <span className={`am-dot ${b.level}`} />
                    <span className="mono">{parseObjectKey(b.key).kind}:{parseObjectKey(b.key).id}</span>
                    <span className="aw-issue-msg">{b.issues[0]?.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="muted"><Icon name="check" size={14} /> Every check passes. Select something in the map to program it.</p>
        )}
        {status.unattributed.length > 0 && (
          <section className="aw-sec">
            <h3>Survey-level</h3>
            <ul className="aw-broken">{status.unattributed.map((i, k) => <li key={k} className={i.level}>{i.message}</li>)}</ul>
          </section>
        )}
      </div>
    );
  }

  const { kind, id } = parseObjectKey(primary);

  if (kind === "question") {
    const q = def.questions.find((x) => x.id === id);
    if (!q) return <Missing what="question" />;
    return (
      <div className="aw" data-testid="workspace-question">
        <QuestionEditor q={q} />
      </div>
    );
  }

  if (kind === "flowNode") {
    const node = findNode(def.flow as FlowNode[], id) as FlowNode | null;
    if (!node) return <Missing what="flow element" />;
    const sum = summarizeFlowNode(node);
    const patch = (next: FlowNode) => {
      s.labelNextEdit(`edit ${sum.label}`);
      s.update((d) => { replaceFlowNode(d.flow as FlowNode[], id, next); });
    };
    const title = (node as { title?: string }).title;
    return (
      <div className="aw" data-testid="workspace-flow">
        <div className="aw-node-head">
          <span className="ai-kind">{node.type.replace(/_/g, " ")}</span>
          {node.type !== "end" && node.type !== "quota_check" && (
            <input className="input aw-title" placeholder={sum.label} value={title ?? ""} data-testid="workspace-node-title"
              onChange={(e) => patch({ ...node, title: e.target.value } as FlowNode)} />
          )}
        </div>
        {node.type === "page" ? (
          <PageWorkspace node={node} onSelect={onSelect} />
        ) : node.type === "block" || node.type === "section" ? (
          <ContainerWorkspace node={node} onSelect={onSelect} patch={patch} />
        ) : (
          <NodeEditor node={node} onChange={patch} />
        )}
      </div>
    );
  }

  if (kind === "displayRule") {
    const i = def.displayRules.findIndex((r) => r.id === id);
    if (i < 0) return <Missing what="display rule" />;
    return <div className="aw" data-testid="workspace-rule"><DisplayRuleCard index={i} /></div>;
  }

  if (kind === "calculation") {
    const i = def.calculations.findIndex((c) => c.id === id);
    if (i < 0) return <Missing what="calculation" />;
    return <div className="aw" data-testid="workspace-calculation"><CalculationCard index={i} /></div>;
  }

  if (kind === "quota") {
    return (
      <div className="aw" data-testid="workspace-quota">
        <p className="muted">Quotas are edited on the Quotas tab, where the fieldwork counts live beside them.</p>
        <button className="btn" onClick={() => s.goToTab?.("quotas")}>Open Quotas</button>
      </div>
    );
  }

  return <Missing what={kind} />;
}

/** "+ Question here" — the same `question.add` command, which reads the selection to know where "here" is */
function AddHere({ what, testId, label }: { what: "question"; testId: string; label: string }) {
  const s = useStudio();
  const cmd = useCommands();
  return (
    <div className="aw-add">
      <button className="btn small" data-testid={testId} disabled={s.readOnly} onClick={() => cmd?.run(what === "question" ? "question.add" : "block.add")} title={label}>+ Question here</button>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return <div className="aw-stat"><span className="aw-stat-n">{n}</span><span className="aw-stat-l">{label}</span></div>;
}

function Missing({ what }: { what: string }) {
  return <div className="aw aw-overview"><p className="muted">That {what} is no longer in the survey.</p></div>;
}

/** a page: its questions, each a link into the map/inspector, plus its condition */
function PageWorkspace({ node, onSelect }: { node: Extract<FlowNode, { type: "page" }>; onSelect(key: ObjectKey): void }) {
  const s = useStudio();
  return (
    <div>
      <ul className="aw-qlist" data-testid="workspace-page-questions">
        {node.questionIds.map((qid) => {
          const q = s.def.questions.find((x) => x.id === qid);
          if (!q) return null;
          return (
            <li key={qid}>
              <button className="ai-link" onClick={() => onSelect(`question:${qid}`)}>
                <span className="mono am-code">{q.code}</span>
                <span>{String(q.text ?? "").replace(/<[^>]*>/g, "").trim() || q.variableName}</span>
              </button>
            </li>
          );
        })}
        {node.questionIds.length === 0 && <li className="muted">No questions on this page.</li>}
      </ul>
      <AddHere what="question" testId="workspace-add-question" label="Add a question to this page" />
      <NodeEditor node={node} onChange={(next) => { s.labelNextEdit("edit page"); s.update((d) => { replaceFlowNode(d.flow as FlowNode[], node.id, next); }); }} />
    </div>
  );
}

function ContainerWorkspace({ node, onSelect, patch }: { node: Extract<FlowNode, { type: "block" | "section" }>; onSelect(key: ObjectKey): void; patch(next: FlowNode): void }) {
  return (
    <div>
      <ul className="aw-qlist" data-testid="workspace-container-children">
        {node.children.map((c) => (
          <li key={c.id}>
            <button className="ai-link" onClick={() => onSelect(`flowNode:${c.id}`)}>
              <span className="ai-link-kind">{c.type.replace(/_/g, " ")}</span>
              <span>{summarizeFlowNode(c).label}</span>
            </button>
          </li>
        ))}
      </ul>
      <AddHere what="question" testId="workspace-add-question" label="Add a question to this block's last page" />
      <NodeEditor node={node} onChange={patch} />
    </div>
  );
}
