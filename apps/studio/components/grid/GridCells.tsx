"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import { listBlocks, moveQuestionTo } from "@rescript/engine";
import { useStudio } from "../studio/store";
import { VariableNameInput } from "../studio/VariableNameInput";
import { useTypeSwitch } from "../studio/VariantPicker";
import type { GridRow } from "../../lib/grid/model";

/**
 * THE CELL EDITORS.
 *
 * Each one edits through the path the Studio already has for that field, so
 * a change made in a cell is indistinguishable from the same change made in
 * the question editor:
 *
 *   text      → the question's `text`, plain only (markup and pipes send you
 *               to the Studio editor rather than being flattened here)
 *   variable  → VariableNameInput: renameImpact → applyRename, with the
 *               same refusal messages and the same "N references updated"
 *   type      → useTypeSwitch: migrateQuestionType, with the same
 *               confirmation dialog when the response model changes
 *   required  → a checkbox, one-click, undoable
 *   block     → moveQuestionTo the end of the chosen block's last page
 *
 * Every editor holds a local draft and commits on blur or Enter. A rename
 * per keystroke would rewrite the survey once per character, and a
 * recomputed grid per character would make typing feel like wading.
 */

export function TextCellEditor({ q, onDone }: { q: Question; onDone(): void }) {
  const s = useStudio();
  const [draft, setDraft] = React.useState(String(q.text ?? ""));
  const commit = () => {
    const to = draft;
    if (to !== q.text) {
      s.labelNextEdit(`edit ${q.code} text`);
      s.update((d) => {
        const i = d.questions.findIndex((x) => x.id === q.id);
        if (i >= 0) d.questions[i] = { ...d.questions[i], text: to };
      });
    }
    onDone();
  };
  return (
    <input
      className="input sg-edit"
      data-testid="grid-edit-text"
      autoFocus
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onDone(); }
        e.stopPropagation(); // the grid's own arrow keys must not fire while typing
      }}
    />
  );
}

export function VariableCellEditor({ q, onDone }: { q: Question; onDone(): void }) {
  return (
    <span onKeyDown={(e) => e.stopPropagation()} className="sg-edit-wrap">
      <VariableNameInput name={q.variableName} testId="grid-edit-variable" autoFocus onDone={onDone} inputClassName="sg-edit" />
    </span>
  );
}

export function TypeCellEditor({ q, onDone }: { q: Question; onDone(): void }) {
  const { current, typesWithPresets, switchTo, dialog } = useTypeSwitch(q);
  return (
    <span onKeyDown={(e) => { if (e.key === "Escape") onDone(); e.stopPropagation(); }} className="sg-edit-wrap">
      {dialog}
      <select
        className="select sg-edit"
        data-testid="grid-edit-type"
        autoFocus
        value={current?.id ?? ""}
        onBlur={() => { if (!dialog) onDone(); }}
        onChange={(e) => {
          const to = variantRegistry.get(e.target.value);
          if (to) switchTo(to);
          onDone();
        }}
      >
        {!current && <option value="">({q.type})</option>}
        {typesWithPresets.map(({ type, presets }) => (
          presets.length === 0
            ? <option key={type.id} value={type.id}>{type.name}</option>
            : (
              <optgroup key={type.id} label={type.name}>
                <option value={type.id}>{type.name}</option>
                {presets.map((pr) => <option key={pr.id} value={pr.id}>↳ {pr.name}</option>)}
              </optgroup>
            )
        ))}
      </select>
    </span>
  );
}

export function BlockCellEditor({ q, row, onDone }: { q: Question; row: GridRow; onDone(): void }) {
  const s = useStudio();
  const blocks = listBlocks(s.def.flow as unknown[]);
  return (
    <select
      className="select sg-edit"
      data-testid="grid-edit-block"
      autoFocus
      value={row.blockId ?? ""}
      onBlur={onDone}
      onKeyDown={(e) => { if (e.key === "Escape") onDone(); e.stopPropagation(); }}
      onChange={(e) => {
        const b = blocks.find((x) => x.id === e.target.value);
        if (b && b.id !== row.blockId) {
          const last = b.pages[b.pages.length - 1].node;
          s.labelNextEdit(`move ${q.code} to ${b.title ?? "block"}`);
          s.update((d) => { moveQuestionTo(d, q.id, last.id, last.questionIds.length); });
        }
        onDone();
      }}
    >
      {!row.blockId && <option value="">— not on a page —</option>}
      {blocks.map((b, i) => <option key={b.id} value={b.id}>{b.title ?? `Block ${i + 1}`}</option>)}
    </select>
  );
}

export function RequiredCell({ q, disabled }: { q: Question; disabled: boolean }) {
  const s = useStudio();
  return (
    <input
      type="checkbox"
      className="sg-check"
      data-testid="grid-required"
      checked={!!q.required}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const to = e.target.checked;
        s.labelNextEdit(`${q.code} ${to ? "required" : "optional"}`);
        s.update((d) => {
          const i = d.questions.findIndex((x) => x.id === q.id);
          if (i >= 0) d.questions[i] = { ...d.questions[i], required: to };
        });
      }}
    />
  );
}

/** the status dot: nothing, or a coloured dot with the count in its title */
export function StatusDot({ row }: { row: GridRow }) {
  if (row.status === "ok") return <span className="sg-dot ok" aria-label="No problems" />;
  return (
    <span className={`sg-dot ${row.status}`} data-testid="grid-status"
      title={`${row.issueCount} ${row.status === "error" ? "problem" : "warning"}${row.issueCount === 1 ? "" : "s"} — open the question to see them`} />
  );
}
