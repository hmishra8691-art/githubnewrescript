"use client";
import React from "react";
import { registerVariantSettings } from "./registry";

/**
 * Studio authoring for the slider family — see docs/VARIANT-BATCH.md §4.
 *
 * Only the multi-slider renderer needs anything the capability-driven editor
 * does not already give it: which of its two layouts to draw. Everything else
 * (bounds, step, end labels, rows, options, sum target) is a declared
 * capability and is edited in the ordinary panels.
 */

registerVariantSettings("slidermatrix", ({ q, patchSettings }) => (
  <div className="row" style={{ flexWrap: "wrap" }}>
    <label className="f" style={{ marginBottom: 0, width: 190 }}>
      <span>Slider layout</span>
      <select
        className="select"
        data-testid="slider-layout"
        value={q.settings.sliderLayout ?? "stack"}
        onChange={(e) => patchSettings({ sliderLayout: e.target.value as "stack" | "grid" })}
      >
        <option value="stack">stacked — label above each slider</option>
        <option value="grid">grid — label, slider, value per row</option>
      </select>
    </label>
    <div className="chip" style={{ alignSelf: "flex-end", marginBottom: 7 }}>
      {q.rows.length} slider{q.rows.length === 1 ? "" : "s"}
    </div>
  </div>
));
