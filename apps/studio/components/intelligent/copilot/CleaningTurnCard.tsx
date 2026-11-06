"use client";
import React from "react";
import type { CleaningCard } from "./cleaningTurn";

/** a cleaning request's card (IM6): the proposal with each match's reasons, then Apply — and Undo once applied */
export function CleaningTurnCard({ card, onAction }: { card: CleaningCard; onAction?: (a: "apply" | "undo") => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const run = (a: "apply" | "undo") => async () => { setBusy(true); await onAction?.(a); setBusy(false); };
  return (
    <div className="cp-data cp-cleaning" data-testid="cp-cleaning" data-status={card.status} data-matches={card.matchCount}>
      <p className="iqi-dim" style={{ margin: "2px 0" }}><b>{card.title}</b></p>
      <ul className="iqi-dim" style={{ margin: "4px 0 0 16px" }}>{card.lines.filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {card.matches.length > 0 && card.status === "preview" && (
        <details style={{ marginTop: 4 }}>
          <summary className="iq-label">{card.matchCount} match{card.matchCount === 1 ? "" : "es"}{card.matchCount > card.matches.length ? ` (first ${card.matches.length} shown)` : ""}</summary>
          <ul style={{ margin: "4px 0 0 16px" }} data-testid="cp-cleaning-matches">{card.matches.slice(0, 50).map((m) => <li key={m.sessionId}><code>{m.sessionId.slice(0, 8)}</code> — {m.because.join("; ")}</li>)}</ul>
        </details>
      )}
      {card.status === "preview" && card.matchCount > 0 && <button type="button" className="iq-btn primary" disabled={busy || !onAction} data-testid="cp-cleaning-apply" onClick={run("apply")}>Apply to {card.matchCount} response{card.matchCount === 1 ? "" : "s"}</button>}
      {card.status === "applied" && <button type="button" className="iq-btn" disabled={busy || !onAction} data-testid="cp-cleaning-undo" onClick={run("undo")}>Undo this batch</button>}
      {card.error && <p className="iq-warning" data-testid="cp-cleaning-error">{card.error}</p>}
    </div>
  );
}
