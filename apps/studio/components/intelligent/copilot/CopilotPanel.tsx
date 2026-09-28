"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { structureRows, changeLabel, type OutlineRow } from "../../../lib/copilot/client";
import { Linked } from "./CopilotCard";
import type { Copilot, PanelTab } from "./useCopilot";

/**
 * THE RIGHT-HAND PANEL of the copilot workspace (the copilot brief §10, §12,
 * §17, §18):
 *
 *   Changes    exactly what the open proposal will do — the change list, the
 *              destructive part behind a confirmation, what was refused and
 *              why, what the result newly breaks, the structure before and
 *              after, and field-by-field changes to existing questions
 *   Review     findings grouped Critical / Warning / Suggestion — the
 *              engine's checks and the model's reading — each linked to its
 *              questions, mechanical fixes offered as a preview
 *   Research   the uploaded documents and their research cards
 *   History    AI Change #001 … with what each created, modified and
 *              removed, and Undo for the whole operation
 *   Inspector  the object in focus (the existing inspector)
 */
export function CopilotPanel({ copilot, def, onSelect, inspector, onApply, applyNote, readOnly }: {
  copilot: Copilot;
  def: SurveyDefinition;
  onSelect(questionId: string): void;
  inspector: React.ReactNode;
  onApply(): void;
  applyNote: string | null;
  readOnly: boolean;
}) {
  const tabs: { id: PanelTab; label: string; badge?: number }[] = [
    { id: "changes", label: "Changes", badge: copilot.state ? copilot.state.diff.summary.length : undefined },
    { id: "review", label: "Review", badge: copilot.review ? copilot.review.rules.counts.critical + copilot.review.ai.filter((f) => f.severity === "critical").length || undefined : undefined },
    { id: "research", label: "Research", badge: copilot.docs.length || undefined },
    { id: "history", label: "History", badge: copilot.history.filter((h) => !h.reverted).length || undefined },
    { id: "inspector", label: "Inspector" },
  ];
  return (
    <aside className="iq-inspector cp-panel" data-testid="cp-panel" data-tab={copilot.tab}>
      <div className="cp-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={copilot.tab === t.id} className={`cp-tab${copilot.tab === t.id ? " on" : ""}`} onClick={() => copilot.setTab(t.id)} data-testid={`cp-tab-${t.id}`}>
            {t.label}{t.badge ? <span className="cp-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="cp-panel-body">
        {copilot.tab === "changes" && <ChangesTab copilot={copilot} def={def} onSelect={onSelect} onApply={onApply} applyNote={applyNote} readOnly={readOnly} />}
        {copilot.tab === "review" && <ReviewTab copilot={copilot} def={def} onSelect={onSelect} />}
        {copilot.tab === "research" && <ResearchTab copilot={copilot} />}
        {copilot.tab === "history" && <HistoryTab copilot={copilot} readOnly={readOnly} />}
        {copilot.tab === "inspector" && inspector}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------ changes */

function ChangesTab({ copilot, onSelect, onApply, applyNote, readOnly }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void; onApply(): void; applyNote: string | null; readOnly: boolean }) {
  const st = copilot.state;
  const p = copilot.proposal;
  const [view, setView] = React.useState<"after" | "both">("after");
  if (!p || !st) return <p className="cp-empty" data-testid="cp-no-proposal">No change is proposed. Ask the copilot for one — “create a survey to test my hypothesis”, “add a question measuring brand trust”, “randomize the brands” — and it appears here, exactly, before anything is written.</p>;
  const beforeRows = structureRows(p.base, st.diff, "before");
  const afterRows = structureRows(st.after, st.diff, "after");
  const blocked = (st.destructive.length > 0 && !copilot.confirmed) || st.diff.empty || readOnly;
  return (
    <div className="cp-changes" data-testid="cp-changes">
      <div className="iq-label">The copilot wants to make these changes</div>
      {p.steps.length > 1 && <p className="iqi-dim" data-testid="cp-steps">{p.steps.length} requests: {p.steps.map((x) => `“${x.request.slice(0, 50)}”`).join(" → ")}</p>}
      <ul className="cp-summary" data-testid="cp-summary">{st.diff.summary.map((l, i) => <li key={i}><Linked text={l} def={st.after} onSelect={onSelect} /></li>)}</ul>
      {copilot.stale && <p className="iq-warning" data-testid="cp-stale"><Icon name="warning" size={12} /> The survey changed since this was proposed; Apply replays it onto the current survey first.</p>}
      {st.errors.length > 0 && (
        <div className="cp-block err" data-testid="cp-refused">
          <div className="iq-label">Not possible — {st.errors.length} action{st.errors.length === 1 ? "" : "s"} refused</div>
          <ul>{st.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {p.base.meta.status === "live" && (st.diff.questionsModified.length > 0 || st.diff.questionsRemoved.length > 0) && (
        <p className="iq-error" data-testid="cp-live-warning"><Icon name="warning" size={12} /> This survey is live. Changing or removing questions that already have answers affects the data you have collected — nothing here touches the responses themselves, and nothing is published until you deploy again.</p>
      )}
      {st.destructive.length > 0 && (
        <div className="cp-block danger" data-testid="cp-destructive">
          <div className="iq-label">Removes or rewrites existing content</div>
          <ul>{st.destructive.map((e, i) => <li key={i}><Linked text={e} def={p.base} onSelect={onSelect} /></li>)}</ul>
          <label className="cp-confirm"><input type="checkbox" checked={copilot.confirmed} onChange={(e) => copilot.setConfirmed(e.target.checked)} data-testid="cp-confirm" /> I understand — apply these {st.destructive.length} change{st.destructive.length === 1 ? "" : "s"} too (undoable)</label>
        </div>
      )}
      {st.warnings.length > 0 && (
        <div className="cp-block warn" data-testid="cp-new-problems">
          <div className="iq-label">The result would have {st.warnings.length} new problem{st.warnings.length === 1 ? "" : "s"}</div>
          <ul>{st.warnings.map((e, i) => <li key={i}><Linked text={e} def={st.after} onSelect={onSelect} /></li>)}</ul>
        </div>
      )}
      <div className="cp-structure-head">
        <span className="iq-label">Structure</span>
        <span className="iq-spacer" />
        <button type="button" className={`iq-btn${view === "after" ? " on" : ""}`} onClick={() => setView("after")}>After</button>
        <button type="button" className={`iq-btn${view === "both" ? " on" : ""}`} onClick={() => setView("both")} data-testid="cp-before-after">Before / after</button>
      </div>
      <div className={`cp-structure${view === "both" ? " two" : ""}`} data-testid="cp-structure">
        {view === "both" && <Outline rows={beforeRows} title="Before" onSelect={onSelect} def={p.base} />}
        <Outline rows={afterRows} title={view === "both" ? "After" : undefined} onSelect={onSelect} def={st.after} />
      </div>
      {st.diff.questionsModified.length > 0 && (
        <div className="cp-block" data-testid="cp-modified">
          <div className="iq-label">Changes to existing questions</div>
          <table className="iqi-table">
            <tbody>
              {st.diff.questionsModified.flatMap((m) => m.changes.map((c, i) => (
                <tr key={`${m.id}${i}`}><td>{i === 0 ? <button type="button" className="cp-ref" onClick={() => onSelect(m.id)}>{m.code}</button> : null}</td><td className="iqi-dim">{c.field}</td><td><span className="cp-from">{c.from || "—"}</span> → <span className="cp-to">{c.to || "—"}</span></td></tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {applyNote && <p className="iq-warning" data-testid="cp-apply-note"><Icon name="info" size={12} /> {applyNote}</p>}
      <div className="iq-actions">
        <button type="button" className="iq-btn" onClick={copilot.cancel} data-testid="cp-panel-cancel">Cancel</button>
        <span className="iq-spacer" />
        <button type="button" className="iq-btn primary" onClick={onApply} disabled={blocked} data-testid="cp-panel-apply" title={readOnly ? "Read-only" : st.destructive.length && !copilot.confirmed ? "Confirm the destructive changes first" : "Apply as one undoable change"}>Apply changes</button>
      </div>
    </div>
  );
}

function Outline({ rows, title, onSelect, def }: { rows: OutlineRow[]; title?: string; onSelect(id: string): void; def: SurveyDefinition }) {
  return (
    <div className="cp-outline" data-testid={title ? `cp-outline-${title.toLowerCase()}` : "cp-outline"}>
      {title && <div className="iq-label">{title}</div>}
      {rows.length === 0 && <p className="iqi-dim">(empty)</p>}
      {rows.map((r) => r.kind === "block"
        ? <div key={r.id} className={`cp-o-block${r.mark ? ` m-${r.mark}` : ""}`} data-mark={r.mark ?? ""}>{r.label}</div>
        : <button key={r.id} type="button" className={`cp-o-q${r.mark ? ` m-${r.mark}` : ""}`} data-mark={r.mark ?? ""} onClick={() => def.questions.some((q) => q.id === r.id) && onSelect(r.id)} data-testid="cp-o-q">{r.label}{r.mark ? <span className="cp-mark">{r.mark}</span> : null}</button>)}
    </div>
  );
}

/* ------------------------------------------------------------ review */

function ReviewTab({ copilot, def, onSelect }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void }) {
  const rv = copilot.review;
  if (!rv) return (
    <div className="cp-empty">
      <p>Ask for a review — “review my survey” — or press Review. The engine checks the logic, reachability, options, scales, duplicates and length at once; the copilot reads for research alignment, hypothesis coverage, wording and bias.</p>
      <button type="button" className="iq-btn primary" onClick={() => void copilot.runReview()} data-testid="cp-run-review">Review the survey</button>
    </div>
  );
  const byCode = new Map(def.questions.map((q) => [String(q.code).toUpperCase(), q.id]));
  const all = [
    ...rv.rules.findings.map((f) => ({ severity: f.severity, message: f.message, suggestion: f.suggestion, questionIds: f.questionIds, fix: f.fix, source: "engine" as const })),
    ...rv.ai.map((f) => ({ severity: f.severity, message: f.message, suggestion: f.suggestion, questionIds: f.questions.map((c) => byCode.get(c.toUpperCase())).filter((x): x is string => !!x), fix: undefined as SurveyAction[] | undefined, source: "copilot" as const })),
  ];
  const groups = (["critical", "warning", "suggestion"] as const).map((sv) => ({ sv, items: all.filter((f) => f.severity === sv) }));
  return (
    <div className="cp-review" data-testid="cp-review">
      <div className="cp-review-head">
        <span className="iqi-dim">{rv.rules.questions} questions · about {rv.rules.minutes} min{rv.running ? " · the copilot is reading…" : ""}</span>
        <span className="iq-spacer" />
        <button type="button" className="iq-btn" onClick={() => void copilot.runReview()} data-testid="cp-rerun-review">Review again</button>
      </div>
      {groups.map(({ sv, items }) => (
        <section key={sv} data-testid={`cp-review-${sv}`}>
          <div className={`iq-label cp-sev-head v-${sv}`}>{sv === "critical" ? "Critical" : sv === "warning" ? "Warning" : "Suggestion"} · {items.length}</div>
          {items.length === 0 && <p className="iqi-dim">None.</p>}
          <ul className="cp-review-list">
            {items.map((f, i) => (
              <li key={i} data-severity={f.severity} data-source={f.source} data-testid="cp-finding">
                <Linked text={f.message} def={def} onSelect={onSelect} />
                {f.suggestion && <div className="iqi-dim">→ {f.suggestion}</div>}
                <div className="cp-finding-foot">
                  <span className="cp-src">{f.source}</span>
                  {f.questionIds.slice(0, 6).map((id) => { const q = def.questions.find((x) => x.id === id); return q ? <button key={id} type="button" className="iq-chip" onClick={() => onSelect(id)}>{q.code}</button> : null; })}
                  {f.fix && <button type="button" className="iq-btn" onClick={() => copilot.previewFix(f.fix!, `Fix: ${f.message.slice(0, 60)}`)} data-testid="cp-preview-fix">Preview fix</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ research */

function ResearchTab({ copilot }: { copilot: Copilot }) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div className="cp-research" data-testid="cp-research">
      <div className="cp-review-head">
        <span className="iqi-dim">{copilot.docs.length} document{copilot.docs.length === 1 ? "" : "s"} · the copilot reads only the passages a request needs</span>
        <span className="iq-spacer" />
        <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.xlsx" onChange={(e) => { void copilot.uploadDocs([...(e.target.files ?? [])]); e.target.value = ""; }} data-testid="cp-doc-file" />
        <button type="button" className="iq-btn" onClick={() => input.current?.click()} disabled={copilot.uploading} data-testid="cp-add-docs"><Icon name="paperclip" size={12} /> {copilot.uploading ? "Reading…" : "Add documents"}</button>
      </div>
      {!copilot.durable && copilot.docs.length > 0 && <p className="iq-warning" data-testid="cp-not-durable"><Icon name="info" size={12} /> Documents are kept for this session only (the research store is not set up on this installation).</p>}
      {copilot.docError && <p className="iq-error" data-testid="cp-doc-error"><Icon name="warning" size={12} /> {copilot.docError}</p>}
      {copilot.uploading && <div className="iq-thinking"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
      {copilot.docs.length === 0 && !copilot.uploading && <p className="cp-empty">Attach papers, literature reviews, reports, client briefs or methodology notes (PDF — scanned pages are read by OCR — Word, text, CSV, Excel). Each is summarised once; then ask “based on the literature, …”.</p>}
      {copilot.docs.map((d) => (
        <details key={d.id} className="cp-doc" data-testid="cp-doc" open={copilot.docs.length <= 2}>
          <summary>
            <span className="mono cp-doc-ref">{d.ref}</span> <b>{d.name}</b> <span className="iqi-dim">{d.summary?.type ?? d.format} · {d.pages} page{d.pages === 1 ? "" : "s"}{d.ocrPages ? ` · ${d.ocrPages} by OCR` : ""}</span>
            <button type="button" className="cp-x" onClick={(e) => { e.preventDefault(); void copilot.deleteDoc(d.id); }} title="Remove this document" data-testid="cp-doc-delete">×</button>
          </summary>
          {d.summary?.summary && <p>{d.summary.summary}</p>}
          {d.summary && (
            <dl className="cp-card-dl">
              {([["Objectives", d.summary.objectives], ["Hypotheses", d.summary.hypotheses], ["Findings", d.summary.findings], ["Gaps", d.summary.gaps], ["Question areas", d.summary.questionAreas]] as const).filter(([, xs]) => xs.length).map(([k, xs]) => (
                <React.Fragment key={k}><dt>{k}</dt><dd>{xs.map((x) => x.text).join(" · ")}</dd></React.Fragment>
              ))}
              {d.summary.constructs.length > 0 && <><dt>Constructs</dt><dd>{d.summary.constructs.map((c) => c.name).join(" · ")}</dd></>}
              {d.summary.scales.length > 0 && <><dt>Scales</dt><dd>{d.summary.scales.map((c) => `${c.name}${c.items ? ` (${c.items} items${c.points ? `, ${c.points}-pt` : ""})` : ""}`).join(" · ")}</dd></>}
            </dl>
          )}
          {d.warnings.map((w, i) => <p key={i} className="iqi-dim"><Icon name="info" size={11} /> {w}</p>)}
        </details>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ history */

function HistoryTab({ copilot, readOnly }: { copilot: Copilot; readOnly: boolean }) {
  const [warn, setWarn] = React.useState<{ n: number; reason: string } | null>(null);
  if (!copilot.history.length) return <p className="cp-empty" data-testid="cp-no-history">Every change you apply from the copilot is listed here — what it created, modified and removed — and can be undone as one operation.</p>;
  return (
    <div className="cp-history" data-testid="cp-history">
      {[...copilot.history].reverse().map((h) => (
        <div key={h.n} className={`cp-change${h.reverted ? " reverted" : ""}`} data-testid="cp-change" data-n={h.n}>
          <div className="cp-change-head">
            <b>{changeLabel(h.n)}</b>
            <span className="iqi-dim">{new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="iq-spacer" />
            {h.reverted ? <span className="iqi-dim">undone</span> : <button type="button" className="iq-btn" disabled={readOnly} onClick={() => { const r = copilot.revert(h.n); if (!r.ok && r.reason) setWarn({ n: h.n, reason: r.reason }); else setWarn(null); }} data-testid="cp-undo-change">Undo</button>}
          </div>
          <p className="iqi-dim cp-change-req">“{h.request.slice(0, 160)}”</p>
          {h.created.length > 0 && <div><span className="iq-label">Created</span> {h.created.join(", ")}</div>}
          {h.modified.length > 0 && <div><span className="iq-label">Modified</span> {h.modified.join(", ")}</div>}
          {h.removed.length > 0 && <div><span className="iq-label">Removed</span> {h.removed.join(", ")}</div>}
          {warn?.n === h.n && (
            <div className="cp-block warn" data-testid="cp-revert-warning">
              <p>{warn.reason}</p>
              <button type="button" className="iq-btn" onClick={() => { copilot.revert(h.n, true); setWarn(null); }} data-testid="cp-revert-anyway">Restore to before {changeLabel(h.n)}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
