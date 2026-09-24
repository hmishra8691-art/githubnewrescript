"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import {
  neighbours, parseObjectKey, conditionSummary, findNode,
  type DependencyIndex, type ObjectKey, type ObjectStatusMap, type DependencyEdge,
} from "@rescript/engine";
import { useStudio } from "../studio/store";
import { PropertiesPanel } from "../studio/PropertiesPanel";
import { Icon } from "../ui/Icon";

/**
 * THE INSPECTOR — the right pane of Architect.
 *
 * For a question it is the property panel the Studio has always had (the
 * same component, the same seventeen sections), with one addition at the
 * top: DEPENDENCIES — what this reads, what reads it, what it would affect —
 * from the engine's dependency index, every entry clickable. Selecting a
 * branch, a named rule, a calculation or a quota shows the same shape for
 * that object: identity, its condition in English, its issues, its
 * dependencies.
 *
 * Nothing here evaluates or edits logic itself: the editing happens in the
 * workspace and in the property panel's own sections. The inspector is where
 * you find out how an object is wired before you touch it.
 */

const KIND_LABEL: Record<string, string> = {
  question: "Question", displayRule: "Display rule", skipRule: "Skip rule", calculation: "Calculation",
  quota: "Quota", flowNode: "Flow element", namedExpression: "Named expression", listFill: "List fill", embedded: "Embedded data",
};

export function Inspector({
  primary, index, status, onSelect,
}: {
  primary: ObjectKey | null;
  index: DependencyIndex;
  status: ObjectStatusMap;
  onSelect(key: ObjectKey): void;
}) {
  const s = useStudio();
  if (!primary) {
    return (
      <div className="ai-empty" data-testid="inspector-empty">
        <Icon name="info" size={18} />
        <p>Select anything in the map — a question, a branch, a rule, a calculation — to see how it is wired and to program it.</p>
      </div>
    );
  }
  const { kind, id } = parseObjectKey(primary);
  const st = status.statusOf(primary);
  const info = index.nodes.get(primary);

  return (
    <div className="ai" data-testid="inspector" data-kind={kind}>
      <div className="ai-head">
        <span className="ai-kind">{KIND_LABEL[kind] ?? kind}</span>
        <span className="ai-title mono">{info?.code ?? id}</span>
        {st.level !== "ok" && <span className={`ai-status ${st.level}`} data-testid="inspector-status">{st.issues.length} {st.level === "error" ? "problem" : "warning"}{st.issues.length === 1 ? "" : "s"}</span>}
      </div>

      {st.issues.length > 0 && (
        <section className="ai-sec" data-testid="inspector-issues">
          <h4>Issues</h4>
          <ul className="ai-issues">
            {st.issues.map((i, k) => <li key={k} className={i.level}>{i.message}</li>)}
          </ul>
        </section>
      )}

      <Dependencies primary={primary} index={index} onSelect={onSelect} />

      {kind === "question" ? (
        // the property panel reads the store's selectedQuestionId, which mirrors this primary
        <div className="ai-props"><PropertiesPanel /></div>
      ) : (
        <ObjectSummary primary={primary} />
      )}
    </div>
  );
}

/** USED BY / DEPENDS ON / AFFECTS — the dependency index, as a person reads it */
function Dependencies({ primary, index, onSelect }: { primary: ObjectKey; index: DependencyIndex; onSelect(key: ObjectKey): void }) {
  const reads = neighbours(index, primary, "dependsOn");
  const readBy = neighbours(index, primary, "usedBy");
  const affects = index.affects(primary).filter((k) => !readBy.some((n) => n.key === k));
  const reach = index.reach(primary).filter((k) => !reads.some((n) => n.key === k));
  const [showAll, setShowAll] = React.useState(false);

  const Row = ({ k, reasons }: { k: ObjectKey; reasons?: DependencyEdge[] }) => {
    const info = index.nodes.get(k);
    const { kind, id } = parseObjectKey(k);
    return (
      <li>
        <button className="ai-link" onClick={() => onSelect(k)} data-testid="dep-link" data-key={k} title={reasons?.map((r) => r.label).join("\n")}>
          <span className="ai-link-kind">{(KIND_LABEL[kind] ?? kind).toLowerCase()}</span>
          <span className="mono">{info?.code ?? id}</span>
          {reasons && reasons.length > 0 && <span className="ai-link-why">{[...new Set(reasons.map((r) => r.kind))].join(", ")}</span>}
        </button>
      </li>
    );
  };

  const empty = reads.length === 0 && readBy.length === 0;
  return (
    <section className="ai-sec" data-testid="inspector-deps">
      <h4>Dependencies</h4>
      {empty && <p className="muted ai-none">Nothing reads this and it reads nothing — it stands alone.</p>}
      {readBy.length > 0 && (
        <>
          <div className="ai-sub">Used by <span className="ai-n">{readBy.length}</span></div>
          <ul className="ai-list" data-testid="dep-used-by">{readBy.map((n) => <Row key={n.key} k={n.key} reasons={n.reasons} />)}</ul>
        </>
      )}
      {reads.length > 0 && (
        <>
          <div className="ai-sub">Depends on <span className="ai-n">{reads.length}</span></div>
          <ul className="ai-list" data-testid="dep-depends-on">{reads.map((n) => <Row key={n.key} k={n.key} reasons={n.reasons} />)}</ul>
        </>
      )}
      {(affects.length > 0 || reach.length > 0) && (
        <>
          <button className="ai-more" onClick={() => setShowAll((v) => !v)} data-testid="dep-more">
            {showAll ? "Hide" : "Show"} indirect · affects {affects.length} more, reaches {reach.length} more
          </button>
          {showAll && (
            <>
              {affects.length > 0 && <><div className="ai-sub">Affects, indirectly</div><ul className="ai-list" data-testid="dep-affects">{affects.map((k) => <Row key={k} k={k} />)}</ul></>}
              {reach.length > 0 && <><div className="ai-sub">Reaches, indirectly</div><ul className="ai-list">{reach.map((k) => <Row key={k} k={k} />)}</ul></>}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** what a non-question object IS, in one screen */
function ObjectSummary({ primary }: { primary: ObjectKey }) {
  const s = useStudio();
  const { kind, id } = parseObjectKey(primary);
  const def = s.def;
  const rows: [string, React.ReactNode][] = [];
  if (kind === "displayRule") {
    const r = def.displayRules.find((x) => x.id === id);
    if (r) {
      const target = r.target.kind === "question" ? (def.questions.find((q) => q.id === r.target.ref)?.code ?? r.target.ref) : `${r.target.kind} ${r.target.ref}${r.target.subRef ? ` › ${r.target.subRef}` : ""}`;
      rows.push(["Label", r.label || "—"], ["Action", r.action.toUpperCase()], ["Target", target], ["When", conditionSummary(def, r.when) || "always"]);
    }
  } else if (kind === "calculation") {
    const c = def.calculations.find((x) => x.id === id);
    if (c) rows.push(["Variable", <span className="mono">{c.targetVariable}</span>], ["Expression", <span className="mono">{c.expression || "—"}</span>], ["Runs", c.trigger.replace(/_/g, " ")], ["Type", c.dataType], ["Only when", c.when ? conditionSummary(def, c.when) : "always"]);
  } else if (kind === "quota") {
    const q = def.quotas.find((x) => x.id === id);
    if (q) rows.push(["Name", q.name], ["Mode", q.mode], ["Cells", `${q.cells.length}`], ["When full", q.onFull.kind], ...q.cells.slice(0, 8).map((c): [string, React.ReactNode] => [`· ${c.label}`, `${conditionSummary(def, c.when)} — limit ${c.limit}`]));
  } else if (kind === "flowNode") {
    const n = findNode(def.flow as FlowNode[], id) as FlowNode | null;
    if (n) {
      rows.push(["Type", n.type.replace(/_/g, " ")]);
      const title = (n as { title?: string }).title; if (title) rows.push(["Title", title]);
      const vis = (n as { visibleIf?: unknown }).visibleIf; if (vis) rows.push(["Shown when", conditionSummary(def, vis as never)]);
      if (n.type === "branch") n.branches.forEach((arm, i) => rows.push([arm.label ?? `Path ${i + 1}`, conditionSummary(def, arm.when) || "always"]));
      if (n.type === "loop") { rows.push(["Loop variable", <span className="mono">{n.loopVar}</span>]); if (n.eligibleIf) rows.push(["Eligible when", conditionSummary(def, n.eligibleIf)]); if (n.breakIf) rows.push(["Stops when", conditionSummary(def, n.breakIf)]); }
      if (n.type === "page") rows.push(["Questions", `${n.questionIds.length}`]);
      if (n.type === "end") rows.push(["Status", n.status]);
      if (n.type === "redirect") rows.push(["URL", n.url]);
      if (n.type === "quota_check") rows.push(["Quotas", `${n.quotaIds.length}`], ["When full", n.onFull.kind]);
    }
  }
  if (!rows.length) return null;
  return (
    <section className="ai-sec" data-testid="inspector-summary">
      <h4>Definition</h4>
      <dl className="ai-dl">
        {rows.map(([k, v], i) => <React.Fragment key={i}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
      </dl>
      <p className="muted ai-none">Edit it in the workspace to the left.</p>
    </section>
  );
}
