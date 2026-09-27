"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import { parseObjectKey, findNode, replaceFlowNode, summarizeFlowNode, splitPageAfter, joinPageAfter, type ObjectKey, type ObjectStatusMap, type DependencyIndex } from "@rescript/engine";
import { useStudio, uid } from "../studio/store";
import { useMode } from "../studio/ModeContext";
import { buildStructure, scopeStructure, positionCrumb, type Structure } from "../../lib/architect/structure";
import { StructureOutline, type StructureActions } from "./Structure";
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
export function Workspace({ primary, status, index, focusSet, onSelect }: { primary: ObjectKey | null; status: ObjectStatusMap; index?: DependencyIndex; focusSet?: ReadonlySet<string> | null; onSelect(key: ObjectKey): void }) {
  const s = useStudio();
  const def = s.def;
  const mode = useMode();

  /*
   * THE STRUCTURE (UI upgrade §4–§8): blocks → pages → questions, page
   * breaks explicit, logic as chips. Built from the definition and the
   * dependency index; scoped to the selected container when one is.
   */
  const structure = React.useMemo<Structure>(() => buildStructure(def, { index }), [def, index]);
  const actions = React.useMemo<StructureActions>(() => ({
    onSelect,
    onReveal: (key, section) => { onSelect(key); mode?.requestPanel(section); },
    onAddBreak: (qid) => {
      let out: { ok: boolean; reason?: string } = { ok: false };
      s.labelNextEdit("add page break");
      s.update((d) => { out = splitPageAfter(d, qid, uid); });
      if (!out.ok) s.toast(out.reason ?? "Could not add a page break there.", "err"); else s.toast("Page break added — same block, new respondent page");
    },
    onRemoveBreak: (qid) => {
      let out: { ok: boolean; reason?: string } = { ok: false };
      s.labelNextEdit("remove page break");
      s.update((d) => { out = joinPageAfter(d, qid); });
      if (!out.ok) s.toast(out.reason ?? "Could not remove that page break.", "err"); else s.toast("Page break removed — the two pages are one");
    },
  }), [onSelect, mode, s]);

  if (!primary) {
    const broken = [...status.byKey.values()].filter((x) => x.level !== "ok");
    return (
      <div className="aw aw-overview" data-testid="workspace-overview">
        <h2>{def.meta.title}</h2>
        <div className="aw-stats">
          <Stat n={def.questions.length} label="questions" />
          <Stat n={structure.blockCount} label="blocks" />
          <Stat n={structure.pageCount} label="pages" />
          <Stat n={structure.breakCount} label="page breaks" />
          <Stat n={def.displayRules.length} label="display rules" />
          <Stat n={def.calculations.length} label="calculations" />
          <Stat n={def.quotas.length} label="quotas" />
          <Stat n={def.questions.filter((q) => q.displayLogic).length} label="with display logic" />
          <Stat n={def.questions.filter((q) => q.skipLogic?.length).length} label="with skips" />
        </div>
        <section className="aw-sec aw-structure">
          <h3>Structure <span className="muted">— blocks, pages and page breaks in respondent order; click a row to inspect it, a chip to open its logic</span></h3>
          <StructureOutline entries={structure.entries} unplaced={structure.unplaced} primary={null} readOnly={s.readOnly} actions={actions} dim={focusSet ?? null} />
        </section>
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
    const crumb = positionCrumb(structure, q.id);
    const row = crumb?.page.questions[crumb.index];
    return (
      <div className="aw" data-testid="workspace-question">
        {/* WHERE THIS QUESTION SITS, and what logic is on it — the architecture around the editor (§5, §8) */}
        <div className="aw-place" data-testid="workspace-place">
          {crumb ? (
            <span className="aw-crumbs">
              <button type="button" className="aw-crumb-link" onClick={() => onSelect(crumb.block.key)}>{crumb.block.label}{crumb.block.title ? ` · ${crumb.block.title}` : ""}</button>
              <span className="aw-crumb-sep">›</span>
              <span>{crumb.block.pages.length > 1 ? `Page ${crumb.page.n} of ${crumb.block.pages.length}` : "One page"}</span>
              <span className="aw-crumb-sep">›</span>
              <span>{crumb.index + 1} of {crumb.page.questions.length}</span>
              {row?.boundary === "page" && <span className="aw-boundary" data-testid="workspace-boundary" title="A page break follows this question">· page break after</span>}
              {row?.boundary === "block" && <span className="aw-boundary" data-testid="workspace-boundary" title="This question ends its block">· ends the block</span>}
            </span>
          ) : <span className="muted">Not on any page — respondents never see this question.</span>}
          <span className="grow" />
          {row && row.chips.length > 0 && (
            <span className="st-chips" data-testid="workspace-chips">
              {row.chips.map((c, i) => (
                <button key={i} type="button" className={`st-chip st-chip-${c.kind}`} data-testid="structure-chip" data-chip={c.kind} title={c.detail}
                  onClick={() => { if (c.key) onSelect(c.key); else if (c.section) actions.onReveal(row.key, c.section); }}>{c.label}</button>
              ))}
            </span>
          )}
          {crumb && !s.readOnly && (
            row?.boundary === "page"
              ? <button type="button" className="btn small" data-testid="workspace-break-remove" onClick={() => actions.onRemoveBreak!(q.id)} title="Join this page with the next">Remove page break after</button>
              : row?.boundary === "none"
                ? <button type="button" className="btn small" data-testid="workspace-break-add" onClick={() => actions.onAddBreak!(q.id)} title="Start a new page after this question">+ Page break after</button>
                : null
          )}
        </div>
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
          <PageWorkspace node={node} onSelect={onSelect} outline={<StructureOutline entries={scopeStructure(structure, primary)} primary={primary} readOnly={s.readOnly} actions={actions} dim={focusSet ?? null} />} />
        ) : node.type === "block" || node.type === "section" ? (
          <ContainerWorkspace node={node} onSelect={onSelect} patch={patch} outline={<StructureOutline entries={scopeStructure(structure, primary)} primary={primary} readOnly={s.readOnly} actions={actions} dim={focusSet ?? null} />} />
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

/** a page: shown in its block — its questions, the breaks around it, the logic on each (§5) — plus its condition */
function PageWorkspace({ node, onSelect, outline }: { node: Extract<FlowNode, { type: "page" }>; onSelect(key: ObjectKey): void; outline: React.ReactNode }) {
  const s = useStudio();
  return (
    <div>
      <div data-testid="workspace-page-questions" data-count={node.questionIds.length}>{outline}</div>
      <AddHere what="question" testId="workspace-add-question" label="Add a question to this page" />
      <NodeEditor node={node} onChange={(next) => { s.labelNextEdit("edit page"); s.update((d) => { replaceFlowNode(d.flow as FlowNode[], node.id, next); }); }} />
    </div>
  );
}

function ContainerWorkspace({ node, patch, outline }: { node: Extract<FlowNode, { type: "block" | "section" }>; onSelect(key: ObjectKey): void; patch(next: FlowNode): void; outline: React.ReactNode }) {
  return (
    <div>
      <div data-testid="workspace-container-children" data-count={node.children.length}>{outline}</div>
      <AddHere what="question" testId="workspace-add-question" label="Add a question to this block's last page" />
      <NodeEditor node={node} onChange={patch} />
    </div>
  );
}
