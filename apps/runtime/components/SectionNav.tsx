"use client";
import React from "react";
import type { SectionEntry, SubmitGate } from "@rescript/engine";

/**
 * THE BUILT-IN SECTION NAVIGATOR (2026-10-30, engine sectionNav.ts).
 *
 * A `nav` landmark with one BUTTON per section (a jump is an action on the
 * interview, not a link to a URL), `aria-current="step"` on the section being
 * answered, and the state of each — visited, answered x of y, locked — in
 * words a screen reader reads, not only in colour. A locked section stays
 * focusable (`aria-disabled`, not `disabled`) so a click can say WHY it is
 * locked. Every decision is the engine's: this component only draws the
 * outline and passes the click to `onJump`.
 */
export function SectionNav({ outline, position, onJump, note, labels }: {
  outline: SectionEntry[];
  position: "top" | "side";
  onJump: (sectionId: string) => void;
  note?: string | null;
  labels?: { nav?: string; answered?: (a: number, t: number) => string; locked?: string; current?: string; visited?: string };
}) {
  if (outline.length < 2) return null;
  const answered = labels?.answered ?? ((a: number, t: number) => `${a} of ${t} answered`);
  return (
    <nav className={`rs-section-nav rs-section-nav-${position}`} aria-label={labels?.nav ?? "Sections"} data-testid="rs-section-nav" data-position={position}>
      <ol className="rs-section-nav-list">
        {outline.map((s) => {
          const state = s.current ? "current" : s.locked ? "locked" : s.visited ? "visited" : "open";
          return (
            <li key={s.id} className="rs-section-nav-li">
              <button
                type="button"
                className={`rs-section-nav-item is-${state}`}
                data-testid="rs-section-nav-item"
                data-section={s.id}
                data-state={state}
                aria-current={s.current ? "step" : undefined}
                aria-disabled={s.locked ? true : undefined}
                onClick={() => { if (!s.current) onJump(s.id); }}
              >
                <span className="rs-section-nav-title">{s.title}</span>
                <span className="rs-section-nav-count" data-testid="rs-section-nav-count">{answered(s.answered, s.total)}</span>
                <span className="rs-visually-hidden">
                  {s.current ? ` — ${labels?.current ?? "current section"}` : s.locked ? ` — ${labels?.locked ?? "locked"}` : s.visited ? ` — ${labels?.visited ?? "visited"}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {note ? <p className="rs-section-nav-note" role="status" data-testid="rs-section-nav-note">{note}</p> : <p className="rs-section-nav-note" role="status" aria-live="polite" />}
    </nav>
  );
}

/**
 * THE SUBMIT GATE (free navigation): what is missing, per section, each with
 * a button that goes there — or, for an assessment, "N unanswered — submit
 * anyway?" with the choice to submit or go back.
 */
export function SubmitGatePanel({ gate, onGo, onConfirm, onCancel }: {
  gate: SubmitGate;
  onGo: (pageId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => { ref.current?.focus(); }, [gate]);
  return (
    <div ref={ref} tabIndex={-1} className="rs-submit-gate" role="alertdialog" aria-labelledby="rs-submit-gate-title" data-testid="rs-submit-gate"
      data-kind={gate.needsConfirm ? "confirm" : "refuse"}>
      <p id="rs-submit-gate-title" className="rs-submit-gate-title">{gate.message}</p>
      {(gate.bySection.length > 0 || gate.invalid.length > 0) && (
        <ul className="rs-submit-gate-list">
          {gate.bySection.map((g) => (
            <li key={g.sectionId ?? g.firstPageId}>
              <button type="button" className="rs-submit-gate-go" data-testid="rs-submit-gate-go" data-page={g.firstPageId} data-section={g.sectionId ?? ""} onClick={() => onGo(g.firstPageId)}>
                {g.sectionTitle}: {g.count} unanswered
              </button>
            </li>
          ))}
          {gate.invalid.map((m) => (
            <li key={`${m.pageId}:${m.questionId}`}>
              <button type="button" className="rs-submit-gate-go" data-testid="rs-submit-gate-go" data-page={m.pageId} onClick={() => onGo(m.pageId)}>
                {m.sectionTitle}: {m.code ?? m.questionId} — {m.message}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rs-submit-gate-actions">
        {gate.needsConfirm ? (
          <>
            <button type="button" className="rs-btn secondary" data-testid="rs-submit-gate-cancel" onClick={onCancel}>Review answers</button>
            <button type="button" className="rs-btn" data-testid="rs-submit-gate-confirm" onClick={onConfirm}>Submit anyway</button>
          </>
        ) : (
          <button type="button" className="rs-btn secondary" data-testid="rs-submit-gate-cancel" onClick={onCancel}>Close</button>
        )}
      </div>
    </div>
  );
}
