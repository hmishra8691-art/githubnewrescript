"use client";
import React from "react";
import type { Question, QuestionColumn } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the matrix family — see docs/VARIANT-BATCH.md §4.
 *
 *   starmatrix   how many stars each row offers
 *   summatrix    the per-row sum target, its unit, and the starter columns
 *
 * `dragmatrix` needs nothing beyond the ordinary Rows and Options editors:
 * its rows are the chips and its options are the columns.
 */

/**
 * The three columns a Constant-Sum Matrix falls back to in the runtime when
 * the programmer has not configured any (`QuestionVariantDef.defaults` can
 * seed rows and options but not columns). Same ids as
 * `fallbackSumColumns` in apps/runtime/components/variants/matrix.tsx, so
 * materialising them here never moves a value the respondent already gave.
 */
export function starterSumColumns(q: Question): QuestionColumn[] {
  return [1, 2, 3].map((n) => ({
    id: `c${n}`,
    label: `Column ${n}`,
    responseType: "numeric" as const,
    variableStem: `${q.variableName}_C${n}`,
    options: [],
    validation: [],
    readOnly: false,
    min: 0,
  }));
}

registerVariantSettings("starmatrix", ({ q, patchSettings }) => (
  <label className="row" style={{ gap: 6, fontSize: 12 }}>
    Stars per row
    <CountInput min={2} max={10} width={80} allowEmpty={false}
      data-testid="starmatrix-max"
      value={q.settings.maxValue ?? 5}
      onChange={(v) => patchSettings({ maxValue: v ?? 5 })} />
    <span className="muted" style={{ fontSize: 11 }}>
      each row stores a number 1–{q.settings.maxValue ?? 5}, exactly like a numeric matrix
    </span>
  </label>
));

registerVariantSettings("summatrix", ({ q, patch, patchSettings }) => (
  <>
    <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
      <label className="row" style={{ gap: 6, fontSize: 12 }}>
        Row total
        <CountInput min={1} width={90} allowEmpty={false}
          data-testid="summatrix-target"
          value={q.settings.sumTarget ?? 100}
          onChange={(v) => patchSettings({ sumTarget: v ?? 100 })} />
      </label>
      <label className="row" style={{ gap: 6, fontSize: 12 }}>
        Unit
        <input className="input" style={{ width: 90 }} placeholder="e.g. %"
          data-testid="summatrix-unit"
          value={q.settings.sumUnit ?? ""}
          onChange={(e) => patchSettings({ sumUnit: e.target.value || undefined })} />
      </label>
      <span className="muted" style={{ fontSize: 11 }}>
        every row must spread exactly {q.settings.sumTarget ?? 100}
        {q.settings.sumUnit ?? ""} across the columns
      </span>
    </div>
    {q.columns.length === 0 && (
      <div className="chip warn" data-testid="summatrix-no-columns" style={{ marginTop: 6 }}>
        No columns configured — respondents see three starter columns.
        <button className="btn small" data-testid="summatrix-seed-columns"
          style={{ marginLeft: 8 }}
          onClick={() => patch({ columns: starterSumColumns(q) })}>
          create them for editing
        </button>
      </div>
    )}
  </>
));
