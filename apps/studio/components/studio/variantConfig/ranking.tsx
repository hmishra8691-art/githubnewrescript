"use client";
import React from "react";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the ranking family.
 *
 * Tournament ranking can stop once the top N is settled. That single number
 * has to reach two places: the renderer (which stops asking duels) and the
 * completeness rule (which must ask for N ranks, not all of them). The
 * variant defaults `rankMode: "top_n"`, so writing `maxSelections` alongside
 * `tournamentTopN` is all it takes — and clearing the field clears both, back
 * to "rank everything".
 */
registerVariantSettings("tournament", ({ q, patchSettings }) => {
  const cap = Math.max(1, q.options.length);
  return (
    <div className="row">
      <label className="f" style={{ marginBottom: 0, width: 150 }}>
        <span>Stop after top N</span>
        <CountInput
          data-testid="tournament-topn"
          min={1}
          max={cap}
          value={q.settings.tournamentTopN}
          onChange={(v) => patchSettings({ tournamentTopN: v, maxSelections: v })}
        />
      </label>
      <span className="muted" style={{ fontSize: 11, alignSelf: "flex-end", paddingBottom: 7 }}>
        Leave empty to rank every item ({cap} item{cap === 1 ? "" : "s"} ≈{" "}
        {estimateDuels(cap)} duels). Set it and the duels stop as soon as the
        top N can no longer change — “find my top 3 of 20” costs a fraction of
        a full ranking, and only the top 3 is stored.
      </span>
    </div>
  );
});

/** Same worst-case count the runtime shows, so the editor's estimate agrees. */
function estimateDuels(n: number): number {
  let total = 0;
  for (let k = 1; k < n; k++) total += Math.ceil(Math.log2(k + 1));
  return total;
}
