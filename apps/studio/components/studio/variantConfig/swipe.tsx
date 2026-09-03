"use client";
import React from "react";
import { registerVariantSettings } from "./registry";

/**
 * Studio authoring for the swipe family.
 *
 * A four-direction deck is only as clear as its mapping: "up" has to mean
 * something the respondent would guess. Left/right/up/down each pick an
 * option here, and the default follows the option order (first → left,
 * second → right, third → up, fourth → down) so a freshly created deck is
 * already coherent.
 */
const DIRS = [
  { key: "left", label: "Swipe left ←" },
  { key: "right", label: "Swipe right →" },
  { key: "up", label: "Swipe up ↑" },
  { key: "down", label: "Swipe down ↓" },
] as const;

registerVariantSettings("swipe4", ({ q, patchSettings }) => {
  const map = q.settings.swipeDirections ?? {};
  const plain = (s: string) => s.replace(/<[^>]*>/g, "");
  return (
    <div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {DIRS.map((d, i) => {
          const fallback = q.options[i];
          const current = map[d.key];
          return (
            <label key={d.key} className="f" style={{ marginBottom: 0, width: 165 }}>
              <span>{d.label}</span>
              <select className="select"
                data-testid={`swipe4-dir-${d.key}`}
                value={current == null ? "" : String(current)}
                onChange={(e) =>
                  patchSettings({
                    swipeDirections: {
                      ...map,
                      [d.key]: e.target.value === "" ? undefined : e.target.value,
                    },
                  })
                }>
                <option value="">
                  {fallback ? `default — ${plain(fallback.label)}` : "— none —"}
                </option>
                {q.options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>{plain(o.label)}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      {q.options.length > 4 && (
        <div className="chip warn" data-testid="swipe4-too-many">
          A card has four directions — this question has {q.options.length} options, so the
          ones not mapped above can never be chosen.
        </div>
      )}
    </div>
  );
});
