"use client";
import React from "react";
import type { Question, QuestionColumn } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";
import { ratingLabelMode, ratingScaleOptions, switchRatingLabels, RATING_SCALE_SIZES, type RatingLabelMode } from "@rescript/engine";

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
    flags: [],
  }));
}

registerVariantSettings("starmatrix", ({ q, patchSettings }) => (
  <label className="row" style={{ gap: 6, fontSize: 13 }}>
    Stars per row
    <CountInput min={2} max={10} width={80} allowEmpty={false}
      data-testid="starmatrix-max"
      value={q.settings.maxValue ?? 5}
      onChange={(v) => patchSettings({ maxValue: v ?? 5 })} />
    <span className="muted" style={{ fontSize: 12.5 }}>
      each row stores a number 1–{q.settings.maxValue ?? 5}, exactly like a numeric matrix
    </span>
  </label>
));

registerVariantSettings("summatrix", ({ q, patch, patchSettings }) => (
  <>
    <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
      <label className="row" style={{ gap: 6, fontSize: 13 }}>
        Row total
        <CountInput min={1} width={90} allowEmpty={false}
          data-testid="summatrix-target"
          value={q.settings.sumTarget ?? 100}
          onChange={(v) => patchSettings({ sumTarget: v ?? 100 })} />
      </label>
      <label className="row" style={{ gap: 6, fontSize: 13 }}>
        Unit
        <input className="input" style={{ width: 90 }} placeholder="e.g. %"
          data-testid="summatrix-unit"
          value={q.settings.sumUnit ?? ""}
          onChange={(e) => patchSettings({ sumUnit: e.target.value || undefined })} />
      </label>
      <span className="muted" style={{ fontSize: 12.5 }}>
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

/*
 * RATING MATRIX — THE SCALE AND WHAT ITS HEADERS SAY (07-10 review, Prince #1).
 *
 * "Selecting Rating Matrix (1–5) should auto-populate columns 1–5", with
 * "Numbers" or "Text Labels (Very Poor, Poor, Neutral, Good, Excellent)" as
 * the column labels, editable, and a "Rating Scale [1–5]" control. The points
 * are the question's options, so this block and the Columns list above edit
 * the same thing; the engine's `ratingScaleOptions` / `switchRatingLabels`
 * keep the codes 1…N (the stored numbers) and remember the words while the
 * headers show numbers.
 */
registerVariantSettings("variant:matrix.rating", ({ q, patch }) => {
  const mode = ratingLabelMode(q);
  const n = q.options.length;
  const standard = (RATING_SCALE_SIZES as readonly number[]).includes(n);
  const setMode = (m: RatingLabelMode) => {
    patch({ options: switchRatingLabels(q.options, m), settings: { ...q.settings, ratingLabels: m } });
  };
  const setSize = (size: number) => patch({ options: ratingScaleOptions(size, mode, q.options) });
  return (
    <div data-testid="rating-scale-block">
      <h3 className="sec">Rating scale &amp; labels</h3>
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          Rating scale
          <select className="select" style={{ width: 120 }} data-testid="rating-scale"
            value={standard ? String(n) : "custom"}
            onChange={(e) => { if (e.target.value !== "custom") setSize(Number(e.target.value)); }}>
            {RATING_SCALE_SIZES.map((k) => <option key={k} value={k}>1–{k}</option>)}
            {!standard && <option value="custom">{n} points (custom)</option>}
          </select>
        </label>
        <span className="row" style={{ gap: 6, fontSize: 13 }}>
          Column labels
          <span className="seg" role="radiogroup" aria-label="Column labels" data-testid="rating-labels">
            {([["numbers", "Numbers"], ["text", "Text labels"]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={mode === v}
                className={`seg-btn${mode === v ? " on" : ""}`} data-testid={`rating-labels-${v}`}
                onClick={() => { if (mode !== v) setMode(v); }}>{label}</button>
            ))}
          </span>
        </span>
      </div>
      {/* what the header will read — the same cells the preview draws */}
      <div className="rating-head-preview" aria-hidden data-testid="rating-head-preview">
        {q.options.map((o) => <span key={String(o.code)} className="rating-head-cell">{String(o.label).replace(/<[^>]*>/g, "") || o.code}</span>)}
      </div>
      {mode === "text" ? (
        <div className="rating-labels" data-testid="rating-label-list">
          {q.options.map((o, i) => (
            <label key={String(o.code)} className="rating-label-row">
              <span className="rating-label-code mono">{String(o.code)}</span>
              <input className="input" data-testid={`rating-label-${o.code}`} value={String(o.label)}
                placeholder={`Label for ${o.code}`}
                onChange={(e) => patch({ options: q.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            </label>
          ))}
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            Respondents see these words as the column headers; the data still stores 1–{n}.
          </p>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
          The column headers show the numbers 1–{n}. Choose <em>Text labels</em> to name each point (Very Poor … Excellent).
        </p>
      )}
    </div>
  );
});
