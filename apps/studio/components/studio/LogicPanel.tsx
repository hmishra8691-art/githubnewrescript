"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import {
  lintSurveyLogic, questionLogicSummary, detectLogicCycles, describeCycle,
  validateFlowStructure, type LogicIssue,
} from "@rescript/engine";
import { AutoPunchPanel } from "./AutoPunchEditor";
import { useStudio, uid } from "./store";
import { ConditionEditor, conditionToText, OptionalCondition } from "./ConditionBuilder";

/**
 * Survey-wide logic check (reqs §30–31): every broken reference, dead option
 * code, incompatible operator, empty group, forward reference and circular
 * dependency in one list, before a respondent ever sees it.
 */
function LogicCheck() {
  const s = useStudio();
  // logic references AND the shape of the flow — a survey can be broken by
  // either, and a programmer checking "is this survey sound?" wants one answer
  const issues: LogicIssue[] = React.useMemo(() => [
    ...lintSurveyLogic(s.def),
    ...validateFlowStructure(s.def.flow as FlowNode[]).map((i) => ({
      level: i.level,
      questionCode: "Flow",
      path: i.nodeId ? `flow.${i.nodeId}` : "flow",
      message: i.message,
    })),
  ], [s.def]);
  const cycles = React.useMemo(() => detectLogicCycles(s.def), [s.def]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const [showWarnings, setShowWarnings] = React.useState(false);

  return (
    <div data-testid="logic-check">
      <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
        <span className={`chip ${errors.length ? "warn" : ""}`} data-testid="logic-error-count">
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
        <span className="chip">{warnings.length} warning{warnings.length === 1 ? "" : "s"}</span>
        {cycles.length > 0 && <span className="chip warn">{cycles.length} circular dependency</span>}
        {warnings.length > 0 && (
          <button className="btn small" onClick={() => setShowWarnings((v) => !v)}>
            {showWarnings ? "hide warnings" : "show warnings"}
          </button>
        )}
        {errors.length === 0 && warnings.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>All logic references resolve.</span>
        )}
      </div>
      {cycles.map((c, i) => (
        <div key={`cyc${i}`} className="chip warn" style={{ marginBottom: 4 }}>{describeCycle(s.def, c)}</div>
      ))}
      {[...errors, ...(showWarnings ? warnings : [])].map((i, k) => (
        <div key={k} className={`chip ${i.level === "error" ? "warn" : ""}`}
          style={{ marginBottom: 4, cursor: i.questionId ? "pointer" : undefined }}
          onClick={() => i.questionId && s.select(i.questionId)}>
          {i.level === "error" ? "✕" : "!"} <strong>{i.questionCode ?? "?"}</strong> {i.path}
          {i.optionCode ? ` [${i.optionCode}]` : ""} — {i.message}
        </div>
      ))}
    </div>
  );
}

/** Plain-English summary of everything dynamic in the survey (req §14). */
function LogicSummaryList() {
  const s = useStudio();
  const rows = s.def.questions
    .map((q) => ({ q, lines: questionLogicSummary(s.def, q) }))
    .filter((r) => r.lines.length > 0);
  if (rows.length === 0)
    return <p className="muted" style={{ fontSize: 12 }}>No dynamic content configured yet.</p>;
  return (
    <div>
      {rows.map(({ q, lines }) => (
        <div key={q.id} className="card selectable" style={{ padding: 10 }} onClick={() => s.select(q.id)}>
          <strong className="mono">{q.code}</strong>
          <div className="logic-summary">
            {lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Logic panel: named display rules (any target) + the Logic Flow view —
 * an inspectable, exportable decision tree derived from the programmed
 * branches and skip rules (requirement §8).
 */

function deriveLogicFlowText(s: ReturnType<typeof useStudio>): string {
  const lines: string[] = [];
  const qcode = (id: string) => s.def.questions.find((q) => q.id === id)?.code ?? id;

  const walk = (nodes: FlowNode[], indent: string) => {
    for (const node of nodes) {
      switch (node.type) {
        case "page":
          for (const qid of node.questionIds) {
            const q = s.def.questions.find((x) => x.id === qid);
            if (!q) continue;
            let line = `${indent}${q.code}`;
            if (q.displayLogic) line += `   [show if ${conditionToText(q.displayLogic, s.def)}]`;
            lines.push(line);
            for (const rule of q.skipLogic) {
              const t = rule.target;
              const target =
                t.kind === "question" ? qcode(t.ref ?? "") :
                t.kind === "url" ? `URL ${t.ref}` :
                t.kind === "page" ? `page ${t.ref}` :
                t.kind === "terminate" ? `TERMINATE (${t.status ?? "terminated"})` : "END";
              lines.push(`${indent} ├─ if ${conditionToText(rule.when, s.def)} → ${target}`);
            }
          }
          break;
        case "branch":
          lines.push(`${indent}BRANCH`);
          for (const b of node.branches) {
            lines.push(`${indent} ├─ ${b.label ?? ""} [${conditionToText(b.when, s.def)}]`);
            walk(b.children, indent + " │   ");
          }
          if (node.otherwise?.length) {
            lines.push(`${indent} └─ otherwise`);
            walk(node.otherwise, indent + "     ");
          }
          break;
        case "loop":
          lines.push(`${indent}LOOP (${node.loopVar})`);
          walk(node.children, indent + "  ");
          break;
        case "randomizer":
          lines.push(`${indent}RANDOMIZE${node.show ? ` show ${node.show}` : ""}`);
          walk(node.children, indent + "  ");
          break;
        case "section":
        case "block":
          lines.push(`${indent}[${node.title ?? node.id}]`);
          walk(node.children, indent + "  ");
          break;
        case "quota_check":
          lines.push(`${indent}QUOTA CHECK (${node.quotaIds.join(", ")}) → ${node.onFull.kind} when full`);
          break;
        case "end":
          lines.push(`${indent}END (${node.status})`);
          break;
        case "redirect":
          lines.push(`${indent}REDIRECT → ${node.url}`);
          break;
        default:
          break;
      }
    }
  };
  walk(s.def.flow, "");
  return lines.join("\n");
}

export function LogicPanel() {
  const s = useStudio();
  const logicText = deriveLogicFlowText(s);

  const download = () => {
    const blob = new Blob([logicText], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.def.meta.code}_logic_flow.txt`;
    a.click();
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Logic</h2>
      </div>

      <h3 className="sec">Logic check</h3>
      <LogicCheck />

      <h3 className="sec">What is dynamic in this survey</h3>
      <LogicSummaryList />

      <h3 className="sec">Auto punch (option → option)</h3>
      <AutoPunchPanel />

      <h3 className="sec">Display rules (show/hide anything)</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        Question-level display &amp; skip logic lives on each question (right panel). Rules here can
        additionally target any question from one place.
      </p>
      {s.def.displayRules.map((r, i) => (
        <div key={r.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input" style={{ width: 180 }} placeholder="rule label" value={r.label ?? ""}
              onChange={(e) => s.update((d) => { d.displayRules[i].label = e.target.value; })} />
            <select className="select" value={r.action}
              onChange={(e) => s.update((d) => { d.displayRules[i].action = e.target.value as any; })}>
              <option value="show">SHOW</option><option value="hide">HIDE</option>
            </select>
            <select className="select grow" value={r.target.ref}
              onChange={(e) => s.update((d) => { d.displayRules[i].target = { kind: "question", ref: e.target.value }; })}>
              <option value="">— target question —</option>
              {s.def.questions.map((q) => <option key={q.id} value={q.id}>{q.code}</option>)}
            </select>
            <button className="btn small danger"
              onClick={() => s.update((d) => { d.displayRules.splice(i, 1); })}>×</button>
          </div>
          <div className="flabel">WHEN</div>
          <ConditionEditor value={r.when}
            onChange={(when) => s.update((d) => { d.displayRules[i].when = when; })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        s.update((d) => {
          d.displayRules.push({
            id: uid("dr"), label: "", action: "show",
            target: { kind: "question", ref: d.questions[0]?.id ?? "" },
            when: { type: "group", op: "and", children: [] },
          });
        })}>
        + display rule
      </button>

      <h3 className="sec">Logic Flow (derived — inspectable &amp; exportable)</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn small" onClick={download}>download .txt</button>
        <button className="btn small" onClick={() => {
          navigator.clipboard.writeText(logicText);
          s.toast("Logic flow copied");
        }}>copy</button>
      </div>
      <pre className="logic-pre">{logicText || "(empty flow)"}</pre>
    </div>
  );
}

export function CalcPanel() {
  const s = useStudio();
  // lazy import to avoid SSR cycles
  const [exprErrors, setExprErrors] = React.useState<Record<string, string | null>>({});
  React.useEffect(() => {
    import("@rescript/engine").then(({ validateExpression }) => {
      const errs: Record<string, string | null> = {};
      for (const c of s.def.calculations) errs[c.id] = validateExpression(c.expression);
      setExprErrors(errs);
    });
  }, [s.def.calculations]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Calculations</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          Calc DSL: + − × ÷ %, sum() avg() min() max() count() countif() pct() weighted() if() round(),
          wildcards like sum(ALLOC_*)
        </span>
      </div>
      {s.def.calculations.map((c, i) => (
        <div key={c.id} className="card" style={{ padding: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input mono" style={{ width: 180 }} value={c.targetVariable}
              placeholder="TARGET_VAR"
              onChange={(e) => s.update((d) => { d.calculations[i].targetVariable = e.target.value.toUpperCase(); })} />
            <span className="muted">=</span>
            <input className="input mono grow" value={c.expression}
              placeholder="Q1 + Q2 + Q3"
              onChange={(e) => s.update((d) => { d.calculations[i].expression = e.target.value; })} />
            <select className="select" style={{ width: 140 }} value={c.trigger}
              onChange={(e) => s.update((d) => { d.calculations[i].trigger = e.target.value as any; })}>
              <option value="on_change">on change</option>
              <option value="on_page_submit">on page submit</option>
              <option value="on_complete">on complete</option>
            </select>
            <button className="btn small danger" onClick={() => s.update((d) => { d.calculations.splice(i, 1); })}>×</button>
          </div>
          {exprErrors[c.id] && <div className="chip warn">syntax: {exprErrors[c.id]}</div>}
          <OptionalCondition label="Only compute when" value={c.when}
            onChange={(w) => s.update((d) => { d.calculations[i].when = w; })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        s.update((d) => {
          d.calculations.push({
            id: uid("calc"), targetVariable: `CALC_${d.calculations.length + 1}`,
            expression: "", trigger: "on_page_submit", dataType: "numeric",
          });
        })}>
        + calculation
      </button>
    </div>
  );
}
