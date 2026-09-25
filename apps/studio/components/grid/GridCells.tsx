"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { variantRegistry, resolveVariant } from "@rescript/schema";
import { listBlocks, moveQuestionTo, nextCode, shapeHasAxis } from "@rescript/engine";
import { useStudio, uid } from "../studio/store";
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


/* ------------------------------------------------------------ options */

/** whether this question's variant carries a flat option list the grid can edit in place */
export function hasEditableOptions(q: Question): boolean {
  const v = resolveVariant(q.variant) ?? variantRegistry.get(q.variant ?? "");
  if (v) return v.capabilities.includes("options") && !shapeHasAxis(q, "rows");
  return /select|dropdown|rank/.test(q.type) && !/matrix/.test(q.type);
}

/**
 * Options, in the cell (round 2, §7). A code and a label per option, add,
 * remove, reorder — the same fields the Studio's option list edits, written
 * to the same `q.options` with the same id/code minting, in one undo step
 * on Done. Structures the grid cannot represent on a line (rows × columns,
 * option groups, per-option logic) send you to Studio instead of being
 * flattened here.
 */
export function OptionsCellEditor({ q, onDone, onOpenInStudio }: { q: Question; onDone(): void; onOpenInStudio(): void }) {
  const s = useStudio();
  type Draft = { id?: string; code: string; label: string; extra: Record<string, unknown> };
  const [rows, setRows] = React.useState<Draft[]>(() => (q.options ?? []).map((o) => { const { id, code, label, ...extra } = o as unknown as Record<string, unknown> & { id?: string; code: string | number; label?: string }; return { id, code: String(code), label: String(label ?? ""), extra }; }));
  const firstRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { firstRef.current?.focus(); }, []);
  if (!hasEditableOptions(q)) {
    return (
      <div className="sg-popover" data-testid="grid-options-editor" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onDone(); }}>
        <p className="muted" style={{ margin: "0 0 8px" }}>{shapeHasAxis(q, "rows") ? "Rows and columns are edited in Studio." : "This question type has no option list."}</p>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small primary" data-testid="grid-options-open-studio" onClick={onOpenInStudio}>Open in Studio</button>
          <button className="btn small" onClick={onDone}>Close</button>
        </div>
      </div>
    );
  }
  const set = (i: number, patch: Partial<Draft>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const add = () => setRows((r) => [...r, { id: uid("opt"), code: nextCode(r.map((x) => ({ code: x.code }))), label: "", extra: { flags: [] } }]);
  const remove = (i: number) => setRows((r) => r.filter((_, k) => k !== i));
  const move = (i: number, dir: -1 | 1) => setRows((r) => { const n = [...r]; const j = i + dir; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const commit = () => {
    const codes = rows.map((r) => r.code.trim());
    if (codes.some((c) => !c)) { s.toast("Every option needs a code.", "err"); return; }
    if (new Set(codes).size !== codes.length) { s.toast("Option codes must be unique.", "err"); return; }
    // existing options keep exactly the fields they had (an option without an id stays without one); new ones are minted like Studio's
    const next = rows.map((r) => ({ ...r.extra, ...(r.id ? { id: r.id } : {}), code: /^-?\d+$/.test(r.code.trim()) ? Number(r.code.trim()) : r.code.trim(), label: r.label, flags: (r.extra.flags as unknown[]) ?? [] }));
    s.labelNextEdit(`edit ${q.code} options`);
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], options: next as Question["options"] };
    });
    onDone();
  };
  return (
    <div className="sg-popover sg-options" data-testid="grid-options-editor" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onDone(); }}>
      <div className="sg-options-head"><span>Options of {q.code}</span><span className="muted">{rows.length}</span></div>
      <div className="sg-options-list">
        {rows.map((r, i) => (
          <div className="sg-option-row" key={r.id ?? `new-${i}`} data-testid="grid-option-row">
            <input className="input sg-opt-code mono" value={r.code} aria-label="Code" onChange={(e) => set(i, { code: e.target.value })} />
            <input ref={i === 0 ? firstRef : undefined} className="input sg-opt-label" value={r.label} placeholder="Label" aria-label="Label" data-testid="grid-option-label"
              onChange={(e) => set(i, { label: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (i === rows.length - 1) add(); else (e.currentTarget.closest(".sg-options-list")?.querySelectorAll<HTMLInputElement>(".sg-opt-label")[i + 1])?.focus(); } }} />
            <button className="sg-opt-btn" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
            <button className="sg-opt-btn" title="Move down" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
            <button className="sg-opt-btn danger" title="Remove" data-testid="grid-option-remove" onClick={() => remove(i)}>×</button>
          </div>
        ))}
        {rows.length === 0 && <div className="muted" style={{ padding: "4px 2px" }}>No options yet.</div>}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn small" data-testid="grid-option-add" onClick={add}>+ option</button>
        <span className="grow" />
        <button className="btn small" data-testid="grid-options-open-studio" onClick={onOpenInStudio} title="Per-option logic, groups, media, exclusive flags — in Studio">More in Studio</button>
        <button className="btn small" onClick={onDone}>Cancel</button>
        <button className="btn small primary" data-testid="grid-options-done" onClick={commit}>Done</button>
      </div>
    </div>
  );
}
