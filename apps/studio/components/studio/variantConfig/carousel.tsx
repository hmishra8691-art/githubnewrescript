"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { registerVariantSettings, registerOptionMetaFields, DESC, PRICE } from "./registry";

/**
 * Studio authoring for the carousel family.
 *
 * `carouseljudge` is ONE variant over three base types: the "Judgement"
 * select rewrites `question.type` (matrix_single / matrix_numeric /
 * matrix_text) and leaves the variant id alone, so the response model follows
 * the input the programmer picked without spawning three variants that differ
 * only in the widget under the card.
 *
 * The generic Rows editor has no per-row meta inputs, so the per-card image
 * and blurb (`row.meta.image` / `row.meta.description`) are edited here.
 */

const MODES: { key: "choice" | "slider" | "text"; type: Question["type"]; label: string; note: string }[] = [
  { key: "choice", type: "matrix_single", label: "Choice — a scale of buttons", note: "Stores one option code per item; the scale points are the question's Options." },
  { key: "slider", type: "matrix_numeric", label: "Slider — a number", note: "Stores a number per item, between Min and Max." },
  { key: "text", type: "matrix_text", label: "Text — a comment box", note: "Stores free text per item." },
];

function modeOf(q: Question) {
  return MODES.find((m) => m.type === q.type) ?? MODES[0];
}

registerVariantSettings("carouseljudge", ({ q, patch, patchSettings }) => {
  const mode = modeOf(q);
  const setMode = (key: string) => {
    const m = MODES.find((x) => x.key === key);
    if (!m || m.type === q.type) return;
    patch({ type: m.type });
    // a slider needs bounds; fill them only when the programmer has none
    if (m.type === "matrix_numeric") {
      patchSettings({
        minValue: q.settings.minValue ?? 0,
        maxValue: q.settings.maxValue ?? 10,
        step: q.settings.step ?? 1,
      });
    }
  };
  const setRowMeta = (i: number, key: "image" | "description", value: string) => {
    patch({
      rows: q.rows.map((r, j) => {
        if (j !== i) return r;
        const meta = { ...(r.meta ?? {}) };
        if (value) meta[key] = value; else delete meta[key];
        return { ...r, meta: Object.keys(meta).length ? meta : undefined };
      }),
    });
  };

  return (
    <>
      <h3 className="sec">Judgement</h3>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="f" style={{ width: 260, marginBottom: 0 }}><span>Input under each card</span>
          <select className="select" data-testid="judge-mode" value={mode.key}
            onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select></label>
        <div className="chip" data-testid="judge-mode-note" style={{ marginBottom: 4 }}>{mode.note}</div>
      </div>
      {mode.key === "slider" && (
        <div className="row">
          <label className="f" style={{ width: 170 }}><span>Left end label</span>
            <input className="input" value={q.settings.sliderLeftLabel ?? ""} placeholder="e.g. Not at all"
              onChange={(e) => patchSettings({ sliderLeftLabel: e.target.value || undefined })} /></label>
          <label className="f" style={{ width: 170 }}><span>Right end label</span>
            <input className="input" value={q.settings.sliderRightLabel ?? ""} placeholder="e.g. Extremely"
              onChange={(e) => patchSettings({ sliderRightLabel: e.target.value || undefined })} /></label>
        </div>
      )}
      {mode.key === "choice" && q.options.length === 0 && (
        <div className="chip warn" data-testid="judge-no-options">
          A choice judgement needs its scale points in <strong>Options</strong> above.
        </div>
      )}

      <h3 className="sec">Card content per item</h3>
      {q.rows.length === 0 ? (
        <div className="chip warn" data-testid="judge-no-rows">
          Add the carousel items in <strong>Rows</strong> above — each row is one card.
        </div>
      ) : (
        <div className="table-wrap">
        <table className="grid" data-testid="judge-cards">
          <thead>
            <tr><th>Item</th><th>Image URL</th><th>Description</th></tr>
          </thead>
          <tbody>
            {q.rows.map((r, i) => (
              <tr key={`${r.code}_${i}`}>
                <th dangerouslySetInnerHTML={{ __html: r.label || String(r.code) }} />
                <td>
                  <input className="input" style={{ width: 200 }} placeholder="https://…/item.jpg"
                    data-testid={`judge-row-image-${i}`}
                    value={String(r.meta?.image ?? "")}
                    onChange={(e) => setRowMeta(i, "image", e.target.value)} />
                </td>
                <td>
                  <input className="input" style={{ width: 260 }} placeholder="secondary line on the card"
                    data-testid={`judge-row-description-${i}`}
                    value={String(r.meta?.description ?? "")}
                    onChange={(e) => setRowMeta(i, "description", e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
});

registerOptionMetaFields("comparecarousel", [DESC, PRICE]);
registerVariantSettings("comparecarousel", ({ q }) =>
  q.options.length < 2 ? (
    <div className="chip warn" data-testid="comparecar-count">
      A comparison carousel slides a window of two items — this one has {q.options.length}.
    </div>
  ) : (
    <div className="chip" data-testid="comparecar-count">
      {q.options.length - 1} pair{q.options.length - 1 === 1 ? "" : "s"} to browse
      ({q.options.length} items, two per slide).
    </div>
  ),
);
