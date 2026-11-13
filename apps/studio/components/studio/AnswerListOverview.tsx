"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { listRulesOverview, LIST_RULE_TOOLS, type ListRuleSection, LIST_GOALS, listGoalSources, suggestListSource, applyListGoal, type ListGoal } from "@rescript/engine";
import { useStudio, uid } from "./store";
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
        <>
          <p className="muted alr-plain" data-testid="alr-plain">
            This question shows its own options, as written. To make the list depend on an earlier answer, say what it should show:
          </p>
          <ListGoalBuilder q={q} />
        </>
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
      {!o.plain && (
        <details className="alr-guide" data-testid="alr-add">
          <summary>Add another rule</summary>
          <ListGoalBuilder q={q} />
        </details>
      )}
      <details className="alr-guide" data-testid="alr-guide">
        <summary>{o.plain ? "Something else? All four tools" : "Which one do I need?"}</summary>
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

/**
 * "SHOW [only the answers they chose at] [Q1]" — the researcher names the goal and the earlier question; the engine
 * (`applyListGoal`, listGoals.ts) picks list logic or carry-forward, builds an ordinary rule of that tool, and says
 * what it will do before anything is stored. The rule is then edited in its own section like any other.
 */
function ListGoalBuilder({ q }: { q: Question }) {
  const s = useStudio();
  const sources = React.useMemo(() => listGoalSources(s.def, q.id), [s.def, q.id]);
  const [goal, setGoal] = React.useState<ListGoal>("only_chosen");
  const [source, setSource] = React.useState<string>(() => suggestListSource(s.def, q.id) ?? "");
  React.useEffect(() => { if (!sources.some((x) => x.id === source)) setSource(suggestListSource(s.def, q.id) ?? ""); }, [sources, source, s.def, q.id]);
  if (!sources.length) {
    return <p className="muted alr-use" data-testid="alr-goal-none">No question with answers is asked before this one, so there is nothing for the list to follow yet.</p>;
  }
  /* preview with a fixed id; the stored rule gets a fresh one */
  const preview = source ? applyListGoal(s.def, q, goal, source, () => "preview") : null;
  const apply = () => {
    const r = applyListGoal(s.def, q, goal, source, () => uid("ll"));
    if (!r.ok) return;
    s.labelNextEdit(`list: ${LIST_GOALS.find((g) => g.goal === goal)?.label ?? goal} ${s.def.questions.find((x) => x.id === source)?.code ?? ""}`.trim());
    s.update((d) => { const t = d.questions.find((x) => x.id === q.id); if (t) Object.assign(t, r.patch); });
  };
  return (
    <div className="alr-goal" data-testid="alr-goal">
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="alr-goal-word">Show</span>
        <select className="select small" data-testid="alr-goal-what" value={goal} onChange={(e) => setGoal(e.target.value as ListGoal)}>
          {LIST_GOALS.map((g) => <option key={g.goal} value={g.goal}>{g.label}</option>)}
        </select>
        <select className="select small" data-testid="alr-goal-source" value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
        </select>
        <button type="button" className="btn small primary" data-testid="alr-goal-apply" disabled={!preview?.ok} onClick={apply}>Apply</button>
      </div>
      {preview && (preview.ok ? (
        <p className="alr-goal-preview" data-testid="alr-goal-preview">
          This will: {preview.summary} <span className="muted">({LIST_RULE_TOOLS[preview.tool].technical})</span>
          {preview.note && <span className="alr-goal-note" data-testid="alr-goal-note"> {preview.note}</span>}
        </p>
      ) : (
        <p className="alr-goal-preview warn" data-testid="alr-goal-reason">{preview.reason}</p>
      ))}
    </div>
  );
}
