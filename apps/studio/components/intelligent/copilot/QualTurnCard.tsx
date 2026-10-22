"use client";
import React from "react";
import type { QualCard } from "./qualTurn";

/** a qualitative request's card (2026-10-22): the preview, then Run — nothing happens on the sentence alone */
export function QualTurnCard({ card, onRun }: { card: QualCard; onRun?: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="cp-data cp-qual" data-testid="cp-qual" data-op={card.request.op} data-status={card.status} data-calls={card.calls}>
      <p className="iqi-dim" style={{ margin: "2px 0" }}><b>{card.title}</b></p>
      <ul className="iqi-dim" style={{ margin: "4px 0 0 16px" }} data-testid="cp-qual-lines">{card.lines.filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {/* a run that failed (the server went away, a refusal) can be run again from the same preview */}
      {(card.status === "preview" || card.status === "failed") && card.runnable && <button type="button" className="iq-btn primary" disabled={busy || !onRun} data-testid="cp-qual-run" onClick={async () => { setBusy(true); await onRun?.(); setBusy(false); }}>{card.status === "failed" ? "Try again" : card.runLabel ?? "Run"}{card.calls ? ` · ${card.calls} model call${card.calls === 1 ? "" : "s"}` : ""}</button>}
      {card.status === "running" && <span className="iq-label">Working…</span>}
      {card.result && <ul style={{ margin: "6px 0 0 16px" }} data-testid="cp-qual-result">{card.result.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {card.quotes && card.quotes.length > 0 && <div data-testid="cp-qual-quotes">{card.quotes.slice(0, 5).map((q) => <blockquote key={q.id} className="iqi-dim" style={{ margin: "4px 0" }}>“{q.quote}” — {q.where} [{q.id}]</blockquote>)}</div>}
      {card.error && <p className="iq-warning" data-testid="cp-qual-error">{card.error}</p>}
    </div>
  );
}
