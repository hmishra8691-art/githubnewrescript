"use client";
import React from "react";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the drag & drop family.
 *
 * Drag buckets and the drag scale need nothing beyond what their capabilities
 * already show (layout columns; numeric bounds and scale labels). Chip
 * allocation needs one number the generic editor has no field for: what a
 * single chip is worth, which together with the sum target decides how many
 * chips the respondent gets to move.
 */
registerVariantSettings("chipallocation", ({ q, patchSettings }) => {
  const target = q.settings.sumTarget ?? 100;
  const chipValue = q.settings.chipValue && q.settings.chipValue > 0 ? q.settings.chipValue : 10;
  const chips = Math.max(1, Math.round(target / chipValue));
  const clean = Number.isInteger(target / chipValue);
  return (
    <div className="row">
      <label className="f" style={{ marginBottom: 0 }}>
        <span>Chip value</span>
        <CountInput
          data-testid="chip-value"
          min={1}
          value={q.settings.chipValue}
          onChange={(v) => patchSettings({ chipValue: v })}
        />
      </label>
      <span className="muted" style={{ fontSize: 11, alignSelf: "flex-end", paddingBottom: 7 }}>
        {chips} chip{chips === 1 ? "" : "s"} of {chipValue}
        {q.settings.sumUnit ?? ""} to distribute across {q.options.length} item
        {q.options.length === 1 ? "" : "s"}.
      </span>
      {!clean && (
        <div className="chip warn" data-testid="chip-value-warn">
          The sum target ({target}) is not a whole number of {chipValue}-point chips, so the
          chips cannot add up to it exactly — pick a chip value that divides {target}.
        </div>
      )}
    </div>
  );
});
