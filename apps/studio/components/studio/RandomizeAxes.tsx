"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { gridAxes, shapeHasAxis } from "@rescript/engine";

/**
 * WHAT IS SHUFFLED — one tick per axis the question really has, so a grid can
 * shuffle its rows AND its columns (29-09 #1); a single select box allowed one.
 * The first ticked axis is the primary one: "show only N" and groups apply
 * to it. On a grid whose columns are the answer scale, the scale is labelled
 * as the columns it is on screen.
 */
export function randomizableAxes(q: Question): { axis: "options" | "rows" | "columns"; label: string }[] {
  const scaleIsColumns = gridAxes(q).columnMeaning === "option_code";
  const out: { axis: "options" | "rows" | "columns"; label: string }[] = [];
  if (shapeHasAxis(q, "rows") && (q.rows?.length ?? 0) > 0) out.push({ axis: "rows", label: "rows" });
  if (shapeHasAxis(q, "options")) out.push({ axis: "options", label: scaleIsColumns ? "columns" : "options" });
  if (shapeHasAxis(q, "columns") && (q.columns?.length ?? 0) > 0) out.push({ axis: "columns", label: "columns" });
  if (!out.length) out.push({ axis: "options", label: "options" });
  return out;
}

export function RandomizeAxes({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const r = q.randomization!;
  const on = new Set(r.scopes?.length ? r.scopes : [r.scope ?? "options"]);
  const axes = randomizableAxes(q);
  /* a stored axis the shape no longer lists stays visible, ticked — never silently dropped */
  for (const a of on) if (!axes.some((x) => x.axis === a)) axes.push({ axis: a, label: a });
  const set = (axis: "options" | "rows" | "columns", checked: boolean) => {
    const next = axes.map((a) => a.axis).filter((a) => (a === axis ? checked : on.has(a)));
    if (!next.length) return; // at least one axis: untick "enabled" to stop randomizing
    const primary = next.includes(r.scope ?? "options") ? (r.scope ?? "options") : next[0];
    patch({ randomization: { ...r, scope: primary, scopes: next.length > 1 ? next : undefined } });
  };
  return (
    <span className="row" style={{ gap: 8 }} data-testid="rand-axes">
      {axes.map((a) => (
        <label key={a.axis} className="row" style={{ gap: 4, fontSize: 13 }}>
          <input type="checkbox" data-testid={`rand-axis-${a.axis}`} checked={on.has(a.axis)}
            onChange={(e) => set(a.axis, e.target.checked)} />
          {a.label}
        </label>
      ))}
    </span>
  );
}

