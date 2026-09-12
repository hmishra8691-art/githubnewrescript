"use client";
import React from "react";
import type { QuestionReference } from "@rescript/engine";

/**
 * WHAT DELETING THIS QUESTION BREAKS — before it breaks it.
 *
 * The old dialog was a browser `confirm` reading "Logic referring to it will
 * need updating." It was accurate and it helped nobody: it did not say what
 * logic, it did not say where, and nothing ever did the updating. The
 * references stayed, pointing at an id that no longer resolved, rendering in
 * every picker as an unset row — so the rule looked unfinished rather than
 * broken, and the survey quietly behaved differently.
 *
 * This lists every rule, mask, punch, carry-forward, quota cell and flow
 * branch that names the question, says what happens to each, and — where a
 * question is left without logic it had — says what the survey will now do.
 * Confirming prunes them all as ONE undo step, so the whole thing is
 * reversible with one ⌘Z rather than not at all.
 */

const GROUP: Record<QuestionReference["kind"], string> = {
  removed: "Rules that will be removed",
  cleared: "Logic that will be emptied",
  unplaced: "Pages",
};

export function DeleteQuestionDialog({ code, refs, onCancel, onConfirm }: {
  code: string;
  refs: QuestionReference[];
  onCancel(): void;
  onConfirm(): void;
}) {
  const groups = (["cleared", "removed", "unplaced"] as const)
    .map((kind) => ({ kind, items: refs.filter((r) => r.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="delete-question-dialog"
        style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Delete {code}?</h3>

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {refs.length === 0
            ? "Nothing else in this survey refers to it."
            : `${refs.length} other thing${refs.length === 1 ? "" : "s"} in this survey refer${refs.length === 1 ? "s" : ""} to it. Deleting cleans them up:`}
        </p>

        <div className="tc-scroll">
          {groups.map((g) => (
            <div key={g.kind} style={{ marginTop: 10 }} data-testid={`delete-refs-${g.kind}`}>
              <div className="flabel" style={{ marginBottom: 4 }}>{GROUP[g.kind]}</div>
              <ul className="tc-list">
                {g.items.map((r, i) => (
                  <li key={`${r.path}-${i}`} data-path={r.path}>
                    <b>{r.where}</b> — {r.effect}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {refs.some((r) => /always be shown/.test(r.effect)) && (
          <div className="alert" style={{ marginTop: 12, fontSize: 12.5 }} data-testid="delete-refs-warning">
            A question whose display logic is emptied is shown to everyone. Check the ones listed
            above before you field this.
          </div>
        )}

        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          Answers already collected for {code} are not deleted, and this is a single undo step.
        </p>

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="btn" data-testid="delete-question-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn danger" data-testid="delete-question-confirm" onClick={onConfirm}>
            Delete {refs.length ? "and clean up" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
