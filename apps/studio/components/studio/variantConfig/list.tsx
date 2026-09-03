"use client";
import React from "react";
import type { Question, QuestionColumn } from "@rescript/schema";
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
export function RepeatBounds({ q, patchSettings }: VariantSettingsProps): React.ReactElement {
  const min = q.settings.minRepeats ?? 1;
  const max = q.settings.maxRepeats ?? 10;
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
      {/* field types and required live in the Fields editor above, which now serves repeating groups too */}
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
