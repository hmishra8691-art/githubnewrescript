"use client";
/**
 * WHERE A BLOCK GOES (2026-11-12) — one dialog for "Add block at…" and "Move block…".
 *
 * The place is chosen from the same list either way (engine `blockPositionChoices`): the beginning of the survey,
 * before or after any block, or the end. For a MOVE the dialog shows, before anything changes, the order the survey
 * would have and what the move would break (engine `previewBlockMove`): a question that would read an answer asked
 * after it — display logic, skip logic, piping, carry-forward, auto-punch — and any page-structure finding. Moving
 * only changes where the block sits; its questions, ids, variables, logic, quotas and randomization are untouched.
 */
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { blockPositionChoices, previewBlockMove, type BlockPosition } from "@rescript/engine";

export type BlockPlacementRequest = { mode: "add" } | { mode: "move"; blockId: string; title: string };

export function BlockPlacementDialog({ def, request, onCancel, onAdd, onMove }: {
  def: SurveyDefinition;
  request: BlockPlacementRequest;
  onCancel(): void;
  onAdd(title: string, position: BlockPosition): void;
  onMove(blockId: string, position: BlockPosition): void;
}) {
  const moving = request.mode === "move" ? request.blockId : undefined;
  const choices = React.useMemo(() => blockPositionChoices(def, moving), [def, moving]);
  const [pick, setPick] = React.useState(choices.length - 1);
  const [title, setTitle] = React.useState("");
  const position = choices[Math.min(pick, choices.length - 1)]?.position ?? { at: "end" as const };
  const preview = React.useMemo(() => (moving ? previewBlockMove(def, moving, position) : null), [def, moving, position]);

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={request.mode === "add" ? "Add a block" : "Move block"}
        onClick={(e) => e.stopPropagation()} data-testid="block-placement-dialog" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>{request.mode === "add" ? "Add a block" : `Move “${request.title}”`}</h3>

        {request.mode === "add" && (
          <label className="field" style={{ display: "block", marginBottom: 12 }}>
            <span className="flabel">Block name (optional)</span>
            <input className="input" autoFocus value={title} maxLength={160} data-testid="block-placement-title"
              placeholder="e.g. Screener" onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}

        <label className="field" style={{ display: "block" }}>
          <span className="flabel">{request.mode === "add" ? "Where should it go?" : "Move it to"}</span>
          <select className="input" value={pick} data-testid="block-placement-position" onChange={(e) => setPick(Number(e.target.value))}>
            {choices.map((c, i) => <option key={i} value={i}>{c.label}</option>)}
          </select>
        </label>

        {preview && (
          <div style={{ marginTop: 14 }} data-testid="block-move-preview">
            <div className="flabel" style={{ marginBottom: 4 }}>Order after the move</div>
            {!preview.ok ? (
              <div className="alert" data-testid="block-move-error">{preview.error}</div>
            ) : (
              <ol className="tc-list" style={{ maxHeight: 220, overflow: "auto", paddingLeft: 22 }}>
                {preview.after.map((b) => (
                  <li key={b.id} data-moved={b.moved ? "1" : undefined} style={b.moved ? { fontWeight: 600 } : undefined}>
                    {b.title} <span className="muted" style={{ fontWeight: 400 }}>· {b.questions} question{b.questions === 1 ? "" : "s"}{b.moved ? " · moved" : ""}</span>
                  </li>
                ))}
              </ol>
            )}
            {preview.ok && preview.unchanged && <p className="muted" style={{ fontSize: 12.5 }} data-testid="block-move-unchanged">The block is already there.</p>}
            {preview.ok && preview.conflicts.length > 0 && (
              <div className="alert" style={{ marginTop: 10, fontSize: 12.5 }} data-testid="block-move-conflicts">
                <b>{preview.conflicts.length} thing{preview.conflicts.length === 1 ? "" : "s"} this order would break:</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {preview.conflicts.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
                <div style={{ marginTop: 6 }}>You can still move it — the logic is kept as written — but fix these before fielding.</div>
              </div>
            )}
            {preview.ok && !preview.unchanged && preview.conflicts.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5 }} data-testid="block-move-clean">No logic, piping or carry-forward is broken by this order. Question ids, variables, quotas and randomization stay as they are.</p>
            )}
          </div>
        )}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn" data-testid="block-placement-cancel" onClick={onCancel}>Cancel</button>
          {request.mode === "add" ? (
            <button className="btn primary" data-testid="block-placement-confirm" onClick={() => onAdd(title.trim(), position)}>Add block</button>
          ) : (
            <button className={`btn ${preview?.conflicts.length ? "danger" : "primary"}`} data-testid="block-placement-confirm"
              disabled={!preview?.ok || !!preview.unchanged} onClick={() => onMove(request.blockId, position)}>
              {preview?.conflicts.length ? "Move anyway" : "Move block"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
