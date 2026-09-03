"use client";
import React from "react";
import { registerVariantSettings } from "./registry";

/**
 * Studio authoring for the numeric family — see docs/VARIANT-BATCH.md §4.
 *
 * Numeric Range needs no settings of its own: the two fields are ordinary
 * list rows and the bounds come from the numeric_bounds capability. What it
 * does need is to say what those bounds mean here, since one pair of
 * min/max applies to both sides, and to say that the order is enforced —
 * otherwise the rule looks like a runtime surprise.
 */

registerVariantSettings("numrange", ({ q }) => (
  <div className="chip" data-testid="numrange-note">
    From ≤ To is enforced on Next.
    {q.settings.minValue != null || q.settings.maxValue != null
      ? ` Both sides must be within ${q.settings.minValue ?? "−∞"} – ${q.settings.maxValue ?? "∞"}.`
      : " Set Min / Max above to bound both sides."}
  </div>
));
