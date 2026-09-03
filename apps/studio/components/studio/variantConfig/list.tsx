"use client";
import React from "react";
import type { Question, QuestionColumn } from "@rescript/schema";
import { FIELD_TYPES } from "@rescript/engine";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the list family — see docs/VARIANT-BATCH.md §4.
 *
 *   dynamiclist  how many lines the respondent may add
 *   spreadsheet  the starter columns (the Columns editor owns the rest)
 */

/**
 * How many entries a respondent-driven repetition allows. Shared by the
 * Dynamic List and the Repeating Form, which read the same two settings and
 * validate against them in the engine.
 */
export function RepeatBounds({ q, patch, patchSettings }: VariantSettingsProps): React.ReactElement {
  const min = q.settings.minRepeats ?? 1;
  const max = q.settings.maxRepeats ?? 10;
  const setRow = (i: number, p: Partial<Question["rows"][number]>) =>
    patch({ rows: q.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  return (
    <>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 6, fontSize: 12 }}>
          Fewest entries
          <CountInput min={0} width={80} allowEmpty={false}
            data-testid="repeat-min"
            value={min}
            onChange={(v) => patchSettings({ minRepeats: v ?? 0 })} />
        </label>
        <label className="row" style={{ gap: 6, fontSize: 12 }}>
          Most entries
          <CountInput min={Math.max(1, min)} width={80} allowEmpty={false}
            data-testid="repeat-max"
            value={max}
            onChange={(v) => patchSettings({ maxRepeats: v ?? 1 })} />
        </label>
        <span className="muted" style={{ fontSize: 11 }}>
          variables are VAR_1_&lt;field&gt; … VAR_{max}_&lt;field&gt; plus VAR_N
        </span>
      </div>
      {/*
        A repeating group's rows are its FIELDS, but the editor's Fields
        section (with its type and required controls) is wired to
        text_list / numeric_list only, so the Rows section above offers a
        repeating form nothing but a code and a label. Rather than reach into
        QuestionsPanel, the two properties the renderer and the validator
        actually read are offered here, per field.
      */}
      {q.rows.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Field types — each row above is captured once per entry
          </div>
          {q.rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 8, fontSize: 12, marginBottom: 4 }}>
              <span className="mono" style={{ minWidth: 92 }} title={r.label}>{String(r.code)}</span>
              <select className="select" style={{ width: 150 }}
                data-testid={`repeat-fieldtype-${i}`}
                value={r.fieldType ?? "text"}
                onChange={(e) => setRow(i, { fieldType: e.target.value as never })}>
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox"
                  data-testid={`repeat-required-${i}`}
                  checked={r.required ?? false}
                  onChange={(e) => setRow(i, { required: e.target.checked })} />
                required
              </label>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The three columns an Editable Table falls back to in the runtime when the
 * programmer has not configured any. Same ids as `fallbackSheetColumns` in
 * apps/runtime/components/variants/list.tsx.
 */
export function starterSheetColumns(q: Question): QuestionColumn[] {
  const spec: { label: string; responseType: "text" | "numeric" }[] = [
    { label: "Item", responseType: "text" },
    { label: "Detail", responseType: "text" },
    { label: "Amount", responseType: "numeric" },
  ];
  return spec.map((s, i) => ({
    id: `c${i + 1}`,
    label: s.label,
    responseType: s.responseType,
    variableStem: `${q.variableName}_C${i + 1}`,
    options: [],
    validation: [],
    readOnly: false,
  }));
}

registerVariantSettings("dynamiclist", RepeatBounds);

registerVariantSettings("spreadsheet", ({ q, patch }) =>
  q.columns.length === 0 ? (
    <div className="chip warn" data-testid="spreadsheet-no-columns">
      No columns configured — respondents see three starter columns (Item, Detail, Amount).
      <button className="btn small" data-testid="spreadsheet-seed-columns"
        style={{ marginLeft: 8 }}
        onClick={() => patch({ columns: starterSheetColumns(q) })}>
        create them for editing
      </button>
    </div>
  ) : null,
);
