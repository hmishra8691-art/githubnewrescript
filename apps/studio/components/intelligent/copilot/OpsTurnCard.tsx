"use client";
import React from "react";
import type { HandOver, OpsCard, OpsQuestion } from "./opsTurn";

export type OpsAction = { kind: "confirm" } | { kind: "answer"; question: OpsQuestion; header: string } | { kind: "noted" } | { kind: "open" };

/**
 * A research-operations request's card (2026-11-22): what was understood, what each column of the file is and why,
 * what needs a look, the steps with the reason for each, and one Confirm button. After it ran: what happened at each
 * step, what was not done and why, and what to do next. Sign-in links for people with no email address arrive
 * separately (`handOver`), are shown once, and are never part of the remembered card.
 */
export function OpsTurnCard({ card, handOver, onAction }: { card: OpsCard; handOver?: HandOver[]; onAction?: (a: OpsAction) => Promise<void> | void }) {
  const [busy, setBusy] = React.useState(false);
  const run = (a: OpsAction) => async () => { setBusy(true); try { await onAction?.(a); } finally { setBusy(false); } };
  const mark = { todo: "○", done: "✓", skipped: "–", failed: "✕" } as const;
  return (
    <div className="cp-data cp-ops" data-testid="cp-ops" data-status={card.status} data-op={card.request.op}>
      <p className="iqi-dim" style={{ margin: "2px 0" }}><b data-testid="cp-ops-title">{card.title}</b></p>
      {card.lines.length > 0 && <ul className="iqi-dim" style={{ margin: "4px 0 0 16px" }} data-testid="cp-ops-lines">{card.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}

      {card.columns && card.columns.length > 0 && card.status !== "done" && (
        <details style={{ marginTop: 6 }} open data-testid="cp-ops-columns">
          <summary className="iq-label">How I read the {card.columns.length} columns{card.fileName ? ` of ${card.fileName}` : ""}</summary>
          <table style={{ width: "100%", fontSize: 12.5, marginTop: 4, borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Column in your file</th><th>Used as</th><th>Because</th></tr></thead>
            <tbody>{card.columns.map((c) => <tr key={c.header} data-testid={`cp-ops-col-${c.header}`}><td className="mono">{c.header}</td><td><b>{c.target}</b></td><td className="iqi-dim">{c.why}</td></tr>)}</tbody>
          </table>
        </details>
      )}

      {(card.questions ?? []).map((q) => (
        <label key={q.field} className="iq-warning" style={{ display: "block", marginTop: 6 }} data-testid={`cp-ops-question-${q.field}`}>
          <span>{q.ask}</span>
          <select className="select" style={{ display: "block", marginTop: 4, maxWidth: 320 }} value={q.chosen ?? ""} disabled={busy || !onAction || card.status === "running"}
            onChange={(e) => { if (e.target.value) void run({ kind: "answer", question: q, header: e.target.value })(); }}>
            {q.chosen === null && <option value="">Choose a column…</option>}
            {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ))}

      {card.problems && card.problems.length > 0 && card.status !== "done" && (
        <details style={{ marginTop: 6 }} open data-testid="cp-ops-problems">
          <summary className="iq-label">What needs a look ({card.problemCount ?? card.problems.length})</summary>
          <ul className="iqi-dim" style={{ margin: "4px 0 0 16px" }}>{card.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          {(card.problemCount ?? 0) > card.problems.length && <p className="iqi-dim" style={{ margin: "2px 0 0 16px" }}>…and {(card.problemCount ?? 0) - card.problems.length} more. The full list is in Distribution → Add people.</p>}
        </details>
      )}

      {card.changes && card.changes.length > 0 && (
        <table style={{ width: "100%", fontSize: 12.5, marginTop: 6, borderCollapse: "collapse" }} data-testid="cp-ops-changes">
          <thead><tr style={{ textAlign: "left" }}><th>Setting</th><th>Now</th><th>After</th></tr></thead>
          <tbody>{card.changes.map((c) => (
            <tr key={c.key} data-testid={`cp-ops-change-${c.key}`}><td>{c.label}{c.note && <div className="iq-warning" style={{ fontSize: 12 }}>{c.note}</div>}</td><td className="iqi-dim">{c.from}</td><td><b>{c.to}</b></td></tr>
          ))}</tbody>
        </table>
      )}

      {card.plan.length > 0 && (
        <ol style={{ margin: "8px 0 0", padding: 0, listStyle: "none", fontSize: 12.5 }} data-testid="cp-ops-plan">
          {card.plan.map((p) => (
            <li key={p.key} data-step={p.key} data-state={p.state} style={{ margin: "3px 0" }}>
              <span aria-hidden="true">{mark[p.state]} </span><b>{p.step}</b>
              <span className="iqi-dim"> — {p.result ?? p.why}</span>
            </li>
          ))}
        </ol>
      )}

      {card.guide && (
        <div style={{ marginTop: 6, fontSize: 12.5 }} data-testid="cp-ops-guide">
          <p style={{ margin: "2px 0" }}><span className="iq-label">Where</span> {card.guide.where.join(" → ")}</p>
          {card.guide.whyGuided && <p className="iqi-dim" style={{ margin: "2px 0" }}><span className="iq-label">Why I do not do this for you</span> {card.guide.whyGuided}</p>}
          {card.guide.needs.length > 0 && <p className="iqi-dim" style={{ margin: "2px 0" }}><span className="iq-label">Needs</span> {card.guide.needs.join("; ")}</p>}
          <ol style={{ margin: "4px 0 0 18px" }}>{card.guide.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <p className="iqi-dim" style={{ margin: "4px 0 0" }}><span className="iq-label">Afterwards</span> {card.guide.then}</p>
        </div>
      )}

      {card.capabilities && (
        <div style={{ marginTop: 6, fontSize: 12.5 }} data-testid="cp-ops-capabilities">
          <p className="iq-label" style={{ margin: "2px 0" }}>I carry these out, after you confirm</p>
          <ul style={{ margin: "2px 0 0 16px" }}>{card.capabilities.filter((c) => c.agent === "does").map((c) => <li key={c.name}><b>{c.name}</b> <span className="iqi-dim">— “{c.say}”</span></li>)}</ul>
          <p className="iq-label" style={{ margin: "6px 0 2px" }}>I tell you where and why</p>
          <ul style={{ margin: "2px 0 0 16px" }}>{card.capabilities.filter((c) => c.agent === "guides").map((c) => <li key={c.name}><b>{c.name}</b> <span className="iqi-dim">— “{c.say}”</span></li>)}</ul>
        </div>
      )}

      {(card.notes ?? []).map((n, i) => <p key={i} className="iq-warning" style={{ margin: "4px 0 0" }} data-testid="cp-ops-note">{n}</p>)}

      {handOver && handOver.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--c-warning-fg, #b45309)", borderRadius: 8 }} data-testid="cp-ops-handover">
          <b style={{ fontSize: 12.5 }}>Hand these over now. They are shown once and are not stored readable.</b>
          <table style={{ width: "100%", fontSize: 12.5, marginTop: 4 }}>
            <thead><tr style={{ textAlign: "left" }}><th>Name</th><th>Respondent ID</th><th>Sign-in link</th></tr></thead>
            <tbody>{handOver.map((h) => <tr key={h.id}><td>{h.name ?? "—"}</td><td className="mono">{h.respondentId}</td><td className="mono" style={{ wordBreak: "break-all" }}>{h.password ? `Password: ${h.password}` : h.link}</td></tr>)}</tbody>
          </table>
          <button type="button" className="iq-btn" style={{ marginTop: 4 }} onClick={run({ kind: "noted" })} data-testid="cp-ops-noted">I have noted them</button>
        </div>
      )}

      {card.next && <p style={{ margin: "6px 0 0", fontSize: 12.5 }} data-testid="cp-ops-next"><span className="iq-label">Next</span> {card.next}</p>}
      {card.error && <p className="iq-warning" data-testid="cp-ops-error">{card.error}</p>}

      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {card.confirm && (card.status === "preview" || card.status === "running") && <button type="button" className="iq-btn primary" disabled={busy || !onAction || card.status === "running"} onClick={run({ kind: "confirm" })} data-testid="cp-ops-confirm">{card.status === "running" ? "Working…" : card.confirm}</button>}
        {card.goTo && onAction && <button type="button" className="iq-btn" onClick={run({ kind: "open" })} data-testid="cp-ops-open">Open Distribution</button>}
      </div>
    </div>
  );
}
