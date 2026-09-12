"use client";
import React from "react";
import type { TypeMigration } from "@rescript/engine";

/**
 * WHAT A TYPE CHANGE IS ABOUT TO DO — before it does it.
 *
 * The old warning was a browser `confirm` that said the response structure
 * was changing and that "incompatible validation/settings will be reset".
 * It was true and it was useless: it never said WHICH, so a programmer who
 * clicked OK found out in fieldwork that a row mask and a randomization had
 * gone, or — worse — did not find out at all, because what actually happened
 * was that the rows stayed and quietly kept driving the exporter.
 *
 * Now the migration is computed first (`migrateQuestionType`, one table, one
 * function) and this shows its result: every list transformed, every setting
 * removed, every rule reset, named. Cancel changes nothing at all; the
 * question is not touched until Change type is pressed, and the change is a
 * single undo step afterwards.
 *
 * A conversion that loses nothing never reaches this dialog — switching a
 * radio list to a dropdown asks nobody anything, because there is nothing to
 * report.
 */

const HEADING: Record<string, string> = {
  transformed: "Carried across in a new shape",
  removed: "Removed",
  reset: "Reset",
};

const NOTE: Record<string, string> = {
  transformed: "Nothing is lost — the codes and labels are the ones you authored.",
  removed: "The new type cannot read these, so keeping them would leave configuration nothing honours.",
  reset: "Kept as a field, but back to its default for this type.",
};

export function TypeChangeDialog({ migration, toName, onCancel, onConfirm }: {
  migration: TypeMigration;
  toName: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const groups = (["transformed", "removed", "reset"] as const)
    .map((kind) => ({ kind, items: migration.changes.filter((c) => c.kind === kind) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="type-change-dialog"
        style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Change question type</h3>

        <p className="muted" style={{ fontSize: 13, marginTop: 0 }} data-testid="type-change-models">
          This question stores <b>{migration.from.label}</b>. As <b>{toName}</b> it stores{" "}
          <b>{migration.to.label}</b>.
        </p>

        {groups.map((g) => (
          <div key={g.kind} style={{ marginTop: 12 }} data-testid={`type-change-${g.kind}`}>
            <div className="flabel" style={{ marginBottom: 4 }}>{HEADING[g.kind]}</div>
            <ul className="tc-list">
              {g.items.map((c, i) => (
                <li key={`${c.field}-${i}`} data-field={c.field}>{c.detail}</li>
              ))}
            </ul>
            <div className="muted" style={{ fontSize: 12 }}>{NOTE[g.kind]}</div>
          </div>
        ))}

        {migration.kept.length > 0 && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }} data-testid="type-change-kept">
            Kept as it is: {migration.kept.join(", ")}. Question text, code, variable name, display
            logic and skip logic are never touched by a type change.
          </p>
        )}

        <div className="alert" style={{ marginTop: 12, fontSize: 12.5 }}>
          Answers already collected against the old structure are not converted. This change is a
          single undo step.
        </div>

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="btn" data-testid="type-change-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn primary" data-testid="type-change-confirm" onClick={onConfirm}>
            Change type
          </button>
        </div>
      </div>
    </div>
  );
}
