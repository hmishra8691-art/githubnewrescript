"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { Icon } from "../../ui/Icon";
import { linkify } from "../../../lib/copilot/client";
import { formatCharge } from "../../../lib/import/chat";
import { languageName } from "../../../lib/intelligent/voice";
import type { CopilotEntry } from "./useCopilot";

/**
 * ONE COPILOT TURN in the conversation: what the researcher said (and, when
 * spoken, what was heard), what the copilot understood — objective,
 * hypotheses, variables and their roles, population, method — the proposed
 * structure, the assumptions it wants confirmed, what the research documents
 * support (and what is only its recommendation), and, when it proposes
 * changes, the headline and the buttons. The detail of the change lives in
 * the Changes panel; this card links to it.
 *
 * Every question code in the copilot's words is a link to the question.
 */
export function CopilotCard({ entry, def, onSelect, onReviewChanges, onApply, onCancel, onAnswer, counts, canApply, applyTitle }: {
  entry: CopilotEntry;
  def: SurveyDefinition;
  onSelect(questionId: string): void;
  onReviewChanges(): void;
  onApply(): void;
  onCancel(): void;
  onAnswer(text: string): void;
  counts: { label: string; value: number }[] | null;
  canApply: boolean;
  applyTitle: string;
}) {
  const r = entry.reply;
  const u = r?.understanding;
  const state = entry.proposal;
  return (
    <article className={`iq-turn cp-turn ${state === "applied" ? "applied" : state === "cancelled" || state === "superseded" ? "cancelled" : "open"}`} data-testid="cp-turn" data-status={entry.status} data-kind={r?.kind ?? ""} data-proposal={state ?? ""} data-mode={entry.context?.mode ?? ""}>
      <div className="iq-said"><Icon name="user" size={13} /> <span>{entry.text}</span></div>
      {entry.heard && (
        <div className="iq-heard" data-testid="iq-heard" data-language={entry.heard.language}>
          <span><span className="iq-heard-kw">Heard{entry.heard.language && entry.heard.language !== "und" ? ` (${languageName(entry.heard.language)})` : ""}:</span> {entry.heard.text}</span>
          {entry.heard.english && entry.heard.english !== entry.heard.text && <span><span className="iq-heard-kw">Read as:</span> {entry.heard.english}</span>}
        </div>
      )}
      <div className={`iq-card cp-card${entry.status === "failed" ? " blocked" : ""}${r?.kind === "proposal" ? " proposal" : " answer"}`}>
        <div className="iq-card-head">
          <span className="iq-kicker"><Icon name="sparkle" size={11} /> {entry.status === "thinking" ? "THINKING" : entry.status === "failed" ? "COULD NOT ANSWER" : state === "applied" ? `APPLIED${entry.changeN ? ` · AI CHANGE #${String(entry.changeN).padStart(3, "0")}` : ""}` : state === "superseded" ? "REVISED BELOW" : state === "cancelled" ? "CANCELLED" : r?.kind === "proposal" ? "PROPOSED" : r?.kind === "review" ? "REVIEW" : r?.kind === "clarify" ? "QUESTION" : "COPILOT"}</span>
          {entry.context?.researchUsed && <span className="iq-source" title={`${entry.context.passages.length} passage(s) from your research documents were used`} data-testid="cp-research-used">research · {entry.context.passages.length}</span>}
          {entry.context?.cached && <span className="iq-source" title="The same request was answered moments ago; no new model call was made">cached</span>}
          <span className="iq-spacer" />
          {entry.usage && entry.usage.charge > 0 && <span className="iqi-dim" data-testid="cp-charge">{formatCharge(entry.usage.charge)}</span>}
        </div>
        {entry.status === "thinking" && <div className="iq-thinking"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
        {entry.error && <p className="iq-error" role="alert" data-testid="cp-error"><Icon name="warning" size={12} /> {entry.error}</p>}
        {entry.message && <p className="iq-warning" data-testid="cp-empty"><Icon name="info" size={12} /> {entry.message}</p>}
        {entry.appliedNote && <p className="cp-applied-note" data-testid="cp-applied-note"><Icon name="check" size={12} /> {entry.appliedNote}</p>}
        {entry.context?.uxOnly && state === "open" && <p className="iqi-dim cp-ux-only-note" data-testid="cp-ux-only-turn">Look and behaviour only — the Studio refuses any change to questions, options, codes or logic in this request.</p>}
        {r && (
          <>
            <p className="cp-reply" data-testid="cp-reply"><Linked text={r.reply} def={def} onSelect={onSelect} /></p>
            {u && (
              <details className="cp-understanding" open={r.kind === "proposal" && !!u.variables.length} data-testid="cp-understanding">
                <summary className="iq-label">Research understanding</summary>
                {u.objective && <div className="cp-row"><span className="iq-label">Objective</span><span>{u.objective}</span></div>}
                {u.hypotheses.map((h, i) => <div key={i} className="cp-row"><span className="iq-label">Hypothesis {u.hypotheses.length > 1 ? i + 1 : ""}</span><span>{h}</span></div>)}
                {u.population && <div className="cp-row"><span className="iq-label">Population</span><span>{u.population}</span></div>}
                {u.variables.length > 0 && (
                  <table className="iqi-table cp-vars" data-testid="cp-variables">
                    <thead><tr><th>Variable</th><th>Role</th><th>Measured by</th></tr></thead>
                    <tbody>{u.variables.map((v, i) => <tr key={i} data-role={v.role}><td>{v.name}</td><td><span className={`cp-role r-${v.role}`}>{v.role}</span></td><td className="iqi-dim"><Linked text={v.measure ?? ""} def={def} onSelect={onSelect} /></td></tr>)}</tbody>
                  </table>
                )}
                {u.methodology && <div className="cp-row"><span className="iq-label">Method</span><span>{u.methodology}</span></div>}
                {u.analysis.length > 0 && <div className="cp-row"><span className="iq-label">Analysis</span><span>{u.analysis.join(" · ")}</span></div>}
              </details>
            )}
            {r.plan.length > 0 && (
              <ol className="cp-plan" data-testid="cp-plan">
                {r.plan.map((p, i) => <li key={i}><b>{p.block}</b>{p.questions !== undefined ? <span className="iqi-dim"> · {p.questions} question{p.questions === 1 ? "" : "s"}</span> : null}{p.purpose ? <span className="iqi-dim"> — {p.purpose}</span> : null}</li>)}
              </ol>
            )}
            {r.sources.length > 0 && (
              <ul className="cp-sources" data-testid="cp-sources">
                {r.sources.map((x, i) => (
                  <li key={i} data-support={x.support}>
                    <span className={`cp-support s-${x.support}`}>{x.support === "document" ? "from your documents" : x.support === "assumption" ? "assumption" : "recommendation"}</span> {x.claim}
                    {x.passages.map((p) => { const ps = entry.passages?.[p]; return <span key={p} className="cp-cite mono" title={ps ? `${ps.doc}, p.${ps.page}${ps.heading ? ` — ${ps.heading}` : ""}\n${ps.excerpt}` : p}>[{ps ? `${ps.doc.replace(/\.[a-z0-9]+$/i, "")} p.${ps.page}` : p}]</span>; })}
                  </li>
                ))}
              </ul>
            )}
            {r.findings.length > 0 && r.kind !== "review" && (
              <ul className="cp-findings" data-testid="cp-findings">
                {r.findings.map((f, i) => <li key={i} data-severity={f.severity}><span className={`cp-sev v-${f.severity}`}>{f.severity}</span> <Linked text={f.message} def={def} onSelect={onSelect} />{f.suggestion ? <span className="iqi-dim"> — {f.suggestion}</span> : null}</li>)}
              </ul>
            )}
            {r.assumptions.length > 0 && (
              <div className="cp-assumptions" data-testid="cp-assumptions">
                <span className="iq-label">Please confirm</span>
                <ul>{r.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
            {r.questions.length > 0 && (
              <div className="cp-clarify" data-testid="cp-clarify">
                {r.questions.map((q, i) => <button key={i} type="button" className="iq-example cp-q" onClick={() => onAnswer(q)}><span className="iq-example-text">{q}</span><span className="iq-example-about">answer this</span></button>)}
              </div>
            )}
            {r.rejected.length > 0 && <p className="iq-warning" data-testid="cp-rejected"><Icon name="warning" size={12} /> {r.rejected.length} action{r.rejected.length === 1 ? "" : "s"} from the model {r.rejected.length === 1 ? "was" : "were"} not in a shape the Studio accepts and {r.rejected.length === 1 ? "was" : "were"} dropped.</p>}
            {r.actions.length > 0 && counts && (
              <div className="cp-counts" data-testid="cp-counts">
                {counts.map((c) => <span key={c.label} className="cp-count"><b>{c.value}</b> {c.label}</span>)}
              </div>
            )}
            {r.actions.length > 0 && state === "open" && (
              <div className="iq-actions">
                <button type="button" className="iq-btn" onClick={onReviewChanges} data-testid="cp-review-changes">Review changes</button>
                <span className="iq-spacer" />
                <button type="button" className="iq-btn" onClick={onCancel} data-testid="cp-cancel">Cancel</button>
                <button type="button" className="iq-btn primary" onClick={onApply} disabled={!canApply} title={applyTitle} data-testid="cp-apply">Apply changes</button>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/** text with the survey's question codes as links */
export function Linked({ text, def, onSelect }: { text: string; def: SurveyDefinition; onSelect(questionId: string): void }) {
  const segs = React.useMemo(() => linkify(text, def), [text, def]);
  return <>{segs.map((x, i) => ("questionId" in x ? <button key={i} type="button" className="cp-ref" onClick={() => onSelect(x.questionId)} data-testid="cp-ref" data-question={x.questionId}>{x.text}</button> : <React.Fragment key={i}>{x.text}</React.Fragment>))}</>;
}
