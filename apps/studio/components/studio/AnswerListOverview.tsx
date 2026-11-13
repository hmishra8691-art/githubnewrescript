"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { listRulesOverview, LIST_RULE_TOOLS, type ListRuleSection } from "@rescript/engine";
import { useStudio } from "./store";
import { useMode } from "./ModeContext";

/**
 * "ANSWER LIST RULES" — the overview above carry-forward, list logic, masking and list operations (2026-11-15).
 *
 * It answers the three questions the four sections never did: which tool do I need, what is this question's list
 * doing right now, and are two of my rules fighting. Everything it says is read from the definition by the engine
 * (`listRulesOverview`); it stores nothing. Each line opens the section it is about.
 */
export function AnswerListOverview({ q }: { q: Question }) {
  const s = useStudio();
  const mode = useMode();
  const o = React.useMemo(() => listRulesOverview(s.def, q), [s.def, q]);
  const open = (section: ListRuleSection) => mode?.requestPanel(section);
  const tools = Object.entries(LIST_RULE_TOOLS) as [ListRuleSection, (typeof LIST_RULE_TOOLS)[ListRuleSection]][];
  return (
    <div className="card alr" data-testid="answer-list-overview" data-plain={o.plain ? "1" : "0"}>
      <div className="alr-head">
        <strong>Answer list rules</strong>
        <span className="muted">which options this question shows</span>
      </div>
      {o.plain ? (
        <p className="muted alr-plain" data-testid="alr-plain">
          This question shows its own options, as written. To make the list depend on earlier answers, pick what you need:
        </p>
      ) : (
        <>
          <p className="muted alr-plain">In effect, in the order they are applied:</p>
          <ol className="alr-steps" data-testid="alr-steps">
            {o.steps.map((st, i) => (
              <li key={`${st.section}:${i}`} data-testid="alr-step" data-section={st.section}>
                <button type="button" className="alr-link" onClick={() => open(st.section)} title="Open this rule">
                  <span className="alr-num">{st.order}</span>{st.summary}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {o.notes.map((n, i) => (
        <div key={i} className={`alr-note ${n.level}`} data-testid="alr-note" data-level={n.level} role={n.level === "conflict" ? "alert" : undefined}>
          <span className="alr-note-tag">{n.level === "conflict" ? "Conflict" : n.level === "overlap" ? "Overlap" : "Note"}</span>
          {n.message}
          {n.sections.slice(0, 2).map((sec) => (
            <button key={sec} type="button" className="btn small ghost" onClick={() => open(sec)}>open {LIST_RULE_TOOLS[sec].technical}</button>
          ))}
        </div>
      ))}
      <details className="alr-guide" data-testid="alr-guide" open={o.plain}>
        <summary>Which one do I need?</summary>
        <ul>
          {tools.map(([sec, t]) => (
            <li key={sec}>
              <button type="button" className="alr-link" data-testid={`alr-tool-${sec}`} onClick={() => open(sec)}>
                <span className="alr-num">{t.order}</span><strong>{t.title}</strong> <span className="muted">({t.technical})</span>
              </button>
              <div className="muted alr-use">{t.use}</div>
            </li>
          ))}
        </ul>
        <p className="muted alr-use">They are applied in this order, then sorting and randomization. One option's own show / hide rule is set on the option itself.</p>
      </details>
    </div>
  );
}
