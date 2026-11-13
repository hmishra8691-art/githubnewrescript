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
import { blockDestinations, previewBlockMove, type BlockPosition } from "@rescript/engine";

export type BlockPlacementRequest = { mode: "add" } | { mode: "move"; blockId: string; title: string };

export function BlockPlacementDialog({ def, request, onCancel, onAdd, onMove }: {
  def: SurveyDefinition;
  request: BlockPlacementRequest;
  onCancel(): void;
  onAdd(title: string, position: BlockPosition): void;
  onMove(blockId: string, position: BlockPosition): void;
}) {
  const moving = request.mode === "move" ? request.blockId : undefined;
  /*
   * 2026-11-14: HOW, THEN WHICH. The picker used to list "Before X" and "After X" for every block in one long menu
   * (two lines per block, unreadable in a large survey). Now: where — beginning, before a block, after a block, end —
   * and, for before / after, which block, each listed ONCE with its number, name and size. A destination that would
   * leave the block where it is is not offered, and the block itself is never one (engine `blockDestinations`).
   */
  const dest = React.useMemo(() => blockDestinations(def, moving), [def, moving]);
  type How = "start" | "before" | "after" | "end";
  const hows: { value: How; label: string; ok: boolean }[] = [
    { value: "start", label: "At the beginning of the survey", ok: dest.start },
    { value: "before", label: "Before a block…", ok: dest.blocks.some((b) => b.before) },
    { value: "after", label: "After a block…", ok: dest.blocks.some((b) => b.after) },
    { value: "end", label: "At the end of the survey", ok: dest.end },
  ];
  const [how, setHow] = React.useState<How>(() => (request.mode === "add" ? "end" : hows.find((h) => h.ok && (h.value === "before" || h.value === "after"))?.value ?? hows.find((h) => h.ok)?.value ?? "end"));
  const candidates = dest.blocks.filter((b) => (how === "before" ? b.before : how === "after" ? b.after : false));
  const [ref, setRef] = React.useState<string>("");
  const [find, setFind] = React.useState("");
  const refId = candidates.some((b) => b.id === ref) ? ref : candidates[0]?.id ?? "";
  const [title, setTitle] = React.useState("");
  const position: BlockPosition = how === "start" || how === "end" ? { at: how } : { at: how, block: refId };
  const valid = how === "start" || how === "end" ? hows.find((h) => h.value === how)!.ok || request.mode === "add" : !!refId;
  const preview = React.useMemo(() => (moving && valid ? previewBlockMove(def, moving, position) : null), [def, moving, how, refId, valid]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (b: { number: number; title: string; questions: number }) => `Block ${b.number}${b.title ? ` — ${b.title}` : ""} · ${b.questions} question${b.questions === 1 ? "" : "s"}`;
  const f = find.trim().toLowerCase();
  const listed = f ? candidates.filter((b) => name(b).toLowerCase().includes(f)) : candidates;

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

        <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label className="field" style={{ display: "block", flex: "1 1 220px" }}>
            <span className="flabel">{request.mode === "add" ? "Where should it go?" : "Move it"}</span>
            <select className="input" value={how} data-testid="block-placement-how" onChange={(e) => setHow(e.target.value as How)}>
              {hows.filter((h) => h.ok || request.mode === "add").map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
          </label>
          {(how === "before" || how === "after") && (
            <label className="field" style={{ display: "block", flex: "2 1 280px" }}>
              <span className="flabel">Which block</span>
              {candidates.length > 12 && (
                <input className="input" style={{ marginBottom: 4 }} placeholder="Find a block by number or name…" value={find} data-testid="block-placement-find" onChange={(e) => setFind(e.target.value)} />
              )}
              <select className="input" value={listed.some((b) => b.id === refId) ? refId : listed[0]?.id ?? ""} data-testid="block-placement-block" onChange={(e) => setRef(e.target.value)}>
                {listed.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
              </select>
            </label>
          )}
        </div>
        {request.mode === "move" && !hows.some((h) => h.ok) && <p className="muted" style={{ fontSize: 12.5 }} data-testid="block-move-nowhere">This is the only block — there is nowhere to move it.</p>}

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
            <button className="btn primary" data-testid="block-placement-confirm" disabled={!valid} onClick={() => onAdd(title.trim(), position)}>Add block</button>
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
