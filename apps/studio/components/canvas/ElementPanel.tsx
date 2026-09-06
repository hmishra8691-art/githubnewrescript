"use client";
import React from "react";
import type { Option, Question, QuestionColumn, QuestionRow, ValidationRule } from "@rescript/schema";
import { useStudio } from "../studio/store";
import { OptionLogicEditor } from "../studio/OptionLogicEditor";
import { OptionalCondition } from "../studio/ConditionBuilder";
import { Icon } from "../ui/Icon";
import { selectionLabel, type SelectedEntity } from "./selection";
import type { AuthoringAnnotations } from "./authoringView";

/**
 * THE CONTEXTUAL PROPERTY PANEL.
 *
 * What is on screen here is decided by one thing: what the programmer selected
 * on the canvas. Selecting an option offers option programming; selecting a
 * row offers row programming; selecting the question offers the question's own
 * configuration — and each offers ONLY that, because a panel that shows every
 * property of every element at once is the thing this feature exists to
 * replace.
 *
 * The editors themselves are the ones the Studio already had. Option and row
 * logic is `OptionLogicEditor`, conditions are `OptionalCondition` — the same
 * components, writing to the same fields, saved by the same autosave. This
 * panel is a new way in, not a new model.
 */

export function ElementPanel({ q, sel, ann, onSelect }: {
  q: Question;
  sel: SelectedEntity;
  ann: AuthoringAnnotations | null;
  onSelect(s: SelectedEntity | null): void;
}) {
  const s = useStudio();

  /** Every write goes through the store, so undo, autosave and the JSON follow. */
  const patchQuestion = (patch: Partial<Question>) =>
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (t) Object.assign(t, patch);
    });

  const patchOption = (code: string, patch: Partial<Option>) =>
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id)?.options.find((o) => String(o.code) === code);
      if (t) Object.assign(t, patch);
    });

  const patchRow = (code: string, patch: Partial<QuestionRow>) =>
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id)?.rows.find((r) => String(r.code) === code);
      if (t) Object.assign(t, patch);
    });

  const patchColumn = (id: string, patch: Partial<QuestionColumn>) =>
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id)?.columns.find((c) => c.id === id);
      if (t) Object.assign(t, patch);
    });

  return (
    <div className="lc-panel" data-testid="element-panel" data-kind={sel.type}>
      <div className="lc-panel-head">
        <span className="lc-kind">{sel.type}</span>
        <h2 data-testid="element-panel-title">{selectionLabel(sel, q)}</h2>
        {sel.type !== "question" && (
          <button className="btn small ghost" data-testid="select-question"
            onClick={() => onSelect({ type: "question", questionId: q.id })}
            title="Select the question itself">
            <Icon name="chevron-right" size={14} /> question
          </button>
        )}
      </div>

      {sel.type === "option" && <OptionProps q={q} code={sel.optionCode} ann={ann} patch={patchOption} onSelect={onSelect} />}
      {sel.type === "row" && <RowProps q={q} code={sel.rowCode} ann={ann} patch={patchRow} onSelect={onSelect} />}
      {sel.type === "column" && <ColumnProps q={q} id={sel.columnId} patch={patchColumn} patchOption={patchOption} />}
      {sel.type === "cell" && <CellProps q={q} rowCode={sel.rowCode} columnId={sel.columnId} onSelect={onSelect} />}
      {sel.type === "text" && <TextProps q={q} patch={patchQuestion} field="text" />}
      {sel.type === "instruction" && <TextProps q={q} patch={patchQuestion} field="instruction" />}
      {sel.type === "media" && <MediaProps q={q} patch={patchQuestion} />}
      {sel.type === "scalepoint" && <ScalePointProps q={q} value={sel.value} />}
      {sel.type === "question" && <QuestionProps q={q} />}
    </div>
  );
}

/* ------------------------------------------------------------------ option */

function OptionProps({ q, code, ann, patch, onSelect }: {
  q: Question; code: string; ann: AuthoringAnnotations | null;
  patch(code: string, p: Partial<Option>): void;
  onSelect(s: SelectedEntity | null): void;
}) {
  const s = useStudio();
  const o = q.options.find((x) => String(x.code) === code);
  if (!o) return <p className="muted">This option is no longer in the question.</p>;
  const flag = (f: string) => o.flags?.includes(f as never) ?? false;
  const toggleFlag = (f: string) =>
    patch(code, { flags: (flag(f) ? o.flags.filter((x) => x !== f) : [...o.flags, f]) as never });

  return (
    <>
      {ann?.hiddenOptions.has(code) && (
        <div className="alert warning" data-testid="option-hidden-note">
          Hidden for these sample answers. It stays visible here so you can still program it.
        </div>
      )}

      <label className="f"><span>Label</span>
        <input className="input" data-testid="opt-label" value={o.label}
          onChange={(e) => patch(code, { label: e.target.value })} /></label>

      <label className="f"><span>Code</span>
        <input className="input mono" data-testid="opt-code"
          value={String(o.code)} disabled={s.hasResponses}
          title={s.hasResponses ? "Codes are frozen once responses exist" : undefined}
          onChange={(e) => {
            const next = e.target.value;
            s.update((d) => {
              const t = d.questions.find((x) => x.id === q.id)?.options.find((x) => String(x.code) === code);
              if (t) t.code = next;
            });
            onSelect({ type: "option", questionId: q.id, optionCode: next });
          }} /></label>

      <label className="f"><span>Image</span>
        <input className="input" placeholder="https://…" value={o.imageUrl ?? ""}
          onChange={(e) => patch(code, { imageUrl: e.target.value || undefined })} /></label>

      <h3 className="sec">Behaviour</h3>
      <div className="lc-flags">
        {["exclusive", "other_specify", "none_of_above", "dont_know", "refused", "anchor_top", "anchor_bottom"].map((f) => (
          <label key={f} className="lc-flag-row">
            <input type="checkbox" checked={flag(f)} data-testid={`opt-flag-${f}`} onChange={() => toggleFlag(f)} />
            <span>{f.replace(/_/g, " ")}</span>
          </label>
        ))}
      </div>

      <h3 className="sec">Option logic</h3>
      <OptionLogicEditor
        title={`Option ${o.code}`}
        logic={o.logic}
        visibleIf={o.visibleIf}
        onChange={(p) => patch(code, p as Partial<Option>)}
      />
    </>
  );
}

/* --------------------------------------------------------------------- row */

function RowProps({ q, code, ann, patch, onSelect }: {
  q: Question; code: string; ann: AuthoringAnnotations | null;
  patch(code: string, p: Partial<QuestionRow>): void;
  onSelect(s: SelectedEntity | null): void;
}) {
  const s = useStudio();
  const r = q.rows.find((x) => String(x.code) === code);
  if (!r) return <p className="muted">This row is no longer in the question.</p>;

  return (
    <>
      {ann?.hiddenRows.has(code) && (
        <div className="alert warning" data-testid="row-hidden-note">
          Hidden for these sample answers — still programmable here.
        </div>
      )}

      <label className="f"><span>Label</span>
        <input className="input" data-testid="row-label" value={r.label}
          onChange={(e) => patch(code, { label: e.target.value })} /></label>

      <label className="f"><span>Code</span>
        <input className="input mono" data-testid="row-code" value={String(r.code)} disabled={s.hasResponses}
          onChange={(e) => {
            const next = e.target.value;
            s.update((d) => {
              const t = d.questions.find((x) => x.id === q.id)?.rows.find((x) => String(x.code) === code);
              if (t) t.code = next;
            });
            onSelect({ type: "row", questionId: q.id, rowCode: next });
          }} /></label>

      <label className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={r.required} data-testid="row-required"
          onChange={(e) => patch(code, { required: e.target.checked })} />
        <span>Required</span>
      </label>

      <h3 className="sec">Row logic</h3>
      <OptionLogicEditor
        title={`Row ${r.code}`}
        logic={r.logic}
        visibleIf={r.visibleIf}
        onChange={(p) => patch(code, p as Partial<QuestionRow>)}
      />

      <h3 className="sec">Row validation</h3>
      <RowValidation q={q} code={code} rules={r.validation ?? []}
        onChange={(rules) => patch(code, { validation: rules })} />
    </>
  );
}

const ROW_RULES: ValidationRule["kind"][] = ["required", "min_value", "max_value", "min_length", "max_length", "pattern", "email", "integer"];

function RowValidation({ rules, onChange }: {
  q: Question; code: string; rules: ValidationRule[]; onChange(r: ValidationRule[]): void;
}) {
  return (
    <div data-testid="row-validation">
      {rules.map((r, i) => (
        <div className="row" key={i} style={{ marginBottom: 6 }}>
          <select className="select small" value={r.kind}
            onChange={(e) => onChange(rules.map((x, j) => (j === i ? { ...x, kind: e.target.value as ValidationRule["kind"] } : x)))}>
            {ROW_RULES.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
          </select>
          <input className="input small grow" placeholder="value" value={String(r.value ?? "")}
            onChange={(e) => onChange(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button className="btn small danger" onClick={() => onChange(rules.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn small" data-testid="add-row-rule"
        onClick={() => onChange([...rules, { kind: "required" } as ValidationRule])}>
        <Icon name="plus" size={13} /> rule
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ column */

function ColumnProps({ q, id, patch, patchOption }: {
  q: Question; id: string;
  patch(id: string, p: Partial<QuestionColumn>): void;
  patchOption(code: string, p: Partial<Option>): void;
}) {
  const col = q.columns.find((c) => c.id === id);

  /* A matrix's "columns" are its scale options — the same object an option
     panel edits. Selecting the header of such a column therefore edits that
     option, which is what a programmer means when they click "Satisfied". */
  if (!col) {
    const o = q.options.find((x) => String(x.code) === id);
    if (!o) return <p className="muted">This column is no longer in the question.</p>;
    return (
      <>
        <div className="alert info" data-testid="column-is-option">
          On this question type the columns are the answer scale, so this column is an option.
        </div>
        <label className="f"><span>Label</span>
          <input className="input" data-testid="col-label" value={o.label}
            onChange={(e) => patchOption(id, { label: e.target.value })} /></label>
        <label className="f"><span>Code</span>
          <input className="input mono" value={String(o.code)} readOnly /></label>
        <h3 className="sec">Column logic</h3>
        <OptionLogicEditor title={`Column ${o.code}`} logic={o.logic} visibleIf={o.visibleIf}
          onChange={(p) => patchOption(id, p as Partial<Option>)} />
      </>
    );
  }

  return (
    <>
      <label className="f"><span>Label</span>
        <input className="input" data-testid="col-label" value={col.label}
          onChange={(e) => patch(id, { label: e.target.value })} /></label>
      <label className="f"><span>Variable stem</span>
        <input className="input mono" value={col.variableStem}
          onChange={(e) => patch(id, { variableStem: e.target.value })} /></label>
      <label className="f"><span>Data type</span>
        <select className="select" data-testid="col-type" value={col.responseType}
          onChange={(e) => patch(id, { responseType: e.target.value as QuestionColumn["responseType"] })}>
          {["single", "multi", "dropdown", "multi_dropdown", "text", "longtext", "numeric", "date", "time", "rank", "slider", "checkbox", "none"]
            .map((t) => <option key={t} value={t}>{t}</option>)}
        </select></label>
      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <label className="f grow"><span>Min</span>
          <input className="input" type="number" value={col.min ?? ""}
            onChange={(e) => patch(id, { min: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        <label className="f grow"><span>Max</span>
          <input className="input" type="number" value={col.max ?? ""}
            onChange={(e) => patch(id, { max: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
      </div>
      <label className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={col.readOnly} onChange={(e) => patch(id, { readOnly: e.target.checked })} />
        <span>Read only</span>
      </label>

      <h3 className="sec">Display</h3>
      <OptionalCondition label="Show this column when" value={col.visibleIf}
        onChange={(c) => patch(id, { visibleIf: c })} />
    </>
  );
}

/* -------------------------------------------------------------------- cell */

function CellProps({ q, rowCode, columnId, onSelect }: {
  q: Question; rowCode: string; columnId: string; onSelect(s: SelectedEntity | null): void;
}) {
  const row = q.rows.find((r) => String(r.code) === rowCode);
  const col = q.columns.find((c) => c.id === columnId);
  const opt = q.options.find((o) => String(o.code) === columnId);

  return (
    <>
      <div className="alert info" data-testid="cell-note">
        A cell is where a row meets a column. The engine programs the row and the column, not the
        intersection, so this is a cross-reference — edit whichever side you meant.
      </div>
      <dl className="kv">
        <dt>Row</dt><dd>{row ? row.label.replace(/<[^>]*>/g, "") : rowCode}</dd>
        <dt>Column</dt><dd>{(col?.label ?? opt?.label ?? columnId).replace(/<[^>]*>/g, "")}</dd>
        <dt>Variable</dt><dd className="mono">{col ? `${col.variableStem}_${rowCode}` : `${q.variableName}_${rowCode}`}</dd>
      </dl>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn small" data-testid="cell-goto-row"
          onClick={() => onSelect({ type: "row", questionId: q.id, rowCode })}>Program the row</button>
        <button className="btn small" data-testid="cell-goto-column"
          onClick={() => onSelect({ type: "column", questionId: q.id, columnId })}>Program the column</button>
      </div>
    </>
  );
}

/* ------------------------------------------------------- text / media / etc */

function TextProps({ q, patch, field }: {
  q: Question; patch(p: Partial<Question>): void; field: "text" | "instruction";
}) {
  const value = (field === "text" ? q.text : q.instruction) ?? "";
  return (
    <>
      <label className="f"><span>{field === "text" ? "Question text" : "Instruction"}</span>
        <textarea className="ta" data-testid={`${field}-edit`} rows={5} value={value}
          onChange={(e) => patch({ [field]: e.target.value } as Partial<Question>)} /></label>
      <p className="muted" style={{ fontSize: 13 }}>
        HTML and piping tokens such as <span className="mono">{"{{Q1}}"}</span> are supported. A token
        with no sample answer behind it is shown as a chip on the canvas.
      </p>
      {field === "text" && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={q.required} data-testid="q-required"
            onChange={(e) => patch({ required: e.target.checked })} />
          <span>Required</span>
        </label>
      )}
    </>
  );
}

function MediaProps({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  return (
    <label className="f"><span>Media URL</span>
      <input className="input" data-testid="media-edit" value={q.settings.mediaUrl ?? ""}
        placeholder="Image, video, YouTube or Google Drive URL"
        onChange={(e) => patch({ settings: { ...q.settings, mediaUrl: e.target.value || undefined } })} /></label>
  );
}

function ScalePointProps({ q, value }: { q: Question; value: string }) {
  return (
    <>
      <div className="alert info">
        A scale point is generated from the question&apos;s bounds, not stored as an option — change
        the range to change the points.
      </div>
      <dl className="kv">
        <dt>Value</dt><dd className="mono">{value}</dd>
        <dt>Minimum</dt><dd>{q.settings.minValue ?? 0}</dd>
        <dt>Maximum</dt><dd>{q.settings.maxValue ?? 10}</dd>
      </dl>
    </>
  );
}

/**
 * The question itself. Its full configuration already has a home — the
 * Properties panel on the Questions tab, which is unchanged — so this offers
 * the identity and the most-used programming and links to the rest rather than
 * duplicating fourteen sections in a second place.
 */
function QuestionProps({ q }: { q: Question }) {
  const s = useStudio();
  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (t) Object.assign(t, p);
    });

  return (
    <>
      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <label className="f grow"><span>Code</span>
          <input className="input mono" data-testid="q-code" value={q.code}
            onChange={(e) => patch({ code: e.target.value })} /></label>
        <label className="f grow"><span>Variable</span>
          <input className="input mono" value={q.variableName}
            onChange={(e) => patch({ variableName: e.target.value })} /></label>
      </div>

      <label className="f"><span>Question text</span>
        <textarea className="ta" data-testid="q-text" rows={3} value={q.text}
          onChange={(e) => patch({ text: e.target.value })} /></label>

      <label className="row" style={{ gap: 8, marginBottom: 14 }}>
        <input type="checkbox" checked={q.required} onChange={(e) => patch({ required: e.target.checked })} />
        <span>Required</span>
      </label>

      <h3 className="sec">Display logic</h3>
      <OptionalCondition label="Show this question when" value={q.displayLogic}
        onChange={(c) => patch({ displayLogic: c })} />

      <h3 className="sec">Randomization</h3>
      <label className="row" style={{ gap: 8, marginBottom: 8 }}>
        <input type="checkbox" data-testid="q-randomize" checked={!!q.randomization?.enabled}
          onChange={(e) => patch({
            randomization: {
              scope: "options",
              method: "shuffle",
              ...(q.randomization ?? {}),
              enabled: e.target.checked,
            } as Question["randomization"],
          })} />
        <span>Randomize</span>
      </label>
      {q.randomization?.enabled && (
        <div className="row" style={{ gap: 8 }}>
          <select className="select small" value={q.randomization.scope}
            onChange={(e) => patch({ randomization: { ...q.randomization!, scope: e.target.value as never } })}>
            <option value="options">options</option><option value="rows">rows</option><option value="columns">columns</option>
          </select>
          <select className="select small" value={q.randomization.method}
            onChange={(e) => patch({ randomization: { ...q.randomization!, method: e.target.value as never } })}>
            <option value="shuffle">shuffle</option><option value="rotate">rotate</option>
            <option value="reverse_half">reverse half</option><option value="none">none</option>
          </select>
        </div>
      )}

      <div className="lc-more">
        <button className="btn small" data-testid="open-full-properties"
          onClick={() => s.goToTab?.("questions")}>
          <Icon name="settings" size={14} /> All question properties
        </button>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Skip logic, carry-forward, masking, list logic and operations, validation, custom code and
          notes live on the Questions tab. They are the same fields — this panel is a shortcut to the
          ones you reach for while looking at the question.
        </p>
      </div>
    </>
  );
}
